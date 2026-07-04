import { CLAUDE_CODE_SUPPORTED_EFFORTS } from '../schemas/connector.js';
import type { Effort } from '../schemas/selection-policy.js';
import type { ResolvedSelection } from '../schemas/selection-policy.js';
import {
  type ConnectorRelayInput,
  type RelayModelUsage,
  type RelayResult,
  type RelayUsage,
  sha256Hex,
} from '../shared/connector-relay.js';
import { extractJsonObject } from '../shared/json-extraction.js';
import { connectorRemediation } from './remediation.js';
import {
  type ConnectorSubprocessResult,
  cappedSuffix,
  isConnectorSubprocessSpawnError,
  parseNdjsonObjects,
  runConnectorSubprocess,
  spawnErrorVerb,
} from './subprocess.js';

export { sha256Hex };

// Real claude-code connector. Invokes the Claude Code CLI as a subprocess of the
// Node.js runtime (subprocess-per-connector at v0). No external SDK
// dependency; Node stdlib only (`node:child_process` + `node:perf_hooks`
// here; `node:crypto` via `../shared/connector-relay.ts` for the shared
// `sha256Hex` helper).
//
// Tool surface: the subprocess receives Claude Code's default tool surface
// — Read, Write, Edit, Bash, Glob, Grep, etc. The runtime check (Zod
// report validation + accepted-verdict allowlist) is the only safety
// net for what the worker produces. MCP servers and slash commands stay
// closed because they can re-introduce arbitrary surfaces the check cannot
// reason about; every other tool is on by default and the worker decides
// what it needs.
//
// Each flag in CLAUDE_CODE_DISPATCH_FLAGS is load-bearing:
//   -p                       — print mode (non-interactive single relay).
//   --permission-mode        — bypassPermissions: the worker can invoke
//   bypassPermissions          its tools without an interactive approval
//                              prompt. The default permission check exists
//                              to checkpoint a human in the loop; in
//                              autonomous relay there is no human to
//                              approve, so the check just deadlocks Edit/
//                              Write/Bash. The runtime check (Zod report
//                              validation + accepted-verdict allowlist) is
//                              the substituted safety net for what the
//                              worker produces.
//   --strict-mcp-config      — empty MCP server list; no remote-write paths
//                              via MCP (Gmail, Notion, Slack, etc.).
//   --disable-slash-commands — zero skill/slash surface; the worker's
//                              behaviour is bounded by its prompt + tools,
//                              not by user-defined skills.
//   --setting-sources ''     — skip user, project, and local settings files.
//                              Prevents operator-configured hooks from
//                              firing inside the connector subprocess (e.g.
//                              this project's Stop hook), which would
//                              otherwise deadlock the subprocess via
//                              hook-feedback retry loops when spawned from
//                              within Circuit.
//   --settings '{}'          — explicit empty inline settings override so
//                              nothing (including keychain reads for stray
//                              settings) reintroduces a hook registration.
//   --output-format stream-json — NDJSON trace_entry stream (one object per
//                              line). The documented `json` format returns
//                              an array in observed behaviour; `stream-json`
//                              is the explicitly documented streaming
//                              protocol and is robust against future
//                              format-shape drift. Requires `--verbose`.
//   --verbose                — required by `--output-format stream-json`.
//   --no-session-persistence — ephemeral session; no resumable session file
//                              written under ~/.claude/projects/** per run.
export const CLAUDE_CODE_DISPATCH_FLAGS = [
  '-p',
  '--permission-mode',
  'bypassPermissions',
  '--strict-mcp-config',
  '--disable-slash-commands',
  '--setting-sources',
  '',
  '--settings',
  '{}',
  '--output-format',
  'stream-json',
  '--verbose',
  '--no-session-persistence',
] as const;

// Tools the claude CLI injects into the session as a consequence of OUR OWN
// dispatch flags, not the worker's equipment scope. `--json-schema` adds a
// `StructuredOutput` tool: the return channel the model uses to emit the
// validated JSON payload. It has no filesystem, network, or exec reach — it is
// a framework mechanism, so admitting it into the enforced-scope check does not
// widen a worker's real capability.
//
// Grounded against claude v2.1.178: `--tools <allow-list>` alone produces
// exactly the allow-list; adding `--json-schema` adds exactly `StructuredOutput`
// and nothing else, independent of the allow-list contents. This set is admitted
// ONLY when the relay actually emitted `--json-schema` (see the honesty guard in
// parseClaudeCodeStdout), so an unexpected return-channel tool appearing without
// our flag still fails closed. If a future CLI version names additional
// return-channel tools, extend this set rather than loosening the guard.
export const CLAUDE_CODE_STRUCTURED_OUTPUT_TOOLS = ['StructuredOutput'] as const;

export const CLAUDE_CODE_EXECUTABLE = 'claude';
// Re-exported from the built-in connector registry (the single source of
// truth); kept under this name for the connector's own effort guard and for
// call sites bound to the claude-code connector.
export { CLAUDE_CODE_SUPPORTED_EFFORTS };

// Default wall-clock budget for a single relay. With the open tool
// surface, workers do real file inspection / edits / verification before
// responding, so the default has headroom for that. A step's
// `budgets.wall_clock_ms` (per src/schemas/step.ts StepBase.budgets)
// overrides this when present.
const DEFAULT_TIMEOUT_MS = 600_000;

// Grace period between SIGTERM and SIGKILL. SIGTERM gives the
// subprocess a chance to close cleanly; if it is still alive after this
// window, SIGKILL is delivered and we resolve only after `close`
// actually fires.
const SIGTERM_TO_SIGKILL_GRACE_MS = 2_000;

// stdout / stderr caps. A misbehaving subprocess emitting an unbounded
// byte stream should not exhaust connector memory. Real relay
// transcripts for v0 are well under these bounds (the smoke test
// produces ~30 KB). 16 MiB stdout + 1 MiB stderr is the current ceiling.
const STDOUT_MAX_BYTES = 16 * 1024 * 1024;
const STDERR_MAX_BYTES = 1024 * 1024;

export interface ClaudeCodeRelayInput extends ConnectorRelayInput {}

// The `ClaudeCodeRelayResult` name is kept as the connector-specific
// alias for call sites that want a name bound to the `claude-code` connector's
// producer contract. The shape lives in `../shared/connector-relay.ts`
// `RelayResult` so the `codex` connector produces the same shape and
// the materializer consumes it uniformly.
export type ClaudeCodeRelayResult = RelayResult;

function selectedAnthropicModel(selection: ResolvedSelection | undefined): string | undefined {
  const model = selection?.model;
  if (model === undefined) return undefined;
  if (model.provider !== 'anthropic') {
    throw new Error(
      `claude-code connector cannot honor model provider '${model.provider}' for model '${model.model}'; expected provider 'anthropic'`,
    );
  }
  return model.model;
}

function assertClaudeCodeEffort(
  effort: Effort,
): asserts effort is (typeof CLAUDE_CODE_SUPPORTED_EFFORTS)[number] {
  if (!(CLAUDE_CODE_SUPPORTED_EFFORTS as readonly string[]).includes(effort)) {
    throw new Error(
      `claude-code connector cannot honor effort '${effort}'; supported efforts: ${CLAUDE_CODE_SUPPORTED_EFFORTS.join(', ')}`,
    );
  }
}

export function buildClaudeCodeArgs(input: ClaudeCodeRelayInput): string[] {
  const args: string[] = [];
  // Equipment-scope enforcement. `--tools` restricts the worker's tool surface
  // to exactly the named set under bypassPermissions. It is variadic and
  // greedily consumes following argv elements, so it MUST lead and be
  // terminated by the next flag (`-p`) — never left adjacent to the trailing
  // prompt, which it would otherwise swallow. The CLI accepts a single
  // comma-joined token. An empty list emits nothing (no dangling flag).
  if (input.toolAllowList !== undefined && input.toolAllowList.length > 0) {
    args.push('--tools', input.toolAllowList.join(','));
  }
  args.push(...CLAUDE_CODE_DISPATCH_FLAGS);
  const model = selectedAnthropicModel(input.resolvedSelection);
  if (model !== undefined) {
    args.push('--model', model);
  }
  const effort = input.resolvedSelection?.effort;
  if (effort !== undefined) {
    assertClaudeCodeEffort(effort);
    args.push('--effort', effort);
  }
  // Structured-output enforcement at the CLI layer. Claude Code's
  // --json-schema path is reliable for plain object roots; top-level
  // anyOf/oneOf schemas can make the CLI exit before returning a receipt.
  // For those shapes, fall back to the prompt shape hint and let the runtime
  // Zod parse remain the authoritative validator.
  if (claudeCodeEmitsStructuredOutputFlag(input)) {
    args.push('--json-schema', JSON.stringify(input.responseSchema));
  }
  args.push(input.prompt);
  return args;
}

// Single source of truth for whether this relay emits `--json-schema`. The argv
// builder uses it to decide whether to pass the flag, and the relay uses it to
// tell the parse-time honesty guard that the CLI's structured-output return
// channel (StructuredOutput) is expected in the session. Routing both decisions
// through one predicate is deliberate: the defect this guards against was the two
// decisions diverging — the flag was emitted, the guard didn't know, and it read
// the CLI's own return-channel tool as a scope leak.
export function claudeCodeEmitsStructuredOutputFlag(input: ClaudeCodeRelayInput): boolean {
  return (
    input.responseSchema !== undefined &&
    isClaudeCodeStructuredOutputCompatible(input.responseSchema)
  );
}

function claudeCodeStdoutDiagnostic(stdout: string): string | undefined {
  try {
    parseClaudeCodeStdout(stdout, '', 0);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function isClaudeCodeStructuredOutputCompatible(schema: Record<string, unknown>): boolean {
  return schema.type === 'object';
}

export async function relayClaudeCode(input: ClaudeCodeRelayInput): Promise<RelayResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const args = buildClaudeCodeArgs(input);
  let result: ConnectorSubprocessResult;
  try {
    // stdin is `ignore` (connected to /dev/null) and the child is detached:
    // the shared subprocess helper owns those lifecycle mechanics for all
    // connectors while this module keeps the claude-specific argv and parser.
    result = await runConnectorSubprocess({
      executable: CLAUDE_CODE_EXECUTABLE,
      args,
      timeoutMs,
      stdoutMaxBytes: STDOUT_MAX_BYTES,
      stderrMaxBytes: STDERR_MAX_BYTES,
      sigtermToSigkillGraceMs: SIGTERM_TO_SIGKILL_GRACE_MS,
      env: process.env,
    });
  } catch (error) {
    if (isConnectorSubprocessSpawnError(error)) {
      throw new Error(
        `claude-code subprocess ${spawnErrorVerb(error)}: ${error.message}. ${connectorRemediation('claude-code')}`,
      );
    }
    throw error;
  }

  if (result.timedOut) {
    const stdoutSuffix = cappedSuffix(result.stdoutCapped, 'stdout');
    const stderrSuffix = cappedSuffix(result.stderrCapped, 'stderr');
    throw new Error(
      `claude-code subprocess timed out after ${timeoutMs}ms; group-kill ${result.killGroupSucceeded ? 'sent' : 'failed'}; final signal=${result.signal ?? 'none'}; stdout[:500]=${result.stdout.slice(0, 500)}${stdoutSuffix}; stderr[:500]=${result.stderr.slice(0, 500)}${stderrSuffix}`,
    );
  }
  if (result.code !== 0) {
    const stdoutSuffix = cappedSuffix(result.stdoutCapped, 'stdout');
    const stderrSuffix = cappedSuffix(result.stderrCapped, 'stderr');
    const stdoutDiagnostic = claudeCodeStdoutDiagnostic(result.stdout);
    const diagnosticText =
      stdoutDiagnostic === undefined ? '' : `; stdout_diagnostic=${stdoutDiagnostic}`;
    throw new Error(
      `claude-code subprocess exited with code ${result.code}${result.signal ? ` (signal ${result.signal})` : ''}${diagnosticText}; stdout[:500]=${result.stdout.slice(0, 500)}${stdoutSuffix}; stderr[:500]=${result.stderr.slice(0, 500)}${stderrSuffix}`,
    );
  }
  if (result.stdoutCapped) {
    throw new Error(
      `claude-code subprocess stdout exceeded ${STDOUT_MAX_BYTES} bytes; capability-boundary check cannot be evaluated on truncated stream`,
    );
  }
  try {
    return parseClaudeCodeStdout(
      result.stdout,
      input.prompt,
      result.durationMs,
      input.toolAllowList,
      // Same predicate that decided whether buildClaudeCodeArgs emitted
      // --json-schema, so the guard admits the CLI's return-channel tool exactly
      // when we asked for structured output — the two can't diverge.
      claudeCodeEmitsStructuredOutputFlag(input),
    );
  } catch (error) {
    const stderrSuffix = cappedSuffix(result.stderrCapped, 'stderr');
    throw new Error(
      `claude-code subprocess: ${(error as Error).message}; stdout[:500]=${result.stdout.slice(0, 500)}; stderr[:200]=${result.stderr.slice(0, 200)}${stderrSuffix}`,
    );
  }
}

// Parsing is extracted so contract tests can exercise the parse branch
// without spawning a real subprocess. The claude CLI emits one JSON
// object per line (NDJSON) under `--output-format stream-json --verbose`.
// We need:
//   - the `{type:'system', subtype:'init'}` trace_entry (for session_id);
//   - the terminal `{type:'result'}` trace_entry (for the text result).
// MCP servers and slash commands stay closed at the flag layer and are
// re-asserted here at parse time so a future flag regression that
// silently widens either surface is caught before the connector result
// reaches any downstream trace-writer. Tools are unconstrained by design
// — the runtime check is the safety net for what workers produce.
export function parseClaudeCodeStdout(
  stdout: string,
  prompt: string,
  duration_ms: number,
  // The tool allow-list requested via `--tools` for an enforced equipment
  // scope. When present, the parser re-asserts that the session's tool surface
  // stayed within it — the honesty guard against a flag regression that
  // silently widened the surface. Absent means an unrestricted surface, so no
  // assertion runs.
  requestedTools?: readonly string[],
  // True when this relay emitted `--json-schema`. The CLI then injects its
  // structured-output return-channel tool(s) into the session
  // (CLAUDE_CODE_STRUCTURED_OUTPUT_TOOLS). Those are framework tools, not the
  // worker's equipment, so the guard admits them — but ONLY when we asked for
  // them, so an unexpected return-channel tool still fails closed.
  structuredOutputRequested = false,
): RelayResult {
  const trace_entries = parseNdjsonObjects(stdout, 'stream-json');
  if (trace_entries.length === 0) {
    throw new Error('stream-json stdout is empty');
  }

  // Filter strictly for `subtype === 'init'`.
  const initTraceEntry = trace_entries.find((e) => e.type === 'system' && e.subtype === 'init');
  // Take the LAST result trace_entry (terminal), not the first. `stream-json`
  // emits a single terminal result trace_entry at v0, but depending on future
  // CLI changes multiple result trace_entries could appear; the terminal one is
  // authoritative.
  const resultTraceEntries = trace_entries.filter((e) => e.type === 'result');
  const resultTraceEntry = resultTraceEntries[resultTraceEntries.length - 1];

  if (initTraceEntry === undefined) {
    throw new Error('system/init trace_entry missing from subprocess stdout');
  }
  if (resultTraceEntry === undefined) {
    throw new Error('result trace_entry missing from subprocess stdout');
  }
  if (resultTraceEntry.is_error === true) {
    const message =
      typeof resultTraceEntry.result === 'string' ? resultTraceEntry.result : '<no message>';
    throw new Error(`subprocess reported is_error: ${message}`);
  }

  // MCP and slash-command surfaces are closed at the flag layer and
  // re-asserted here so a flag regression cannot silently widen them.
  // Tools are unrestricted by design — the runtime check validates worker
  // output before it becomes flow state.
  const mcpServers = initTraceEntry.mcp_servers;
  const slashCommands = initTraceEntry.slash_commands;
  if (!Array.isArray(mcpServers) || mcpServers.length !== 0) {
    throw new Error(
      `init.mcp_servers must be []; got ${JSON.stringify(mcpServers)}. CLAUDE_CODE_DISPATCH_FLAGS includes --strict-mcp-config to keep this surface closed.`,
    );
  }
  if (!Array.isArray(slashCommands) || slashCommands.length !== 0) {
    throw new Error(
      `init.slash_commands must be []; got ${JSON.stringify(slashCommands)}. CLAUDE_CODE_DISPATCH_FLAGS includes --disable-slash-commands to keep this surface closed.`,
    );
  }

  // Enforced equipment scope: re-assert that the session's tool surface stayed
  // within the requested allow-list. `--tools` restricts the surface at the
  // flag layer; this is the parse-time safety net so a flag regression that
  // silently widened it (a tool we never granted appearing in the session)
  // fails the relay instead of letting an over-equipped worker reach flow state.
  if (requestedTools !== undefined && requestedTools.length > 0) {
    const sessionTools = initTraceEntry.tools;
    if (!Array.isArray(sessionTools)) {
      throw new Error(
        `init.tools must be an array to verify the enforced equipment scope; got ${JSON.stringify(sessionTools)}`,
      );
    }
    const allowed = new Set<string>(requestedTools);
    // Admit the CLI's structured-output return channel ONLY when this relay
    // emitted --json-schema. Without our flag the CLI never injects it, so an
    // unexpected StructuredOutput still counts as a leak (fail closed). Admitting
    // it does not widen the worker: it has no filesystem, network, or exec reach.
    if (structuredOutputRequested) {
      for (const tool of CLAUDE_CODE_STRUCTURED_OUTPUT_TOOLS) allowed.add(tool);
    }
    // Fail closed: a non-string entry is unverifiable against the allow-list,
    // so it counts as a leak rather than being narrowed away. A type-narrowing
    // filter would silently drop it and let an unverifiable surface pass.
    const leaked = sessionTools.filter((tool) => typeof tool !== 'string' || !allowed.has(tool));
    if (leaked.length !== 0) {
      const rendered = leaked
        .map((tool) => (typeof tool === 'string' ? tool : JSON.stringify(tool)))
        .join(', ');
      throw new Error(
        `enforced equipment scope violated: tools outside the allow-list are present in the session: ${rendered}. The relay passes --tools to restrict the surface to [${requestedTools.join(', ')}]; a tool beyond it means the restriction did not hold.`,
      );
    }
  }

  const receipt_id = initTraceEntry.session_id;
  const cli_version = initTraceEntry.claude_code_version;
  if (typeof receipt_id !== 'string' || receipt_id.length === 0) {
    throw new Error('init.session_id missing or empty');
  }
  if (typeof cli_version !== 'string' || cli_version.length === 0) {
    throw new Error('init.claude_code_version missing or empty');
  }
  // When `--json-schema` is in effect, claude-code routes the validated
  // JSON payload into `result.structured_output` (as a parsed object) and
  // leaves `result.result` as model prose (or empty when the model emits
  // zero free-form text alongside the StructuredOutput tool call). Prefer
  // the structured payload; fall back to the prose field when the schema
  // flag wasn't set.
  const structuredOutput = resultTraceEntry.structured_output;
  let result_body: string;
  if (structuredOutput !== undefined && structuredOutput !== null) {
    if (typeof structuredOutput !== 'object') {
      throw new Error('result.structured_output present but not an object');
    }
    result_body = JSON.stringify(structuredOutput);
  } else {
    const result_body_raw = resultTraceEntry.result;
    if (typeof result_body_raw !== 'string') {
      throw new Error('result.result missing or not a string');
    }
    // Tolerant extraction: workers preamble status sentences before their
    // JSON response despite the shape-hint instruction. Strip any prose
    // wrapping the JSON object so downstream check evaluation and report
    // schema parsing see clean JSON. Non-JSON output (rare) flows through
    // unchanged.
    result_body = extractJsonObject(result_body_raw);
  }
  const usage = extractRelayUsage(resultTraceEntry);
  return {
    request_payload: prompt,
    receipt_id,
    result_body,
    duration_ms,
    cli_version,
    ...(usage === undefined ? {} : { usage }),
  };
}

// Token/cost extraction from the terminal result event. Tolerant by design:
// any missing or odd-shaped field returns undefined instead of throwing,
// because usage is observability and a CLI that stops emitting it must not
// fail relays. The per-model `modelUsage` map is the true token total (the
// top-level `usage` block covers the main loop only); the top-level block is
// still read because it alone carries the cache-write TTL split.
function extractRelayUsage(resultTraceEntry: Record<string, unknown>): RelayUsage | undefined {
  const usage = resultTraceEntry.usage;
  const modelUsage = resultTraceEntry.modelUsage;
  const hasUsage = usage !== null && typeof usage === 'object';
  const hasModelUsage = modelUsage !== null && typeof modelUsage === 'object';
  if (!hasUsage && !hasModelUsage) return undefined;
  const u = (hasUsage ? usage : {}) as Record<string, unknown>;
  const cacheCreation = (u.cache_creation ?? {}) as Record<string, unknown>;

  const models: RelayModelUsage[] = [];
  if (hasModelUsage) {
    for (const [model, raw] of Object.entries(modelUsage as Record<string, unknown>)) {
      if (raw === null || typeof raw !== 'object') continue;
      const m = raw as Record<string, unknown>;
      const costUsd = finiteOrUndefined(m.costUSD);
      models.push({
        // The trace schema requires a non-empty model id, and a schema
        // rejection at trace append would fail the relay. An empty
        // modelUsage key becomes "unknown" so this stays observability.
        model: model.length === 0 ? 'unknown' : model,
        input_tokens: finiteOrZero(m.inputTokens),
        output_tokens: finiteOrZero(m.outputTokens),
        cache_read_tokens: finiteOrZero(m.cacheReadInputTokens),
        cache_creation_tokens: finiteOrZero(m.cacheCreationInputTokens),
        ...(costUsd === undefined ? {} : { cost_usd_reported: costUsd }),
      });
    }
  }

  const totalCostUsd = finiteOrUndefined(resultTraceEntry.total_cost_usd);
  const totals =
    models.length > 0
      ? {
          input_tokens: sumBy(models, (m) => m.input_tokens),
          output_tokens: sumBy(models, (m) => m.output_tokens),
          cache_read_tokens: sumBy(models, (m) => m.cache_read_tokens),
          cache_creation_tokens: sumBy(models, (m) => m.cache_creation_tokens),
        }
      : {
          input_tokens: finiteOrZero(u.input_tokens),
          output_tokens: finiteOrZero(u.output_tokens),
          cache_read_tokens: finiteOrZero(u.cache_read_input_tokens),
          cache_creation_tokens: finiteOrZero(u.cache_creation_input_tokens),
        };
  return {
    ...totals,
    cache_creation_5m_tokens: finiteOrZero(cacheCreation.ephemeral_5m_input_tokens),
    cache_creation_1h_tokens: finiteOrZero(cacheCreation.ephemeral_1h_input_tokens),
    ...(totalCostUsd === undefined ? {} : { total_cost_usd_reported: totalCostUsd }),
    ...(models.length === 0 ? {} : { models }),
  };
}

function finiteOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function sumBy<T>(items: readonly T[], pick: (item: T) => number): number {
  return items.reduce((sum, item) => sum + pick(item), 0);
}
