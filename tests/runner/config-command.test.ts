import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  it('removes a key and keeps the file valid', () => {
    mkdirSync(join(projectDir, '.circuit'), { recursive: true });
    writeFileSync(
      projectConfigFile(),
      ['schema_version: 1', 'defaults:', '  power: high', ''].join('\n'),
    );
    const code = run(['unset', 'defaults.power']);
    expect(code).toBe(0);
    expect(readFileSync(projectConfigFile(), 'utf8')).not.toContain('power');
  });

  it('reports already-unset keys without failing', () => {
    const code = run(['unset', 'defaults.power']);
    expect(code).toBe(0);
    expect(plainStdout()).toContain('already unset');
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
