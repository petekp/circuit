import { z } from 'zod';

import {
  MAX_CHECKPOINT_REVIEW_COMMENTS,
  MAX_CHECKPOINT_REVIEW_COMMENT_CHARS,
  MAX_CHECKPOINT_REVIEW_JSON_BYTES,
} from './checkpoint-review-constraints.js';
import { RunId, StepId } from './ids.js';
import { Sha256 } from './ref.js';

export { MAX_CHECKPOINT_REVIEW_JSON_BYTES } from './checkpoint-review-constraints.js';

const CommentBody = z.string().trim().min(1).max(MAX_CHECKPOINT_REVIEW_COMMENT_CHARS);

export const CheckpointReviewComment = z.discriminatedUnion('scope', [
  z
    .object({
      scope: z.literal('choice'),
      choice_id: z.string().min(1),
      body: CommentBody,
    })
    .strict(),
  z
    .object({
      scope: z.literal('overall'),
      body: CommentBody,
    })
    .strict(),
]);
export type CheckpointReviewComment = z.infer<typeof CheckpointReviewComment>;

// Typed operator feedback prepared by a checkpoint review page. The token
// carrying this value is only transport; resume still validates the saved run,
// unresolved checkpoint, and allowed choice before the response is written.
export const CheckpointReviewResponse = z
  .object({
    schema: z.literal('checkpoint.review-response@v1'),
    run_id: RunId,
    step_id: StepId,
    attempt: z.number().int().positive(),
    request_sha256: Sha256,
    selection: z.string().min(1),
    comments: z.array(CheckpointReviewComment).max(MAX_CHECKPOINT_REVIEW_COMMENTS),
  })
  .strict()
  .superRefine((response, ctx) => {
    const bytes = new TextEncoder().encode(JSON.stringify(response)).byteLength;
    if (bytes > MAX_CHECKPOINT_REVIEW_JSON_BYTES) {
      ctx.addIssue({
        code: 'custom',
        path: ['comments'],
        message: `checkpoint review response exceeds ${MAX_CHECKPOINT_REVIEW_JSON_BYTES} UTF-8 bytes`,
      });
    }
  });
export type CheckpointReviewResponse = z.infer<typeof CheckpointReviewResponse>;
export type CheckpointReviewResponseInput = z.input<typeof CheckpointReviewResponse>;
