// Shared checkpoint page renderer.
//
// A waiting checkpoint is a decision surface, not a report: the operator
// must be able to answer four questions from the page alone — what is being
// asked, what are the options, what happens if I do nothing, and how do I
// respond. renderCheckpointPage renders that shape for every flow; flow
// projectors feed it richer option bodies and context cards, and
// genericCheckpointHtml renders it straight from the projector context so
// a waiting run always has a page even when no flow projector exists.

import { intentBadge } from './components.js';
import { MAX_PROMPT_LEN, escapeHtml, truncate } from './page.js';
import { renderPage } from './page.js';
import type { HtmlProjectorContext } from './projector.js';

export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function resumeCommandForChoice(runFolder: string, choiceId: string): string {
  return `circuit resume --run-folder ${shellSingleQuote(
    runFolder,
  )} --checkpoint-choice ${shellSingleQuote(choiceId)}`;
}

export type CheckpointPageOption = {
  readonly id: string;
  readonly label: string;
  readonly description?: string | undefined;
  readonly isDefault?: boolean | undefined;
  readonly isRecommended?: boolean | undefined;
  // Pre-rendered flow-specific option body (bullets, evidence chips).
  // Callers escape operator-controlled substrings before composing it.
  readonly extraHtml?: string | undefined;
};

export type CheckpointPageInput = {
  readonly meta: {
    readonly flowLabel: string;
    readonly runId: string;
    readonly stepId: string;
  };
  readonly question: string;
  readonly subtitle?: string | undefined;
  readonly ribbon: readonly string[];
  readonly recommendation?:
    | {
        readonly label: string;
        readonly rationale?: string | undefined;
      }
    | undefined;
  readonly options: readonly CheckpointPageOption[];
  readonly defaultChoice?: { readonly id: string; readonly label: string } | undefined;
  // Pre-rendered flow-specific context (e.g. Build's artifact/risk cards).
  readonly contextHtml?: string | undefined;
  // Pre-rendered trailing section (e.g. a raw-evidence details block).
  readonly appendixHtml?: string | undefined;
  readonly resume: { readonly runFolder: string };
  readonly footerLeft?: string | undefined;
  readonly footerRight?: string | undefined;
};

const CHECKPOINT_STYLES =
  '.ribbon{display:flex;flex-wrap:wrap;gap:8px;margin:20px 0 28px}' +
  '.ribbon .tag{font:600 11px/1 -apple-system,system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:var(--text-2);background:var(--surface-2);border:1px solid var(--border);border-radius:999px;padding:6px 12px;white-space:nowrap}' +
  '.rec-why{color:var(--text-2)}' +
  '.opt-list{display:flex;flex-direction:column;gap:12px;margin:8px 0 0}' +
  '.opt{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:18px 20px;display:flex;flex-direction:column;gap:10px}' +
  '.opt.is-recommended{border-color:var(--intent-positive);box-shadow:0 0 0 3px var(--intent-positive-soft)}' +
  '.opt-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}' +
  '.opt-head h2{font:600 16px/1.3 -apple-system,system-ui,sans-serif;margin:0;letter-spacing:-.005em}' +
  '.opt-desc{color:var(--text-2);font-size:14px;margin:0}' +
  '.opt-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding-top:2px}' +
  '.opt-actions code{font:500 12px/1.5 ui-monospace,"SF Mono",Menlo,monospace;color:var(--text-2);background:var(--surface-2);border:1px solid var(--border);border-radius:6px;padding:6px 10px;overflow-x:auto;white-space:pre;max-width:100%}' +
  '.default-strip{display:flex;gap:12px;align-items:baseline;background:var(--surface-2);border:1px dashed var(--border-strong);border-radius:8px;padding:14px 16px;margin:20px 0 0;font-size:13.5px;color:var(--text-2)}' +
  '.default-strip .k{font:600 10px/1.4 -apple-system,system-ui,sans-serif;text-transform:uppercase;letter-spacing:.08em;color:var(--text-3);white-space:nowrap}' +
  '.default-strip strong{color:var(--text)}';

function ribbonHtml(ribbon: readonly string[]): string {
  if (ribbon.length === 0) return '';
  const tags = ribbon
    .map((tag) => `<span class="tag">${escapeHtml(truncate(tag, 120))}</span>`)
    .join('');
  return `  <div class="ribbon">${tags}</div>\n`;
}

function recommendationHtml(rec: CheckpointPageInput['recommendation']): string {
  if (rec === undefined) return '';
  const why =
    rec.rationale === undefined
      ? ''
      : ` <span class="rec-why">${escapeHtml(truncate(rec.rationale, MAX_PROMPT_LEN))}</span>`;
  return `  <div class="verdict intent-positive">
    <span class="badge">Recommended</span>
    <span class="text"><strong>${escapeHtml(rec.label)}</strong>${why}</span>
  </div>\n`;
}

function optionHtml(option: CheckpointPageOption, runFolder: string): string {
  const badges = [
    ...(option.isRecommended === true
      ? [intentBadge({ text: 'Recommended', intent: 'positive' })]
      : []),
    ...(option.isDefault === true ? [intentBadge({ text: 'Default', intent: 'neutral' })] : []),
  ].join('');
  const description =
    option.description === undefined
      ? ''
      : `      <p class="opt-desc">${escapeHtml(truncate(option.description, MAX_PROMPT_LEN))}</p>\n`;
  const extra = option.extraHtml === undefined ? '' : `${option.extraHtml}\n`;
  const command = truncate(resumeCommandForChoice(runFolder, option.id), MAX_PROMPT_LEN);
  const classes = option.isRecommended === true ? 'opt is-recommended' : 'opt';
  return `    <article class="${classes}">
      <div class="opt-head">
        <h2>${escapeHtml(truncate(option.label, MAX_PROMPT_LEN))}</h2>
        ${badges}
      </div>
${description}${extra}      <div class="opt-actions">
        <button class="copy" data-prompt="${escapeHtml(command)}">Copy resume command</button>
        <code>${escapeHtml(command)}</code>
      </div>
    </article>`;
}

function defaultStripHtml(defaultChoice: CheckpointPageInput['defaultChoice']): string {
  const consequence =
    defaultChoice === undefined
      ? 'The run stays parked at this checkpoint until you choose.'
      : `The run stays parked at this checkpoint. The declared default is <strong>${escapeHtml(
          defaultChoice.label,
        )}</strong>.`;
  return `  <div class="default-strip">
    <span class="k">If you do nothing</span>
    <span>${consequence}</span>
  </div>\n`;
}

export function renderCheckpointPage(input: CheckpointPageInput): string {
  const options = input.options
    .map((option) => optionHtml(option, input.resume.runFolder))
    .join('\n');
  const bodyHtml =
    ribbonHtml(input.ribbon) +
    recommendationHtml(input.recommendation) +
    (input.contextHtml === undefined ? '' : `${input.contextHtml}\n`) +
    `  <div class="opt-list">\n${options}\n  </div>\n` +
    defaultStripHtml(input.defaultChoice) +
    (input.appendixHtml === undefined ? '' : `${input.appendixHtml}\n`);
  return renderPage({
    title: `${truncate(input.question, 80)} · Circuit ${input.meta.flowLabel} checkpoint`,
    metaLine: `Circuit · ${input.meta.flowLabel} · checkpoint waiting`,
    headline: truncate(input.question, MAX_PROMPT_LEN),
    subtitle:
      input.subtitle ?? 'This run is paused. Pick an option, then resume from the terminal.',
    bodyHtml,
    footerLeft: input.footerLeft ?? `circuit · ${input.meta.stepId} · ${input.meta.runId}`,
    ...(input.footerRight === undefined ? {} : { footerRight: input.footerRight }),
    extraStyles: CHECKPOINT_STYLES,
  });
}

function flowLabelFromId(flowId: string): string {
  return flowId
    .split('-')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

// Renders the generic checkpoint page from the projector context alone.
// This is the writer's structural fallback: it runs for any waiting
// checkpoint whose flow has no projector (or whose projector produced
// nothing), and it must render even when the request file was unreadable —
// in that case the widened fields are absent and choice ids stand in as
// labels. Returns undefined outside a waiting checkpoint.
export function genericCheckpointHtml(ctx: HtmlProjectorContext): string | undefined {
  if (ctx.runOutcome !== 'checkpoint_waiting') return undefined;
  const checkpoint = ctx.checkpoint;
  if (checkpoint === undefined) return undefined;

  // Options come from the request's labeled choices, filtered to the
  // allowed ids the runtime vouched for; any allowed id the request did
  // not cover still gets a row so every legal resume path is visible.
  const allowed = new Set(checkpoint.allowed_choices);
  const labeled = (checkpoint.choices ?? []).filter((choice) => allowed.has(choice.id));
  const covered = new Set(labeled.map((choice) => choice.id));
  const options: CheckpointPageOption[] = [
    ...labeled.map((choice) => ({
      id: choice.id,
      label: choice.label ?? choice.id,
      ...(choice.description === undefined ? {} : { description: choice.description }),
      ...(checkpoint.safe_default_choice === choice.id ? { isDefault: true } : {}),
    })),
    ...checkpoint.allowed_choices
      .filter((id) => !covered.has(id))
      .map((id) => ({
        id,
        label: id,
        ...(checkpoint.safe_default_choice === id ? { isDefault: true } : {}),
      })),
  ];
  if (options.length === 0) return undefined;

  const defaultOption =
    checkpoint.safe_default_choice === undefined
      ? undefined
      : options.find((option) => option.id === checkpoint.safe_default_choice);

  const flowLabel = flowLabelFromId(ctx.flowId);
  const question =
    checkpoint.prompt ??
    `The ${flowLabel} flow is waiting for your choice at ${checkpoint.step_id}.`;
  const ribbon = [
    'Waiting for you',
    ...(checkpoint.depth === undefined ? [] : [`Depth ${checkpoint.depth}`]),
    `${options.length} ${options.length === 1 ? 'choice' : 'choices'}`,
  ];
  const requestPath = checkpoint.request_path.startsWith(`${ctx.runFolder}/`)
    ? checkpoint.request_path.slice(ctx.runFolder.length + 1)
    : checkpoint.request_path;

  return renderCheckpointPage({
    meta: { flowLabel, runId: ctx.runId, stepId: checkpoint.step_id },
    question,
    ribbon,
    options,
    ...(defaultOption === undefined
      ? {}
      : { defaultChoice: { id: defaultOption.id, label: defaultOption.label } }),
    resume: { runFolder: ctx.runFolder },
    footerLeft: `circuit · ${checkpoint.step_id} · ${ctx.runId}`,
    footerRight: requestPath,
  });
}
