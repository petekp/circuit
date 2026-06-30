// Cross-Tool Build report schemas.
//
// cross-tool-build codifies a recurring two-tool process: one connector (the
// "doer") authors a proposal, revises it into a comprehensive implementation
// spec, then implements end-to-end and manually tests; a second connector (the
// adversarial "reviewer") reviews the proposal and the spec. The per-step
// worker pin in the schematic routes the doer steps to one connector and the
// review steps to the other, so the cross-tool split is a property of the flow,
// not of operator config.
//
// Like fix-until-green, this flow owns its OWN schema names rather than reusing
// build's. The compose, verification, and report-schema registries are global
// and keyed by schema name, built from every flow package, so reusing another
// flow's name would collide two writers on one key. Its own names keep the flow
// self-contained.
//
// The two review steps share ONE shape (CrossToolBuildReview) registered under
// two schema names — proposal-review and spec-review — because an adversarial
// review of a design doc has the same structure whether the doc is a proposal
// or a spec. The reviews are forward-carry: both verdicts pass the relay check
// and continue, and the verdict + findings are a typed input the next doer step
// consumes (the doer revises against them). The one hard gate is verification.

import { z } from 'zod';
import { VerificationCommand, VerificationResult } from '../../schemas/verification.js';

// The preamble plan: it lifts the verification commands the implementation will
// be checked against into a deliberate, check-able list, resolved from the
// operator's goal. Same shape fix-until-green uses for the same purpose.
export const CrossToolBuildPlan = z
  .object({
    objective: z.string().min(1),
    approach: z.string().min(1),
    verification: z
      .object({
        commands: z.array(VerificationCommand).min(1),
      })
      .strict(),
  })
  .strict();
export type CrossToolBuildPlan = z.infer<typeof CrossToolBuildPlan>;

// The doer's first artifact: a proposal for how to implement the requested
// feature. Deliberately rich so the adversarial review has real surface to
// push on. verdict is the relay pass token.
export const CrossToolBuildProposal = z
  .object({
    verdict: z.literal('accept'),
    summary: z.string().min(1).describe('one-line statement of what this proposal implements'),
    problem: z.string().min(1).describe('the feature or problem this proposal addresses'),
    approach: z.string().min(1).describe('the proposed implementation approach'),
    key_decisions: z
      .array(z.string().min(1))
      .min(1)
      .describe('the notable design decisions and the reasoning behind each'),
    alternatives_considered: z
      .array(z.string().min(1))
      .default([])
      .describe('approaches weighed and set aside, with why'),
    risks: z
      .array(z.string().min(1))
      .default([])
      .describe('known risks or tradeoffs the reviewer should scrutinize'),
    open_questions: z
      .array(z.string().min(1))
      .default([])
      .describe('questions still unresolved, surfaced for the reviewer'),
  })
  .strict();
export type CrossToolBuildProposal = z.infer<typeof CrossToolBuildProposal>;

// The doer's second artifact: a comprehensive implementation spec built from the
// proposal AFTER the proposal review. revisions_from_review records how the
// proposal review's findings were folded in (the doer revises the proposal as
// part of writing the spec, per the operator's process).
export const CrossToolBuildSpec = z
  .object({
    verdict: z.literal('accept'),
    summary: z.string().min(1).describe('one-line statement of what this spec delivers'),
    revisions_from_review: z
      .array(z.string().min(1))
      .default([])
      .describe('how the proposal review findings were addressed in this spec'),
    implementation_steps: z
      .array(z.string().min(1))
      .min(1)
      .describe('the ordered, concrete steps a worker follows to implement the change'),
    files_touched: z
      .array(z.string().min(1))
      .default([])
      .describe('the files the implementation is anticipated to touch'),
    test_plan: z
      .array(z.string().min(1))
      .min(1)
      .describe('how the implementation will be verified, including the manual tests to run'),
    risks: z
      .array(z.string().min(1))
      .default([])
      .describe('known risks or tradeoffs the reviewer should scrutinize'),
  })
  .strict();
export type CrossToolBuildSpec = z.infer<typeof CrossToolBuildSpec>;

// One adversarial finding against a design doc.
export const CrossToolBuildReviewFinding = z
  .object({
    severity: z.enum(['critical', 'high', 'medium', 'low']),
    text: z.string().min(1).describe('the problem, stated plainly'),
    refs: z
      .array(z.string().min(1))
      .default([])
      .describe('section or file references that ground this finding'),
  })
  .strict();
export type CrossToolBuildReviewFinding = z.infer<typeof CrossToolBuildReviewFinding>;

// The adversarial review verdict, shared by the proposal review and the spec
// review. Both verdicts pass the relay check (the review is forward-carry, not a
// blocking gate): 'accept' means the doc is sound, 'revise' means the doer must
// change it in the next step. A 'revise' must name what to fix — an empty
// 'revise' would be an adversarial review with no teeth.
export const CrossToolBuildReview = z
  .object({
    verdict: z.enum(['accept', 'revise']),
    assessment: z.string().min(1).describe('the overall adversarial assessment in plain language'),
    findings: z.array(CrossToolBuildReviewFinding).default([]),
    must_address: z
      .array(z.string().min(1))
      .default([])
      .describe('the specific changes the next step must make before proceeding'),
  })
  .strict()
  .superRefine((review, ctx) => {
    if (
      review.verdict === 'revise' &&
      review.findings.length === 0 &&
      review.must_address.length === 0
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['verdict'],
        message: "a 'revise' verdict must carry at least one finding or must_address entry",
      });
    }
  });
export type CrossToolBuildReview = z.infer<typeof CrossToolBuildReview>;

// Registered under two names: the proposal review and the spec review share one
// shape. The JS identifiers are aliases of the same Zod object; the registry
// keys on the schema NAME, so two report entries point one schema at two names.
export const CrossToolBuildProposalReview = CrossToolBuildReview;
export type CrossToolBuildProposalReview = z.infer<typeof CrossToolBuildProposalReview>;
export const CrossToolBuildSpecReview = CrossToolBuildReview;
export type CrossToolBuildSpecReview = z.infer<typeof CrossToolBuildSpecReview>;

// The doer's final artifact: it implements the spec end-to-end, manually tests,
// and addresses what the manual tests surface. This is the change evidence the
// verification step and the close read.
export const CrossToolBuildImplementation = z
  .object({
    verdict: z.literal('accept'),
    summary: z.string().min(1).describe('what was implemented'),
    changed_files: z
      .array(z.string().min(1).describe('project-relative path'))
      .describe('every file changed; empty only when nothing changed'),
    manual_tests: z
      .array(z.string().min(1))
      .min(1)
      .describe('the manual tests performed and their outcomes'),
    findings_addressed: z
      .array(z.string().min(1))
      .default([])
      .describe('issues found during manual testing and how each was addressed'),
    evidence: z
      .array(z.string().min(1))
      .min(1)
      .describe('verification or implementation evidence backing the change'),
  })
  .strict();
export type CrossToolBuildImplementation = z.infer<typeof CrossToolBuildImplementation>;

// The verification result is the canonical command-list shape (the same Build
// emits); overall_status is the automated proof the close gate reads.
export const CrossToolBuildVerification = VerificationResult;
export type CrossToolBuildVerification = z.infer<typeof CrossToolBuildVerification>;

// A pointer to one report file the operator can open.
const CrossToolBuildResultLink = z
  .object({
    label: z.string().min(1),
    path: z.string().min(1),
  })
  .strict();

// The flow's final result. outcome is 'complete' only when the automated
// verification passed; the two review verdicts are carried for transparency
// (a 'revise' is expected and fine — the doer revised against it downstream),
// not as blockers.
export const CrossToolBuildResult = z
  .object({
    summary: z.string().min(1),
    outcome: z.enum(['complete', 'needs_attention', 'failed']),
    verification_status: z.enum(['passed', 'failed']),
    proposal_review_verdict: z.enum(['accept', 'revise']),
    spec_review_verdict: z.enum(['accept', 'revise']),
    evidence_links: z.array(CrossToolBuildResultLink).min(1),
  })
  .strict()
  .superRefine((result, ctx) => {
    if (result.outcome === 'complete' && result.verification_status !== 'passed') {
      ctx.addIssue({
        code: 'custom',
        path: ['verification_status'],
        message: "verification_status must be 'passed' when outcome is 'complete'",
      });
    }
  });
export type CrossToolBuildResult = z.infer<typeof CrossToolBuildResult>;
