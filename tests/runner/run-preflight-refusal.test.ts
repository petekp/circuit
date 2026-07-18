import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { preflightRunConnectors } from '../../src/cli/run-preflight.js';
import { parseExecutionArgs, runExecutionCommand } from '../../src/cli/run.js';
import { captureStreams, makeStubRelayer } from '../helpers/runtime-fixtures.js';

const VALID_REVIEW_BODY = JSON.stringify({
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

describe('run intake preflight: refuse the sandbox class, warn on missing CLIs', () => {
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
      'sandbox preflight contract: missing CLI warns at intake, run proceeds',
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
      hostKind: 'codex',
      probes: {
        presence: () =>
          Promise.resolve({ kind: 'ran', code: 0, stdout: '1.0.0', stderr: '', timedOut: false }),
        stateDir: (dir) => ({ writable: true, dir }),
      },
    });
    expect(healthy).toEqual({ ok: true, warnings: [] });

    // A probe that timed out is "could not check", never a refusal: the run
    // itself will surface a genuinely wedged CLI legibly.
    const unknown = await preflightRunConnectors({
      flow,
      configLayers: [],
      hostKind: 'codex',
      probes: {
        presence: () =>
          Promise.resolve({ kind: 'ran', code: null, stdout: '', stderr: '', timedOut: true }),
        stateDir: (dir) => ({ writable: true, dir }),
      },
    });
    expect(unknown).toEqual({ ok: true, warnings: [] });
  });
});
