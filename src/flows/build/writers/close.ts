// Build close-with-evidence builder.
//
// Reads brief + plan + implementation + verification + review and emits
// build.result@v1 with verification_status, review_verdict, scope, summary,
// and the canonical pointer set. Outcome is 'complete' only when verification
// passed, review accepted, and the reviewer's alignment covered every
// plan-declared guardrail with no violation or scope creep; accepted
// follow-ups and any scope gap need attention. The plan is parsed and passed
// so the projector can reconcile declared guardrails against the alignment.
//
// The review and touch-area reads are optional. Build's own full flow always
// runs both steps, so for build the close behaves exactly as before. A
// whole-grain (folded) build-derived flow drops the review and touch-area
// steps; the close writer then receives neither report, drops the absent
// review pointer from the evidence links, and lets the projector mark both
// aspects "not assessed" rather than fabricate a pass.

import type { CloseBuildContext, CloseBuilder } from '../../registries/close-writers/types.js';
import { reportPathForSchemaInRuntimeFlow } from '../../registries/runtime-index.js';
import {
  BuildBrief,
  BuildImplementation,
  BuildPlan,
  BuildReview,
  BuildTouchArea,
  BuildVerification,
} from '../reports.js';
import { projectBuildResult } from './result-projection.js';

// The four reports every grain produces, always linked. 'build.review' is added
// only when the review report is present (see build()), so a folded flow that
// ran no review carries the four-link set without a fabricated review pointer.
const ALWAYS_PRESENT_POINTERS = [
  { report_id: 'build.brief', schema: 'build.brief@v1' },
  { report_id: 'build.plan', schema: 'build.plan@v1' },
  { report_id: 'build.implementation', schema: 'build.implementation@v1' },
  { report_id: 'build.verification', schema: 'build.verification@v1' },
] as const;

const REVIEW_POINTER = { report_id: 'build.review', schema: 'build.review@v1' } as const;

export const buildCloseBuilder: CloseBuilder = {
  resultSchemaName: 'build.result@v1',
  reads: [
    { name: 'brief', schema: 'build.brief@v1', required: true },
    { name: 'plan', schema: 'build.plan@v1', required: true },
    { name: 'implementation', schema: 'build.implementation@v1', required: true },
    { name: 'verification', schema: 'build.verification@v1', required: true },
    // Optional so a folded flow with no review/touch-area step still closes.
    // resolveCloseReadPaths resolves these normally when the flow declares the
    // writer (build's full flow), so build's inputs are byte-identical; it
    // returns undefined only when no step writes the schema at all.
    { name: 'review', schema: 'build.review@v1', required: false },
    { name: 'touch_area', schema: 'build.touch-area@v1', required: false },
  ],
  build(context: CloseBuildContext): unknown {
    const brief = BuildBrief.parse(context.inputs.brief);
    const plan = BuildPlan.parse(context.inputs.plan);
    const implementation = BuildImplementation.parse(context.inputs.implementation);
    const verification = BuildVerification.parse(context.inputs.verification);
    const review =
      context.inputs.review === undefined ? undefined : BuildReview.parse(context.inputs.review);
    const touchArea =
      context.inputs.touch_area === undefined
        ? undefined
        : BuildTouchArea.parse(context.inputs.touch_area);

    // The review pointer is added only when the review report exists. Resolving
    // its path otherwise would throw (no writer for the schema), so dropping it
    // here keeps the folded flow from looking up a report that was never
    // produced.
    const pointers =
      review === undefined ? ALWAYS_PRESENT_POINTERS : [...ALWAYS_PRESENT_POINTERS, REVIEW_POINTER];

    return projectBuildResult({
      brief,
      plan,
      implementation,
      verification,
      ...(review === undefined ? {} : { review }),
      ...(touchArea === undefined ? {} : { touchArea }),
      evidenceLinks: pointers.map((p) => ({
        ...p,
        path: reportPathForSchemaInRuntimeFlow(context.flow, p.schema),
      })),
    });
  },
};
