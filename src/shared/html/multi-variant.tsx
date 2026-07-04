// Shared multi-variant checkpoint HTML renderer.
//
// Keeps the comparison structure reusable while letting each flow decide what
// evidence, labels, and resume commands mean. Visual artifacts get a pinned
// preview rail. Non-visual variants stay evidence-first and avoid preview
// chrome entirely.
//
// The comparison rows and the pinned rail are a bespoke layout, so they keep
// a small page-specific stylesheet (mv-*) on top of the design system; the
// content inside the cells is composed from the shared report components.

import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ReactNode } from 'react';

import { CONTROL_PLANE_RUNS_DIR } from '../control-plane-paths.js';
import { MAX_BULLET_LEN, MAX_PROMPT_LEN } from './page.js';
import { t } from './react-page.js';
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

export type MultiVariantPreview = {
  readonly href: string;
  readonly sourcePath: string;
};

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
  // Trailing section (e.g. a raw-evidence disclosure block).
  readonly details?: ReactNode;
  readonly footerLeft?: string;
  readonly footerRight?: string;
};

const PREVIEWABLE_EXTENSIONS = new Set([
  '.gif',
  '.htm',
  '.html',
  '.jpeg',
  '.jpg',
  '.pdf',
  '.png',
  '.svg',
  '.webp',
]);

function withoutQueryOrHash(value: string): string {
  const queryIndex = value.search(/[?#]/);
  return queryIndex === -1 ? value : value.slice(0, queryIndex);
}

function extensionForPath(value: string): string {
  const cleaned = withoutQueryOrHash(value).toLowerCase();
  const dotIndex = cleaned.lastIndexOf('.');
  if (dotIndex === -1) return '';
  const slashIndex = cleaned.lastIndexOf('/');
  return dotIndex > slashIndex ? cleaned.slice(dotIndex) : '';
}

export function isPreviewableArtifactPath(value: string): boolean {
  return PREVIEWABLE_EXTENSIONS.has(extensionForPath(value));
}

function toBrowserPath(value: string): string {
  return value.replace(/\\/g, '/');
}

function encodeUrlPath(value: string): string {
  return value
    .split('/')
    .map((part) => (part === '..' || part === '.' ? part : encodeURIComponent(part)))
    .join('/');
}

function isInside(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return fromRoot !== '' && !fromRoot.startsWith('..') && !isAbsolute(fromRoot);
}

function runIdFromFolder(runFolder: string): string | undefined {
  const parts = toBrowserPath(resolve(runFolder))
    .split('/')
    .filter((part) => part.length > 0);
  return parts.at(-1);
}

export function runArtifactPreviewHref(input: {
  readonly entryPath: string;
  readonly runFolder: string;
  readonly projectRoot?: string | undefined;
}): string | undefined {
  if (!isPreviewableArtifactPath(input.entryPath)) return undefined;
  const reportsDir = resolve(input.runFolder, 'reports');
  const runRoot = resolve(input.runFolder);

  if (isAbsolute(input.entryPath)) {
    const absoluteEntry = resolve(input.entryPath);
    if (!isInside(runRoot, absoluteEntry)) return undefined;
    return encodeUrlPath(toBrowserPath(relative(reportsDir, absoluteEntry)));
  }

  const normalized = toBrowserPath(input.entryPath).replace(/^\.\//, '');
  if (normalized.split('/').some((part) => part === '..')) return undefined;
  if (normalized.startsWith('prototype-files/')) return encodeUrlPath(`../${normalized}`);

  const runId = runIdFromFolder(input.runFolder);
  const currentRunPrefix = runId === undefined ? undefined : `${CONTROL_PLANE_RUNS_DIR}/${runId}/`;
  if (currentRunPrefix !== undefined && normalized.startsWith(currentRunPrefix)) {
    return encodeUrlPath(`../${normalized.slice(currentRunPrefix.length)}`);
  }

  if (input.projectRoot !== undefined) {
    const projectRoot = resolve(input.projectRoot);
    const absoluteEntry = resolve(projectRoot, normalized);
    if (!isInside(projectRoot, absoluteEntry)) return undefined;
    return pathToFileURL(absoluteEntry).href;
  }

  return undefined;
}

export function previewForEntryPoints(input: {
  readonly entryPoints: readonly string[];
  readonly runFolder: string;
  readonly projectRoot?: string | undefined;
}): MultiVariantPreview | undefined {
  for (const entryPoint of input.entryPoints) {
    const href = runArtifactPreviewHref({
      entryPath: entryPoint,
      runFolder: input.runFolder,
      projectRoot: input.projectRoot,
    });
    if (href !== undefined) return { href, sourcePath: entryPoint };
  }
  return undefined;
}

// Bespoke layout the utility classes do not cover: the comparison grid, the
// selected-row marker, and the pinned preview rail with its breakpoints.
// Colors come from the design-system tokens in theme.css.
const MULTI_VARIANT_STYLE = [
  '.mv-wrap{--mv-pad:clamp(18px,2.4vw,44px);--mv-top:clamp(30px,3vw,50px);--mv-rail-width:clamp(420px,32vw,640px);--mv-rail-gap:clamp(34px,4vw,72px);max-width:1280px}',
  '.mv-wrap.mv-visual{max-width:none;width:100%;padding:var(--mv-top) calc(var(--mv-rail-width) + var(--mv-pad) + var(--mv-rail-gap)) 96px var(--mv-pad)}',
  '.mv-decision{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:18px;align-items:center;margin:24px 0 28px;padding:16px 0;border-top:1px solid var(--border);border-bottom:1px solid var(--border)}',
  '.mv-decision strong{display:block;font-size:15px;line-height:1.35;margin-bottom:3px;font-weight:560}',
  '.mv-decision span{color:var(--muted-foreground)}',
  '.mv-count{font-size:12px;color:var(--muted-foreground);white-space:nowrap}',
  '.mv-list-head,.mv-row{display:grid;grid-template-columns:minmax(150px,190px) minmax(30ch,1fr) minmax(240px,.9fr);gap:clamp(18px,2vw,34px);align-items:start}',
  '.mv-list-head{padding:0 0 10px;color:var(--muted-foreground);font-size:11px;font-weight:600;text-transform:uppercase}',
  '.mv-row{position:relative;width:100%;padding:18px 0;border-top:1px solid var(--border)}',
  '.mv-row:last-child{border-bottom:1px solid var(--border)}',
  '.mv-row[data-selected="true"]::before{content:"";position:absolute;left:-14px;top:18px;bottom:18px;width:2px;border-radius:999px;background:var(--positive)}',
  '.mv-name{display:flex;flex-direction:column;gap:6px;align-items:flex-start}',
  '.mv-name strong{font-size:15.5px;line-height:1.3;font-weight:560}',
  '.mv-copy p{margin:0 0 9px}',
  '.mv-evidence-cell{display:flex;flex-direction:column;gap:10px;min-width:0}',
  '.mv-detail{position:fixed;top:var(--mv-top);right:var(--mv-pad);bottom:28px;width:var(--mv-rail-width);border-left:1px solid var(--border);padding-left:clamp(24px,2.4vw,40px);overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable}',
  '.mv-detail h2{font-size:18px;line-height:1.3;margin:0 0 12px;font-weight:560}',
  '.mv-frame{border:1px solid var(--input);border-radius:10px;background:var(--card);min-height:clamp(280px,42vh,470px);box-shadow:0 16px 42px rgba(22,28,24,.07);overflow:hidden}',
  '.mv-frame iframe{display:block;width:100%;height:clamp(280px,42vh,470px);border:0;background:white}',
  '.mv-empty-preview{padding:18px;color:var(--muted-foreground);font-size:13px}',
  '.mv-detail-meta{display:flex;flex-direction:column;gap:10px;margin-top:14px}',
  '.mv-open-link{font-size:13px;color:var(--info);text-decoration:none}',
  '.mv-open-link:hover{text-decoration:underline}',
  '.mv-detail-source{font:500 11px/1.4 ui-monospace,"SF Mono",Menlo,monospace;color:var(--muted-foreground);overflow-wrap:anywhere}',
  '.mv-wrap.mv-evidence .mv-row{grid-template-columns:minmax(150px,210px) minmax(32ch,1fr) minmax(260px,.8fr)}',
  '@media (max-width:1320px){.mv-wrap.mv-visual{max-width:1280px;margin:0 auto;padding:var(--mv-top) var(--mv-pad) 96px}.mv-detail{position:static;width:auto;overflow:visible;border-left:0;border-top:1px solid var(--border);padding-left:0;padding-top:22px;margin-top:24px}.mv-frame iframe{height:420px}}',
  '@media (max-width:760px){.mv-decision{grid-template-columns:1fr}.mv-count{white-space:normal}.mv-list-head{display:none}.mv-row,.mv-wrap.mv-evidence .mv-row{grid-template-columns:1fr;gap:12px}.mv-frame iframe{height:340px}}',
].join('');

const MULTI_VARIANT_SCRIPT = `(()=>{const frame=document.querySelector('[data-mv-frame]');const title=document.querySelector('[data-mv-title]');const source=document.querySelector('[data-mv-source]');const link=document.querySelector('[data-mv-open]');const empty=document.querySelector('[data-mv-empty]');const rows=[...document.querySelectorAll('[data-mv-row]')];const triggers=[...document.querySelectorAll('[data-mv-preview-trigger]')];if(!frame||!title||!source||!link||!empty)return;function select(trigger){const id=trigger.dataset.mvVariantId||'';const src=trigger.dataset.mvPreviewSrc||'';title.textContent=trigger.dataset.mvPreviewTitle||'';source.textContent=trigger.dataset.mvPreviewSource||'';rows.forEach(row=>{row.dataset.selected=String(row.dataset.mvVariantId===id);});if(src.length>0){frame.hidden=false;empty.hidden=true;frame.setAttribute('src',src);link.hidden=false;link.setAttribute('href',src);}else{frame.hidden=true;empty.hidden=false;link.hidden=true;link.removeAttribute('href');}}triggers.forEach(trigger=>{trigger.addEventListener('click',()=>select(trigger));});})();`;

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

function VariantRow({
  variant,
  visual,
  selected,
}: {
  readonly variant: MultiVariantItem;
  readonly visual: boolean;
  readonly selected: boolean;
}) {
  return (
    <article
      className="mv-row"
      data-mv-row=""
      data-mv-variant-id={t(variant.id, 120)}
      data-selected={selected ? 'true' : 'false'}
    >
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
        <p>{t(variant.description, MAX_BULLET_LEN)}</p>
        <VariantFacts facts={variant.facts} />
        {variant.risks === undefined || variant.risks.length === 0 ? null : (
          <div className="mt-2.5">
            <SectionLabel>Risks</SectionLabel>
            <BulletList items={variant.risks} />
          </div>
        )}
      </div>
      <div className="mv-evidence-cell">
        {variant.evidence.length === 0 ? null : <ChipRow items={variant.evidence} />}
        <div className="flex flex-wrap gap-2">
          {visual && variant.preview !== undefined ? (
            <Button
              variant="outline"
              size="sm"
              type="button"
              data-mv-preview-trigger=""
              data-mv-variant-id={t(variant.id, 120)}
              data-mv-preview-src={variant.preview.href}
              data-mv-preview-title={t(variant.label, 160)}
              data-mv-preview-source={t(variant.preview.sourcePath, MAX_PROMPT_LEN)}
            >
              Preview
            </Button>
          ) : null}
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

function VisualDetail({ variant }: { readonly variant: MultiVariantItem }) {
  const preview = variant.preview;
  return (
    <aside className="mv-detail" aria-label="Selected variant preview">
      <h2 data-mv-title="">{t(variant.label, 160)}</h2>
      <div className="mv-frame">
        {preview === undefined ? (
          <>
            <iframe data-mv-frame="" hidden title="Variant preview" />
            <p className="mv-empty-preview" data-mv-empty="">
              No visual preview is available for this variant.
            </p>
          </>
        ) : (
          <>
            <iframe
              data-mv-frame=""
              src={preview.href}
              title={`${t(variant.label, 160)} preview`}
              sandbox="allow-scripts allow-forms allow-pointer-lock"
              loading="lazy"
            />
            <p className="mv-empty-preview" data-mv-empty="" hidden>
              No visual preview is available for this variant.
            </p>
          </>
        )}
      </div>
      <div className="mv-detail-meta">
        {preview === undefined ? (
          // biome-ignore lint/a11y/useValidAnchor: placeholder link; the preview switcher script sets href before unhiding it.
          <a className="mv-open-link" data-mv-open="" hidden>
            Open artifact
          </a>
        ) : (
          <a
            className="mv-open-link"
            data-mv-open=""
            href={preview.href}
            target="_blank"
            rel="noreferrer"
          >
            Open artifact
          </a>
        )}
        <div className="mv-detail-source" data-mv-source="">
          {t(preview?.sourcePath ?? 'No visual artifact path', MAX_PROMPT_LEN)}
        </div>
      </div>
    </aside>
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
  const visual = input.variants.some((variant) => variant.preview !== undefined);
  const defaultVariant = visual
    ? (input.variants.find((variant) => variant.recommended && variant.preview !== undefined) ??
      input.variants.find((variant) => variant.preview !== undefined) ??
      recommended)
    : recommended;

  return renderReportPage({
    title: input.title,
    metaLine: input.metaLine,
    headline: input.headline,
    subtitle: input.subtitle,
    ...(input.footerLeft === undefined ? {} : { footerLeft: input.footerLeft }),
    ...(input.footerRight === undefined ? {} : { footerRight: input.footerRight }),
    wrapClassName: visual ? 'mv-wrap mv-visual' : 'mv-wrap mv-evidence',
    extraStyle: MULTI_VARIANT_STYLE,
    ...(visual ? { extraScript: MULTI_VARIANT_SCRIPT } : {}),
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
        <section className="mv-decision" aria-label="Checkpoint decision">
          <div>
            <strong>Recommended: {t(recommended.label, 160)}</strong>
            <span>{t(input.recommendation.rationale, MAX_PROMPT_LEN)}</span>
          </div>
          <div className="mv-count">{input.variants.length} variants compared</div>
        </section>
        <div className="mv-compare">
          <section aria-label="Variant comparison">
            <div className="mv-list-head">
              <div>Variant</div>
              <div>What changes</div>
              <div>{visual ? 'Evidence and preview' : 'Evidence'}</div>
            </div>
            {input.variants.map((variant) => (
              <VariantRow
                key={variant.id}
                variant={variant}
                visual={visual}
                selected={variant.id === defaultVariant.id}
              />
            ))}
          </section>
          {visual ? <VisualDetail variant={defaultVariant} /> : null}
        </div>
        {input.details ?? null}
      </>
    ),
  });
}
