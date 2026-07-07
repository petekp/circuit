// Connector contract — see docs/contracts/connector.md. Also covers
// Config + connector registry parity checks.

import { describe, expect, it } from 'vitest';
import {
  BUILTIN_CONNECTOR_CAPABILITIES,
  BUILTIN_CONNECTOR_SPECS,
  Config,
  ConnectorCapabilities,
  ConnectorName,
  ConnectorRef,
  ConnectorReference,
  CustomConnectorDescriptor,
  EnabledConnector,
  HostKind,
  RESERVED_CONNECTOR_NAMES,
  RelayConfig,
  RelayResolutionSource,
  ResolvedConnector,
  ToolScopeCapability,
  TraceEntry,
} from '../../src/index.js';
import { RUN_A } from '../helpers/runtrace-builders.js';

function customConnector(name = 'gemini', command = ['./bin/g']) {
  return {
    kind: 'custom' as const,
    name,
    command,
    prompt_transport: 'prompt-file' as const,
    output: { kind: 'output-file' as const },
    capabilities: { filesystem: 'read-only' as const, structured_output: 'json' as const },
  };
}

describe('Config + connector registry', () => {
  it('relay.default parses auto/builtin/registered-connector-name', () => {
    const a = RelayConfig.safeParse({ default: 'auto' });
    expect(a.success).toBe(true);
    const b = RelayConfig.safeParse({ default: 'codex' });
    expect(b.success).toBe(true);
  });

  it('relay.default rejects unknown connector name without registry entry', () => {
    const bad = RelayConfig.safeParse({ default: 'gemini' });
    expect(bad.success).toBe(false);
  });

  it('relay.default rejects stale codex-isolated without a registry entry', () => {
    const bad = RelayConfig.safeParse({ default: 'codex-isolated' });
    expect(bad.success).toBe(false);
  });

  it('relay.default accepts the cursor-agent built-in connector', () => {
    const ok = RelayConfig.safeParse({ default: 'cursor-agent' });
    expect(ok.success).toBe(true);
  });

  it('relay.default resolves to registered named connector', () => {
    const ok = RelayConfig.safeParse({
      default: 'gemini',
      connectors: {
        gemini: customConnector('gemini', [
          './docs/examples/gemini-relay.sh',
          '--model',
          'gemini-2.5-pro',
        ]),
      },
    });
    expect(ok.success).toBe(true);
  });

  it('role connector reference to unregistered named connector fails', () => {
    const bad = RelayConfig.safeParse({
      roles: { researcher: { kind: 'named', name: 'gemini' } },
    });
    expect(bad.success).toBe(false);
  });

  it('Config with empty input applies relay defaults while leaving host unset', () => {
    const c = Config.safeParse({ schema_version: 1 });
    expect(c.success).toBe(true);
    if (c.success) {
      expect(c.data.host).toBeUndefined();
      expect(c.data.relay.default).toBe('auto');
    }
  });

  it('Config accepts codex as a host kind', () => {
    const c = Config.safeParse({ schema_version: 1, host: { kind: 'codex' } });
    expect(c.success).toBe(true);
    if (c.success) {
      expect(c.data.host?.kind).toBe('codex');
    }
  });
});

describe('HostKind', () => {
  it('accepts supported V1 hosts and rejects worker-only names', () => {
    expect(HostKind.safeParse('generic-shell').success).toBe(true);
    expect(HostKind.safeParse('claude-code').success).toBe(true);
    expect(HostKind.safeParse('codex').success).toBe(true);
    expect(HostKind.safeParse('codex-isolated').success).toBe(false);
  });
});

describe('EnabledConnector (connector-I1)', () => {
  it('accepts the current built-ins', () => {
    expect(EnabledConnector.safeParse('claude-code').success).toBe(true);
    expect(EnabledConnector.safeParse('codex').success).toBe(true);
    expect(EnabledConnector.safeParse('cursor-agent').success).toBe(true);
  });

  it('rejects unknown built-in names', () => {
    expect(EnabledConnector.safeParse('agent').success).toBe(false);
    expect(EnabledConnector.safeParse('codex-isolated').success).toBe(false);
    expect(EnabledConnector.safeParse('gemini').success).toBe(false);
    expect(EnabledConnector.safeParse('ollama').success).toBe(false);
    expect(EnabledConnector.safeParse('').success).toBe(false);
  });

  it('built-in enum is the frozen current tuple and ordering is stable', () => {
    expect(EnabledConnector.options).toEqual(['claude-code', 'codex', 'cursor-agent']);
  });
});

describe('ConnectorName regex (connector-I2 syntax)', () => {
  it('accepts lowercase, digits-after-first, hyphens', () => {
    expect(ConnectorName.safeParse('gemini').success).toBe(true);
    expect(ConnectorName.safeParse('ollama-local').success).toBe(true);
    expect(ConnectorName.safeParse('a1-b2-c3').success).toBe(true);
  });

  it('rejects uppercase, leading digit, whitespace, empty, underscores', () => {
    expect(ConnectorName.safeParse('Gemini').success).toBe(false);
    expect(ConnectorName.safeParse('1gemini').success).toBe(false);
    expect(ConnectorName.safeParse('gem ini').success).toBe(false);
    expect(ConnectorName.safeParse('').success).toBe(false);
    expect(ConnectorName.safeParse('gem_ini').success).toBe(false);
    expect(ConnectorName.safeParse('-gemini').success).toBe(false);
  });
});

describe('RESERVED_CONNECTOR_NAMES (connector-I2 reservation set)', () => {
  it('contains every built-in plus the auto sentinel and nothing else', () => {
    expect(RESERVED_CONNECTOR_NAMES).toEqual(['claude-code', 'codex', 'cursor-agent', 'auto']);
  });
});

describe('CustomConnectorDescriptor (connector-I3)', () => {
  const ok = customConnector('gemini', [
    './docs/examples/gemini-relay.sh',
    '--model',
    'gemini-2.5-pro',
  ]);

  it('parses a well-formed descriptor', () => {
    expect(CustomConnectorDescriptor.safeParse(ok).success).toBe(true);
  });

  it('rejects empty command vector', () => {
    expect(CustomConnectorDescriptor.safeParse({ ...ok, command: [] }).success).toBe(false);
  });

  it('rejects empty string element in command (connector-I3 element-level min)', () => {
    expect(CustomConnectorDescriptor.safeParse({ ...ok, command: ['codex', ''] }).success).toBe(
      false,
    );
    expect(CustomConnectorDescriptor.safeParse({ ...ok, command: [''] }).success).toBe(false);
  });

  it('rejects surplus keys (connector-I9 transitive .strict() on the descriptor)', () => {
    expect(CustomConnectorDescriptor.safeParse({ ...ok, env: { API_KEY: 'x' } }).success).toBe(
      false,
    );
  });

  it('rejects wrong kind literal (connector-I4 discriminant)', () => {
    expect(CustomConnectorDescriptor.safeParse({ ...ok, kind: 'builtin' }).success).toBe(false);
  });

  it('rejects name that violates ConnectorName regex', () => {
    expect(CustomConnectorDescriptor.safeParse({ ...ok, name: 'Gemini' }).success).toBe(false);
  });

  it('requires declared capabilities and output extraction', () => {
    const { capabilities: _capabilities, ...withoutCapabilities } = ok;
    const { output: _output, ...withoutOutput } = ok;
    expect(CustomConnectorDescriptor.safeParse(withoutCapabilities).success).toBe(false);
    expect(CustomConnectorDescriptor.safeParse(withoutOutput).success).toBe(false);
  });

  it('rejects unsupported capability values', () => {
    expect(
      CustomConnectorDescriptor.safeParse({
        ...ok,
        capabilities: { filesystem: 'trusted-write', structured_output: 'json' },
      }).success,
    ).toBe(false);
  });
});

describe('ConnectorRef discriminated union (connector-I4)', () => {
  it('accepts builtin variant', () => {
    const ok = ConnectorRef.safeParse({ kind: 'builtin', name: 'codex' });
    expect(ok.success).toBe(true);
  });

  it('rejects the removed codex-isolated builtin variant', () => {
    const bad = ConnectorRef.safeParse({ kind: 'builtin', name: 'codex-isolated' });
    expect(bad.success).toBe(false);
  });

  it('accepts the cursor-agent builtin variant', () => {
    const ok = ConnectorRef.safeParse({ kind: 'builtin', name: 'cursor-agent' });
    expect(ok.success).toBe(true);
  });

  it('accepts named variant', () => {
    const ok = ConnectorRef.safeParse({ kind: 'named', name: 'gemini' });
    expect(ok.success).toBe(true);
  });

  it('accepts inline custom variant (distinct from ConnectorReference — connector-I5)', () => {
    const ok = ConnectorRef.safeParse({
      ...customConnector('gemini', ['./bin/gemini-relay']),
    });
    expect(ok.success).toBe(true);
  });

  it('rejects unknown kind discriminant', () => {
    const bad = ConnectorRef.safeParse({ kind: 'mystery', name: 'x' });
    expect(bad.success).toBe(false);
  });

  it('rejects surplus key on builtin variant (connector-I9 transitive strict)', () => {
    const bad = ConnectorRef.safeParse({ kind: 'builtin', name: 'codex', hint: 'x' });
    expect(bad.success).toBe(false);
  });

  it('rejects surplus key on named variant', () => {
    const bad = ConnectorRef.safeParse({ kind: 'named', name: 'gemini', alias: 'g' });
    expect(bad.success).toBe(false);
  });
});

describe('RelayConfig reserved-name disjointness (connector-I2)', () => {
  it('rejects a custom connector keyed under a EnabledConnector value', () => {
    const bad = RelayConfig.safeParse({
      connectors: {
        codex: {
          ...customConnector('codex', ['./bin/shadow-codex']),
        },
      },
    });
    expect(bad.success).toBe(false);
  });

  it('rejects a custom connector keyed under a newly added EnabledConnector value', () => {
    const bad = RelayConfig.safeParse({
      connectors: {
        'cursor-agent': {
          ...customConnector('cursor-agent', ['./bin/cursor-agent']),
        },
      },
    });
    expect(bad.success).toBe(false);
  });

  it('rejects a custom connector keyed under the `auto` sentinel', () => {
    const bad = RelayConfig.safeParse({
      connectors: {
        auto: {
          ...customConnector('auto', ['./bin/pick-for-me']),
        },
      },
    });
    expect(bad.success).toBe(false);
  });

  it('accepts non-reserved custom connector names', () => {
    const ok = RelayConfig.safeParse({
      connectors: {
        gemini: customConnector('gemini', ['./bin/gemini']),
      },
    });
    expect(ok.success).toBe(true);
  });
});

describe('RelayConfig strict surface (connector-I9)', () => {
  it('rejects surplus top-level key (`relay.adpaters` typo transposition)', () => {
    const bad = RelayConfig.safeParse({
      adpaters: {},
    });
    expect(bad.success).toBe(false);
  });

  it('rejects ConnectorReference (registry-layer) with inline custom kind — connector-I5', () => {
    const bad = RelayConfig.safeParse({
      roles: {
        researcher: {
          kind: 'custom',
          name: 'gemini',
          command: ['./bin/gemini'],
        },
      },
    });
    expect(bad.success).toBe(false);
  });

  it('rejects ConnectorReference surplus keys (typo smuggle)', () => {
    const bad = RelayConfig.safeParse({
      roles: { researcher: { kind: 'named', name: 'gemini', alias: 'g' } },
      connectors: {
        gemini: customConnector(),
      },
    });
    expect(bad.success).toBe(false);
  });

  it('rejects ConnectorReference with unknown kind discriminant', () => {
    const bad = RelayConfig.safeParse({
      roles: { researcher: { kind: 'inline', name: 'gemini' } },
    });
    expect(bad.success).toBe(false);
  });

  it('rejects RelayRole key outside the closed enum (connector-I6 — orchestrator not a role)', () => {
    const bad = RelayConfig.safeParse({
      roles: { orchestrator: { kind: 'builtin', name: 'codex' } },
    });
    expect(bad.success).toBe(false);
  });

  it('rejects read-only custom connectors for implementer roles', () => {
    const bad = RelayConfig.safeParse({
      roles: { implementer: { kind: 'named', name: 'gemini' } },
      connectors: { gemini: customConnector() },
    });
    expect(bad.success).toBe(false);
  });
});

describe('RelayResolutionSource (connector-I7)', () => {
  it('accepts the 5 category variants with correct disambiguators', () => {
    expect(RelayResolutionSource.safeParse({ source: 'explicit' }).success).toBe(true);
    expect(RelayResolutionSource.safeParse({ source: 'role', role: 'researcher' }).success).toBe(
      true,
    );
    expect(RelayResolutionSource.safeParse({ source: 'flow', flow_id: 'explore' }).success).toBe(
      true,
    );
    expect(RelayResolutionSource.safeParse({ source: 'default' }).success).toBe(true);
    expect(RelayResolutionSource.safeParse({ source: 'auto' }).success).toBe(true);
  });

  it('rejects role variant missing the role disambiguator', () => {
    expect(RelayResolutionSource.safeParse({ source: 'role' }).success).toBe(false);
  });

  it('rejects circuit variant missing the flow_id disambiguator', () => {
    expect(RelayResolutionSource.safeParse({ source: 'flow' }).success).toBe(false);
  });

  it('rejects role with a disambiguator for a different category (cross-variant smuggle)', () => {
    const bad = RelayResolutionSource.safeParse({
      source: 'role',
      flow_id: 'explore',
    });
    expect(bad.success).toBe(false);
  });

  it('rejects unknown source category', () => {
    expect(RelayResolutionSource.safeParse({ source: 'heuristic' }).success).toBe(false);
  });

  it('rejects surplus keys on every variant (connector-I9)', () => {
    expect(
      RelayResolutionSource.safeParse({ source: 'explicit', flag: '--connector' }).success,
    ).toBe(false);
    expect(
      RelayResolutionSource.safeParse({
        source: 'role',
        role: 'researcher',
        fallback: 'default',
      }).success,
    ).toBe(false);
    expect(
      RelayResolutionSource.safeParse({
        source: 'flow',
        flow_id: 'explore',
        smuggled: 'x',
      }).success,
    ).toBe(false);
    expect(RelayResolutionSource.safeParse({ source: 'default', hint: 'x' }).success).toBe(false);
    expect(RelayResolutionSource.safeParse({ source: 'auto', reason: 'x' }).success).toBe(false);
  });

  it('rejects role variant with an invalid RelayRole value (closed-enum parity)', () => {
    expect(RelayResolutionSource.safeParse({ source: 'role', role: 'orchestrator' }).success).toBe(
      false,
    );
  });
});

describe('RelayStartedTraceEntry.resolved_from consumes RelayResolutionSource (connector-I7 × trace_entry)', () => {
  const base = {
    schema_version: 1 as const,
    sequence: 0,
    recorded_at: '2026-04-18T05:00:00.000Z',
    run_id: RUN_A,
    kind: 'relay.started' as const,
    step_id: 'frame',
    attempt: 1,
    connector: { kind: 'builtin' as const, name: 'codex' as const },
    role: 'researcher' as const,
    resolved_selection: { skills: [] },
  };

  it('accepts role-sourced relay with role disambiguator', () => {
    const ok = TraceEntry.safeParse({
      ...base,
      resolved_from: { source: 'role', role: 'researcher' },
    });
    expect(ok.success).toBe(true);
  });

  it('accepts circuit-sourced relay with flow_id disambiguator', () => {
    const ok = TraceEntry.safeParse({
      ...base,
      resolved_from: { source: 'flow', flow_id: 'explore' },
    });
    expect(ok.success).toBe(true);
  });

  it('rejects pre-connector-I7 flat-enum shape (migration guard)', () => {
    const bad = TraceEntry.safeParse({
      ...base,
      resolved_from: 'role',
    });
    expect(bad.success).toBe(false);
  });

  it('rejects role-sourced relay missing the role disambiguator', () => {
    const bad = TraceEntry.safeParse({
      ...base,
      resolved_from: { source: 'role' },
    });
    expect(bad.success).toBe(false);
  });
});

describe('connector-I10 — ResolvedConnector rejects pre-resolution named references', () => {
  it('accepts built-in variant', () => {
    expect(ResolvedConnector.safeParse({ kind: 'builtin', name: 'codex' }).success).toBe(true);
  });

  it('accepts inline custom descriptor variant', () => {
    expect(
      ResolvedConnector.safeParse({
        ...customConnector(),
      }).success,
    ).toBe(true);
  });

  it('rejects named reference — resolver must dereference before trace_entry emission', () => {
    expect(ResolvedConnector.safeParse({ kind: 'named', name: 'gemini' }).success).toBe(false);
  });
});

describe('connector-I10 — RelayStartedTraceEntry.connector rejects named references via trace_entry', () => {
  const baseEv = {
    schema_version: 1 as const,
    sequence: 0,
    recorded_at: '2026-04-18T05:00:00.000Z',
    run_id: RUN_A,
    kind: 'relay.started' as const,
    step_id: 'frame',
    attempt: 1,
    role: 'researcher' as const,
    resolved_selection: { skills: [] },
    resolved_from: { source: 'explicit' as const },
  };

  it('parses with a fully-resolved built-in connector', () => {
    expect(
      TraceEntry.safeParse({
        ...baseEv,
        connector: { kind: 'builtin', name: 'codex' },
      }).success,
    ).toBe(true);
  });

  it('parses with a fully-resolved custom descriptor', () => {
    expect(
      TraceEntry.safeParse({
        ...baseEv,
        connector: customConnector(),
      }).success,
    ).toBe(true);
  });

  it('rejects a pre-resolution named reference in trace_entry.connector', () => {
    expect(
      TraceEntry.safeParse({
        ...baseEv,
        connector: { kind: 'named', name: 'gemini' },
      }).success,
    ).toBe(false);
  });
});

describe('RelayConfig registry-key/descriptor-name parity (connector-I11)', () => {
  it('connector-I11 — rejects a descriptor whose `name` does not equal its registry key', () => {
    const bad = RelayConfig.safeParse({
      connectors: {
        gemini: {
          ...customConnector('ollama', ['./bin/ollama']),
        },
      },
    });
    expect(bad.success).toBe(false);
  });

  it('connector-I11 — accepts matching registry key and descriptor name', () => {
    const ok = RelayConfig.safeParse({
      connectors: {
        gemini: customConnector('gemini', ['./bin/gemini']),
      },
    });
    expect(ok.success).toBe(true);
  });
});

describe('RelayConfig closure via own-property check (connector-I8)', () => {
  it('connector-I8 — rejects a role reference to `constructor` when no own registry entry exists', () => {
    const bad = RelayConfig.safeParse({
      roles: { researcher: { kind: 'named', name: 'constructor' } },
      connectors: {},
    });
    expect(bad.success).toBe(false);
  });

  it('connector-I8 — rejects a circuit reference to `toString` when no own registry entry exists', () => {
    const bad = RelayConfig.safeParse({
      flows: { explore: { kind: 'named', name: 'toString' } },
      connectors: {},
    });
    expect(bad.success).toBe(false);
  });

  it('connector-I8 — rejects relay.default = `hasOwnProperty` when no own registry entry exists', () => {
    const bad = RelayConfig.safeParse({
      default: 'hasOwnProperty',
      connectors: {},
    });
    expect(bad.success).toBe(false);
  });

  it('connector-I8 — accepts a role reference to a name that IS registered as an own key', () => {
    const ok = RelayConfig.safeParse({
      roles: { researcher: { kind: 'named', name: 'gemini' } },
      connectors: {
        gemini: customConnector(),
      },
    });
    expect(ok.success).toBe(true);
  });
});

describe('RelayStartedTraceEntry role ↔ resolved_from.role binding', () => {
  const baseEv = {
    schema_version: 1 as const,
    sequence: 0,
    recorded_at: '2026-04-18T05:00:00.000Z',
    run_id: RUN_A,
    kind: 'relay.started' as const,
    step_id: 'frame',
    attempt: 1,
    connector: { kind: 'builtin' as const, name: 'codex' as const },
    resolved_selection: { skills: [] },
  };

  it('accepts trace_entry when role matches resolved_from.role', () => {
    const ok = TraceEntry.safeParse({
      ...baseEv,
      role: 'researcher',
      resolved_from: { source: 'role', role: 'researcher' },
    });
    expect(ok.success).toBe(true);
  });

  it('rejects trace_entry when role disagrees with resolved_from.role', () => {
    const bad = TraceEntry.safeParse({
      ...baseEv,
      role: 'researcher',
      resolved_from: { source: 'role', role: 'reviewer' },
    });
    expect(bad.success).toBe(false);
  });

  it('binding only applies when resolved_from.source === "role"', () => {
    const ok = TraceEntry.safeParse({
      ...baseEv,
      role: 'researcher',
      resolved_from: { source: 'default' },
    });
    expect(ok.success).toBe(true);
  });
});

describe('ConnectorReference registry-layer refusal — exported surface', () => {
  it('accepts builtin variant', () => {
    expect(ConnectorReference.safeParse({ kind: 'builtin', name: 'codex' }).success).toBe(true);
    expect(ConnectorReference.safeParse({ kind: 'builtin', name: 'cursor-agent' }).success).toBe(
      true,
    );
  });

  it('rejects the removed codex-isolated builtin variant', () => {
    expect(ConnectorReference.safeParse({ kind: 'builtin', name: 'codex-isolated' }).success).toBe(
      false,
    );
  });

  it('accepts named variant', () => {
    expect(ConnectorReference.safeParse({ kind: 'named', name: 'gemini' }).success).toBe(true);
  });

  it('rejects inline custom variant (connector-I5 — registry references by name only)', () => {
    const bad = ConnectorReference.safeParse({
      kind: 'custom',
      name: 'gemini',
      command: ['./bin/g'],
    });
    expect(bad.success).toBe(false);
  });

  it('rejects surplus keys (per-variant strict)', () => {
    expect(
      ConnectorReference.safeParse({ kind: 'named', name: 'gemini', alias: 'g' }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RelayStartedTraceEntry.equipment — the enforcement decision recorded for the
// audit. The trace must be honest: effective enforcement and the enforced tool
// list cannot disagree.
// ---------------------------------------------------------------------------
describe('RelayStartedTraceEntry.equipment evidence', () => {
  const base = {
    schema_version: 1 as const,
    sequence: 0,
    recorded_at: '2026-04-18T05:00:00.000Z',
    run_id: RUN_A,
    kind: 'relay.started' as const,
    step_id: 'act',
    attempt: 1,
    connector: { kind: 'builtin' as const, name: 'claude-code' as const },
    role: 'implementer' as const,
    resolved_selection: { skills: [] },
    resolved_from: { source: 'role' as const, role: 'implementer' as const },
  };

  it('accepts a relay.started with no equipment field (back-compat)', () => {
    expect(TraceEntry.safeParse(base).success).toBe(true);
  });

  it('accepts an enforced decision carrying its enforced tool list', () => {
    const ok = TraceEntry.safeParse({
      ...base,
      equipment: {
        declared: 'enforced',
        effective: 'enforced',
        downgraded: false,
        enforced_tools: ['Read', 'Edit', 'Write'],
      },
    });
    expect(ok.success).toBe(true);
  });

  it('accepts a trusted decision with no enforced tool list', () => {
    const ok = TraceEntry.safeParse({
      ...base,
      equipment: { declared: 'trusted', effective: 'trusted', downgraded: false },
    });
    expect(ok.success).toBe(true);
  });

  it('accepts a downgraded decision (declared enforced, effective trusted)', () => {
    const ok = TraceEntry.safeParse({
      ...base,
      equipment: { declared: 'enforced', effective: 'trusted', downgraded: true },
    });
    expect(ok.success).toBe(true);
  });

  it('rejects an effective-enforced decision missing the enforced tool list', () => {
    const bad = TraceEntry.safeParse({
      ...base,
      equipment: { declared: 'enforced', effective: 'enforced', downgraded: false },
    });
    expect(bad.success).toBe(false);
  });

  it('rejects an effective-trusted decision that still carries an enforced tool list (dishonest)', () => {
    const bad = TraceEntry.safeParse({
      ...base,
      equipment: {
        declared: 'trusted',
        effective: 'trusted',
        downgraded: false,
        enforced_tools: ['Read'],
      },
    });
    expect(bad.success).toBe(false);
  });

  it('rejects a downgraded decision whose effective enforcement is still enforced', () => {
    const bad = TraceEntry.safeParse({
      ...base,
      equipment: {
        declared: 'enforced',
        effective: 'enforced',
        downgraded: true,
        enforced_tools: ['Read'],
      },
    });
    expect(bad.success).toBe(false);
  });

  it('rejects an effective-enforced decision whose declared intent was only trusted', () => {
    // Effective enforcement is only reachable from a declared-enforced scope —
    // the runtime never tightens a trusted declaration into a real boundary.
    // This input satisfies every other rule (enforced_tools present, not flagged
    // downgraded) so it isolates the declared/effective consistency rule.
    const bad = TraceEntry.safeParse({
      ...base,
      equipment: {
        declared: 'trusted',
        effective: 'enforced',
        downgraded: false,
        enforced_tools: ['Read'],
      },
    });
    expect(bad.success).toBe(false);
  });

  it('rejects surplus keys on the equipment evidence (strict)', () => {
    const bad = TraceEntry.safeParse({
      ...base,
      equipment: {
        declared: 'trusted',
        effective: 'trusted',
        downgraded: false,
        note: 'smuggled',
      },
    });
    expect(bad.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// tool_scope capability (equipment-scope enforcement) — which connectors can
// restrict a worker's tool surface to a declared allow-list.
// ---------------------------------------------------------------------------
describe('ToolScopeCapability + connector tool_scope', () => {
  it('accepts the two capability values and rejects others', () => {
    expect(ToolScopeCapability.safeParse('none').success).toBe(true);
    expect(ToolScopeCapability.safeParse('allow-list').success).toBe(true);
    expect(ToolScopeCapability.safeParse('enforced').success).toBe(false);
    expect(ToolScopeCapability.safeParse('').success).toBe(false);
  });

  it('declares claude-code as allow-list-capable and the others as none', () => {
    expect(BUILTIN_CONNECTOR_SPECS['claude-code'].capabilities.tool_scope).toBe('allow-list');
    expect(BUILTIN_CONNECTOR_SPECS.codex.capabilities.tool_scope).toBe('none');
    expect(BUILTIN_CONNECTOR_SPECS['cursor-agent'].capabilities.tool_scope).toBe('none');
  });

  it('projects the same tool_scope through BUILTIN_CONNECTOR_CAPABILITIES', () => {
    expect(BUILTIN_CONNECTOR_CAPABILITIES['claude-code'].tool_scope).toBe('allow-list');
    expect(BUILTIN_CONNECTOR_CAPABILITIES.codex.tool_scope).toBe('none');
  });

  it('defaults tool_scope to none when the capability set omits it (back-compat)', () => {
    const parsed = ConnectorCapabilities.parse({
      filesystem: 'read-only',
      structured_output: 'json',
    });
    expect(parsed.tool_scope).toBe('none');
  });

  it('rejects an unknown tool_scope value on the capability set', () => {
    expect(
      ConnectorCapabilities.safeParse({
        filesystem: 'read-only',
        structured_output: 'json',
        tool_scope: 'enforced',
      }).success,
    ).toBe(false);
  });

  it('lets a custom descriptor declare tool_scope none (or omit it)', () => {
    const omitted = customConnector('gemini', ['./bin/g']);
    expect(CustomConnectorDescriptor.safeParse(omitted).success).toBe(true);
    const explicitNone = {
      ...omitted,
      capabilities: {
        filesystem: 'read-only' as const,
        structured_output: 'json' as const,
        tool_scope: 'none' as const,
      },
    };
    expect(CustomConnectorDescriptor.safeParse(explicitNone).success).toBe(true);
  });

  it('rejects a custom descriptor that claims allow-list (custom connectors cannot enforce in V1)', () => {
    const bad = {
      ...customConnector('gemini', ['./bin/g']),
      capabilities: {
        filesystem: 'read-only' as const,
        structured_output: 'json' as const,
        tool_scope: 'allow-list' as const,
      },
    };
    expect(CustomConnectorDescriptor.safeParse(bad).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Config contract — CONFIG-I1 through CONFIG-I7.
// ---------------------------------------------------------------------------
