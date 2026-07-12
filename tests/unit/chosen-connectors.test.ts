import { describe, expect, it } from 'vitest';
import { resolveChosenConnectors } from '../../src/cli/chosen-connectors.js';
import { LayeredConfig } from '../../src/schemas/config.js';

// The chosen connector set is what `circuit doctor` grades: the union of
// connectors any public flow's relay step would actually dispatch through,
// under the effective config layers and host kind. See src/cli/doctor.ts.

describe('resolveChosenConnectors: fresh machine', () => {
  it('resolves exactly {claude-code} with no config and no host kind', () => {
    const chosen = resolveChosenConnectors();
    expect([...chosen.names]).toEqual(['claude-code']);
    expect(chosen.custom.size).toBe(0);
    // Every step fell through to the host-aware auto fallback, so the
    // teachable provenance is a single phrase.
    expect(chosen.sources.get('claude-code')).toEqual(['auto']);
  });

  it('resolves exactly {claude-code} with empty config layers', () => {
    const chosen = resolveChosenConnectors({ configLayers: [] });
    expect([...chosen.names]).toEqual(['claude-code']);
  });
});

describe('resolveChosenConnectors: config overrides', () => {
  it('a role override to codex adds codex to the chosen set', () => {
    const layer = LayeredConfig.parse({
      layer: 'user-global',
      config: {
        schema_version: 1,
        relay: { roles: { reviewer: { kind: 'builtin', name: 'codex' } } },
      },
    });
    const chosen = resolveChosenConnectors({ configLayers: [layer] });
    expect(chosen.names.has('codex')).toBe(true);
    expect(chosen.sources.get('codex')).toEqual(['role: reviewer']);
    expect(chosen.sources.get('claude-code')).toEqual(['auto']);
  });

  it('a relay default of codex makes codex the whole chosen set', () => {
    const layer = LayeredConfig.parse({
      layer: 'user-global',
      config: { schema_version: 1, relay: { default: 'codex' } },
    });
    const chosen = resolveChosenConnectors({ configLayers: [layer] });
    expect([...chosen.names]).toEqual(['codex']);
    expect(chosen.sources.get('codex')).toEqual(['default']);
  });
});

describe('resolveChosenConnectors: host kind', () => {
  it('a codex host kind auto-chooses codex', () => {
    const chosen = resolveChosenConnectors({ hostKind: 'codex' });
    expect([...chosen.names]).toEqual(['codex']);
  });

  it('a claude-code host kind auto-chooses claude-code', () => {
    const chosen = resolveChosenConnectors({ hostKind: 'claude-code' });
    expect([...chosen.names]).toEqual(['claude-code']);
  });
});

describe('resolveChosenConnectors: custom connectors', () => {
  it('surfaces a chosen custom connector descriptor for a presence probe', () => {
    // Custom connectors are read-only in V1, so they can only fill a
    // read-capable role (reviewer/researcher), never implementer.
    const layer = LayeredConfig.parse({
      layer: 'user-global',
      config: {
        schema_version: 1,
        relay: {
          roles: { reviewer: { kind: 'named', name: 'my-tool' } },
          connectors: {
            'my-tool': {
              kind: 'custom',
              name: 'my-tool',
              command: ['/usr/local/bin/my-tool'],
              prompt_transport: 'prompt-file',
              output: { kind: 'output-file' },
              capabilities: {
                filesystem: 'read-only',
                structured_output: 'json',
                tool_scope: 'none',
              },
            },
          },
        },
      },
    });
    const chosen = resolveChosenConnectors({ configLayers: [layer] });
    expect(chosen.names.has('my-tool')).toBe(true);
    // The other roles still fall through to the auto default.
    expect(chosen.names.has('claude-code')).toBe(true);
    expect(chosen.custom.get('my-tool')?.command).toEqual(['/usr/local/bin/my-tool']);
  });
});
