import type { ResolvedSelection } from '../schemas/selection-policy.js';
export { sha256OfString as sha256Hex } from '../schemas/hashing.js';

// Per-model token counts as reported by the connector CLI. The per-model map
// is the true total: the top-level usage block in claude-code's result event
// covers the main loop only, while internal helper calls appear here.
export interface RelayModelUsage {
  readonly model: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_creation_tokens: number;
  readonly cost_usd_reported?: number;
}

// Normalized token/cost usage for one relay subprocess. Optional everywhere it
// appears: usage is observability, not correctness, and a connector that emits
// no usage data must not fail a relay. The TTL split (5m vs 1h cache writes)
// exists only at this aggregate level because the CLI does not report it per
// model.
export interface RelayUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_creation_tokens: number;
  readonly cache_creation_5m_tokens: number;
  readonly cache_creation_1h_tokens: number;
  readonly total_cost_usd_reported?: number;
  readonly models?: readonly RelayModelUsage[];
}

// Shared relay-result shape produced by connector subprocess implementations.
// Materializers and runtime executors consume this shape without branching on the
// connector that produced it.
export interface RelayResult {
  readonly request_payload: string;
  readonly receipt_id: string;
  readonly result_body: string;
  readonly duration_ms: number;
  readonly cli_version: string;
  readonly usage?: RelayUsage;
  // The model the connector actually spawned with, when the connector resolves
  // it at dispatch. Set by codex when it falls back to (or confirms) a model
  // that the selection layer did not pin, so the run receipt is authoritative
  // about the model even though `resolved_selection.model` is absent. Optional:
  // a connector whose model is already fixed by `resolved_selection` (or that
  // does not surface one) leaves it unset.
  readonly model?: string;
}

export interface ConnectorRelayInput {
  prompt: string;
  timeoutMs?: number;
  cwd?: string;
  resolvedSelection?: ResolvedSelection;
  // JSON Schema (draft-07) describing the worker's final response shape.
  // Connectors that support a native structured-output flag (claude-code's
  // `--json-schema`, codex's `--output-schema`) pass this through. Custom
  // connectors and any connector that does not yet honor it fall back to
  // the prose shape hint already in the prompt.
  responseSchema?: Record<string, unknown>;
  // The exact tool names the worker is restricted to, set ONLY when the step
  // declares an ENFORCED equipment scope and the resolved connector can honor
  // it (tool_scope capability 'allow-list'). A connector that can restrict its
  // tool surface translates this to its native flag (claude-code's `--tools`);
  // a connector that cannot ignores it (the resolver never hands an enforced
  // list to such a connector, so absence means an unrestricted tool surface).
  toolAllowList?: readonly string[];
}
