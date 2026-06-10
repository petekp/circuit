import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  DEFAULT_RUNS_BASE,
  HistoryCommandError,
  computeRunFolderNamesHash,
  listCandidateRunFolders,
} from '../../history/run-corpus.js';
import {
  type HistoryDocumentV1 as HistoryDocument,
  HistoryDocumentV1,
  HistoryErrorV1,
  type HistoryManifestV1 as HistoryManifest,
  HistoryManifestV1,
  type HistoryStatusV1 as HistoryStatus,
  HistoryStatusV1,
  type HistoryWarningV1,
} from '../../schemas/index.js';
import { CONTROL_PLANE_HISTORY_DIR } from '../../shared/control-plane-paths.js';
import { mtimeMs } from '../../shared/run-artifact-io.js';
import { extractRunHistoryDocuments } from './extract.js';
import { collectRunSourceFiles } from './run-source-files.js';

export const DEFAULT_INDEX_DIR = CONTROL_PLANE_HISTORY_DIR;
export const HISTORY_DOCUMENTS_FILE = 'documents.v1.jsonl';
export const HISTORY_MANIFEST_FILE = 'manifest.v1.json';
export const HISTORY_MEMORY_MERGE_FILE = 'memory-merge.v1.json';
export const HISTORY_MEMORY_EFFECT_FILE = 'memory-effect.v1.json';
export {
  DEFAULT_RUNS_BASE,
  HistoryCommandError,
  computeRunFolderNamesHash,
  listCandidateRunFolders,
} from '../../history/run-corpus.js';

export interface HistoryPaths {
  readonly repoRoot: string;
  readonly runsBase: string;
  readonly indexDir: string;
  readonly manifestPath: string;
  readonly documentsPath: string;
}

export interface HistoryPathOptions {
  readonly repoRoot?: string;
  readonly runsBase?: string;
  readonly indexDir?: string;
}

export interface HistoryIndex {
  readonly manifest: HistoryManifest;
  readonly documents: readonly HistoryDocument[];
}

export function resolveHistoryPaths(options: HistoryPathOptions = {}): HistoryPaths {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const runsBase = resolve(repoRoot, options.runsBase ?? DEFAULT_RUNS_BASE);
  const indexDir = resolve(repoRoot, options.indexDir ?? DEFAULT_INDEX_DIR);
  return {
    repoRoot,
    runsBase,
    indexDir,
    manifestPath: join(indexDir, HISTORY_MANIFEST_FILE),
    documentsPath: join(indexDir, HISTORY_DOCUMENTS_FILE),
  };
}

export function computeLatestSourceMtime(sourceFiles: readonly string[]): number {
  let latest = 0;
  for (const file of sourceFiles) {
    try {
      latest = Math.max(latest, mtimeMs(file));
    } catch {
      // Missing files after rebuild make the existing index possibly stale at query time.
    }
  }
  return latest;
}

export function computeHistoryFingerprint(input: {
  readonly runsBase: string;
  readonly sourceFiles?: readonly string[];
}): HistoryManifest['source_fingerprint'] {
  const runFolders = listCandidateRunFolders(input.runsBase);
  return {
    run_folder_names_sha256: computeRunFolderNamesHash(runFolders),
    latest_source_mtime_ms: computeLatestSourceMtime(
      input.sourceFiles ?? collectSourceFiles(runFolders),
    ),
  };
}

function collectSourceFiles(runFolders: readonly string[]): readonly string[] {
  const files: string[] = [];
  for (const runFolder of runFolders) {
    files.push(...collectRunSourceFiles(runFolder));
  }
  return files.sort();
}

export function errorEnvelope(error: HistoryCommandError) {
  return HistoryErrorV1.parse({
    api_version: 'history-error-v1',
    schema_version: 1,
    error: {
      code: error.code,
      message: error.message,
    },
    ...(error.paths.runsBase === undefined ? {} : { runs_base: error.paths.runsBase }),
    ...(error.paths.indexDir === undefined ? {} : { index_dir: error.paths.indexDir }),
  });
}

export function rebuildHistoryIndex(
  options: HistoryPathOptions & { readonly now?: () => Date } = {},
) {
  const paths = resolveHistoryPaths(options);
  const runFolders = listCandidateRunFolders(paths.runsBase);
  const documents: HistoryDocument[] = [];
  const warnings: HistoryWarningV1[] = [];
  const sourceFiles: string[] = [];

  for (const runFolder of runFolders) {
    try {
      const extracted = extractRunHistoryDocuments(runFolder);
      documents.push(...extracted.documents);
      warnings.push(...extracted.warnings);
      sourceFiles.push(...extracted.sourceFiles);
    } catch (error) {
      warnings.push({
        code: 'run_skipped',
        message: `run skipped: ${error instanceof Error ? error.message : String(error)}`,
        run_folder: runFolder,
      });
    }
  }

  const manifest = HistoryManifestV1.parse({
    api_version: 'history-index-v1',
    schema_version: 1,
    created_at: (options.now ?? (() => new Date()))().toISOString(),
    repo_root: paths.repoRoot,
    runs_base: paths.runsBase,
    index_dir: paths.indexDir,
    documents_path: HISTORY_DOCUMENTS_FILE,
    run_count: runFolders.length,
    document_count: documents.length,
    source_fingerprint: {
      run_folder_names_sha256: computeRunFolderNamesHash(runFolders),
      latest_source_mtime_ms: computeLatestSourceMtime(sourceFiles),
    },
    warnings,
  });

  mkdirSync(paths.indexDir, { recursive: true });
  const documentsJsonl = `${documents.map((doc) => JSON.stringify(HistoryDocumentV1.parse(doc))).join('\n')}\n`;
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;

  const documentsTmp = `${paths.documentsPath}.tmp-${process.pid}`;
  const manifestTmp = `${paths.manifestPath}.tmp-${process.pid}`;
  writeFileSync(documentsTmp, documentsJsonl, 'utf8');
  writeFileSync(manifestTmp, manifestJson, 'utf8');

  HistoryManifestV1.parse(JSON.parse(readFileSync(manifestTmp, 'utf8')) as unknown);
  for (const line of readFileSync(documentsTmp, 'utf8').split('\n')) {
    if (line.trim().length === 0) continue;
    HistoryDocumentV1.parse(JSON.parse(line) as unknown);
  }

  renameSync(documentsTmp, paths.documentsPath);
  renameSync(manifestTmp, paths.manifestPath);

  return {
    manifest,
    documents,
  };
}

export function readHistoryManifest(paths: HistoryPaths): HistoryManifest {
  if (!existsSync(paths.manifestPath) || !existsSync(paths.documentsPath)) {
    throw new HistoryCommandError('index_missing', `history index missing: ${paths.indexDir}`, {
      runsBase: paths.runsBase,
      indexDir: paths.indexDir,
    });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(paths.manifestPath, 'utf8')) as unknown;
  } catch (error) {
    throw new HistoryCommandError(
      'index_corrupt',
      `history manifest corrupt: ${error instanceof Error ? error.message : String(error)}`,
      { runsBase: paths.runsBase, indexDir: paths.indexDir },
    );
  }
  if (
    raw !== null &&
    typeof raw === 'object' &&
    !Array.isArray(raw) &&
    'schema_version' in raw &&
    (raw as { schema_version?: unknown }).schema_version !== 1
  ) {
    throw new HistoryCommandError('index_unsupported', 'history index schema is unsupported', {
      runsBase: paths.runsBase,
      indexDir: paths.indexDir,
    });
  }
  const parsed = HistoryManifestV1.safeParse(raw);
  if (!parsed.success) {
    throw new HistoryCommandError('index_corrupt', parsed.error.message, {
      runsBase: paths.runsBase,
      indexDir: paths.indexDir,
    });
  }
  return parsed.data;
}

export function readHistoryIndex(options: HistoryPathOptions = {}): HistoryIndex {
  const paths = resolveHistoryPaths(options);
  const manifest = readHistoryManifest(paths);
  let documentsRaw = '';
  try {
    documentsRaw = readFileSync(paths.documentsPath, 'utf8');
  } catch (error) {
    throw new HistoryCommandError(
      'index_corrupt',
      `history documents unreadable: ${error instanceof Error ? error.message : String(error)}`,
      { runsBase: paths.runsBase, indexDir: paths.indexDir },
    );
  }
  const documents: HistoryDocument[] = [];
  for (const [index, line] of documentsRaw.split('\n').entries()) {
    if (line.trim().length === 0) continue;
    try {
      documents.push(HistoryDocumentV1.parse(JSON.parse(line) as unknown));
    } catch (error) {
      throw new HistoryCommandError(
        'index_corrupt',
        `history document line ${index + 1} corrupt: ${error instanceof Error ? error.message : String(error)}`,
        { runsBase: paths.runsBase, indexDir: paths.indexDir },
      );
    }
  }
  return { manifest, documents };
}

export function historyIndexState(
  paths: HistoryPaths,
  manifest: HistoryManifest,
): 'fresh' | 'possibly_stale' {
  const current = computeHistoryFingerprint({ runsBase: paths.runsBase });
  return current.run_folder_names_sha256 === manifest.source_fingerprint.run_folder_names_sha256 &&
    current.latest_source_mtime_ms === manifest.source_fingerprint.latest_source_mtime_ms
    ? 'fresh'
    : 'possibly_stale';
}

export function historyStatus(options: HistoryPathOptions = {}): HistoryStatus {
  const paths = resolveHistoryPaths(options);
  try {
    const manifest = readHistoryManifest(paths);
    const state = historyIndexState(paths, manifest);
    return HistoryStatusV1.parse({
      api_version: 'history-status-v1',
      schema_version: 1,
      index_exists: true,
      index_state: state,
      runs_base: paths.runsBase,
      index_dir: paths.indexDir,
      manifest,
      warnings: manifest.warnings,
    });
  } catch (error) {
    if (error instanceof HistoryCommandError) {
      if (error.code === 'index_missing') {
        return HistoryStatusV1.parse({
          api_version: 'history-status-v1',
          schema_version: 1,
          index_exists: false,
          index_state: 'missing',
          runs_base: paths.runsBase,
          index_dir: paths.indexDir,
          warnings: [],
        });
      }
      if (error.code === 'index_unsupported' || error.code === 'index_corrupt') {
        return HistoryStatusV1.parse({
          api_version: 'history-status-v1',
          schema_version: 1,
          index_exists: true,
          index_state: error.code === 'index_unsupported' ? 'unsupported' : 'corrupt',
          runs_base: paths.runsBase,
          index_dir: paths.indexDir,
          warnings: [
            {
              code: 'source_invalid',
              message: error.message,
            },
          ],
        });
      }
    }
    throw error;
  }
}
