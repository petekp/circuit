import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CodexModelRosterError,
  loadCodexModelRoster,
  parseCodexModelRoster,
  validateCachedSearchModels,
  validatePrototypeVariantModels,
} from '../../src/hosts/codex-mcp/codex-model-roster.js';

function model(
  slug: string,
  priority: number,
  efforts: readonly string[],
  extras: Record<string, unknown> = {},
) {
  return {
    slug,
    priority,
    visibility: 'list',
    supported_in_api: true,
    supported_reasoning_levels: efforts.map((effort) => ({ effort })),
    supports_search_tool: true,
    ...extras,
  };
}

describe('Codex MCP model roster', () => {
  it('uses only listed API models and preserves each advertised effort set', () => {
    const roster = parseCodexModelRoster({
      models: [
        model('gpt-second', 20, ['low']),
        model('gpt-first', 10, ['low', 'medium', 'high', 'xhigh']),
        model('hidden', 0, ['low'], { visibility: 'hide' }),
        model('chat-only', 1, ['low'], { supported_in_api: false }),
      ],
    });

    expect(roster.default_model).toBe('gpt-first');
    expect(roster.allowed_models).toEqual(['gpt-first', 'gpt-second']);
    expect(roster.efforts_by_model.get('gpt-first')).toEqual(
      new Set(['low', 'medium', 'high', 'xhigh']),
    );
  });

  it('rejects tournament variants that are absent or request an unsupported effort', () => {
    const roster = parseCodexModelRoster({
      models: [
        model('gpt-default', 1, ['low', 'medium', 'high', 'xhigh']),
        model('gpt-safe', 2, ['low', 'medium']),
      ],
    });

    expect(() =>
      validatePrototypeVariantModels(
        [
          { id: 'a', label: 'A', model: 'gpt-safe', effort: 'high' },
          { id: 'b', label: 'B', model: 'missing', effort: 'low' },
        ],
        roster,
      ),
    ).toThrow(CodexModelRosterError);
  });

  it('requires the selected models to advertise cached search', () => {
    const roster = parseCodexModelRoster({
      models: [
        model('gpt-default', 1, ['low', 'medium', 'high', 'xhigh']),
        model('gpt-no-search', 2, ['low'], { supports_search_tool: false }),
      ],
    });

    expect(() =>
      validateCachedSearchModels(
        { web_search: 'cached', variants: [{ model: 'gpt-no-search' }] },
        roster,
      ),
    ).toThrow(CodexModelRosterError);
    expect(() => validateCachedSearchModels({ web_search: 'off' }, roster)).not.toThrow();
  });

  it('reads only a bounded regular cache file and rejects symbolic links', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'circuit-mcp-models-'));
    const realCache = resolve(root, 'real.json');
    const linkedCache = resolve(root, 'linked.json');
    writeFileSync(realCache, JSON.stringify({ models: [model('gpt-safe', 1, ['low'])] }));
    symlinkSync(realCache, linkedCache);

    expect(() => loadCodexModelRoster(linkedCache)).toThrow(CodexModelRosterError);

    const directory = resolve(root, 'directory.json');
    mkdirSync(directory);
    expect(() => loadCodexModelRoster(directory)).toThrow(CodexModelRosterError);
  });
});
