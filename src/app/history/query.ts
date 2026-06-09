import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  HISTORY_AUTHORITY_NOTICE,
  type HistoryDocumentV1 as HistoryDocument,
  type HistoryDocumentKindV1,
  type HistoryQueryHitV1 as HistoryQueryHit,
  type HistoryQueryResultV1 as HistoryQueryResult,
  HistoryQueryResultV1,
  type HistoryStalenessV1,
  type HistoryWarningV1,
} from '../../schemas/index.js';
import { sha256Hex } from '../../shared/connector-relay.js';
import { resolveRunFilePath } from '../../shared/run-file-paths.js';
import {
  HistoryCommandError,
  type HistoryIndex,
  type HistoryPathOptions,
  historyIndexState,
  readHistoryIndex,
  rebuildHistoryIndex,
  resolveHistoryPaths,
} from './indexer.js';

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'that',
  'this',
  'with',
  'from',
  'into',
  'what',
  'when',
  'where',
  'why',
  'how',
  'run',
  'runs',
  'circuit',
  'history',
  'query',
  'report',
  'reports',
]);

const FAILURE_TERMS = new Set(['fail', 'failed', 'failure', 'aborted', 'abort', 'error']);
const CHECKPOINT_TERMS = new Set(['checkpoint', 'choice', 'selection', 'resume']);
const VERIFICATION_TERMS = new Set(['verify', 'verification', 'proof', 'check', 'test']);

export interface HistoryQueryOptions extends HistoryPathOptions {
  readonly query: string;
  readonly limit?: number;
  readonly perRunLimit?: number;
  readonly flow?: string;
  readonly kind?: HistoryDocumentKindV1;
  readonly rebuildIfStale?: boolean;
  readonly now?: () => Date;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 2 && !STOPWORDS.has(term));
}

function termCounts(tokens: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function idf(documents: readonly HistoryDocument[]): Map<string, number> {
  const docFreq = new Map<string, number>();
  for (const doc of documents) {
    const terms = unique(
      tokenize(`${doc.title}\n${doc.summary}\n${doc.text}\n${doc.facets.join(' ')}`),
    );
    for (const term of terms) docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
  }
  const out = new Map<string, number>();
  for (const [term, count] of docFreq) {
    out.set(term, Math.log((documents.length + 1) / (count + 1)) + 1);
  }
  return out;
}

function weightedTf(doc: HistoryDocument, term: string): number {
  const title = termCounts(tokenize(doc.title)).get(term) ?? 0;
  const summary = termCounts(tokenize(doc.summary)).get(term) ?? 0;
  const text = termCounts(tokenize(doc.text)).get(term) ?? 0;
  const facets = termCounts(tokenize(doc.facets.join(' '))).get(term) ?? 0;
  return title * 5 + summary * 4 + facets * 2 + text;
}

function queryBigrams(terms: readonly string[]): string[] {
  const bigrams: string[] = [];
  for (let index = 0; index < terms.length - 1; index += 1) {
    const left = terms[index];
    const right = terms[index + 1];
    if (left !== undefined && right !== undefined) bigrams.push(`${left} ${right}`);
  }
  return bigrams;
}

function facetBoost(
  queryTerms: readonly string[],
  doc: HistoryDocument,
): {
  readonly score: number;
  readonly reasons: readonly string[];
} {
  let score = 0;
  const reasons: string[] = [];
  const facets = new Set(doc.facets);
  if (queryTerms.some((term) => FAILURE_TERMS.has(term)) && facets.has('failure')) {
    score += 5;
    reasons.push('failure facet matched');
    if (doc.doc_kind === 'trace' || doc.doc_kind === 'run') {
      score += 3;
      reasons.push('failure trace/run prioritized');
    }
  }
  if (queryTerms.some((term) => CHECKPOINT_TERMS.has(term)) && facets.has('checkpoint')) {
    score += 2;
    reasons.push('checkpoint facet matched');
  }
  if (queryTerms.some((term) => VERIFICATION_TERMS.has(term)) && facets.has('verification')) {
    score += 2;
    reasons.push('verification facet matched');
  }
  return { score, reasons };
}

function scoreDocument(input: {
  readonly query: string;
  readonly queryTerms: readonly string[];
  readonly queryIdf: ReadonlyMap<string, number>;
  readonly doc: HistoryDocument;
  readonly indexState: 'fresh' | 'possibly_stale';
}): {
  readonly score: number;
  readonly matchedTerms: readonly string[];
  readonly reasons: readonly string[];
} {
  let score = 0;
  const reasons: string[] = [];
  const matchedTerms: string[] = [];
  for (const term of input.queryTerms) {
    const tf = Math.min(weightedTf(input.doc, term), 3);
    if (tf <= 0) continue;
    matchedTerms.push(term);
    score += (input.queryIdf.get(term) ?? 1) * tf;
  }
  const haystack = `${input.doc.title}\n${input.doc.summary}\n${input.doc.text}`.toLowerCase();
  const queryPhrase = input.query.trim().toLowerCase();
  if (queryPhrase.length > 0 && haystack.includes(queryPhrase)) {
    score += 2;
    reasons.push('exact phrase matched');
  }
  for (const bigram of queryBigrams(input.queryTerms)) {
    if (haystack.includes(bigram)) {
      score += 0.5;
      reasons.push(`bigram matched: ${bigram}`);
    }
  }
  const boosted = facetBoost(input.queryTerms, input.doc);
  score += boosted.score;
  reasons.push(...boosted.reasons);
  if (!input.doc.memory_safe) {
    score -= 3;
    reasons.push('memory-unsafe source penalized');
  }
  if (input.indexState === 'possibly_stale') {
    score -= 0.5;
    reasons.push('possibly stale index penalty');
  }
  if (matchedTerms.length > 0) reasons.push(`matched terms: ${matchedTerms.join(', ')}`);
  return {
    score,
    matchedTerms: unique(matchedTerms),
    reasons,
  };
}

// Lexical relevance of a stored project fact to the run query. Reuses the same
// machinery prior-run recall uses (tokenize -> weighted term frequency capped at
// 3, exact-phrase +2, adjacent-bigram +0.5) so a project fact and a prior-run
// hit are scored on the same scale. A project fact carries no corpus, so IDF is
// flat (every matched term contributes its capped weighted tf directly) and the
// stale/effect signals stay out of this number; those are the gate's job, not
// the scorer's. The caller maps a fact's fields onto these inputs: `summary` is
// the headline (summary weight), each hint `text` is detail (text weight), and
// each hint `applies_to` is a categorical tag (facet weight). Returns 0 when the
// query has no scorable terms, which preserves store order under a flat tie.
export function scoreProjectFactRelevance(input: {
  readonly query: string;
  readonly summary: string;
  readonly hintTexts: readonly string[];
  readonly appliesTo: readonly string[];
}): number {
  const queryTerms = unique(tokenize(input.query));
  if (queryTerms.length === 0) return 0;
  const summaryCounts = termCounts(tokenize(input.summary));
  const textCounts = termCounts(tokenize(input.hintTexts.join('\n')));
  const facetCounts = termCounts(tokenize(input.appliesTo.join(' ')));
  let score = 0;
  for (const term of queryTerms) {
    // Same field weighting as weightedTf (title*5 + summary*4 + facets*2 + text),
    // minus the title field a project fact does not have, then capped at 3.
    const weighted =
      (summaryCounts.get(term) ?? 0) * 4 +
      (facetCounts.get(term) ?? 0) * 2 +
      (textCounts.get(term) ?? 0);
    const tf = Math.min(weighted, 3);
    if (tf > 0) score += tf;
  }
  const haystack = `${input.summary}\n${input.hintTexts.join('\n')}`.toLowerCase();
  const queryPhrase = input.query.trim().toLowerCase();
  if (queryPhrase.length > 0 && haystack.includes(queryPhrase)) score += 2;
  for (const bigram of queryBigrams(queryTerms)) {
    if (haystack.includes(bigram)) score += 0.5;
  }
  return score;
}

function normalizeText(text: string): string {
  return tokenize(text).join(' ');
}

function snippet(doc: HistoryDocument, matchedTerms: readonly string[]): string {
  const haystack = `${doc.summary}\n${doc.text}`.replace(/\s+/g, ' ').trim();
  if (haystack.length <= 420) return haystack;
  const lower = haystack.toLowerCase();
  const firstMatch = matchedTerms
    .map((term) => lower.indexOf(term))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  const start = Math.max(0, (firstMatch ?? 0) - 120);
  return haystack.slice(start, start + 420).trim();
}

function sourceStaleness(doc: HistoryDocument, checkedAt: string): HistoryStalenessV1 {
  if (doc.source_sha256 === undefined) {
    return {
      status: 'unknown',
      reason_codes: ['memory_unverified'],
      checked_at: checkedAt,
    };
  }
  try {
    const sourcePath = resolveRunFilePath(doc.run_folder, doc.source_path);
    if (!existsSync(sourcePath)) {
      return {
        status: 'stale',
        reason_codes: ['memory_stale'],
        checked_at: checkedAt,
      };
    }
    const currentHash = sha256Hex(readFileSync(sourcePath, 'utf8'));
    return currentHash === doc.source_sha256
      ? {
          status: 'fresh',
          reason_codes: ['source_hash_verified'],
          checked_at: checkedAt,
        }
      : {
          status: 'stale',
          reason_codes: ['memory_stale'],
          checked_at: checkedAt,
        };
  } catch {
    return {
      status: 'unknown',
      reason_codes: ['memory_unverified'],
      checked_at: checkedAt,
    };
  }
}

export function queryHistory(options: HistoryQueryOptions): HistoryQueryResult {
  const limit = options.limit ?? 8;
  const perRunLimit = options.perRunLimit ?? 1;
  if (limit < 1 || limit > 50 || !Number.isInteger(limit)) {
    throw new HistoryCommandError('invalid_invocation', '--limit must be an integer from 1 to 50');
  }
  if (perRunLimit < 1 || perRunLimit > 5 || !Number.isInteger(perRunLimit)) {
    throw new HistoryCommandError(
      'invalid_invocation',
      '--per-run-limit must be an integer from 1 to 5',
    );
  }
  const queryTerms = unique(tokenize(options.query));
  const paths = resolveHistoryPaths(options);

  let rebuilt = false;
  let index: HistoryIndex;
  try {
    index = readHistoryIndex(options);
  } catch (error) {
    if (
      error instanceof HistoryCommandError &&
      error.code === 'index_missing' &&
      options.rebuildIfStale === true
    ) {
      index = rebuildHistoryIndex(options);
      rebuilt = true;
    } else {
      throw error;
    }
  }

  let indexState = historyIndexState(paths, index.manifest);
  if (indexState === 'possibly_stale' && options.rebuildIfStale === true) {
    index = rebuildHistoryIndex(options);
    rebuilt = true;
    indexState = historyIndexState(paths, index.manifest);
  }

  const warnings: HistoryWarningV1[] = [...index.manifest.warnings];
  if (indexState === 'possibly_stale') {
    warnings.push({
      code: 'source_invalid',
      message: 'history index may be stale; run circuit history rebuild --json to refresh it',
    });
  }

  const candidates = index.documents.filter((doc) => {
    if (options.flow !== undefined && doc.flow_id !== options.flow) return false;
    if (options.kind !== undefined && doc.doc_kind !== options.kind) return false;
    return true;
  });
  const idfMap = idf(candidates);
  const scored = candidates
    .map((doc) => {
      const score = scoreDocument({
        query: options.query,
        queryTerms,
        queryIdf: idfMap,
        doc,
        indexState,
      });
      return { doc, ...score };
    })
    .filter((candidate) => candidate.score > 0 || options.query.trim().length === 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      const rightDate = Date.parse(right.doc.recorded_at ?? '1970-01-01T00:00:00.000Z');
      const leftDate = Date.parse(left.doc.recorded_at ?? '1970-01-01T00:00:00.000Z');
      if (rightDate !== leftDate) return rightDate - leftDate;
      return left.doc.doc_id.localeCompare(right.doc.doc_id);
    });

  const seenText = new Set<string>();
  const runCounts = new Map<string, number>();
  const selected = [];
  for (const candidate of scored) {
    const textHash = sha256Hex(normalizeText(candidate.doc.text));
    if (seenText.has(textHash)) continue;
    const runCount = runCounts.get(candidate.doc.run_id) ?? 0;
    if (runCount >= perRunLimit) continue;
    seenText.add(textHash);
    runCounts.set(candidate.doc.run_id, runCount + 1);
    selected.push(candidate);
    if (selected.length >= limit) break;
  }

  const checkedAt = (options.now ?? (() => new Date()))().toISOString();
  const hits: HistoryQueryHit[] = selected.map((candidate, index) => {
    const staleness = sourceStaleness(candidate.doc, checkedAt);
    const freshBoost = staleness.status === 'fresh' ? 0.25 : 0;
    return {
      rank: index + 1,
      score: Number((candidate.score + freshBoost).toFixed(6)),
      doc: candidate.doc,
      snippet: snippet(candidate.doc, candidate.matchedTerms),
      matched_terms: [...candidate.matchedTerms],
      ranking_reasons:
        freshBoost > 0 ? [...candidate.reasons, 'source hash verified'] : [...candidate.reasons],
      staleness,
    };
  });

  return HistoryQueryResultV1.parse({
    api_version: 'history-query-result-v1',
    schema_version: 1,
    query: options.query,
    format: 'json',
    index_state: indexState,
    rebuilt,
    authority_notice: HISTORY_AUTHORITY_NOTICE,
    warnings,
    results: hits,
  });
}

export function maybeResolveSourcePath(doc: HistoryDocument): string {
  return resolve(doc.run_folder, doc.source_path);
}
