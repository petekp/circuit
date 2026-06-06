import { z } from 'zod';
import { InvocationId, RunId, StageId, StepId } from './ids.js';
import { ControlPlaneFileStem } from './scalars.js';
import { SnapshotStatus } from './snapshot.js';

/**
 * Continuity surfaces — see docs/contracts/continuity.md.
 *
 * Two reports — `continuity.record` and `continuity.index` — describe
 * a saved cross-session resume point. `record_id` is a path-derived
 * field, so it uses ControlPlaneFileStem (see ./scalars.ts).
 *
 * All ZodObjects below use `.strict()` to reject surplus keys at parse
 * time, both on outer records and on every nested object (resume_contract,
 * run_ref provenance, and the index pointers).
 */

export const GitState = z
  .object({
    cwd: z.string().min(1),
    branch: z.string().optional(),
    head: z.string().optional(),
    base_commit: z.string().optional(),
  })
  .strict();
export type GitState = z.infer<typeof GitState>;

export const ContinuityNarrative = z
  .object({
    goal: z.string().min(1),
    next: z.string().min(1),
    state_markdown: z.string().min(1),
    debt_markdown: z.string().min(1),
  })
  .strict();
export type ContinuityNarrative = z.infer<typeof ContinuityNarrative>;

/**
 * Run-attached resume provenance. When a continuity record is saved
 * against a live run, the record must capture enough state at save time
 * for resume adjudication to be auditable. `run_id` alone is insufficient
 * — resume needs to compare "what was true at save time" vs "what is true
 * now".
 */
export const RunAttachedProvenance = z
  .object({
    run_id: RunId,
    invocation_id: InvocationId.optional(),
    current_stage: StageId,
    current_step: StepId,
    runtime_status: SnapshotStatus,
    runtime_updated_at: z.string().datetime(),
  })
  .strict();
export type RunAttachedProvenance = z.infer<typeof RunAttachedProvenance>;

/**
 * Ambient-capture provenance. Ambient records are harvested mechanically by
 * a Stop/SessionEnd hook from the live transcript — not written by a
 * deliberate `circuit handoff save`. This block records where the capture
 * came from so resume adjudication can weigh it against a manual save and an
 * operator can audit it. `transcript_path` points back to the full history;
 * `session_id` is the harvesting session; `source` names the hook that fired.
 */
export const AmbientProvenance = z
  .object({
    session_id: z.string().min(1).optional(),
    transcript_path: z.string().min(1),
    source: z.enum(['stop', 'session-end']),
  })
  .strict();
export type AmbientProvenance = z.infer<typeof AmbientProvenance>;

/**
 * Non-contradiction between `auto_resume` and `requires_explicit_resume`.
 * Exactly one must be true. Both-true means "auto-resume AND require
 * explicit resume" — incoherent. Both-false means neither resume path is
 * armed and leaves the record silently dead.
 */
const resumeContractRefine = <
  T extends { auto_resume: boolean; requires_explicit_resume: boolean },
>(
  v: T,
) => v.auto_resume !== v.requires_explicit_resume;

const resumeContractRefineMessage = {
  message: 'auto_resume and requires_explicit_resume are contradictory: exactly one must be true',
} as const;

const StandaloneResumeContract = z
  .object({
    mode: z.literal('resume_standalone'),
    auto_resume: z.boolean(),
    requires_explicit_resume: z.boolean(),
  })
  .strict()
  .refine(resumeContractRefine, resumeContractRefineMessage);

const RunBackedResumeContract = z
  .object({
    mode: z.literal('resume_run'),
    auto_resume: z.boolean(),
    requires_explicit_resume: z.boolean(),
  })
  .strict()
  .refine(resumeContractRefine, resumeContractRefineMessage);

const AmbientResumeContract = z
  .object({
    mode: z.literal('resume_ambient'),
    auto_resume: z.boolean(),
    requires_explicit_resume: z.boolean(),
  })
  .strict()
  .refine(resumeContractRefine, resumeContractRefineMessage);

const ContinuityBase = z.object({
  schema_version: z.literal(1),
  record_id: ControlPlaneFileStem,
  project_root: z.string().min(1),
  created_at: z.string().datetime(),
  git: GitState,
  narrative: ContinuityNarrative,
});

export const StandaloneContinuity = ContinuityBase.extend({
  continuity_kind: z.literal('standalone'),
  resume_contract: StandaloneResumeContract,
}).strict();
export type StandaloneContinuity = z.infer<typeof StandaloneContinuity>;

export const RunBackedContinuity = ContinuityBase.extend({
  continuity_kind: z.literal('run-backed'),
  run_ref: RunAttachedProvenance,
  resume_contract: RunBackedResumeContract,
}).strict();
export type RunBackedContinuity = z.infer<typeof RunBackedContinuity>;

/**
 * Ambient continuity — a mechanically harvested cross-session resume point.
 * Reuses the same narrative shape as a manual save so the brief renderer is
 * uniform, but is discriminated by `continuity_kind: 'ambient'` and carries
 * `ambient_provenance` instead of `run_ref`. A manual save outranks an
 * ambient record at resume time; the index keeps them in separate pointers
 * so neither writer clobbers the other.
 */
export const AmbientContinuity = ContinuityBase.extend({
  continuity_kind: z.literal('ambient'),
  ambient_provenance: AmbientProvenance,
  resume_contract: AmbientResumeContract,
}).strict();
export type AmbientContinuity = z.infer<typeof AmbientContinuity>;

/**
 * Raw-input own-property guard. `.strict()` rejects surplus own keys but
 * does NOT defend against prototype-chain smuggle: Zod reads inherited
 * properties during parse, so `Object.create({record_id: 'evil'})` would
 * satisfy a `record_id` requirement through the prototype. This guard
 * runs on the raw input before Zod's property access, requiring identity
 * fields to be own properties. Mirrors the same defense in run.ts.
 */
const recordOwnPropertyGuard = z.custom<unknown>((raw) => {
  if (raw === null || typeof raw !== 'object') return true;
  const guarded = ['schema_version', 'record_id', 'continuity_kind', 'resume_contract'] as const;
  for (const f of guarded) if (!Object.hasOwn(raw, f)) return false;
  return true;
}, 'continuity record has inherited (not own) identity/discriminator field; prototype-chain smuggle rejected');

/**
 * ContinuityRecord is a discriminated union on `continuity_kind`.
 * Standalone records reject `run_ref` (enforced by `.strict()`);
 * run-backed records require it. `resume_contract.mode` is bound to
 * `continuity_kind` via the per-variant literal. The outer pipeline
 * prepends an own-property guard before the discriminated union.
 */
export const ContinuityRecord = recordOwnPropertyGuard.pipe(
  z.discriminatedUnion('continuity_kind', [
    StandaloneContinuity,
    RunBackedContinuity,
    AmbientContinuity,
  ]),
);
export type ContinuityRecord = z.infer<typeof ContinuityRecord>;

/**
 * ContinuityIndex aggregate. The index resolves which continuity record
 * is authoritative for resume. Three orthogonal pointers:
 *   - `pending_record`: a deliberate manual save, by `record_id`; null when
 *     no record is pending.
 *   - `current_run`: by `run_id` plus the at-attach stage/step snapshot;
 *     null when no run is attached.
 *   - `ambient_record`: a mechanically harvested ambient record, by
 *     `record_id`; absent/null when nothing has been harvested. Kept
 *     separate from `pending_record` so a manual save and an auto-harvest
 *     never overwrite each other.
 *
 * Pointers may be simultaneously populated, simultaneously null, or mixed.
 * Resume semantics (which pointer wins when several are set — a manual
 * `pending_record` outranks `ambient_record`) is a resolver-level concern,
 * not a schema invariant.
 */
export const PendingRecordPointer = z
  .object({
    record_id: ControlPlaneFileStem,
    continuity_kind: z.union([z.literal('standalone'), z.literal('run-backed')]),
    created_at: z.string().datetime(),
  })
  .strict();
export type PendingRecordPointer = z.infer<typeof PendingRecordPointer>;

export const AttachedRunPointer = z
  .object({
    run_id: RunId,
    current_stage: StageId,
    current_step: StepId,
    runtime_status: SnapshotStatus,
    attached_at: z.string().datetime(),
    last_validated_at: z.string().datetime(),
  })
  .strict();
export type AttachedRunPointer = z.infer<typeof AttachedRunPointer>;

/**
 * Ambient-record pointer. The index keeps the harvested ambient record in
 * its own pointer, orthogonal to `pending_record` (manual saves) and
 * `current_run`. Resume prefers a manual `pending_record`; the ambient
 * pointer is the fallback safety net. Optional/absent on pre-ambient
 * indexes, so older index files keep parsing.
 */
export const AmbientRecordPointer = z
  .object({
    record_id: ControlPlaneFileStem,
    continuity_kind: z.literal('ambient'),
    created_at: z.string().datetime(),
  })
  .strict();
export type AmbientRecordPointer = z.infer<typeof AmbientRecordPointer>;

const ContinuityIndexBody = z
  .object({
    schema_version: z.literal(1),
    project_root: z.string().min(1),
    pending_record: PendingRecordPointer.nullable(),
    current_run: AttachedRunPointer.nullable(),
    ambient_record: AmbientRecordPointer.nullable().optional(),
  })
  .strict();

/**
 * Own-property guard applied to the index aggregate. Required fields
 * must be own properties on the raw input. Nullable fields still
 * require the key to be own (value may be null).
 */
const indexOwnPropertyGuard = z.custom<unknown>((raw) => {
  if (raw === null || typeof raw !== 'object') return true;
  const guarded = ['schema_version', 'project_root', 'pending_record', 'current_run'] as const;
  for (const f of guarded) if (!Object.hasOwn(raw, f)) return false;
  return true;
}, 'continuity index has inherited (not own) required field; prototype-chain smuggle rejected');

export const ContinuityIndex = indexOwnPropertyGuard.pipe(ContinuityIndexBody);
export type ContinuityIndex = z.infer<typeof ContinuityIndex>;
