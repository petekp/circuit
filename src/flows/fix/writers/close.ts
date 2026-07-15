// Fix close-with-evidence builder.
//
// Reads brief + context + diagnosis + regression-proof + baseline-snapshot +
// change + verification + regression-rerun + final-change-set (all required) plus
// review (optional — lite mode skips review via route_overrides).
//
// All outcome and pillar-status logic lives in `projectFixResult`. This
// writer is a thin orchestrator: parse inputs, build evidence pointers from
// compiled-flow context, hand the projector everything it needs. Drift
// between the result and its evidence is impossible because there is only
// one place that decides what 'fixed', 'partial', 'not-reproduced', and
// 'failed' mean.

import type { CloseBuildContext, CloseBuilder } from '../../registries/close-writers/types.js';
import { reportPathForSchemaInRuntimeFlow } from '../../registries/runtime-index.js';
import {
  FixBaselineSnapshot,
  FixBrief,
  FixChange,
  FixContext,
  FixDiagnosis,
  FixFinalChangeSet,
  FixRegressionProof,
  FixRegressionRerun,
  type FixResultReportPointer,
  FixReview,
  FixVerification,
} from '../reports.js';
import { projectFixResult } from './result-projection.js';

const REQUIRED_POINTERS = [
  { report_id: 'fix.brief', schema: 'fix.brief@v1' },
  { report_id: 'fix.context', schema: 'fix.context@v1' },
  { report_id: 'fix.diagnosis', schema: 'fix.diagnosis@v1' },
  { report_id: 'fix.regression-proof', schema: 'fix.regression-proof@v1' },
  { report_id: 'fix.baseline-snapshot', schema: 'fix.baseline-snapshot@v1' },
  { report_id: 'fix.change', schema: 'fix.change@v1' },
  { report_id: 'fix.verification', schema: 'fix.verification@v1' },
  { report_id: 'fix.regression-rerun', schema: 'fix.regression-rerun@v1' },
  { report_id: 'fix.change-set', schema: 'fix.change-set@v1' },
  { report_id: 'fix.final-change-set', schema: 'fix.final-change-set@v1' },
] as const;

const OPTIONAL_REVIEW_POINTER = {
  report_id: 'fix.review',
  schema: 'fix.review@v1',
} as const;

export const fixCloseBuilder: CloseBuilder = {
  resultSchemaName: 'fix.result@v1',
  reads: [
    { name: 'brief', schema: 'fix.brief@v1', required: true },
    { name: 'context', schema: 'fix.context@v1', required: true },
    { name: 'diagnosis', schema: 'fix.diagnosis@v1', required: true },
    { name: 'regression', schema: 'fix.regression-proof@v1', required: true },
    { name: 'baseline_snapshot', schema: 'fix.baseline-snapshot@v1', required: true },
    { name: 'change', schema: 'fix.change@v1', required: true },
    { name: 'verification', schema: 'fix.verification@v1', required: true },
    { name: 'regression_rerun', schema: 'fix.regression-rerun@v1', required: true },
    { name: 'change_set', schema: 'fix.final-change-set@v1', required: true },
    { name: 'review', schema: 'fix.review@v1', required: false },
  ],
  build(context: CloseBuildContext): unknown {
    const brief = FixBrief.parse(context.inputs.brief);
    FixContext.parse(context.inputs.context);
    const diagnosis = FixDiagnosis.parse(context.inputs.diagnosis);
    const regression = FixRegressionProof.parse(context.inputs.regression);
    FixBaselineSnapshot.parse(context.inputs.baseline_snapshot);
    const change = FixChange.parse(context.inputs.change);
    const verification = FixVerification.parse(context.inputs.verification);
    const regressionRerun = FixRegressionRerun.parse(context.inputs.regression_rerun);
    const changeSet = FixFinalChangeSet.parse(context.inputs.change_set);
    const review =
      context.inputs.review === undefined ? undefined : FixReview.parse(context.inputs.review);

    const pointers: FixResultReportPointer[] = REQUIRED_POINTERS.map((p) => ({
      report_id: p.report_id,
      schema: p.schema,
      path: reportPathForSchemaInRuntimeFlow(context.flow, p.schema),
    }));
    if (review !== undefined) {
      pointers.push({
        report_id: OPTIONAL_REVIEW_POINTER.report_id,
        schema: OPTIONAL_REVIEW_POINTER.schema,
        path: reportPathForSchemaInRuntimeFlow(context.flow, OPTIONAL_REVIEW_POINTER.schema),
      });
    }

    return projectFixResult({
      brief,
      diagnosis,
      regression,
      regression_rerun: regressionRerun,
      change,
      change_set: changeSet,
      verification,
      ...(review === undefined ? {} : { review }),
      ...(review === undefined && context.closeStep.id === 'fix-close'
        ? {
            review_skip_reason:
              'Reviewer connector failed after proof passed; Fix closed with regression, verification, and change-set evidence.',
          }
        : {}),
      evidence_links: pointers,
    });
  },
};
