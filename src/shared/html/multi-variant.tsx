// Shared multi-variant checkpoint HTML renderer.
//
// Keeps the comparison structure reusable while letting each flow decide what
// evidence, labels, and resume commands mean. Visual artifacts get a focused
// review workspace. Non-visual variants stay evidence-first and avoid preview
// chrome.
//
// The review workspace and evidence rows are bespoke layouts, so they keep a
// small page-specific stylesheet (mv-*) on top of the design system; the
// content inside the cells is composed from the shared report components.

import type { ReactNode } from 'react';

import {
  ARTIFACT_PREVIEW_SCRIPT,
  ARTIFACT_PREVIEW_STYLE,
  type ArtifactPreview,
  ArtifactPreviewFrame,
  artifactPreviewFallbackCopy,
  isPreviewableArtifactPath,
  previewForEntryPoints,
  runArtifactPreviewHref,
} from './artifact-preview.js';
import { CHECKPOINT_REVIEW_RUNTIME } from './checkpoint-review-runtime.generated.js';
import { MAX_BULLET_LEN, MAX_PROMPT_LEN } from './page.js';
import { renderHtmlDocument, t } from './react-page.js';
import {
  BulletList,
  ChipRow,
  type Intent,
  IntentBadge,
  SectionLabel,
  VerdictBanner,
  renderReportPage,
} from './report-components.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';

export type MultiVariantPreview = ArtifactPreview;

export { isPreviewableArtifactPath, previewForEntryPoints, runArtifactPreviewHref };

export type MultiVariantFact = {
  readonly label: string;
  readonly value: string;
};

export type MultiVariantAction = {
  readonly label: string;
  readonly prompt: string;
  readonly primary?: boolean;
};

export type MultiVariantItem = {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly recommended: boolean;
  readonly facts: readonly MultiVariantFact[];
  readonly evidence: readonly string[];
  readonly risks?: readonly string[];
  readonly preview?: MultiVariantPreview;
  readonly action?: MultiVariantAction;
};

export type MultiVariantComparisonInput = {
  readonly title: string;
  readonly metaLine: string;
  readonly headline: string;
  readonly subtitle: string;
  readonly recommendation: {
    readonly label: string;
    readonly rationale: string;
    readonly badgeText: string;
    readonly intent: Intent;
    readonly aside?: string;
  };
  readonly variants: readonly MultiVariantItem[];
  readonly resume?:
    | {
        readonly runFolder: string;
        readonly runId: string;
        readonly stepId: string;
        readonly commandPrefix: string;
        readonly attempt: number;
        readonly requestSha256: string;
      }
    | undefined;
  // Trailing section (e.g. a raw-evidence disclosure block).
  readonly details?: ReactNode;
  readonly footerLeft?: string;
  readonly footerRight?: string;
};

// The visual comparison is a full-height review workspace. The artifact owns
// the room; prose and evidence live in a compact inspector and disclosures.
const MULTI_VARIANT_STYLE = [
  ARTIFACT_PREVIEW_STYLE,
  '.mv-wrap.mv-visual{min-width:0;min-height:100dvh;max-width:none;width:100%;padding:0;background:var(--background)}',
  '.mv-review-ui{height:100dvh;min-width:0;display:grid;grid-template-rows:auto auto minmax(0,1fr) auto}',
  '.mv-skip{position:fixed;left:12px;top:10px;z-index:50;transform:translateY(-150%);border-radius:8px;background:var(--foreground);color:var(--background);padding:9px 12px;font-size:13px}',
  '.mv-skip:focus{transform:translateY(0)}',
  '.mv-topbar{min-width:0;display:flex;align-items:center;justify-content:space-between;gap:24px;padding:16px 20px 14px;border-bottom:1px solid var(--border);background:color-mix(in oklab,var(--background) 94%,transparent)}',
  '.mv-heading{min-width:0;flex:1;display:flex;align-items:baseline;gap:12px}',
  '.mv-heading h1{min-width:0;overflow-wrap:anywhere;word-break:break-word;font-size:19px;line-height:1.2;font-weight:620;letter-spacing:-.02em}',
  '.mv-heading p{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;color:var(--muted-foreground)}',
  '.mv-progress{flex:none;font-size:12px;color:var(--muted-foreground);white-space:nowrap}',
  '.mv-tabs{min-width:0;max-width:100%;display:flex;gap:8px;overflow-x:auto;padding:9px 14px;border-bottom:1px solid var(--border);scrollbar-width:none;background:var(--background)}',
  '.mv-tabs::-webkit-scrollbar{display:none}',
  '.mv-tab{position:relative;min-width:0;flex:none;display:flex;align-items:center;gap:8px;min-height:44px;max-width:300px;padding:8px 12px;border:1px solid transparent;border-radius:10px;color:var(--muted-foreground);text-align:left;white-space:nowrap;cursor:pointer;touch-action:manipulation}',
  '.mv-tab[aria-selected="true"]{border-color:var(--border);background:var(--card);color:var(--foreground);box-shadow:0 1px 2px rgba(0,0,0,.05)}',
  '.mv-tab:focus-visible{outline:3px solid color-mix(in oklab,var(--ring) 45%,transparent);outline-offset:1px}',
  '.mv-tab-title{min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:13px;font-weight:560}',
  '.mv-tab-index{font:600 10px/1 ui-monospace,"SF Mono",Menlo,monospace;color:var(--muted-foreground)}',
  '.mv-tab-note{min-width:18px;height:18px;border-radius:999px;background:var(--secondary);padding:0 5px;font-size:10px;line-height:18px;text-align:center}',
  '.mv-suggested{font-size:10px;font-weight:650;color:var(--positive);text-transform:uppercase;letter-spacing:.045em}',
  '.mv-main{min-width:0;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) minmax(300px,350px)}',
  '.mv-main>*{min-width:0}',
  '.mv-stage{min-width:0;min-height:0;display:grid;grid-template-rows:auto minmax(0,1fr);background:var(--muted)}',
  '.mv-stagebar{min-width:0;display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:48px;padding:8px 14px;border-bottom:1px solid var(--border);background:var(--background)}',
  '.mv-stage-title{min-width:0;font-size:13px;font-weight:560;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.mv-stage-actions{min-width:0;flex:none;display:flex;align-items:center;gap:6px}',
  '.mv-icon-button,.mv-open-link{display:inline-flex;align-items:center;justify-content:center;min-width:44px;min-height:36px;border:1px solid var(--border);border-radius:8px;background:var(--background);color:var(--foreground);font-size:12px;text-decoration:none}',
  '.mv-open-link{gap:6px;padding:0 10px;white-space:nowrap}',
  '.mv-icon-button:active,.mv-open-link:active,.mv-primary:active{transform:scale(.97)}',
  '.mv-canvas{position:relative;min-width:0;min-height:0;margin:12px;border:1px solid var(--border);border-radius:12px;background:white;overflow:hidden;box-shadow:0 14px 36px rgba(24,24,27,.08)}',
  '.mv-panel{position:absolute;inset:0;min-width:0}',
  '.mv-inspector{min-width:0;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;border-left:1px solid var(--border);background:var(--background);padding:20px}',
  '.mv-inspector-head{display:flex;align-items:center;gap:8px;margin-bottom:9px}',
  '.mv-inspector h2{min-width:0;overflow-wrap:anywhere;word-break:break-word;font-size:20px;line-height:1.25;font-weight:620;letter-spacing:-.025em}',
  '.mv-description{overflow-wrap:anywhere;margin:8px 0 20px;color:var(--muted-foreground);font-size:13px;line-height:1.5}',
  '.mv-field-label{display:block;margin-bottom:7px;font-size:12px;font-weight:600}',
  '.mv-comment{display:block;width:100%;min-height:112px;resize:vertical;border:1px solid var(--input);border-radius:10px;background:var(--background);padding:11px 12px;font-size:13px;line-height:1.45;outline:none}',
  '.mv-comment:focus{border-color:var(--ring);box-shadow:0 0 0 3px color-mix(in oklab,var(--ring) 20%,transparent)}',
  '.mv-save-state{min-height:18px;margin:7px 0 18px;color:var(--muted-foreground);font-size:11px}',
  '.mv-disclosure{border-top:1px solid var(--border)}',
  '.mv-disclosure:last-of-type{border-bottom:1px solid var(--border)}',
  '.mv-disclosure summary{cursor:pointer;display:flex;align-items:center;justify-content:space-between;min-height:44px;font-size:13px;font-weight:560;list-style:none}',
  '.mv-disclosure summary::-webkit-details-marker{display:none}',
  '.mv-disclosure summary::after{content:"+";color:var(--muted-foreground);font-size:17px;font-weight:400}',
  '.mv-disclosure[open] summary::after{content:"−"}',
  '.mv-disclosure-body{min-width:0;padding:0 0 16px;overflow-wrap:anywhere;color:var(--muted-foreground);font-size:12.5px;line-height:1.5}',
  '.mv-facts{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px}',
  '.mv-fact b{display:block;margin-bottom:2px;color:var(--muted-foreground);font-size:9px;text-transform:uppercase;letter-spacing:.06em}',
  '.mv-fact span{overflow-wrap:anywhere;word-break:break-word;color:var(--foreground);font-size:11.5px}',
  '.mv-technical-list{display:flex;flex-direction:column;gap:6px;margin-top:9px}',
  '.mv-technical-list code{overflow-wrap:anywhere;font:500 10px/1.4 ui-monospace,"SF Mono",Menlo,monospace}',
  '.mv-footer{min-width:0;display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:64px;padding:10px 14px;border-top:1px solid var(--border);background:var(--background)}',
  '.mv-footer-group{min-width:0;display:flex;align-items:center;gap:8px}',
  '.mv-secondary,.mv-primary{min-width:0;min-height:42px;border-radius:9px;padding:0 15px;font-size:13px;font-weight:580;cursor:pointer;touch-action:manipulation}',
  '.mv-secondary{border:1px solid var(--border);background:var(--background)}',
  '.mv-primary{border:1px solid var(--primary);background:var(--primary);color:var(--primary-foreground)}',
  '.mv-dialog{position:fixed;inset:0;width:min(520px,calc(100vw - 32px));max-height:calc(100dvh - 32px);margin:auto;overflow:auto;border:1px solid var(--border);border-radius:16px;background:var(--background);color:var(--foreground);padding:0;box-shadow:0 28px 90px rgba(0,0,0,.22)}',
  '.mv-dialog::backdrop{background:rgba(0,0,0,.32);backdrop-filter:blur(3px)}',
  '.mv-dialog-body{padding:24px}',
  '.mv-dialog h2{overflow-wrap:anywhere;word-break:break-word;font-size:22px;font-weight:620;letter-spacing:-.025em}',
  '.mv-dialog-copy{margin:7px 0 18px;overflow-wrap:anywhere;color:var(--muted-foreground);font-size:13px}',
  '.mv-dialog-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;margin-top:18px}',
  '.mv-command{display:block;max-height:110px;overflow:auto;margin-top:14px;border:1px solid var(--border);border-radius:9px;background:var(--muted);padding:10px;font:500 10px/1.45 ui-monospace,"SF Mono",Menlo,monospace;overflow-wrap:anywhere;user-select:all}',
  '.mv-command-state{min-height:18px;margin-top:8px;color:var(--muted-foreground);font-size:11px}',
  '.mv-live{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}',
  '.mv-noscript{width:min(760px,calc(100% - 32px));margin:24px auto;border:1px solid var(--border);border-radius:16px;background:var(--background);padding:24px}',
  '.mv-noscript h1{overflow-wrap:anywhere;font-size:24px;line-height:1.2;font-weight:650;letter-spacing:-.025em}',
  '.mv-noscript>p{margin-top:8px;color:var(--muted-foreground)}',
  '.mv-noscript-list{display:grid;gap:12px;margin-top:20px}',
  '.mv-noscript-option{min-width:0;border:1px solid var(--border);border-radius:12px;background:var(--muted);padding:15px}',
  '.mv-noscript-option strong{display:block;overflow-wrap:anywhere;font-size:14px}',
  '.mv-noscript-option span,.mv-noscript-option a{display:block;margin-top:4px;overflow-wrap:anywhere;color:var(--muted-foreground);font-size:12px}',
  '.mv-noscript code{display:block;margin-top:10px;overflow-wrap:anywhere;white-space:pre-wrap;user-select:all;font:500 13px/1.55 ui-monospace,"SF Mono",Menlo,monospace}',
  '.mv-wrap.mv-evidence{max-width:980px}',
  '.mv-evidence-row{display:grid;grid-template-columns:minmax(150px,200px) minmax(0,1fr);gap:10px 24px;padding:20px 0;border-top:1px solid var(--border)}',
  '.mv-evidence-cell{grid-column:2}',
  '@media (max-width:900px){.mv-review-ui{height:auto;min-height:100dvh;grid-template-rows:auto auto auto auto}.mv-topbar{align-items:flex-start}.mv-heading{display:block}.mv-heading p{margin-top:4px}.mv-main{grid-template-columns:1fr}.mv-stage{height:68dvh;min-height:520px}.mv-inspector{border-left:0;border-top:1px solid var(--border);overflow:visible}.mv-footer{position:sticky;bottom:0;z-index:20}.mv-progress{display:none}}',
  '@media (max-width:600px){.mv-topbar{padding:13px 14px}.mv-heading h1{font-size:17px}.mv-heading p{display:none}.mv-tabs{padding-inline:8px}.mv-tab{max-width:230px}.mv-stage{height:62dvh;min-height:430px}.mv-stagebar{padding-inline:10px}.mv-canvas{margin:8px}.mv-inspector{padding:18px 16px}.mv-footer{display:grid;grid-template-columns:minmax(0,1fr) auto;padding:8px}.mv-footer-group:first-child{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.mv-footer .mv-open-link{display:none}.mv-secondary,.mv-primary{width:100%;padding-inline:10px}.mv-dialog{inset:auto 8px 8px;width:auto;max-height:calc(100dvh - 16px);margin:auto 0 0;border-radius:18px}.mv-dialog-body{padding:20px}.mv-dialog-actions{display:grid;grid-template-columns:1fr}.mv-noscript{width:calc(100% - 20px);margin:10px auto;padding:18px}.mv-noscript code{font-size:12px}.mv-evidence-row{grid-template-columns:1fr;gap:9px}.mv-evidence-cell{grid-column:1}}',
  '@media (prefers-reduced-motion:reduce){.mv-icon-button,.mv-open-link,.mv-primary{transition:none}}',
].join('');

const MULTI_VARIANT_REVIEW_SCRIPT = `${CHECKPOINT_REVIEW_RUNTIME}\n${ARTIFACT_PREVIEW_SCRIPT}`;

function VariantFacts({ facts }: { readonly facts: readonly MultiVariantFact[] }) {
  if (facts.length === 0) return null;
  return (
    <div className="grid grid-cols-1 gap-2.5 text-[13px] text-muted-foreground sm:grid-cols-2">
      {facts.map((fact) => (
        <span key={fact.label}>
          <b className="mb-0.5 block text-[11px] font-semibold uppercase text-muted-foreground/80">
            {t(fact.label, 120)}
          </b>
          {t(fact.value, MAX_BULLET_LEN)}
        </span>
      ))}
    </div>
  );
}

function EvidenceRow({ variant }: { readonly variant: MultiVariantItem }) {
  const evidence = Array.from(new Set(variant.evidence));
  return (
    <article className="mv-evidence-row">
      <div className="mv-name">
        <strong>{t(variant.label, 160)}</strong>
        {variant.recommended ? (
          <IntentBadge text="Recommended" intent="positive" />
        ) : (
          <Badge variant="outline" className="text-muted-foreground">
            {t(variant.id, 120)}
          </Badge>
        )}
      </div>
      <div className="mv-copy text-sm">
        <p>{t(variant.description, 360)}</p>
        <VariantFacts facts={variant.facts} />
        {variant.risks === undefined || variant.risks.length === 0 ? null : (
          <div className="mt-2.5">
            <SectionLabel>Risks</SectionLabel>
            <BulletList items={variant.risks} />
          </div>
        )}
      </div>
      <div className="mv-evidence-cell mt-3">
        {evidence.length === 0 ? null : <ChipRow items={evidence} />}
        <div className="mt-3 flex flex-wrap gap-2">
          {variant.action === undefined ? null : (
            <Button
              variant={variant.action.primary === false ? 'outline' : 'default'}
              size="sm"
              data-prompt={t(variant.action.prompt, MAX_PROMPT_LEN)}
            >
              {t(variant.action.label, 120)}
            </Button>
          )}
        </div>
      </div>
    </article>
  );
}

function VisualPanel({
  variant,
  selected,
  index,
}: {
  readonly variant: MultiVariantItem;
  readonly selected: boolean;
  readonly index: number;
}) {
  const preview = variant.preview ?? { status: 'unavailable' as const };
  return (
    <div
      className="mv-panel"
      id={`mv-panel-${index}`}
      data-mv-panel=""
      data-artifact-preview-panel=""
      data-mv-variant-id={variant.id}
      role="tabpanel"
      aria-labelledby={`mv-option-${index}`}
      hidden={!selected}
    >
      <ArtifactPreviewFrame
        preview={preview}
        title={`${t(variant.label, 160)} artifact preview`}
        eager={selected}
      />
    </div>
  );
}

function VisualInspector({
  variant,
  selected,
}: { readonly variant: MultiVariantItem; readonly selected: boolean }) {
  const preview = variant.preview ?? { status: 'unavailable' as const };
  const evidence = Array.from(
    new Set([...variant.evidence, ...('sourcePath' in preview ? [preview.sourcePath] : [])]),
  );
  return (
    <section data-mv-inspector="" data-mv-variant-id={variant.id} hidden={!selected}>
      <div className="mv-inspector-head">
        {variant.recommended ? <span className="mv-suggested">Suggested</span> : null}
      </div>
      <h2>{t(variant.label, 160)}</h2>
      <p className="mv-description">{t(variant.description, 420)}</p>
      <details className="mv-disclosure">
        <summary>Option details</summary>
        <div className="mv-disclosure-body">
          <VariantFacts facts={variant.facts} />
          {variant.risks === undefined || variant.risks.length === 0 ? null : (
            <>
              <SectionLabel>Risks</SectionLabel>
              <BulletList items={variant.risks} />
            </>
          )}
        </div>
      </details>
      <details className="mv-disclosure">
        <summary>Evidence</summary>
        <div className="mv-disclosure-body mv-technical-list">
          {evidence.length === 0 ? <span>No evidence links were reported.</span> : null}
          {evidence.map((item) => (
            <code key={item}>{t(item, MAX_PROMPT_LEN)}</code>
          ))}
        </div>
      </details>
    </section>
  );
}

function VisualReviewWorkspace({
  input,
  defaultVariant,
}: {
  readonly input: MultiVariantComparisonInput;
  readonly defaultVariant: MultiVariantItem;
}) {
  const defaultIndex = input.variants.findIndex((variant) => variant.id === defaultVariant.id);
  const openHref =
    defaultVariant.preview?.status === 'ready' ? defaultVariant.preview.href : undefined;
  return (
    <div
      className="mv-wrap mv-visual"
      data-mv-workspace=""
      data-run-folder={input.resume?.runFolder ?? ''}
      data-resume-prefix={input.resume?.commandPrefix ?? 'circuit resume'}
      data-run-id={input.resume?.runId ?? ''}
      data-step-id={input.resume?.stepId ?? ''}
      data-attempt={input.resume?.attempt ?? 0}
      data-request-sha256={input.resume?.requestSha256 ?? ''}
    >
      <div className="mv-review-ui" data-mv-interactive="">
        <a className="mv-skip" href="#mv-artifact">
          Skip to artifact
        </a>
        <a className="mv-skip" href="#mv-comment">
          Skip to comments
        </a>
        <header className="mv-topbar">
          <div className="mv-heading">
            <h1>{t(input.headline, 180)}</h1>
            <p>{t(input.subtitle, 280)}</p>
          </div>
          <div className="mv-progress">
            <span data-mv-position="">
              {defaultIndex + 1} of {input.variants.length}
            </span>
            {' · '}Review draft
          </div>
        </header>
        <nav className="mv-tabs" role="tablist" aria-label="Review options">
          {input.variants.map((variant, index) => {
            const selected = variant.id === defaultVariant.id;
            const previewHref = variant.preview?.status === 'ready' ? variant.preview.href : '';
            return (
              <button
                key={variant.id}
                type="button"
                className="mv-tab"
                id={`mv-option-${index}`}
                role="tab"
                aria-selected={selected}
                aria-controls={`mv-panel-${index}`}
                tabIndex={selected ? 0 : -1}
                data-mv-option=""
                data-mv-variant-id={variant.id}
                data-mv-label={t(variant.label, 160)}
                data-mv-preview-src={previewHref}
              >
                <span className="mv-tab-index">{String(index + 1).padStart(2, '0')}</span>
                <span className="mv-tab-title">{t(variant.label, 160)}</span>
                {variant.recommended ? <span className="mv-suggested">Suggested</span> : null}
                <span className="mv-tab-note" data-mv-note-count="" hidden>
                  0
                </span>
              </button>
            );
          })}
        </nav>
        <main className="mv-main">
          <section
            className="mv-stage"
            id="mv-artifact"
            aria-label="Artifact preview"
            tabIndex={-1}
          >
            <div className="mv-stagebar">
              <div className="mv-stage-title" data-mv-stage-title="">
                {t(defaultVariant.label, 160)}
              </div>
              <div className="mv-stage-actions">
                <button
                  className="mv-icon-button"
                  type="button"
                  data-mv-previous=""
                  aria-label="Previous option"
                >
                  ←
                </button>
                <button
                  className="mv-icon-button"
                  type="button"
                  data-mv-next=""
                  aria-label="Next option"
                >
                  →
                </button>
                {openHref === undefined ? (
                  // biome-ignore lint/a11y/useValidAnchor: the review script supplies href for previewable options.
                  <a className="mv-open-link" data-mv-open="" hidden>
                    Open full size ↗
                  </a>
                ) : (
                  <a
                    className="mv-open-link"
                    data-mv-open=""
                    data-artifact-full-size-src={openHref}
                    href="#mv-artifact"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open full size ↗
                  </a>
                )}
              </div>
            </div>
            <div className="mv-canvas">
              {input.variants.map((variant, index) => (
                <VisualPanel
                  key={variant.id}
                  variant={variant}
                  selected={variant.id === defaultVariant.id}
                  index={index}
                />
              ))}
            </div>
          </section>
          <aside className="mv-inspector" id="mv-comments" aria-label="Review notes">
            {input.variants.map((variant) => (
              <VisualInspector
                key={variant.id}
                variant={variant}
                selected={variant.id === defaultVariant.id}
              />
            ))}
            <div className="mt-4">
              <label className="mv-field-label" htmlFor="mv-comment">
                Comment on this option
              </label>
              <textarea
                className="mv-comment"
                id="mv-comment"
                data-mv-comment=""
                maxLength={2000}
                placeholder="Record what you noticed or why you prefer this option."
              />
              <div className="mv-save-state" data-mv-save-state="">
                Saved in this browser
              </div>
            </div>
            <details className="mv-disclosure">
              <summary>
                Why Circuit suggested {t(input.recommendation.label, MAX_PROMPT_LEN)}
              </summary>
              <div className="mv-disclosure-body">
                {t(input.recommendation.rationale, MAX_PROMPT_LEN)}
              </div>
            </details>
            {input.details === undefined ? null : (
              <details className="mv-disclosure">
                <summary>Full comparison report</summary>
                <div className="mv-disclosure-body">{input.details}</div>
              </details>
            )}
          </aside>
        </main>
        <footer className="mv-footer">
          <div className="mv-footer-group">
            <button className="mv-secondary" type="button" data-mv-previous="">
              ← Previous
            </button>
            <button className="mv-secondary" type="button" data-mv-next="">
              Next →
            </button>
          </div>
          <div className="mv-footer-group">
            <button className="mv-primary" type="button" data-mv-finish="">
              Choose this option
            </button>
          </div>
        </footer>
        <dialog
          className="mv-dialog"
          data-mv-dialog=""
          aria-labelledby="mv-dialog-title"
          aria-describedby="mv-dialog-summary mv-dialog-description"
        >
          <div className="mv-dialog-body">
            <div className="mv-suggested">Finish review</div>
            <h2 id="mv-dialog-title">
              Choose <span data-mv-confirm-title="">{t(defaultVariant.label, 160)}</span>?
            </h2>
            <p className="mv-dialog-copy" id="mv-dialog-summary" data-mv-confirm-summary="">
              0 option comments
            </p>
            <p className="mv-dialog-copy" id="mv-dialog-description">
              Copy the command or export JSON to carry this selection and these notes back to
              Circuit.
            </p>
            <label className="mv-field-label" htmlFor="mv-overall-comment">
              Note for the run record (optional)
            </label>
            <textarea
              className="mv-comment"
              id="mv-overall-comment"
              data-mv-overall-comment=""
              maxLength={2000}
              placeholder="Add any context you want saved with this review."
            />
            <code className="mv-command" data-mv-command="" hidden />
            <div
              className="mv-command-state"
              data-mv-command-state=""
              role="status"
              aria-live="polite"
            />
            <div className="mv-dialog-actions">
              <button className="mv-secondary" type="button" data-mv-close-dialog="">
                Keep reviewing
              </button>
              <button className="mv-secondary" type="button" data-mv-export="">
                Export review JSON
              </button>
              <button className="mv-primary" type="button" data-mv-copy-decision="">
                Copy decision command
              </button>
              <button className="mv-primary" type="button" data-mv-submit-decision="" hidden>
                Done
              </button>
            </div>
          </div>
        </dialog>
        <div className="mv-live" aria-live="polite" data-mv-live="" />
      </div>
      <noscript>
        <style>{'[data-mv-interactive]{display:none!important}'}</style>
        <div className="mv-noscript">
          <h1>{t(input.headline, 180)}</h1>
          <p>JavaScript is off. Review each option, then run one legacy resume command.</p>
          <div className="mv-noscript-list">
            {input.variants.map((variant) => (
              <section key={variant.id} className="mv-noscript-option">
                <strong>
                  {t(variant.label, 160)}
                  {variant.recommended ? ' · Suggested' : ''}
                </strong>
                <span>{t(variant.description, 420)}</span>
                {variant.facts.map((fact) => (
                  <span key={fact.label}>
                    {t(fact.label, 120)}: {t(fact.value, MAX_BULLET_LEN)}
                  </span>
                ))}
                {variant.preview?.status === 'ready' ? (
                  <span>Artifact preview available in the live review</span>
                ) : (
                  <span>
                    {variant.preview === undefined
                      ? 'Preview unavailable'
                      : artifactPreviewFallbackCopy(variant.preview).title}
                  </span>
                )}
                {variant.action === undefined ? null : (
                  <code>{t(variant.action.prompt, MAX_PROMPT_LEN)}</code>
                )}
              </section>
            ))}
          </div>
        </div>
      </noscript>
    </div>
  );
}

export function renderMultiVariantComparisonPage(input: MultiVariantComparisonInput): string {
  if (input.variants.length === 0) {
    throw new Error('multi-variant comparison requires at least one variant');
  }
  const recommended = input.variants.find((variant) => variant.recommended) ?? input.variants[0];
  if (recommended === undefined) {
    throw new Error('multi-variant comparison could not choose a default variant');
  }
  const hasPreview = input.variants.some((variant) => variant.preview?.status === 'ready');
  const reviewWorkspace = input.resume !== undefined;
  if (hasPreview && input.resume === undefined) {
    throw new Error('visual multi-variant review requires resume metadata');
  }
  const defaultVariant = reviewWorkspace
    ? (input.variants.find(
        (variant) => variant.recommended && variant.preview?.status === 'ready',
      ) ??
      input.variants.find((variant) => variant.preview?.status === 'ready') ??
      recommended)
    : recommended;

  if (reviewWorkspace) {
    return renderHtmlDocument({
      title: input.title,
      body: <VisualReviewWorkspace input={input} defaultVariant={defaultVariant} />,
      extraStyle: MULTI_VARIANT_STYLE,
      extraScript: MULTI_VARIANT_REVIEW_SCRIPT,
    });
  }

  return renderReportPage({
    title: input.title,
    metaLine: input.metaLine,
    headline: input.headline,
    subtitle: input.subtitle,
    ...(input.footerLeft === undefined ? {} : { footerLeft: input.footerLeft }),
    ...(input.footerRight === undefined ? {} : { footerRight: input.footerRight }),
    wrapClassName: 'mv-wrap mv-evidence',
    extraStyle: MULTI_VARIANT_STYLE,
    children: (
      <>
        <VerdictBanner
          intent={input.recommendation.intent}
          badgeText={input.recommendation.badgeText}
          main={
            <>
              <strong>{t(input.recommendation.label, 160)}</strong> ·{' '}
              {t(input.recommendation.rationale, MAX_PROMPT_LEN)}
            </>
          }
          {...(input.recommendation.aside === undefined
            ? {}
            : { aside: input.recommendation.aside })}
        />
        <section aria-label="Variant comparison">
          {input.variants.map((variant) => (
            <EvidenceRow key={variant.id} variant={variant} />
          ))}
        </section>
        {input.details ?? null}
      </>
    ),
  });
}
