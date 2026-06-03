import { describe, expect, it } from 'vitest';

import { ProgressEvent } from '../../src/schemas/progress-event.js';

const BASE = {
  schema_version: 1,
  run_id: '86000000-0000-0000-0000-000000000001',
  flow_id: 'review',
  recorded_at: '2026-04-28T12:00:00.000Z',
  label: 'Progress label',
  display: {
    text: 'Circuit is making progress.',
    importance: 'major',
    tone: 'info',
  },
} as const;

describe('progress event schema', () => {
  it('accepts the host-facing progress event set', () => {
    const events = [
      { ...BASE, type: 'run.started', run_folder: '/tmp/run' },
      {
        ...BASE,
        type: 'route.selected',
        presentation: {
          block_id: BASE.run_id,
          line_mode: 'append',
          status_text: 'Chose review.',
        },
        selected_flow: 'review',
        routed_by: 'explicit',
        router_reason: 'matched review',
        entry_mode: 'default',
        entry_mode_source: 'explicit',
      },
      {
        ...BASE,
        type: 'step.started',
        step_id: 'intake-step',
        step_title: 'Intake',
        attempt: 1,
      },
      {
        ...BASE,
        type: 'step.completed',
        step_id: 'intake-step',
        step_title: 'Intake',
        attempt: 1,
        route_taken: 'pass',
      },
      {
        ...BASE,
        type: 'step.aborted',
        step_id: 'intake-step',
        step_title: 'Intake',
        attempt: 1,
        reason: 'failed',
      },
      {
        ...BASE,
        type: 'evidence.collected',
        step_id: 'intake-step',
        report_path: 'reports/review-intake.json',
        report_schema: 'review.intake@v1',
        warning_count: 1,
      },
      {
        ...BASE,
        type: 'evidence.warning',
        step_id: 'intake-step',
        report_path: 'reports/review-intake.json',
        warning_kind: 'diff_truncated',
        message: 'staged diff was truncated',
      },
      {
        ...BASE,
        type: 'relay.started',
        step_id: 'audit-step',
        step_title: 'Independent Audit',
        attempt: 1,
        role: 'reviewer',
        connector_name: 'claude-code',
        connector_kind: 'builtin',
        filesystem_capability: 'trusted-write',
      },
      {
        ...BASE,
        type: 'relay.completed',
        step_id: 'audit-step',
        step_title: 'Independent Audit',
        attempt: 1,
        verdict: 'NO_ISSUES_FOUND',
        duration_ms: 1,
      },
      {
        ...BASE,
        type: 'fanout.started',
        step_id: 'fanout-step',
        step_title: 'Fanout',
        branch_count: 1,
        branch_ids: ['option-1'],
      },
      {
        ...BASE,
        type: 'fanout.branch_started',
        step_id: 'fanout-step',
        step_title: 'Fanout',
        branch_id: 'option-1',
        branch_kind: 'relay',
      },
      {
        ...BASE,
        type: 'fanout.branch_completed',
        step_id: 'fanout-step',
        step_title: 'Fanout',
        branch_id: 'option-1',
        branch_kind: 'relay',
        child_outcome: 'complete',
        verdict: 'accept',
        duration_ms: 1,
      },
      {
        ...BASE,
        type: 'fanout.joined',
        step_id: 'fanout-step',
        step_title: 'Fanout',
        policy: 'aggregate-only',
        aggregate_path: 'reports/fanout/aggregate.json',
        branches_completed: 1,
        branches_failed: 0,
      },
      {
        ...BASE,
        type: 'checkpoint.waiting',
        step_id: 'frame-step',
        request_path: 'reports/checkpoints/frame-step-request.json',
        allowed_choices: ['continue'],
      },
      {
        ...BASE,
        type: 'task_list.updated',
        tasks: [
          { id: 'frame-step', title: 'Frame the work', status: 'completed' },
          { id: 'act-step', title: 'Make the change', status: 'in_progress' },
        ],
      },
      {
        ...BASE,
        type: 'user_input.requested',
        display: {
          text: 'Circuit needs your checkpoint choice to continue.',
          importance: 'major',
          tone: 'checkpoint',
        },
        checkpoint: {
          step_id: 'frame-step',
          request_path: 'reports/checkpoints/frame-step-request.json',
          allowed_choices: ['continue'],
        },
        questions: [
          {
            id: 'checkpoint-choice',
            header: 'Choice',
            question: 'Confirm the Build brief before implementation starts.',
            options: [
              {
                label: 'Continue',
                description: "Resume Circuit with 'continue'.",
                checkpoint_choice: 'continue',
              },
            ],
            allow_free_text: false,
          },
        ],
        resume: {
          run_folder: '/tmp/run',
          checkpoint_choice_arg: '<choice>',
          command:
            "circuit resume --run-folder '/tmp/run' --checkpoint-choice '<choice>' --progress jsonl",
        },
      },
      { ...BASE, type: 'run.completed', outcome: 'complete', result_path: '/tmp/run/result.json' },
      {
        ...BASE,
        type: 'run.aborted',
        outcome: 'aborted',
        result_path: '/tmp/run/result.json',
        reason: 'failed',
      },
    ];

    for (const event of events) {
      expect(ProgressEvent.safeParse(event).success, event.type).toBe(true);
    }
  });

  it('requires short host-facing display text on every progress event', () => {
    expect(
      ProgressEvent.safeParse({
        ...BASE,
        type: 'run.started',
        run_folder: '/tmp/run',
        display: undefined,
      }).success,
    ).toBe(false);

    expect(
      ProgressEvent.safeParse({
        ...BASE,
        type: 'run.started',
        run_folder: '/tmp/run',
        display: {
          text: 'x'.repeat(241),
          importance: 'major',
          tone: 'info',
        },
      }).success,
    ).toBe(false);

    expect(
      ProgressEvent.safeParse({
        ...BASE,
        type: 'run.started',
        run_folder: '/tmp/run',
        display: {
          text: 'Circuit started.',
          importance: 'loud',
          tone: 'sparkly',
        },
      }).success,
    ).toBe(false);
  });

  it('rejects invalid task-list and user-input limits', () => {
    expect(
      ProgressEvent.safeParse({
        ...BASE,
        type: 'task_list.updated',
        tasks: [{ id: 'frame-step', title: 'Frame the work', status: 'active' }],
      }).success,
    ).toBe(false);

    const validQuestion = {
      id: 'checkpoint-choice',
      header: 'Choice',
      question: 'Choose how Circuit should continue.',
      options: [
        {
          label: 'Continue',
          description: "Resume Circuit with 'continue'.",
          checkpoint_choice: 'continue',
        },
      ],
      allow_free_text: false,
    };

    expect(
      ProgressEvent.safeParse({
        ...BASE,
        type: 'user_input.requested',
        checkpoint: {
          step_id: 'frame-step',
          request_path: 'reports/checkpoints/frame-step-request.json',
          allowed_choices: ['continue'],
        },
        questions: [validQuestion, validQuestion, validQuestion, validQuestion],
        resume: {
          run_folder: '/tmp/run',
          checkpoint_choice_arg: '<choice>',
          command:
            "circuit resume --run-folder '/tmp/run' --checkpoint-choice '<choice>' --progress jsonl",
        },
      }).success,
    ).toBe(false);

    expect(
      ProgressEvent.safeParse({
        ...BASE,
        type: 'user_input.requested',
        checkpoint: {
          step_id: 'frame-step',
          request_path: 'reports/checkpoints/frame-step-request.json',
          allowed_choices: ['continue'],
        },
        questions: [
          {
            ...validQuestion,
            options: [
              ...validQuestion.options,
              ...validQuestion.options,
              ...validQuestion.options,
              ...validQuestion.options,
              ...validQuestion.options,
            ],
          },
        ],
        resume: {
          run_folder: '/tmp/run',
          checkpoint_choice_arg: '<choice>',
          command:
            "circuit resume --run-folder '/tmp/run' --checkpoint-choice '<choice>' --progress jsonl",
        },
      }).success,
    ).toBe(false);
  });

  it('accepts old progress events without presentation metadata', () => {
    expect(
      ProgressEvent.safeParse({
        ...BASE,
        type: 'run.started',
        run_folder: '/tmp/run',
      }).success,
    ).toBe(true);
  });

  it('validates status block presentation metadata', () => {
    expect(
      ProgressEvent.safeParse({
        ...BASE,
        type: 'run.started',
        run_folder: '/tmp/run',
        presentation: {
          block_id: BASE.run_id,
          line_mode: 'append',
          status_text: 'Framing the work...',
        },
      }).success,
    ).toBe(true);

    expect(
      ProgressEvent.safeParse({
        ...BASE,
        type: 'run.started',
        run_folder: '/tmp/run',
        presentation: {
          block_id: BASE.run_id,
          line_mode: 'replace_slot',
          status_text: 'Review completed.',
        },
      }).success,
    ).toBe(false);

    expect(
      ProgressEvent.safeParse({
        ...BASE,
        type: 'run.started',
        run_folder: '/tmp/run',
        presentation: {
          block_id: BASE.run_id,
          line_mode: 'append',
          status_text: 'x'.repeat(181),
        },
      }).success,
    ).toBe(false);
  });
});
