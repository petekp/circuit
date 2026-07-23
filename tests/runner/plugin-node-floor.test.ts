import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REQUIRED_NODE } from '../../bin/node-version-guard.js';

// The plugin host wrappers and hooks are TypeScript, so a host that runs them
// as `node foo.ts` on a Node below the TypeScript floor (22.18) fails at parse
// time with ERR_UNKNOWN_FILE_EXTENSION before the friendly version gate inside
// the .ts file can ever run. The fix is a plain-JavaScript shim per host
// entrypoint that checks the Node version first, then dynamically imports its
// sibling .ts. These tests pin that the host entrypoints point at the shims and
// that each shim guards before it delegates.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FLOOR = `${REQUIRED_NODE.major}.${REQUIRED_NODE.minor}`;

type ShimSpec = { shim: string; target: string; delegates: boolean };

const SHIMS: ShimSpec[] = [
  { shim: 'plugins/codex/mcp/server.cjs', target: 'server.mjs', delegates: false },
  { shim: 'plugins/claude/scripts/circuit.js', target: 'circuit.ts', delegates: true },
  { shim: 'plugins/codex/scripts/circuit.js', target: 'circuit.ts', delegates: true },
  { shim: 'plugins/claude/hooks/session-start.js', target: 'session-start.ts', delegates: false },
  { shim: 'plugins/claude/hooks/harvest.js', target: 'harvest.ts', delegates: false },
];

function read(rel: string): string {
  return readFileSync(resolve(repoRoot, rel), 'utf8');
}

describe('host entrypoints invoke a .js shim, never a .ts file', () => {
  it('the Claude hooks config runs the .js shims, not the .ts hooks', () => {
    const hooks = read('plugins/claude/hooks/hooks.json');
    const commands: string[] = [];
    JSON.parse(hooks, (key, value) => {
      if (key === 'command' && typeof value === 'string') commands.push(value);
      return value;
    });
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command).not.toMatch(/hooks\/[\w-]+\.ts/);
    }
    const joined = commands.join('\n');
    expect(joined).toContain('hooks/session-start.js');
    expect(joined).toContain('hooks/harvest.js');
  });

  it('the command-doc generator points the host wrapper at circuit.js', () => {
    const renderers = read('scripts/flows/host-renderers.ts');
    // The two wrapper-command constants the emitter injects into command docs.
    expect(renderers).toContain('/scripts/circuit.js"');
    expect(renderers).toContain("/scripts/circuit.js'");
    expect(renderers).not.toMatch(
      /CLAUDE_PLUGIN_WRAPPER_COMMAND = 'node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/circuit\.ts"/,
    );
  });

  it('the Codex hook launcher defaults to circuit.js', () => {
    const codexHooks = read('src/cli/handoff-codex-hooks.ts');
    expect(codexHooks).toContain("'scripts/circuit.js'");
    expect(codexHooks).not.toContain("resolve(pluginRoot, 'scripts/circuit.ts')");
  });
});

describe('each shim guards the Node floor before delegating', () => {
  for (const { shim, target } of SHIMS) {
    it(`${shim} exists, names the floor, and guards before importing ${target}`, () => {
      const abs = resolve(repoRoot, shim);
      expect(existsSync(abs)).toBe(true);
      const body = read(shim);
      // Floor number is single-sourced against the bin guard so it cannot drift.
      expect(body).toContain(FLOOR);
      const guardAt = body.indexOf('process.exit(1)');
      const importAt = body.indexOf('import(');
      expect(guardAt).toBeGreaterThanOrEqual(0);
      expect(importAt).toBeGreaterThanOrEqual(0);
      // The version guard must run and be able to exit before the .ts is loaded.
      expect(guardAt).toBeLessThan(importAt);
      expect(body).toMatch(new RegExp(`import\\((['"])\\./${target.replace('.', '\\.')}\\1\\)`));
    });
  }
});

describe('shim behavior on a simulated Node version (subprocess)', () => {
  let dir: string;
  let fakeOld: string;
  let fakeOk: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'circuit-node-floor-'));
    fakeOld = join(dir, 'fake-old-node.cjs');
    fakeOk = join(dir, 'fake-ok-node.cjs');
    writeFileSync(
      fakeOld,
      "Object.defineProperty(process.versions,'node',{value:'20.11.1',configurable:true});\n",
    );
    writeFileSync(
      fakeOk,
      `Object.defineProperty(process.versions,'node',{value:'${FLOOR}.0',configurable:true});\n`,
    );
  });

  afterAll(() => {
    // Best-effort temp cleanup; the OS reclaims it regardless.
    try {
      require('node:fs').rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  for (const { shim } of SHIMS) {
    it(`${shim} prints a legible version error and exits 1 on an old Node`, () => {
      const abs = resolve(repoRoot, shim);
      const result = spawnSync(process.execPath, ['--require', fakeOld, abs, 'run', 'fix'], {
        input: '{}',
        encoding: 'utf8',
        timeout: 20_000,
      });
      expect(result.status).toBe(1);
      const stderr = result.stderr ?? '';
      expect(stderr).toContain('Node');
      expect(stderr).toContain(FLOOR);
      expect(stderr).toContain('20.11.1');
      if (shim === 'plugins/codex/mcp/server.cjs') {
        expect(stderr).toContain(
          `Install Node.js ${FLOOR} or newer, ensure node is on PATH, restart Codex, and try again.`,
        );
      }
      // The whole point: never the cryptic loader error on an old Node.
      expect(stderr).not.toContain('ERR_UNKNOWN_FILE_EXTENSION');
    });
  }

  for (const { shim, delegates } of SHIMS.filter((s) => s.delegates)) {
    it(`${shim} clears the guard and reaches its .ts on a supported Node`, () => {
      expect(delegates).toBe(true);
      const abs = resolve(repoRoot, shim);
      const result = spawnSync(process.execPath, ['--require', fakeOk, abs, '--help'], {
        input: '',
        encoding: 'utf8',
        timeout: 60_000,
      });
      const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      // Guard passed (no floor message) and the .ts loaded (no loader error).
      expect(combined).not.toContain('requires Node.js');
      expect(combined).not.toContain('ERR_UNKNOWN_FILE_EXTENSION');
    });
  }
});
