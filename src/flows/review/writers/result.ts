// Review result compose writer.
//
// Reads the audit fan-out's aggregate — one file carrying every unit
// reviewer's verdict body, plus the fact of any unit whose reviewer produced
// none — and merges it into the canonical ReviewResult report. Most targets
// are a single unit, so the common case is one body in, one review out; a
// split target merges several, and says so.

import { readFileSync } from 'node:fs';
import { resolveRunRelative } from '../../../shared/run-relative-path.js';
import type {
  ComposeBuildContext,
  ComposeBuilder,
} from '../../registries/compose-writers/types.js';
import type {
  RuntimeIndexedComposeStep,
  RuntimeIndexedFanoutStep,
  RuntimeIndexedFlow,
} from '../../registries/runtime-index.js';
import { ReviewAuditAggregate, ReviewIntake } from '../reports.js';
import { projectReviewResult } from './result-projection.js';
import { mergeReviewUnits } from './unit-merge.js';

/**
 * Where the audit step's joined aggregate lands for the close step to read.
 *
 * The aggregate is a typed report the engine writes after the last branch
 * joins, so unlike the raw relay result it read before, this path is a
 * declared write and the close step's read of it is checked here rather than
 * assumed.
 */
function reviewAuditAggregatePath(
  flow: RuntimeIndexedFlow,
  closeStep: ComposeBuildContext['step'],
): string {
  const closeStepId = closeStep.id as unknown as string;
  const audits = flow.steps.filter(
    (candidate): candidate is RuntimeIndexedFanoutStep =>
      candidate.kind === 'fanout' && (candidate.routes.pass as unknown as string) === closeStepId,
  );
  if (audits.length !== 1) {
    throw new Error(
      `review.result@v1 requires exactly one audit fan-out routing to '${closeStepId}', found ${audits.length}`,
    );
  }
  // A fan-out writes its joined report under `aggregate`, not `report`.
  const reportPath = audits[0]?.writes.aggregate;
  const path =
    typeof reportPath === 'string' ? reportPath : (reportPath?.path as string | undefined);
  if (path === undefined || !closeStep.reads.includes(path as never)) {
    throw new Error(
      `review.result@v1 requires close step '${closeStepId}' to read the audit aggregate at '${path ?? '<missing>'}'`,
    );
  }
  return path;
}

function reviewIntakePath(
  flow: RuntimeIndexedFlow,
  closeStep: ComposeBuildContext['step'],
): string {
  const closeStepId = closeStep.id as unknown as string;
  const intakeStep = flow.steps.find(
    (candidate): candidate is RuntimeIndexedComposeStep =>
      candidate.kind === 'compose' &&
      candidate.writes.report.schema === 'review.intake@v1' &&
      closeStep.reads.includes(candidate.writes.report.path as never),
  );
  const path = intakeStep?.writes.report.path as unknown as string | undefined;
  if (path === undefined) {
    throw new Error(
      `review.result@v1 requires close step '${closeStepId}' to read the review intake report`,
    );
  }
  return path;
}

export const reviewResultComposeBuilder: ComposeBuilder = {
  resultSchemaName: 'review.result@v1',
  // No declarative reads — the read is a relay result body, not a
  // typed report at a schema-mapped path. The build function does
  // its own resolution.
  build(context: ComposeBuildContext): unknown {
    const path = reviewAuditAggregatePath(context.flow, context.step);
    const intake = ReviewIntake.parse(
      JSON.parse(
        readFileSync(
          resolveRunRelative(context.runFolder, reviewIntakePath(context.flow, context.step)),
          'utf8',
        ),
      ),
    );
    const aggregate = ReviewAuditAggregate.parse(
      JSON.parse(readFileSync(resolveRunRelative(context.runFolder, path), 'utf8')),
    );
    const merged = mergeReviewUnits({ intake, aggregate });
    return projectReviewResult({ intake, relayResult: merged.relayResult });
  },
};
