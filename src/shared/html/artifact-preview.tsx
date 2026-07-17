// Shared local-artifact preview contract.
//
// HTML artifacts are snapshotted into the waiting report. That gives the
// reviewer a stable, interactive preview even if the source file moves after
// the report is written. A small postMessage handshake proves that the
// sandboxed document actually ran; an iframe load event alone is not enough
// because Chromium also fires it for missing local files.

import { createHash } from 'node:crypto';
import { constants, accessSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CONTROL_PLANE_RUNS_DIR } from '../control-plane-paths.js';
import { MAX_PROMPT_LEN } from './page.js';
import { t } from './react-page.js';

export const ARTIFACT_PREVIEW_HANDSHAKE = 'circuit.artifact-preview-ready@v1';

export type ArtifactPreview =
  | {
      readonly status: 'ready';
      readonly href: string;
      readonly sourcePath: string;
      readonly embedded?:
        | {
            readonly base64: string;
            readonly proof: string;
          }
        | undefined;
    }
  | {
      readonly status: 'missing';
      readonly sourcePath: string;
    }
  | {
      readonly status: 'unsupported';
      readonly sourcePath: string;
    }
  | {
      readonly status: 'unavailable';
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

type ArtifactPreviewLocation = {
  readonly absolutePath: string;
  readonly allowedRoot: string;
  readonly href: string;
};

function artifactPreviewLocation(input: {
  readonly entryPath: string;
  readonly runFolder: string;
  readonly projectRoot?: string | undefined;
}): ArtifactPreviewLocation | undefined {
  if (!isPreviewableArtifactPath(input.entryPath)) return undefined;
  const reportsDir = resolve(input.runFolder, 'reports');
  const runRoot = resolve(input.runFolder);

  if (isAbsolute(input.entryPath)) {
    const absoluteEntry = resolve(input.entryPath);
    if (isInside(runRoot, absoluteEntry)) {
      return {
        absolutePath: absoluteEntry,
        allowedRoot: runRoot,
        href: encodeUrlPath(toBrowserPath(relative(reportsDir, absoluteEntry))),
      };
    }
    if (input.projectRoot !== undefined && isInside(resolve(input.projectRoot), absoluteEntry)) {
      return {
        absolutePath: absoluteEntry,
        allowedRoot: resolve(input.projectRoot),
        href: pathToFileURL(absoluteEntry).href,
      };
    }
    return undefined;
  }

  const normalized = toBrowserPath(input.entryPath).replace(/^\.\//, '');
  if (normalized.split('/').some((part) => part === '..')) return undefined;
  if (normalized.startsWith('prototype-files/')) {
    return {
      absolutePath: resolve(runRoot, normalized),
      allowedRoot: runRoot,
      href: encodeUrlPath(`../${normalized}`),
    };
  }

  const runId = runIdFromFolder(input.runFolder);
  const currentRunPrefix = runId === undefined ? undefined : `${CONTROL_PLANE_RUNS_DIR}/${runId}/`;
  if (currentRunPrefix !== undefined && normalized.startsWith(currentRunPrefix)) {
    const runRelative = normalized.slice(currentRunPrefix.length);
    return {
      absolutePath: resolve(runRoot, runRelative),
      allowedRoot: runRoot,
      href: encodeUrlPath(`../${runRelative}`),
    };
  }

  if (input.projectRoot !== undefined) {
    const projectRoot = resolve(input.projectRoot);
    const absoluteEntry = resolve(projectRoot, normalized);
    if (!isInside(projectRoot, absoluteEntry)) return undefined;
    return {
      absolutePath: absoluteEntry,
      allowedRoot: projectRoot,
      href: pathToFileURL(absoluteEntry).href,
    };
  }

  return undefined;
}

export function runArtifactPreviewHref(input: {
  readonly entryPath: string;
  readonly runFolder: string;
  readonly projectRoot?: string | undefined;
}): string | undefined {
  return artifactPreviewLocation(input)?.href;
}

function safeReadablePath(location: ArtifactPreviewLocation): string | undefined {
  try {
    const root = resolve(location.allowedRoot);
    const target = resolve(location.absolutePath);
    if (!isInside(root, target) || lstatSync(root).isSymbolicLink()) return undefined;

    const realRoot = realpathSync.native(root);
    let cursor = root;
    for (const segment of relative(root, target).split(sep)) {
      cursor = resolve(cursor, segment);
      if (lstatSync(cursor).isSymbolicLink()) return undefined;
      if (!isInside(realRoot, realpathSync.native(cursor))) return undefined;
    }

    const realTarget = realpathSync.native(target);
    if (!isInside(realRoot, realTarget) || !statSync(realTarget).isFile()) return undefined;
    accessSync(realTarget, constants.R_OK);
    return realTarget;
  } catch {
    return undefined;
  }
}

function injectHtmlPreviewBootstrap(source: string, bootstrap: string): string {
  const doctype = source.match(/^\uFEFF?\s*<!doctype[^>]*>/i)?.[0] ?? '';
  const body = source.slice(doctype.length);
  const headOpen = body.match(/<head\b[^>]*>/i);
  if (headOpen !== null && headOpen.index !== undefined) {
    const insertAt = headOpen.index + headOpen[0].length;
    return `${doctype}${body.slice(0, insertAt)}${bootstrap}${body.slice(insertAt)}`;
  }

  const htmlOpen = body.match(/<html\b[^>]*>/i);
  if (htmlOpen !== null && htmlOpen.index !== undefined) {
    const insertAt = htmlOpen.index + htmlOpen[0].length;
    return `${doctype}${body.slice(0, insertAt)}<head>${bootstrap}</head>${body.slice(insertAt)}`;
  }

  return `${doctype}<head>${bootstrap}</head>${body}`;
}

function embeddedHtmlSnapshot(
  location: ArtifactPreviewLocation,
): ArtifactPreview & { readonly status: 'ready' } {
  const source = readFileSync(location.absolutePath, 'utf8');
  const proof = createHash('sha256')
    .update(location.absolutePath)
    .update('\0')
    .update(source)
    .digest('hex');
  const baseHref = pathToFileURL(`${dirname(location.absolutePath)}${sep}`).href;
  const bootstrap = `<base href=${JSON.stringify(baseHref)}><script>(()=>{const announce=()=>parent.postMessage({type:${JSON.stringify(
    ARTIFACT_PREVIEW_HANDSHAKE,
  )},proof:${JSON.stringify(
    proof,
  )}},'*');const announceAfterReady=()=>setTimeout(announce,0);if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',announceAfterReady,{once:true});else announceAfterReady();})()</script>`;
  const html = injectHtmlPreviewBootstrap(source, bootstrap);
  return {
    status: 'ready',
    href: location.href,
    sourcePath: '',
    embedded: { base64: Buffer.from(html, 'utf8').toString('base64'), proof },
  };
}

export function previewForEntryPoints(input: {
  readonly entryPoints: readonly string[];
  readonly runFolder: string;
  readonly projectRoot?: string | undefined;
}): ArtifactPreview {
  if (input.entryPoints.length === 0) return { status: 'unavailable' };

  let firstMissing: ArtifactPreview | undefined;
  for (const entryPoint of input.entryPoints) {
    const location = artifactPreviewLocation({
      entryPath: entryPoint,
      runFolder: input.runFolder,
      projectRoot: input.projectRoot,
    });
    if (location === undefined) continue;
    const readablePath = safeReadablePath(location);
    if (readablePath === undefined) {
      firstMissing ??= { status: 'missing', sourcePath: entryPoint };
      continue;
    }
    const safeLocation = { ...location, absolutePath: readablePath };

    const extension = extensionForPath(location.absolutePath);
    if (extension === '.html' || extension === '.htm') {
      try {
        return { ...embeddedHtmlSnapshot(safeLocation), sourcePath: entryPoint };
      } catch {
        firstMissing ??= { status: 'missing', sourcePath: entryPoint };
        continue;
      }
    }
    return { status: 'ready', href: location.href, sourcePath: entryPoint };
  }

  return firstMissing ?? { status: 'unsupported', sourcePath: input.entryPoints[0] ?? '' };
}

export const ARTIFACT_PREVIEW_STYLE = [
  '.ap-shell{position:absolute;inset:0;min-width:0;background:#fff}',
  '.ap-shell iframe{display:block;width:100%;height:100%;border:0;background:#fff}',
  '.ap-status{position:absolute;inset:0;z-index:1;display:grid;place-content:center;justify-items:center;gap:9px;padding:28px;background:#fff;color:#71717a;text-align:center}',
  '.ap-status strong{color:#18181b;font-size:16px}',
  '.ap-status code{max-width:min(560px,80vw);overflow-wrap:anywhere;color:#52525b;font:500 10px/1.45 ui-monospace,"SF Mono",Menlo,monospace}',
  '.ap-shell[data-artifact-preview-state="ready"] .ap-status{display:none}',
  '.ap-shell[data-artifact-preview-state="failed"] iframe{visibility:hidden}',
  '.ap-retry{min-height:38px;margin-top:4px;border:1px solid #d4d4d8;border-radius:8px;background:#fff;padding:0 13px;color:#18181b;font-size:12px;font-weight:580}',
  '.ap-empty{height:100%;display:grid;place-content:center;gap:10px;padding:28px;background:#fff;color:#71717a;text-align:center}',
  '.ap-empty strong{color:#18181b;font-size:16px}',
  '.ap-empty code{max-width:min(560px,80vw);overflow-wrap:anywhere;color:#52525b;font:500 10px/1.45 ui-monospace,"SF Mono",Menlo,monospace}',
].join('');

export const ARTIFACT_PREVIEW_SCRIPT = `(()=>{const type=${JSON.stringify(
  ARTIFACT_PREVIEW_HANDSHAKE,
)};const shells=[...document.querySelectorAll('[data-artifact-preview-shell]')];const timeoutMs=8000;const decode=value=>{const binary=atob(value);const bytes=Uint8Array.from(binary,char=>char.charCodeAt(0));return new TextDecoder().decode(bytes);};const state=(shell,value)=>{shell.dataset.artifactPreviewState=value;if(shell.hasAttribute('data-mv-preview-state'))shell.dataset.mvPreviewState=value;};function start(shell){if(shell.dataset.artifactPreviewStarted==='true'&&shell.dataset.artifactPreviewState!=='failed')return;const frame=shell.querySelector('[data-artifact-preview-frame]');const message=shell.querySelector('[data-artifact-preview-message]');const detail=shell.querySelector('[data-artifact-preview-detail]');const retry=shell.querySelector('[data-artifact-preview-retry]');if(!frame||!message||!detail||!retry)return;const generation=String(Number(shell.dataset.artifactPreviewGeneration||'0')+1);shell.dataset.artifactPreviewGeneration=generation;shell.dataset.artifactPreviewStarted='true';state(shell,'loading');shell.setAttribute('aria-busy','true');message.textContent='Loading preview…';detail.textContent='Preparing the local artifact.';retry.hidden=true;let settled=false;const proof=frame.dataset.artifactPreviewProof||'';const embedded=frame.dataset.artifactPreviewEmbedded||'';const source=frame.dataset.artifactPreviewSrc||'';const htmlLike=/\\.html?(?:[?#]|$)/i.test(source);const cleanup=()=>window.removeEventListener('message',onMessage);const timer=setTimeout(()=>fail('Preview took too long to load','You can retry it or open the artifact full size.'),timeoutMs);function finish(){if(settled||shell.dataset.artifactPreviewGeneration!==generation)return;settled=true;clearTimeout(timer);cleanup();state(shell,'ready');shell.setAttribute('aria-busy','false');}function fail(title,copy){if(settled||shell.dataset.artifactPreviewGeneration!==generation)return;settled=true;clearTimeout(timer);cleanup();state(shell,'failed');shell.setAttribute('aria-busy','false');message.textContent=title;detail.textContent=copy;retry.hidden=false;}function onMessage(event){const value=event.data;if(event.source===frame.contentWindow&&proof.length>0&&value&&value.type===type&&value.proof===proof)finish();}window.addEventListener('message',onMessage);frame.addEventListener('error',()=>fail('Preview could not be loaded','You can retry it or open the artifact full size.'),{once:true});if(embedded.length>0){try{frame.srcdoc=decode(embedded);}catch{fail('Preview could not be loaded','The embedded artifact snapshot could not be read. Open it full size instead.');}}else{if(!htmlLike)frame.addEventListener('load',finish,{once:true});frame.src=source;}}shells.forEach(shell=>{const panel=shell.closest('[data-artifact-preview-panel]');const begin=()=>{if(!panel||!panel.hidden)start(shell);};begin();if(panel)new MutationObserver(begin).observe(panel,{attributes:true,attributeFilter:['hidden']});const retry=shell.querySelector('[data-artifact-preview-retry]');if(retry)retry.addEventListener('click',()=>{const frame=shell.querySelector('[data-artifact-preview-frame]');if(!frame)return;const replacement=frame.cloneNode();replacement.removeAttribute('src');replacement.removeAttribute('srcdoc');frame.replaceWith(replacement);shell.dataset.artifactPreviewStarted='false';start(shell);});});})();`;

export function ArtifactPreviewFrame({
  preview,
  title,
  eager = false,
}: {
  readonly preview: ArtifactPreview;
  readonly title: string;
  readonly eager?: boolean | undefined;
}) {
  if (preview.status !== 'ready') {
    const copy =
      preview.status === 'missing'
        ? {
            title: 'Preview file missing',
            detail:
              'Circuit could not find or read this reported file. Review the evidence instead.',
          }
        : preview.status === 'unsupported'
          ? {
              title: 'Preview format unsupported',
              detail: 'This entry point cannot be shown in a browser. Review the evidence instead.',
            }
          : {
              title: 'Preview unavailable',
              detail: 'This option did not report a browser-viewable entry point.',
            };
    return (
      <div className="ap-empty" data-artifact-preview-state={preview.status}>
        <strong>{copy.title}</strong>
        <span>{copy.detail}</span>
        {'sourcePath' in preview ? <code>{t(preview.sourcePath, MAX_PROMPT_LEN)}</code> : null}
      </div>
    );
  }

  return (
    <div
      className="ap-shell"
      data-artifact-preview-shell=""
      data-artifact-preview-state="loading"
      data-mv-preview-shell=""
      data-mv-preview-state="loading"
      aria-busy="true"
    >
      <output className="ap-status" aria-live="polite">
        <strong data-artifact-preview-message="">Loading preview…</strong>
        <span data-artifact-preview-detail="">Preparing the local artifact.</span>
        <button
          className="ap-retry"
          type="button"
          data-artifact-preview-retry=""
          data-mv-preview-retry=""
          hidden
        >
          Retry preview
        </button>
      </output>
      <iframe
        data-mv-frame=""
        data-mv-preview-src={preview.href}
        data-artifact-preview-frame=""
        data-artifact-preview-src={preview.href}
        {...(preview.embedded === undefined
          ? {}
          : {
              'data-artifact-preview-embedded': preview.embedded.base64,
              'data-artifact-preview-proof': preview.embedded.proof,
            })}
        title={t(title, 220)}
        sandbox="allow-scripts allow-forms allow-pointer-lock"
        loading={eager ? 'eager' : 'lazy'}
      />
    </div>
  );
}
