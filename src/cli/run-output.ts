import type { OperatorSummaryWriteResult } from '../app/operator-summary/writer.js';
import type { WriteRunEnvelopeRecordResult } from '../app/run-envelope/source-record.js';

export interface RouteOutputFieldsInput {
  readonly selectedFlow: string;
  readonly routedBy: 'explicit';
  readonly routerReason: string;
  readonly entryMode?: string;
  readonly entryModeSource?: 'explicit' | 'derived';
}

export interface SelectedProcessFieldsInput {
  readonly processId: string;
  readonly routedBy?: 'explicit';
  readonly routerReason: string;
  readonly entryMode?: string;
}

export interface SelectedProcessFields {
  readonly process_id: string;
  readonly routed_by?: 'explicit';
  readonly router_reason: string;
  readonly entry_mode?: string;
}

export interface OperatorSummaryOutputFieldsInput {
  readonly operatorSummary: OperatorSummaryWriteResult;
}

export interface RunEnvelopeOutputFieldsInput {
  readonly runEnvelope: WriteRunEnvelopeRecordResult;
}

export function routeOutputFields(input: RouteOutputFieldsInput): Record<string, unknown> {
  return {
    selected_flow: input.selectedFlow,
    routed_by: input.routedBy,
    router_reason: input.routerReason,
    ...(input.entryMode === undefined ? {} : { entry_mode: input.entryMode }),
    ...(input.entryModeSource === undefined ? {} : { entry_mode_source: input.entryModeSource }),
  };
}

// The selected_process literal shared by the run-envelope shadow + source
// writers (and the route.selected progress event's process facet). The three
// post-run call sites (closed run, checkpoint-waiting, resume) restate the same
// shape; this builder owns the optional-field collapsing so the key order and
// omission rules stay identical across them.
export function selectedProcessFields(input: SelectedProcessFieldsInput): SelectedProcessFields {
  return {
    process_id: input.processId,
    ...(input.routedBy === undefined ? {} : { routed_by: input.routedBy }),
    router_reason: input.routerReason,
    ...(input.entryMode === undefined ? {} : { entry_mode: input.entryMode }),
  };
}

export function operatorSummaryOutputFields(
  input: OperatorSummaryOutputFieldsInput,
): Record<string, unknown> {
  const operatorSummary = input.operatorSummary;
  return {
    operator_summary_path: operatorSummary.jsonPath,
    operator_summary_markdown_path: operatorSummary.markdownPath,
    ...(operatorSummary.summary.status_text === undefined
      ? {}
      : { operator_summary_status_text: operatorSummary.summary.status_text }),
    ...(operatorSummary.htmlPath === undefined
      ? {}
      : { operator_summary_html_path: operatorSummary.htmlPath }),
  };
}

export function runEnvelopeOutputFields(
  input: RunEnvelopeOutputFieldsInput,
): Record<string, unknown> {
  return {
    run_envelope_path: input.runEnvelope.path,
    run_process_evidence_path: input.runEnvelope.processEvidencePath,
    run_surface_markdown_path: input.runEnvelope.surfacePath,
    run_surface_status_text: input.runEnvelope.record.surface_output.status_text,
    ...(input.runEnvelope.decisionPacketPaths.length === 0
      ? {}
      : { run_decision_packet_paths: input.runEnvelope.decisionPacketPaths }),
  };
}
