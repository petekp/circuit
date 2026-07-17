import { describe, expect, it } from 'vitest';

import {
  CHECKPOINT_REVIEW_COMMENT_TOO_LONG,
  CHECKPOINT_REVIEW_TOO_LARGE,
  TOO_MANY_CHECKPOINT_REVIEW_COMMENTS,
  checkpointReviewPayloadError,
} from '../../../src/schemas/checkpoint-review-constraints.js';
import { CheckpointReviewResponse } from '../../../src/schemas/checkpoint-review-response.js';
import {
  CHECKPOINT_REVIEW_DRAFT_SCHEMA,
  SAVED_CHECKPOINT_REVIEW_SELECTION_UNAVAILABLE,
  SAVED_CHECKPOINT_REVIEW_VERSION_UNAVAILABLE,
  buildCheckpointReviewResponse,
  checkpointReviewDraftRestoreNotice,
  checkpointReviewDraftSummary,
  checkpointReviewStorageKey,
  createCheckpointReviewDraft,
  restoreCheckpointReviewDraft,
  selectCheckpointReviewChoice,
  setCheckpointReviewChoiceNote,
  setCheckpointReviewOverallNote,
} from '../../../src/shared/checkpoint-review/state.js';

const CHOICES = ['variant-a', 'variant-b', 'variant-c'] as const;
const IDENTITY = {
  runId: '11111111-1111-4111-8111-111111111111',
  stepId: 'prototype-variant-checkpoint-step',
  attempt: 2,
  requestSha256: 'b'.repeat(64),
} as const;

describe('checkpoint review draft state', () => {
  it('keeps the established identity-specific storage key', () => {
    expect(checkpointReviewStorageKey(IDENTITY)).toBe(
      `circuit:checkpoint-review:${IDENTITY.runId}:${IDENTITY.stepId}:2:${'b'.repeat(64)}`,
    );
  });

  it('starts on the current default and treats the visible choice as visited', () => {
    expect(
      createCheckpointReviewDraft({ choiceIds: CHOICES, defaultSelection: 'variant-b' }),
    ).toEqual({
      schema: CHECKPOINT_REVIEW_DRAFT_SCHEMA,
      selection: 'variant-b',
      notes: {},
      overall: '',
      visited: ['variant-b'],
    });
  });

  it('migrates the old unversioned draft without changing the saved value', () => {
    const saved = {
      notes: { 'variant-a': 'Keep this note', 'variant-b': 'Second note' },
      overall: 'Overall context',
      visited: ['variant-b'],
    };
    const before = structuredClone(saved);

    const restored = restoreCheckpointReviewDraft(saved, {
      choiceIds: CHOICES,
      defaultSelection: 'variant-a',
    });

    expect(saved).toEqual(before);
    expect(restored).toEqual({
      schema: CHECKPOINT_REVIEW_DRAFT_SCHEMA,
      selection: 'variant-a',
      notes: { 'variant-a': 'Keep this note', 'variant-b': 'Second note' },
      overall: 'Overall context',
      visited: ['variant-b', 'variant-a'],
    });
  });

  it('restores a saved non-default selection and filters choices that disappeared', () => {
    const restored = restoreCheckpointReviewDraft(
      {
        schema: CHECKPOINT_REVIEW_DRAFT_SCHEMA,
        selection: 'variant-c',
        notes: { 'variant-a': 'A', 'variant-c': 'C', removed: 'Do not submit' },
        overall: '',
        visited: ['removed', 'variant-c', 'variant-c'],
      },
      { choiceIds: CHOICES, defaultSelection: 'variant-a' },
    );

    expect(restored.selection).toBe('variant-c');
    expect(restored.notes).toEqual({ 'variant-a': 'A', 'variant-c': 'C' });
    expect(restored.visited).toEqual(['variant-c']);
  });

  it('visibly explains stale selections and unknown draft versions', () => {
    expect(
      checkpointReviewDraftRestoreNotice(
        { schema: CHECKPOINT_REVIEW_DRAFT_SCHEMA, selection: 'removed' },
        { choiceIds: CHOICES, defaultSelection: 'variant-a' },
      ),
    ).toBe(SAVED_CHECKPOINT_REVIEW_SELECTION_UNAVAILABLE);
    expect(
      checkpointReviewDraftRestoreNotice(
        { schema: 'checkpoint.review-draft@v2', selection: 'variant-b' },
        { choiceIds: CHOICES, defaultSelection: 'variant-a' },
      ),
    ).toBe(SAVED_CHECKPOINT_REVIEW_VERSION_UNAVAILABLE);
  });

  it('falls back safely when a saved selection is unavailable', () => {
    const restored = restoreCheckpointReviewDraft(
      {
        schema: CHECKPOINT_REVIEW_DRAFT_SCHEMA,
        selection: 'removed',
        notes: { 'variant-a': 'Still useful' },
        overall: 'Keep this too',
        visited: ['removed'],
      },
      { choiceIds: CHOICES, defaultSelection: 'variant-b' },
    );

    expect(restored.selection).toBe('variant-b');
    expect(restored.notes).toEqual({ 'variant-a': 'Still useful' });
    expect(restored.overall).toBe('Keep this too');
    expect(restored.visited).toEqual(['variant-b']);
  });

  it('starts clean rather than interpreting an unknown future version', () => {
    const restored = restoreCheckpointReviewDraft(
      {
        schema: 'checkpoint.review-draft@v2',
        selection: 'variant-c',
        notes: { 'variant-c': 'Incompatible' },
      },
      { choiceIds: CHOICES, defaultSelection: 'variant-a' },
    );

    expect(restored).toEqual(
      createCheckpointReviewDraft({ choiceIds: CHOICES, defaultSelection: 'variant-a' }),
    );
  });

  it('updates selection, notes, and visited choices without mutating earlier state', () => {
    const initial = createCheckpointReviewDraft({
      choiceIds: CHOICES,
      defaultSelection: 'variant-a',
    });
    const withNote = setCheckpointReviewChoiceNote(initial, 'variant-a', 'First note', CHOICES);
    const selected = selectCheckpointReviewChoice(withNote, 'variant-c', CHOICES);
    const withOverall = setCheckpointReviewOverallNote(selected, 'Whole review');

    expect(initial.notes).toEqual({});
    expect(initial.selection).toBe('variant-a');
    expect(withOverall).toMatchObject({
      selection: 'variant-c',
      notes: { 'variant-a': 'First note' },
      overall: 'Whole review',
      visited: ['variant-a', 'variant-c'],
    });
    expect(checkpointReviewDraftSummary(withOverall, CHOICES)).toEqual({
      choiceCommentCount: 1,
      hasOverallComment: true,
      unvisitedCount: 1,
    });
  });

  it('handles canonical choice ids such as __proto__ as data', () => {
    const choices = ['__proto__', 'normal'];
    const initial = createCheckpointReviewDraft({
      choiceIds: choices,
      defaultSelection: '__proto__',
    });
    const updated = setCheckpointReviewChoiceNote(initial, '__proto__', 'safe', choices);
    expect(updated.notes.__proto__).toBe('safe');
  });
});

describe('checkpoint review response construction', () => {
  it('builds the unchanged v1 response, trims notes, and omits blanks', () => {
    const draft = restoreCheckpointReviewDraft(
      {
        schema: CHECKPOINT_REVIEW_DRAFT_SCHEMA,
        selection: 'variant-b',
        notes: {
          'variant-a': '  First note  ',
          'variant-b': '\n\t',
          'variant-c': 'Third note\n',
        },
        overall: '  Overall context  ',
        visited: CHOICES,
      },
      { choiceIds: CHOICES, defaultSelection: 'variant-a' },
    );

    const response = buildCheckpointReviewResponse(draft, IDENTITY, CHOICES);
    expect(response).toEqual({
      schema: 'checkpoint.review-response@v1',
      run_id: IDENTITY.runId,
      step_id: IDENTITY.stepId,
      attempt: 2,
      request_sha256: IDENTITY.requestSha256,
      selection: 'variant-b',
      comments: [
        { scope: 'choice', choice_id: 'variant-a', body: 'First note' },
        { scope: 'choice', choice_id: 'variant-c', body: 'Third note' },
        { scope: 'overall', body: 'Overall context' },
      ],
    });
    expect(CheckpointReviewResponse.parse(response)).toEqual(response);
  });

  it('rejects an unavailable selection before constructing a response', () => {
    const draft = {
      ...createCheckpointReviewDraft({ choiceIds: CHOICES, defaultSelection: 'variant-a' }),
      selection: 'removed',
    };
    expect(() => buildCheckpointReviewResponse(draft, IDENTITY, CHOICES)).toThrow(
      "checkpoint review selection 'removed' is unavailable",
    );
  });

  it('reports the 25-comment guard in plain English', () => {
    const payload = {
      comments: Array.from({ length: 25 }, (_, index) => ({ body: `Comment ${index}` })),
    };
    expect(checkpointReviewPayloadError(payload)).toBe(TOO_MANY_CHECKPOINT_REVIEW_COMMENTS);
  });

  it('measures the 60,000-byte guard as UTF-8', () => {
    expect(checkpointReviewPayloadError({ comments: [{ body: '界'.repeat(21_000) }] })).toBe(
      CHECKPOINT_REVIEW_TOO_LARGE,
    );
  });

  it('reports an individually overlong comment below the total-size limit', () => {
    expect(checkpointReviewPayloadError({ comments: [{ body: 'a'.repeat(2_001) }] })).toBe(
      CHECKPOINT_REVIEW_COMMENT_TOO_LONG,
    );
  });
});
