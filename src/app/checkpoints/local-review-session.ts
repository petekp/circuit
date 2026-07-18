import { randomBytes, timingSafeEqual } from 'node:crypto';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';

import {
  type CheckpointReviewResponse,
  CheckpointReviewResponse as CheckpointReviewResponseSchema,
  MAX_CHECKPOINT_REVIEW_JSON_BYTES,
} from '../../schemas/checkpoint-review-response.js';
import {
  MAX_CHECKPOINT_REVIEW_ASSET_BYTES,
  MAX_CHECKPOINT_REVIEW_ASSET_FILES,
  MAX_CHECKPOINT_REVIEW_ASSET_TOTAL_BYTES,
} from '../../shared/checkpoint-review-assets.js';
import type { CheckpointReviewIdentity } from '../../shared/checkpoint-review/state.js';
import { sanitizeArtifactMarkup } from '../../shared/html/artifact-sanitizer.js';
import {
  decodeMarkupAttribute,
  localReferenceSuffix,
  rewriteCssAssetReferences,
  rewriteHtmlAssetReferences,
  rewriteMarkupAttributeReferences,
  rewriteSvgAssetReferences,
} from './local-review-references.js';
import type { LocalCheckpointReviewAsset } from './local-review-types.js';

const LOOPBACK_HOST = '127.0.0.1';
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const PUBLIC_MESSAGE_LIMIT = 240;
const DEFAULT_REJECTION_MESSAGE = 'The review could not be saved. Try again.';
export const LOCAL_CHECKPOINT_REVIEW_REPLAY_WINDOW_MS = 5_000;
const REVIEW_ASSET_CONTENT_TYPES = new Set([
  'font/woff',
  'font/woff2',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/svg+xml',
  'image/webp',
  'text/css',
  'text/html',
]);
const REVIEW_ASSET_URL_ATTRIBUTES = new Set([
  'data-artifact-preview-src',
  'data-artifact-full-size-src',
  'data-mv-preview-src',
  'href',
  'poster',
  'src',
]);

export const CHECKPOINT_REVIEW_SESSION_HEADER = 'X-Circuit-Review-Session' as const;

export type CheckpointReviewSubmissionDecision =
  | {
      readonly status: 'accepted';
      /** The review is durable even when the remaining run could not continue. */
      readonly continuation?: 'failed';
    }
  | {
      readonly status: 'rejected';
      /** Terminal rejections mean this run can no longer accept this review. */
      readonly terminal: boolean;
      readonly code: string;
      readonly publicMessage: string;
    };

export type LocalCheckpointReviewSessionSettlement =
  | {
      readonly status: 'accepted';
      readonly response: CheckpointReviewResponse;
    }
  | {
      readonly status: 'rejected';
      readonly response: CheckpointReviewResponse;
    };

export type StartLocalCheckpointReviewSessionOptions = {
  /** Exact trusted operator-summary HTML captured by the caller. */
  readonly html: string;
  readonly identity: CheckpointReviewIdentity;
  readonly allowedChoices: readonly string[];
  /** Exact preview bytes captured by the caller; no generic file route exists. */
  readonly assets?: readonly LocalCheckpointReviewAsset[];
  /**
   * Return accepted only after the runtime has durably accepted this response.
   * Retryable rejections keep the page live. Terminal rejections settle the session.
   */
  readonly onSubmit: (
    response: CheckpointReviewResponse,
  ) => CheckpointReviewSubmissionDecision | Promise<CheckpointReviewSubmissionDecision>;
};

export type LocalCheckpointReviewSession = {
  /** The same-origin review page that should be opened in the browser. */
  readonly url: string;
  /** The same-origin endpoint injected into the in-memory browser bootstrap. */
  readonly endpoint: string;
  /** A second capability. The browser sends it in CHECKPOINT_REVIEW_SESSION_HEADER. */
  readonly authorization: string;
  /** Resolves after durable acceptance or a terminal runtime rejection. */
  readonly settled: Promise<LocalCheckpointReviewSessionSettlement>;
  /**
   * After durable acceptance, wait briefly for the browser to replay the exact
   * response. That second request proves the first acknowledgement arrived and
   * gives a lost acknowledgement a bounded recovery window.
   */
  waitForAcceptedReplay(): Promise<void>;
  close(): Promise<void>;
};

type SubmissionState = 'idle' | 'submitting' | 'accepted' | 'terminal-rejected';

type BodyReadResult =
  | { readonly status: 'ok'; readonly body: Buffer }
  | { readonly status: 'too-large' };

type JsonReply = {
  readonly ok: boolean;
  readonly code?: string;
  readonly message: string;
  /** Whether this exact review session has reached a final state. */
  readonly terminal?: boolean;
};

type SubmissionOutcome = {
  readonly status: number;
  readonly reply: JsonReply;
  readonly settlement?: 'accepted' | 'rejected';
};

function capability(): string {
  return randomBytes(32).toString('base64url');
}

function commonHeaders(): Readonly<Record<string, string>> {
  return {
    'cache-control': 'no-store, max-age=0',
    connection: 'close',
    'content-security-policy': "frame-ancestors 'none'",
    'cross-origin-opener-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  };
}

function replyJson(response: ServerResponse, status: number, reply: JsonReply): void {
  response.writeHead(status, {
    ...commonHeaders(),
    'content-type': JSON_CONTENT_TYPE,
  });
  response.end(JSON.stringify(reply));
}

function replyError(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
  terminal = false,
): void {
  replyJson(response, status, { ok: false, code, message, terminal });
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

function secureCapabilityMatch(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;
  const actualBytes = Buffer.from(actual, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return (
    actualBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function hasJsonMediaType(request: IncomingMessage): boolean {
  const contentType = singleHeader(request, 'content-type');
  if (contentType === undefined) return false;
  return contentType.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
}

function declaredBodyTooLarge(request: IncomingMessage): boolean | 'invalid' {
  const rawLength = singleHeader(request, 'content-length');
  if (rawLength === undefined) return false;
  if (!/^\d+$/.test(rawLength)) return 'invalid';
  const length = Number(rawLength);
  if (!Number.isSafeInteger(length)) return 'invalid';
  return length > MAX_CHECKPOINT_REVIEW_JSON_BYTES;
}

function readRequestBody(request: IncomingMessage): Promise<BodyReadResult> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let tooLarge = false;

    request.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > MAX_CHECKPOINT_REVIEW_JSON_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(buffer);
    });
    request.on('end', () => {
      resolve(tooLarge ? { status: 'too-large' } : { status: 'ok', body: Buffer.concat(chunks) });
    });
    request.on('aborted', () => reject(new Error('checkpoint review request was aborted')));
    request.on('error', reject);
  });
}

function decodeUtf8(body: Buffer): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return undefined;
  }
}

function responseMatchesIdentity(
  response: CheckpointReviewResponse,
  identity: CheckpointReviewIdentity,
): boolean {
  return (
    response.run_id === identity.runId &&
    response.step_id === identity.stepId &&
    response.attempt === identity.attempt &&
    response.request_sha256 === identity.requestSha256
  );
}

function responseUsesAllowedChoices(
  response: CheckpointReviewResponse,
  allowedChoices: ReadonlySet<string>,
): boolean {
  if (!allowedChoices.has(response.selection)) return false;
  return response.comments.every(
    (comment) => comment.scope !== 'choice' || allowedChoices.has(comment.choice_id),
  );
}

function sameCheckpointReviewResponse(
  left: CheckpointReviewResponse,
  right: CheckpointReviewResponse,
): boolean {
  if (
    left.schema !== right.schema ||
    left.run_id !== right.run_id ||
    left.step_id !== right.step_id ||
    left.attempt !== right.attempt ||
    left.request_sha256 !== right.request_sha256 ||
    left.selection !== right.selection ||
    left.comments.length !== right.comments.length
  ) {
    return false;
  }
  return left.comments.every((comment, index) => {
    const other = right.comments[index];
    if (other === undefined || comment.scope !== other.scope || comment.body !== other.body) {
      return false;
    }
    return (
      comment.scope === 'overall' ||
      (other.scope === 'choice' && comment.choice_id === other.choice_id)
    );
  });
}

function sanitizedCode(code: string): string {
  return /^[a-z][a-z0-9._-]{0,63}$/.test(code) ? code : 'review_rejected';
}

function sanitizedPublicMessage(message: string): string {
  const withoutControls = Array.from(message, (character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127) ? ' ' : character;
  }).join('');
  const clean = withoutControls.replace(/\s+/g, ' ').trim().slice(0, PUBLIC_MESSAGE_LIMIT).trim();
  return clean.length > 0 ? clean : DEFAULT_REJECTION_MESSAGE;
}

function isSubmissionDecision(value: unknown): value is CheckpointReviewSubmissionDecision {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const decision = value as Readonly<Record<string, unknown>>;
  if (decision.status === 'accepted') {
    return decision.continuation === undefined || decision.continuation === 'failed';
  }
  return (
    decision.status === 'rejected' &&
    typeof decision.terminal === 'boolean' &&
    typeof decision.code === 'string' &&
    typeof decision.publicMessage === 'string'
  );
}

function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => {
    const codePoint = character.codePointAt(0);
    return codePoint === undefined ? '' : `\\u${codePoint.toString(16).padStart(4, '0')}`;
  });
}

function injectBootstrap(
  html: string,
  bootstrap: {
    readonly endpoint: string;
    readonly authorization: string;
    readonly identity: CheckpointReviewIdentity;
  },
): string {
  const script = `<script>window.__CIRCUIT_REVIEW_SESSION__ = ${scriptSafeJson(bootstrap)};</script>`;
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  if (head?.index !== undefined) {
    const insertionPoint = head.index + head[0].length;
    return `${html.slice(0, insertionPoint)}${script}${html.slice(insertionPoint)}`;
  }
  const firstScript = html.search(/<script\b/i);
  if (firstScript >= 0) {
    return `${html.slice(0, firstScript)}${script}${html.slice(firstScript)}`;
  }
  return `${script}${html}`;
}

function isLocalPreviewUrl(value: string): boolean {
  if (value.length === 0 || value.length > 8_192) return false;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      codePoint < 0x21 ||
      codePoint > 0x7e ||
      '"<>`\\'.includes(character)
    ) {
      return false;
    }
  }
  try {
    const parsed = new URL(value, 'http://circuit.invalid/reports/operator-summary.html');
    return (
      parsed.protocol === 'file:' ||
      (parsed.protocol === 'http:' && parsed.origin === 'http://circuit.invalid')
    );
  } catch {
    return false;
  }
}

function rewriteAssetReferences(
  html: string,
  replacements: ReadonlyMap<string, string>,
): { readonly html: string; readonly replaced: ReadonlySet<string> } {
  return rewriteMarkupAttributeReferences(html, REVIEW_ASSET_URL_ATTRIBUTES, replacements);
}

function tagAttributeValue(tag: string, name: string): string | undefined {
  const match = tag.match(
    new RegExp(`(?:\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'iu'),
  );
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function removeTagAttribute(tag: string, name: string): string {
  return tag.replace(
    new RegExp(`\\s+${name}(?=\\s|=|/?>)(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+))?`, 'giu'),
    '',
  );
}

function escapedDoubleQuotedAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

function setTagAttribute(tag: string, name: string, value: string): string {
  const serialized = `${name}="${escapedDoubleQuotedAttribute(value)}"`;
  const existing = new RegExp(`(\\s+)${name}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)`, 'iu');
  if (existing.test(tag)) return tag.replace(existing, `$1${serialized}`);
  return tag.replace(/>$/u, ` ${serialized}>`);
}

function removeCapturedEmbeddedSnapshots(
  html: string,
  capturedSources: ReadonlySet<string>,
): string {
  return html.replace(/<iframe\b[^<>]*>/giu, (tag) => {
    const source = tagAttributeValue(tag, 'data-artifact-preview-src');
    if (source === undefined || !capturedSources.has(source)) return tag;
    return removeTagAttribute(tag, 'data-artifact-preview-embedded');
  });
}

function activateCapturedFullSizeLinks(html: string, routes: ReadonlySet<string>): string {
  return html.replace(/<a\b[^<>]*>/giu, (tag) => {
    const encodedRoute = tagAttributeValue(tag, 'data-artifact-full-size-src');
    if (encodedRoute === undefined) return tag;
    const route = decodeMarkupAttribute(encodedRoute);
    if (!routes.has(route)) return tag;
    return removeTagAttribute(setTagAttribute(tag, 'href', route), 'hidden');
  });
}

function safeReferenceValue(value: string): boolean {
  if (value.length === 0 || value.length > 8_192) return false;
  return Array.from(value).every((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && codePoint >= 0x20 && codePoint !== 0x7f;
  });
}

type CapturedReviewAsset = LocalCheckpointReviewAsset & {
  readonly contentType: string;
  readonly bytes: Buffer;
};

function textAsset(asset: CapturedReviewAsset): string | undefined {
  if (!asset.contentType.startsWith('text/') && asset.contentType !== 'image/svg+xml') {
    return undefined;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(asset.bytes);
  } catch {
    return undefined;
  }
}

function capturedAssets(
  assets: readonly LocalCheckpointReviewAsset[] | undefined,
): readonly CapturedReviewAsset[] {
  if (assets === undefined) return [];
  if (assets.length > MAX_CHECKPOINT_REVIEW_ASSET_FILES) {
    throw new Error('checkpoint review session has too many preview assets');
  }
  const seenIds = new Set<string>();
  const seenPageReferences = new Set<string>();
  let totalBytes = 0;
  const captured = assets.map((asset) => {
    const contentType = asset.contentType.toLowerCase();
    if (
      !/^[A-Za-z0-9_-]{1,80}$/.test(asset.id) ||
      seenIds.has(asset.id) ||
      !Array.isArray(asset.pageReferences) ||
      !Array.isArray(asset.references) ||
      !REVIEW_ASSET_CONTENT_TYPES.has(contentType)
    ) {
      throw new Error('checkpoint review session preview asset is invalid');
    }
    seenIds.add(asset.id);
    for (const reference of asset.pageReferences) {
      if (
        !isLocalPreviewUrl(reference.sourceUrl) ||
        seenPageReferences.has(reference.sourceUrl) ||
        (reference.previewProof !== undefined && !/^[a-f0-9]{64}$/.test(reference.previewProof))
      ) {
        throw new Error('checkpoint review session preview asset is invalid');
      }
      seenPageReferences.add(reference.sourceUrl);
    }
    for (const reference of asset.references) {
      if (
        (reference.kind !== 'html-attribute' &&
          reference.kind !== 'html-srcset' &&
          reference.kind !== 'css-url') ||
        !safeReferenceValue(reference.sourceValue) ||
        !/^[A-Za-z0-9_-]{1,80}$/.test(reference.targetId) ||
        (reference.kind === 'html-attribute' &&
          contentType !== 'text/html' &&
          contentType !== 'image/svg+xml') ||
        (reference.kind === 'html-srcset' &&
          contentType !== 'text/html' &&
          contentType !== 'image/svg+xml') ||
        (reference.kind === 'css-url' &&
          contentType !== 'text/html' &&
          contentType !== 'text/css' &&
          contentType !== 'image/svg+xml')
      ) {
        throw new Error('checkpoint review session preview asset is invalid');
      }
    }
    const bytes = Buffer.from(asset.bytes);
    if (bytes.byteLength > MAX_CHECKPOINT_REVIEW_ASSET_BYTES) {
      throw new Error('checkpoint review session preview asset is too large');
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_CHECKPOINT_REVIEW_ASSET_TOTAL_BYTES) {
      throw new Error('checkpoint review session preview assets are too large');
    }
    return {
      ...asset,
      pageReferences: asset.pageReferences.map((reference) => ({ ...reference })),
      references: asset.references.map((reference) => ({ ...reference })),
      contentType,
      bytes,
    };
  });

  const byId = new Map(captured.map((asset) => [asset.id, asset] as const));
  for (const asset of captured) {
    const source = textAsset(asset);
    if (
      (asset.contentType.startsWith('text/') || asset.contentType === 'image/svg+xml') &&
      source === undefined
    ) {
      throw new Error('checkpoint review session preview asset is invalid');
    }
    for (const reference of asset.references) {
      if (!byId.has(reference.targetId) || source === undefined) {
        throw new Error('checkpoint review session preview asset is invalid');
      }
      const replacements = new Map([[reference.sourceValue, reference.sourceValue]]);
      const markupReplacements = {
        htmlAttribute:
          reference.kind === 'html-attribute' ? replacements : new Map<string, string>(),
        htmlSrcset: reference.kind === 'html-srcset' ? replacements : new Map<string, string>(),
        cssUrl: reference.kind === 'css-url' ? replacements : new Map<string, string>(),
      };
      const probe =
        asset.contentType === 'text/css'
          ? rewriteCssAssetReferences(source, replacements).replaced
          : asset.contentType === 'image/svg+xml'
            ? rewriteSvgAssetReferences(source, markupReplacements).replaced
            : rewriteHtmlAssetReferences(source, markupReplacements).replaced;
      if (!probe.has(reference.sourceValue)) {
        throw new Error('checkpoint review session preview asset reference was not found');
      }
    }
  }

  const reachable = new Set<string>();
  const queue = captured
    .filter((asset) => asset.pageReferences.length > 0)
    .map((asset) => asset.id);
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined || reachable.has(id)) continue;
    reachable.add(id);
    const asset = byId.get(id);
    if (asset === undefined) continue;
    queue.push(...asset.references.map((reference) => reference.targetId));
  }
  if (reachable.size !== captured.length) {
    throw new Error('checkpoint review session preview asset is not referenced by the HTML');
  }
  return captured;
}

function servedAssetBytes(
  asset: CapturedReviewAsset,
  routeById: ReadonlyMap<string, string>,
): Buffer {
  const source = textAsset(asset);
  if (source === undefined) return asset.bytes;
  const htmlReplacements = new Map<string, string>();
  const srcsetReplacements = new Map<string, string>();
  const cssReplacements = new Map<string, string>();
  for (const reference of asset.references) {
    const route = routeById.get(reference.targetId);
    if (route === undefined) continue;
    const replacements =
      reference.kind === 'html-attribute'
        ? htmlReplacements
        : reference.kind === 'html-srcset'
          ? srcsetReplacements
          : cssReplacements;
    replacements.set(
      reference.sourceValue,
      `${route}${localReferenceSuffix(reference.sourceValue, {
        decodeAttributeEntities: reference.kind !== 'css-url',
      })}`,
    );
  }

  let rewritten = source;
  if (asset.contentType === 'text/html') {
    rewritten = rewriteHtmlAssetReferences(rewritten, {
      htmlAttribute: htmlReplacements,
      htmlSrcset: srcsetReplacements,
      cssUrl: cssReplacements,
    }).html;
    rewritten = sanitizeArtifactMarkup(rewritten, {
      allowedResourceUrls: new Set(htmlReplacements.values()),
    });
  } else if (asset.contentType === 'text/css') {
    rewritten = rewriteCssAssetReferences(rewritten, cssReplacements).css;
  } else if (asset.contentType === 'image/svg+xml') {
    rewritten = rewriteSvgAssetReferences(rewritten, {
      htmlAttribute: htmlReplacements,
      htmlSrcset: srcsetReplacements,
      cssUrl: cssReplacements,
    }).svg;
    rewritten = sanitizeArtifactMarkup(rewritten, {
      format: 'svg',
      allowedResourceUrls: new Set(htmlReplacements.values()),
    });
  }
  return Buffer.from(rewritten, 'utf8');
}

function servedContentType(contentType: string): string {
  return contentType.startsWith('text/') || contentType === 'image/svg+xml'
    ? `${contentType}; charset=utf-8`
    : contentType;
}

function artifactContentSecurityPolicy(origin: string): string {
  return [
    "default-src 'none'",
    "script-src 'none'",
    `style-src 'unsafe-inline' ${origin}`,
    `img-src ${origin} data: blob:`,
    `font-src ${origin} data:`,
    `media-src ${origin} data: blob:`,
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    'sandbox',
    "frame-ancestors 'self'",
  ].join('; ');
}

function reviewPageContentSecurityPolicy(origin: string): string {
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    `connect-src ${origin}`,
    `frame-src ${origin}`,
    "form-action 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "worker-src 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function assertValidOptions(options: StartLocalCheckpointReviewSessionOptions): Set<string> {
  const identityProbe = CheckpointReviewResponseSchema.safeParse({
    schema: 'checkpoint.review-response@v1',
    run_id: options.identity.runId,
    step_id: options.identity.stepId,
    attempt: options.identity.attempt,
    request_sha256: options.identity.requestSha256,
    selection: 'choice',
    comments: [],
  });
  if (!identityProbe.success) {
    throw new Error('checkpoint review session identity is invalid');
  }
  if (options.allowedChoices.length === 0) {
    throw new Error('checkpoint review session requires at least one choice');
  }
  const allowedChoices = new Set(options.allowedChoices);
  if (
    allowedChoices.size !== options.allowedChoices.length ||
    options.allowedChoices.some((choice) => choice.length === 0)
  ) {
    throw new Error('checkpoint review session choices must be non-empty and unique');
  }
  return allowedChoices;
}

export async function startLocalCheckpointReviewSession(
  options: StartLocalCheckpointReviewSessionOptions,
): Promise<LocalCheckpointReviewSession> {
  const allowedChoices = assertValidOptions(options);
  const assets = capturedAssets(options.assets);
  const html = options.html;
  const pageReferences = assets.flatMap((asset) => asset.pageReferences);
  const referenceProbe = rewriteAssetReferences(
    html,
    new Map(pageReferences.map((reference) => [reference.sourceUrl, reference.sourceUrl])),
  );
  if (referenceProbe.replaced.size !== pageReferences.length) {
    throw new Error('checkpoint review session preview asset is not referenced by the HTML');
  }
  const identity: CheckpointReviewIdentity = { ...options.identity };
  const routeCapability = capability();
  const authorization = capability();
  const pagePath = `/${routeCapability}/review`;
  const endpointPath = `/${routeCapability}/complete`;
  const assetPaths = new Map<string, (typeof assets)[number]>();
  for (const asset of assets) {
    let assetPath: string;
    do {
      assetPath = `/${routeCapability}/asset/${capability()}`;
    } while (assetPaths.has(assetPath));
    assetPaths.set(assetPath, asset);
  }
  let origin = '';
  let expectedHost = '';
  let state: SubmissionState = 'idle';
  let acceptedResponse: CheckpointReviewResponse | undefined;
  let acceptedReply: JsonReply | undefined;
  let inFlightSubmission:
    | {
        readonly response: CheckpointReviewResponse;
        readonly outcome: Promise<SubmissionOutcome>;
      }
    | undefined;
  let acceptedReplayObserved = false;
  let resolveAcceptedReplay: (() => void) | undefined;
  const acceptedReplay = new Promise<void>((resolve) => {
    resolveAcceptedReplay = resolve;
  });
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let resolveSettled: ((settlement: LocalCheckpointReviewSessionSettlement) => void) | undefined;
  const settled = new Promise<LocalCheckpointReviewSessionSettlement>((resolve) => {
    resolveSettled = resolve;
  });

  async function decideSubmission(submitted: CheckpointReviewResponse): Promise<SubmissionOutcome> {
    let decision: unknown;
    try {
      decision = await options.onSubmit(submitted);
    } catch {
      state = 'idle';
      return {
        status: 500,
        reply: {
          ok: false,
          code: 'save_failed',
          message: DEFAULT_REJECTION_MESSAGE,
          terminal: false,
        },
      };
    }
    if (!isSubmissionDecision(decision)) {
      state = 'idle';
      return {
        status: 500,
        reply: {
          ok: false,
          code: 'save_failed',
          message: DEFAULT_REJECTION_MESSAGE,
          terminal: false,
        },
      };
    }
    if (decision.status === 'rejected') {
      state = decision.terminal ? 'terminal-rejected' : 'idle';
      return {
        status: 409,
        reply: {
          ok: false,
          code: sanitizedCode(decision.code),
          message: sanitizedPublicMessage(decision.publicMessage),
          terminal: decision.terminal,
        },
        ...(decision.terminal ? { settlement: 'rejected' as const } : {}),
      };
    }

    state = 'accepted';
    acceptedResponse = submitted;
    acceptedReply =
      decision.continuation === 'failed'
        ? {
            ok: true,
            code: 'resume_failed_after_save',
            message: 'Review saved, but Circuit could not finish continuing the run.',
            terminal: true,
          }
        : { ok: true, message: 'Review saved.', terminal: true };
    return { status: 200, reply: acceptedReply, settlement: 'accepted' };
  }

  async function handleSubmission(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const requestOrigin = singleHeader(request, 'origin');
    const requestAuthorization = singleHeader(
      request,
      CHECKPOINT_REVIEW_SESSION_HEADER.toLowerCase(),
    );
    if (
      request.headers.host !== expectedHost ||
      requestOrigin !== origin ||
      !secureCapabilityMatch(requestAuthorization, authorization)
    ) {
      request.resume();
      replyError(response, 403, 'forbidden', 'This review session could not be authorized.');
      return;
    }
    if (!hasJsonMediaType(request)) {
      request.resume();
      replyError(response, 415, 'unsupported_media_type', 'Send the review as JSON.');
      return;
    }
    const declaredSize = declaredBodyTooLarge(request);
    if (declaredSize === 'invalid') {
      request.resume();
      replyError(response, 400, 'invalid_request', 'Invalid checkpoint review request.');
      return;
    }
    if (declaredSize) {
      request.resume();
      replyError(response, 413, 'review_too_large', 'The checkpoint review is too large.');
      return;
    }

    const bodyResult = await readRequestBody(request);
    if (bodyResult.status === 'too-large') {
      replyError(response, 413, 'review_too_large', 'The checkpoint review is too large.');
      return;
    }
    const text = decodeUtf8(bodyResult.body);
    if (text === undefined) {
      replyError(response, 400, 'invalid_review', 'Invalid checkpoint review.');
      return;
    }
    let input: unknown;
    try {
      input = JSON.parse(text) as unknown;
    } catch {
      replyError(response, 400, 'invalid_review', 'Invalid checkpoint review.');
      return;
    }
    const parsed = CheckpointReviewResponseSchema.safeParse(input);
    if (!parsed.success) {
      replyError(response, 400, 'invalid_review', 'Invalid checkpoint review.');
      return;
    }
    if (!responseMatchesIdentity(parsed.data, identity)) {
      replyError(
        response,
        409,
        'stale_review',
        'This review is stale. Reload the page and try again.',
      );
      return;
    }
    if (!responseUsesAllowedChoices(parsed.data, allowedChoices)) {
      replyError(
        response,
        409,
        'choice_unavailable',
        'A reviewed choice is no longer available. Reload the page and try again.',
      );
      return;
    }
    if (state === 'submitting') {
      const active = inFlightSubmission;
      if (active !== undefined && sameCheckpointReviewResponse(parsed.data, active.response)) {
        const outcome = await active.outcome;
        replyJson(response, outcome.status, outcome.reply);
        if (outcome.settlement === 'accepted') {
          acceptedReplayObserved = true;
          resolveAcceptedReplay?.();
        }
        return;
      }
      replyError(response, 409, 'submission_in_progress', 'This review is already being saved.');
      return;
    }
    if (state === 'accepted') {
      if (
        acceptedResponse !== undefined &&
        acceptedReply !== undefined &&
        sameCheckpointReviewResponse(parsed.data, acceptedResponse)
      ) {
        replyJson(response, 200, acceptedReply);
        acceptedReplayObserved = true;
        resolveAcceptedReplay?.();
        return;
      }
      replyError(response, 409, 'already_submitted', 'This review was already saved.', true);
      return;
    }
    if (state === 'terminal-rejected') {
      replyError(
        response,
        409,
        'session_finished',
        'This run can no longer accept this review. Open its current checkpoint status.',
        true,
      );
      return;
    }

    state = 'submitting';
    const outcome = decideSubmission(parsed.data);
    inFlightSubmission = { response: parsed.data, outcome };
    const decided = await outcome;
    if (decided.settlement === 'accepted') {
      resolveSettled?.({ status: 'accepted', response: parsed.data });
    } else if (decided.settlement === 'rejected') {
      resolveSettled?.({ status: 'rejected', response: parsed.data });
    }
    replyJson(response, decided.status, decided.reply);
  }

  const server = createServer((request, response) => {
    void (async () => {
      if (closed) {
        request.resume();
        replyError(response, 503, 'session_closed', 'This review session is closed.');
        return;
      }
      if (request.url === pagePath) {
        if (request.method !== 'GET') {
          request.resume();
          replyError(response, 405, 'method_not_allowed', 'Method not allowed.');
          return;
        }
        if (request.headers.host !== expectedHost) {
          request.resume();
          replyError(response, 403, 'forbidden', 'This review session could not be authorized.');
          return;
        }
        const endpoint = `${origin}${endpointPath}`;
        const replacements = new Map<string, string>();
        for (const [assetPath, asset] of assetPaths) {
          for (const reference of asset.pageReferences) {
            replacements.set(
              reference.sourceUrl,
              `${origin}${assetPath}${localReferenceSuffix(reference.sourceUrl)}`,
            );
          }
        }
        const withoutSnapshots = removeCapturedEmbeddedSnapshots(
          html,
          new Set(pageReferences.map((reference) => reference.sourceUrl)),
        );
        const rewritten = rewriteAssetReferences(withoutSnapshots, replacements);
        const withFullSizeLinks = activateCapturedFullSizeLinks(
          rewritten.html,
          new Set(replacements.values()),
        );
        const servedHtml = injectBootstrap(withFullSizeLinks, {
          endpoint,
          authorization,
          identity,
        });
        response.writeHead(200, {
          ...commonHeaders(),
          'content-security-policy': reviewPageContentSecurityPolicy(origin),
          'content-type': 'text/html; charset=utf-8',
          'cross-origin-resource-policy': 'same-origin',
        });
        response.end(servedHtml);
        return;
      }
      const assetRequestPath = request.url?.split('?', 1)[0];
      const asset = assetRequestPath === undefined ? undefined : assetPaths.get(assetRequestPath);
      if (asset !== undefined) {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          request.resume();
          replyError(response, 405, 'method_not_allowed', 'Method not allowed.');
          return;
        }
        if (request.headers.host !== expectedHost) {
          request.resume();
          replyError(response, 403, 'forbidden', 'This review session could not be authorized.');
          return;
        }
        const routeById = new Map(
          Array.from(assetPaths, ([assetPath, captured]) => [captured.id, `${origin}${assetPath}`]),
        );
        const bytes = servedAssetBytes(asset, routeById);
        response.writeHead(200, {
          'cache-control': 'no-store, max-age=0',
          connection: 'close',
          'content-type': servedContentType(asset.contentType),
          'content-length': String(bytes.byteLength),
          'content-security-policy': artifactContentSecurityPolicy(origin),
          'cross-origin-opener-policy': 'same-origin',
          'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff',
          'x-dns-prefetch-control': 'off',
          'x-frame-options': 'SAMEORIGIN',
        });
        response.end(request.method === 'HEAD' ? undefined : bytes);
        return;
      }
      if (request.url === endpointPath) {
        if (request.method !== 'POST') {
          request.resume();
          replyError(response, 405, 'method_not_allowed', 'Method not allowed.');
          return;
        }
        await handleSubmission(request, response);
        return;
      }
      request.resume();
      replyError(response, 404, 'not_found', 'Not found.');
    })().catch(() => {
      if (!response.headersSent) {
        replyError(response, 500, 'server_error', 'The review session hit an unexpected error.');
      } else if (!response.writableEnded) {
        response.end();
      }
    });
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 1;
  server.maxHeadersCount = 32;
  server.maxRequestsPerSocket = 8;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, LOOPBACK_HOST);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error('checkpoint review session did not bind to loopback');
  }
  expectedHost = `${LOOPBACK_HOST}:${address.port}`;
  origin = `http://${expectedHost}`;

  return {
    url: `${origin}${pagePath}`,
    endpoint: `${origin}${endpointPath}`,
    authorization,
    settled,
    async waitForAcceptedReplay() {
      if (state !== 'accepted' || acceptedReplayObserved || closed) return;
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, LOCAL_CHECKPOINT_REVIEW_REPLAY_WINDOW_MS);
        void acceptedReplay.then(() => {
          clearTimeout(timeout);
          resolve();
        });
      });
    },
    close() {
      if (closePromise !== undefined) return closePromise;
      closed = true;
      closePromise = new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) reject(error);
          else resolve();
        });
      });
      return closePromise;
    },
  };
}
