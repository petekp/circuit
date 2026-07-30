// Trace and evidence reading for the graph runner.
//
// Pure readers over a run's trace entries and reports: failure evidence for
// recovery routes, report/relay refs, resume-time projections (completed step
// counts, skill-hook injections), and proof-policy scope helpers. Nothing here
// drives execution or appends trace entries.

import type { GuidanceDecisionTraceEntryBody } from '../../schemas/guidance-decision.js';
import { CompiledFlowId, RunId, StepId } from '../../schemas/ids.js';
import type { RecoveryRouteBindingV0 } from '../../schemas/recovery-route-kind.js';
import type { Ref } from '../../schemas/ref.js';
import type { ProofAssessedTraceEntry } from '../../schemas/trace-entry.js';
import type { SkillHookInjectionChannel } from '../../skill-hooks/injection.js';
import { isAcceptanceRetryFeedback } from '../acceptance-criteria.js';
import type { TraceEntry } from '../domain/trace.js';
import type { RecoveryFailureEvidence } from './recovery-binding-verdict.js';
import type { RunContext } from './run-context.js';
import type { SliceCorridor } from './slice-corridor.js';

function traceRefForEntry(input: {
  readonly context: RunContext;
  readonly stepId: string;
  readonly attempt: number;
  readonly sequence: number;
}): Ref {
  return {
    kind: 'trace',
    ref: `trace.ndjson#sequence=${input.sequence}`,
    run_id: RunId.parse(input.context.runId),
    flow_id: CompiledFlowId.parse(input.context.flow.id),
    step_id: StepId.parse(input.stepId),
    attempt: input.attempt,
    sequence: input.sequence,
  };
}

export function latestRecoveryFailureEvidence(input: {
  readonly context: RunContext;
  readonly stepId: string;
  readonly attempt: number;
  readonly details: Record<string, unknown>;
  // The active slice index for loop-body steps. Under the slice loop a step's
  // attempt number resets per slice, so (step_id, attempt) collides across
  // slices; without this filter the resolver would attribute an earlier
  // slice's failed check to a later slice's clean attempt. Undefined for
  // non-loop steps (no filtering, unchanged behavior).
  readonly sliceIndex?: number;
}): RecoveryFailureEvidence | undefined {
  for (const entry of [...input.context.trace.getAll()].reverse()) {
    if (entry.kind !== 'check.evaluated' && entry.kind !== 'relay.failed') continue;
    if (entry.step_id !== input.stepId || entry.attempt !== input.attempt) continue;
    if (
      input.sliceIndex !== undefined &&
      'slice_index' in entry &&
      entry.slice_index !== input.sliceIndex
    ) {
      continue;
    }
    if (entry.kind === 'check.evaluated') {
      // A non-fail evaluation is decisive: this attempt's work was accepted,
      // so nothing earlier in the attempt is failure evidence for the route it
      // selected. Scanning past it would attribute a connector death the
      // relay-layer retry already absorbed to a passing attempt.
      if (entry.outcome !== 'fail') return undefined;
      return {
        ref: traceRefForEntry({
          context: input.context,
          stepId: input.stepId,
          attempt: input.attempt,
          sequence: entry.sequence,
        }),
        cause: isAcceptanceRetryFeedback(input.details.acceptance_feedback)
          ? 'failed_acceptance_criteria'
          : 'failed_check',
      };
    }
    return {
      ref: traceRefForEntry({
        context: input.context,
        stepId: input.stepId,
        attempt: input.attempt,
        sequence: entry.sequence,
      }),
      cause: 'relay_connector_failed',
    };
  }
  return undefined;
}

// Unlike latestRecoveryFailureEvidence, this needs no slice filter: every
// loop-body execution writes a report/result, so under the slice loop the
// current slice's entry is always the latest-by-sequence match for
// (step_id, attempt) and reverse iteration returns it. (A clean slice has no
// failure entry of its own, which is why the failure resolver — not this one —
// must filter by slice to avoid crossing an earlier slice's failure.)
export function latestStepReportOrRelayRef(input: {
  readonly context: RunContext;
  readonly stepId: string;
  readonly attempt: number;
}): Ref | undefined {
  for (const entry of [...input.context.trace.getAll()].reverse()) {
    if (entry.kind !== 'step.report_written' && entry.kind !== 'relay.result') continue;
    if (entry.step_id !== input.stepId || entry.attempt !== input.attempt) continue;
    return traceRefForEntry({
      context: input.context,
      stepId: input.stepId,
      attempt: input.attempt,
      sequence: entry.sequence,
    });
  }
  return undefined;
}

export function reportSelectedCheckpointBoundaryEvidence(input: {
  readonly context: RunContext;
  readonly stepId: string;
  readonly attempt: number;
  readonly details: Record<string, unknown>;
  readonly binding: RecoveryRouteBindingV0 | undefined;
}): RecoveryFailureEvidence | undefined {
  if (!routeSelectedFromReport(input.details)) return undefined;
  if (input.binding?.kind !== 'checkpoint_authority') return undefined;
  if (!input.binding.allowed_failure_causes.includes('checkpoint_boundary')) return undefined;
  const ref = latestStepReportOrRelayRef(input);
  return ref === undefined ? undefined : { ref, cause: 'checkpoint_boundary' };
}

// On checkpoint resume the injection channel is recreated empty, but `auto`
// hooks that fired in the PRIOR process recorded their injections durably as
// run.skill-hook events. Re-seed the channel from those events so a later
// implementer step in the resumed process sees the same injected skill set a
// single-process run would. Without this, an injection from a step that is not
// re-executed on resume is silently lost and the resumed run can feed a later
// step a different skill set (and different check outcomes) than a single-process
// run. Mirrors the live actuator gate exactly: auto policy, no pending decision
// packet, at least one resolved skill.
export function seedSkillHookInjectionsFromTrace(
  entries: readonly TraceEntry[],
  channel: SkillHookInjectionChannel | undefined,
): void {
  if (channel === undefined) return;
  for (const entry of entries) {
    if (entry.kind !== 'run.skill-hook') continue;
    const event = entry.event;
    if (
      event.policy.mode === 'auto' &&
      event.decision_packet_id === undefined &&
      event.triggered_skills.length > 0
    ) {
      channel.add(event.triggered_skills.map((skill) => skill.id));
    }
  }
}

export function completedStepCountsFromTrace(
  entries: readonly TraceEntry[],
  corridor: SliceCorridor,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.kind !== 'step.completed' || entry.step_id === undefined) continue;
    // Loop-body completions are keyed per slice so a resumed run restarts the
    // next slice at attempt 1 (matching the live keying below). The recorded
    // slice_index is load-bearing here; non-loop steps key on the bare id.
    const sliceIndex = typeof entry.slice_index === 'number' ? entry.slice_index : 0;
    const key = corridor.countKey(entry.step_id, sliceIndex);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function routeSelectedFromReport(details: Record<string, unknown>): boolean {
  return details.route_source === 'report';
}

export function traceScope(
  entry: GuidanceDecisionTraceEntryBody | ProofAssessedTraceEntry,
): Record<string, unknown> {
  return recordValue(entry.scope);
}

export function proofPolicyRequirementKey(entry: GuidanceDecisionTraceEntryBody): string {
  const scope = traceScope(entry);
  const selected = recordValue(entry.selected);
  return JSON.stringify({
    flow_id: scope.flow_id,
    step_id: scope.step_id,
    proof_profile: selected.proof_profile,
    required_claim_kinds: selected.required_claim_kinds,
    required_evidence_kinds: selected.required_evidence_kinds,
  });
}
