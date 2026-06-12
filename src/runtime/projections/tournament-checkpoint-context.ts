export interface CheckpointChoicePresentation {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

export interface CheckpointPresentation {
  readonly prompt: string;
  readonly choices: readonly CheckpointChoicePresentation[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedText(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export type CheckpointPresentationJsonReader = (path: string) => unknown | undefined;

function optionPresentationById(
  readJson: CheckpointPresentationJsonReader,
): ReadonlyMap<string, CheckpointChoicePresentation> {
  const raw = readJson('reports/decision-options.json');
  if (!isRecord(raw) || !Array.isArray(raw.options)) return new Map();
  const entries: [string, CheckpointChoicePresentation][] = [];
  for (const option of raw.options) {
    if (!isRecord(option)) continue;
    const id = option.id;
    const label = option.label;
    if (typeof id !== 'string' || typeof label !== 'string') continue;
    const description =
      typeof option.summary === 'string'
        ? option.summary
        : typeof option.best_case_prompt === 'string'
          ? option.best_case_prompt
          : `Resume with '${id}'.`;
    entries.push([
      id,
      {
        id,
        label: boundedText(label, 80),
        description: boundedText(description, 160),
      },
    ]);
  }
  return new Map(entries);
}

function tournamentQuestion(readJson: CheckpointPresentationJsonReader): string | undefined {
  const raw = readJson('reports/tournament-review.json');
  if (!isRecord(raw)) return undefined;
  const question = raw.tradeoff_question;
  return typeof question === 'string' && question.trim().length > 0
    ? boundedText(question.trim(), 240)
    : undefined;
}

export function tournamentCheckpointPresentation(input: {
  readonly readJson: CheckpointPresentationJsonReader;
  readonly allowedChoices: readonly string[];
  readonly fallbackPrompt: string;
  readonly fallbackLabel: (choice: string) => string;
  readonly fallbackDescription: (choice: string) => string;
}): CheckpointPresentation {
  const byId = optionPresentationById(input.readJson);
  return {
    prompt: tournamentQuestion(input.readJson) ?? boundedText(input.fallbackPrompt, 240),
    choices: input.allowedChoices.map((choice) => {
      const dynamic = byId.get(choice);
      if (dynamic !== undefined) return dynamic;
      return {
        id: choice,
        label: boundedText(input.fallbackLabel(choice), 80),
        description: boundedText(input.fallbackDescription(choice), 160),
      };
    }),
  };
}
