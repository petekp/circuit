import { describe, expect, it } from 'vitest';

import {
  genericCheckpointHtml,
  renderCheckpointPage,
} from '../../../../src/shared/html/checkpoint-page.js';
import type { HtmlProjectorContext } from '../../../../src/shared/html/projector.js';

const RUN_FOLDER = '/tmp/circuit-run';

function waitingContext(
  overrides: Partial<NonNullable<HtmlProjectorContext['checkpoint']>> = {},
): HtmlProjectorContext {
  return {
    runFolder: RUN_FOLDER,
    runId: '87000000-0000-0000-0000-000000000031',
    flowId: 'fix',
    runOutcome: 'checkpoint_waiting',
    checkpoint: {
      step_id: 'fix-no-repro-decision',
      request_path: `${RUN_FOLDER}/reports/checkpoints/fix-no-repro-decision-request.json`,
      allowed_choices: ['continue', 'stop'],
      prompt: 'Diagnosis did not cleanly reproduce the bug. Choose how to proceed.',
      safe_default_choice: 'continue',
      choices: [
        { id: 'continue', label: 'Continue with a focused fix anyway' },
        { id: 'stop', label: 'Stop and hand back' },
      ],
      depth: 'high',
      ...overrides,
    },
    flowReport: undefined,
    readJsonRunRelative: () => undefined,
    readEvidenceReportById: () => undefined,
  };
}

describe('renderCheckpointPage', () => {
  it('leads with the prompt, marks the default choice, and carries an honest resume path', () => {
    const html = renderCheckpointPage({
      meta: { flowLabel: 'Fix', runId: 'run-1', stepId: 'fix-no-repro-decision' },
      question: 'Diagnosis did not cleanly reproduce the bug. Choose how to proceed.',
      ribbon: ['Waiting for you', 'Depth high'],
      options: [
        {
          id: 'continue',
          label: 'Continue with a focused fix anyway',
          isDefault: true,
        },
        { id: 'stop', label: 'Stop and hand back' },
      ],
      defaultChoice: { id: 'continue', label: 'Continue with a focused fix anyway' },
      resume: { runFolder: RUN_FOLDER },
      footerLeft: 'circuit · fix · run-1',
      footerRight: 'reports/checkpoints/fix-no-repro-decision-request.json',
    });

    // The question is the hero headline.
    expect(html).toContain('<h1>Diagnosis did not cleanly reproduce the bug.');
    // Context ribbon chips are present.
    expect(html).toContain('Waiting for you');
    expect(html).toContain('Depth high');
    // The default choice is marked on its option and stated in the strip.
    expect(html).toContain('Default');
    expect(html).toMatch(/If you do nothing/);
    expect(html).toContain('Continue with a focused fix anyway');
    // Every option carries the real resume command for that choice.
    expect(html).toContain(
      `circuit resume --run-folder &#39;${RUN_FOLDER}&#39; --checkpoint-choice &#39;continue&#39;`,
    );
    expect(html).toContain(
      `circuit resume --run-folder &#39;${RUN_FOLDER}&#39; --checkpoint-choice &#39;stop&#39;`,
    );
    expect(html).toContain('Copy resume command');
  });

  it('states the parked outcome when no default choice exists', () => {
    const html = renderCheckpointPage({
      meta: { flowLabel: 'Explainer', runId: 'run-2', stepId: 'publish-gate' },
      question: 'Authorize publishing only if the site is faithful.',
      ribbon: ['Waiting for you'],
      options: [{ id: 'publish', label: 'Publish the explainer' }],
      resume: { runFolder: RUN_FOLDER },
    });

    expect(html).toMatch(/If you do nothing/);
    expect(html).toContain('stays parked');
    expect(html).not.toContain('Default choice');
  });

  it('escapes hostile option labels and prompts', () => {
    const html = renderCheckpointPage({
      meta: { flowLabel: 'Fix', runId: 'run-3', stepId: 's' },
      question: 'Choose <script>alert(1)</script> now',
      ribbon: [],
      options: [{ id: 'a', label: '<img src=x onerror=alert(2)>' }],
      resume: { runFolder: RUN_FOLDER },
    });

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
  });

  it('shows the recommendation once, sourced from a single selection', () => {
    const html = renderCheckpointPage({
      meta: { flowLabel: 'Build', runId: 'run-4', stepId: 'frame-step' },
      question: 'Confirm the Build brief before implementation starts.',
      ribbon: [],
      recommendation: {
        label: 'Confirm and build',
        rationale: 'The scope is bounded and the proof plan is explicit.',
      },
      options: [
        { id: 'continue', label: 'Confirm and build', isRecommended: true, isDefault: true },
        { id: 'revise', label: 'Send the brief back' },
      ],
      defaultChoice: { id: 'continue', label: 'Confirm and build' },
      resume: { runFolder: RUN_FOLDER },
    });

    expect(html).toContain('Recommended');
    expect(html).toContain('The scope is bounded and the proof plan is explicit.');
  });
});

describe('genericCheckpointHtml', () => {
  it('renders a full page from the widened projector context alone', () => {
    const html = genericCheckpointHtml(waitingContext());
    expect(html).toBeDefined();
    if (html === undefined) throw new Error('expected generic checkpoint html');
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Diagnosis did not cleanly reproduce the bug.');
    expect(html).toContain('Continue with a focused fix anyway');
    expect(html).toContain('Stop and hand back');
    expect(html).toContain('--checkpoint-choice &#39;continue&#39;');
    expect(html).toContain('Depth high');
  });

  it('falls back to choice ids when the request carries no labels', () => {
    const html = genericCheckpointHtml(
      waitingContext({ choices: undefined, safe_default_choice: undefined }),
    );
    expect(html).toBeDefined();
    if (html === undefined) throw new Error('expected generic checkpoint html');
    expect(html).toContain('continue');
    expect(html).toContain('stop');
    expect(html).toContain('stays parked');
  });

  it('returns undefined outside a waiting checkpoint', () => {
    const ctx = waitingContext();
    const closed: HtmlProjectorContext = {
      ...ctx,
      runOutcome: 'complete',
      checkpoint: undefined,
    };
    expect(genericCheckpointHtml(closed)).toBeUndefined();
  });
});
