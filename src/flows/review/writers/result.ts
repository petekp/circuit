// Review result compose writer.
//
// Reads the upstream reviewer relay's result body (NOT a typed
// report at a known schema path — this is the relay's
// writes.result file) and lifts findings + verdict into the canonical
// ReviewResult report. This is the one compose writer that does
// not consume a typed report via schema-name lookup; it consumes a
// relay result, so the path resolver is custom.

import { readFileSync } from 'node:fs';
import { resolveRunRelative } from '../../../shared/run-relative-path.js';
import type {
  ComposeBuildContext,
  ComposeBuilder,
} from '../../registries/compose-writers/types.js';
import type {
  RuntimeIndexedComposeStep,
  RuntimeIndexedFlow,
  RuntimeIndexedRelayStep,
} from '../../registries/runtime-index.js';
import { ReviewIntake, ReviewRelayResult } from '../reports.js';
import { projectReviewResult } from './result-projection.js';

/**
 * Where the reviewer's response lands for the close step to read.
 *
 * Prefer the relay step's typed report: when the step declares one, the runtime
 * has already validated the body against `review.verdict@v1` before writing it,
 * and the compiler routes the close step's read there. The raw result path is
 * the fallback for a relay step that declares no report, where the body reaches
 * the close step unvalidated.
 */
function reviewerRelayResultPath(
  flow: RuntimeIndexedFlow,
  closeStep: ComposeBuildContext['step'],
): string {
  const closeStepId = closeStep.id as unknown as string;
  const reviewerRelayes = flow.steps.filter(
    (candidate): candidate is RuntimeIndexedRelayStep =>
      candidate.kind === 'relay' &&
      candidate.role === 'reviewer' &&
      (candidate.routes.pass as unknown as string) === closeStepId,
  );
  if (reviewerRelayes.length !== 1) {
    throw new Error(
      `review.result@v1 requires exactly one reviewer relay routing to '${closeStepId}', found ${reviewerRelayes.length}`,
    );
  }
  const relayWrites = reviewerRelayes[0]?.writes;
  const reportPath = relayWrites?.report?.path as unknown as string | undefined;
  const resultPath = relayWrites?.result as unknown as string | undefined;
  const readable = [reportPath, resultPath].find(
    (candidate): candidate is string =>
      candidate !== undefined && closeStep.reads.includes(candidate as never),
  );
  if (readable === undefined) {
    throw new Error(
      `review.result@v1 requires close step '${closeStepId}' to read the reviewer verdict at '${reportPath ?? resultPath ?? '<missing>'}'`,
    );
  }
  return readable;
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
    const path = reviewerRelayResultPath(context.flow, context.step);
    const intake = ReviewIntake.parse(
      JSON.parse(
        readFileSync(
          resolveRunRelative(context.runFolder, reviewIntakePath(context.flow, context.step)),
          'utf8',
        ),
      ),
    );
    const relayResult = ReviewRelayResult.parse(
      JSON.parse(readFileSync(resolveRunRelative(context.runFolder, path), 'utf8')),
    );
    return projectReviewResult({ intake, relayResult });
  },
};
