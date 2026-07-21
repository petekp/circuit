export interface CheckpointDecisionChoice {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

export interface CheckpointReviewMaterial {
  readonly path: string;
  readonly content: unknown;
}

export interface CheckpointDecisionView {
  readonly step_id: string;
  readonly prompt: string;
  readonly request_path: string;
  readonly request_sha256: string;
  readonly allowed_choices: readonly string[];
  readonly choices: readonly CheckpointDecisionChoice[];
  readonly safe_default_choice?: string;
  readonly review_material: readonly CheckpointReviewMaterial[];
}

export function checkpointViewForJob(job: {
  readonly runFolder: string;
  readonly final?: unknown;
}): Promise<CheckpointDecisionView | undefined>;
