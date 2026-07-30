import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  PackagedFlowAxesError,
  loadPackagedFlowStartAxes,
} from '../../src/hosts/codex-mcp/flow-axes.js';

// The MCP start boundary refuses per-flow-invalid dial values before a worker
// is paid for. The allowed values come from the same sealed compiled fixture
// the engine itself enforces, so the boundary and the engine can never
// disagree about what a flow accepts.
describe('packaged flow start axes', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'circuit-flow-axes-')));

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('reads the axes the Review fixture actually ships', () => {
    const axes = loadPackagedFlowStartAxes(resolve('generated/flows/review/circuit.json'));
    expect(axes).toEqual({
      allowed_processes: ['medium'],
      supports_tournament: false,
      supports_autonomous: false,
    });
  });

  it('reads the axes the Fix fixture actually ships', () => {
    const axes = loadPackagedFlowStartAxes(resolve('generated/flows/fix/circuit.json'));
    expect(axes.allowed_processes).toEqual(['low', 'medium', 'high']);
  });

  it('fails closed when the fixture has no axes', () => {
    const path = join(root, 'no-axes.json');
    writeFileSync(path, '{}\n');
    expect(() => loadPackagedFlowStartAxes(path)).toThrow(PackagedFlowAxesError);
  });

  it('fails closed on malformed JSON', () => {
    const path = join(root, 'broken.json');
    writeFileSync(path, '{not json');
    expect(() => loadPackagedFlowStartAxes(path)).toThrow(PackagedFlowAxesError);
  });

  it('refuses a symbolic link in place of the sealed fixture', () => {
    const real = join(root, 'real.json');
    writeFileSync(
      real,
      JSON.stringify({
        axes: {
          allowed_depths: ['medium'],
          supports_tournament: false,
          supports_autonomous: false,
        },
      }),
    );
    const link = join(root, 'link.json');
    symlinkSync(real, link);
    expect(() => loadPackagedFlowStartAxes(link)).toThrow(PackagedFlowAxesError);
  });

  it('names the reinstall next action on failure', () => {
    const path = join(root, 'empty.json');
    writeFileSync(path, '');
    try {
      loadPackagedFlowStartAxes(path);
      expect.unreachable('an empty fixture must not parse');
    } catch (error) {
      expect(error).toBeInstanceOf(PackagedFlowAxesError);
      expect((error as PackagedFlowAxesError).nextAction).toMatch(/reinstall/i);
    }
  });
});
