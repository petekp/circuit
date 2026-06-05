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
import type { EditFileTiming } from '../schemas/report-file-surface.js';
import { type RunSkillHookEvent, SKILL_HOOK_VOCABULARY } from '../schemas/skill-hook.js';
import type { TraceEntry } from '../schemas/trace-entry.js';
import type { UserSkillRegistry } from '../shared/user-skill-registry.js';
import { buildRunSkillHookEvent } from './policy.js';
import type { EditFileSurfaceSource } from './surface-sources.js';

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

// ---------------------------------------------------------------------------
// File-edit hooks (before:edit-files / after:edit-files)
// ---------------------------------------------------------------------------
//
// Unlike the check-outcome hooks (which read a literal trace signal), the
// file-edit hooks key on a FILE SURFACE that a step wrote into a typed report:
// the actual touched paths (after) or a predicted surface (before). The
// dispatcher reads the report via a `readJson` accessor, pulls the surface out
// via the per-flow EDIT_FILE_SURFACE_SOURCES table, and tests it against the
// operator's configured edit-files policy keys. The predicate is the key suffix
// (extension-suffix in v1): `after:edit-files:.tsx` matches a surface entry that
// `endsWith('.tsx')`; the bare `after:edit-files` matches any non-empty surface.
// See docs/ideas/skill-hooks-dispatch-spec.md (slice 2, D1/D2).

export type DispatchReadJson = (ref: string) => Promise<unknown>;

export interface DispatchEditFileHooksInput extends DispatchSkillHooksInput {
  // Reads a run-relative report path (the report_path on a step.report_written
  // entry) and returns its parsed JSON body.
  readonly readJson: DispatchReadJson;
  readonly editFileSurfaceSources: Readonly<Record<string, EditFileSurfaceSource>>;
}

// Matches the bare anchors and the v1 extension-suffix form, and nothing else
// (a namespaced custom hook starts with `<ns>/`, so it never matches).
const EDIT_FILE_KEY_RE = /^(before|after):edit-files(:(\.[A-Za-z0-9]+)+)?$/;

function editFileTiming(key: string): EditFileTiming {
  return key.startsWith('before:') ? 'before' : 'after';
}

function baseEditFileHook(key: string): 'before:edit-files' | 'after:edit-files' {
  return key.startsWith('before:') ? 'before:edit-files' : 'after:edit-files';
}

// The literal predicate carried in the key suffix: '.tsx' for
// `after:edit-files:.tsx`, '' (match-any) for a bare `after:edit-files`.
function editFileSuffix(key: string): string {
  const rest = key.slice(baseEditFileHook(key).length);
  return rest.startsWith(':') ? rest.slice(1) : '';
}

function surfaceMatches(surface: readonly string[], suffix: string): boolean {
  if (suffix === '') return surface.length > 0;
  return surface.some((item) => item.endsWith(suffix));
}

// The distinct edit-files policy keys configured across the run's config layers.
function editFilePolicyKeys(configLayers: readonly LayeredConfig[]): readonly string[] {
  const keys = new Set<string>();
  for (const layer of configLayers) {
    for (const key of Object.keys(layer.config.skill_hooks.policy)) {
      if (EDIT_FILE_KEY_RE.test(key)) keys.add(key);
    }
  }
  return [...keys];
}

// Build the edit-files skill-hook events a step's report surfaces trigger under
// the run's config. Returns only events whose policy resolved to something the
// operator opted into (mode !== 'none'). Best-effort: an unreadable report or a
// report schema with no surface source is skipped, never thrown.
export async function dispatchEditFileHooksForEntries(
  input: DispatchEditFileHooksInput,
): Promise<readonly RunSkillHookEvent[]> {
  const keys = editFilePolicyKeys(input.configLayers ?? []);
  if (keys.length === 0) return [];

  const events: RunSkillHookEvent[] = [];
  for (const entry of input.entries) {
    if (entry.kind !== 'step.report_written') continue;
    const source = input.editFileSurfaceSources[entry.report_schema];
    if (source === undefined) continue;

    let report: unknown;
    try {
      report = await input.readJson(entry.report_path);
    } catch {
      continue; // unreadable report: report-only dispatch must never break a run
    }

    const surface = source.extract(report);
    if (surface.length === 0) continue;

    for (const key of keys) {
      if (editFileTiming(key) !== source.timing) continue;
      if (!surfaceMatches(surface, editFileSuffix(key))) continue;
      const vocabulary = VOCABULARY_BY_HOOK.get(baseEditFileHook(key));
      if (vocabulary === undefined) continue;
      const event = buildRunSkillHookEvent({
        eventId: `${input.eventIdBase}:${key}:${entry.sequence}`,
        hook: key,
        detectedFrom: [...vocabulary.detected_from],
        cardinality: vocabulary.cardinality,
        ...(input.configLayers === undefined ? {} : { configLayers: input.configLayers }),
        ...(input.registry === undefined ? {} : { registry: input.registry }),
        ...(input.scope.flowId === undefined ? {} : { flowId: input.scope.flowId }),
        ...(input.scope.stageId === undefined ? {} : { stageId: input.scope.stageId }),
        ...(input.scope.stepId === undefined ? {} : { stepId: input.scope.stepId }),
        ...(input.scope.attemptId === undefined ? {} : { attemptId: input.scope.attemptId }),
      });
      if (event.policy.mode === 'none') continue;
      events.push(event);
    }
  }
  return events;
}

// The single dispatch entry the graph-runner calls after a step completes:
// records both check-outcome hooks (sync, from trace signals) and file-edit
// hooks (async, from report surfaces) the step's entries trigger.
export async function dispatchSkillHooks(
  input: DispatchEditFileHooksInput,
): Promise<readonly RunSkillHookEvent[]> {
  const checkOutcome = dispatchSkillHooksForEntries(input);
  const editFile = await dispatchEditFileHooksForEntries(input);
  return [...checkOutcome, ...editFile];
}
