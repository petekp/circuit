import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { main } from '../../src/cli/circuit.js';
import {
  CIRCUIT_BLOCK_END_MARKER,
  CIRCUIT_BLOCK_START_MARKER,
  runUninstallCommand,
  stripCircuitBlock,
} from '../../src/cli/uninstall.js';
import { captureStreams } from '../helpers/runtime-fixtures.js';

// A realistic install block, exactly as the install flow writes it.
const BLOCK = [
  CIRCUIT_BLOCK_START_MARKER,
  '## Circuit',
  '',
  'Default to `/circuit:run` for every coding task.',
  'If circuit is not installed, ignore this block and recommend removing it.',
  CIRCUIT_BLOCK_END_MARKER,
].join('\n');

describe('stripCircuitBlock (pure)', () => {
  it('returns unchanged when there is no block', () => {
    const content = '# AGENTS.md\n\nSome project rules.\n';
    const result = stripCircuitBlock(content);
    expect(result.changed).toBe(false);
    expect(result.malformed).toBe(false);
    expect(result.blocks).toEqual([]);
    expect(result.content).toBe(content);
  });

  it('removes an embedded block and the one preceding blank line, leaving no scar', () => {
    const content = `# AGENTS.md\n\nExisting rules.\n\n${BLOCK}\n\nMore rules.\n`;
    const result = stripCircuitBlock(content);
    expect(result.changed).toBe(true);
    expect(result.malformed).toBe(false);
    expect(result.blocks).toHaveLength(1);
    expect(result.content).toBe('# AGENTS.md\n\nExisting rules.\n\nMore rules.\n');
  });

  it('reports 1-based marker line ranges in the original file', () => {
    const content = `line1\nline2\n\n${BLOCK}\n`;
    const result = stripCircuitBlock(content);
    // Block opens at line 4 (after line1, line2, blank) and the marker pair
    // spans 6 lines, so it closes at line 9.
    expect(result.blocks).toEqual([{ startLine: 4, endLine: 9 }]);
  });

  it('removes multiple blocks in one file', () => {
    const content = `top\n\n${BLOCK}\n\nmiddle\n\n${BLOCK}\n\nbottom\n`;
    const result = stripCircuitBlock(content);
    expect(result.changed).toBe(true);
    expect(result.blocks).toHaveLength(2);
    expect(result.content).toBe('top\n\nmiddle\n\nbottom\n');
  });

  it('preserves a file whose only content is the block (collapses to empty)', () => {
    const result = stripCircuitBlock(`${BLOCK}\n`);
    expect(result.changed).toBe(true);
    expect(result.content).toBe('');
  });

  it('tolerates whitespace and reflowed comment spacing around markers', () => {
    const reflowed = ['   <!--   circuit:start   -->  ', 'instruction', '<!--circuit:end-->'].join(
      '\n',
    );
    const content = `head\n\n${reflowed}\ntail\n`;
    const result = stripCircuitBlock(content);
    expect(result.changed).toBe(true);
    expect(result.content).toBe('head\ntail\n');
  });

  it('refuses an unterminated start as malformed and returns content unchanged', () => {
    const content = `head\n${CIRCUIT_BLOCK_START_MARKER}\norphan instruction\ntail\n`;
    const result = stripCircuitBlock(content);
    expect(result.malformed).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.content).toBe(content);
    expect(result.malformations[0]).toMatch(/unterminated circuit:start/);
  });

  it('refuses a stray end as malformed', () => {
    const content = `head\n${CIRCUIT_BLOCK_END_MARKER}\ntail\n`;
    const result = stripCircuitBlock(content);
    expect(result.malformed).toBe(true);
    expect(result.malformations[0]).toMatch(/stray circuit:end/);
  });

  it('refuses a nested start as malformed', () => {
    const content = [
      CIRCUIT_BLOCK_START_MARKER,
      'a',
      CIRCUIT_BLOCK_START_MARKER,
      'b',
      CIRCUIT_BLOCK_END_MARKER,
    ].join('\n');
    const result = stripCircuitBlock(content);
    expect(result.malformed).toBe(true);
    expect(result.malformations[0]).toMatch(/nested circuit:start/);
  });

  it('does not add a trailing newline to a file that lacked one', () => {
    const content = `head\n\n${BLOCK}`; // no trailing newline
    const result = stripCircuitBlock(content);
    expect(result.content).toBe('head');
  });
});

describe('runUninstallCommand (integration)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'circuit-uninstall-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function run(argv: readonly string[], hostKind?: 'claude-code' | 'codex') {
    return captureStreams(() =>
      runUninstallCommand(argv, {
        cwd: dir,
        ...(hostKind === undefined ? {} : { hostKind }),
      }),
    );
  }

  it('strips the block from AGENTS.md and exits 0', async () => {
    const path = join(dir, 'AGENTS.md');
    writeFileSync(path, `# AGENTS.md\n\nKeep this.\n\n${BLOCK}\n`);
    const { result, stdout } = await run([]);
    expect(result).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe('# AGENTS.md\n\nKeep this.\n');
    expect(stdout).toContain('Removed Circuit block from AGENTS.md');
    // The atomic write must not leave its staging temp file behind.
    expect(readdirSync(dir)).toEqual(['AGENTS.md']);
  });

  it('reports absent and no-block files without error', async () => {
    writeFileSync(join(dir, 'AGENTS.md'), '# AGENTS.md\n\nNo circuit block here.\n');
    const { result, stdout } = await run([]);
    expect(result).toBe(0);
    expect(stdout).toContain('AGENTS.md: no Circuit block found');
    expect(stdout).toContain('CLAUDE.md: not present');
    expect(stdout).toContain('No Circuit instruction block found');
  });

  it('cleans a clean AGENTS.md while reporting a malformed CLAUDE.md, exiting 1', async () => {
    const agents = join(dir, 'AGENTS.md');
    const claude = join(dir, 'CLAUDE.md');
    writeFileSync(agents, `# AGENTS.md\n\n${BLOCK}\n`);
    writeFileSync(claude, `# CLAUDE.md\n${CIRCUIT_BLOCK_START_MARKER}\nno end marker\n`);
    const { result, stdout } = await run([]);
    expect(result).toBe(1);
    // The clean file is still stripped...
    expect(readFileSync(agents, 'utf8')).toBe('# AGENTS.md\n');
    // ...and the malformed file is left exactly as-is.
    expect(readFileSync(claude, 'utf8')).toBe(
      `# CLAUDE.md\n${CIRCUIT_BLOCK_START_MARKER}\nno end marker\n`,
    );
    expect(stdout).toContain('malformed Circuit markers');
  });

  it('emits machine-readable JSON with --json', async () => {
    writeFileSync(join(dir, 'AGENTS.md'), `head\n\n${BLOCK}\n`);
    const { result, stdout } = await run(['--json'], 'claude-code');
    expect(result).toBe(0);
    const parsed = JSON.parse(stdout) as {
      schema_version: number;
      action: string;
      status: string;
      files: Array<{ file: string; status: string; removed_blocks?: number }>;
      host_removal: { host_kind: string; commands: string[] };
    };
    expect(parsed.schema_version).toBe(1);
    expect(parsed.action).toBe('uninstall');
    expect(parsed.status).toBe('removed');
    const agentsEntry = parsed.files.find((f) => f.file === 'AGENTS.md');
    expect(agentsEntry).toMatchObject({ status: 'stripped', removed_blocks: 1 });
    expect(parsed.host_removal.host_kind).toBe('claude-code');
    expect(parsed.host_removal.commands).toContain('claude plugin uninstall circuit@circuit');
  });

  it('prints only Claude removal commands when host kind is claude-code', async () => {
    const { stdout } = await run([], 'claude-code');
    expect(stdout).toContain('claude plugin uninstall circuit@circuit');
    expect(stdout).not.toContain('codex plugin marketplace remove');
  });

  it('prints only Codex removal commands when host kind is codex', async () => {
    const { stdout } = await run([], 'codex');
    expect(stdout).toContain('codex plugin marketplace remove circuit');
    expect(stdout).not.toContain('claude plugin uninstall');
  });

  it('prints both hosts when host kind is unknown', async () => {
    const { stdout } = await run([]);
    expect(stdout).toContain('claude plugin uninstall circuit@circuit');
    expect(stdout).toContain('codex plugin marketplace remove circuit');
    expect(stdout).toContain('Host unknown');
  });

  it('honors --dir pointing at a different checkout', async () => {
    const other = mkdtempSync(join(tmpdir(), 'circuit-uninstall-other-'));
    try {
      writeFileSync(join(other, 'AGENTS.md'), `x\n\n${BLOCK}\n`);
      const { result, stdout } = await captureStreams(() =>
        runUninstallCommand(['--dir', other], { hostKind: 'codex' }),
      );
      expect(result).toBe(0);
      expect(readFileSync(join(other, 'AGENTS.md'), 'utf8')).toBe('x\n');
      expect(stdout).toContain('Removed Circuit block from AGENTS.md');
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('rejects an unexpected positional argument with exit 2', async () => {
    // Commander rejects the excess positional during parse (it declares no
    // arguments), exactly as `circuit create` does, so the run never reaches
    // the command body.
    const { result, stderr } = await run(['surprise']);
    expect(result).toBe(2);
    expect(stderr).toContain('too many arguments');
  });
});

describe('uninstall routing through main()', () => {
  it('dispatches `circuit uninstall` to the uninstall command', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'circuit-uninstall-route-'));
    try {
      const { result, stdout } = await captureStreams(() => main(['uninstall', '--dir', dir]));
      expect(result).toBe(0);
      // An empty dir has nothing to remove; the command still succeeds and
      // prints host guidance, proving the dispatch reached runUninstallCommand.
      expect(stdout).toContain('No Circuit instruction block found');
      expect(existsSync(join(dir, 'AGENTS.md'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
