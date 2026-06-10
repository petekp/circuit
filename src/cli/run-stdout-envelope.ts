import { join } from 'node:path';

import {
  HISTORY_RECALL_REPORT_PATH,
  type prepareRunStartHistoryRecall,
} from '../app/history/run-start-recall.js';
import type { OperatorSummaryWriteResult } from '../app/operator-summary/writer.js';
import type { LoopResult } from '../app/run-envelope/continuation-loop.js';
import type { WriteRunEnvelopeRecordResult } from '../app/run-envelope/source-record.js';
import type { Axes as AxesValue } from '../schemas/axes.js';
import type { RunResult } from '../schemas/result.js';
import {
  type PostRunArtifactWarning,
  postRunArtifactWarningOutputFields,
} from './post-run-artifacts.js';
import {
  type RouteOutputFieldsInput,
  operatorSummaryOutputFields,
  routeOutputFields,
  runEnvelopeOutputFields,
} from './run-output.js';

// The final stdout envelope for the run/resume execution paths, extracted
// from src/cli/run.ts. composeRunStdoutEnvelope is a pure object composition;
// the caller owns the process.stdout.write + JSON.stringify framing. Key
// order is part of the contract: the JSON written to stdout must stay
// byte-identical, so the spread order below is load-bearing.

export function historyRecallOutputFields(input: {
  readonly runFolder: string;
  readonly report: ReturnType<typeof prepareRunStartHistoryRecall>['report'];
}) {
  return {
    history_recall: {
      status: input.report.status,
      memory_input_count: input.report.memory_input_count,
      report_path: join(input.runFolder, HISTORY_RECALL_REPORT_PATH),
      rebuilt: input.report.rebuilt,
      ...(input.report.index_state === undefined ? {} : { index_state: input.report.index_state }),
      warnings: input.report.warnings.map((warning) => ({
        code: warning.code,
        message: warning.message,
      })),
    },
  };
}

export interface ComposeRunStdoutEnvelopeInput {
  readonly runId: RunResult['run_id'];
  readonly flowId: RunResult['flow_id'];
  // The run path records the resolved axes and route facets; resume reuses
  // the saved run's route and axes, so it passes undefined for both.
  readonly resolvedAxes: AxesValue | undefined;
  readonly route: RouteOutputFieldsInput | undefined;
  readonly runFolder: string;
  readonly outcome: RunResult['outcome'];
  readonly reason: string | undefined;
  readonly traceEntriesObserved: number;
  readonly resultPath: string;
  // Pre-composed runtime decision fields: the run path spreads
  // runtimeOutputFields, resume spreads its checkpoint-resume
  // runtime_reason record.
  readonly runtimeFields: Record<string, unknown>;
  readonly historyRecallReport:
    | ReturnType<typeof prepareRunStartHistoryRecall>['report']
    | undefined;
  readonly postRunArtifactWarnings: readonly PostRunArtifactWarning[];
  readonly operatorSummary: OperatorSummaryWriteResult | undefined;
  readonly runEnvelope: WriteRunEnvelopeRecordResult | undefined;
  readonly autonomousLoop: (LoopResult & { readonly path: string }) | undefined;
}

export function composeRunStdoutEnvelope(
  input: ComposeRunStdoutEnvelopeInput,
): Record<string, unknown> {
  return {
    schema_version: 1,
    run_id: input.runId,
    flow_id: input.flowId,
    ...(input.resolvedAxes === undefined
      ? {}
      : {
          resolved_axes: {
            rigor: input.resolvedAxes.rigor,
            tournament: input.resolvedAxes.tournament,
            autonomous: input.resolvedAxes.autonomous,
          },
        }),
    ...(input.route === undefined ? {} : routeOutputFields(input.route)),
    run_folder: input.runFolder,
    outcome: input.outcome,
    // Copy the abort reason onto the final envelope so a non-streaming
    // host (and the present no-blocks branch) renders the specific reason
    // rather than a generic fallback (F-H-2). result.json carries it too.
    // A resumed run can also abort; surface its reason the same way (F-H-2).
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    trace_entries_observed: input.traceEntriesObserved,
    result_path: input.resultPath,
    ...input.runtimeFields,
    ...(input.historyRecallReport === undefined
      ? {}
      : historyRecallOutputFields({
          runFolder: input.runFolder,
          report: input.historyRecallReport,
        })),
    ...postRunArtifactWarningOutputFields(input.postRunArtifactWarnings),
    ...(input.operatorSummary === undefined
      ? {}
      : operatorSummaryOutputFields({ operatorSummary: input.operatorSummary })),
    ...(input.runEnvelope === undefined
      ? {}
      : runEnvelopeOutputFields({ runEnvelope: input.runEnvelope })),
    ...(input.autonomousLoop === undefined
      ? {}
      : {
          autonomous_loop: {
            outcome: input.autonomousLoop.outcome,
            attempts: input.autonomousLoop.attempts.length,
            stop_reason: input.autonomousLoop.stopReason,
            path: input.autonomousLoop.path,
          },
        }),
  };
}
