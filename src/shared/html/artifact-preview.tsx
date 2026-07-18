// Shared local-artifact preview contract.
//
// HTML artifacts are snapshotted into the waiting report. The snapshot is a
// safe visual preview: model-authored scripts and navigation are removed so it
// cannot reach the network or neighbouring local files. The live loopback
// review can add captured CSS, images, and fonts without widening that rule.

import { createHash } from 'node:crypto';
import {
  constants,
  type BigIntStats,
  accessSync,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { CheckpointReviewAssetFile } from '../../schemas/checkpoint-review-assets.js';
import { CONTROL_PLANE_RUNS_DIR } from '../control-plane-paths.js';
import { sanitizeArtifactMarkup } from './artifact-sanitizer.js';
import { MAX_PROMPT_LEN } from './page.js';
import { t } from './react-page.js';

// A saved review page can be opened directly from disk, without Circuit's
// loopback server. The same no-script policy applies to that direct fallback.
const EMBEDDED_ARTIFACT_PREVIEW_POLICY = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
].join('; ');

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
      readonly reason?: ArtifactPreviewUnavailableReason | undefined;
    };

export type ArtifactPreviewUnavailableReason =
  | 'changed'
  | 'invalid-text'
  | 'too-large'
  | 'unreadable';

const PREVIEWABLE_EXTENSIONS = new Set([
  '.gif',
  '.htm',
  '.html',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.webp',
]);

const VISUAL_MIME_BY_EXTENSION = new Map([
  ['.gif', 'image/gif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
]);
const MAX_EMBEDDED_HTML_BYTES = 8 * 1024 * 1024;
const MAX_EMBEDDED_VISUAL_BYTES = 8 * 1024 * 1024;
const PREVIEW_READ_CHUNK_BYTES = 64 * 1024;

class ArtifactPreviewReadError extends Error {
  constructor(readonly reason: ArtifactPreviewUnavailableReason) {
    super(reason);
    this.name = 'ArtifactPreviewReadError';
  }
}

function failPreviewRead(reason: ArtifactPreviewUnavailableReason): never {
  throw new ArtifactPreviewReadError(reason);
}

function unavailablePreview(error: unknown): Extract<ArtifactPreview, { status: 'unavailable' }> {
  return {
    status: 'unavailable',
    reason: error instanceof ArtifactPreviewReadError ? error.reason : 'unreadable',
  };
}

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

type SafeReadablePreviewPath = {
  readonly path: string;
  readonly identity: PreviewFileIdentity;
};

function safeReadablePath(location: ArtifactPreviewLocation): SafeReadablePreviewPath | undefined {
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
    const identity = pathIdentity(realTarget);
    if (!isInside(realRoot, realTarget) || !identity.regular) return undefined;
    accessSync(realTarget, constants.R_OK);
    return { path: realTarget, identity };
  } catch {
    return undefined;
  }
}

type PreviewFileIdentity = {
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly modified: bigint;
  readonly changed: bigint;
  readonly regular: boolean;
};

function previewFileIdentity(info: BigIntStats): PreviewFileIdentity {
  return {
    device: info.dev,
    inode: info.ino,
    size: info.size,
    modified: info.mtimeNs,
    changed: info.ctimeNs,
    regular: info.isFile(),
  };
}

function descriptorIdentity(descriptor: number): PreviewFileIdentity {
  return previewFileIdentity(fstatSync(descriptor, { bigint: true }));
}

function pathIdentity(path: string): PreviewFileIdentity {
  return previewFileIdentity(lstatSync(path, { bigint: true }));
}

function samePreviewFile(left: PreviewFileIdentity, right: PreviewFileIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modified === right.modified &&
    left.changed === right.changed &&
    left.regular &&
    right.regular
  );
}

function readBoundedPreviewBytes(descriptor: number, expectedSize: bigint, limit: number): Buffer {
  if (expectedSize > BigInt(limit)) failPreviewRead('too-large');
  const expectedLength = Number(expectedSize);
  const bytes = Buffer.allocUnsafe(expectedLength);
  let total = 0;
  while (total < expectedLength) {
    const read = readSync(
      descriptor,
      bytes,
      total,
      Math.min(PREVIEW_READ_CHUNK_BYTES, expectedLength - total),
      null,
    );
    if (read === 0) failPreviewRead('changed');
    total += read;
  }

  const growthProbe = Buffer.allocUnsafe(1);
  if (readSync(descriptor, growthProbe, 0, growthProbe.byteLength, null) !== 0) {
    failPreviewRead('changed');
  }
  return bytes;
}

function stablePreviewBytes(input: {
  readonly path: string;
  readonly byteLimit: number;
  readonly validatedIdentity: PreviewFileIdentity;
  readonly expectedSha256?: string | undefined;
}): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      input.path,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    const before = descriptorIdentity(descriptor);
    if (!before.regular) failPreviewRead('unreadable');
    if (before.size > BigInt(input.byteLimit)) {
      failPreviewRead('too-large');
    }
    if (
      !samePreviewFile(input.validatedIdentity, before) ||
      !samePreviewFile(before, pathIdentity(input.path))
    ) {
      failPreviewRead('changed');
    }

    const bytes = readBoundedPreviewBytes(descriptor, before.size, input.byteLimit);
    const after = descriptorIdentity(descriptor);
    if (
      !samePreviewFile(before, after) ||
      !samePreviewFile(after, pathIdentity(input.path)) ||
      BigInt(bytes.byteLength) !== before.size
    ) {
      failPreviewRead('changed');
    }

    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (input.expectedSha256 !== undefined && sha256 !== input.expectedSha256) {
      failPreviewRead('changed');
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function decodePreviewText(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return failPreviewRead('invalid-text');
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
  validatedIdentity: PreviewFileIdentity,
  expectedSha256?: string,
): ArtifactPreview & { readonly status: 'ready' } {
  const bytes = stablePreviewBytes({
    path: location.absolutePath,
    byteLimit: MAX_EMBEDDED_HTML_BYTES,
    validatedIdentity,
    expectedSha256,
  });
  const source = decodePreviewText(bytes);
  const proof = createHash('sha256')
    .update(location.absolutePath)
    .update('\0')
    .update(bytes)
    .digest('hex');
  const bootstrap = `<meta http-equiv="Content-Security-Policy" content=${JSON.stringify(
    EMBEDDED_ARTIFACT_PREVIEW_POLICY,
  )}>`;
  const html = injectHtmlPreviewBootstrap(sanitizeArtifactMarkup(source), bootstrap);
  return {
    status: 'ready',
    href: location.href,
    sourcePath: '',
    embedded: { base64: Buffer.from(html, 'utf8').toString('base64'), proof },
  };
}

function embeddedVisualSnapshot(
  location: ArtifactPreviewLocation,
  extension: string,
  validatedIdentity: PreviewFileIdentity,
  expectedSha256?: string,
): ArtifactPreview & { readonly status: 'ready' } {
  const contentType = VISUAL_MIME_BY_EXTENSION.get(extension);
  if (contentType === undefined) throw new Error('artifact preview format is unsupported');
  const original = stablePreviewBytes({
    path: location.absolutePath,
    byteLimit: MAX_EMBEDDED_VISUAL_BYTES,
    validatedIdentity,
    expectedSha256,
  });
  const safeBytes =
    contentType === 'image/svg+xml'
      ? Buffer.from(sanitizeArtifactMarkup(decodePreviewText(original), { format: 'svg' }), 'utf8')
      : original;
  const proof = createHash('sha256')
    .update(location.absolutePath)
    .update('\0')
    .update(original)
    .digest('hex');
  const source = `data:${contentType};base64,${safeBytes.toString('base64')}`;
  const html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content=${JSON.stringify(
    EMBEDDED_ARTIFACT_PREVIEW_POLICY,
  )}><style>html,body{height:100%;margin:0;background:#fff}body{display:grid;place-items:center}img{display:block;max-width:100%;max-height:100%;object-fit:contain}</style></head><body><img alt="Artifact preview" src=${JSON.stringify(
    source,
  )}></body></html>`;
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
  readonly expectedFiles?: readonly CheckpointReviewAssetFile[] | undefined;
}): ArtifactPreview {
  if (input.entryPoints.length === 0) return { status: 'unavailable' };

  let firstMissing: ArtifactPreview | undefined;
  let firstUnavailable: Extract<ArtifactPreview, { status: 'unavailable' }> | undefined;
  for (const entryPoint of input.entryPoints) {
    const expected = input.expectedFiles?.find((file) => file.path === entryPoint);
    if (input.expectedFiles !== undefined && expected === undefined) {
      firstMissing ??= { status: 'missing', sourcePath: entryPoint };
      continue;
    }
    const location = artifactPreviewLocation({
      entryPath: entryPoint,
      runFolder: input.runFolder,
      projectRoot: input.projectRoot,
    });
    if (location === undefined) continue;
    const readable = safeReadablePath(location);
    if (readable === undefined) {
      firstMissing ??= { status: 'missing', sourcePath: entryPoint };
      continue;
    }
    const safeLocation = { ...location, absolutePath: readable.path };

    const extension = extensionForPath(location.absolutePath);
    if (extension === '.html' || extension === '.htm') {
      try {
        return {
          ...embeddedHtmlSnapshot(safeLocation, readable.identity, expected?.sha256),
          sourcePath: entryPoint,
        };
      } catch (error) {
        firstUnavailable ??= unavailablePreview(error);
        continue;
      }
    }
    try {
      return {
        ...embeddedVisualSnapshot(safeLocation, extension, readable.identity, expected?.sha256),
        sourcePath: entryPoint,
      };
    } catch (error) {
      firstUnavailable ??= unavailablePreview(error);
    }
  }

  return (
    firstUnavailable ??
    firstMissing ?? { status: 'unsupported', sourcePath: input.entryPoints[0] ?? '' }
  );
}

export const ARTIFACT_PREVIEW_STYLE = [
  '.ap-shell{position:absolute;inset:0;min-width:0;background:#fff}',
  '.ap-shell iframe{display:block;width:100%;height:100%;border:0;background:#fff}',
  '.ap-status{position:absolute;inset:0;z-index:1;display:grid;place-content:center;justify-items:center;gap:9px;padding:28px;background:#fff;color:#71717a;text-align:center}',
  '.ap-status strong{color:#18181b;font-size:16px}',
  '.ap-status code{max-width:min(560px,80vw);overflow-wrap:anywhere;color:#52525b;font:500 10px/1.45 ui-monospace,"SF Mono",Menlo,monospace}',
  '.ap-shell[data-artifact-preview-state="ready"] .ap-status{display:none}',
  '.ap-shell[data-artifact-preview-state="failed"] iframe{visibility:hidden}',
  '.ap-safety{position:absolute;right:10px;bottom:10px;z-index:2;margin:0;border:1px solid #e4e4e7;border-radius:999px;background:rgb(255 255 255/.92);padding:5px 9px;color:#71717a;font:600 10px/1.2 ui-sans-serif,system-ui,sans-serif;box-shadow:0 1px 3px rgb(0 0 0/.08);pointer-events:none}',
  '.ap-retry{min-height:38px;margin-top:4px;border:1px solid #d4d4d8;border-radius:8px;background:#fff;padding:0 13px;color:#18181b;font-size:12px;font-weight:580}',
  '.ap-empty{height:100%;display:grid;place-content:center;gap:10px;padding:28px;background:#fff;color:#71717a;text-align:center}',
  '.ap-empty strong{color:#18181b;font-size:16px}',
  '.ap-empty code{max-width:min(560px,80vw);overflow-wrap:anywhere;color:#52525b;font:500 10px/1.45 ui-monospace,"SF Mono",Menlo,monospace}',
].join('');

export const ARTIFACT_PREVIEW_SCRIPT = `(()=>{const shells=[...document.querySelectorAll('[data-artifact-preview-shell]')];const timeoutMs=8000;const retryCopy='You can retry the preview or continue reviewing without it.';const decode=value=>{const binary=atob(value);const bytes=Uint8Array.from(binary,char=>char.charCodeAt(0));return new TextDecoder().decode(bytes);};const state=(shell,value)=>{shell.dataset.artifactPreviewState=value;if(shell.hasAttribute('data-mv-preview-state'))shell.dataset.mvPreviewState=value;};let ended=false;const endedTitle='This preview ended with the review session.';const endedCopy='Restart the review from your terminal to load it again.';function markEnded(shell){const frame=shell.querySelector('[data-artifact-preview-frame]');const message=shell.querySelector('[data-artifact-preview-message]');const detail=shell.querySelector('[data-artifact-preview-detail]');const retry=shell.querySelector('[data-artifact-preview-retry]');if(!frame||!message||!detail)return;if((frame.dataset.artifactPreviewEmbedded||'').length>0)return;shell.dataset.artifactPreviewGeneration=String(Number(shell.dataset.artifactPreviewGeneration||'0')+1);shell.dataset.artifactPreviewStarted='true';state(shell,'failed');shell.setAttribute('aria-busy','false');message.textContent=endedTitle;detail.textContent=endedCopy;if(retry)retry.hidden=true;}function start(shell){if(shell.dataset.artifactPreviewStarted==='true'&&shell.dataset.artifactPreviewState!=='failed')return;const frame=shell.querySelector('[data-artifact-preview-frame]');const message=shell.querySelector('[data-artifact-preview-message]');const detail=shell.querySelector('[data-artifact-preview-detail]');const retry=shell.querySelector('[data-artifact-preview-retry]');if(!frame||!message||!detail||!retry)return;const generation=String(Number(shell.dataset.artifactPreviewGeneration||'0')+1);shell.dataset.artifactPreviewGeneration=generation;shell.dataset.artifactPreviewStarted='true';state(shell,'loading');shell.setAttribute('aria-busy','true');message.textContent='Loading preview…';detail.textContent='Preparing the local artifact.';retry.hidden=true;let settled=false;const embedded=frame.dataset.artifactPreviewEmbedded||'';const source=frame.dataset.artifactPreviewSrc||'';if(ended&&embedded.length===0){state(shell,'failed');shell.setAttribute('aria-busy','false');message.textContent=endedTitle;detail.textContent=endedCopy;return;}const timer=setTimeout(()=>fail('Preview took too long to load',retryCopy),timeoutMs);function finish(){if(settled||shell.dataset.artifactPreviewGeneration!==generation)return;settled=true;clearTimeout(timer);state(shell,'ready');shell.setAttribute('aria-busy','false');}function fail(title,copy){if(settled||shell.dataset.artifactPreviewGeneration!==generation)return;settled=true;clearTimeout(timer);state(shell,'failed');shell.setAttribute('aria-busy','false');message.textContent=title;detail.textContent=copy;retry.hidden=false;}frame.addEventListener('load',finish,{once:true});frame.addEventListener('error',()=>fail('Preview could not be loaded',retryCopy),{once:true});if(embedded.length>0){try{frame.srcdoc=decode(embedded);}catch{fail('Preview could not be loaded','The embedded artifact snapshot could not be read. '+retryCopy);}}else{frame.src=source;}}shells.forEach(shell=>{const panel=shell.closest('[data-artifact-preview-panel]');const begin=()=>{if(!panel||!panel.hidden)start(shell);};begin();if(panel)new MutationObserver(begin).observe(panel,{attributes:true,attributeFilter:['hidden']});const retry=shell.querySelector('[data-artifact-preview-retry]');if(retry)retry.addEventListener('click',()=>{const frame=shell.querySelector('[data-artifact-preview-frame]');if(!frame)return;const replacement=frame.cloneNode();replacement.removeAttribute('src');replacement.removeAttribute('srcdoc');frame.replaceWith(replacement);shell.dataset.artifactPreviewStarted='false';start(shell);});});document.addEventListener('circuit:checkpoint-review-session-ended',()=>{if(ended)return;ended=true;shells.forEach(markEnded);},{once:true});})();`;

export function artifactPreviewFallbackCopy(preview: ArtifactPreview): {
  readonly title: string;
  readonly detail: string;
  readonly showSourcePath: boolean;
} {
  if (preview.status === 'missing') {
    return {
      title: 'Preview file missing',
      detail: 'Circuit could not find or read this reported file. Review the evidence instead.',
      showSourcePath: true,
    };
  }
  if (preview.status === 'unsupported') {
    return {
      title: 'Preview format unsupported',
      detail: 'This entry point cannot be shown in a browser. Review the evidence instead.',
      showSourcePath: true,
    };
  }
  if (preview.status === 'unavailable') {
    if (preview.reason === 'too-large') {
      return {
        title: 'Preview is too large',
        detail: 'This file exceeds the safe preview limit. Review the evidence instead.',
        showSourcePath: false,
      };
    }
    if (preview.reason === 'changed') {
      return {
        title: 'Preview changed',
        detail:
          'The reported file changed while Circuit prepared this review. Regenerate the checkpoint before relying on it.',
        showSourcePath: false,
      };
    }
    if (preview.reason === 'invalid-text') {
      return {
        title: 'Preview text could not be read',
        detail: 'This HTML or SVG file is not valid UTF-8. Review the evidence instead.',
        showSourcePath: false,
      };
    }
    if (preview.reason === 'unreadable') {
      return {
        title: 'Preview could not be read',
        detail: 'Circuit could not safely prepare this preview. Review the evidence instead.',
        showSourcePath: false,
      };
    }
    return {
      title: 'Preview unavailable',
      detail: 'This option did not report a browser-viewable entry point.',
      showSourcePath: false,
    };
  }
  return {
    title: 'Preview available',
    detail: 'The artifact is ready to review.',
    showSourcePath: false,
  };
}

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
    const copy = artifactPreviewFallbackCopy(preview);
    return (
      <div className="ap-empty" data-artifact-preview-state={preview.status}>
        <strong>{copy.title}</strong>
        <span>{copy.detail}</span>
        {copy.showSourcePath && 'sourcePath' in preview ? (
          <code>{t(preview.sourcePath, MAX_PROMPT_LEN)}</code>
        ) : null}
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
        sandbox=""
        loading={eager ? 'eager' : 'lazy'}
      />
      <p className="ap-safety">Safe preview · Scripts and links are off</p>
    </div>
  );
}
