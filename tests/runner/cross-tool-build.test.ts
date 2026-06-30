import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import type { RelayFn, RelayInput } from '../../src/shared/relay-runtime-types.js';
import { deterministicNow, stubRelayResult } from '../helpers/runtime-fixtures.js';

// cross-tool-build's end-to-end test. cross-tool-build codifies a recurring
// two-tool process: one connector (the "doer") proposes a feature, revises it
// into a spec, and implements it; a second connector (the adversarial
// "reviewer") reviews the proposal and the spec. The split is intrinsic to the
// flow via the per-step worker pin (each relay step carries a `connector`):
// propose/spec/implement pin to 'codex', the two reviews pin to 'claude-code'.
//
// This file proves three things, in increasing depth:
//
//   1. COMPILED ROUTING (static). The emitted circuit.json carries the pin on
//      each relay step. This is the cross-tool guarantee as a property of the
//      compiled flow, independent of any runtime.
//
//   2. RUNTIME ROUTING + FULL PIPELINE (green path). Driven through
//      runCompiledFlow with a real run-verification body and the real close
//      gate, the flow runs propose -> review -> spec -> review -> implement ->
//      verify -> close to @complete, and every relay step's relay.started trace
//      records the connector its pin requested. This is the same cross-tool
//      guarantee proven at runtime, on the real relay path. It also proves the
//      forward-carry design: the proposal review returns verdict 'revise' and
//      the run still continues (the review is a typed input the doer revises
//      against, not a blocking gate).
//
//   3. THE VERIFY GATE HAS TEETH (red-then-green). When the first verify is red,
//      the run does NOT close 'complete'. It routes back to implement (the
//      bounded retry), the doer fixes it, the second verify is green, and only
//      then does the run close. A failing verification can never be laundered
//      as done.
//
// The fake connector. cross-tool-build pins different connectors per step, so a
// single fixed-identity relayer cannot drive it — the runtime's connector
// identity guard would reject the first step whose pin differs from the
// relayer's name. Instead the relayer is connector-AGNOSTIC (no connectorName):
// the guard then stays silent and each step resolves its OWN pinned connector,
// exactly as production does (production injects no relayer at all and each step
// spawns its pinned connector subprocess). Only the model call is faked; the
// relay executor, the verdict checks, the run-verification command, and the
// close gate are all live.

const FIXTURE_PATH = join('generated', 'flows', 'cross-tool-build', 'circuit.json');

function crossToolBuildBytes(): Buffer {
  return readFileSync(FIXTURE_PATH);
}

// Expected per-step connector pin: the doer steps run on 'codex', the two
// adversarial reviews run on 'claude-code'. The non-relay steps (plan compose,
// run-verification, close compose) carry no connector.
const EXPECTED_PINS: Record<string, string> = {
  'propose-step': 'codex',
  'review-proposal-step': 'claude-code',
  'spec-step': 'codex',
  'review-spec-step': 'claude-code',
  'implement-step': 'codex',
};

interface TraceRow {
  readonly kind: string;
  readonly step_id?: string | undefined;
  readonly connector?: { readonly kind?: string; readonly name?: string } | undefined;
}

function enteredCount(trace: readonly TraceRow[], stepId: string): number {
  return trace.filter((e) => e.kind === 'step.entered' && e.step_id === stepId).length;
}

// Every relay.started entry's connector name, keyed by step id. When a step ran
// more than once (a retry), the LAST connector wins — for the cross-tool
// assertions every attempt of a given step uses the same pin, so last == every.
function startedConnectorsByStep(trace: readonly TraceRow[]): Record<string, string | undefined> {
  const byStep: Record<string, string | undefined> = {};
  for (const e of trace) {
    if (e.kind === 'relay.started' && e.step_id !== undefined) {
      byStep[e.step_id] = e.connector?.name;
    }
  }
  return byStep;
}

// Every relay.started entry's connector name for one step, in order — so a
// retried step can assert that EVERY attempt used the same pin.
function startedConnectorsForStep(
  trace: readonly TraceRow[],
  stepId: string,
): (string | undefined)[] {
  return trace
    .filter((e) => e.kind === 'relay.started' && e.step_id === stepId)
    .map((e) => e.connector?.name);
}

// The canned doer/reviewer report bodies. Each satisfies its step's report
// schema (see src/flows/cross-tool-build/reports.ts) so the relay verdict check
// and the schema parse both pass and the typed report rides forward.
const PROPOSAL_BODY = JSON.stringify({
  verdict: 'accept',
  summary: 'Add a bounded retry budget to relay steps.',
  problem: 'Relay steps retry on failure without a per-step upper bound.',
  approach: 'Thread a max_attempts field from the schematic into the runtime retry loop.',
  key_decisions: ['Bound retries at the step, not the whole run'],
});

// The proposal review returns 'revise' (with a finding) ON PURPOSE: it proves
// forward-carry. A 'revise' passes the relay check and the run continues; the
// doer revises against the finding in the next step. An empty 'revise' would be
// rejected by the schema, so the finding is required.
const PROPOSAL_REVIEW_BODY = JSON.stringify({
  verdict: 'revise',
  assessment: 'Directionally right, but the proposal understates the resume interaction.',
  findings: [
    {
      severity: 'high',
      text: 'No account of how the bound interacts with a resumed run mid-retry.',
      refs: [],
    },
  ],
});

const SPEC_BODY = JSON.stringify({
  verdict: 'accept',
  summary: 'Implementation spec for the bounded relay retry.',
  revisions_from_review: ['Added a resume section addressing the proposal review finding.'],
  implementation_steps: [
    'Add max_attempts to the relay step schema',
    'Enforce the bound in the runtime retry loop',
  ],
  test_plan: ['Unit-test the bound', 'Run a flow that exhausts the bound and confirm it stops'],
});

// The spec review returns 'accept': the other verdict, so one run exercises
// both review outcomes.
const SPEC_REVIEW_BODY = JSON.stringify({
  verdict: 'accept',
  assessment: 'The spec folds in the proposal review and is implementable as written.',
});

const IMPLEMENTATION_BODY = JSON.stringify({
  verdict: 'accept',
  summary: 'Implemented the bounded relay retry and manually tested the exhaustion path.',
  changed_files: ['src/runtime/executors/relay.ts'],
  manual_tests: ['Ran a flow that exhausts the bound; it stopped without claiming complete'],
  evidence: ['the project verify script passed after the change'],
});

// A project root whose `verify` script exits 0 iff the marker file exists. The
// cross-tool-build plan compose writer resolves this script into the run's
// verification command via the shared resolver (npm run verify), so the command
// the run-verification step runs is exactly this check.
function makeProjectWithMarker(base: string): { projectRoot: string; markerPath: string } {
  const projectRoot = join(base, 'project');
  mkdirSync(projectRoot, { recursive: true });
  const markerPath = join(projectRoot, 'GREEN_MARKER');
  const escaped = markerPath.replace(/\\/g, '\\\\');
  writeFileSync(
    join(projectRoot, 'package.json'),
    `${JSON.stringify({
      private: true,
      scripts: { verify: `node -e "process.exit(require('fs').existsSync('${escaped}')?0:1)"` },
    })}\n`,
  );
  return { projectRoot, markerPath };
}

// The connector-agnostic fake connector. It dispatches on the step marker the
// prompt composer embeds ("Step: <id>") and returns that step's canned body.
// The implement step writes the green marker on its `writeMarkerOnImplementCall`
// call (>=1), so the verify after it goes green; undefined means it never writes
// (every verify stays red).
function crossToolBuildRelayer(input: {
  readonly markerPath: string;
  readonly writeMarkerOnImplementCall: number | undefined;
}): RelayFn {
  let implementCalls = 0;
  const relay = async (relayInput: RelayInput) => {
    const prompt = relayInput.prompt;
    if (prompt.includes('Step: propose-step')) {
      return stubRelayResult({ request_payload: prompt, result_body: PROPOSAL_BODY });
    }
    if (prompt.includes('Step: review-proposal-step')) {
      return stubRelayResult({ request_payload: prompt, result_body: PROPOSAL_REVIEW_BODY });
    }
    if (prompt.includes('Step: spec-step')) {
      return stubRelayResult({ request_payload: prompt, result_body: SPEC_BODY });
    }
    if (prompt.includes('Step: review-spec-step')) {
      return stubRelayResult({ request_payload: prompt, result_body: SPEC_REVIEW_BODY });
    }
    if (prompt.includes('Step: implement-step')) {
      implementCalls += 1;
      if (
        input.writeMarkerOnImplementCall !== undefined &&
        implementCalls >= input.writeMarkerOnImplementCall
      ) {
        writeFileSync(input.markerPath, 'fixed');
      }
      return stubRelayResult({ request_payload: prompt, result_body: IMPLEMENTATION_BODY });
    }
    return stubRelayResult({ request_payload: prompt, result_body: '{"verdict":"accept"}' });
  };
  // connectorName intentionally omitted: see the file header. With no supplied
  // identity the runtime guard stays silent and each step resolves its own pin,
  // which is the only way a single relayer can drive a flow that pins different
  // connectors per step.
  return { connectorName: undefined, relay } as unknown as RelayFn;
}

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'circuit-cross-tool-build-'));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('cross-tool-build: the per-step worker pin routes doer and reviewer to different connectors', () => {
  it('compiles the connector pin onto every relay step (doer -> codex, reviews -> claude-code)', () => {
    const compiled = JSON.parse(crossToolBuildBytes().toString('utf8')) as {
      steps: Array<{ id: string; kind: string; connector?: unknown }>;
    };
    const byId = new Map(compiled.steps.map((s) => [s.id, s]));

    // Every relay step carries exactly the pin its role demands.
    for (const [stepId, expected] of Object.entries(EXPECTED_PINS)) {
      const step = byId.get(stepId);
      expect(step, `step ${stepId} present`).toBeDefined();
      expect(step?.kind).toBe('relay');
      expect(step?.connector, `step ${stepId} pin`).toBe(expected);
    }

    // The non-relay steps carry no connector — the pin is a relay-only concept.
    for (const stepId of ['plan-step', 'verify-step', 'close-step']) {
      expect(byId.get(stepId)?.connector, `step ${stepId} has no pin`).toBeUndefined();
    }
  });

  it('runs the full pipeline to @complete, routing each step to its pinned connector at runtime; a revise review does not block', async () => {
    const { projectRoot, markerPath } = makeProjectWithMarker(base);
    const runFolder = join(base, 'green');

    // implement writes the marker on its first call, so the verify after it is
    // green and the run closes on the first pass.
    const result = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: crossToolBuildBytes(),
      projectRoot,
      runId: '7c000000-0000-0000-0000-0000000000c1',
      goal: 'cross-tool-build until the project verify script passes',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 5, 30, 9, 0, 0)),
      relayer: crossToolBuildRelayer({ markerPath, writeMarkerOnImplementCall: 1 }),
    });
    const trace = (await new TraceStore(runFolder).load()) as readonly TraceRow[];

    expect(result.outcome).toBe('complete');
    expect(result.flow_id).toBe('cross-tool-build');

    // The whole linear pipeline ran once each, in order.
    for (const stepId of [
      'plan-step',
      'propose-step',
      'review-proposal-step',
      'spec-step',
      'review-spec-step',
      'implement-step',
      'verify-step',
      'close-step',
    ]) {
      expect(enteredCount(trace, stepId), `${stepId} entered once`).toBe(1);
    }

    // The cross-tool guarantee, proven at runtime: every relay step's
    // relay.started records the connector its pin requested.
    expect(startedConnectorsByStep(trace)).toEqual(EXPECTED_PINS);

    // Forward-carry: the proposal review returned 'revise' and the run still
    // reached @complete. The result carries both verdicts for transparency.
    const resultReport = JSON.parse(
      readFileSync(join(runFolder, 'reports/cross-tool-build-result.json'), 'utf8'),
    ) as {
      outcome: string;
      verification_status: string;
      proposal_review_verdict: string;
      spec_review_verdict: string;
    };
    expect(resultReport.outcome).toBe('complete');
    expect(resultReport.verification_status).toBe('passed');
    expect(resultReport.proposal_review_verdict).toBe('revise');
    expect(resultReport.spec_review_verdict).toBe('accept');
    // Real-subprocess e2e: the verify step spawns a live command, so a generous
    // timeout keeps it green under the full suite's parallel load.
  }, 30_000);

  it('does not close complete on a red verify: it routes back to implement, then closes once green', async () => {
    const { projectRoot, markerPath } = makeProjectWithMarker(base);
    const runFolder = join(base, 'red-then-green');

    // implement writes the marker on its SECOND call. So: implement(1) leaves
    // the verify red -> the verify gate routes back to implement -> implement(2)
    // writes the marker -> the second verify is green -> the run closes.
    const result = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: crossToolBuildBytes(),
      projectRoot,
      runId: '7c000000-0000-0000-0000-0000000000c2',
      goal: 'cross-tool-build whose first verify is red must not close until green',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 5, 30, 9, 30, 0)),
      relayer: crossToolBuildRelayer({ markerPath, writeMarkerOnImplementCall: 2 }),
    });
    const trace = (await new TraceStore(runFolder).load()) as readonly TraceRow[];

    expect(result.outcome).toBe('complete');
    expect(result.flow_id).toBe('cross-tool-build');

    // The verify gate had teeth: a red verify re-entered implement rather than
    // closing. implement and verify each ran twice; the upstream steps ran once.
    expect(enteredCount(trace, 'propose-step')).toBe(1);
    expect(enteredCount(trace, 'review-proposal-step')).toBe(1);
    expect(enteredCount(trace, 'spec-step')).toBe(1);
    expect(enteredCount(trace, 'review-spec-step')).toBe(1);
    expect(enteredCount(trace, 'implement-step')).toBe(2);
    expect(enteredCount(trace, 'verify-step')).toBe(2);
    expect(enteredCount(trace, 'close-step')).toBe(1);

    // Both implement attempts ran on the doer pin — the retry kept the routing.
    expect(startedConnectorsForStep(trace, 'implement-step')).toEqual(['codex', 'codex']);

    // The marker exists at the end (the green pass wrote it), so the close gate
    // saw a passed verification.
    expect(existsSync(markerPath)).toBe(true);
  }, 30_000);
});
