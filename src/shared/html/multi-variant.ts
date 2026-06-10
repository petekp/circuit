// Shared multi-variant checkpoint HTML renderer.
//
// Keeps the comparison structure reusable while letting each flow decide what
// evidence, labels, and resume commands mean. Visual artifacts get a pinned
// preview rail. Non-visual variants stay evidence-first and avoid preview
// chrome entirely.

import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONTROL_PLANE_RUNS_DIR } from '../control-plane-paths.js';
import { type Intent, chip, verdictBanner } from './components.js';
import { MAX_BULLET_LEN, MAX_PROMPT_LEN, escapeHtml, renderPage, truncate } from './page.js';

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
  readonly detailsHtml?: string;
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

function multiVariantStyles(): string {
  return `.mv-wrap{--mv-pad:clamp(18px,2.4vw,44px);--mv-top:clamp(30px,3vw,50px);--mv-rail-width:clamp(420px,32vw,640px);--mv-rail-gap:clamp(34px,4vw,72px);max-width:1280px}.mv-wrap.mv-visual{max-width:none;width:100%;padding:var(--mv-top) calc(var(--mv-rail-width) + var(--mv-pad) + var(--mv-rail-gap)) 96px var(--mv-pad)}.mv-decision{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:18px;align-items:center;margin:24px 0 28px;padding:16px 0;border-top:1px solid var(--border);border-bottom:1px solid var(--border)}.mv-decision strong{display:block;font-size:15px;line-height:1.35;margin-bottom:3px;font-weight:560}.mv-decision span{color:var(--text-2)}.mv-count{font-size:12px;color:var(--text-3);white-space:nowrap}.mv-compare{display:block}.mv-list-head,.mv-row{display:grid;grid-template-columns:minmax(150px,190px) minmax(30ch,1fr) minmax(240px,.9fr);gap:clamp(18px,2vw,34px);align-items:start}.mv-list-head{padding:0 0 10px;color:var(--text-3);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0}.mv-row{position:relative;width:100%;padding:18px 0;border-top:1px solid var(--border)}.mv-row:last-child{border-bottom:1px solid var(--border)}.mv-row[data-selected="true"]::before{content:"";position:absolute;left:-14px;top:18px;bottom:18px;width:2px;border-radius:999px;background:var(--intent-positive)}.mv-name{display:flex;flex-direction:column;gap:6px}.mv-name strong{font-size:15.5px;line-height:1.3;font-weight:560}.mv-tag{width:max-content;color:var(--text-2);border:1px solid var(--border);border-radius:999px;padding:2px 7px;font-size:11px;font-weight:500}.mv-tag.good{color:var(--intent-positive);border-color:var(--intent-positive)}.mv-copy p{margin:0 0 9px;color:var(--text)}.mv-facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;color:var(--text-2);font-size:13px}.mv-facts b{display:block;color:var(--text-3);font-size:11px;text-transform:uppercase;letter-spacing:0;font-weight:600;margin-bottom:2px}.mv-evidence-cell{display:flex;flex-direction:column;gap:10px;min-width:0}.mv-actions{display:flex;gap:8px;flex-wrap:wrap}.mv-preview-trigger{font:500 13px/1 -apple-system,system-ui,sans-serif;padding:8px 12px;border:1px solid var(--border-strong);border-radius:6px;background:var(--surface);color:var(--text);cursor:pointer}.mv-preview-trigger:hover{background:var(--surface-2)}.mv-detail{position:fixed;top:var(--mv-top);right:var(--mv-pad);bottom:28px;width:var(--mv-rail-width);border-left:1px solid var(--border);padding-left:clamp(24px,2.4vw,40px);overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable}.mv-detail h2{font-size:18px;line-height:1.3;margin:0 0 12px;letter-spacing:0;font-weight:560}.mv-frame{border:1px solid var(--border-strong);border-radius:10px;background:var(--surface);min-height:clamp(280px,42vh,470px);box-shadow:0 16px 42px rgba(22,28,24,.07);overflow:hidden}.mv-frame iframe{display:block;width:100%;height:clamp(280px,42vh,470px);border:0;background:white}.mv-empty-preview{padding:18px;color:var(--text-2);font-size:13px}.mv-detail-meta{display:flex;flex-direction:column;gap:10px;margin-top:14px}.mv-open-link{font-size:13px;color:var(--intent-info);text-decoration:none}.mv-open-link:hover{text-decoration:underline}.mv-detail-source{font:500 11px/1.4 ui-monospace,"SF Mono",Menlo,monospace;color:var(--text-3);overflow-wrap:anywhere}.mv-wrap.mv-evidence .mv-row{grid-template-columns:minmax(150px,210px) minmax(32ch,1fr) minmax(260px,.8fr)}@media (max-width:1320px){.mv-wrap.mv-visual{max-width:1280px;margin:0 auto;padding:var(--mv-top) var(--mv-pad) 96px}.mv-detail{position:static;width:auto;overflow:visible;border-left:0;border-top:1px solid var(--border);padding-left:0;padding-top:22px;margin-top:24px}.mv-frame iframe{height:420px}}@media (max-width:760px){.mv-decision{grid-template-columns:1fr}.mv-count{white-space:normal}.mv-list-head{display:none}.mv-row,.mv-wrap.mv-evidence .mv-row{grid-template-columns:1fr;gap:12px}.mv-facts{grid-template-columns:1fr}.mv-frame iframe{height:340px}}`;
}

function multiVariantScript(): string {
  return `(()=>{const frame=document.querySelector('[data-mv-frame]');const title=document.querySelector('[data-mv-title]');const source=document.querySelector('[data-mv-source]');const link=document.querySelector('[data-mv-open]');const empty=document.querySelector('[data-mv-empty]');const rows=[...document.querySelectorAll('[data-mv-row]')];const triggers=[...document.querySelectorAll('[data-mv-preview-trigger]')];if(!frame||!title||!source||!link||!empty)return;function select(trigger){const id=trigger.dataset.mvVariantId||'';const src=trigger.dataset.mvPreviewSrc||'';title.textContent=trigger.dataset.mvPreviewTitle||'';source.textContent=trigger.dataset.mvPreviewSource||'';rows.forEach(row=>{row.dataset.selected=String(row.dataset.mvVariantId===id);});if(src.length>0){frame.hidden=false;empty.hidden=true;frame.setAttribute('src',src);link.hidden=false;link.setAttribute('href',src);}else{frame.hidden=true;empty.hidden=false;link.hidden=true;link.removeAttribute('href');}}triggers.forEach(trigger=>{trigger.addEventListener('click',()=>select(trigger));});})();`;
}

function renderFacts(facts: readonly MultiVariantFact[]): string {
  if (facts.length === 0) return '';
  return `<div class="mv-facts">
          ${facts
            .map(
              (fact) =>
                `<span><b>${escapeHtml(fact.label)}</b>${escapeHtml(truncate(fact.value, MAX_BULLET_LEN))}</span>`,
            )
            .join('\n          ')}
        </div>`;
}

function renderRisks(risks: readonly string[] | undefined): string {
  if (risks === undefined || risks.length === 0) return '';
  return `<div>
          <p class="section-label">Risks</p>
          <ul class="tradeoffs">
            ${risks.map((risk) => `<li>${escapeHtml(truncate(risk, MAX_BULLET_LEN))}</li>`).join('\n            ')}
          </ul>
        </div>`;
}

function renderAction(action: MultiVariantAction | undefined): string {
  if (action === undefined) return '';
  const classes = action.primary === false ? 'copy' : 'copy primary';
  return `<button class="${classes}" data-prompt="${escapeHtml(
    truncate(action.prompt, MAX_PROMPT_LEN),
  )}">${escapeHtml(action.label)}</button>`;
}

function renderVariantRow(input: {
  readonly variant: MultiVariantItem;
  readonly visual: boolean;
  readonly selected: boolean;
}): string {
  const { selected, variant, visual } = input;
  const previewButton =
    visual && variant.preview !== undefined
      ? `<button class="mv-preview-trigger" type="button" data-mv-preview-trigger data-mv-variant-id="${escapeHtml(
          variant.id,
        )}" data-mv-preview-src="${escapeHtml(variant.preview.href)}" data-mv-preview-title="${escapeHtml(
          variant.label,
        )}" data-mv-preview-source="${escapeHtml(variant.preview.sourcePath)}">Preview</button>`
      : '';
  const evidence =
    variant.evidence.length === 0
      ? ''
      : variant.evidence.map((item) => chip(item)).join('\n          ');
  return `      <article class="mv-row" data-mv-row data-mv-variant-id="${escapeHtml(
    variant.id,
  )}" data-selected="${selected ? 'true' : 'false'}">
        <div class="mv-name">
          <strong>${escapeHtml(variant.label)}</strong>
          <span class="mv-tag${variant.recommended ? ' good' : ''}">${escapeHtml(
            variant.recommended ? 'Recommended' : variant.id,
          )}</span>
        </div>
        <div class="mv-copy">
          <p>${escapeHtml(truncate(variant.description, MAX_BULLET_LEN))}</p>
          ${renderFacts(variant.facts)}
          ${renderRisks(variant.risks)}
        </div>
        <div class="mv-evidence-cell">
          <div class="evidence">
          ${evidence}
          </div>
          <div class="mv-actions">
            ${previewButton}
            ${renderAction(variant.action)}
          </div>
        </div>
      </article>`;
}

function renderVisualDetail(variant: MultiVariantItem): string {
  const preview = variant.preview;
  const frameHtml =
    preview === undefined
      ? '<iframe data-mv-frame hidden title=""></iframe><p class="mv-empty-preview" data-mv-empty>No visual preview is available for this variant.</p>'
      : `<iframe data-mv-frame src="${escapeHtml(preview.href)}" title="${escapeHtml(
          `${variant.label} preview`,
        )}" sandbox="allow-scripts allow-forms allow-pointer-lock" loading="lazy"></iframe><p class="mv-empty-preview" data-mv-empty hidden>No visual preview is available for this variant.</p>`;
  const source = preview?.sourcePath ?? 'No visual artifact path';
  const link =
    preview === undefined
      ? '<a class="mv-open-link" data-mv-open hidden>Open artifact</a>'
      : `<a class="mv-open-link" data-mv-open href="${escapeHtml(
          preview.href,
        )}" target="_blank" rel="noreferrer">Open artifact</a>`;
  return `    <aside class="mv-detail" aria-label="Selected variant preview">
      <h2 data-mv-title>${escapeHtml(variant.label)}</h2>
      <div class="mv-frame">
        ${frameHtml}
      </div>
      <div class="mv-detail-meta">
        ${link}
        <div class="mv-detail-source" data-mv-source>${escapeHtml(source)}</div>
      </div>
    </aside>`;
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
  const rows = input.variants
    .map((variant) =>
      renderVariantRow({ variant, visual, selected: variant.id === defaultVariant.id }),
    )
    .join('\n');
  const banner = verdictBanner({
    intent: input.recommendation.intent,
    badgeText: input.recommendation.badgeText,
    mainHtml: `<strong>${escapeHtml(input.recommendation.label)}</strong> &mdash; ${escapeHtml(
      input.recommendation.rationale,
    )}`,
    ...(input.recommendation.aside === undefined ? {} : { aside: input.recommendation.aside }),
  });
  const details = input.detailsHtml === undefined ? '' : input.detailsHtml;
  const bodyHtml = `${banner}

  <section class="mv-decision" aria-label="Checkpoint decision">
    <div>
      <strong>Recommended: ${escapeHtml(recommended.label)}</strong>
      <span>${escapeHtml(input.recommendation.rationale)}</span>
    </div>
    <div class="mv-count">${input.variants.length} variants compared</div>
  </section>

  <div class="mv-compare">
    <section aria-label="Variant comparison">
      <div class="mv-list-head">
        <div>Variant</div>
        <div>What changes</div>
        <div>${visual ? 'Evidence and preview' : 'Evidence'}</div>
      </div>
${rows}
    </section>
${visual ? renderVisualDetail(defaultVariant) : ''}
  </div>

${details}
`;

  return renderPage({
    title: input.title,
    metaLine: input.metaLine,
    headline: input.headline,
    subtitle: input.subtitle,
    bodyHtml,
    ...(input.footerLeft === undefined ? {} : { footerLeft: input.footerLeft }),
    ...(input.footerRight === undefined ? {} : { footerRight: input.footerRight }),
    wrapClassName: visual ? 'wrap mv-wrap mv-visual' : 'wrap mv-wrap mv-evidence',
    extraStyles: multiVariantStyles(),
    ...(visual ? { extraScript: multiVariantScript() } : {}),
  });
}
