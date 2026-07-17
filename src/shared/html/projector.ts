// HTML projector contract.
//
// A projector renders a single flow's operator-summary HTML from the run
// folder. It owns evidence loading, schema validation, and gating logic for
// its flow. The writer dispatches by flow id through HTML_PROJECTORS.

export type JsonObject = Record<string, unknown>;

export type HtmlAutoResolution = {
  readonly checkpoint_id: string;
  readonly checkpoint_label?: string | undefined;
  readonly policy: 'highest-score';
  readonly resolved_value: string;
  readonly winning_score: number;
  readonly margin: number | null;
  readonly runtime_veto_effect: string;
};

export type HtmlCheckpointChoice = {
  readonly id: string;
  readonly label?: string | undefined;
  readonly description?: string | undefined;
};

export type HtmlProjectorCheckpoint = {
  readonly step_id: string;
  readonly attempt: number;
  readonly request_path: string;
  readonly request_sha256: string;
  readonly allowed_choices: readonly string[];
  // Widened context parsed from the checkpoint request file by the writer.
  // The page can only adapt to what it can see. These are best-effort:
  // absent when the request file is missing or malformed, so projectors
  // must degrade to allowed_choices ids.
  readonly prompt?: string | undefined;
  readonly safe_default_choice?: string | undefined;
  readonly choices?: readonly HtmlCheckpointChoice[] | undefined;
  readonly depth?: string | undefined;
};

export type HtmlProjectorContext = {
  readonly runFolder: string;
  readonly projectRoot?: string | undefined;
  readonly runId: string;
  readonly flowId: string;
  readonly runOutcome: string;
  // Exact launcher for the environment that produced the report. Plugin
  // installs do not put a global `circuit` binary on PATH.
  readonly resumeCommandPrefix?: string | undefined;
  readonly checkpoint?: HtmlProjectorCheckpoint | undefined;
  readonly flowReport: JsonObject | undefined;
  readonly readJsonRunRelative: (relPath: string) => JsonObject | undefined;
  readonly readEvidenceReportById: (reportId: string) => JsonObject | undefined;
  readonly autoResolutions?: readonly HtmlAutoResolution[];
};

// Returns rendered HTML, or undefined when the flow has not produced the
// inputs HTML projection requires (e.g. an Explore run that has not yet
// finalized a decision).
export type HtmlProjector = (ctx: HtmlProjectorContext) => string | undefined;
