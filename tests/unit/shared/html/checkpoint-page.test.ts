import { describe, expect, it } from 'vitest';

import {
  genericCheckpointHtml,
  renderCheckpointPage,
} from '../../../../src/shared/html/checkpoint-page.js';
import { CHECKPOINT_REVIEW_RUNTIME } from '../../../../src/shared/html/checkpoint-review-runtime.generated.js';
import type { HtmlProjectorContext } from '../../../../src/shared/html/projector.js';

const RUN_FOLDER = '/tmp/circuit-run';
const REVIEW_IDENTITY = { attempt: 2, requestSha256: 'b'.repeat(64) } as const;

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
      attempt: REVIEW_IDENTITY.attempt,
      request_sha256: REVIEW_IDENTITY.requestSha256,
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
      resume: {
        runFolder: RUN_FOLDER,
        commandPrefix: "'/usr/local/bin/node' '/tmp/circuit-plugin/scripts/circuit.js' resume",
        ...REVIEW_IDENTITY,
      },
      footerLeft: 'circuit · fix · run-1',
      footerRight: 'reports/checkpoints/fix-no-repro-decision-request.json',
    });

    // The question is the hero headline.
    expect(html).toMatch(/<h1[^>]*>Diagnosis did not cleanly reproduce the bug\./);
    // Context ribbon chips are present.
    expect(html).toContain('Waiting for you');
    expect(html).toContain('Depth high');
    // The default choice is marked on its option and stated in the strip.
    expect(html).toContain('Default');
    expect(html).toMatch(/If you do nothing/);
    expect(html).toContain('Continue with a focused fix anyway');
    // The page is one decision workspace: choose, comment, then prepare one
    // typed response. Legacy choice commands remain available without JS.
    expect(html).toContain('data-cp-workspace');
    expect(html).toContain('data-cp-option');
    expect(html).toContain('data-cp-comment');
    expect(html).toContain('data-cp-finish');
    expect(html).toContain('aria-labelledby="cp-dialog-title"');
    expect(html).toContain('Saved in this browser');
    expect(html).toContain('--checkpoint-response');
    expect(html).toContain(
      'data-resume-prefix="&#x27;/usr/local/bin/node&#x27; &#x27;/tmp/circuit-plugin/scripts/circuit.js&#x27; resume"',
    );
    expect(html).toContain(CHECKPOINT_REVIEW_RUNTIME);
    expect(html.match(/checkpoint\.review-draft@v1/g)).toHaveLength(1);
    expect(html).toContain('checkpoint.review-response@v1');
    expect(html).toContain('data-cp-confirm-summary');
    expect(html).toContain('data-cp-note-count');
    expect(html).toContain('data-cp-live');
    expect(html).toContain('data-attempt="2"');
    expect(html).toContain(`data-request-sha256="${REVIEW_IDENTITY.requestSha256}"`);
    expect(html).toContain(
      `&#x27;/usr/local/bin/node&#x27; &#x27;/tmp/circuit-plugin/scripts/circuit.js&#x27; resume --run-folder &#x27;${RUN_FOLDER}&#x27; --checkpoint-choice &#x27;continue&#x27;`,
    );
    expect(html).toContain(
      `&#x27;/usr/local/bin/node&#x27; &#x27;/tmp/circuit-plugin/scripts/circuit.js&#x27; resume --run-folder &#x27;${RUN_FOLDER}&#x27; --checkpoint-choice &#x27;stop&#x27;`,
    );
  });

  it('states the parked outcome when no default choice exists', () => {
    const html = renderCheckpointPage({
      meta: { flowLabel: 'Explainer', runId: 'run-2', stepId: 'publish-gate' },
      question: 'Authorize publishing only if the site is faithful.',
      ribbon: ['Waiting for you'],
      options: [{ id: 'publish', label: 'Publish the explainer' }],
      resume: { runFolder: RUN_FOLDER, commandPrefix: 'circuit resume', ...REVIEW_IDENTITY },
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
      resume: { runFolder: RUN_FOLDER, commandPrefix: 'circuit resume', ...REVIEW_IDENTITY },
    });

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
  });

  it('preserves a long canonical choice id in the response identity', () => {
    const choiceId = `choice-${'x'.repeat(180)}`;
    const html = renderCheckpointPage({
      meta: { flowLabel: 'Fix', runId: 'run-3b', stepId: 's' },
      question: 'Choose one.',
      ribbon: [],
      options: [{ id: choiceId, label: 'Continue' }],
      resume: { runFolder: RUN_FOLDER, commandPrefix: 'circuit resume', ...REVIEW_IDENTITY },
    });

    expect(html).toContain(`data-cp-choice-id="${choiceId}"`);
  });

  it('does not sanitize canonical choice ids in response data', () => {
    const choiceId = 'choice:\u202eraw';
    const html = renderCheckpointPage({
      meta: { flowLabel: 'Fix', runId: 'run-3c', stepId: 's' },
      question: 'Choose one.',
      ribbon: [],
      options: [{ id: choiceId, label: 'Continue' }],
      resume: { runFolder: RUN_FOLDER, commandPrefix: 'circuit resume', ...REVIEW_IDENTITY },
    });

    expect(html).toContain(`data-cp-choice-id="${choiceId}"`);
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
      resume: { runFolder: RUN_FOLDER, commandPrefix: 'circuit resume', ...REVIEW_IDENTITY },
    });

    expect(html).toContain('Suggested');
    expect(html).toContain('Why Circuit suggested Confirm and build');
    expect(html).toContain('The scope is bounded and the proof plan is explicit.');
  });

  it('renders the shared resilient review-shell contract', () => {
    const html = renderCheckpointPage({
      meta: { flowLabel: 'Fix', runId: 'run-5', stepId: 'decision-step' },
      question: `Choose safely after ${'unbroken'.repeat(80)}`,
      ribbon: [],
      options: [
        { id: 'continue', label: `Continue ${'without-a-break'.repeat(30)}` },
        { id: 'stop', label: 'Stop' },
      ],
      resume: { runFolder: RUN_FOLDER, commandPrefix: 'circuit resume', ...REVIEW_IDENTITY },
    });

    expect(html).toContain('data-cp-interactive');
    expect(html).toContain('data-cp-confirm-summary');
    expect(html).toContain('href="#cp-options"');
    expect(html).toContain('id="cp-options"');
    expect(html).toMatch(/tabindex="-1"/i);
    expect(html).toContain('overflow-wrap:anywhere');
    expect(html).toContain(
      '.cp-dialog h2{margin-top:5px;overflow-wrap:anywhere;word-break:break-word',
    );
    expect(html).toContain('max-height:calc(100dvh - 32px)');
    expect(html).toContain('margin:auto');
    expect(html).toContain('[data-cp-interactive]{display:none!important}');
  });

  it('announces prepared-decision status changes to assistive technology', () => {
    const html = renderCheckpointPage({
      meta: { flowLabel: 'Fix', runId: 'run-6', stepId: 'decision-step' },
      question: 'Choose how this run should continue.',
      ribbon: [],
      options: [{ id: 'continue', label: 'Continue' }],
      resume: { runFolder: RUN_FOLDER, commandPrefix: 'circuit resume', ...REVIEW_IDENTITY },
    });

    const commandState = html.match(/<div[^>]*data-cp-command-state=""[^>]*>/)?.[0];
    expect(commandState).toBeDefined();
    expect(commandState).toContain('role="status"');
    expect(commandState).toContain('aria-live="polite"');
  });

  it('keeps the real question and choice descriptions in the no-JavaScript review', () => {
    const question = 'Should this carefully scoped change continue?';
    const description = 'Continue only after the focused browser proof is green.';
    const html = renderCheckpointPage({
      meta: { flowLabel: 'Fix', runId: 'run-7', stepId: 'decision-step' },
      question,
      ribbon: [],
      options: [{ id: 'continue', label: 'Continue', description }],
      resume: { runFolder: RUN_FOLDER, commandPrefix: 'circuit resume', ...REVIEW_IDENTITY },
    });

    const noScript = html.match(/<noscript>([\s\S]*?)<\/noscript>/)?.[1];
    expect(noScript).toBeDefined();
    expect(noScript).toContain(question);
    expect(noScript).toContain(description);
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
    expect(html).toContain('--checkpoint-choice &#x27;continue&#x27;');
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
