// Run intake probed the worker CLIs for presence and stopped there, so a
// signed-out CLI was discovered mid-flight, after the healthy branches had
// already spent. `circuit doctor` knew how to ask (`codex login status`,
// `cursor-agent status`) and intake never asked. It asks now.
//
// It warns rather than refuses, for the same reason a missing CLI warns: a run
// can reach its first checkpoint before any worker spawns, and a CLI that
// reports itself signed out is sometimes wrong (see the transient sign-out
// doubt in src/connectors/subprocess.ts). A false positive must not be able to
// stop a run at the door.
import { describe, expect, it } from 'vitest';
import { loadCompiledFlow, resolveCompiledFlowPath } from '../../src/cli/compiled-flow-loading.js';
import { preflightRunConnectors } from '../../src/cli/run-preflight.js';
import {
  builtinConnectorSignInCommand,
  probeReportsSignedOut,
} from '../../src/connectors/health.js';
import { LayeredConfig } from '../../src/schemas/config.js';

function reviewFlow() {
  return loadCompiledFlow(resolveCompiledFlowPath('review', undefined, undefined, undefined)).flow;
}

const CODEX_PROJECT = LayeredConfig.parse({
  layer: 'project',
  config: { schema_version: 1, relay: { default: 'codex' } },
});

const PRESENT = {
  kind: 'ran',
  code: 0,
  stdout: 'codex-cli 0.146.0',
  stderr: '',
  timedOut: false,
} as const;

describe('reading a sign-in probe', () => {
  it('calls a CLI signed out when it says so, or when it exits nonzero', () => {
    expect(
      probeReportsSignedOut({
        kind: 'ran',
        code: 0,
        stdout: 'Not logged in',
        stderr: '',
        timedOut: false,
      }),
    ).toBe(true);
    expect(
      probeReportsSignedOut({ kind: 'ran', code: 1, stdout: '', stderr: '', timedOut: false }),
    ).toBe(true);
  });

  it('never calls a CLI signed out on evidence it does not have', () => {
    // Answered and happy.
    expect(
      probeReportsSignedOut({
        kind: 'ran',
        code: 0,
        stdout: 'Logged in using ChatGPT',
        stderr: '',
        timedOut: false,
      }),
    ).toBe(false);
    // A probe that could not run, or ran out of time, is "could not check".
    expect(probeReportsSignedOut({ kind: 'spawn_error', message: 'ENOENT' })).toBe(false);
    expect(
      probeReportsSignedOut({ kind: 'ran', code: null, stdout: '', stderr: '', timedOut: true }),
    ).toBe(false);
  });

  it('knows the sign-in command for the CLIs that have one', () => {
    expect(builtinConnectorSignInCommand('codex')).toBe('codex login');
    expect(builtinConnectorSignInCommand('cursor-agent')).toBe('cursor-agent login');
    // claude-code has no cheap offline sign-in probe, so intake never claims
    // to have checked it.
    expect(builtinConnectorSignInCommand('claude-code')).toBeUndefined();
  });
});

describe('what intake does with a signed-out worker CLI', () => {
  it('warns with the sign-in command and lets the run start', async () => {
    const verdict = await preflightRunConnectors({
      flow: reviewFlow(),
      configLayers: [CODEX_PROJECT],
      depth: 'medium',
      probes: {
        presence: () => Promise.resolve(PRESENT),
        stateDir: (dir) => ({ writable: true, dir }),
        signIn: () =>
          Promise.resolve({
            kind: 'ran',
            code: 0,
            stdout: 'Not logged in',
            stderr: '',
            timedOut: false,
          }),
      },
    });

    expect(verdict.ok).toBe(true);
    if (!verdict.ok) throw new Error('a signed-out CLI must not refuse the run');
    expect(verdict.warnings).toHaveLength(1);
    expect(verdict.warnings[0]).toContain("this run's steps relay through the codex CLI");
    expect(verdict.warnings[0]).toContain('reports that it is not signed in');
    expect(verdict.warnings[0]).toContain('Not logged in');
    expect(verdict.warnings[0]).toContain('codex login');
  });

  it('says nothing when the CLI reports itself signed in', async () => {
    const verdict = await preflightRunConnectors({
      flow: reviewFlow(),
      configLayers: [CODEX_PROJECT],
      depth: 'medium',
      probes: {
        presence: () => Promise.resolve(PRESENT),
        stateDir: (dir) => ({ writable: true, dir }),
        signIn: () =>
          Promise.resolve({
            kind: 'ran',
            code: 0,
            stdout: 'Logged in using ChatGPT',
            stderr: '',
            timedOut: false,
          }),
      },
    });
    expect(verdict).toEqual({ ok: true, warnings: [] });
  });

  it('stays quiet when the sign-in probe itself could not answer', async () => {
    const verdict = await preflightRunConnectors({
      flow: reviewFlow(),
      configLayers: [CODEX_PROJECT],
      depth: 'medium',
      probes: {
        presence: () => Promise.resolve(PRESENT),
        stateDir: (dir) => ({ writable: true, dir }),
        signIn: () =>
          Promise.resolve({ kind: 'ran', code: null, stdout: '', stderr: '', timedOut: true }),
      },
    });
    expect(verdict).toEqual({ ok: true, warnings: [] });
  });

  it('does not ask a CLI about sign-in when the CLI is not there', async () => {
    let signInAsks = 0;
    const verdict = await preflightRunConnectors({
      flow: reviewFlow(),
      configLayers: [CODEX_PROJECT],
      depth: 'medium',
      probes: {
        presence: () => Promise.resolve({ kind: 'spawn_error', message: 'spawn codex ENOENT' }),
        stateDir: (dir) => ({ writable: true, dir }),
        signIn: () => {
          signInAsks += 1;
          return Promise.resolve(undefined);
        },
      },
    });

    expect(signInAsks).toBe(0);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) throw new Error('a missing CLI must not refuse the run');
    // One warning, about the missing CLI. Not two: a CLI that is absent is not
    // separately reported as signed out.
    expect(verdict.warnings).toHaveLength(1);
    expect(verdict.warnings[0]).toContain('was not found');
  });

  it('only probes the connectors this run actually plans to use', async () => {
    const asked: string[] = [];
    await preflightRunConnectors({
      flow: reviewFlow(),
      configLayers: [CODEX_PROJECT],
      depth: 'medium',
      probes: {
        presence: () => Promise.resolve(PRESENT),
        stateDir: (dir) => ({ writable: true, dir }),
        signIn: (connector) => {
          asked.push(connector);
          return Promise.resolve(undefined);
        },
      },
    });
    expect(asked).toEqual(['codex']);
  });
});
