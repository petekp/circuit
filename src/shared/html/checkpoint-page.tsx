// Shared checkpoint page renderer.
//
// A waiting checkpoint is a decision surface, not a report: the operator
// must be able to answer four questions from the page alone — what is being
// asked, what are the options, what happens if I do nothing, and how do I
// respond. renderCheckpointPage renders that shape for every flow; flow
// projectors feed it richer option bodies and context sections, and
// genericCheckpointHtml renders it straight from the projector context so
// a waiting run always has a page even when no flow projector exists.
//
// Rendered with the vendored design system (src/shared/html/ui) through
// the React document shell; output is static, single-file HTML.

import type { ReactNode } from 'react';

import { MAX_PROMPT_LEN, truncate } from './page.js';
import type { HtmlProjectorContext } from './projector.js';
import { renderHtmlDocument, t } from './react-page.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import { Card } from './ui/card.js';

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
  // Flow-specific option body (bullets, evidence chips) as rendered nodes.
  readonly extra?: ReactNode | undefined;
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
  // Flow-specific context (e.g. Build's artifact/risk cards).
  readonly context?: ReactNode | undefined;
  // Trailing section (e.g. a raw-evidence disclosure block).
  readonly appendix?: ReactNode | undefined;
  readonly resume: { readonly runFolder: string };
  readonly footerLeft?: string | undefined;
  readonly footerRight?: string | undefined;
};

function Ribbon({ tags }: { readonly tags: readonly string[] }) {
  if (tags.length === 0) return null;
  return (
    <div data-slot="ribbon" className="mb-7 flex flex-wrap gap-2">
      {tags.map((tag) => (
        <Badge
          key={tag}
          variant="secondary"
          className="rounded-full px-3 py-1 text-[11px] uppercase tracking-[0.06em] text-muted-foreground"
        >
          {t(tag, 120)}
        </Badge>
      ))}
    </div>
  );
}

function Recommendation({
  recommendation,
}: {
  readonly recommendation: NonNullable<CheckpointPageInput['recommendation']>;
}) {
  return (
    <div
      data-slot="recommendation"
      className="mb-6 flex flex-wrap items-baseline gap-3 rounded-lg border border-positive/50 bg-positive/5 px-5 py-4"
    >
      <Badge variant="outline" className="border-positive/50 uppercase text-positive">
        Recommended
      </Badge>
      <span className="min-w-[200px] flex-1 text-sm">
        <strong className="font-semibold">{t(recommendation.label, MAX_PROMPT_LEN)}</strong>
        {recommendation.rationale === undefined ? null : (
          <span className="text-muted-foreground">
            {' '}
            {t(recommendation.rationale, MAX_PROMPT_LEN)}
          </span>
        )}
      </span>
    </div>
  );
}

function OptionCard({
  option,
  runFolder,
}: {
  readonly option: CheckpointPageOption;
  readonly runFolder: string;
}) {
  const command = truncate(resumeCommandForChoice(t(runFolder), option.id), MAX_PROMPT_LEN);
  return (
    <Card
      data-slot="option"
      className={
        option.isRecommended === true
          ? 'gap-2.5 border-positive/60 py-5 shadow-none ring-[3px] ring-positive/10'
          : 'gap-2.5 py-5 shadow-none'
      }
    >
      <div className="flex flex-wrap items-center gap-2.5 px-6">
        <h2 className="text-base font-semibold leading-snug tracking-tight">
          {t(option.label, MAX_PROMPT_LEN)}
        </h2>
        {option.isRecommended === true ? (
          <Badge variant="outline" className="border-positive/50 uppercase text-positive">
            Recommended
          </Badge>
        ) : null}
        {option.isDefault === true ? (
          <Badge variant="secondary" className="uppercase text-muted-foreground">
            Default
          </Badge>
        ) : null}
      </div>
      {option.description === undefined ? null : (
        <p className="px-6 text-sm text-muted-foreground">
          {t(option.description, MAX_PROMPT_LEN)}
        </p>
      )}
      {option.extra ?? null}
      <div className="flex flex-wrap items-center gap-2.5 px-6 pt-0.5">
        <Button variant="outline" size="sm" data-prompt={command}>
          Copy resume command
        </Button>
        <code className="max-w-full overflow-x-auto whitespace-pre rounded-md border bg-muted px-2.5 py-1.5 font-mono text-xs text-muted-foreground">
          {command}
        </code>
      </div>
    </Card>
  );
}

function DefaultStrip({
  defaultChoice,
}: {
  readonly defaultChoice: CheckpointPageInput['defaultChoice'];
}) {
  return (
    <div
      data-slot="default-strip"
      className="mt-5 flex flex-wrap items-baseline gap-3 rounded-lg border border-dashed border-border px-4 py-3.5 text-[13.5px] text-muted-foreground"
    >
      <span className="whitespace-nowrap text-[10px] font-semibold uppercase tracking-[0.08em]">
        If you do nothing
      </span>
      {defaultChoice === undefined ? (
        <span>The run stays parked at this checkpoint until you choose.</span>
      ) : (
        <span>
          The run stays parked at this checkpoint. The declared default is{' '}
          <strong className="font-semibold text-foreground">
            {t(defaultChoice.label, MAX_PROMPT_LEN)}
          </strong>
          .
        </span>
      )}
    </div>
  );
}

function CheckpointPage({ input }: { readonly input: CheckpointPageInput }) {
  const subtitle =
    input.subtitle ?? 'This run is paused. Pick an option, then resume from the terminal.';
  return (
    <div className="mx-auto max-w-4xl px-6 py-12 pb-24 text-[15px] leading-relaxed antialiased">
      <header className="mb-6">
        <div className="mb-2 text-xs font-medium uppercase tracking-[0.06em] text-muted-foreground">
          {t(`Circuit · ${input.meta.flowLabel} · checkpoint waiting`, 160)}
        </div>
        <h1 className="text-[27px] font-semibold leading-tight tracking-tight text-balance">
          {t(input.question, MAX_PROMPT_LEN)}
        </h1>
        <p className="mt-2 text-base text-muted-foreground">{t(subtitle, MAX_PROMPT_LEN)}</p>
      </header>
      <Ribbon tags={input.ribbon} />
      {input.recommendation === undefined ? null : (
        <Recommendation recommendation={input.recommendation} />
      )}
      {input.context ?? null}
      <div data-slot="option-list" className="mt-2 flex flex-col gap-3">
        {input.options.map((option) => (
          <OptionCard key={option.id} option={option} runFolder={input.resume.runFolder} />
        ))}
      </div>
      <DefaultStrip defaultChoice={input.defaultChoice} />
      {input.appendix ?? null}
      <footer className="mt-12 flex flex-wrap justify-between gap-3 border-t pt-6 text-xs text-muted-foreground">
        <span>
          {t(input.footerLeft ?? `circuit · ${input.meta.stepId} · ${input.meta.runId}`, 300)}
        </span>
        {input.footerRight === undefined ? null : (
          <span>
            <code className="font-mono text-[11px]">{t(input.footerRight, 300)}</code>
          </span>
        )}
      </footer>
    </div>
  );
}

export function renderCheckpointPage(input: CheckpointPageInput): string {
  return renderHtmlDocument({
    title: `${truncate(input.question, 80)} · Circuit ${input.meta.flowLabel} checkpoint`,
    body: <CheckpointPage input={input} />,
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
