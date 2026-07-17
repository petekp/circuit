// Browser and engine code share these limits without pulling a schema library
// into the generated checkpoint page.

export const MAX_CHECKPOINT_REVIEW_COMMENT_CHARS = 2_000;
export const MAX_CHECKPOINT_REVIEW_COMMENTS = 24;
export const MAX_CHECKPOINT_REVIEW_JSON_BYTES = 60_000;

export const TOO_MANY_CHECKPOINT_REVIEW_COMMENTS =
  'Too many comments. Keep notes on at most 24 choices, including the overall note.';
export const CHECKPOINT_REVIEW_TOO_LARGE =
  'Review notes are too large. Shorten them before preparing the decision.';
export const CHECKPOINT_REVIEW_COMMENT_TOO_LONG =
  'Each comment can be at most 2,000 characters. Shorten the longer notes before preparing the decision.';

export type CheckpointReviewCommentBody = {
  readonly body: string;
};

export type CheckpointReviewPayloadLike = {
  readonly comments: readonly CheckpointReviewCommentBody[];
};

// Returns operator-facing copy because the browser uses this result directly.
// Count and total-size failures take priority: they are more useful when a
// manually seeded or older draft violates several limits at once.
export function checkpointReviewPayloadError(
  payload: CheckpointReviewPayloadLike,
): string | undefined {
  if (payload.comments.length > MAX_CHECKPOINT_REVIEW_COMMENTS) {
    return TOO_MANY_CHECKPOINT_REVIEW_COMMENTS;
  }

  const bytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
  if (bytes > MAX_CHECKPOINT_REVIEW_JSON_BYTES) return CHECKPOINT_REVIEW_TOO_LARGE;

  if (
    payload.comments.some((comment) => comment.body.length > MAX_CHECKPOINT_REVIEW_COMMENT_CHARS)
  ) {
    return CHECKPOINT_REVIEW_COMMENT_TOO_LONG;
  }

  return undefined;
}
