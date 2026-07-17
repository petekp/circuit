export const CHECKPOINT_REVIEW_DRAFT_SCHEMA = 'checkpoint.review-draft@v1' as const;

export type CheckpointReviewIdentity = {
  readonly runId: string;
  readonly stepId: string;
  readonly attempt: number;
  readonly requestSha256: string;
};

export type CheckpointReviewDraft = {
  readonly schema: typeof CHECKPOINT_REVIEW_DRAFT_SCHEMA;
  readonly selection: string;
  readonly notes: Readonly<Record<string, string>>;
  readonly overall: string;
  readonly visited: readonly string[];
};

export type CheckpointReviewChoiceComment = {
  readonly scope: 'choice';
  readonly choice_id: string;
  readonly body: string;
};

export type CheckpointReviewOverallComment = {
  readonly scope: 'overall';
  readonly body: string;
};

export type CheckpointReviewResponseData = {
  readonly schema: 'checkpoint.review-response@v1';
  readonly run_id: string;
  readonly step_id: string;
  readonly attempt: number;
  readonly request_sha256: string;
  readonly selection: string;
  readonly comments: readonly (CheckpointReviewChoiceComment | CheckpointReviewOverallComment)[];
};

export type RestoreCheckpointReviewDraftInput = {
  readonly choiceIds: readonly string[];
  readonly defaultSelection: string;
};

export type CheckpointReviewDraftSummary = {
  readonly choiceCommentCount: number;
  readonly hasOverallComment: boolean;
  readonly unvisitedCount: number;
};

export const SAVED_CHECKPOINT_REVIEW_SELECTION_UNAVAILABLE =
  'The saved choice is no longer available. Review started from the current default.';
export const SAVED_CHECKPOINT_REVIEW_VERSION_UNAVAILABLE =
  'This saved draft uses a different version. Review started fresh.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function uniqueChoiceIds(choiceIds: readonly string[]): readonly string[] {
  return Array.from(new Set(choiceIds.filter((choiceId) => choiceId.length > 0)));
}

function requireChoices(input: RestoreCheckpointReviewDraftInput): readonly string[] {
  const choiceIds = uniqueChoiceIds(input.choiceIds);
  if (choiceIds.length === 0) throw new Error('checkpoint review requires at least one choice');
  return choiceIds;
}

function initialSelection(choiceIds: readonly string[], requestedDefault: string): string {
  return choiceIds.includes(requestedDefault) ? requestedDefault : (choiceIds[0] ?? '');
}

export function checkpointReviewStorageKey(identity: CheckpointReviewIdentity): string {
  return `circuit:checkpoint-review:${identity.runId}:${identity.stepId}:${identity.attempt}:${identity.requestSha256}`;
}

export function createCheckpointReviewDraft(
  input: RestoreCheckpointReviewDraftInput,
): CheckpointReviewDraft {
  const choiceIds = requireChoices(input);
  const selection = initialSelection(choiceIds, input.defaultSelection);
  return {
    schema: CHECKPOINT_REVIEW_DRAFT_SCHEMA,
    selection,
    notes: {},
    overall: '',
    visited: [selection],
  };
}

export function checkpointReviewDraftRestoreNotice(
  saved: unknown,
  input: RestoreCheckpointReviewDraftInput,
): string | undefined {
  const choiceIds = requireChoices(input);
  if (!isRecord(saved)) return undefined;
  if ('schema' in saved && saved.schema !== CHECKPOINT_REVIEW_DRAFT_SCHEMA) {
    return SAVED_CHECKPOINT_REVIEW_VERSION_UNAVAILABLE;
  }
  if (typeof saved.selection === 'string' && !choiceIds.includes(saved.selection)) {
    return SAVED_CHECKPOINT_REVIEW_SELECTION_UNAVAILABLE;
  }
  return undefined;
}

// Accepts both the new versioned draft and the unversioned shape emitted by
// the first checkpoint pages. Unknown future versions start clean instead of
// being interpreted with stale rules.
export function restoreCheckpointReviewDraft(
  saved: unknown,
  input: RestoreCheckpointReviewDraftInput,
): CheckpointReviewDraft {
  const choiceIds = requireChoices(input);
  const fallback = createCheckpointReviewDraft(input);
  if (!isRecord(saved)) return fallback;
  if ('schema' in saved && saved.schema !== CHECKPOINT_REVIEW_DRAFT_SCHEMA) return fallback;

  const selection =
    typeof saved.selection === 'string' && choiceIds.includes(saved.selection)
      ? saved.selection
      : fallback.selection;

  const notes = isRecord(saved.notes)
    ? Object.fromEntries(
        Object.entries(saved.notes).filter(
          (entry): entry is [string, string] =>
            choiceIds.includes(entry[0]) && typeof entry[1] === 'string',
        ),
      )
    : {};
  const overall = typeof saved.overall === 'string' ? saved.overall : '';
  const visited = Array.isArray(saved.visited)
    ? Array.from(
        new Set(
          saved.visited.filter(
            (choiceId): choiceId is string =>
              typeof choiceId === 'string' && choiceIds.includes(choiceId),
          ),
        ),
      )
    : [];
  if (!visited.includes(selection)) visited.push(selection);

  return {
    schema: CHECKPOINT_REVIEW_DRAFT_SCHEMA,
    selection,
    notes,
    overall,
    visited,
  };
}

export function selectCheckpointReviewChoice(
  draft: CheckpointReviewDraft,
  choiceId: string,
  choiceIds: readonly string[],
): CheckpointReviewDraft {
  if (!choiceIds.includes(choiceId)) return draft;
  const visited = draft.visited.includes(choiceId) ? draft.visited : [...draft.visited, choiceId];
  if (draft.selection === choiceId && visited === draft.visited) return draft;
  return { ...draft, selection: choiceId, visited };
}

export function setCheckpointReviewChoiceNote(
  draft: CheckpointReviewDraft,
  choiceId: string,
  body: string,
  choiceIds: readonly string[],
): CheckpointReviewDraft {
  if (!choiceIds.includes(choiceId) || draft.notes[choiceId] === body) return draft;
  return { ...draft, notes: { ...draft.notes, [choiceId]: body } };
}

export function setCheckpointReviewOverallNote(
  draft: CheckpointReviewDraft,
  body: string,
): CheckpointReviewDraft {
  return draft.overall === body ? draft : { ...draft, overall: body };
}

export function checkpointReviewDraftSummary(
  draft: CheckpointReviewDraft,
  choiceIds: readonly string[],
): CheckpointReviewDraftSummary {
  const allowed = uniqueChoiceIds(choiceIds);
  return {
    choiceCommentCount: allowed.filter(
      (choiceId) => (draft.notes[choiceId] ?? '').trim().length > 0,
    ).length,
    hasOverallComment: draft.overall.trim().length > 0,
    unvisitedCount: allowed.filter((choiceId) => !draft.visited.includes(choiceId)).length,
  };
}

export function buildCheckpointReviewResponse(
  draft: CheckpointReviewDraft,
  identity: CheckpointReviewIdentity,
  choiceIds: readonly string[],
): CheckpointReviewResponseData {
  const allowed = uniqueChoiceIds(choiceIds);
  if (!allowed.includes(draft.selection)) {
    throw new Error(`checkpoint review selection '${draft.selection}' is unavailable`);
  }

  const comments: (CheckpointReviewChoiceComment | CheckpointReviewOverallComment)[] = [];
  for (const choiceId of allowed) {
    const body = (draft.notes[choiceId] ?? '').trim();
    if (body.length > 0) comments.push({ scope: 'choice', choice_id: choiceId, body });
  }
  const overall = draft.overall.trim();
  if (overall.length > 0) comments.push({ scope: 'overall', body: overall });

  return {
    schema: 'checkpoint.review-response@v1',
    run_id: identity.runId,
    step_id: identity.stepId,
    attempt: identity.attempt,
    request_sha256: identity.requestSha256,
    selection: draft.selection,
    comments,
  };
}
