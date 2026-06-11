import { z } from 'zod';
import { CompiledDepth } from './depth.js';
import { SkillId, StageId, StepId } from './ids.js';
import { JsonObject } from './json.js';
import { Power } from './power.js';

// Provider-scoped model. The four-provider enum is closed; `model` is an
// open string because connector-specific code owns provider/model handling.
// New model releases do not force a schema change here.
export const ProviderScopedModel = z
  .object({
    provider: z.enum(['openai', 'anthropic', 'gemini', 'custom']),
    model: z.string().min(1),
  })
  .strict();
export type ProviderScopedModel = z.infer<typeof ProviderScopedModel>;

// Effort tier. OpenAI's 6-tier vocabulary plus Claude Code's `max`,
// chosen for cross-provider
// portability — connectors map non-OpenAI effort levels onto this set.
export const Effort = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export type Effort = z.infer<typeof Effort>;

// Skill arrays enforce uniqueness. Set-algebra composition (union,
// difference) at the resolver layer expects the inputs to be sets;
// accepting duplicates at parse time would let a YAML author's typo
// silently produce `['tdd', 'tdd']` and mask the intent.
const UniqueSkillArray = z.array(SkillId).superRefine((arr, ctx) => {
  const duplicates = [...new Set(arr.filter((skill, index) => arr.indexOf(skill) !== index))];
  if (duplicates.length === 0) return;
  ctx.addIssue({
    code: 'custom',
    message: `skills array contains duplicates: ${duplicates.join(', ')}`,
  });
});

// Typed skill operations, no empty-array ambiguity. `inherit` is a pure
// sentinel; the other three carry an explicit `skills: SkillId[]`. Empty
// arrays under non-inherit modes are legal and mean what they say:
// replace:[] clears the set; append:[] and remove:[] are no-ops.
export const SkillOverride = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('inherit') }).strict(),
  z.object({ mode: z.literal('replace'), skills: UniqueSkillArray }).strict(),
  z.object({ mode: z.literal('append'), skills: UniqueSkillArray }).strict(),
  z.object({ mode: z.literal('remove'), skills: UniqueSkillArray }).strict(),
]);
export type SkillOverride = z.infer<typeof SkillOverride>;

// Every field optional; `.strict()` rejects surplus keys (typos that
// would otherwise silently leave the effective selection at the prior
// layer's default). `invocation_options` is JSON-safe; its merge
// semantics are right-biased by precedence (later layers override).
export const SelectionOverride = z
  .object({
    model: ProviderScopedModel.optional(),
    effort: Effort.optional(),
    skills: SkillOverride.default({ mode: 'inherit' }),
    depth: CompiledDepth.optional(),
    invocation_options: JsonObject.default({}),
  })
  .strict();
export type SelectionOverride = z.infer<typeof SelectionOverride>;

// ResolvedSelection is the effective record at relay time.
// `invocation_options` is included because connectors consume it; omitting
// it would make RelayStartedTraceEntry.resolved_selection insufficient for
// audit or replay. The resolver flattens `applied[].override.invocation_options`
// via right-biased merge by precedence. ResolvedSelection does NOT carry
// SkillOverride — the resolver flattens the override chain into a final
// unique SkillId[].
export const ResolvedSelection = z
  .object({
    model: ProviderScopedModel.optional(),
    effort: Effort.optional(),
    skills: UniqueSkillArray,
    depth: CompiledDepth.optional(),
    invocation_options: JsonObject.default({}),
    // Present only when the Power dial materialized this selection's model or
    // effort from a tier table. Absent when explicit model config won, when
    // the connector has no tier table, or on pre-dial artifacts. Carried here
    // so RelayStartedTraceEntry.resolved_selection self-reports dial
    // application and the run receipt never has to guess.
    power: Power.optional(),
    // True only when a retry (attempt > 1) actually bumped the allocated tier
    // up. A retry whose role was already at the top tier records no
    // escalation — the receipt counts real bumps, not retries.
    power_escalated: z.boolean().optional(),
  })
  .strict();
export type ResolvedSelection = z.infer<typeof ResolvedSelection>;

export const SelectionSource = z.enum([
  'default',
  'user-global',
  'project',
  'flow',
  'stage',
  'step',
  'invocation',
]);
export type SelectionSource = z.infer<typeof SelectionSource>;

// Precedence is declared, closed, and compile-time pinned to the
// `SelectionSource` enum. The `as const satisfies readonly SelectionSource[]`
// makes drift between the enum and the precedence list a `tsc --strict`
// error — adding a source to the enum without adding it here (or vice
// versa) fails the build before the runtime sees it.
export const SELECTION_PRECEDENCE = [
  'default',
  'user-global',
  'project',
  'flow',
  'stage',
  'step',
  'invocation',
] as const satisfies readonly SelectionSource[];

// Compile-time bidirectional equality: `SelectionSource` and the
// tuple-derived element type must be the same string-literal set. If one
// drifts, `_SelectionSourcePrecedenceParity` collapses to `never` and the
// build fails.
type _IsExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type _PrecedenceSource = (typeof SELECTION_PRECEDENCE)[number];
type _SelectionSourcePrecedenceParity = _IsExact<SelectionSource, _PrecedenceSource> extends true
  ? true
  : never;
export const _compileTimeSelectionSourceParity: _SelectionSourcePrecedenceParity = true;

// Precedence-index lookup used by the applied-chain ordering check.
const PRECEDENCE_INDEX: Record<SelectionSource, number> = Object.fromEntries(
  SELECTION_PRECEDENCE.map((s, i) => [s, i]),
) as Record<SelectionSource, number>;

// Applied[] entries are a discriminated union on `source`. The `stage` and
// `step` variants carry a required disambiguator (`stage_id`, `step_id`).
// The five singleton-identified variants (default, user-global, project,
// flow, invocation) do not, because a Run has at most one contribution
// from each.
//
// Disambiguators make provenance independently auditable: reading an
// `applied` entry with `source: 'stage'` names the exact stage. Two
// `stage` entries are permitted when a step legally belongs to multiple
// stages (overlapping stages are allowed in the schema; the trace must
// be able to represent them).
const AppliedEntry = z.discriminatedUnion('source', [
  z.object({ source: z.literal('default'), override: SelectionOverride }).strict(),
  z.object({ source: z.literal('user-global'), override: SelectionOverride }).strict(),
  z.object({ source: z.literal('project'), override: SelectionOverride }).strict(),
  z.object({ source: z.literal('flow'), override: SelectionOverride }).strict(),
  z
    .object({
      source: z.literal('stage'),
      stage_id: StageId,
      override: SelectionOverride,
    })
    .strict(),
  z.object({ source: z.literal('step'), step_id: StepId, override: SelectionOverride }).strict(),
  z.object({ source: z.literal('invocation'), override: SelectionOverride }).strict(),
]);
export type AppliedEntry = z.infer<typeof AppliedEntry>;

// Ghost-provenance rejection. An override is "empty" iff every field is
// at its schema default: no model, no effort, no depth, skills in `inherit`
// mode, invocation_options empty. Applied entries whose override is empty
// fabricate provenance for a non-contributing layer and are rejected.
function overrideContributes(o: SelectionOverride): boolean {
  if (o.model !== undefined) return true;
  if (o.effort !== undefined) return true;
  if (o.depth !== undefined) return true;
  if (o.skills.mode !== 'inherit') return true;
  if (Object.keys(o.invocation_options).length > 0) return true;
  return false;
}

const SelectionResolutionBody = z
  .object({
    resolved: ResolvedSelection,
    applied: z.array(AppliedEntry),
  })
  .strict();

const issueAt = (ctx: z.RefinementCtx, path: (string | number)[], message: string) => {
  ctx.addIssue({ code: 'custom', path, message });
};

// Single-pass enforcement on the applied chain:
//   - Precedence-order: each source must have a precedence index > the
//     previous for category changes. Equal index is tolerated when the
//     disambiguator distinguishes the entries (two stage entries are
//     legal).
//   - Unique-identity: no identity (source + disambiguator) appears twice.
//     For singleton sources (default, user-global, project, flow,
//     invocation), identity is the source alone. For plural sources
//     (stage, step), identity is `{source, stage_id}` / `{source, step_id}`.
//   - Ghost-provenance: every entry's override must contribute — no entry
//     that re-asserts the prior chain's resolved value.
function identityKey(entry: AppliedEntry): string {
  switch (entry.source) {
    case 'stage':
      return `stage:${entry.stage_id as unknown as string}`;
    case 'step':
      return `step:${entry.step_id as unknown as string}`;
    default:
      return entry.source;
  }
}

export const SelectionResolution = SelectionResolutionBody.superRefine((res, ctx) => {
  const seen = new Set<string>();
  let lastIndex = -1;
  for (let i = 0; i < res.applied.length; i++) {
    const entry = res.applied[i];
    if (entry === undefined) continue;
    const key = identityKey(entry);
    if (seen.has(key)) {
      issueAt(
        ctx,
        ['applied', i, 'source'],
        `duplicate applied identity '${key}' at index ${i}; each identity may contribute at most once (stage/step are disambiguated by their id)`,
      );
      continue;
    }
    seen.add(key);
    const idx = PRECEDENCE_INDEX[entry.source];
    if (idx < lastIndex) {
      issueAt(
        ctx,
        ['applied', i, 'source'],
        `applied entry '${entry.source}' at index ${i} is out of precedence order; entries must appear in SELECTION_PRECEDENCE order (default < user-global < project < flow < stage < step < invocation). Two entries with equal precedence (two stages, two steps) are legal and must appear contiguously; a later category cannot precede an earlier one.`,
      );
    } else {
      lastIndex = idx;
    }
    if (!overrideContributes(entry.override)) {
      issueAt(
        ctx,
        ['applied', i, 'override'],
        `applied entry at index ${i} has an empty override (no model, effort, depth, skills operation, or invocation_options); a layer that contributes nothing must NOT appear in the applied chain (ghost provenance)`,
      );
    }
  }
});
export type SelectionResolution = z.infer<typeof SelectionResolution>;
