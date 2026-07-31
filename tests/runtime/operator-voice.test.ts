import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { flowPackages } from '../../src/flows/catalog.js';
import type { TraceEntry } from '../../src/runtime/domain/trace.js';
import { fromCompiledFlow } from '../../src/runtime/manifest/from-compiled-flow.js';
import {
  type ProgressProjectionFiles,
  createProgressProjector,
} from '../../src/runtime/projections/progress.js';
import { CompiledFlow } from '../../src/schemas/compiled-flow.js';
import type { ProgressEvent } from '../../src/schemas/progress-event.js';

// The jargon floor: no operator-facing line may leak an internal token. The
// operator channel is presentation.status_text (every renderer — CLI status
// blocks, the Claude present wrapper, the TUI, the Codex MCP event summaries —
// narrates from it); display.text is a machine mirror and may keep its
// "Circuit:" chrome. Flow-authored progress-surface strings feed status_text
// verbatim, so they are held to the same floor.
const JARGON_RULES: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
  // Route targets and codenames like @complete, @stop, @handoff.
  { name: 'an @-target codename', pattern: /@[a-z_]+/i },
  // Raw enum tokens like NO_ISSUES_FOUND or CHANGES_REQUIRED.
  { name: 'a SCREAMING_CASE enum', pattern: /\b[A-Z0-9]+_[A-Z0-9_]+\b/ },
  // Dotted schema or report ids like circuit.review.result.
  { name: 'a dotted schema id', pattern: /\bcircuit\.[a-z]/i },
  // Internal fan-out branch ids like unit-1.
  { name: 'an internal unit id', pattern: /\bunit-\d+\b/ },
  // Branding is the host's job; the engine's operator line stays unbranded.
  { name: 'a "Circuit:" brand prefix', pattern: /^Circuit:/ },
];

function expectOperatorSafe(text: string, context: string): void {
  for (const rule of JARGON_RULES) {
    expect.soft(rule.pattern.test(text), `${context} contains ${rule.name}: "${text}"`).toBe(false);
  }
}

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const RECORDED_AT = '2026-07-31T12:00:00.000Z';
const RUN_DIR = '/tmp/circuit-operator-voice-test';

function trace(
  entry: { readonly sequence: number; readonly kind: TraceEntry['kind'] } & Record<string, unknown>,
): TraceEntry {
  return { run_id: RUN_ID, recorded_at: RECORDED_AT, ...entry } as unknown as TraceEntry;
}

function projectorFixture(files?: ProgressProjectionFiles): {
  readonly project: (entries: readonly TraceEntry[]) => void;
  readonly events: ProgressEvent[];
} {
  const body = JSON.parse(readFileSync(resolve('generated/flows/explore/circuit.json'), 'utf8'));
  const surface = flowPackages.find((pkg) => pkg.id === 'explore')?.runtimeSurface?.progress;
  if (surface === undefined) throw new Error('missing explore progress surface');
  const events: ProgressEvent[] = [];
  const projector = createProgressProjector({
    progress: (event) => events.push(event),
    runDir: RUN_DIR,
    runId: RUN_ID,
    flow: fromCompiledFlow(CompiledFlow.parse(body)),
    progressSurface: surface,
    ...(files === undefined ? {} : { files }),
  });
  return {
    project: (entries) => {
      for (const entry of entries) projector(entry);
    },
    events,
  };
}

describe('operator voice jargon floor', () => {
  it('keeps every flow-authored progress surface string jargon free', () => {
    for (const pkg of flowPackages) {
      const steps = pkg.runtimeSurface?.progress?.steps ?? [];
      for (const step of steps) {
        expectOperatorSafe(step.taskTitle, `${pkg.id}/${step.stepId} taskTitle`);
        expectOperatorSafe(step.activeText, `${pkg.id}/${step.stepId} activeText`);
        if (step.relayStartedText !== undefined) {
          expectOperatorSafe(step.relayStartedText, `${pkg.id}/${step.stepId} relayStartedText`);
        }
        if (step.relayCompletedText !== undefined) {
          expectOperatorSafe(
            step.relayCompletedText,
            `${pkg.id}/${step.stepId} relayCompletedText`,
          );
        }
      }
    }
  });

  it('keeps every projector status line jargon free across all narrated paths', () => {
    const reportPath = 'reports/explore.synthesize.json';
    const requestPath = 'checkpoints/choice.json';
    const files: ProgressProjectionFiles = {
      readText: (path) => {
        if (path.endsWith(reportPath)) {
          return JSON.stringify({
            evidence: { commands: [] },
            evidence_warnings: [
              { kind: 'missing_file', message: 'A cited file is missing.', path: 'src/a.ts' },
            ],
          });
        }
        if (path.endsWith(requestPath)) {
          return JSON.stringify({ prompt: 'Keep the draft or send it back for revision?' });
        }
        return undefined;
      },
    };
    const { project, events } = projectorFixture(files);
    const step = 'synthesize-step';
    project([
      trace({ sequence: 0, kind: 'run.bootstrapped', flow_id: 'explore' }),
      trace({ sequence: 1, kind: 'step.entered', step_id: step, attempt: 1 }),
      trace({
        sequence: 2,
        kind: 'relay.started',
        step_id: step,
        role: 'reviewer',
        connector: { kind: 'builtin', name: 'claude-code' },
        context_seal: { applied: false, reason: 'this connector kept repository access' },
      }),
      trace({
        sequence: 3,
        kind: 'relay.completed',
        step_id: step,
        role: 'reviewer',
        verdict: 'accept',
        duration_ms: 1200,
      }),
      trace({
        sequence: 4,
        kind: 'step.report_written',
        step_id: step,
        report_path: reportPath,
        report_schema: 'explore.synthesize',
      }),
      trace({
        sequence: 5,
        kind: 'fanout.started',
        step_id: step,
        branch_ids: ['option-1', 'option-2'],
      }),
      trace({
        sequence: 6,
        kind: 'fanout.joined',
        step_id: step,
        policy: 'pick-winner',
        selected_branch_id: 'option-1',
        aggregate_path: 'fanout/aggregate.json',
        branches_completed: 2,
        branches_failed: 0,
      }),
      trace({
        sequence: 7,
        kind: 'checkpoint.requested',
        step_id: step,
        request_path: requestPath,
        options: ['keep', 'revise'],
        auto_resolved: false,
      }),
      // A failed check routed to recovery, then a spent retry budget.
      trace({ sequence: 8, kind: 'check.evaluated', step_id: step, attempt: 1, outcome: 'fail' }),
      trace({
        sequence: 9,
        kind: 'step.completed',
        step_id: step,
        attempt: 1,
        route_taken: 'retry',
      }),
      trace({ sequence: 10, kind: 'check.evaluated', step_id: step, attempt: 2, outcome: 'fail' }),
      trace({
        sequence: 11,
        kind: 'step.exhaustion_rerouted',
        step_id: step,
        attempt: 2,
        to_route: 'escalate',
      }),
      trace({
        sequence: 12,
        kind: 'step.completed',
        step_id: step,
        attempt: 2,
        route_taken: 'escalate',
      }),
      trace({ sequence: 13, kind: 'step.entered', step_id: step, attempt: 3 }),
      trace({
        sequence: 14,
        kind: 'step.aborted',
        step_id: step,
        attempt: 3,
        reason: 'The worker exited before writing its report.',
      }),
      trace({
        sequence: 15,
        kind: 'run.closed',
        outcome: 'evidence_invalid',
        reason: 'A cited file is missing.',
      }),
      trace({ sequence: 16, kind: 'run.closed', outcome: 'complete' }),
      trace({
        sequence: 17,
        kind: 'run.closed',
        outcome: 'aborted',
        reason: 'The run folder disappeared.',
      }),
    ]);

    const narrated = events.filter((event) => event.presentation?.status_text !== undefined);
    expect(narrated.length).toBeGreaterThanOrEqual(10);
    for (const event of narrated) {
      const statusText = event.presentation?.status_text;
      if (statusText === undefined) continue;
      expectOperatorSafe(statusText, `${event.type} status_text`);
    }
    // Checkpoint questions reach the operator verbatim through the native
    // question surface, so they are held to the same floor.
    for (const event of events) {
      if (event.type !== 'user_input.requested') continue;
      for (const question of event.questions) {
        expectOperatorSafe(question.question, 'checkpoint question');
        for (const option of question.options) {
          expectOperatorSafe(option.label, 'checkpoint option label');
        }
      }
    }
  });
});
