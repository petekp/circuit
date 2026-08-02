import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { preflightRunConnectors } from '../../src/cli/run-preflight.js';
import { parseExecutionArgs, runExecutionCommand } from '../../src/cli/run.js';
import {
  connectorFailureSummary,
  forgetConnectorSuccesses,
  isTransientSignOutFailure,
} from '../../src/connectors/subprocess.js';
import { connectorRetrySchedule } from '../../src/runtime/executors/relay.js';
import { LayeredConfig } from '../../src/schemas/config.js';
import { PolicyLayer } from '../../src/schemas/policy-envelope.js';
import { captureStreams, makeStubRelayer } from '../helpers/runtime-fixtures.js';

const VALID_REVIEW_BODY = JSON.stringify({
  unit_id: 'unit-1',
  verdict: 'NO_ISSUES_FOUND',
  findings: [],
  assessment: 'Stub reviewer: nothing actionable in the relayed evidence.',
  verification: ['Inspected the relayed intake report.'],
  confidence_limitations: [],
});

// The sandboxed-session failure class, refused at intake. A run launched from
// a sandboxed host session spawns codex, codex cannot write ~/.codex, and the
// run used to die seconds in with raw stderr. The intake preflight probes the
// chosen connectors in the run's own environment and refuses BEFORE the run
// folder exists, with the cause (setup: sandboxed session) and the next step.
// Refusal is reserved for that class alone; a merely missing CLI warns and
// lets the run proceed (second test).
//
// This is end-to-end through the real command path: real intake, real config
// discovery pinning codex, real preflight logic — only the two probes are
// injected, so the test neither spawns a real codex nor chmods the operator's
// home directory.

function tempProjectPinningCodex(): { projectDir: string; homeDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'circuit-preflight-refusal-'));
  const projectDir = join(root, 'project');
  const homeDir = join(root, 'home');
  mkdirSync(join(projectDir, '.circuit'), { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  writeFileSync(
    join(projectDir, '.circuit', 'config.yaml'),
    'schema_version: 1\nrelay:\n  default: codex\n',
  );
  return { projectDir, homeDir };
}

function tempBuildProjectPinningUnsupportedCodexEffort(): {
  projectDir: string;
  homeDir: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'circuit-effort-preflight-refusal-'));
  const projectDir = join(root, 'project');
  const homeDir = join(root, 'home');
  mkdirSync(join(projectDir, '.circuit'), { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  writeFileSync(
    join(projectDir, '.circuit', 'config.yaml'),
    [
      'schema_version: 1',
      'relay:',
      '  default: codex',
      'flows:',
      '  build:',
      '    selection:',
      '      effort: none',
      '      depth: low',
      'defaults:',
      '  power: auto',
      '',
    ].join('\n'),
  );
  return { projectDir, homeDir };
}

describe('run intake preflight: refuse the sandbox class, warn on missing CLIs', () => {
  it('refuses an unsupported codex effort before creating the run folder', async () => {
    const { projectDir, homeDir } = tempBuildProjectPinningUnsupportedCodexEffort();
    const runFolder = join(projectDir, '.circuit', 'runs', 'unsupported-effort-run');
    const args = parseExecutionArgs('run', [
      'build',
      '--goal',
      'reject an incompatible connector selection before starting',
      '--run-folder',
      runFolder,
    ]);
    let relayCalls = 0;

    const { result, stderr } = await captureStreams(() =>
      runExecutionCommand(args, {
        configCwd: projectDir,
        configHomeDir: homeDir,
        relayer: makeStubRelayer(
          () => {
            relayCalls += 1;
            return '{"verdict":"accept"}';
          },
          { connectorName: 'codex' },
        ),
        connectorPreflight: (input) =>
          preflightRunConnectors({
            ...input,
            probes: {
              presence: () =>
                Promise.resolve({
                  kind: 'ran',
                  code: 0,
                  stdout: 'codex-cli 0.144.3',
                  stderr: '',
                  timedOut: false,
                }),
              signIn: () => Promise.resolve(undefined),
              stateDir: (dir) => ({ writable: true, dir }),
            },
          }),
      }),
    );

    expect(result).toBe(2);
    expect(stderr).toContain("codex connector cannot honor effort 'none'");
    expect(stderr).toContain('supported efforts: low, medium, high, xhigh');
    expect(stderr).toContain('Remove the effort override');
    expect(relayCalls).toBe(0);
    expect(existsSync(runFolder)).toBe(false);
  });

  it('refuses before creating the run folder when codex state dir is unwritable', async () => {
    const { projectDir, homeDir } = tempProjectPinningCodex();
    const runFolder = join(projectDir, '.circuit', 'runs', 'refused-run');
    const args = parseExecutionArgs('run', [
      'review',
      '--goal',
      'sandbox preflight contract: refuse at intake, not mid-run',
      '--run-folder',
      runFolder,
    ]);

    const { result, stderr } = await captureStreams(() =>
      runExecutionCommand(args, {
        configCwd: projectDir,
        configHomeDir: homeDir,
        connectorPreflight: (input) =>
          preflightRunConnectors({
            ...input,
            env: { CODEX_HOME: '/sealed/.codex' },
            probes: {
              presence: () =>
                Promise.resolve({
                  kind: 'ran',
                  code: 0,
                  stdout: '1.0.0',
                  stderr: '',
                  timedOut: false,
                }),
              signIn: () => Promise.resolve(undefined),
              stateDir: (dir) => ({
                writable: false,
                dir,
                detail: 'EROFS: read-only file system',
              }),
            },
          }),
      }),
    );

    expect(result).toBe(2);
    expect(stderr).toContain(
      'error: The codex CLI could not write its state directory (/sealed/.codex).',
    );
    expect(stderr).toContain('setup problem, not a task failure');
    expect(stderr).toContain('Rerun Circuit outside the sandbox');
    expect(stderr).toContain('EROFS');
    // Refused at intake: the run folder was never created.
    expect(existsSync(runFolder)).toBe(false);
  });

  // A missing worker CLI must NOT refuse: a run can legitimately reach its
  // first checkpoint before any worker spawns (the Codex host plugin's doctor
  // smoke drives exactly that path in a repo with no CLIs on PATH), and the
  // spawn itself already fails with a legible missing-CLI sentence. The
  // contract here is warn-and-proceed: one TTY-gated note on stderr, then the
  // run continues normally.
  it('warns and proceeds when the chosen connector CLI is missing', async () => {
    const { projectDir, homeDir } = tempProjectPinningCodex();
    const runFolder = join(projectDir, '.circuit', 'runs', 'missing-cli-run');
    const args = parseExecutionArgs('run', [
      'review',
      '--goal',
      'Review this supplied text: a missing CLI should warn at intake while the run proceeds.',
      '--run-folder',
      runFolder,
    ]);

    // Warnings are TTY-gated (like the run-started notice) so `--progress
    // jsonl` stderr stays pure JSONL; fake a TTY to observe them.
    const stderrStream = process.stderr as { isTTY?: boolean | undefined };
    const originalIsTTY = stderrStream.isTTY;
    stderrStream.isTTY = true;
    try {
      const { result, stdout, stderr } = await captureStreams(() =>
        runExecutionCommand(args, {
          configCwd: projectDir,
          configHomeDir: homeDir,
          relayer: makeStubRelayer(() => VALID_REVIEW_BODY),
          connectorPreflight: (input) =>
            preflightRunConnectors({
              ...input,
              probes: {
                presence: () =>
                  Promise.resolve({ kind: 'spawn_error', message: 'spawn codex ENOENT' }),
                signIn: () => Promise.resolve(undefined),
                stateDir: (dir) => ({ writable: true, dir }),
              },
            }),
        }),
      );

      expect(stderr).toContain("note: this run's steps relay through the codex CLI");
      expect(stderr).toContain('spawn codex ENOENT');
      expect(stderr).toContain('the run will stop when it first needs it');
      // The run proceeded past intake and closed normally.
      const envelope = JSON.parse(stdout) as { outcome?: string };
      expect(envelope.outcome).toBe('complete');
      expect(result).toBe(0);
      expect(existsSync(runFolder)).toBe(true);
    } finally {
      stderrStream.isTTY = originalIsTTY;
    }
  });

  // Same warn-and-proceed contract for a CLI that is installed but signed out.
  // Intake asks now (`codex login status`) instead of leaving the operator to
  // discover it mid-flight, after the healthy branches have already spent. It
  // must not refuse: these CLIs sometimes report themselves signed out while
  // working fine, which is why connectorFailureSummary learned to doubt them.
  it('warns and proceeds when the chosen connector CLI reports it is signed out', async () => {
    const { projectDir, homeDir } = tempProjectPinningCodex();
    const runFolder = join(projectDir, '.circuit', 'runs', 'signed-out-cli-run');
    const args = parseExecutionArgs('run', [
      'review',
      '--goal',
      'Review this supplied text: a signed-out CLI should warn at intake while the run proceeds.',
      '--run-folder',
      runFolder,
    ]);

    const stderrStream = process.stderr as { isTTY?: boolean | undefined };
    const originalIsTTY = stderrStream.isTTY;
    stderrStream.isTTY = true;
    try {
      const { result, stdout, stderr } = await captureStreams(() =>
        runExecutionCommand(args, {
          configCwd: projectDir,
          configHomeDir: homeDir,
          relayer: makeStubRelayer(() => VALID_REVIEW_BODY),
          connectorPreflight: (input) =>
            preflightRunConnectors({
              ...input,
              probes: {
                presence: () =>
                  Promise.resolve({
                    kind: 'ran',
                    code: 0,
                    stdout: 'codex-cli 0.146.0',
                    stderr: '',
                    timedOut: false,
                  }),
                signIn: () =>
                  Promise.resolve({
                    kind: 'ran',
                    code: 1,
                    stdout: 'Not logged in',
                    stderr: '',
                    timedOut: false,
                  }),
                stateDir: (dir) => ({ writable: true, dir }),
              },
            }),
        }),
      );

      expect(stderr).toContain("note: this run's steps relay through the codex CLI");
      expect(stderr).toContain('reports that it is not signed in');
      expect(stderr).toContain('Not logged in');
      expect(stderr).toContain('codex login');
      const envelope = JSON.parse(stdout) as { outcome?: string };
      expect(envelope.outcome).toBe('complete');
      expect(result).toBe(0);
      expect(existsSync(runFolder)).toBe(true);
    } finally {
      stderrStream.isTTY = originalIsTTY;
    }
  });

  it('passes a healthy environment and treats an unanswerable probe as unknown, not broken', async () => {
    const { loadCompiledFlow, resolveCompiledFlowPath } = await import(
      '../../src/cli/compiled-flow-loading.js'
    );
    const { flow } = loadCompiledFlow(
      resolveCompiledFlowPath('review', undefined, undefined, undefined),
    );
    const healthy = await preflightRunConnectors({
      flow,
      configLayers: [],
      depth: 'medium',
      hostKind: 'codex',
      probes: {
        presence: () =>
          Promise.resolve({ kind: 'ran', code: 0, stdout: '1.0.0', stderr: '', timedOut: false }),
        signIn: () => Promise.resolve(undefined),
        stateDir: (dir) => ({ writable: true, dir }),
      },
    });
    expect(healthy).toEqual({ ok: true, warnings: [] });

    // A probe that timed out is "could not check", never a refusal: the run
    // itself will surface a genuinely wedged CLI legibly.
    const unknown = await preflightRunConnectors({
      flow,
      configLayers: [],
      depth: 'medium',
      hostKind: 'codex',
      probes: {
        presence: () =>
          Promise.resolve({ kind: 'ran', code: null, stdout: '', stderr: '', timedOut: true }),
        signIn: () => Promise.resolve(undefined),
        stateDir: (dir) => ({ writable: true, dir }),
      },
    });
    expect(unknown).toEqual({ ok: true, warnings: [] });
  });

  // A step retry bumps the power tier one notch, so the escalated tier's
  // selection is as reachable as the first attempt's. The corpus lost runs to
  // exactly this input-validation class reaching a subprocess mid-flight;
  // asserting only attempt 1 would leave the escalated selection to die there.
  it('refuses a power tier the connector cannot honor before a retry escalates into it', async () => {
    const { CompiledFlow } = await import('../../src/schemas/compiled-flow.js');
    const flow = CompiledFlow.parse(
      JSON.parse(readFileSync(resolve('generated/flows/runtime-proof/circuit.json'), 'utf8')),
    );
    // Attempt 1 resolves the low tier (effort 'low', honored). The one-notch
    // escalation lands on the medium tier, which this config poisons with an
    // effort codex rejects.
    const configLayer = LayeredConfig.parse({
      layer: 'project',
      config: {
        schema_version: 1,
        relay: { default: 'codex' },
        defaults: { power: 'low' },
        power_tiers: { codex: { medium: { effort: 'none' } } },
      },
    });

    const verdict = await preflightRunConnectors({
      flow,
      configLayers: [configLayer],
      depth: 'medium',
      probes: {
        presence: () =>
          Promise.resolve({ kind: 'ran', code: 0, stdout: '1.0.0', stderr: '', timedOut: false }),
        signIn: () => Promise.resolve(undefined),
        stateDir: (dir) => ({ writable: true, dir }),
      },
    });

    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('expected a refusal');
    expect(verdict.refusal).toContain("codex connector cannot honor effort 'none'");
    expect(verdict.refusal).toContain('retry escalates');
  });

  it('keeps effort none valid when policy selects cursor-agent', async () => {
    const { loadCompiledFlow, resolveCompiledFlowPath } = await import(
      '../../src/cli/compiled-flow-loading.js'
    );
    const { flow } = loadCompiledFlow(
      resolveCompiledFlowPath('review', undefined, undefined, undefined),
    );
    const configLayer = LayeredConfig.parse({
      layer: 'project',
      config: {
        schema_version: 1,
        relay: { default: 'codex' },
        defaults: { selection: { effort: 'none' } },
      },
    });
    const policyLayer = PolicyLayer.parse({
      source: 'project',
      envelope: {
        schema_version: 2,
        policy: {
          defaults: { connector: { kind: 'builtin', name: 'cursor-agent' } },
        },
      },
    });
    const probed: string[] = [];

    const verdict = await preflightRunConnectors({
      flow,
      configLayers: [configLayer],
      policyLayers: [policyLayer],
      depth: 'medium',
      probes: {
        presence: (connector) => {
          probed.push(connector);
          return Promise.resolve({
            kind: 'ran',
            code: 0,
            stdout: 'cursor-agent 1.0.0',
            stderr: '',
            timedOut: false,
          });
        },
        signIn: () => Promise.resolve(undefined),
        stateDir: () => {
          throw new Error('codex state should not be probed when policy selects cursor-agent');
        },
      },
    });

    expect(verdict).toEqual({ ok: true, warnings: [] });
    expect(probed).toEqual(['cursor-agent']);
  });

  // The first relay of a run used to have nothing vouching for the CLI, so a
  // sign-out arriving in a token-refresh window was BELIEVED: the operator was
  // told to sign in while signed in fine, and the engine spent the 400ms meant
  // for a real sign-out instead of the long wait that rides such a window out.
  // Intake had already watched `codex login status` answer happily.
  //
  // End to end through the real command path: real intake, real preflight, and
  // the real classifier deciding believed-vs-doubted. Only the two probes and
  // the subprocess itself are stood in for.
  it('lets a clean intake probe make the first relay sign-out a doubted one', async () => {
    forgetConnectorSuccesses();
    const realSchedule = connectorRetrySchedule.signedOutMs;
    connectorRetrySchedule.signedOutMs = [0, 0, 0, 0];

    const { projectDir, homeDir } = tempProjectPinningCodex();
    const runFolder = join(projectDir, '.circuit', 'runs', 'first-relay-vouch-run');
    const args = parseExecutionArgs('run', [
      'review',
      '--goal',
      "Review this supplied text: the first relay of a run should inherit intake's sign-in evidence.",
      '--run-folder',
      runFolder,
    ]);

    // Fails the first ask the way the real connector would, by composing the
    // sentence through the same classifier the subprocess uses. Whether that
    // sentence is the believed or the doubted one is precisely what intake's
    // vouch decides, so it must not be hard-coded here.
    const reasons: string[] = [];
    let asks = 0;
    const relayer = {
      connectorName: 'codex',
      relay: async (input: { readonly prompt: string }) => {
        asks += 1;
        if (asks === 1) {
          const summary =
            connectorFailureSummary({
              cli: 'codex',
              signInHint: 'Run `codex login` to sign in',
              stderr: '',
              stdout: '',
              streamError: 'Not logged in',
            }) ?? '';
          reasons.push(summary);
          throw new Error(summary);
        }
        return makeStubRelayer(() => VALID_REVIEW_BODY, { connectorName: 'codex' }).relay(
          input as never,
        );
      },
    };

    try {
      await captureStreams(() =>
        runExecutionCommand(args, {
          configCwd: projectDir,
          configHomeDir: homeDir,
          relayer: relayer as never,
          connectorPreflight: (input) =>
            preflightRunConnectors({
              ...input,
              probes: {
                presence: () =>
                  Promise.resolve({
                    kind: 'ran',
                    code: 0,
                    stdout: 'codex-cli 0.146.0',
                    stderr: '',
                    timedOut: false,
                  }),
                signIn: () =>
                  Promise.resolve({
                    kind: 'ran',
                    code: 0,
                    stdout: 'Logged in using ChatGPT',
                    stderr: '',
                    timedOut: false,
                  }),
                stateDir: (dir) => ({ writable: true, dir }),
              },
            }),
        }),
      );
    } finally {
      connectorRetrySchedule.signedOutMs = realSchedule;
      forgetConnectorSuccesses();
    }

    expect(reasons).toHaveLength(1);
    const reason = reasons[0] ?? '';
    // The payoff. Without intake's vouch this reads "The codex CLI is not
    // logged in", which is both wrong and a wrong instruction.
    expect(isTransientSignOutFailure(reason)).toBe(true);
    expect(reason).toContain('answered normally minutes ago');
    // The sign-in hint survives, demoted: still the fix if the doubt is wrong.
    expect(reason).toContain('codex login');
  });

  it('believes a first-relay sign-out when intake could not vouch', async () => {
    // The control. Same run, same failure, but the intake probe timed out, so
    // nothing vouches and the sign-out is taken at its word.
    forgetConnectorSuccesses();
    const { projectDir, homeDir } = tempProjectPinningCodex();
    const runFolder = join(projectDir, '.circuit', 'runs', 'first-relay-no-vouch-run');
    const args = parseExecutionArgs('run', [
      'review',
      '--goal',
      'Review this supplied text: an unvouched first relay sign-out is believed.',
      '--run-folder',
      runFolder,
    ]);

    const reasons: string[] = [];
    let asks = 0;
    const relayer = {
      connectorName: 'codex',
      relay: async (input: { readonly prompt: string }) => {
        asks += 1;
        if (asks === 1) {
          const summary =
            connectorFailureSummary({
              cli: 'codex',
              signInHint: 'Run `codex login` to sign in',
              stderr: '',
              stdout: '',
              streamError: 'Not logged in',
            }) ?? '';
          reasons.push(summary);
          throw new Error(summary);
        }
        return makeStubRelayer(() => VALID_REVIEW_BODY, { connectorName: 'codex' }).relay(
          input as never,
        );
      },
    };

    try {
      await captureStreams(() =>
        runExecutionCommand(args, {
          configCwd: projectDir,
          configHomeDir: homeDir,
          relayer: relayer as never,
          connectorPreflight: (input) =>
            preflightRunConnectors({
              ...input,
              probes: {
                presence: () =>
                  Promise.resolve({
                    kind: 'ran',
                    code: 0,
                    stdout: 'codex-cli 0.146.0',
                    stderr: '',
                    timedOut: false,
                  }),
                signIn: () =>
                  Promise.resolve({
                    kind: 'ran',
                    code: null,
                    stdout: '',
                    stderr: '',
                    timedOut: true,
                  }),
                stateDir: (dir) => ({ writable: true, dir }),
              },
            }),
        }),
      );
    } finally {
      forgetConnectorSuccesses();
    }

    expect(reasons).toHaveLength(1);
    const reason = reasons[0] ?? '';
    expect(isTransientSignOutFailure(reason)).toBe(false);
    expect(reason).toContain('The codex CLI is not logged in');
  });
});
