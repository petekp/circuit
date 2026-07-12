import { describe, expect, it } from 'vitest';
import { resolveRoutedConnectors } from '../../src/cli/routed-connectors.js';
import { LayeredConfig } from '../../src/schemas/config.js';

// The routed connector set is what `circuit doctor` grades: the union of
// connectors any public flow's relay step would actually dispatch through,
// under the effective config layers and host kind. See src/cli/doctor.ts.

describe('resolveRoutedConnectors: fresh machine', () => {
  it('resolves exactly {claude-code} with no config and no host kind', () => {
    const routed = resolveRoutedConnectors();
    expect([...routed.names]).toEqual(['claude-code']);
    expect(routed.custom.size).toBe(0);
    // Every step fell through to the host-aware auto fallback, so the
    // teachable provenance is a single phrase.
    expect(routed.routes.get('claude-code')).toEqual(['auto']);
  });

  it('resolves exactly {claude-code} with empty config layers', () => {
    const routed = resolveRoutedConnectors({ configLayers: [] });
    expect([...routed.names]).toEqual(['claude-code']);
  });
});

describe('resolveRoutedConnectors: config overrides', () => {
  it('a role override to codex adds codex to the routed set', () => {
    const layer = LayeredConfig.parse({
      layer: 'user-global',
      config: {
        schema_version: 1,
        relay: { roles: { reviewer: { kind: 'builtin', name: 'codex' } } },
      },
    });
    const routed = resolveRoutedConnectors({ configLayers: [layer] });
    expect(routed.names.has('codex')).toBe(true);
    expect(routed.routes.get('codex')).toEqual(['role: reviewer']);
    expect(routed.routes.get('claude-code')).toEqual(['auto']);
  });

  it('a relay default of codex makes codex the whole routed set', () => {
    const layer = LayeredConfig.parse({
      layer: 'user-global',
      config: { schema_version: 1, relay: { default: 'codex' } },
    });
    const routed = resolveRoutedConnectors({ configLayers: [layer] });
    expect([...routed.names]).toEqual(['codex']);
    expect(routed.routes.get('codex')).toEqual(['default']);
  });
});

describe('resolveRoutedConnectors: host kind', () => {
  it('a codex host kind auto-routes codex', () => {
    const routed = resolveRoutedConnectors({ hostKind: 'codex' });
    expect([...routed.names]).toEqual(['codex']);
  });

  it('a claude-code host kind auto-routes claude-code', () => {
    const routed = resolveRoutedConnectors({ hostKind: 'claude-code' });
    expect([...routed.names]).toEqual(['claude-code']);
  });
});

describe('resolveRoutedConnectors: custom connectors', () => {
  it('surfaces a routed custom connector descriptor for a presence probe', () => {
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
    const routed = resolveRoutedConnectors({ configLayers: [layer] });
    expect(routed.names.has('my-tool')).toBe(true);
    // The other roles still fall through to the auto default.
    expect(routed.names.has('claude-code')).toBe(true);
    expect(routed.custom.get('my-tool')?.command).toEqual(['/usr/local/bin/my-tool']);
  });
});
