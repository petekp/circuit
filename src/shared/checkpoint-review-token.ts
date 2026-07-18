import {
  CheckpointReviewResponse,
  type CheckpointReviewResponseInput,
  MAX_CHECKPOINT_REVIEW_JSON_BYTES,
} from '../schemas/checkpoint-review-response.js';

const TOKEN_PREFIX = 'ckr1.';
const MAX_TOKEN_CHARS = TOKEN_PREFIX.length + Math.ceil((MAX_CHECKPOINT_REVIEW_JSON_BYTES * 4) / 3);

export function encodeCheckpointReviewResponse(input: CheckpointReviewResponseInput): string {
  const response = CheckpointReviewResponse.parse(input);
  return `${TOKEN_PREFIX}${Buffer.from(JSON.stringify(response), 'utf8').toString('base64url')}`;
}

export function decodeCheckpointReviewResponse(token: string): CheckpointReviewResponse {
  if (!token.startsWith(TOKEN_PREFIX) || token.length > MAX_TOKEN_CHARS) {
    throw new Error('checkpoint response token has an invalid envelope');
  }
  const payload = token.slice(TOKEN_PREFIX.length);
  if (payload.length === 0) throw new Error('checkpoint response token has no payload');
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new Error('checkpoint response token payload is not valid JSON');
  }
  const parsed = CheckpointReviewResponse.safeParse(raw);
  if (!parsed.success) {
    // A token can carry private review notes. Never let schema diagnostics echo
    // values from that payload into terminal output.
    throw new Error(
      'checkpoint response token payload does not match checkpoint.review-response@v1',
    );
  }
  return parsed.data;
}
