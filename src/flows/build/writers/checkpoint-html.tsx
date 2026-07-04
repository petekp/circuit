// Build checkpoint HTML projector.
//
// Renders only while Build is waiting at its checkpoint. The packet data stays
// in build.brief@v1; this projector owns only the visual arrangement. The page
// shape (ribbon, recommendation, options, do-nothing strip, resume commands)
// comes from the shared checkpoint renderer; Build contributes its context
// cards (artifact, salience, risk, proof) and the raw-evidence appendix, all
// composed from the vendored design system.

import type { ReactNode } from 'react';

import {
  type CheckpointPageOption,
  renderCheckpointPage,
  shellSingleQuote,
} from '../../../shared/html/checkpoint-page.js';
import { MAX_BULLET_LEN, MAX_PROMPT_LEN } from '../../../shared/html/page.js';
import type { HtmlProjector, JsonObject } from '../../../shared/html/projector.js';
import { t } from '../../../shared/html/react-page.js';
import { Card, CardHeader, CardTitle } from '../../../shared/html/ui/card.js';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../../../shared/html/ui/collapsible.js';
import { cn } from '../../../shared/html/ui/utils.js';
import {
  BuildBrief,
  type BuildCheckpointPacket,
  type BuildCheckpointPacketChoice,
} from '../reports.js';

const BUILD_BRIEF_PATH = 'reports/build/brief.json';

type CardIntent = 'neutral' | 'info' | 'attention';

const INTENT_CARD_CLASS: Record<CardIntent, string> = {
  neutral: '',
  info: 'border-info/50 ring-[3px] ring-info/10',
  attention: 'border-attention/60 ring-[3px] ring-attention/10',
};

function SectionLabel({ children }: { readonly children: string }) {
  return (
    <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
      {children}
    </p>
  );
}

function Summary({ text }: { readonly text: string }) {
  return <p className="text-sm text-muted-foreground">{t(text, MAX_PROMPT_LEN)}</p>;
}

function BulletList({ items }: { readonly items: readonly string[] }) {
  return (
    <ul className="m-0 list-disc space-y-1.5 pl-4 text-[13px] leading-normal marker:text-muted-foreground/60">
      {items.map((item) => (
        <li key={item}>{t(item, MAX_BULLET_LEN)}</li>
      ))}
    </ul>
  );
}

function Chip({ text }: { readonly text: string }) {
  return (
    <code className="break-words rounded-md border bg-muted px-2 py-1 font-mono text-[11px] leading-normal text-muted-foreground">
      {t(text, MAX_BULLET_LEN)}
    </code>
  );
}

function ChipRow({ items }: { readonly items: readonly string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <Chip key={item} text={item} />
      ))}
    </div>
  );
}

function ContextCard({
  intent,
  eyebrow,
  title,
  children,
}: {
  readonly intent: CardIntent;
  readonly eyebrow: string;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <Card className={cn('gap-4 py-5 shadow-none', INTENT_CARD_CLASS[intent])}>
      <CardHeader className="gap-1 px-5">
        <div className="font-mono text-[11px] uppercase tracking-[0.05em] text-muted-foreground">
          {t(eyebrow, 120)}
        </div>
        <CardTitle className="text-base tracking-tight">{t(title, MAX_PROMPT_LEN)}</CardTitle>
      </CardHeader>
      <div className="flex flex-col gap-3.5 px-5">{children}</div>
    </Card>
  );
}

function commandText(command: { readonly argv: readonly string[]; readonly cwd: string }): string {
  return `${command.cwd}$ ${command.argv.join(' ')}`;
}

function ArtifactCard({
  brief,
  packet,
}: {
  readonly brief: BuildBrief;
  readonly packet: BuildCheckpointPacket;
}) {
  return (
    <ContextCard intent="info" eyebrow={packet.artifact.title} title={brief.objective}>
      <Summary text={packet.artifact.preview} />
      <div>
        <SectionLabel>Scope</SectionLabel>
        <Summary text={packet.artifact.scope} />
      </div>
      <div>
        <SectionLabel>Success bar</SectionLabel>
        <BulletList items={packet.artifact.success_criteria} />
      </div>
    </ContextCard>
  );
}

function SalienceCard({ packet }: { readonly packet: BuildCheckpointPacket }) {
  return (
    <ContextCard intent="neutral" eyebrow="salience" title="Why this needs you">
      <Summary text={packet.salience.summary} />
      <div>
        <SectionLabel>Why now</SectionLabel>
        <BulletList items={packet.salience.why_now} />
      </div>
      <div>
        <SectionLabel>Stays internal</SectionLabel>
        <BulletList items={packet.salience.hidden_routine_work} />
      </div>
    </ContextCard>
  );
}

function RiskCard({ packet }: { readonly packet: BuildCheckpointPacket }) {
  return (
    <ContextCard intent="attention" eyebrow="manager judgment" title="Risk">
      <Summary text={packet.risk.summary} />
      <div>
        <SectionLabel>Tradeoffs</SectionLabel>
        <BulletList items={packet.risk.tradeoffs} />
      </div>
    </ContextCard>
  );
}

function ProofCard({ packet }: { readonly packet: BuildCheckpointPacket }) {
  return (
    <ContextCard
      intent={packet.proof.status === 'missing' ? 'attention' : 'neutral'}
      eyebrow={packet.proof.status}
      title="Proof"
    >
      <Summary text={packet.proof.summary} />
      <div>
        <SectionLabel>Planned checks</SectionLabel>
        <ChipRow items={packet.proof.commands.map(commandText)} />
      </div>
      <div>
        <SectionLabel>Proof state</SectionLabel>
        <BulletList items={packet.proof.evidence} />
      </div>
    </ContextCard>
  );
}

function RouteExtra({ choice }: { readonly choice: BuildCheckpointPacketChoice }) {
  return (
    <div className="px-6">
      <SectionLabel>Executable route</SectionLabel>
      <ChipRow items={[`${choice.route.key} -> ${choice.route.target}`]} />
    </div>
  );
}

function Appendix({
  packet,
  rawEvidence,
  resumeCommandTemplate,
}: {
  readonly packet: BuildCheckpointPacket;
  readonly rawEvidence: readonly string[];
  readonly resumeCommandTemplate: string;
}) {
  return (
    <Collapsible className="mt-8 rounded-lg border bg-card px-4 py-3">
      <CollapsibleTrigger className="text-[13px] font-medium text-muted-foreground">
        Raw evidence and resume command
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-3 flex flex-col gap-2.5 text-[13px] text-muted-foreground">
        <p>
          <strong className="font-semibold text-foreground">Decision.</strong>{' '}
          {t(packet.decision.question, MAX_PROMPT_LEN)}
        </p>
        <p className="flex flex-wrap items-baseline gap-1.5">
          <strong className="font-semibold text-foreground">Resume command.</strong>
          <Chip text={resumeCommandTemplate} />
        </p>
        <p>
          <strong className="font-semibold text-foreground">Reports.</strong>
        </p>
        <ChipRow items={rawEvidence} />
      </CollapsibleContent>
    </Collapsible>
  );
}

function filteredChoices(
  packetChoices: readonly BuildCheckpointPacketChoice[],
  allowedChoices: readonly string[],
): BuildCheckpointPacketChoice[] {
  const allowed = new Set(allowedChoices);
  return packetChoices.filter((choice) => allowed.has(choice.id));
}

function loadBrief(
  readJsonRunRelative: (relPath: string) => JsonObject | undefined,
): BuildBrief | undefined {
  const raw = readJsonRunRelative(BUILD_BRIEF_PATH);
  const parsed = BuildBrief.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export const buildCheckpointProjector: HtmlProjector = (ctx) => {
  if (ctx.flowId !== 'build' || ctx.runOutcome !== 'checkpoint_waiting') return undefined;
  if (ctx.checkpoint === undefined) return undefined;
  const brief = loadBrief(ctx.readJsonRunRelative);
  if (brief === undefined) return undefined;

  const packet = brief.checkpoint_packet;
  if (packet === undefined) return undefined;
  const choices = filteredChoices(packet.choices, ctx.checkpoint.allowed_choices);
  if (choices.length === 0) return undefined;
  const recommendedChoice =
    choices.find((choice) => choice.id === packet.recommendation.choice_id) ?? choices[0];
  if (recommendedChoice === undefined) return undefined;

  const safeDefaultId = ctx.checkpoint.safe_default_choice;
  const options: CheckpointPageOption[] = choices.map((choice) => ({
    id: choice.id,
    label: choice.label,
    description: choice.description,
    ...(choice.id === recommendedChoice.id ? { isRecommended: true } : {}),
    ...(choice.id === safeDefaultId ? { isDefault: true } : {}),
    extra: <RouteExtra choice={choice} />,
  }));
  const defaultChoice = options.find((option) => option.id === safeDefaultId);

  const resumeCommandTemplate = `circuit resume --run-folder ${shellSingleQuote(
    ctx.runFolder,
  )} --checkpoint-choice '<choice>'`;
  const rawEvidence = [
    BUILD_BRIEF_PATH,
    packet.internal.request_path,
    packet.internal.response_path,
    ...packet.internal.raw_evidence,
    ctx.checkpoint.request_path,
  ];

  return renderCheckpointPage({
    meta: { flowLabel: 'Build', runId: ctx.runId, stepId: ctx.checkpoint.step_id },
    question: brief.objective,
    subtitle: `${packet.decision.question} ${packet.decision.operator_judgment}`,
    ribbon: [
      'Waiting for you',
      ...(ctx.checkpoint.depth === undefined ? [] : [`Depth ${ctx.checkpoint.depth}`]),
      `Proof ${packet.proof.status}`,
    ],
    recommendation: {
      label: packet.recommendation.label,
      rationale: packet.recommendation.rationale,
    },
    options,
    ...(defaultChoice === undefined
      ? {}
      : { defaultChoice: { id: defaultChoice.id, label: defaultChoice.label } }),
    context: (
      <div className="grid gap-4 md:grid-cols-2">
        <ArtifactCard brief={brief} packet={packet} />
        <SalienceCard packet={packet} />
        <RiskCard packet={packet} />
        <ProofCard packet={packet} />
      </div>
    ),
    appendix: (
      <Appendix
        packet={packet}
        rawEvidence={rawEvidence}
        resumeCommandTemplate={resumeCommandTemplate}
      />
    ),
    resume: { runFolder: ctx.runFolder },
    footerLeft: `circuit · build · ${ctx.runId}`,
    footerRight: BUILD_BRIEF_PATH,
  });
};
