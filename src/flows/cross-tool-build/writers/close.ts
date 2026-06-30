// Cross-Tool Build close-with-evidence builder.
//
// Reads the implementation, the automated verification, and both adversarial
// review verdicts, then emits cross-tool-build.result@v1. The outcome is
// 'complete' only when the verification passed; the two review verdicts are
// carried into the result for transparency, not as blockers (a 'revise' is
// expected — the doer revised against it in the next step). The evidence links
// point at every report the run produced so the operator can open them.

import type { CloseBuildContext, CloseBuilder } from '../../registries/close-writers/types.js';
import { reportPathForSchemaInRuntimeFlow } from '../../registries/runtime-index.js';
import {
  CrossToolBuildImplementation,
  CrossToolBuildProposalReview,
  CrossToolBuildResult,
  CrossToolBuildSpecReview,
  CrossToolBuildVerification,
} from '../reports.js';

// Every report the run links from the result, in run order. Each is produced by
// a step, so its path resolves through the runtime report index.
const EVIDENCE_POINTERS = [
  { label: 'Proposal', schema: 'cross-tool-build.proposal@v1' },
  { label: 'Proposal review', schema: 'cross-tool-build.proposal-review@v1' },
  { label: 'Implementation spec', schema: 'cross-tool-build.spec@v1' },
  { label: 'Spec review', schema: 'cross-tool-build.spec-review@v1' },
  { label: 'Implementation', schema: 'cross-tool-build.implementation@v1' },
  { label: 'Verification', schema: 'cross-tool-build.verification@v1' },
] as const;

export const crossToolBuildCloseBuilder: CloseBuilder = {
  resultSchemaName: 'cross-tool-build.result@v1',
  reads: [
    { name: 'implementation', schema: 'cross-tool-build.implementation@v1', required: true },
    { name: 'verification', schema: 'cross-tool-build.verification@v1', required: true },
    { name: 'proposal_review', schema: 'cross-tool-build.proposal-review@v1', required: true },
    { name: 'spec_review', schema: 'cross-tool-build.spec-review@v1', required: true },
  ],
  build(context: CloseBuildContext): unknown {
    const implementation = CrossToolBuildImplementation.parse(context.inputs.implementation);
    const verification = CrossToolBuildVerification.parse(context.inputs.verification);
    const proposalReview = CrossToolBuildProposalReview.parse(context.inputs.proposal_review);
    const specReview = CrossToolBuildSpecReview.parse(context.inputs.spec_review);

    const verificationStatus = verification.overall_status === 'passed' ? 'passed' : 'failed';
    const outcome = verificationStatus === 'passed' ? 'complete' : 'needs_attention';

    return CrossToolBuildResult.parse({
      summary: implementation.summary,
      outcome,
      verification_status: verificationStatus,
      proposal_review_verdict: proposalReview.verdict,
      spec_review_verdict: specReview.verdict,
      evidence_links: EVIDENCE_POINTERS.map((pointer) => ({
        label: pointer.label,
        path: reportPathForSchemaInRuntimeFlow(context.flow, pointer.schema),
      })),
    });
  },
};
