// Skill-hook dispatch (report-only slice).
//
// This is the live caller the policy layer was staged for. After a step
// completes, the graph-runner hands this the trace entries that step just
// appended; this maps the literal, rule-based detection signals to the
// check-outcome hooks (after:verification-failed, after:evidence-gap), asks the
// policy layer what each would do (buildRunSkillHookEvent), and returns the
// events that a configured policy matched. The caller RECORDS them and injects
// nothing — report-only. Detection is rule-based only (a typed trace signal),
// never a model reading prose. See docs/ideas/skill-hooks-dispatch-spec.md.

import type { LayeredConfig } from '../schemas/config.js';
import { type RunSkillHookEvent, SKILL_HOOK_VOCABULARY } from '../schemas/skill-hook.js';
import type { TraceEntry } from '../schemas/trace-entry.js';
import type { UserSkillRegistry } from '../shared/user-skill-registry.js';
import { buildRunSkillHookEvent } from './policy.js';

const VOCABULARY_BY_HOOK = new Map<string, (typeof SKILL_HOOK_VOCABULARY)[number]>(
  SKILL_HOOK_VOCABULARY.map((entry) => [entry.hook, entry]),
);

export interface SkillHookDispatchScope {
  readonly flowId?: string;
  readonly stageId?: string;
  readonly stepId?: string;
  readonly attemptId?: string;
}

export interface DispatchSkillHooksInput {
  // Trace entries a single step just appended (executor output + step.completed).
  readonly entries: readonly TraceEntry[];
  // The run's layered config (context.selectionConfigLayers); carries skill_hooks.
  readonly configLayers?: readonly LayeredConfig[];
  readonly scope: SkillHookDispatchScope;
  // A run/step-unique prefix so each event_id is distinct.
  readonly eventIdBase: string;
  readonly registry?: UserSkillRegistry;
}

// Map a just-appended trace entry to the check-outcome hook it triggers, if any.
// Rule-based: keys on literal trace signals, no model.
//
// after:verification-failed — a failed verification check (the schema_sections
// check the verification executor emits); deliberately NOT relay result_verdict
// or acceptance_criteria checks.
//
// after:evidence-gap — the vocabulary defines this as "required claim missing
// AFTER VERIFY", so it must key only on a VERIFICATION proof assessment
// (assessment_id `proof.verification:*`, not a relay's `proof.acceptance:*`
// proof, which every ordinary implementer relay emits as non-proven). It also
// excludes 'contradicted' (a hard verification failure, already covered by
// after:verification-failed) so a single failing verify does not double-fire;
// the gap signal is a verification that ran but left a required claim unproven.
function hookForEntry(entry: TraceEntry): string | undefined {
  if (
    entry.kind === 'check.evaluated' &&
    entry.check_kind === 'schema_sections' &&
    entry.outcome === 'fail'
  ) {
    return 'after:verification-failed';
  }
  if (
    entry.kind === 'proof.assessed' &&
    entry.assessment_id.startsWith('proof.verification:') &&
    entry.overall_status !== 'proven' &&
    entry.overall_status !== 'contradicted'
  ) {
    return 'after:evidence-gap';
  }
  return undefined;
}

// Build the skill-hook events a step's signals trigger under the run's config.
// Returns only events whose policy resolved to something the operator opted into
// (mode !== 'none'); a run with no matching skill_hooks config yields []. Pure:
// no IO beyond the optional skill registry's own resolution; never throws for a
// non-triggering entry.
export function dispatchSkillHooksForEntries(
  input: DispatchSkillHooksInput,
): readonly RunSkillHookEvent[] {
  const events: RunSkillHookEvent[] = [];
  for (const entry of input.entries) {
    const hook = hookForEntry(entry);
    if (hook === undefined) continue;
    const vocabulary = VOCABULARY_BY_HOOK.get(hook);
    if (vocabulary === undefined) continue;
    const event = buildRunSkillHookEvent({
      eventId: `${input.eventIdBase}:${hook}:${entry.sequence}`,
      hook,
      detectedFrom: [...vocabulary.detected_from],
      cardinality: vocabulary.cardinality,
      ...(input.configLayers === undefined ? {} : { configLayers: input.configLayers }),
      ...(input.registry === undefined ? {} : { registry: input.registry }),
      ...(input.scope.flowId === undefined ? {} : { flowId: input.scope.flowId }),
      ...(input.scope.stageId === undefined ? {} : { stageId: input.scope.stageId }),
      ...(input.scope.stepId === undefined ? {} : { stepId: input.scope.stepId }),
      ...(input.scope.attemptId === undefined ? {} : { attemptId: input.scope.attemptId }),
    });
    // Operator opt-in gate: mode 'none' means no configured policy matched this
    // hook, so a run with no skill_hooks config records nothing.
    if (event.policy.mode === 'none') continue;
    events.push(event);
  }
  return events;
}
