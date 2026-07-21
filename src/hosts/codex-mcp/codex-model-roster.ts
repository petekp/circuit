import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';

const MAX_MODELS_CACHE_BYTES = 4 * 1024 * 1024;
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._@/-]{0,127}$/;
const PUBLIC_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;
type PublicEffort = (typeof PUBLIC_EFFORTS)[number];

export class CodexModelRosterError extends Error {
  readonly code: string;
  readonly nextAction: string;

  constructor(
    message: string,
    code = 'codex_model_roster_unavailable',
    nextAction = 'Run Codex once to refresh its model list, then retry.',
  ) {
    super(message);
    this.name = 'CodexModelRosterError';
    this.code = code;
    this.nextAction = nextAction;
  }
}

export interface CodexModelRoster {
  readonly default_model: string;
  readonly allowed_models: readonly string[];
  readonly efforts_by_model: ReadonlyMap<string, ReadonlySet<PublicEffort>>;
  readonly cached_search_models: ReadonlySet<string>;
}

interface ModelCandidate {
  readonly slug: string;
  readonly priority: number;
  readonly index: number;
  readonly efforts: ReadonlySet<PublicEffort>;
  readonly supportsCachedSearch: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function candidate(value: unknown, index: number): ModelCandidate | undefined {
  if (!isRecord(value) || value.visibility !== 'list' || value.supported_in_api !== true) {
    return undefined;
  }
  const slug = typeof value.slug === 'string' ? value.slug.trim() : '';
  if (!MODEL_NAME.test(slug)) return undefined;
  if (typeof value.priority !== 'number' || !Number.isSafeInteger(value.priority)) return undefined;
  if (!Array.isArray(value.supported_reasoning_levels)) return undefined;

  const efforts = new Set<PublicEffort>();
  for (const level of value.supported_reasoning_levels) {
    if (!isRecord(level) || typeof level.effort !== 'string') continue;
    if ((PUBLIC_EFFORTS as readonly string[]).includes(level.effort)) {
      efforts.add(level.effort as PublicEffort);
    }
  }
  if (efforts.size === 0) return undefined;
  return {
    slug,
    priority: value.priority,
    index,
    efforts,
    supportsCachedSearch: value.supports_search_tool === true,
  };
}

export function parseCodexModelRoster(value: unknown): CodexModelRoster {
  if (!isRecord(value) || !Array.isArray(value.models)) {
    throw new CodexModelRosterError('The Codex model list has an unsupported shape.');
  }
  const candidates = value.models
    .map(candidate)
    .filter((entry): entry is ModelCandidate => entry !== undefined)
    .sort(
      (left, right) =>
        left.priority - right.priority ||
        left.index - right.index ||
        left.slug.localeCompare(right.slug),
    );
  if (candidates.length === 0) {
    throw new CodexModelRosterError('The Codex model list has no usable API models.');
  }
  const defaultModel = candidates.find((entry) =>
    PUBLIC_EFFORTS.every((effort) => entry.efforts.has(effort)),
  );
  if (defaultModel === undefined) {
    throw new CodexModelRosterError(
      'The Codex model list has no model that supports every Circuit effort level.',
    );
  }

  const effortsByModel = new Map<string, ReadonlySet<PublicEffort>>();
  const cachedSearchModels = new Set<string>();
  for (const entry of candidates) {
    if (effortsByModel.has(entry.slug)) {
      throw new CodexModelRosterError(`The Codex model list repeats '${entry.slug}'.`);
    }
    effortsByModel.set(entry.slug, entry.efforts);
    if (entry.supportsCachedSearch) cachedSearchModels.add(entry.slug);
  }
  return Object.freeze({
    default_model: defaultModel.slug,
    allowed_models: Object.freeze([...effortsByModel.keys()]),
    efforts_by_model: effortsByModel,
    cached_search_models: cachedSearchModels,
  });
}

export function validateCachedSearchModels(
  input: {
    readonly web_search: 'off' | 'cached';
    readonly variants?: readonly { readonly model: string }[];
  },
  roster: CodexModelRoster,
): void {
  if (input.web_search !== 'cached') return;
  const models = input.variants?.map((variant) => variant.model) ?? [roster.default_model];
  const unsupported = models.find((model) => !roster.cached_search_models.has(model));
  if (unsupported !== undefined) {
    throw new CodexModelRosterError(
      `The selected Codex model '${unsupported}' does not advertise cached search.`,
      'cached_search_unsupported',
      'Choose a search-capable model or set web_search to off.',
    );
  }
}

export function loadCodexModelRoster(cachePath: string): CodexModelRoster {
  let fd: number | undefined;
  try {
    fd = openSync(cachePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd);
    if (!before.isFile()) throw new Error('model cache is not a regular file');
    if (before.size === 0 || before.size > MAX_MODELS_CACHE_BYTES) {
      throw new Error('model cache is empty or too large');
    }
    const raw = readFileSync(fd, 'utf8');
    const after = fstatSync(fd);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error('model cache changed while Circuit read it');
    }
    return parseCodexModelRoster(JSON.parse(raw) as unknown);
  } catch (error) {
    if (error instanceof CodexModelRosterError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new CodexModelRosterError(`Circuit could not read the Codex model list: ${message}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function validatePrototypeVariantModels(
  variants: readonly {
    readonly id?: string;
    readonly label?: string;
    readonly model: string;
    readonly effort: PublicEffort;
  }[],
  roster: CodexModelRoster,
): void {
  for (const variant of variants) {
    const efforts = roster.efforts_by_model.get(variant.model);
    if (efforts === undefined) {
      throw new CodexModelRosterError(
        `The selected Codex model '${variant.model}' is not in the current model list.`,
        'model_unsupported',
        'Choose a model advertised by the current Codex host, then retry.',
      );
    }
    if (!efforts.has(variant.effort)) {
      throw new CodexModelRosterError(
        `The selected Codex model '${variant.model}' does not support effort '${variant.effort}'.`,
        'effort_unsupported',
        'Choose an effort advertised for that model, then retry.',
      );
    }
  }
}
