import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  discoverConfigLayers,
  discoverRuntimeConfigLayers,
  projectConfigPath,
} from '../../src/shared/config-loader.js';

// An unrecognized config key has two honest explanations: a typo, or a key
// added by a newer Circuit than the one reading the file. Additive optional
// keys land without a schema_version bump (power_auto and project_id both did),
// so version matching cannot flag the second case — the operator just sees a
// strict-parse failure on a key that is perfectly valid somewhere else. The
// loader stays strict (it still throws); the error must name both explanations
// instead of leaving a bare schema dump.

let root: string;
let homeDir: string;
let cwdDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'circuit-config-guidance-'));
  homeDir = join(root, 'home');
  cwdDir = join(root, 'cwd');
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(cwdDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeProjectConfig(text: string): void {
  mkdirSync(join(cwdDir, '.circuit'), { recursive: true });
  writeFileSync(projectConfigPath(cwdDir), text);
}

describe('config loader unrecognized-key guidance', () => {
  it('an unknown key still fails, and the error says typo-or-newer-Circuit', () => {
    writeProjectConfig('schema_version: 1\npower_boost: {}\n');
    let message = '';
    try {
      discoverRuntimeConfigLayers({ homeDir, cwd: cwdDir });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('config validation failed for project');
    expect(message).toContain('power_boost');
    expect(message).toContain('typo');
    expect(message).toContain('newer Circuit');
  });

  it('the selection-only loader gives the same guidance', () => {
    writeProjectConfig('schema_version: 1\npower_boost: {}\n');
    expect(() => discoverConfigLayers({ homeDir, cwd: cwdDir })).toThrow(/newer Circuit/);
  });

  it('a wrong-typed known key keeps the plain error — the hint would mislead', () => {
    writeProjectConfig('schema_version: 1\ndefaults:\n  power: 11\n');
    let message = '';
    try {
      discoverRuntimeConfigLayers({ homeDir, cwd: cwdDir });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('config validation failed for project');
    expect(message).not.toContain('newer Circuit');
  });

  // The per-flow config key was `circuits` through alpha.10; v1 renamed it to
  // `flows`. An alpha config still carrying `circuits:` is not a typo and not a
  // newer-Circuit key, so the generic hint would mislead. The error names the
  // rename and the replacement so the fix is one edit away.
  it('the legacy `circuits` key errors with a did-you-mean pointing at `flows`', () => {
    writeProjectConfig(
      'schema_version: 1\ncircuits:\n  fix:\n    selection:\n      effort: high\n',
    );
    let message = '';
    try {
      discoverRuntimeConfigLayers({ homeDir, cwd: cwdDir });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('config validation failed for project');
    expect(message).toContain('`circuits`');
    expect(message).toContain('renamed to `flows`');
    // The rename hint replaces the generic one — it would be noise here.
    expect(message).not.toContain('newer Circuit');
  });

  it('the legacy `relay.circuits` key also gets the rename hint', () => {
    writeProjectConfig(
      'schema_version: 1\nrelay:\n  circuits:\n    fix: { kind: builtin, name: claude-code }\n',
    );
    let message = '';
    try {
      discoverRuntimeConfigLayers({ homeDir, cwd: cwdDir });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('renamed to `flows`');
  });
});
