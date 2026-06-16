import { z } from 'zod';
import { CompiledFlowId } from './ids.js';
import { RelayRole } from './step.js';

export const EnabledConnector = z.enum(['claude-code', 'codex', 'cursor-agent']);
export type EnabledConnector = z.infer<typeof EnabledConnector>;

export const FilesystemCapability = z.enum(['read-only', 'trusted-write', 'isolated-write']);
export type FilesystemCapability = z.infer<typeof FilesystemCapability>;

export const StructuredOutputCapability = z.enum(['json']);
export type StructuredOutputCapability = z.infer<typeof StructuredOutputCapability>;

// Whether a connector can restrict a worker's tool surface to a declared
// allow-list (the enforcement lever for equipment scope).
//   "none"       — cannot restrict tools; an enforced equipment scope is
//                  downgraded to trusted guidance against this connector.
//   "allow-list" — can spawn the worker with exactly a named set of tools, so
//                  an enforced equipment scope becomes a real boundary.
export const ToolScopeCapability = z.enum(['none', 'allow-list']);
export type ToolScopeCapability = z.infer<typeof ToolScopeCapability>;

export const ConnectorCapabilities = z
  .object({
    filesystem: FilesystemCapability,
    structured_output: StructuredOutputCapability,
    // Defaulted so a capability set serialized before this field existed (and a
    // custom descriptor that omits it) parses as the safe "cannot restrict"
    // value rather than failing.
    tool_scope: ToolScopeCapability.default('none'),
  })
  .strict();
export type ConnectorCapabilities = z.infer<typeof ConnectorCapabilities>;

export const PromptTransport = z.enum(['prompt-file']);
export type PromptTransport = z.infer<typeof PromptTransport>;

export const ConnectorOutputExtraction = z
  .object({
    kind: z.literal('output-file'),
  })
  .strict();
export type ConnectorOutputExtraction = z.infer<typeof ConnectorOutputExtraction>;

// Model provider a built-in connector binds to. Mirrors the closed provider
// enum on `SelectionPolicy.Model.provider`; a connector cannot honor a model
// from a different provider.
export type ConnectorProvider = 'anthropic' | 'openai' | 'gemini';

// Single source of truth for built-in connector identity. Every built-in
// connector carries exactly this much identity: the model provider it binds
// to, the effort levels it can honor, and its filesystem / structured-output
// capabilities. The executable name and dispatch flags stay in the connector
// modules (they are subprocess-spawn mechanics, not selection-time identity).
//
// `satisfies Record<EnabledConnector, ConnectorSpec>` is the load-bearing
// guard: adding a value to the `EnabledConnector` enum without a matching
// entry here — or adding an entry whose key is not in the enum — is a `tsc`
// error, so the registry can never silently drift out of sync with the enum.
export interface ConnectorSpec {
  readonly provider: ConnectorProvider;
  readonly supportedEfforts: readonly string[];
  readonly capabilities: ConnectorCapabilities;
}

// Effort tuples are declared here as the single source of truth and
// re-exported from the connector modules under their established names
// (CLAUDE_CODE_SUPPORTED_EFFORTS, etc.). The `as const` preserves the literal
// tuple type those modules rely on for their `asserts effort is ...` guards.
export const CLAUDE_CODE_SUPPORTED_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const CODEX_SUPPORTED_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;
export const CURSOR_AGENT_SUPPORTED_EFFORTS = ['none'] as const;

export const BUILTIN_CONNECTOR_SPECS = {
  'claude-code': {
    provider: 'anthropic',
    supportedEfforts: CLAUDE_CODE_SUPPORTED_EFFORTS,
    // The CLI's `--tools` flag restricts the worker's tool surface, so an
    // enforced equipment scope becomes a real boundary on this connector.
    capabilities: {
      filesystem: 'trusted-write',
      structured_output: 'json',
      tool_scope: 'allow-list',
    },
  },
  codex: {
    provider: 'openai',
    supportedEfforts: CODEX_SUPPORTED_EFFORTS,
    capabilities: { filesystem: 'trusted-write', structured_output: 'json', tool_scope: 'none' },
  },
  'cursor-agent': {
    provider: 'gemini',
    supportedEfforts: CURSOR_AGENT_SUPPORTED_EFFORTS,
    capabilities: { filesystem: 'trusted-write', structured_output: 'json', tool_scope: 'none' },
  },
} as const satisfies Record<EnabledConnector, ConnectorSpec>;

// Derived capability view, preserved for callers that only need the
// filesystem / structured-output capabilities. Single source of truth is
// `BUILTIN_CONNECTOR_SPECS`; this projection cannot drift from it.
export const BUILTIN_CONNECTOR_CAPABILITIES: Readonly<
  Record<EnabledConnector, ConnectorCapabilities>
> = Object.fromEntries(
  EnabledConnector.options.map((name) => [name, BUILTIN_CONNECTOR_SPECS[name].capabilities]),
) as Record<EnabledConnector, ConnectorCapabilities>;

// connector-I2: the `'auto'` literal is a reserved sentinel for
// `RelayConfig.default`; connector names must not collide with it.
export const RESERVED_CONNECTOR_NAMES: readonly string[] = [
  ...EnabledConnector.options,
  'auto',
] as const;

export const ConnectorName = z.string().regex(/^[a-z][a-z0-9-]*$/);
export type ConnectorName = z.infer<typeof ConnectorName>;

// connector-I3: element-level `.min(1)` forbids empty argv elements
// (e.g. `['']` or `['codex', '']`) which either signal a bug or are a
// silent gotcha — shells drop them; `execve(2)` does not.
export const CustomConnectorDescriptor = z
  .object({
    kind: z.literal('custom'),
    name: ConnectorName,
    command: z.array(z.string().min(1)).min(1),
    prompt_transport: PromptTransport,
    output: ConnectorOutputExtraction,
    capabilities: ConnectorCapabilities,
  })
  .strict()
  .superRefine((descriptor, ctx) => {
    if (descriptor.capabilities.filesystem !== 'read-only') {
      ctx.addIssue({
        code: 'custom',
        path: ['capabilities', 'filesystem'],
        message:
          'custom connectors are read-only in V1; writable custom workers require a later isolated mode',
      });
    }
    if (descriptor.capabilities.tool_scope !== 'none') {
      ctx.addIssue({
        code: 'custom',
        path: ['capabilities', 'tool_scope'],
        message:
          'custom connectors cannot enforce a tool allow-list in V1; declare tool_scope "none" (an enforced equipment scope is honored only by a built-in connector that can restrict tools)',
      });
    }
  });
export type CustomConnectorDescriptor = z.infer<typeof CustomConnectorDescriptor>;

export const BuiltInConnectorRef = z
  .object({
    kind: z.literal('builtin'),
    name: EnabledConnector,
  })
  .strict();
export type BuiltInConnectorRef = z.infer<typeof BuiltInConnectorRef>;

export const NamedConnectorRef = z
  .object({
    kind: z.literal('named'),
    name: ConnectorName,
  })
  .strict();
export type NamedConnectorRef = z.infer<typeof NamedConnectorRef>;

export const ConnectorRef = z.union([
  BuiltInConnectorRef,
  NamedConnectorRef,
  CustomConnectorDescriptor,
]);
export type ConnectorRef = z.infer<typeof ConnectorRef>;

// A resolved connector MUST NOT still be a named
// reference. Named references are pre-resolution pointers at the registry;
// the relayer must dereference them before emitting RelayStartedTraceEntry.
// `ResolvedConnector` is the 2-variant discriminated union used at the trace_entry
// layer; `ConnectorRef` remains the 3-variant pre-resolution union used in
// config and CLI parsing.
export const ResolvedConnector = z.union([BuiltInConnectorRef, CustomConnectorDescriptor]);
export type ResolvedConnector = z.infer<typeof ResolvedConnector>;

// The tool-scope capability of a fully-resolved connector — the single lookup
// the equipment-enforcement resolver needs. Built-ins read from the registry;
// a custom descriptor carries its own (forced to 'none' in V1).
export function connectorToolScopeCapability(connector: ResolvedConnector): ToolScopeCapability {
  if (connector.kind === 'custom') return connector.capabilities.tool_scope;
  return BUILTIN_CONNECTOR_CAPABILITIES[connector.name].tool_scope;
}

// Relay resolution source carries a category plus a disambiguator. Same
// shape as the applied[] entries on the selection side. An audit reading
// `RelayStartedTraceEntry.resolved_from` can identify the exact config
// entry that chose the connector, not just the category.
const ExplicitResolutionSource = z.object({ source: z.literal('explicit') }).strict();
const RoleResolutionSource = z.object({ source: z.literal('role'), role: RelayRole }).strict();
const CircuitResolutionSource = z
  .object({ source: z.literal('circuit'), flow_id: CompiledFlowId })
  .strict();
const DefaultResolutionSource = z.object({ source: z.literal('default') }).strict();
const AutoResolutionSource = z.object({ source: z.literal('auto') }).strict();

export const RelayResolutionSource = z.discriminatedUnion('source', [
  ExplicitResolutionSource,
  RoleResolutionSource,
  CircuitResolutionSource,
  DefaultResolutionSource,
  AutoResolutionSource,
]);
export type RelayResolutionSource = z.infer<typeof RelayResolutionSource>;
