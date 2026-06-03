import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow, makeStubRelayer } from '../helpers/runtime-fixtures.js';

import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import type { RelayFn, RelayInput } from '../../src/shared/relay-runtime-types.js';

// The react-doctor inspect -> fix -> re-inspect loop, proven on the real
// graph-runner with a stubbed connector. This is the "smallest honest version":
// it exercises the actual runtime (skill injection, verdict routing, recovery
// corridor, report-reads carrier) and produces a real run folder + trace.
//
// Topology (no new engine surface, all reused):
//   produce (relay/implementer)            -> inspect
//   inspect (relay/reviewer, react-doctor) -> @complete on NO_ISSUES_FOUND
//                                          -> retry -> fix on ISSUES_FOUND
//   fix     (relay/implementer)            -> inspect   (loop back)
//
// "inspect" is the recovery-corridor origin: on ISSUES_FOUND the verdict check
// fails, the auto-derived narrow_scope binding routes 'retry' -> fix, and fix's
// 'pass' route re-enters inspect (legal because it reaches the corridor origin).
// The loop is capped by fix's default recovery max_attempts (2).

const REACT_DOCTOR_MARKER = 'REACT_DOCTOR_RUBRIC_BODY_MARKER';
const FINDING_MARKER = 'FINDING_MARKER_missing_key_prop';

let root: string;
let homeDir: string;
let runDir: string;
let originalHome: string | undefined;

function writeSkill(id: string, body: string): void {
  const dir = join(homeDir, '.agents', 'skills', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), body, 'utf8');
}

function relayStep(
  id: string,
  role: string,
  routes: Record<string, string>,
  pass: readonly string[],
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    title: id,
    protocol: `${id}@v1`,
    reads: [],
    routes,
    executor: 'worker',
    kind: 'relay',
    role,
    writes: {
      request: `requests/${id}.txt`,
      receipt: `receipts/${id}.txt`,
      result: `results/${id}.json`,
    },
    check: {
      kind: 'result_verdict',
      source: { kind: 'relay_result', ref: 'result' },
      pass,
    },
    ...extras,
  };
}

function demoFlowBytes(): Buffer {
  const steps = [
    relayStep('produce', 'implementer', { pass: 'inspect' }, ['accept']),
    relayStep('inspect', 'reviewer', { pass: '@complete', retry: 'fix' }, ['NO_ISSUES_FOUND'], {
      selection: { skills: { mode: 'replace', skills: ['react-doctor'] } },
    }),
    relayStep('fix', 'implementer', { pass: 'inspect' }, ['accept'], {
      reads: ['results/inspect.json'],
    }),
  ];
  return Buffer.from(
    JSON.stringify({
      schema_version: '2',
      id: 'react-doctor-loop-demo',
      version: '0.0.0-test',
      purpose: 'Demonstrate the react-doctor inspect-fix-reinspect loop.',
      entry: { signals: { include: [], exclude: [] }, intent_prefixes: [] },
      axes: {
        allowed_rigors: ['standard'],
        supports_tournament: false,
        supports_autonomous: false,
      },
      starts_at: 'produce',
      stages: [
        {
          id: 'act-stage',
          title: 'Act',
          canonical: 'act',
          steps: steps.map((step) => step.id),
        },
      ],
      stage_path_policy: {
        mode: 'partial',
        omits: ['frame', 'analyze', 'plan', 'verify', 'review', 'close'],
        rationale: 'Focused demonstrator: only the act stage carries the loop.',
      },
      steps,
    }),
  );
}

/**
 * A stub connector that returns scripted verdicts. The inspect step is the only
 * one with react-doctor injected, so its prompt is the only one carrying
 * REACT_DOCTOR_MARKER — that is how we tell which relay call is the inspector.
 * On ISSUES_FOUND the body carries the FINDING_MARKER, which (written to
 * results/inspect.json and read by fix) must surface in the fixer's prompt.
 */
function scriptedRelayer(
  verdictForInspectCall: (call: number) => 'NO_ISSUES_FOUND' | 'ISSUES_FOUND',
  captured: RelayInput[],
): RelayFn {
  let inspectCalls = 0;
  return makeStubRelayer((input) => {
    captured.push(input);
    if (input.prompt.includes(REACT_DOCTOR_MARKER)) {
      inspectCalls += 1;
      const verdict = verdictForInspectCall(inspectCalls);
      if (verdict === 'NO_ISSUES_FOUND') {
        return JSON.stringify({ verdict: 'NO_ISSUES_FOUND', findings: [] });
      }
      return JSON.stringify({
        verdict: 'ISSUES_FOUND',
        findings: [{ severity: 'high', id: 'F1', text: FINDING_MARKER, file_refs: ['App.tsx:12'] }],
      });
    }
    return JSON.stringify({ verdict: 'accept' });
  });
}

async function runDemo(
  verdictForInspectCall: (call: number) => 'NO_ISSUES_FOUND' | 'ISSUES_FOUND',
) {
  const captured: RelayInput[] = [];
  const outcome = await runCompiledFlow({
    runDir,
    flowBytes: demoFlowBytes(),
    runId: '7d000000-0000-4000-8000-00000000d0c7',
    goal: 'react-doctor inspect-fix-reinspect loop',
    depth: 'standard',
    now: deterministicNow(Date.UTC(2026, 5, 2, 10, 0, 0)),
    relayer: scriptedRelayer(verdictForInspectCall, captured),
  });
  const trace = await new TraceStore(runDir).load();
  const completions = trace
    .filter((entry) => entry.kind === 'step.completed')
    .map((entry) => [entry.step_id, entry.attempt, entry.route_taken] as const);
  return { outcome, trace, completions, captured };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'circuit-react-doctor-loop-'));
  homeDir = join(root, 'home');
  runDir = join(root, 'run');
  originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  writeSkill('react-doctor', `${REACT_DOCTOR_MARKER}\nReview the React change for quality issues.`);
});

afterEach(() => {
  if (originalHome === undefined) {
    Reflect.deleteProperty(process.env, 'HOME');
  } else {
    process.env.HOME = originalHome;
  }
  rmSync(root, { recursive: true, force: true });
});

describe('react-doctor inspect-fix-reinspect loop', () => {
  it('path 1: clean on first inspection completes without fixing', async () => {
    const { outcome, completions, captured } = await runDemo(() => 'NO_ISSUES_FOUND');

    expect(outcome.outcome).toBe('complete');
    expect(completions).toEqual([
      ['produce', 1, 'pass'],
      ['inspect', 1, 'pass'],
    ]);
    // react-doctor was injected into the inspector's prompt (skill-as-inspector).
    const inspectPrompts = captured.filter((input) => input.prompt.includes(REACT_DOCTOR_MARKER));
    expect(inspectPrompts).toHaveLength(1);
    // Control (non-vacuity): the only other relay call (produce) does NOT carry the
    // marker, so the marker is present because the skill was injected on inspect, not
    // because the harness leaks it everywhere.
    expect(captured).toHaveLength(2);
    const nonInspectPrompts = captured.filter(
      (input) => !input.prompt.includes(REACT_DOCTOR_MARKER),
    );
    expect(nonInspectPrompts).toHaveLength(1);
  });

  it('path 2: issues then clean loops once through the fixer', async () => {
    const { outcome, completions, captured } = await runDemo((call) =>
      call === 1 ? 'ISSUES_FOUND' : 'NO_ISSUES_FOUND',
    );

    expect(outcome.outcome).toBe('complete');
    expect(completions).toEqual([
      ['produce', 1, 'pass'],
      ['inspect', 1, 'retry'],
      ['fix', 1, 'pass'],
      ['inspect', 2, 'pass'],
    ]);
    // The inspector's findings reached the fixer's prompt (findings carrier).
    const fixPrompt = captured.find(
      (input) =>
        !input.prompt.includes(REACT_DOCTOR_MARKER) && input.prompt.includes(FINDING_MARKER),
    );
    expect(fixPrompt).toBeDefined();
  });

  it('path 3: persistent issues stop at the safety cap', async () => {
    const { outcome, completions } = await runDemo(() => 'ISSUES_FOUND');

    expect(outcome.outcome).toBe('aborted');
    expect(outcome.reason ?? '').toMatch(/exhausted max_attempts/);
    // The fixer ran twice (the default recovery cap) before the loop was stopped.
    const fixAttempts = completions.filter(([stepId]) => stepId === 'fix');
    expect(fixAttempts).toEqual([
      ['fix', 1, 'pass'],
      ['fix', 2, 'pass'],
    ]);
  });
});
