import { createHash } from 'node:crypto';
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CheckpointReviewAssetGroups } from '../../schemas/checkpoint-review-assets.js';
import {
  MAX_CHECKPOINT_REVIEW_ASSET_BYTES,
  MAX_CHECKPOINT_REVIEW_ASSET_FILES,
  MAX_CHECKPOINT_REVIEW_ASSET_TOTAL_BYTES,
} from '../../shared/checkpoint-review-assets.js';
import {
  decodeMarkupAttribute,
  extractCssAssetReferences,
  extractHtmlAssetReferences,
  extractSvgAssetReferences,
} from './local-review-references.js';
import type {
  LocalCheckpointReviewAsset,
  LocalCheckpointReviewAssetReference,
  LocalCheckpointReviewPageReference,
} from './local-review-types.js';

const REPORT_RELATIVE_PATH = 'reports/operator-summary.html';
const READ_CHUNK_BYTES = 64 * 1024;
const MIME_BY_EXTENSION = new Map([
  ['.css', 'text/css'],
  ['.gif', 'image/gif'],
  ['.htm', 'text/html'],
  ['.html', 'text/html'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

export type CaptureLocalCheckpointReviewAssetsOptions = {
  /** Exact trusted HTML returned by Circuit's checkpoint renderer. */
  readonly html: string;
  readonly runFolder: string;
  readonly projectRoot?: string | undefined;
  /** Exact project-relative asset identities carried by the checkpoint request. */
  readonly reviewAssets: CheckpointReviewAssetGroups;
};

type FileIdentity = {
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly modified: bigint;
  readonly changed: bigint;
  readonly regular: boolean;
};

type StableFile = {
  readonly realPath: string;
  readonly bytes: Buffer;
};

type PendingAsset = {
  readonly realPath: string;
  readonly root: string;
  readonly contentType: string;
  readonly bytes: Buffer;
  readonly pageReferences: LocalCheckpointReviewPageReference[];
  readonly unresolvedReferences: Array<{
    readonly kind: LocalCheckpointReviewAssetReference['kind'];
    readonly sourceValue: string;
    readonly targetPath: string;
  }>;
  readonly expectedFiles: ReadonlyMap<string, string>;
};

type ExpectedAssetGroup = {
  readonly root: string;
  readonly entryPoints: ReadonlySet<string>;
  readonly files: ReadonlyMap<string, string>;
};

type HtmlTag = {
  readonly name: string;
  readonly raw: string;
  readonly end: number;
  readonly attributes: ReadonlyMap<string, string>;
};

function isInside(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return (
    fromRoot !== '' &&
    !fromRoot.startsWith(`..${sep}`) &&
    fromRoot !== '..' &&
    !isAbsolute(fromRoot)
  );
}

function safeRealFile(rootPath: string, targetPath: string): string | undefined {
  try {
    const root = resolve(rootPath);
    const target = resolve(targetPath);
    const rootInfo = lstatSync(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !isInside(root, target)) {
      return undefined;
    }

    const realRoot = realpathSync.native(root);
    let cursor = root;
    for (const segment of relative(root, target).split(sep)) {
      cursor = resolve(cursor, segment);
      if (lstatSync(cursor).isSymbolicLink()) return undefined;
      const realCursor = realpathSync.native(cursor);
      if (realCursor !== realRoot && !isInside(realRoot, realCursor)) return undefined;
    }

    const realTarget = realpathSync.native(target);
    if (!isInside(realRoot, realTarget) || !statSync(realTarget).isFile()) return undefined;
    return realTarget;
  } catch {
    return undefined;
  }
}

function safeRealDirectory(rootPath: string, targetPath: string): string | undefined {
  try {
    const root = resolve(rootPath);
    const target = resolve(targetPath);
    const rootInfo = lstatSync(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !isInside(root, target)) {
      return undefined;
    }

    const realRoot = realpathSync.native(root);
    let cursor = root;
    for (const segment of relative(root, target).split(sep)) {
      cursor = resolve(cursor, segment);
      const info = lstatSync(cursor);
      if (info.isSymbolicLink()) return undefined;
      const realCursor = realpathSync.native(cursor);
      if (!isInside(realRoot, realCursor)) return undefined;
    }

    const realTarget = realpathSync.native(target);
    if (!isInside(realRoot, realTarget) || !statSync(realTarget).isDirectory()) return undefined;
    return realTarget;
  } catch {
    return undefined;
  }
}

function identityFromDescriptor(descriptor: number): FileIdentity {
  const info = fstatSync(descriptor, { bigint: true });
  return {
    device: info.dev,
    inode: info.ino,
    size: info.size,
    modified: info.mtimeNs,
    changed: info.ctimeNs,
    regular: info.isFile(),
  };
}

function identityFromPath(path: string): FileIdentity {
  const info = statSync(path, { bigint: true });
  return {
    device: info.dev,
    inode: info.ino,
    size: info.size,
    modified: info.mtimeNs,
    changed: info.ctimeNs,
    regular: info.isFile(),
  };
}

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.device === right.device && left.inode === right.inode && left.regular && right.regular
  );
}

function sameSnapshot(left: FileIdentity, right: FileIdentity): boolean {
  return (
    sameFile(left, right) &&
    left.size === right.size &&
    left.modified === right.modified &&
    left.changed === right.changed
  );
}

function readBounded(descriptor: number, limit: number): Buffer | undefined {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= limit) {
    const remaining = limit + 1 - total;
    const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
    const read = readSync(descriptor, chunk, 0, chunk.byteLength, null);
    if (read === 0) break;
    chunks.push(chunk.subarray(0, read));
    total += read;
  }
  return total > limit ? undefined : Buffer.concat(chunks, total);
}

function captureStableBytes(input: {
  readonly targetPath: string;
  readonly root: string;
  readonly byteLimit: number;
}): StableFile | undefined {
  const beforePath = safeRealFile(input.root, input.targetPath);
  if (beforePath === undefined) return undefined;

  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      beforePath,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    const before = identityFromDescriptor(descriptor);
    if (!before.regular || before.size > BigInt(input.byteLimit)) return undefined;

    const afterPath = safeRealFile(input.root, input.targetPath);
    if (afterPath !== beforePath || !sameFile(before, identityFromPath(afterPath))) {
      return undefined;
    }

    const bytes = readBounded(descriptor, input.byteLimit);
    if (bytes === undefined) return undefined;
    const after = identityFromDescriptor(descriptor);
    if (!sameSnapshot(before, after) || BigInt(bytes.byteLength) !== before.size) return undefined;
    return { realPath: beforePath, bytes };
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Omission is safer than turning cleanup failure into a serving fallback.
      }
    }
  }
}

function tagAt(html: string, start: number): HtmlTag | undefined {
  if (html[start] !== '<') return undefined;
  if (html.startsWith('<!--', start)) {
    const commentEnd = html.indexOf('-->', start + 4);
    return {
      name: '!--',
      raw: html.slice(start, commentEnd === -1 ? html.length : commentEnd + 3),
      end: commentEnd === -1 ? html.length : commentEnd + 3,
      attributes: new Map(),
    };
  }

  let cursor = start + 1;
  if (html[cursor] === '/') cursor += 1;
  while (/\s/u.test(html[cursor] ?? '')) cursor += 1;
  const nameStart = cursor;
  while (/[A-Za-z0-9:-]/u.test(html[cursor] ?? '')) cursor += 1;
  if (cursor === nameStart) return undefined;
  const name = html.slice(nameStart, cursor).toLowerCase();
  let quote: string | undefined;
  while (cursor < html.length) {
    const character = html[cursor];
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      cursor += 1;
      break;
    }
    cursor += 1;
  }
  const raw = html.slice(start, cursor);
  const attributes = new Map<string, string>();
  for (const attribute of raw.matchAll(
    /\b([A-Za-z][A-Za-z0-9:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))/gu,
  )) {
    const attributeName = attribute[1]?.toLowerCase();
    const value = attribute[2] ?? attribute[3] ?? attribute[4];
    if (attributeName !== undefined && value !== undefined && !attributes.has(attributeName)) {
      attributes.set(attributeName, value);
    }
  }
  return { name, raw, end: cursor, attributes };
}

function htmlTags(html: string): readonly HtmlTag[] {
  const tags: HtmlTag[] = [];
  let cursor = 0;
  while (cursor < html.length) {
    const start = html.indexOf('<', cursor);
    if (start === -1) break;
    const tag = tagAt(html, start);
    if (tag === undefined) {
      cursor = start + 1;
      continue;
    }
    tags.push(tag);
    cursor = tag.end;

    if (tag.name === 'script' && !tag.raw.startsWith('</')) {
      const close = html.toLowerCase().indexOf('</script', cursor);
      if (close !== -1) cursor = close;
    }
  }
  return tags;
}

function previewEntries(html: string): readonly LocalCheckpointReviewPageReference[] {
  const entries: LocalCheckpointReviewPageReference[] = [];
  const seen = new Set<string>();
  for (const tag of htmlTags(html)) {
    if (tag.name !== 'iframe' || tag.raw.startsWith('</')) continue;
    const sourceUrl = tag.attributes.get('data-artifact-preview-src');
    if (sourceUrl === undefined || sourceUrl.length === 0 || seen.has(sourceUrl)) continue;
    const proof = tag.attributes.get('data-artifact-preview-proof');
    entries.push({
      sourceUrl,
      ...(proof === undefined ? {} : { previewProof: proof }),
    });
    seen.add(sourceUrl);
  }
  return entries;
}

function decodeUtf8(bytes: Buffer): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function resolvedFilePath(
  sourceUrl: string,
  baseUrl: URL,
  decodeAttributeEntities = true,
): string | undefined {
  try {
    const decoded = (decodeAttributeEntities ? decodeMarkupAttribute(sourceUrl) : sourceUrl).trim();
    if (decoded.startsWith('#')) return undefined;
    if (decoded.startsWith('//')) return undefined;
    const resolved = new URL(decoded, baseUrl);
    if (resolved.protocol !== 'file:') return undefined;
    resolved.search = '';
    resolved.hash = '';
    // Marketplace-safe by build-pipeline emission: this code is bundled unchanged
    // into each host runtime, while `resolved` comes from the explicit run or
    // project preview root and never from the plugin installation directory.
    return fileURLToPath(resolved);
  } catch {
    return undefined;
  }
}

function referencesForAsset(asset: PendingAsset): readonly {
  readonly kind: LocalCheckpointReviewAssetReference['kind'];
  readonly sourceValue: string;
}[] {
  const source = decodeUtf8(asset.bytes);
  if (source === undefined) return [];
  if (asset.contentType === 'text/html') return extractHtmlAssetReferences(source);
  if (asset.contentType === 'text/css') return extractCssAssetReferences(source);
  if (asset.contentType === 'image/svg+xml') return extractSvgAssetReferences(source);
  return [];
}

/**
 * Capture a closed, capability-ready graph from the preview entries named by
 * Circuit's trusted checkpoint HTML. Files must remain regular, symlink-free,
 * and inside the entry's root for the entire bounded read. Missing or unsafe
 * dependencies are omitted and later blocked by the preview CSP.
 */
export function captureLocalCheckpointReviewAssets(
  options: CaptureLocalCheckpointReviewAssetsOptions,
): readonly LocalCheckpointReviewAsset[] {
  const reportUrl = pathToFileURL(resolve(options.runFolder, REPORT_RELATIVE_PATH));
  const strictGroups: readonly ExpectedAssetGroup[] = (() => {
    if (options.reviewAssets.length === 0) return [];
    if (options.projectRoot === undefined) {
      throw new Error('checkpoint review assets require the bound project root');
    }
    const projectRoot = options.projectRoot;
    const verified = CheckpointReviewAssetGroups.parse(options.reviewAssets);
    const realProjectRoot = realpathSync.native(resolve(projectRoot));
    return verified.map((group) => {
      const root = safeRealDirectory(projectRoot, resolve(projectRoot, group.root));
      if (root === undefined) {
        throw new Error('checkpoint review preview root could not be captured safely');
      }
      const entryPoints = new Set(
        group.entry_points.map((entryPoint) => {
          const entry = safeRealFile(root, resolve(realProjectRoot, entryPoint));
          if (entry === undefined) {
            throw new Error('checkpoint review preview entry is not bound to the checkpoint');
          }
          return entry;
        }),
      );
      const files = new Map(
        group.files.map((file) => [resolve(realProjectRoot, file.path), file.sha256]),
      );
      return { root, entryPoints, files };
    });
  })();
  const pending: PendingAsset[] = [];
  const pathIndexes = new Map<string, number>();
  let totalBytes = 0;

  function addAsset(input: {
    readonly targetPath: string;
    readonly root: string;
    readonly pageReference?: LocalCheckpointReviewPageReference;
    readonly expectedFiles: ReadonlyMap<string, string>;
    readonly required?: boolean | undefined;
  }): number | undefined {
    const contentType = MIME_BY_EXTENSION.get(extname(input.targetPath).toLowerCase());
    if (contentType === undefined) return undefined;
    const remaining = MAX_CHECKPOINT_REVIEW_ASSET_TOTAL_BYTES - totalBytes;
    if (remaining <= 0) {
      throw new Error('checkpoint review preview assets exceed the safe total byte limit');
    }
    const captured = captureStableBytes({
      targetPath: input.targetPath,
      root: input.root,
      byteLimit: Math.min(MAX_CHECKPOINT_REVIEW_ASSET_BYTES, remaining),
    });
    if (captured === undefined) {
      if (input.required === true) {
        throw new Error('checkpoint review preview file could not be captured safely');
      }
      return undefined;
    }
    const expectedSha256 = input.expectedFiles.get(captured.realPath);
    if (expectedSha256 === undefined) {
      if (input.required === true) {
        throw new Error('checkpoint review preview references a file not bound to the checkpoint');
      }
      return undefined;
    }
    if (createHash('sha256').update(captured.bytes).digest('hex') !== expectedSha256) {
      throw new Error('checkpoint review asset files changed after their identity was recorded');
    }
    if (
      input.pageReference?.previewProof !== undefined &&
      createHash('sha256')
        .update(captured.realPath)
        .update('\0')
        .update(captured.bytes)
        .digest('hex') !== input.pageReference.previewProof
    ) {
      return undefined;
    }

    const existing = pathIndexes.get(captured.realPath);
    if (existing !== undefined) {
      const pageReferences = pending[existing]?.pageReferences;
      if (
        input.pageReference !== undefined &&
        pageReferences !== undefined &&
        !pageReferences.some((reference) => reference.sourceUrl === input.pageReference?.sourceUrl)
      ) {
        pageReferences.push(input.pageReference);
      }
      return existing;
    }

    if (pending.length >= MAX_CHECKPOINT_REVIEW_ASSET_FILES) {
      throw new Error('checkpoint review has too many preview assets to capture safely');
    }

    totalBytes += captured.bytes.byteLength;
    const index = pending.length;
    pathIndexes.set(captured.realPath, index);
    pending.push({
      realPath: captured.realPath,
      root: realpathSync.native(resolve(input.root)),
      contentType,
      bytes: captured.bytes,
      pageReferences: input.pageReference === undefined ? [] : [input.pageReference],
      unresolvedReferences: [],
      expectedFiles: input.expectedFiles,
    });
    return index;
  }

  for (const pageReference of previewEntries(options.html)) {
    const targetPath = resolvedFilePath(pageReference.sourceUrl, reportUrl);
    if (targetPath === undefined) continue;
    const realTarget = (() => {
      try {
        return realpathSync.native(resolve(targetPath));
      } catch {
        return undefined;
      }
    })();
    if (realTarget === undefined) {
      throw new Error('checkpoint review preview entry is not bound to the checkpoint');
    }
    const group = strictGroups.find((candidate) => candidate.entryPoints.has(realTarget));
    if (group === undefined) {
      throw new Error('checkpoint review preview entry is not bound to the checkpoint');
    }
    addAsset({
      targetPath: realTarget,
      root: group.root,
      pageReference,
      expectedFiles: group.files,
      required: true,
    });
  }

  for (let index = 0; index < pending.length; index += 1) {
    const asset = pending[index];
    if (asset === undefined) continue;
    const baseUrl = pathToFileURL(asset.realPath);
    for (const reference of referencesForAsset(asset)) {
      const targetPath = resolvedFilePath(
        reference.sourceValue,
        baseUrl,
        reference.kind !== 'css-url',
      );
      if (targetPath === undefined) continue;
      const targetIndex = addAsset({
        targetPath,
        root: asset.root,
        expectedFiles: asset.expectedFiles,
      });
      if (targetIndex === undefined) continue;
      const target = pending[targetIndex];
      if (target === undefined) continue;
      asset.unresolvedReferences.push({
        kind: reference.kind,
        sourceValue: reference.sourceValue,
        targetPath: target.realPath,
      });
    }
  }

  return pending.map((asset, index) => ({
    id: `asset-${index}`,
    pageReferences: asset.pageReferences,
    contentType: asset.contentType,
    bytes: asset.bytes,
    references: asset.unresolvedReferences.flatMap((reference) => {
      const targetIndex = pathIndexes.get(reference.targetPath);
      return targetIndex === undefined
        ? []
        : [
            {
              kind: reference.kind,
              sourceValue: reference.sourceValue,
              targetId: `asset-${targetIndex}`,
            },
          ];
    }),
  }));
}
