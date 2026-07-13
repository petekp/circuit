import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runConfigCommand } from '../../src/cli/config-command.js';

// `circuit config` is the programmatic half of the configuration surface: the
// interactive shell dispatches through the same functions, so these tests pin
// the contract both frontends share. Writes go through the YAML Document API
// (comments survive) and the merged result must re-validate against the full
// Config schema before anything lands on disk.

let stdout: string[];
let stderr: string[];
let homeDir: string;
let projectDir: string;

beforeEach(() => {
  stdout = [];
  stderr = [];
  homeDir = mkdtempSync(join(tmpdir(), 'circuit-config-home-'));
  projectDir = mkdtempSync(join(tmpdir(), 'circuit-config-project-'));
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function plainStdout(): string {
  return stdout.join('').replace(ANSI_PATTERN, '');
}

function run(argv: readonly string[]): number {
  return runConfigCommand(argv, { homeDir, cwd: projectDir });
}

function projectConfigFile(): string {
  return join(projectDir, '.circuit', 'config.yaml');
}

function globalConfigFile(): string {
  return join(homeDir, '.config', 'circuit', 'config.yaml');
}

describe('circuit config set', () => {
  it('creates the project config file with schema_version when absent', () => {
    const code = run(['set', 'defaults.power', 'high']);
    expect(code).toBe(0);
    const body = readFileSync(projectConfigFile(), 'utf8');
    expect(body).toContain('schema_version: 1');
    expect(body).toContain('power: high');
    expect(plainStdout()).toContain('defaults.power');
    expect(plainStdout()).toContain('high');
  });

  it('targets the user-global file with --global', () => {
    const code = run(['set', 'defaults.power', 'low', '--global']);
    expect(code).toBe(0);
    expect(readFileSync(globalConfigFile(), 'utf8')).toContain('power: low');
  });

  it('preserves comments and unrelated keys on existing files', () => {
    mkdirSync(join(projectDir, '.circuit'), { recursive: true });
    writeFileSync(
      projectConfigFile(),
      ['# operator notes live here', 'schema_version: 1', 'defaults:', '  power: low', ''].join(
        '\n',
      ),
    );
    const code = run(['set', 'defaults.power', 'high']);
    expect(code).toBe(0);
    const body = readFileSync(projectConfigFile(), 'utf8');
    expect(body).toContain('# operator notes live here');
    expect(body).toContain('power: high');
  });

  it('rejects a value the schema refuses and leaves the file untouched', () => {
    mkdirSync(join(projectDir, '.circuit'), { recursive: true });
    const before = ['schema_version: 1', 'defaults:', '  power: low', ''].join('\n');
    writeFileSync(projectConfigFile(), before);
    const code = run(['set', 'defaults.power', 'ludicrous']);
    expect(code).toBe(2);
    expect(stderr.join('')).toContain('defaults.power');
    expect(readFileSync(projectConfigFile(), 'utf8')).toBe(before);
  });

  it('rejects an unknown key (strict schema) without writing', () => {
    const code = run(['set', 'defaults.powr', 'high']);
    expect(code).toBe(2);
    expect(stderr.join('')).toContain('powr');
  });

  // M1 — object-typed keys must reject a bare name by naming the shape that
  // works, not with schema parser jargon.
  it('rejects a bare connector name for an object-typed key and names the working form', () => {
    const code = run(['set', 'relay.roles.reviewer', 'codex']);
    expect(code).toBe(2);
    const err = stderr.join('');
    expect(err).toContain('relay.roles.reviewer');
    expect(err).toContain("'{kind: builtin, name: codex}'");
    expect(err).not.toContain('Invalid input');
  });

  it('accepts the suggested inline-YAML object form for object-typed keys', () => {
    const code = run(['set', 'relay.roles.reviewer', '{kind: builtin, name: codex}']);
    expect(code).toBe(0);
    const body = readFileSync(projectConfigFile(), 'utf8');
    expect(body).toContain('kind: builtin');
    expect(body).toContain('name: codex');
  });

  // P10a — unknown top-level keys get plain English plus the valid key list,
  // not a zod path like `(root)`.
  it('rejects an unknown top-level key in plain English naming the valid keys', () => {
    const code = run(['set', 'banana.split', 'yes']);
    expect(code).toBe(2);
    const err = stderr.join('');
    expect(err).toContain('banana');
    expect(err).not.toContain('(root)');
    expect(err).toContain('relay');
    expect(err).toContain('defaults');
  });

  it('refuses to edit a policy envelope (schema_version 2) file', () => {
    mkdirSync(join(projectDir, '.circuit'), { recursive: true });
    writeFileSync(projectConfigFile(), 'schema_version: 2\n');
    const code = run(['set', 'defaults.power', 'high']);
    expect(code).toBe(2);
    expect(stderr.join('')).toContain('policy');
    expect(readFileSync(projectConfigFile(), 'utf8')).toBe('schema_version: 2\n');
  });
});

describe('circuit config unset', () => {
  it('removes a key and keeps the file valid when other content remains', () => {
    mkdirSync(join(projectDir, '.circuit'), { recursive: true });
    writeFileSync(
      projectConfigFile(),
      ['schema_version: 1', 'project_id: my-project', 'defaults:', '  power: high', ''].join('\n'),
    );
    const code = run(['unset', 'defaults.power']);
    expect(code).toBe(0);
    const body = readFileSync(projectConfigFile(), 'utf8');
    expect(body).not.toContain('power');
    expect(body).toContain('project_id: my-project');
  });

  it('reports already-unset keys without failing', () => {
    const code = run(['unset', 'defaults.power']);
    expect(code).toBe(0);
    expect(plainStdout()).toContain('already unset');
  });

  // P10b — product rule 7: healthy defaults write no config. Unsetting the
  // last user-set value must not leave a residue file behind.
  it('removes the file when the last user-set value is unset', () => {
    run(['set', 'defaults.power', 'high']);
    expect(existsSync(projectConfigFile())).toBe(true);
    const code = run(['unset', 'defaults.power']);
    expect(code).toBe(0);
    expect(existsSync(projectConfigFile())).toBe(false);
    expect(plainStdout()).toContain('removed');
  });

  it('keeps the file when other user content remains', () => {
    mkdirSync(join(projectDir, '.circuit'), { recursive: true });
    writeFileSync(
      projectConfigFile(),
      ['schema_version: 1', 'project_id: my-project', 'defaults:', '  power: high', ''].join('\n'),
    );
    const code = run(['unset', 'defaults.power']);
    expect(code).toBe(0);
    expect(existsSync(projectConfigFile())).toBe(true);
    expect(readFileSync(projectConfigFile(), 'utf8')).toContain('project_id: my-project');
  });

  it('keeps the file when it carries operator comments', () => {
    mkdirSync(join(projectDir, '.circuit'), { recursive: true });
    writeFileSync(
      projectConfigFile(),
      ['# operator notes live here', 'schema_version: 1', 'defaults:', '  power: high', ''].join(
        '\n',
      ),
    );
    const code = run(['unset', 'defaults.power']);
    expect(code).toBe(0);
    expect(existsSync(projectConfigFile())).toBe(true);
    expect(readFileSync(projectConfigFile(), 'utf8')).toContain('# operator notes live here');
  });
});

describe('circuit config show', () => {
  it('renders layer presence and effective values with provenance', () => {
    mkdirSync(join(projectDir, '.circuit'), { recursive: true });
    writeFileSync(
      projectConfigFile(),
      ['schema_version: 1', 'defaults:', '  power: high', ''].join('\n'),
    );
    const code = run(['show']);
    expect(code).toBe(0);
    const out = plainStdout();
    expect(out).toContain('user-global');
    expect(out).toContain('project');
    expect(out).toContain('defaults.power');
    expect(out).toContain('high');
    // Provenance: the value came from the project layer.
    expect(out).toMatch(/defaults\.power.*high.*project/s);
    // Untouched keys read as defaults.
    expect(out).toContain('default');
  });

  // B6 — provenance comes from the raw layer documents, pre-defaulting. A
  // schema default that materializes on parse (relay.default: auto) must read
  // as the built-in default, never as a value the project set.
  it('a config file with no set values reads as defaults, not project-set', () => {
    mkdirSync(join(projectDir, '.circuit'), { recursive: true });
    writeFileSync(projectConfigFile(), ['schema_version: 1', 'defaults: {}', ''].join('\n'));
    const code = run(['show']);
    expect(code).toBe(0);
    const out = plainStdout();
    const relayLine = out.split('\n').find((line) => line.startsWith('relay.default'));
    expect(relayLine).toBeDefined();
    expect(relayLine).toContain('default');
    expect(relayLine).not.toContain('project');
  });

  it('show --json reports source project only for values the document really sets', () => {
    mkdirSync(join(projectDir, '.circuit'), { recursive: true });
    writeFileSync(
      projectConfigFile(),
      ['schema_version: 1', 'relay:', '  default: codex', ''].join('\n'),
    );
    const code = run(['show', '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.join('')) as {
      effective: Record<string, { value: unknown; source: string }>;
    };
    expect(parsed.effective['relay.default']?.value).toBe('codex');
    expect(parsed.effective['relay.default']?.source).toBe('project');
    // Nothing set defaults.power, so it must read as the built-in default.
    expect(parsed.effective['defaults.power']?.source).toBe('default');
  });

  // P4 — machine surfaces carry a schema version.
  it('show --json carries schema_version 1', () => {
    const code = run(['show', '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.join('')) as { schema_version: number };
    expect(parsed.schema_version).toBe(1);
  });

  it('emits the discovered layers as JSON with --json', () => {
    mkdirSync(join(projectDir, '.circuit'), { recursive: true });
    writeFileSync(
      projectConfigFile(),
      ['schema_version: 1', 'defaults:', '  power: medium', ''].join('\n'),
    );
    const code = run(['show', '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout.join('')) as {
      layers: Array<{ layer: string; config: { defaults?: { power?: string } } }>;
      effective: Record<string, { value: unknown; source: string }>;
    };
    expect(parsed.layers.some((l) => l.layer === 'project')).toBe(true);
    expect(parsed.effective['defaults.power']?.value).toBe('medium');
    expect(parsed.effective['defaults.power']?.source).toBe('project');
  });
});

describe('circuit config argument handling', () => {
  it('rejects set without a value', () => {
    const code = run(['set', 'defaults.power']);
    expect(code).toBe(2);
  });

  it('rejects an unknown subcommand with guidance', () => {
    const code = run(['frobnicate']);
    expect(code).toBe(2);
    expect(stderr.join('')).toContain('show, set, or unset');
  });

  it('rejects --project combined with --global', () => {
    const code = run(['set', 'defaults.power', 'high', '--project', '--global']);
    expect(code).toBe(2);
  });
});
