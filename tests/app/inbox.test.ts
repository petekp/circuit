import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { BriefGitProbe, StalenessFacts } from '../../src/app/continuity/brief.js';
import { discoverDecisionInbox } from '../../src/app/inbox/discover.js';
import { renderDecisionInbox } from '../../src/app/inbox/render.js';
import { main } from '../../src/cli/circuit.js';
import { CompiledFlowId, RunId } from '../../src/schemas/ids.js';
import { sha256Hex } from '../../src/shared/connector-relay.js';
import { writeManifestSnapshot } from '../../src/shared/manifest-snapshot.js';
import { captureStreams } from '../helpers/runtime-fixtures.js';

// Three run folders share one runs root: one parked at a checkpoint
// (checkpoint_waiting), one dead crashed folder (trace ends mid-step, no
// checkpoint, no close), one cleanly closed folder. The inbox must list ONLY
// the parked one, render its fork (prompt + choices), attach staleness from an
// injected stub probe, and EXCLUDE the dead and closed folders.

const tempRoots: string[] = [];
const RECORDED_AT = '2026-04-30T12:00:00.000Z';
// The parked fixture is validated against the real fix flow's checkpoint
// step, so the projection accepts it as a genuine checkpoint_waiting run.
const FIX_FLOW_BYTES = readFileSync(resolve('generated/flows/fix/circuit.json'));
const FIX_CHECKPOINT_STEP = 'fix-no-repro-decision';
const FIX_CHECKPOINT_REQUEST_PATH = `reports/checkpoints/${FIX_CHECKPOINT_STEP}-request.json`;
const BOUNDARY_REF_PATH = `reports/checkpoints/${FIX_CHECKPOINT_STEP}-contract.json`;

const change_kind = {
  change_kind: 'discovery' as const,
  failure_mode: 'inbox discovery test fixture',
  acceptance_evidence: 'inbox lists only the parked run',
  alternate_framing: 'hand-authored run folder fixtures',
};

function newRunsRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'circuit-inbox-'));
  tempRoots.push(root);
  const runsRoot = join(root, 'runs');
  mkdirSync(runsRoot, { recursive: true });
  return runsRoot;
}

function makeRunFolder(runsRoot: string, name: string): string {
  const runFolder = join(runsRoot, name);
  mkdirSync(runFolder, { recursive: true });
  return runFolder;
}

function writeManifest(runFolder: string, runId: string): string {
  const manifest = writeManifestSnapshot(runFolder, {
    run_id: RunId.parse(runId),
    flow_id: CompiledFlowId.parse('fix'),
    captured_at: RECORDED_AT,
    bytes: FIX_FLOW_BYTES,
  });
  return manifest.hash;
}

function writeTrace(runFolder: string, entries: readonly unknown[]): void {
  writeFileSync(
    join(runFolder, 'trace.ndjson'),
    `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
  );
}

function bootstrap(input: {
  readonly runId: string;
  readonly manifestHash: string;
  readonly goal: string;
}): unknown {
  return {
    schema_version: 1,
    sequence: 0,
    recorded_at: RECORDED_AT,
    run_id: input.runId,
    kind: 'run.bootstrapped',
    flow_id: 'fix',
    depth: 'medium',
    goal: input.goal,
    change_kind,
    manifest_hash: input.manifestHash,
  };
}

function stepEntered(runId: string, sequence: number, stepId: string): unknown {
  return {
    schema_version: 1,
    sequence,
    recorded_at: RECORDED_AT,
    run_id: runId,
    kind: 'step.entered',
    step_id: stepId,
    attempt: 1,
  };
}

function runClosed(runId: string, sequence: number, outcome: string): unknown {
  return {
    schema_version: 1,
    sequence,
    recorded_at: RECORDED_AT,
    run_id: runId,
    kind: 'run.closed',
    outcome,
  };
}

// A run parked at a clean checkpoint: bootstrap, step.entered, then a valid
// checkpoint.requested whose request file hashes match the trace. This is the
// genuine checkpoint_waiting shape the inbox is allowed to list.
function makeParkedFolder(runsRoot: string, runId: string, goal: string): string {
  const runFolder = makeRunFolder(runsRoot, 'parked');
  const manifestHash = writeManifest(runFolder, runId);

  const requestPath = join(runFolder, FIX_CHECKPOINT_REQUEST_PATH);
  mkdirSync(dirname(requestPath), { recursive: true });
  const requestText = `${JSON.stringify(
    {
      schema_version: 1,
      step_id: FIX_CHECKPOINT_STEP,
      prompt: 'Diagnosis did not cleanly reproduce the bug. Choose how to proceed.',
      allowed_choices: ['continue'],
      execution_context: { selection_config_layers: [] },
    },
    null,
    2,
  )}\n`;
  writeFileSync(requestPath, requestText);
  const requestHash = sha256Hex(requestText);

  const boundaryPath = join(runFolder, BOUNDARY_REF_PATH);
  const boundaryText = `${JSON.stringify({ schema_version: 1, step_id: FIX_CHECKPOINT_STEP }, null, 2)}\n`;
  writeFileSync(boundaryPath, boundaryText);
  const boundaryHash = sha256Hex(boundaryText);

  writeTrace(runFolder, [
    bootstrap({ runId, manifestHash, goal }),
    stepEntered(runId, 1, FIX_CHECKPOINT_STEP),
    {
      schema_version: 1,
      sequence: 2,
      recorded_at: RECORDED_AT,
      run_id: runId,
      kind: 'checkpoint.requested',
      step_id: FIX_CHECKPOINT_STEP,
      attempt: 1,
      options: ['continue'],
      request_path: FIX_CHECKPOINT_REQUEST_PATH,
      request_report_hash: requestHash,
      boundary_ref: {
        kind: 'work_contract',
        ref: BOUNDARY_REF_PATH,
        sha256: boundaryHash,
        step_id: FIX_CHECKPOINT_STEP,
        flow_id: 'fix',
      },
      boundary_hash: boundaryHash,
    },
  ]);
  return runFolder;
}

// A dead crashed folder: bootstrap then a step.entered that never completes,
// no checkpoint, no run.closed. needs_attention but NOT resumable.
function makeDeadFolder(runsRoot: string, runId: string): string {
  const runFolder = makeRunFolder(runsRoot, 'dead');
  const manifestHash = writeManifest(runFolder, runId);
  writeTrace(runFolder, [
    bootstrap({ runId, manifestHash, goal: 'Crashed mid-step run' }),
    stepEntered(runId, 1, 'fix-gather-context'),
  ]);
  return runFolder;
}

// A cleanly closed folder: bootstrap, step, run.closed complete.
function makeClosedFolder(runsRoot: string, runId: string): string {
  const runFolder = makeRunFolder(runsRoot, 'closed');
  const manifestHash = writeManifest(runFolder, runId);
  writeTrace(runFolder, [
    bootstrap({ runId, manifestHash, goal: 'Finished run' }),
    stepEntered(runId, 1, 'fix-close'),
    runClosed(runId, 2, 'complete'),
  ]);
  return runFolder;
}

const PARKED_RUN_ID = '11111111-1111-4111-8111-111111111111';
const DEAD_RUN_ID = '22222222-2222-4222-8222-222222222222';
const CLOSED_RUN_ID = '33333333-3333-4333-8333-333333333333';

const STALENESS: StalenessFacts = {
  head_advanced: true,
  tree_clean: true,
  commits_since: 3,
};

// Stub probe: any captured baseline yields the same divergence facts. The
// inbox only probes folders for which a captured baseline was resolved.
const stubProbe: BriefGitProbe = () => STALENESS;

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('decision inbox discovery', () => {
  it('lists only the parked run, renders its fork, and excludes dead and closed folders', () => {
    const runsRoot = newRunsRoot();
    const parkedFolder = makeParkedFolder(runsRoot, PARKED_RUN_ID, 'Fix the checkout bug');
    makeDeadFolder(runsRoot, DEAD_RUN_ID);
    makeClosedFolder(runsRoot, CLOSED_RUN_ID);

    const inbox = discoverDecisionInbox({
      runsRoot,
      gitProbe: stubProbe,
      // A captured baseline is available for the parked run, so staleness is
      // probed for it. Real run folders carry no baseline today, so this is
      // the injection seam that exercises the triage column.
      capturedBaselineFor: () => ({ head: 'abc1234', branch: 'feat/x' }),
    });

    expect(inbox.rows).toHaveLength(1);
    const row = inbox.rows[0];
    if (row === undefined) throw new Error('expected one inbox row');

    expect(row.run_folder).toBe(resolve(parkedFolder));
    expect(row.run_id).toBe(PARKED_RUN_ID);
    expect(row.flow_id).toBe('fix');
    expect(row.goal).toBe('Fix the checkout bug');

    // The fork: prompt + choices come straight from the projection.
    expect(row.checkpoint.prompt).toContain('Choose how to proceed');
    expect(row.checkpoint.choices.map((choice) => choice.id)).toEqual(['continue']);

    // The row links to the existing per-run resume; the inbox never actuates.
    expect(row.resume_command).toBe(
      `circuit resume --run-folder ${resolve(parkedFolder)} --checkpoint-choice <choice>`,
    );

    // Staleness attached from the injected probe.
    expect(row.staleness).toEqual(STALENESS);

    // Dead and closed folders are excluded.
    const folders = inbox.rows.map((listed) => listed.run_folder);
    expect(folders).not.toContain(resolve(join(runsRoot, 'dead')));
    expect(folders).not.toContain(resolve(join(runsRoot, 'closed')));
  });

  it('survives a throwing git probe: omits staleness and still lists the parked run', () => {
    const runsRoot = newRunsRoot();
    const parkedFolder = makeParkedFolder(runsRoot, PARKED_RUN_ID, 'Fix the checkout bug');

    const throwingProbe: BriefGitProbe = () => {
      throw new Error('git probe blew up');
    };

    const inbox = discoverDecisionInbox({
      runsRoot,
      gitProbe: throwingProbe,
      // A baseline resolves, so the probe is reached — and it throws. Best-effort
      // staleness must swallow that and keep listing rather than abort the walk.
      capturedBaselineFor: () => ({ head: 'abc1234', branch: 'feat/x' }),
    });

    expect(inbox.rows).toHaveLength(1);
    expect(inbox.rows[0]?.run_folder).toBe(resolve(parkedFolder));
    expect(inbox.rows[0]?.staleness).toBeUndefined();
  });

  it('omits the staleness column when no captured baseline is available', () => {
    const runsRoot = newRunsRoot();
    makeParkedFolder(runsRoot, PARKED_RUN_ID, 'Fix the checkout bug');

    const inbox = discoverDecisionInbox({
      runsRoot,
      gitProbe: stubProbe,
      // No baseline resolves: best-effort staleness omits the row's column
      // rather than probe against nothing and render a wrong claim.
      capturedBaselineFor: () => undefined,
    });

    expect(inbox.rows).toHaveLength(1);
    expect(inbox.rows[0]?.staleness).toBeUndefined();
  });

  it('returns an empty inbox when the runs root does not exist', () => {
    const inbox = discoverDecisionInbox({
      runsRoot: join(tmpdir(), 'circuit-inbox-missing-root-does-not-exist'),
      gitProbe: stubProbe,
    });
    expect(inbox.rows).toEqual([]);
  });

  it('renders a plain-English list with the fork and the resume link', () => {
    const runsRoot = newRunsRoot();
    const parkedFolder = makeParkedFolder(runsRoot, PARKED_RUN_ID, 'Fix the checkout bug');

    const inbox = discoverDecisionInbox({
      runsRoot,
      gitProbe: stubProbe,
      capturedBaselineFor: () => ({ head: 'abc1234', branch: 'feat/x' }),
    });
    const text = renderDecisionInbox(inbox);

    expect(text).toContain('Fix the checkout bug');
    expect(text).toContain('Choose how to proceed');
    expect(text).toContain('continue');
    expect(text).toContain(
      `circuit resume --run-folder ${resolve(parkedFolder)} --checkpoint-choice <choice>`,
    );
  });

  it('renders an empty-state line when no run is waiting', () => {
    const runsRoot = newRunsRoot();
    makeClosedFolder(runsRoot, CLOSED_RUN_ID);
    const inbox = discoverDecisionInbox({ runsRoot, gitProbe: stubProbe });
    const text = renderDecisionInbox(inbox);
    expect(text).toMatch(/no runs are waiting/i);
  });
});

describe('circuit inbox CLI', () => {
  it('routes the inbox subcommand and prints the parked run as JSON', async () => {
    const runsRoot = newRunsRoot();
    const parkedFolder = makeParkedFolder(runsRoot, PARKED_RUN_ID, 'Fix the checkout bug');
    makeDeadFolder(runsRoot, DEAD_RUN_ID);
    makeClosedFolder(runsRoot, CLOSED_RUN_ID);

    const { result: exit, stdout } = await captureStreams(() =>
      main(['inbox', '--runs-base', runsRoot, '--json'], { briefGitProbe: stubProbe }),
    );

    expect(exit).toBe(0);
    const parsed = JSON.parse(stdout) as {
      rows: Array<{ run_folder: string; goal: string; resume_command: string }>;
    };
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]?.run_folder).toBe(resolve(parkedFolder));
    expect(parsed.rows[0]?.goal).toBe('Fix the checkout bug');
    expect(parsed.rows[0]?.resume_command).toBe(
      `circuit resume --run-folder ${resolve(parkedFolder)} --checkpoint-choice <choice>`,
    );
  });

  it('routes the inbox subcommand and prints a plain-English list by default', async () => {
    const runsRoot = newRunsRoot();
    makeParkedFolder(runsRoot, PARKED_RUN_ID, 'Fix the checkout bug');

    const { result: exit, stdout } = await captureStreams(() =>
      main(['inbox', '--runs-base', runsRoot], { briefGitProbe: stubProbe }),
    );

    expect(exit).toBe(0);
    expect(stdout).toContain('1 run waiting on a decision');
    expect(stdout).toContain('Fix the checkout bug');
    expect(stdout).toContain('--checkpoint-choice <choice>');
  });
});
