import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { codexStateDir } from './state-dir.js';

// Codex default-model resolver.
//
// Circuit runs codex with `--ignore-user-config` (a capability-boundary
// invariant — see CODEX_WRITE_FLAGS), so the operator's `~/.codex/config.toml`
// `model = ...` is intentionally NOT consulted. When a codex relay step pins no
// model of its own, codex would otherwise fall back to its CLI-baked default,
// which a given account may not be entitled to (e.g. a ChatGPT-account default
// that returns a 400 "model is not supported"). This module resolves a safe
// default from the codex models cache instead, so the connector always sends an
// explicit `-m <model>` and never inherits an unentitled CLI default.
//
// The cache (`<CODEX_HOME>/models_cache.json`, refreshed by codex on most runs)
// lives under CODEX_HOME, so it is readable even with `--ignore-user-config`
// (that flag drops config.toml/rules, not the cache). Reading it here is a
// connector-DISPATCH concern, deliberately separate from selection resolution:
// the selection layer stays a pure function of config + dial (so the audit
// trace's `resolved_selection` is machine-independent and the idempotency guard
// `assertRelayGuidanceMatchesPlan` holds), while this machine-local default is
// resolved only at the point of a real spawn.
//
// Field names below are grounded against a real capture. The top level is
// `{ fetched_at, etag, client_version, models: [...] }`; each model carries
// `slug` (the model id passed to `-m`), `visibility` ("list" | "hide"),
// `supported_in_api` (bool), and `priority` (int, lower = more prominent).

export const CODEX_MODELS_CACHE_FILENAME = 'models_cache.json';

// CODEX_HOME overrides the default `~/.codex`. Mirrors codex's own resolution
// so Circuit reads the same cache the CLI writes. The canonical resolver
// lives in state-dir.ts, shared with the writability probe.
export function codexHomeDir(): string {
  return codexStateDir(process.env);
}

export function codexModelsCachePath(): string {
  return join(codexHomeDir(), CODEX_MODELS_CACHE_FILENAME);
}

interface CandidateCodexModel {
  readonly slug: string;
  readonly priority: number;
}

// A model is a default candidate iff it is API-listed: visible in the picker
// (`visibility === "list"`) AND usable through the API (`supported_in_api`).
// Anything else — a hidden preview, a chat-only model — must never be picked as
// a silent default even if its priority is lower.
function candidateFrom(value: unknown): CandidateCodexModel | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.visibility !== 'list') return undefined;
  if (record.supported_in_api !== true) return undefined;
  const priority = record.priority;
  if (typeof priority !== 'number' || !Number.isFinite(priority)) return undefined;
  // Trim and reject a non-substantive slug (empty or whitespace-only). A slug
  // like "   " has length > 0 but is not a usable model id — passing it as
  // `-m "   "` would cause the exact mid-run 400 this resolver prevents. Return
  // the trimmed value so `-m` never receives leading/trailing whitespace.
  const slug = typeof record.slug === 'string' ? record.slug.trim() : undefined;
  if (slug === undefined || slug.length === 0) return undefined;
  return { slug, priority };
}

// Pure pick: the lowest-priority (most prominent) API-listed model slug.
// Returns undefined when nothing qualifies (empty / hidden-only / malformed
// cache) so the caller can decide whether that is fatal. Deterministic
// tie-break: lower priority first, then the cache's own array order (stable
// sort), so the pick never depends on object-key iteration order.
export function pickCodexFlagshipModel(cache: unknown): string | undefined {
  if (typeof cache !== 'object' || cache === null) return undefined;
  const models = (cache as Record<string, unknown>).models;
  if (!Array.isArray(models)) return undefined;
  const candidates = models
    .map(candidateFrom)
    .filter((entry): entry is CandidateCodexModel => entry !== undefined);
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => a.priority - b.priority);
  return candidates[0]?.slug;
}

// Thrown when no codex default model can be resolved. Named so callers and
// tests can distinguish "the operator must pin a model" from an unrelated
// filesystem error.
export class CodexDefaultModelUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexDefaultModelUnavailableError';
  }
}

function unavailableMessage(cachePath: string, reason: string): string {
  return [
    'codex connector: no model is pinned for this codex step and no default could',
    `be resolved from the Codex models cache (${cachePath}).`,
    'Circuit runs codex with --ignore-user-config, so ~/.codex/config.toml is',
    'intentionally not consulted for the model. Fix by either (a) pinning an',
    'openai model for codex in your Circuit config — set defaults.selection.model',
    '(or flows.<flow>.selection.model) to { provider: "openai", model:',
    '"<model>" }, or set power_tiers.codex.<tier>.model — or (b) running `codex`',
    `once so ${cachePath} is populated.`,
    `(reason: ${reason})`,
  ].join(' ');
}

// Read the cache and return the flagship slug, or throw a loud, actionable
// error naming both override paths. NOT memoized — exported for tests that vary
// CODEX_HOME. Production callers use `resolveCodexDefaultModel` below.
export function resolveCodexDefaultModelUncached(): string {
  const cachePath = codexModelsCachePath();
  let raw: string;
  try {
    raw = readFileSync(cachePath, 'utf8');
  } catch (err) {
    throw new CodexDefaultModelUnavailableError(
      unavailableMessage(cachePath, `cache not readable: ${(err as Error).message}`),
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CodexDefaultModelUnavailableError(
      unavailableMessage(cachePath, `cache is not valid JSON: ${(err as Error).message}`),
    );
  }
  const model = pickCodexFlagshipModel(parsed);
  if (model === undefined) {
    throw new CodexDefaultModelUnavailableError(
      unavailableMessage(cachePath, 'no API-listed model found in the cache'),
    );
  }
  return model;
}

// Memoized per process. The cache can refresh between codex runs, but within a
// single Circuit run every codex step must use the same default so the doer
// steps are consistent and the idempotent guidance replan sees a stable value.
// Memoizing success (not failure) mirrors `captureCodexVersion` in codex.ts:
// a failure re-throws on each call until the operator fixes the cache.
let cachedDefaultModel: string | undefined;
export function resolveCodexDefaultModel(): string {
  if (cachedDefaultModel !== undefined) return cachedDefaultModel;
  cachedDefaultModel = resolveCodexDefaultModelUncached();
  return cachedDefaultModel;
}
