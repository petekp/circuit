import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { discoverRunsList } from '../../src/app/runs-list/list.js';
import { renderRunsList } from '../../src/app/runs-list/list.js';
import { main } from '../../src/cli/circuit.js';
import { CompiledFlowId, RunId } from '../../src/schemas/ids.js';
import { sha256Hex } from '../../src/shared/connector-relay.js';
import { writeManifestSnapshot } from '../../src/shared/manifest-snapshot.js';
import { captureStreams } from '../helpers/runtime-fixtures.js';

// Bare `circuit runs` is the recent-runs listing: one line per saved run
// folder, newest first, in plain English. It must show every class honestly:
// closed runs by their terminal outcome, runs waiting on a decision (including
// ones parked by an older engine whose trace no longer parses), open runs
// whose fate is unknowable from the folder alone, and folders this engine
// cannot read at all. Before this listing existed, bare `circuit runs` was an
// error and stalled runs had no aggregate surface anywhere.

const tempRoots: string[] = [];
const FIX_FLOW_BYTES = readFileSync(resolve('generated/flows/fix/circuit.json'));
const FIX_CHECKPOINT_STEP = 'fix-no-repro-decision';
const FIX_CHECKPOINT_REQUEST_PATH = `reports/checkpoints/${FIX_CHECKPOINT_STEP}-request.json`;
const BOUNDARY_REF_PATH = `reports/checkpoints/${FIX_CHECKPOINT_STEP}-contract.json`;

const change_kind = {
  change_kind: 'discovery' as const,
  failure_mode: 'runs listing test fixture',
  acceptance_evidence: 'runs listing shows every folder class honestly',
  alternate_framing: 'hand-authored run folder fixtures',
};

function newRunsRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'circuit-runs-list-'));
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
    captured_at: '2026-04-30T12:00:00.000Z',
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
  readonly at: string;
}): unknown {
  return {
    schema_version: 1,
    sequence: 0,
    recorded_at: input.at,
    run_id: input.runId,
    kind: 'run.bootstrapped',
    flow_id: 'fix',
    depth: 'medium',
    goal: input.goal,
    change_kind,
    manifest_hash: input.manifestHash,
  };
}

function stepEntered(runId: string, sequence: number, stepId: string, at: string): unknown {
  return {
    schema_version: 1,
    sequence,
    recorded_at: at,
    run_id: runId,
    kind: 'step.entered',
    step_id: stepId,
    attempt: 1,
  };
}

function runClosed(runId: string, sequence: number, outcome: string, at: string): unknown {
  return {
    schema_version: 1,
    sequence,
    recorded_at: at,
    run_id: runId,
    kind: 'run.closed',
    outcome,
  };
}

function makeClosedFolder(input: {
  readonly runsRoot: string;
  readonly name: string;
  readonly runId: string;
  readonly goal: string;
  readonly outcome: string;
  readonly at: string;
}): string {
  const runFolder = makeRunFolder(input.runsRoot, input.name);
  const manifestHash = writeManifest(runFolder, input.runId);
  writeTrace(runFolder, [
    bootstrap({ runId: input.runId, manifestHash, goal: input.goal, at: input.at }),
    stepEntered(input.runId, 1, 'fix-close', input.at),
    runClosed(input.runId, 2, input.outcome, input.at),
  ]);
  return runFolder;
}

function makeOpenFolder(input: {
  readonly runsRoot: string;
  readonly name: string;
  readonly runId: string;
  readonly goal: string;
  readonly at: string;
}): string {
  const runFolder = makeRunFolder(input.runsRoot, input.name);
  const manifestHash = writeManifest(runFolder, input.runId);
  writeTrace(runFolder, [
    bootstrap({ runId: input.runId, manifestHash, goal: input.goal, at: input.at }),
    stepEntered(input.runId, 1, 'fix-gather-context', input.at),
  ]);
  return runFolder;
}

function makeParkedFolder(input: {
  readonly runsRoot: string;
  readonly name: string;
  readonly runId: string;
  readonly goal: string;
  readonly at: string;
  /** When true, the checkpoint entry predates the boundary fields. */
  readonly oldShape: boolean;
}): string {
  const runFolder = makeRunFolder(input.runsRoot, input.name);
  const manifestHash = writeManifest(runFolder, input.runId);

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
  const boundaryText = `${JSON.stringify(
    { schema_version: 1, step_id: FIX_CHECKPOINT_STEP },
    null,
    2,
  )}\n`;
  writeFileSync(boundaryPath, boundaryText);
  const boundaryHash = sha256Hex(boundaryText);

  writeTrace(runFolder, [
    bootstrap({ runId: input.runId, manifestHash, goal: input.goal, at: input.at }),
    stepEntered(input.runId, 1, FIX_CHECKPOINT_STEP, input.at),
    {
      schema_version: 1,
      sequence: 2,
      recorded_at: input.at,
      run_id: input.runId,
      kind: 'checkpoint.requested',
      step_id: FIX_CHECKPOINT_STEP,
      attempt: 1,
      options: ['continue'],
      request_path: FIX_CHECKPOINT_REQUEST_PATH,
      request_report_hash: requestHash,
      ...(input.oldShape
        ? { auto_resolved: false }
        : {
            boundary_ref: {
              kind: 'work_contract',
              ref: BOUNDARY_REF_PATH,
              sha256: boundaryHash,
              step_id: FIX_CHECKPOINT_STEP,
              flow_id: 'fix',
            },
            boundary_hash: boundaryHash,
          }),
    },
  ]);
  return runFolder;
}

const COMPLETE_RUN_ID = '11111111-1111-4111-8111-111111111111';
const STOPPED_RUN_ID = '22222222-2222-4222-8222-222222222222';
const PARKED_RUN_ID = '33333333-3333-4333-8333-333333333333';
const OLD_SHAPE_RUN_ID = '44444444-4444-4444-8444-444444444444';
const OPEN_RUN_ID = '55555555-5555-4555-8555-555555555555';

function makeAllClasses(runsRoot: string): {
  readonly completeFolder: string;
  readonly stoppedFolder: string;
  readonly parkedFolder: string;
  readonly oldShapeFolder: string;
  readonly openFolder: string;
  readonly garbageFolder: string;
} {
  const completeFolder = makeClosedFolder({
    runsRoot,
    name: 'closed-complete',
    runId: COMPLETE_RUN_ID,
    goal: 'Fix the checkout bug',
    outcome: 'complete',
    at: '2026-04-25T10:00:00.000Z',
  });
  const stoppedFolder = makeClosedFolder({
    runsRoot,
    name: 'closed-stopped',
    runId: STOPPED_RUN_ID,
    goal: 'Fix the login regression',
    outcome: 'stopped',
    at: '2026-04-26T10:00:00.000Z',
  });
  const parkedFolder = makeParkedFolder({
    runsRoot,
    name: 'parked',
    runId: PARKED_RUN_ID,
    goal: 'Fix the flaky signup test',
    at: '2026-04-27T10:00:00.000Z',
    oldShape: false,
  });
  const oldShapeFolder = makeParkedFolder({
    runsRoot,
    name: 'parked-old-shape',
    runId: OLD_SHAPE_RUN_ID,
    goal: 'Prototype three variants of the settings page',
    at: '2026-04-24T10:00:00.000Z',
    oldShape: true,
  });
  const openFolder = makeOpenFolder({
    runsRoot,
    name: 'open-run',
    runId: OPEN_RUN_ID,
    goal: 'Fix the slow dashboard query',
    at: '2026-04-28T10:00:00.000Z',
  });
  const garbageFolder = makeRunFolder(runsRoot, 'unreadable-garbage');
  writeFileSync(join(garbageFolder, 'trace.ndjson'), 'not json at all\n');
  return { completeFolder, stoppedFolder, parkedFolder, oldShapeFolder, openFolder, garbageFolder };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('runs list discovery', () => {
  it('lists every folder class with an honest state, newest first', () => {
    const runsRoot = newRunsRoot();
    const folders = makeAllClasses(runsRoot);

    const list = discoverRunsList({ runsRoot });
    expect(list.rows).toHaveLength(6);

    const byFolder = new Map(list.rows.map((row) => [row.run_folder, row]));

    const complete = byFolder.get(resolve(folders.completeFolder));
    expect(complete?.state).toBe('complete');
    expect(complete?.goal).toBe('Fix the checkout bug');
    expect(complete?.flow_id).toBe('fix');

    const stopped = byFolder.get(resolve(folders.stoppedFolder));
    expect(stopped?.state).toBe('stopped');

    const parked = byFolder.get(resolve(folders.parkedFolder));
    expect(parked?.state).toBe('waiting_on_decision');
    expect(parked?.goal).toBe('Fix the flaky signup test');

    const oldShape = byFolder.get(resolve(folders.oldShapeFolder));
    expect(oldShape?.state).toBe('waiting_on_decision_older_engine');
    expect(oldShape?.goal).toBe('Prototype three variants of the settings page');

    const open = byFolder.get(resolve(folders.openFolder));
    expect(open?.state).toBe('open_unconfirmed');

    const garbage = byFolder.get(resolve(folders.garbageFolder));
    expect(garbage?.state).toBe('unreadable');

    // Newest first among rows with a known time; rows with no readable time
    // sort last. The open run (04-28) leads, then parked (04-27), stopped
    // (04-26), complete (04-25), old-shape (04-24), then the unreadable one.
    expect(list.rows.map((row) => row.run_folder)).toEqual(
      [
        folders.openFolder,
        folders.parkedFolder,
        folders.stoppedFolder,
        folders.completeFolder,
        folders.oldShapeFolder,
        folders.garbageFolder,
      ].map((folder) => resolve(folder)),
    );
  });

  it('renders a plain-English listing with waiting and detail pointers', () => {
    const runsRoot = newRunsRoot();
    makeAllClasses(runsRoot);

    const text = renderRunsList(discoverRunsList({ runsRoot }));

    expect(text).toContain('Fix the checkout bug');
    expect(text).toContain('complete');
    expect(text).toContain('stopped');
    expect(text).toContain('waiting on a decision');
    expect(text).toContain('older engine');
    // The open state never reads as "definitely still running".
    expect(text).toMatch(/open \(running or crashed\)/);
    expect(text).toContain('unreadable');
    // Endings point forward: waiting runs go to the checkpoints list, and any
    // single run can be inspected in detail.
    expect(text).toContain('circuit checkpoints');
    expect(text).toContain('circuit runs show --run-folder');
  });

  it('renders an empty state when there are no saved runs', () => {
    const runsRoot = newRunsRoot();
    const text = renderRunsList(discoverRunsList({ runsRoot }));
    expect(text).toMatch(/no saved runs/i);
  });
});

describe('circuit runs CLI', () => {
  it('bare circuit runs prints the listing instead of demanding a subcommand', async () => {
    const runsRoot = newRunsRoot();
    makeAllClasses(runsRoot);

    const { result: exit, stdout } = await captureStreams(() =>
      main(['runs', '--runs-base', runsRoot]),
    );

    expect(exit).toBe(0);
    expect(stdout).toContain('waiting on a decision');
    expect(stdout).toContain('Fix the checkout bug');
  });

  it('bare circuit runs --json prints a versioned machine listing', async () => {
    const runsRoot = newRunsRoot();
    makeAllClasses(runsRoot);

    const { result: exit, stdout } = await captureStreams(() =>
      main(['runs', '--runs-base', runsRoot, '--json']),
    );

    expect(exit).toBe(0);
    const parsed = JSON.parse(stdout) as {
      api_version: string;
      schema_version: number;
      rows: Array<{ run_folder: string; state: string }>;
    };
    expect(parsed.api_version).toBe('runs-list-v1');
    expect(parsed.schema_version).toBe(1);
    expect(parsed.rows).toHaveLength(6);
    expect(parsed.rows.some((row) => row.state === 'waiting_on_decision_older_engine')).toBe(true);
  });

  it('circuit runs show still projects a single run folder', async () => {
    const runsRoot = newRunsRoot();
    const folders = makeAllClasses(runsRoot);

    const { result: exit, stdout } = await captureStreams(() =>
      main(['runs', 'show', '--json', '--run-folder', folders.completeFolder]),
    );

    expect(exit).toBe(0);
    const parsed = JSON.parse(stdout) as { engine_state: string };
    expect(parsed.engine_state).toBe('completed');
  });
});
