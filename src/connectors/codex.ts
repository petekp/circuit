import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { CODEX_SUPPORTED_EFFORTS } from '../schemas/connector.js';
import type { Effort } from '../schemas/selection-policy.js';
import type { ResolvedSelection } from '../schemas/selection-policy.js';
import type { ConnectorRelayInput, RelayResult } from '../shared/connector-relay.js';
import { extractJsonObject } from '../shared/json-extraction.js';
import { resolveCodexDefaultModel } from './codex-default-model.js';
import { connectorRemediation } from './remediation.js';
import {
  type ConnectorSubprocessResult,
  cappedSuffix,
  isConnectorSubprocessSpawnError,
  parseNdjsonObjects,
  runConnectorSubprocess,
  spawnErrorVerb,
} from './subprocess.js';

// Codex CLI connector. Invokes Codex as a Node subprocess (no external SDK
// dependency; Node stdlib only). Codex is a first-class write-capable worker,
// but Circuit still owns the subprocess boundary: user config/rules are
// ignored, dangerous bypass flags are denied, and the only permitted config
// override is model_reasoning_effort.
export const CODEX_WRITE_FLAGS = Object.freeze([
  'exec',
  '--json',
  '-s',
  'workspace-write',
  '--ephemeral',
  '--skip-git-repo-check',
  '--ignore-user-config',
  '--ignore-rules',
] as const);

export const CODEX_EXECUTABLE = 'codex';

// Forbidden flag / prefix set. Any of these in the spawn argv would undermine
// the connector-owned `-s workspace-write` boundary:
//
//   --dangerously-bypass-approvals-and-sandbox
//     Skips all confirmations AND disables the sandbox entirely.
//   --full-auto
//     Codex convenience alias that changes approvals/sandbox outside the pinned
//     connector contract.
//   --add-dir <DIR>
//     Extends the writable root set outside the runtime-supplied cwd.
//   -o / --output-last-message <FILE>
//     Codex CLI native write path: Codex writes the final message to
//     the named file regardless of model sandbox. This is a direct
//     repo-write surface outside Circuit's request/receipt/result files.
//   -c / --config <key=value>
//     Can override `sandbox_mode` / `sandbox_permissions` /
//     `shell_environment_policy` / `approval_policy` and therefore
//     disable the boundary from inside config rather than argv. There is
//     one controlled exception outside CODEX_WRITE_FLAGS:
//     buildCodexArgs may emit `-c model_reasoning_effort="<effort>"`
//     from the connector-owned effort allowlist. assertCodexSpawnArgvBoundary()
//     validates the final spawn argv so no caller-authored config key is
//     ever accepted.
//   -p / --profile <NAME>
//     Loads a named profile from `~/.codex/config.toml`; profiles can
//     carry sandbox / approval / MCP-server / shell-env overrides
//     that re-widen the surface outside the module's visibility.
//   --sandbox <MODE>
//     Long-form sandbox override. The one allowed sandbox declaration is
//     the base `-s workspace-write` pair in CODEX_WRITE_FLAGS; any later
//     sandbox flag would let argv order re-widen the boundary.
//
// The module-load assertion below rejects any of these as either an
// exact token match or a prefix (the `<arg>` variants like
// `--add-dir` take the next argv slot, but a `-c sandbox_mode="..."`
// reaching this assertion would still fire on the `-c` match if it were
// added to CODEX_WRITE_FLAGS).
//
// The forbidden-token set above covers `--full-auto`, `--add-dir`,
// `-c sandbox_mode=workspace-write`, `--profile`, and `-o` — all of
// which break the connector-owned boundary.
export const CODEX_FORBIDDEN_ARGV_TOKENS = Object.freeze([
  '--dangerously-bypass-approvals-and-sandbox',
  '--full-auto',
  '--add-dir',
  '-o',
  '--output-last-message',
  '-c',
  '--config',
  '-p',
  '--profile',
  '--sandbox',
] as const);
export const CODEX_REASONING_EFFORT_CONFIG_KEY = 'model_reasoning_effort';
// Re-exported from the built-in connector registry (the single source of
// truth); kept under this name for the connector's own effort guard, the
// allowlisted -c override builder, and call sites bound to the codex connector.
export { CODEX_SUPPORTED_EFFORTS };

// Fail-closed module-load assertion. The `CODEX_WRITE_FLAGS` constant
// is frozen (see `Object.freeze` above) so this is a static-shape
// invariant: the connector refuses to load if the flags drift away from
// the capability-boundary-preserving set.
//
// Why assert here rather than at first relay: catches a regression
// on `import` so a test suite that imports the module but skips the
// CODEX_SMOKE path still surfaces the invariant break.
if (
  !CODEX_WRITE_FLAGS.includes('-s') ||
  !CODEX_WRITE_FLAGS.includes('workspace-write') ||
  !CODEX_WRITE_FLAGS.includes('--ignore-user-config') ||
  !CODEX_WRITE_FLAGS.includes('--ignore-rules')
) {
  throw new Error(
    'CODEX_WRITE_FLAGS boundary invariant broken: must include "-s workspace-write", "--ignore-user-config", and "--ignore-rules"',
  );
}
const flagsAsStringArray: readonly string[] = CODEX_WRITE_FLAGS;
for (const forbidden of CODEX_FORBIDDEN_ARGV_TOKENS) {
  if (flagsAsStringArray.includes(forbidden)) {
    throw new Error(
      `CODEX_WRITE_FLAGS boundary invariant broken: must NOT include "${forbidden}" (forbidden-token set)`,
    );
  }
}

// Default wall-clock budget for a single relay. A step's
// `budgets.wall_clock_ms` overrides this when present.
const DEFAULT_TIMEOUT_MS = 600_000;

// Grace period between SIGTERM and SIGKILL, modeled on claude-code.ts.
const SIGTERM_TO_SIGKILL_GRACE_MS = 2_000;

// stdout / stderr caps. Codex's `--json` stream is typically tiny
// (four trace_entries for a single-turn relay), but a misbehaving
// subprocess should not exhaust connector memory.
const STDOUT_MAX_BYTES = 16 * 1024 * 1024;
const STDERR_MAX_BYTES = 1024 * 1024;

// Version-capture timeout. `codex --version` is a fast local command
// (~150ms on a warm cache); a longer-than-a-few-seconds hang indicates
// a broken installation and should fail the relay rather than block
// indefinitely.
const VERSION_CAPTURE_TIMEOUT_MS = 5_000;

export interface CodexRelayInput extends ConnectorRelayInput {}

// The `CodexRelayResult` name parallels `ClaudeCodeRelayResult` —
// both alias the shared `RelayResult` shape and exist for call-site
// clarity at the connector boundary.
export type CodexRelayResult = RelayResult;

// Capture the Codex CLI version via a separate `codex --version`
// shellout. Codex's `--json` stream does not emit version in-band
// (unlike `claude`'s `system/init` trace_entry which carries
// `claude_code_version`), so a pre-invocation shellout is the only
// direct way to version-pin a relay.
//
// The version capture is memoized per process lifetime so the overhead
// is paid once per connector import, not once per relay. `codex
// --version` also prints PATH-update warnings to stderr on some
// installations; memoizing localizes that side-effect to the first
// relay in a process. Trade-off: if the operator upgrades the Codex
// CLI mid-process, the cached version goes stale until the process
// restarts. At v0 this is an accepted corner case — CLI upgrades
// mid-session are rare, and the fingerprint writer invokes
// relayCodex fresh each smoke run (so fingerprint evidence remains
// version-accurate as long as the smoke run process restarts after a
// CLI upgrade, which it does since vitest spawns fresh workers).
let cachedCodexVersion: string | undefined;
function captureCodexVersion(): string {
  if (cachedCodexVersion !== undefined) return cachedCodexVersion;
  let stdout: string;
  try {
    stdout = execFileSync(CODEX_EXECUTABLE, ['--version'], {
      encoding: 'utf8',
      timeout: VERSION_CAPTURE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    throw new Error(`codex --version failed: ${(err as Error).message}`);
  }
  // Expected format: "codex-cli 0.118.0" (one line, may include trailing
  // newline). Parse liberally: strip whitespace, keep whatever token(s)
  // remain. If the CLI output shape changes, version-pin still records
  // the raw bytes; downstream tools can normalize.
  const version = stdout.trim();
  if (version.length === 0) {
    throw new Error('codex --version produced empty output');
  }
  cachedCodexVersion = version;
  return version;
}

function assertCodexEffort(
  effort: Effort,
): asserts effort is (typeof CODEX_SUPPORTED_EFFORTS)[number] {
  if (!(CODEX_SUPPORTED_EFFORTS as readonly string[]).includes(effort)) {
    throw new Error(
      `codex connector cannot honor effort '${effort}'; supported efforts: ${CODEX_SUPPORTED_EFFORTS.join(', ')}`,
    );
  }
}

function selectedOpenAIModel(selection: ResolvedSelection | undefined): string | undefined {
  const model = selection?.model;
  if (model === undefined) return undefined;
  if (model.provider !== 'openai') {
    throw new Error(
      `codex connector cannot honor model provider '${model.provider}' for model '${model.model}'; expected provider 'openai'`,
    );
  }
  return model.model;
}

export function codexReasoningEffortConfigValue(
  effort: (typeof CODEX_SUPPORTED_EFFORTS)[number],
): string {
  return `${CODEX_REASONING_EFFORT_CONFIG_KEY}=${JSON.stringify(effort)}`;
}

function isForbiddenCodexArg(arg: string): boolean {
  return CODEX_FORBIDDEN_ARGV_TOKENS.some((token) => {
    if (token === '-c') return false;
    if (arg === token) return true;
    return token.startsWith('--') && arg.startsWith(`${token}=`);
  });
}

function isAllowedCodexConfigOverride(value: string | undefined): boolean {
  return (
    value !== undefined &&
    CODEX_SUPPORTED_EFFORTS.some((effort) => value === codexReasoningEffortConfigValue(effort))
  );
}

export function assertCodexSpawnArgvBoundary(args: readonly string[]): void {
  const sandboxFlagIndexes = args
    .map((arg, idx) => (arg === '-s' ? idx : -1))
    .filter((idx) => idx >= 0);
  const sandboxFlagIndex = sandboxFlagIndexes[0];
  if (
    sandboxFlagIndexes.length !== 1 ||
    sandboxFlagIndex === undefined ||
    args[sandboxFlagIndex + 1] !== 'workspace-write'
  ) {
    throw new Error(
      'codex spawn argv boundary broken: exactly one "-s workspace-write" pair is required',
    );
  }

  let configOverrideCount = 0;
  for (let idx = 0; idx < args.length; idx += 1) {
    const arg = args[idx];
    if (arg === undefined) continue;
    if (arg === '-c') {
      configOverrideCount += 1;
      if (configOverrideCount > 1) {
        throw new Error(
          'codex spawn argv boundary broken: at most one allowlisted -c override is allowed',
        );
      }
      const value = args[idx + 1];
      if (!isAllowedCodexConfigOverride(value)) {
        throw new Error(
          `codex spawn argv boundary broken: only ${CODEX_REASONING_EFFORT_CONFIG_KEY}=<supported effort> is allowed after -c`,
        );
      }
      idx += 1;
      continue;
    }
    if (isForbiddenCodexArg(arg)) {
      throw new Error(`codex spawn argv boundary broken: forbidden argv token "${arg}"`);
    }
  }
}

// `defaultModel` is the connector-resolved fallback used ONLY when the
// selection stack pinned no openai model. relayCodex resolves it from the codex
// models cache and passes it here, so a doer step that pins no model still
// spawns with an explicit `-m` instead of inheriting codex's CLI-baked default
// (which a given account may not be entitled to). A selection-pinned model
// always wins over the fallback. Left undefined by direct callers and unit
// tests, so those paths keep their prior "no -m unless the selection has one"
// behavior with no filesystem read.
export function buildCodexArgs(
  input: CodexRelayInput,
  schemaPath?: string,
  defaultModel?: string,
): string[] {
  const args: string[] = [...CODEX_WRITE_FLAGS];
  if (input.cwd !== undefined) {
    args.push('--cd', input.cwd);
  }
  const model = selectedOpenAIModel(input.resolvedSelection) ?? defaultModel;
  if (model !== undefined) {
    args.push('-m', model);
  }
  const effort = input.resolvedSelection?.effort;
  if (effort !== undefined) {
    assertCodexEffort(effort);
    args.push('-c', codexReasoningEffortConfigValue(effort));
  }
  if (schemaPath !== undefined) {
    args.push('--output-schema', schemaPath);
  }
  args.push(input.prompt);
  assertCodexSpawnArgvBoundary(args);
  return args;
}

// Allocate the temp directory FIRST and return it alongside the file path
// so the caller can register the dir for cleanup before any operation that
// might throw (JSON.stringify on a BigInt, EAGAIN on writeFile, etc.) gets
// a chance to leak it. Callers must hold the returned `dir` through a
// try/finally even if `path` is never written successfully.
//
// Exported for direct test coverage of the cleanup-on-throw path; not a
// stable runtime surface.
//
const CODEX_OUTPUT_SCHEMA_UNSUPPORTED_KEYWORDS: ReadonlySet<string> = new Set([
  '$id',
  '$ref',
  '$schema',
  '$defs',
  'allOf',
  'anyOf',
  'const',
  'contains',
  'definitions',
  'dependentRequired',
  'dependentSchemas',
  'exclusiveMaximum',
  'exclusiveMinimum',
  'format',
  'if',
  'maxContains',
  'maxItems',
  'maxLength',
  'maxProperties',
  'maximum',
  'minContains',
  'minItems',
  'minLength',
  'minProperties',
  'minimum',
  'multipleOf',
  'not',
  'oneOf',
  'pattern',
  'patternProperties',
  'propertyNames',
  'then',
  'uniqueItems',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function everyObjectPropertyIsRequired(schema: Record<string, unknown>): boolean {
  if (!isRecord(schema.properties)) return true;
  if (!Array.isArray(schema.required)) return false;
  const required = new Set(
    schema.required.filter((value): value is string => typeof value === 'string'),
  );
  const propertyNames = Object.keys(schema.properties);
  return (
    propertyNames.length === required.size &&
    propertyNames.every((property) => required.has(property))
  );
}

function isCodexOutputSchemaNodeCompatible(node: unknown): boolean {
  if (Array.isArray(node)) return node.every(isCodexOutputSchemaNodeCompatible);
  if (!isRecord(node)) return true;

  for (const key of Object.keys(node)) {
    if (CODEX_OUTPUT_SCHEMA_UNSUPPORTED_KEYWORDS.has(key)) return false;
  }

  if (Array.isArray(node.type)) return false;
  if (node.type === 'object') {
    if (node.additionalProperties !== undefined && node.additionalProperties !== false) {
      return false;
    }
    if (!everyObjectPropertyIsRequired(node)) return false;
  }

  return Object.values(node).every(isCodexOutputSchemaNodeCompatible);
}

// Probe whether a JSON Schema can be passed to codex's `--output-schema`.
// Codex forwards that flag into the OpenAI structured-output path, which accepts
// a narrower schema subset than draft-07. If a flow report schema carries
// validation-only constraints such as minLength, pattern, propertyNames, or
// additionalProperties-as-schema, skip the flag and rely on the prose shape hint
// plus the runtime Zod parse instead of letting the CLI fail before generation.
//
// Exported for direct test coverage; not a stable runtime surface.
export function isCodexOutputSchemaCompatible(schema: Record<string, unknown>): boolean {
  return schema.type === 'object' && isCodexOutputSchemaNodeCompatible(schema);
}

export async function writeSchemaTempFile(
  schema: Record<string, unknown>,
): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(joinPath(tmpdir(), 'circuit-codex-schema-'));
  try {
    const path = joinPath(dir, 'schema.json');
    await writeFile(path, JSON.stringify(schema), 'utf8');
    return { dir, path };
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

async function cleanupSchemaTempDir(dir: string | undefined): Promise<void> {
  if (dir === undefined) return;
  // Remove the entire mkdtemp directory; the schema file is the only
  // thing in it, but `rm -rf` against the dir is safer than dance-
  // around-then-rmdir if any future code ever drops a sibling output.
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; a leaked temp dir is preferable to surfacing
    // a teardown error and masking the real relay result.
  }
}

export async function relayCodex(input: CodexRelayInput): Promise<RelayResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cli_version = captureCodexVersion();
  // Acquire the schema temp file FIRST and put every subsequent operation
  // inside the try block. If `buildCodexArgs` throws (boundary assertion)
  // or if `spawn` throws, the `finally` still runs and the mkdtemp
  // directory is cleaned. `writeSchemaTempFile` cleans up its own dir if
  // the JSON serialization itself throws (BigInt, circular ref) so this
  // local `tempDir` only sees a successfully-allocated directory.
  let tempDir: string | undefined;
  let schemaPath: string | undefined;
  try {
    // Resolve the effective openai model BEFORE spawning. A selection-pinned
    // model wins; otherwise fall back to the connector default resolved from the
    // codex models cache. resolveCodexDefaultModel throws a loud, actionable
    // error HERE — before any subprocess, i.e. before spend — when no model can
    // be resolved, rather than letting codex inherit its (possibly unentitled)
    // CLI default and 400 mid-turn. The throw propagates out of relayCodex; the
    // `finally` below still runs (tempDir is undefined at this point, a no-op).
    const effectiveModel =
      selectedOpenAIModel(input.resolvedSelection) ?? resolveCodexDefaultModel();
    // Degrade gracefully for schemas outside Codex's structured-output subset:
    // skip the flag and fall back to the prose shape hint already embedded in
    // the prompt. The downstream runtime Zod check still validates worker
    // output.
    if (input.responseSchema !== undefined && isCodexOutputSchemaCompatible(input.responseSchema)) {
      const allocated = await writeSchemaTempFile(input.responseSchema);
      tempDir = allocated.dir;
      schemaPath = allocated.path;
    }
    const args = buildCodexArgs(input, schemaPath, effectiveModel);
    let result: ConnectorSubprocessResult;
    try {
      // The shared subprocess helper owns stdin-ignore, detached process
      // groups, timeout kill, and bounded output capture. Codex-specific
      // sandbox flags and JSONL parsing remain in this module.
      result = await runConnectorSubprocess({
        executable: CODEX_EXECUTABLE,
        args,
        timeoutMs,
        stdoutMaxBytes: STDOUT_MAX_BYTES,
        stderrMaxBytes: STDERR_MAX_BYTES,
        sigtermToSigkillGraceMs: SIGTERM_TO_SIGKILL_GRACE_MS,
        env: process.env,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      });
    } catch (error) {
      if (isConnectorSubprocessSpawnError(error)) {
        throw new Error(
          `codex subprocess ${spawnErrorVerb(error)}: ${error.message}. ${connectorRemediation('codex')}`,
        );
      }
      throw error;
    }

    if (result.timedOut) {
      const stdoutSuffix = cappedSuffix(result.stdoutCapped, 'stdout');
      const stderrSuffix = cappedSuffix(result.stderrCapped, 'stderr');
      throw new Error(
        `codex subprocess timed out after ${timeoutMs}ms; group-kill ${result.killGroupSucceeded ? 'sent' : 'failed'}; final signal=${result.signal ?? 'none'}; stdout[:500]=${result.stdout.slice(0, 500)}${stdoutSuffix}; stderr[:2000]=${result.stderr.slice(0, 2000)}${stderrSuffix}`,
      );
    }
    if (result.code !== 0) {
      const stdoutSuffix = cappedSuffix(result.stdoutCapped, 'stdout');
      const stderrSuffix = cappedSuffix(result.stderrCapped, 'stderr');
      throw new Error(
        `codex subprocess exited with code ${result.code}${result.signal ? ` (signal ${result.signal})` : ''}; stdout[:500]=${result.stdout.slice(0, 500)}${stdoutSuffix}; stderr[:2000]=${result.stderr.slice(0, 2000)}${stderrSuffix}`,
      );
    }
    if (result.stdoutCapped) {
      throw new Error(
        `codex subprocess stdout exceeded ${STDOUT_MAX_BYTES} bytes; capability-boundary check cannot be evaluated on truncated stream`,
      );
    }
    try {
      const parsed = parseCodexStdout(result.stdout, input.prompt, result.durationMs, cli_version);
      // Record which model the doer actually ran with. When the selection
      // pinned none, effectiveModel is the cache-resolved default — recording it
      // keeps the run receipt authoritative about the model even though the
      // selection layer (resolved_selection) pinned nothing. Parallels the
      // cli_version already carried on RelayResult: both are connector-dispatch
      // facts observed at spawn, not selection-provenance claims.
      return { ...parsed, model: effectiveModel };
    } catch (error) {
      const stderrSuffix = cappedSuffix(result.stderrCapped, 'stderr');
      throw new Error(
        `codex subprocess: ${(error as Error).message}; stdout[:500]=${result.stdout.slice(0, 500)}; stderr[:200]=${result.stderr.slice(0, 200)}${stderrSuffix}`,
      );
    }
  } finally {
    await cleanupSchemaTempDir(tempDir);
  }
}

// Known `item.completed` `item.type` values at Codex CLI 0.118-0.130. The
// connector accepts model narration, planning/progress items, command
// execution, reasoning, and write receipts. It rejects anything else: an
// unknown type may represent a new capability surface that bypasses the
// connector-owned contract and needs to be explicitly reviewed before we
// start admitting it.
//
// A future CLI bump that introduces another reviewed protocol item type can
// extend this list; a bump that introduces a new capability surface must be
// reviewed before this allowlist is extended.
const KNOWN_CODEX_ITEM_TYPES = new Set<string>([
  'agent_message',
  'command_execution',
  'reasoning',
  'file_change',
  'todo_list',
]);

// Top-level trace_entry types the parser expects at Codex CLI 0.118-0.128 —
// grounded in the `tests/fixtures/codex-smoke/protocol/happy-path-
// ok.jsonl` real capture, a 0.125 manual smoke that emitted
// `item.started` before a `command_execution`, and a 0.128
// observation of `item.updated` carrying incremental progress on a
// `command_execution`. An trace_entry whose `type` is outside this set
// is rejected: the connector refuses to admit unfamiliar protocol
// surfaces into the relay transcript. `item.updated` carries no new
// capability — it is a progress beacon for a command already opened
// via `item.started` and gated by the existing `KNOWN_CODEX_ITEM_TYPES`
// allowlist on the contained `item.type`.
const KNOWN_CODEX_EVENT_TYPES = new Set<string>([
  'thread.started',
  'turn.started',
  'item.started',
  'item.updated',
  'item.completed',
  'turn.completed',
]);

// Explicit failure-trace_entry types. The challenger's no-network probe
// observed top-level `turn.failed` and `error` trace_entries alongside a
// partial `thread.started` / `turn.started`. Rejecting these with
// named error messages keeps relay failures legible — the connector
// says "codex reported turn.failed" rather than surfacing as "missing
// turn.completed" and letting the caller guess what happened.
const CODEX_FAILURE_EVENT_TYPES = new Set<string>(['turn.failed', 'error']);

export function parseCodexStdout(
  stdout: string,
  prompt: string,
  duration_ms: number,
  cli_version: string,
): RelayResult {
  const trace_entries = parseNdjsonObjects(stdout, 'codex --json');
  if (trace_entries.length === 0) {
    throw new Error('codex --json stdout is empty');
  }

  // Top-level trace_entry-type gating.
  //   (a) Reject failure trace_entries up front with a named error so relay
  //       callers see "codex reported turn.failed" / "codex reported
  //       error" instead of a generic downstream parse error.
  //   (b) Reject unknown top-level trace_entry types so a new Codex CLI
  //       version that adds a capability trace_entry cannot slip past the
  //       known-types allowlist and land in the transcript implicitly.
  for (const [idx, trace_entry] of trace_entries.entries()) {
    const type = trace_entry.type;
    if (typeof type !== 'string') {
      throw new Error(`codex --json line ${idx + 1}: trace_entry has no string 'type' field`);
    }
    if (CODEX_FAILURE_EVENT_TYPES.has(type)) {
      const msgField =
        typeof trace_entry.message === 'string'
          ? trace_entry.message
          : typeof trace_entry.error === 'string'
            ? trace_entry.error
            : JSON.stringify(trace_entry).slice(0, 200);
      throw new Error(
        `codex reported ${type}: ${msgField}. If this recurs, examine whether the failure shape indicates a capability-boundary regression (e.g., a sandboxed write attempt surfacing as turn.failed).`,
      );
    }
    if (!KNOWN_CODEX_EVENT_TYPES.has(type)) {
      throw new Error(
        `codex --json line ${idx + 1}: unknown top-level trace_entry type '${type}' (allowlist: ${Array.from(KNOWN_CODEX_EVENT_TYPES).join(', ')}). A new Codex trace_entry type must be reviewed before the connector admits it.`,
      );
    }
  }

  // `thread.started` carries the thread_id. It is emitted as the FIRST
  // trace_entry of any exec invocation under Codex 0.118.
  const threadStarted = trace_entries.find((e) => e.type === 'thread.started');
  if (threadStarted === undefined) {
    throw new Error('thread.started trace_entry missing from codex --json stdout');
  }
  const thread_id = threadStarted.thread_id;
  if (typeof thread_id !== 'string' || thread_id.length === 0) {
    throw new Error('thread.started.thread_id missing or empty');
  }

  // `turn.completed` is the terminal turn marker. Missing = the turn did
  // not complete cleanly even if the exit code was 0 (shouldn't happen
  // at v0 but the assertion is cheap).
  const turnCompleted = trace_entries.find((e) => e.type === 'turn.completed');
  if (turnCompleted === undefined) {
    throw new Error('turn.completed trace_entry missing from codex --json stdout');
  }

  // Collect `item.completed` trace_entries. Each carries an `item` object
  // with an `id`, `type`, and type-specific fields. Reject any item whose
  // type is not in KNOWN_CODEX_ITEM_TYPES: a silent pass-through of a
  // novel item type would bypass the reviewed protocol surface.
  // New Codex item types must be reviewed before extending the allowlist.
  const itemCompleted = trace_entries.filter((e) => e.type === 'item.completed');
  for (const [idx, e] of itemCompleted.entries()) {
    const item = e.item;
    if (typeof item !== 'object' || item === null) {
      throw new Error(`item.completed[${idx}].item is not an object`);
    }
    const itemType = (item as Record<string, unknown>).type;
    if (typeof itemType !== 'string') {
      throw new Error(`item.completed[${idx}].item.type is not a string`);
    }
    if (!KNOWN_CODEX_ITEM_TYPES.has(itemType)) {
      throw new Error(
        `capability-boundary violation: item.completed[${idx}].item.type='${itemType}' is not in the known-types allowlist (${Array.from(KNOWN_CODEX_ITEM_TYPES).join(', ')}). A new Codex item type must be reviewed before the connector admits it.`,
      );
    }
  }

  // `item.updated` (Codex 0.128+) carries an incremental progress payload
  // for an item already opened via `item.started`. Check it against the
  // same KNOWN_CODEX_ITEM_TYPES allowlist as `item.completed` so a novel
  // item type cannot slip in via the update channel either.
  const itemUpdated = trace_entries.filter((e) => e.type === 'item.updated');
  for (const [idx, e] of itemUpdated.entries()) {
    const item = e.item;
    if (typeof item !== 'object' || item === null) {
      throw new Error(`item.updated[${idx}].item is not an object`);
    }
    const itemType = (item as Record<string, unknown>).type;
    if (typeof itemType !== 'string') {
      throw new Error(`item.updated[${idx}].item.type is not a string`);
    }
    if (!KNOWN_CODEX_ITEM_TYPES.has(itemType)) {
      throw new Error(
        `capability-boundary violation: item.updated[${idx}].item.type='${itemType}' is not in the known-types allowlist (${Array.from(KNOWN_CODEX_ITEM_TYPES).join(', ')}). A new Codex item type must be reviewed before the connector admits it.`,
      );
    }
  }

  // Take the LAST agent_message item — the terminal response. A Codex
  // exec may emit reasoning items between agent_message deltas
  // (though at 0.118 with --json we observe a single terminal
  // agent_message for the short prompts v0 relays carry).
  const agentMessages = itemCompleted.filter((e) => {
    const item = e.item as Record<string, unknown>;
    return (item.type as string) === 'agent_message';
  });
  const terminalMessage = agentMessages[agentMessages.length - 1];
  if (terminalMessage === undefined) {
    throw new Error('no item.completed/agent_message trace_entry found in codex --json stdout');
  }
  const item = terminalMessage.item as Record<string, unknown>;
  const result_body_raw = item.text;
  if (typeof result_body_raw !== 'string') {
    throw new Error('terminal agent_message item.text missing or not a string');
  }
  // Tolerant extraction: workers preamble status sentences before their
  // JSON response despite the shape-hint instruction. Symmetric with
  // `parseClaudeCodeStdout`. Non-JSON output flows through unchanged.
  const result_body = extractJsonObject(result_body_raw);

  return {
    request_payload: prompt,
    receipt_id: thread_id,
    result_body,
    duration_ms,
    cli_version,
  };
}
