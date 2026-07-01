import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CODEX_MODELS_CACHE_FILENAME,
  CodexDefaultModelUnavailableError,
  codexModelsCachePath,
  pickCodexFlagshipModel,
  resolveCodexDefaultModelUncached,
} from '../../src/connectors/codex-default-model.js';

// Field names are grounded against a real `~/.codex/models_cache.json`
// capture (Codex CLI 0.1xx): the top level is
// `{ fetched_at, etag, client_version, models: [...] }` and each model
// carries `slug` (the model id), `visibility` ("list" | "hide"),
// `supported_in_api` (bool), and `priority` (int, lower = more prominent).
// A model qualifies as a default when it is API-listed; the flagship is the
// lowest-priority (most prominent) qualifying model.
function model(
  slug: string,
  overrides: Partial<{ visibility: string; supported_in_api: boolean; priority: number }> = {},
): Record<string, unknown> {
  return {
    slug,
    display_name: slug,
    visibility: overrides.visibility ?? 'list',
    supported_in_api: overrides.supported_in_api ?? true,
    priority: overrides.priority ?? 10,
  };
}

// Mirrors the real capture: gpt-5.5 (prio 7) is the flagship; two lower-
// prominence API models; one hidden; one not-in-API.
function realShapedCache(): Record<string, unknown> {
  return {
    fetched_at: '2026-06-30T00:00:00Z',
    etag: 'abc',
    client_version: '0.130.0',
    models: [
      model('gpt-5.4', { priority: 16 }),
      model('gpt-5.5', { priority: 7 }),
      model('gpt-5.4-mini', { priority: 23 }),
      model('gpt-5.6-internal', { visibility: 'hide', priority: 1 }),
      model('o9-preview', { supported_in_api: false, priority: 2 }),
    ],
  };
}

describe('pickCodexFlagshipModel', () => {
  it('returns the lowest-priority API-listed model slug', () => {
    expect(pickCodexFlagshipModel(realShapedCache())).toBe('gpt-5.5');
  });

  it('excludes hidden models even when their priority is lower', () => {
    // gpt-5.6-internal has priority 1 (would win) but visibility "hide".
    const cache = {
      models: [
        model('visible', { priority: 5 }),
        model('hidden', { visibility: 'hide', priority: 1 }),
      ],
    };
    expect(pickCodexFlagshipModel(cache)).toBe('visible');
  });

  it('excludes models not supported in the API even when their priority is lower', () => {
    const cache = {
      models: [
        model('api-ok', { priority: 5 }),
        model('chat-only', { supported_in_api: false, priority: 1 }),
      ],
    };
    expect(pickCodexFlagshipModel(cache)).toBe('api-ok');
  });

  it('returns undefined when no model qualifies (all hidden or non-API)', () => {
    const cache = {
      models: [model('a', { visibility: 'hide' }), model('b', { supported_in_api: false })],
    };
    expect(pickCodexFlagshipModel(cache)).toBeUndefined();
  });

  it('returns undefined for a malformed cache (missing models array)', () => {
    expect(pickCodexFlagshipModel({})).toBeUndefined();
    expect(pickCodexFlagshipModel({ models: 'nope' })).toBeUndefined();
    expect(pickCodexFlagshipModel(null)).toBeUndefined();
    expect(pickCodexFlagshipModel(42)).toBeUndefined();
  });

  it('ignores malformed entries but still picks from valid ones', () => {
    const cache = {
      models: [
        { slug: 42 }, // wrong type
        null,
        model('valid', { priority: 9 }),
      ],
    };
    expect(pickCodexFlagshipModel(cache)).toBe('valid');
  });

  it('rejects a whitespace-only slug even when its priority is lowest', () => {
    // A slug like "   " has length > 0 but is not a usable model id; passing it
    // as `-m "   "` would cause the exact mid-run 400 this resolver exists to
    // prevent. The lower-prominence but real model must win instead.
    const cache = {
      models: [model('   ', { priority: 1 }), model('gpt-real', { priority: 8 })],
    };
    expect(pickCodexFlagshipModel(cache)).toBe('gpt-real');
  });

  it('trims surrounding whitespace off the picked slug', () => {
    const cache = { models: [model('  gpt-padded  ', { priority: 3 })] };
    expect(pickCodexFlagshipModel(cache)).toBe('gpt-padded');
  });
});

describe('resolveCodexDefaultModelUncached', () => {
  let originalCodexHome: string | undefined;
  let tempHome: string;

  beforeEach(() => {
    originalCodexHome = process.env.CODEX_HOME;
    tempHome = mkdtempSync(join(tmpdir(), 'circuit-codex-home-'));
    process.env.CODEX_HOME = tempHome;
  });

  afterEach(() => {
    // Reflect.deleteProperty (not `delete`) satisfies the biome perf rule while
    // still truly removing the var — `process.env.X = undefined` would coerce to
    // the string "undefined" and leak into later tests.
    if (originalCodexHome === undefined) Reflect.deleteProperty(process.env, 'CODEX_HOME');
    else process.env.CODEX_HOME = originalCodexHome;
    rmSync(tempHome, { recursive: true, force: true });
  });

  it('reads the cache under CODEX_HOME and returns the flagship slug', () => {
    writeFileSync(
      join(tempHome, CODEX_MODELS_CACHE_FILENAME),
      JSON.stringify(realShapedCache()),
      'utf8',
    );
    expect(codexModelsCachePath()).toBe(join(tempHome, CODEX_MODELS_CACHE_FILENAME));
    expect(resolveCodexDefaultModelUncached()).toBe('gpt-5.5');
  });

  it('fails loud with an actionable error when the cache file is absent', () => {
    // No cache written to tempHome.
    let caught: unknown;
    try {
      resolveCodexDefaultModelUncached();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CodexDefaultModelUnavailableError);
    const message = (caught as Error).message;
    // Names the REAL operator config keys (there is no per-step operator key;
    // the actionable keys are defaults.selection.model / circuits.<flow>.
    // selection.model / power_tiers.codex.<tier>.model).
    expect(message).toContain('defaults.selection.model');
    expect(message).toContain('circuits.<flow>.selection.model');
    expect(message).toContain('power_tiers.codex.<tier>.model');
    // Names the cache path so the operator knows what to populate.
    expect(message).toContain(tempHome);
    // Explains why config.toml is not consulted.
    expect(message).toContain('--ignore-user-config');
  });

  it('fails loud when the cache has no API-listed model', () => {
    writeFileSync(
      join(tempHome, CODEX_MODELS_CACHE_FILENAME),
      JSON.stringify({ models: [model('hidden', { visibility: 'hide' })] }),
      'utf8',
    );
    expect(() => resolveCodexDefaultModelUncached()).toThrow(CodexDefaultModelUnavailableError);
  });

  it('fails loud when the cache is not valid JSON', () => {
    writeFileSync(join(tempHome, CODEX_MODELS_CACHE_FILENAME), '{not json', 'utf8');
    expect(() => resolveCodexDefaultModelUncached()).toThrow(CodexDefaultModelUnavailableError);
  });
});
