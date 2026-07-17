// Explainer (paper-to-site) flow report contracts.
//
// One `.strict()` Zod body per `explainer.<name>@v1` contract. The
// describe-light shapes here mirror the explore/goal house style: compose
// reports are produced by deterministic writers (writers/), relay reports are
// produced by a connector-bound worker and guided by relay-hints.ts, and the
// tournament aggregate is written by the engine's fanout join (so its shape is
// copied verbatim from explore's proven aggregate, only swapping option_id for
// concept_id).
//
// The flow encodes the operator's real research-paper -> interactive-site
// pipeline: a lossless ("unsummarizable") digest, persona-lensed ideation, a
// six-criteria tournament, an adversarial fidelity hardening pass, an operator
// pick, a house-style spec, a child build run, verification, an operator
// sign-off, and a close. See docs/ideas/paper-to-site-flow-brief.md.

import { z } from 'zod';
import { CheckpointReviewComment } from '../../schemas/checkpoint-review-response.js';
import { RubricJudgment, RubricResult } from '../../schemas/rubric.js';

// The operator's six selection criteria. These ARE the rubric dims the
// tournament fanout ranks branches on (ordered_dims in data.ts). Rubric dim
// ids are free-form in the engine (RubricResult.dims is a string-keyed
// record), so the operator's real vocabulary travels straight through.
export const EXPLAINER_RUBRIC_DIMS = [
  'fidelity',
  'memetic_potential',
  'entertainment',
  'cross_audience_reach',
  'build_feasibility',
  'novelty',
] as const;

const CONCEPT_ID = z
  .string()
  .regex(/^concept-[0-9]+$/, { message: 'concept id must be concept-<n>' });

// 1. intake (compose) — frame the run: subject, source paper, house-style
// references, and the success condition. Deterministic projection of the goal.
export const ExplainerIntake = z
  .object({
    subject: z.string().min(1).describe('the paper or topic being explained'),
    paper_reference: z
      .string()
      .min(1)
      .describe('how to locate the source paper/outline for this run'),
    house_style_references: z
      .array(z.string().min(1))
      .min(1)
      .describe('operator house-style spec files the build must honor'),
    success_condition: z
      .string()
      .min(1)
      .describe('what a faithful, shippable explainer site must satisfy'),
  })
  .strict();
export type ExplainerIntake = z.infer<typeof ExplainerIntake>;

// 2. digest (compose) — the "unsummarizable" lossless outline. A scaffold in
// v1 (deterministic): the principle plus the row/section shape the operator
// fills from the real paper. Promoting this to a model-authored relay is the
// primary enrichment.
export const ExplainerNotationRow = z
  .object({
    symbol: z.string().min(1),
    name: z.string().min(1),
    definition: z.string().min(1),
    role: z.string().min(1),
  })
  .strict();
export type ExplainerNotationRow = z.infer<typeof ExplainerNotationRow>;

export const ExplainerOutlineSection = z
  .object({
    section_id: z.string().min(1).describe('addressable line id, e.g. O:40'),
    title: z.string().min(1),
    load_bearing_points: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type ExplainerOutlineSection = z.infer<typeof ExplainerOutlineSection>;

export const ExplainerDigest = z
  .object({
    subject: z.string().min(1),
    lossless_principle: z
      .string()
      .min(1)
      .describe('the rule the digest obeys: dense, addressable, teaches the real driver'),
    notation_rows: z
      .array(ExplainerNotationRow)
      .min(1)
      .describe('one row per symbol, lookup-not-narrative'),
    outline_sections: z
      .array(ExplainerOutlineSection)
      .min(1)
      .describe('dense bullet stacks, every line load-bearing'),
  })
  .strict();
export type ExplainerDigest = z.infer<typeof ExplainerDigest>;

// 3. ideas (compose) — N scoped concepts to fan the tournament out over, one
// per persona lens. Sized from axes.tournament_n.
export const ExplainerConcept = z
  .object({
    id: CONCEPT_ID,
    label: z.string().min(1),
    summary: z.string().min(1),
    lens: z.string().min(1).describe('the persona lens this concept is conceived through'),
    scoped_prompt: z
      .string()
      .min(1)
      .describe('best-case advocacy instruction handed to this branch relay'),
    fidelity_anchor: z
      .string()
      .min(1)
      .describe('outline citation (O:N) this concept must stay faithful to'),
  })
  .strict();
export type ExplainerConcept = z.infer<typeof ExplainerConcept>;

export const ExplainerIdeas = z
  .object({
    brief_question: z.string().min(1),
    concepts: z.array(ExplainerConcept).min(1),
  })
  .strict()
  .superRefine((report, ctx) => {
    const seen = new Set<string>();
    for (const [index, concept] of report.concepts.entries()) {
      if (seen.has(concept.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['concepts', index, 'id'],
          message: `duplicate concept id '${concept.id}'`,
        });
      }
      seen.add(concept.id);
    }
  });
export type ExplainerIdeas = z.infer<typeof ExplainerIdeas>;

// The six-criteria self-judgment every tournament branch reports. Runtime
// signals (declared in the fanout rubric) may veto a dim regardless of the
// model's self-score.
export const ExplainerRubricModelJudgments = z
  .object({
    fidelity: RubricJudgment,
    memetic_potential: RubricJudgment,
    entertainment: RubricJudgment,
    cross_audience_reach: RubricJudgment,
    build_feasibility: RubricJudgment,
    novelty: RubricJudgment,
  })
  .strict();
export type ExplainerRubricModelJudgments = z.infer<typeof ExplainerRubricModelJudgments>;

// 4a. tournament-proposal (relay) — the per-branch advocate report. One relay
// per concept argues the strongest evidence-backed case for THAT concept.
export const ExplainerTournamentProposal = z
  .object({
    verdict: z.literal('accept'),
    concept_id: CONCEPT_ID.describe('the branch concept id named in the step title'),
    concept_label: z.string().min(1),
    case_summary: z.string().min(1).describe('strongest evidence-backed case for THIS concept'),
    fidelity_evidence: z
      .array(z.string().min(1))
      .min(1)
      .describe('O:N / outline citations proving it teaches the right driver'),
    risks: z.array(z.string().min(1)),
    next_action: z.string().min(1),
    rubric_model_judgments: ExplainerRubricModelJudgments,
  })
  .strict();
export type ExplainerTournamentProposal = z.infer<typeof ExplainerTournamentProposal>;

// 4b. tournament-aggregate (report, engine-written by the fanout join). Shape
// copied from explore's proven ExploreTournamentAggregate so the engine's
// aggregate validates; result_body is the explainer proposal.
export const ExplainerTournamentAggregateBranch = z
  .object({
    branch_id: z.string().min(1),
    child_run_id: z.string().min(1),
    child_outcome: z.enum(['complete', 'aborted', 'handoff', 'stopped', 'escalated']),
    verdict: z.string().min(1),
    admitted: z.boolean(),
    result_path: z.string().min(1),
    duration_ms: z.number().nonnegative(),
    result_body: ExplainerTournamentProposal.optional(),
    rubric_result: RubricResult.optional(),
  })
  .strict();
export type ExplainerTournamentAggregateBranch = z.infer<typeof ExplainerTournamentAggregateBranch>;

export const ExplainerTournamentAggregate = z
  .object({
    schema_version: z.literal(1),
    join_policy: z.literal('aggregate-survivors'),
    branch_count: z.number().int().positive(),
    branches: z.array(ExplainerTournamentAggregateBranch).min(1),
  })
  .strict()
  .superRefine((aggregate, ctx) => {
    if (aggregate.branch_count !== aggregate.branches.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['branch_count'],
        message: 'branch_count must match branches.length',
      });
    }
    for (const [index, branch] of aggregate.branches.entries()) {
      if (branch.child_outcome === 'complete' && branch.result_body === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['branches', index, 'result_body'],
          message: 'complete tournament branches must include result_body provenance',
        });
      }
      if (branch.child_outcome === 'complete' && branch.rubric_result === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['branches', index, 'rubric_result'],
          message: 'complete tournament branches must include rubric_result provenance',
        });
      }
      if (
        branch.child_outcome === 'complete' &&
        branch.result_body !== undefined &&
        branch.result_body.concept_id !== branch.branch_id
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['branches', index, 'result_body', 'concept_id'],
          message: `branch_id '${branch.branch_id}' must match result_body.concept_id '${branch.result_body.concept_id}'`,
        });
      }
    }
  });
export type ExplainerTournamentAggregate = z.infer<typeof ExplainerTournamentAggregate>;

// 5. hardening (relay) — adversarial fidelity pass over the survivors. The
// danger protagonist is always the seductive wrong driver; the reviewer blocks
// if any concept teaches it.
export const ExplainerBannedPhraseFinding = z
  .object({
    phrase: z.string().min(1),
    present: z.boolean(),
    note: z.string().min(1).describe('why this phrase is a fidelity risk, with an O:N anchor'),
  })
  .strict();
export type ExplainerBannedPhraseFinding = z.infer<typeof ExplainerBannedPhraseFinding>;

export const ExplainerHardening = z
  .object({
    verdict: z.enum(['recommend', 'no-clear-winner', 'needs-operator']),
    recommended_concept_id: z.string().min(1).nullable(),
    teaches_right_driver: z
      .boolean()
      .describe('does the recommended concept foreground the actual driver, not the seductive one'),
    banned_phrase_findings: z.array(ExplainerBannedPhraseFinding),
    objections: z.array(z.string().min(1)),
    confidence: z.enum(['low', 'medium', 'high']),
  })
  .strict();
export type ExplainerHardening = z.infer<typeof ExplainerHardening>;

// 7. spec (compose) — build-ready design law assembled from the winning
// concept plus the operator house-style files.
export const ExplainerSpec = z
  .object({
    concept_id: z.string().min(1),
    concept_label: z.string().min(1),
    visual_system: z.string().min(1).describe('design-token direction from VISUAL_SYSTEM.md'),
    motion_architecture: z.string().min(1).describe('motion direction from MOTION_ARCHITECTURE.md'),
    copy_deck: z.string().min(1).describe('voice and copy direction from COPY_DECK.md'),
    fidelity_citations: z
      .array(z.string().min(1))
      .min(1)
      .describe('VERIFIED vs O:N tagged claims the build must not violate'),
    build_brief: z.string().min(1).describe('the goal string handed to the build sub-run'),
  })
  .strict();
export type ExplainerSpec = z.infer<typeof ExplainerSpec>;

// 9. verification (verification) — mechanical proof of the built site.
export const ExplainerVerificationCommand = z
  .object({
    id: z.string().min(1),
    status: z.enum(['passed', 'failed']),
    exit_code: z.number().int(),
    stdout_summary: z.string(),
    stderr_summary: z.string(),
  })
  .strict();
export type ExplainerVerificationCommand = z.infer<typeof ExplainerVerificationCommand>;

export const ExplainerVerification = z
  .object({
    overall_status: z.enum(['passed', 'failed']),
    commands: z.array(ExplainerVerificationCommand).min(1),
  })
  .strict();
export type ExplainerVerification = z.infer<typeof ExplainerVerification>;

// 11. result (close) — the primary result. Honest outcome bound to the close.
export const ExplainerResult = z
  .object({
    outcome: z.enum(['complete', 'blocked', 'stopped']).describe('honest run outcome'),
    summary: z.string().min(1),
    shipped_concept_id: z.string().min(1).nullable(),
    evidence_pointers: z.array(z.string().min(1)).min(1),
    residual_risks: z.array(z.string().min(1)),
  })
  .strict();
export type ExplainerResult = z.infer<typeof ExplainerResult>;

// Checkpoint response body (engine-written). Both operator checkpoints — the
// concept PICK and the publish SIGN-OFF — resolve the human-decision block, whose
// output_contract decision.answer@v1 this flow aliases to two actuals
// (explainer.selection@v1, explainer.signoff@v1). The checkpoint executor writes
// this exact shape to each step's response file (src/runtime/executors/checkpoint.ts).
// Registering it as the body behind BOTH actuals lets the multi-actual
// body-divergence probe prove the two checkpoints share one shape (uniform)
// instead of leaving them unresolved. auto_resolution is left engine-typed
// (present only on an auto-resolved checkpoint) rather than re-authored here.
export const ExplainerCheckpointResponse = z
  .object({
    schema_version: z.literal(1),
    step_id: z.string().min(1),
    selection: z.string().min(1),
    route_id: z.string().min(1),
    resolution_source: z.string().min(1),
    comments: z.array(CheckpointReviewComment).max(24).optional(),
    auto_resolution: z.unknown().optional(),
  })
  .strict();
export type ExplainerCheckpointResponse = z.infer<typeof ExplainerCheckpointResponse>;
