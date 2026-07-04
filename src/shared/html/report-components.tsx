// Shared report components.
//
// Cross-flow building blocks for operator-summary pages, composed from the
// vendored design system (src/shared/html/ui). Every block that expresses a
// semantic intent also carries a data-intent attribute so tests and tooling
// can assert meaning without pinning utility class names.

import type { ReactNode } from 'react';

import { MAX_BULLET_LEN, MAX_PROMPT_LEN } from './page.js';
import { renderHtmlDocument, t } from './react-page.js';
import { Badge } from './ui/badge.js';
import { Card, CardAction, CardHeader, CardTitle } from './ui/card.js';
import { cn } from './ui/utils.js';

export type Intent = 'info' | 'positive' | 'attention' | 'negative' | 'neutral';

const CARD_INTENT_CLASS: Record<Intent, string> = {
  neutral: '',
  info: 'border-info/50 ring-[3px] ring-info/10',
  positive: 'border-positive/60 ring-[3px] ring-positive/10',
  attention: 'border-attention/60 ring-[3px] ring-attention/10',
  negative: 'border-destructive/60 ring-[3px] ring-destructive/10',
};

const BADGE_INTENT_CLASS: Record<Intent, string> = {
  neutral: 'text-muted-foreground',
  info: 'border-info/50 text-info',
  positive: 'border-positive/50 text-positive',
  attention: 'border-attention/60 text-attention',
  negative: 'border-destructive/50 text-destructive',
};

const BANNER_INTENT_CLASS: Record<Intent, string> = {
  neutral: 'border-border bg-muted/40',
  info: 'border-info/50 bg-info/5',
  positive: 'border-positive/50 bg-positive/5',
  attention: 'border-attention/60 bg-attention/5',
  negative: 'border-destructive/50 bg-destructive/5',
};

export function IntentBadge({ text, intent }: { readonly text: string; readonly intent: Intent }) {
  return (
    <Badge
      variant="outline"
      data-intent={intent}
      className={cn('uppercase', BADGE_INTENT_CLASS[intent])}
    >
      {t(text, 120)}
    </Badge>
  );
}

export function Chip({ text }: { readonly text: string }) {
  return (
    <code className="break-words rounded-md border bg-muted px-2 py-1 font-mono text-[11px] leading-normal text-muted-foreground">
      {t(text, MAX_BULLET_LEN)}
    </code>
  );
}

export function ChipRow({ items }: { readonly items: readonly string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <Chip key={item} text={item} />
      ))}
    </div>
  );
}

export function BulletList({ items }: { readonly items: readonly string[] }) {
  return (
    <ul className="m-0 list-disc space-y-1.5 pl-4 text-[13px] leading-normal marker:text-muted-foreground/60">
      {items.map((item) => (
        <li key={item}>{t(item, MAX_BULLET_LEN)}</li>
      ))}
    </ul>
  );
}

export function SectionLabel({ children }: { readonly children: string }) {
  return (
    <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
      {children}
    </p>
  );
}

export function Summary({ text }: { readonly text: string }) {
  return <p className="text-sm text-muted-foreground">{t(text, MAX_PROMPT_LEN)}</p>;
}

export function ReportCard({
  intent = 'neutral',
  eyebrow,
  title,
  badge,
  children,
}: {
  readonly intent?: Intent;
  readonly eyebrow?: string | undefined;
  readonly title: string;
  readonly badge?: { readonly text: string; readonly intent: Intent } | undefined;
  readonly children: ReactNode;
}) {
  return (
    <Card
      {...(intent === 'neutral' ? {} : { 'data-intent': intent })}
      className={cn('gap-4 py-5 shadow-none', CARD_INTENT_CLASS[intent])}
    >
      <CardHeader className="gap-1 px-5">
        {eyebrow === undefined ? null : (
          <div className="font-mono text-[11px] uppercase tracking-[0.05em] text-muted-foreground">
            {t(eyebrow, 120)}
          </div>
        )}
        <CardTitle className="text-base tracking-tight">{t(title, MAX_PROMPT_LEN)}</CardTitle>
        {badge === undefined ? null : (
          <CardAction>
            <IntentBadge text={badge.text} intent={badge.intent} />
          </CardAction>
        )}
      </CardHeader>
      <div className="flex flex-col gap-3.5 px-5">{children}</div>
    </Card>
  );
}

export function VerdictBanner({
  intent,
  badgeText,
  main,
  aside,
}: {
  readonly intent: Intent;
  readonly badgeText: string;
  // Rendered nodes so callers can place <strong> emphasis; operator text
  // inside must already be passed through t().
  readonly main: ReactNode;
  readonly aside?: string | undefined;
}) {
  return (
    <div
      data-slot="verdict"
      data-intent={intent}
      className={cn(
        'mb-6 flex flex-wrap items-baseline gap-3 rounded-lg border px-5 py-4',
        BANNER_INTENT_CLASS[intent],
      )}
    >
      <IntentBadge text={badgeText} intent={intent} />
      <span className="min-w-[200px] flex-1 text-sm">{main}</span>
      {aside === undefined ? null : (
        <span className="text-xs lowercase text-muted-foreground">{t(aside, 160)}</span>
      )}
    </div>
  );
}

// The auto-fit column behavior mirrors the old report grid: cards flow into
// as many 320px-minimum columns as the page width allows.
export function CardGrid({ children }: { readonly children: ReactNode }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(320px,1fr))] gap-4">{children}</div>
  );
}

export type ReportShellInput = {
  readonly metaLine: string;
  readonly headline: string;
  readonly subtitle: string;
  readonly children: ReactNode;
  readonly footerLeft?: string | undefined;
  readonly footerRight?: string | undefined;
  // Extra classes on the page wrapper (e.g. multi-variant's layout hooks).
  readonly wrapClassName?: string | undefined;
};

export function ReportShell(input: ReportShellInput) {
  return (
    <div
      className={cn(
        'mx-auto max-w-6xl px-6 py-12 pb-24 text-[15px] leading-relaxed antialiased',
        input.wrapClassName,
      )}
    >
      <header className="mb-6">
        <div className="mb-2 text-xs font-medium uppercase tracking-[0.06em] text-muted-foreground">
          {t(input.metaLine, 160)}
        </div>
        <h1 className="text-[27px] font-semibold leading-tight tracking-tight text-balance">
          {t(input.headline, MAX_PROMPT_LEN)}
        </h1>
        <p className="mt-2 text-base text-muted-foreground">{t(input.subtitle, MAX_PROMPT_LEN)}</p>
      </header>
      {input.children}
      <footer className="mt-12 flex flex-wrap justify-between gap-3 border-t pt-6 text-xs text-muted-foreground">
        {input.footerLeft === undefined ? null : <span>{t(input.footerLeft, 300)}</span>}
        {input.footerRight === undefined ? null : (
          <span>
            <code className="font-mono text-[11px]">{t(input.footerRight, 300)}</code>
          </span>
        )}
      </footer>
    </div>
  );
}

export type ReportPageInput = ReportShellInput & {
  readonly title: string;
  // Build-time constants only, never operator input.
  readonly extraStyle?: string | undefined;
  readonly extraScript?: string | undefined;
};

export function renderReportPage(input: ReportPageInput): string {
  const { title, extraStyle, extraScript, ...shell } = input;
  return renderHtmlDocument({
    title,
    ...(extraStyle === undefined ? {} : { extraStyle }),
    ...(extraScript === undefined ? {} : { extraScript }),
    body: <ReportShell {...shell} />,
  });
}
