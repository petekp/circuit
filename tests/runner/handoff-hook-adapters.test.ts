import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const tempRoots: string[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeStubLauncher(root: string): string {
  const stub = join(root, 'stub-launcher.ts');
  writeFileSync(
    stub,
    [
      "import { writeFileSync } from 'node:fs';",
      'writeFileSync(process.env.CAPTURE_PATH, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));',
      "const status = process.env.STUB_STATUS ?? 'available';",
      "if (status === 'available') {",
      "  process.stdout.write(JSON.stringify({ status: 'available', additional_context: 'UNIQUE-HANDOFF-TOKEN' }));",
      '  process.exit(0);',
      '}',
      "if (status === 'invalid') {",
      "  process.stdout.write(JSON.stringify({ status: 'invalid', error: { code: 'record_invalid' }, operator_notice: 'CIRCUIT-INVALID-NOTICE' }));",
      '  process.exit(0);',
      '}',
      "if (status === 'invalid-bare') {",
      "  process.stdout.write(JSON.stringify({ status: 'invalid', error: { code: 'record_invalid' } }));",
      '  process.exit(0);',
      '}',
      "if (status === 'empty') {",
      "  process.stdout.write(JSON.stringify({ status: 'empty' }));",
      '  process.exit(0);',
      '}',
      "process.stderr.write('stub failure');",
      'process.exit(1);',
    ].join('\n'),
  );
  return stub;
}

function writeSleepingStubLauncher(root: string): string {
  const stub = join(root, 'sleeping-stub-launcher.ts');
  writeFileSync(stub, 'setTimeout(() => {}, 10_000);\n');
  return stub;
}

function runHook(
  input: unknown,
  options: {
    readonly hookPath: string;
    readonly launcher: string;
    readonly capturePath: string;
    readonly cwd: string;
    readonly status?: string;
    readonly debug?: boolean;
    readonly timeoutMs?: number;
    readonly env?: Readonly<Record<string, string>>;
  },
) {
  return spawnSync(process.execPath, [options.hookPath], {
    cwd: options.cwd,
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: {
      ...process.env,
      CIRCUIT_HANDOFF_HOOK_LAUNCHER: options.launcher,
      CAPTURE_PATH: options.capturePath,
      ...(options.status === undefined ? {} : { STUB_STATUS: options.status }),
      ...(options.debug === true ? { CIRCUIT_HANDOFF_HOOK_DEBUG: '1' } : {}),
      ...(options.timeoutMs === undefined
        ? {}
        : { CIRCUIT_HANDOFF_HOOK_TIMEOUT_MS: String(options.timeoutMs) }),
      ...(options.env ?? {}),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

describe('handoff SessionStart hook adapters', () => {
  it.each([
    ['claude', resolve('plugins/claude/hooks/session-start.ts')],
    ['codex', resolve('plugins/codex/hooks/session-start.ts')],
  ] as const)(
    '%s adapter injects the shared handoff context from hook cwd input',
    (_name, hookPath) => {
      const root = tempRoot('circuit-handoff-hook-');
      const projectRoot = join(root, 'project');
      const wrongCwd = join(root, 'wrong-cwd');
      const capturePath = join(root, 'capture.json');
      const launcher = writeStubLauncher(root);
      mkdirSync(projectRoot, { recursive: true });
      mkdirSync(wrongCwd, { recursive: true });

      const result = runHook(
        {
          hook_event_name: 'SessionStart',
          source: 'startup',
          session_id: 'sess-1234',
          cwd: projectRoot,
        },
        { hookPath, launcher, capturePath, cwd: wrongCwd },
      );

      expect(result.status, result.stderr).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output).toEqual({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: 'UNIQUE-HANDOFF-TOKEN',
        },
      });
      const capture = JSON.parse(readFileSync(capturePath, 'utf8')) as {
        argv: string[];
        cwd: string;
      };
      // Session identity rides along so the brief resolves the calling
      // session's own ambient record (session-scoped ambient resolution).
      expect(capture.argv).toEqual([
        'handoff',
        'brief',
        '--json',
        '--project-root',
        projectRoot,
        '--session-id',
        'sess-1234',
        '--session-source',
        'startup',
      ]);
      expect(realpathSync(capture.cwd)).toBe(realpathSync(projectRoot));
    },
  );

  it.each([
    ['claude', resolve('plugins/claude/hooks/session-start.ts')],
    ['codex', resolve('plugins/codex/hooks/session-start.ts')],
  ] as const)(
    '%s adapter omits identity flags when the hook input lacks them',
    (_name, hookPath) => {
      const root = tempRoot('circuit-handoff-hook-no-identity-');
      const projectRoot = join(root, 'project');
      const capturePath = join(root, 'capture.json');
      const launcher = writeStubLauncher(root);
      mkdirSync(projectRoot, { recursive: true });

      const result = runHook(
        { hook_event_name: 'SessionStart', cwd: projectRoot },
        { hookPath, launcher, capturePath, cwd: root },
      );

      expect(result.status, result.stderr).toBe(0);
      const capture = JSON.parse(readFileSync(capturePath, 'utf8')) as { argv: string[] };
      expect(capture.argv).toEqual(['handoff', 'brief', '--json', '--project-root', projectRoot]);
    },
  );

  it.each([
    ['claude', resolve('plugins/claude/hooks/session-start.ts')],
    ['codex', resolve('plugins/codex/hooks/session-start.ts')],
  ] as const)('%s adapter stays silent when the brief is empty', (_name, hookPath) => {
    const root = tempRoot('circuit-handoff-hook-empty-');
    const projectRoot = join(root, 'project');
    const capturePath = join(root, 'capture.json');
    const launcher = writeStubLauncher(root);
    mkdirSync(projectRoot, { recursive: true });

    // Nothing to restore is not a failure: empty stays silent (no noise).
    const empty = runHook(
      { hook_event_name: 'SessionStart', source: 'startup', cwd: projectRoot },
      { hookPath, launcher, capturePath, cwd: root, status: 'empty' },
    );
    expect(empty.status, empty.stderr).toBe(0);
    expect(empty.stdout).toBe('');
  });

  it.each([
    ['claude', resolve('plugins/claude/hooks/session-start.ts')],
    ['codex', resolve('plugins/codex/hooks/session-start.ts')],
  ] as const)(
    '%s adapter surfaces the brief operator_notice when the brief is invalid (A1)',
    (_name, hookPath) => {
      const root = tempRoot('circuit-handoff-hook-invalid-');
      const projectRoot = join(root, 'project');
      const capturePath = join(root, 'capture.json');
      const launcher = writeStubLauncher(root);
      mkdirSync(projectRoot, { recursive: true });

      // A broken store must not look identical to a clean one: the operator
      // sees one short line instead of nothing.
      const invalid = runHook(
        { hook_event_name: 'SessionStart', source: 'startup', cwd: projectRoot },
        { hookPath, launcher, capturePath, cwd: root, status: 'invalid' },
      );
      expect(invalid.status, invalid.stderr).toBe(0);
      const output = JSON.parse(invalid.stdout);
      expect(output).toEqual({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: 'CIRCUIT-INVALID-NOTICE',
        },
      });
    },
  );

  it.each([
    ['claude', resolve('plugins/claude/hooks/session-start.ts')],
    ['codex', resolve('plugins/codex/hooks/session-start.ts')],
  ] as const)(
    '%s adapter synthesizes a notice when an invalid brief omits operator_notice (A1)',
    (_name, hookPath) => {
      const root = tempRoot('circuit-handoff-hook-invalid-bare-');
      const projectRoot = join(root, 'project');
      const capturePath = join(root, 'capture.json');
      const launcher = writeStubLauncher(root);
      mkdirSync(projectRoot, { recursive: true });

      const invalid = runHook(
        { hook_event_name: 'SessionStart', source: 'startup', cwd: projectRoot },
        { hookPath, launcher, capturePath, cwd: root, status: 'invalid-bare' },
      );
      expect(invalid.status, invalid.stderr).toBe(0);
      const output = JSON.parse(invalid.stdout) as {
        hookSpecificOutput: { additionalContext: string };
      };
      expect(output.hookSpecificOutput.additionalContext).toContain('could not');
      expect(output.hookSpecificOutput.additionalContext).toContain('record_invalid');
    },
  );

  it.each([
    ['claude', resolve('plugins/claude/hooks/session-start.ts')],
    ['codex', resolve('plugins/codex/hooks/session-start.ts')],
  ] as const)(
    '%s adapter does not fall back to process cwd when hook cwd is missing',
    (_name, hookPath) => {
      const root = tempRoot('circuit-handoff-hook-no-cwd-');
      const capturePath = join(root, 'capture.json');
      const launcher = writeStubLauncher(root);

      const result = runHook(
        { hook_event_name: 'SessionStart', source: 'startup' },
        { hookPath, launcher, capturePath, cwd: root, debug: true },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('hook input did not include cwd');
    },
  );

  it.each([
    ['claude', resolve('plugins/claude/hooks/session-start.ts')],
    ['codex', resolve('plugins/codex/hooks/session-start.ts')],
  ] as const)(
    '%s adapter surfaces a fallback notice when the brief command hangs (A1)',
    (_name, hookPath) => {
      const root = tempRoot('circuit-handoff-hook-timeout-');
      const projectRoot = join(root, 'project');
      const capturePath = join(root, 'capture.json');
      const launcher = writeSleepingStubLauncher(root);
      mkdirSync(projectRoot, { recursive: true });

      // A timeout is a real restore failure, not a benign empty: say so once.
      const result = runHook(
        { hook_event_name: 'SessionStart', source: 'startup', cwd: projectRoot },
        { hookPath, launcher, capturePath, cwd: root, debug: true, timeoutMs: 25 },
      );

      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout) as {
        hookSpecificOutput: { additionalContext: string };
      };
      expect(output.hookSpecificOutput.additionalContext).toContain('could not');
      expect(result.stderr).toContain('Circuit handoff hook: brief command failed');
    },
  );

  // E2: brief injection is source-aware and opt-in. By default every source
  // injects the full brief (today's behaviour). Opting in suppresses injection
  // for a deliberate clear or a just-happened compaction, where re-injecting
  // state is redundant or unwanted.
  it.each([
    ['claude', resolve('plugins/claude/hooks/session-start.ts')],
    ['codex', resolve('plugins/codex/hooks/session-start.ts')],
  ] as const)('%s adapter injects on clear by default (E2 opt-in)', (_name, hookPath) => {
    const root = tempRoot('circuit-handoff-hook-clear-default-');
    const projectRoot = join(root, 'project');
    const capturePath = join(root, 'capture.json');
    const launcher = writeStubLauncher(root);
    mkdirSync(projectRoot, { recursive: true });

    const result = runHook(
      { hook_event_name: 'SessionStart', source: 'clear', cwd: projectRoot },
      { hookPath, launcher, capturePath, cwd: root },
    );
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as {
      hookSpecificOutput: { additionalContext: string };
    };
    expect(output.hookSpecificOutput.additionalContext).toBe('UNIQUE-HANDOFF-TOKEN');
  });

  it.each([
    ['claude', resolve('plugins/claude/hooks/session-start.ts')],
    ['codex', resolve('plugins/codex/hooks/session-start.ts')],
  ] as const)('%s adapter suppresses injection on clear when opted in (E2)', (_name, hookPath) => {
    const root = tempRoot('circuit-handoff-hook-clear-suppress-');
    const projectRoot = join(root, 'project');
    const capturePath = join(root, 'capture.json');
    const launcher = writeStubLauncher(root);
    mkdirSync(projectRoot, { recursive: true });

    // The operator just wiped context with /clear and opted out of re-injecting
    // the snapshot they cleared: the hook stays silent.
    const result = runHook(
      { hook_event_name: 'SessionStart', source: 'clear', cwd: projectRoot },
      {
        hookPath,
        launcher,
        capturePath,
        cwd: root,
        env: { CIRCUIT_HANDOFF_ON_CLEAR: 'suppress' },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
  });

  it.each([
    ['claude', resolve('plugins/claude/hooks/session-start.ts')],
    ['codex', resolve('plugins/codex/hooks/session-start.ts')],
  ] as const)(
    '%s adapter suppresses injection on compact when opted in (E2)',
    (_name, hookPath) => {
      const root = tempRoot('circuit-handoff-hook-compact-suppress-');
      const projectRoot = join(root, 'project');
      const capturePath = join(root, 'capture.json');
      const launcher = writeStubLauncher(root);
      mkdirSync(projectRoot, { recursive: true });

      const result = runHook(
        { hook_event_name: 'SessionStart', source: 'compact', cwd: projectRoot },
        {
          hookPath,
          launcher,
          capturePath,
          cwd: root,
          env: { CIRCUIT_HANDOFF_ON_COMPACT: 'suppress' },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('');
    },
  );

  it.each([
    ['claude', resolve('plugins/claude/hooks/session-start.ts')],
    ['codex', resolve('plugins/codex/hooks/session-start.ts')],
  ] as const)(
    '%s adapter still injects on startup even when clear is suppressed (E2 is per-source)',
    (_name, hookPath) => {
      const root = tempRoot('circuit-handoff-hook-startup-keep-');
      const projectRoot = join(root, 'project');
      const capturePath = join(root, 'capture.json');
      const launcher = writeStubLauncher(root);
      mkdirSync(projectRoot, { recursive: true });

      // Suppressing clear must not bleed into a real startup: startup always
      // injects the full brief.
      const result = runHook(
        { hook_event_name: 'SessionStart', source: 'startup', cwd: projectRoot },
        {
          hookPath,
          launcher,
          capturePath,
          cwd: root,
          env: { CIRCUIT_HANDOFF_ON_CLEAR: 'suppress' },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      const output = JSON.parse(result.stdout) as {
        hookSpecificOutput: { additionalContext: string };
      };
      expect(output.hookSpecificOutput.additionalContext).toBe('UNIQUE-HANDOFF-TOKEN');
    },
  );
});
