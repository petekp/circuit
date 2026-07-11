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

export interface RenderedRecallWarning {
  readonly code: string;
  readonly message: string;
}

function leadingNumber(message: string): number {
  const match = message.match(/\d+/);
  return match === null ? 0 : Number(match[0]);
}

// Groups repeated identical-code warnings into one line with a count and the
// largest example, so an agent-facing channel does not repeat the same one
// line of information N times (F9). Emission upstream stays per-document;
// only this render boundary collapses them. Order-preserving: the first
// occurrence of each code marks its position in the output.
export function collapseIdenticalCodeWarnings(
  warnings: readonly RenderedRecallWarning[],
): RenderedRecallWarning[] {
  const order: string[] = [];
  const groups = new Map<string, RenderedRecallWarning[]>();
  for (const warning of warnings) {
    const group = groups.get(warning.code);
    if (group === undefined) {
      groups.set(warning.code, [warning]);
      order.push(warning.code);
    } else {
      group.push(warning);
    }
  }
  return order.map((code) => {
    const group = groups.get(code) as RenderedRecallWarning[];
    const first = group[0] as RenderedRecallWarning;
    if (group.length === 1) return first;
    const largest = group.reduce((best, current) =>
      leadingNumber(current.message) > leadingNumber(best.message) ? current : best,
    );
    return { code, message: `${code} x${group.length} (largest: ${largest.message})` };
  });
}

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
      warnings: collapseIdenticalCodeWarnings(
        input.report.warnings.map((warning) => ({ code: warning.code, message: warning.message })),
      ),
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
            depth: input.resolvedAxes.depth,
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
