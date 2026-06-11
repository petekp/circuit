---
contract: connector
status: ratified-v0.2
version: 0.2
schema_source: src/schemas/connector.ts
last_updated: 2026-06-11
depends_on: [ids, step, selection-policy]
enforces_also_in: [src/schemas/config.ts, src/schemas/trace-entry.ts]
report_ids:
  - connector.registry
  - connector.reference
  - connector.resolved
invariant_ids: [connector-I1, connector-I2, connector-I3, connector-I4, connector-I5, connector-I6, connector-I7, connector-I8, connector-I9, connector-I10, connector-I11]
property_ids: [connector.prop.custom_command_direct_exec_semantics, connector.prop.custom_command_environment_isolation, connector.prop.registry_closure_preserved_under_config_merge, connector.prop.reserved_name_disjointness_across_layer_merge, connector.prop.resolution_is_total_and_first_match_wins, connector.prop.resolved_from_agrees_with_resolution]
---

# Connector Contract

A **Connector** is the relay target a `RelayStep` executes against at
run time. The connector contract governs three related surfaces:

1. **Connector identity** — `EnabledConnector`, `ConnectorName`, and
   `CustomConnectorDescriptor`, which together name every connector that can
   run relayed work.
2. **Connector references** — `ConnectorRef` and `ConnectorReference`, which
   spell how steps, roles, circuits, and the default refer to a connector
   without re-declaring its shape at every reference site.
3. **Relay resolution** — the total ordered precedence that picks a
   concrete connector for a step at relay time, plus the in-trace_entry
   provenance record (`RelayStartedTraceEntry.resolved_from`) that makes
   the choice auditable after the fact.

The contract answers: what must be true of a connector name, a custom
descriptor, a connector reference, and a relay resolution record for
the relay layer to be structurally sound, name-space-safe, and
independently auditable?

## Ubiquitous language

See [UBIQUITOUS_LANGUAGE.md#relay-language](../../UBIQUITOUS_LANGUAGE.md#relay-language)
for canonical definitions of **Connector**, **ConnectorRef**, **Role**, and
**Relay resolution**. Do not introduce synonyms; new vocabulary must land in
[UBIQUITOUS_LANGUAGE.md](../../UBIQUITOUS_LANGUAGE.md) before use here. This
slice adds the entry **ConnectorName** (as a regex-
constrained slug, reserved-name-disjoint from `EnabledConnector`), the
entry **Custom connector descriptor** (a registered connector with an
argv command vector), and the entry **Relay resolution source** (the
category-plus-disambiguator record emitted on every `RelayStartedTraceEntry`)
to [UBIQUITOUS_LANGUAGE.md](../../UBIQUITOUS_LANGUAGE.md).

The distinction to keep straight: a **connector** runs a worker
(Claude Code headless CLI, Codex CLI, custom
operator-authored command). A **connector reference** is what a config
file or step carries pointing AT a connector. `ConnectorRef` (in
`src/schemas/connector.ts`) is the full 3-variant union that admits an
inline `CustomConnectorDescriptor`; `ConnectorReference` (in
`src/schemas/config.ts`) is the 2-variant union used inside
`relay.roles` and `relay.circuits` that REFUSES inline custom
descriptors and requires registration via `relay.connectors[name]`
instead. The asymmetry is intentional (connector-I5).

## Invariants

The runtime MUST reject any `EnabledConnector`, `ConnectorName`,
`CustomConnectorDescriptor`, `ConnectorRef`, `ConnectorReference`,
`RelayConfig`, or `RelayStartedTraceEntry.resolved_from` that
violates these. All invariants are enforced via `src/schemas/connector.ts`
and — for the cross-schema invariants — the schema files named per
invariant; tested in `tests/contracts/connector-schema.test.ts`,
`tests/contracts/codex-connector-schema.test.ts`,
`tests/contracts/cursor-agent-connector-schema.test.ts`.

- **connector-I1 — `EnabledConnector` is a closed 3-variant enum with
  declared semantic distinctions; adding a built-in is a breaking
  change.** The enum is the frozen tuple
  `['claude-code', 'codex', 'cursor-agent']`.
  The three built-ins mean:
  - `claude-code` — the Claude Code headless CLI (`claude -p` print-mode or
    equivalent), invoked as a **subprocess** of the Node.js runtime per
    ADR-0009 §1 (v0 invocation-pattern decision: subprocess-per-connector).
    Superseded prior wording described this as "the Claude Code Agent
    tool (same-process)" — that phrasing was SDK-flavored and is replaced
    here to match ADR-0009's subprocess-per-connector decision. The
    subprocess inherits the operator session's filesystem + environment
    via the parent process but runs as a child `claude` executable,
    not in the host Node process. No `@anthropic-ai/sdk` dep at v0;
    ADR-0009 §4 Check 28 enforces this at package.json level. Slice 87
    wires resolved selection into this connector: allowed Anthropic
    model ids are passed with `--model`; supported efforts (`low`,
    `medium`, `high`, `xhigh`, `max`) are passed with `--effort`; unsupported
    providers or unsupported built-in effort tiers fail before spawn.
  - `codex` — the Codex CLI relayed via `codex exec` as a
    **subprocess** of the Node.js runtime (same invocation pattern as
    `claude-code` per ADR-0009 §1) in the operator's current session context.
    Same host session as `claude-code`; distinct model vendor; distinct
    subprocess. Codex is a write-capable worker connector. It pins the Codex
    CLI to `codex exec --json -s workspace-write --ephemeral
    --skip-git-repo-check --ignore-user-config --ignore-rules`, threads the
    runtime workspace through `--cd` and subprocess `cwd`, and rejects argv
    surfaces that bypass or widen the connector-owned boundary
    (`--dangerously-bypass-approvals-and-sandbox`, `--full-auto`, `--add-dir`,
    `-o` / `--output-last-message`, arbitrary `-c` / `--config`, `-p` /
    `--profile`, and later `--sandbox` overrides). The only allowed `-c`
    override is `model_reasoning_effort=<supported effort>`.
    Compatible OpenAI model ids are passed with `-m`; supported efforts are
    `low`, `medium`, `high`, and `xhigh`; `max` fails before spawn.
    `parseCodexStdout()` still rejects unknown Codex JSONL event/item shapes
    and named failure entries so protocol drift fails closed.
    Slice 45 (P2.6) binds the mechanism and lands
    `src/connectors/codex.ts`; ADR-0009 §Consequences.Enabling is
    the governance authority (§Enabling explicitly names `codex` as the
    next connector after `claude-code`).
  - `cursor-agent` — the Cursor CLI relayed in headless print mode for
    write-capable implementer work. It is a dedicated built-in path so Circuit
    does not need to make arbitrary custom connectors write-capable. The
    current support matrix is Gemini provider only with `effort: none`.
  The built-ins are NOT interchangeable: `claude-code`, `codex`, and
  `cursor-agent` each have connector-owned provider, effort, subprocess, and
  filesystem behavior. Adding a
  built-in is a schema-level change that forces all
  consumers (`RelayConfig.default`, `relay.roles`,
  `relay.circuits`, the connector-bridge relayer, and every
  contract test) to coordinate. Enforced at `src/schemas/connector.ts`
  (`EnabledConnector = z.enum(['claude-code', 'codex', 'cursor-agent'])`).

- **connector-I2 — `ConnectorName` regex + reserved-name disjointness.**
  `ConnectorName` matches `^[a-z][a-z0-9-]*$`: lowercase letter + optional
  lowercase alnum or hyphen. No uppercase (avoids cross-platform
  case-sensitivity issues in registry keys). No leading digit (parses
  cleanly as an identifier in future DSLs). No whitespace. No trailing
  hyphen regex enforcement in v0.1 (cosmetic; v0.2 may add). **Reserved-
  name separation.** A custom connector key registered in
  `relay.connectors[name]` MUST NOT collide with any `EnabledConnector`
  enum value NOR the reserved `'auto'` sentinel used by
  `relay.default`. A custom connector named `codex` would silently
  shadow the built-in in `relay.default` resolution — it would parse
  successfully under the regex, appear in the registry, and be picked
  up by `default: 'codex'`, producing a behavior divergence the author
  did not intend. v0.1 rejects the collision at parse time in
  `RelayConfig.superRefine`. Enforced at `src/schemas/connector.ts`
  (the regex) and `src/schemas/config.ts` (the reservation check).

- **connector-I3 — `CustomConnectorDescriptor.command` is a non-empty argv
  vector of non-empty strings with a declared calling convention.**
  `command: z.array(z.string().min(1)).min(1)` — at least one element
  and no empty-string elements (an empty argv element would be passed
  to `execve(2)` as an empty argument, which has connector-specific
  behavior, at best misleading, at worst a silent error). The argv
  form is **direct exec** (`spawn(command[0], command.slice(1).concat([promptFile, outputFile]))`
  or equivalent); no `/bin/sh -c` wrapping; no shell interpolation; no
  `${VAR}` expansion by the relayer. `prompt_transport` is
  `prompt-file`, and `output.kind` is `output-file`. **Calling
  convention.** The
  relayer appends two positional arguments `PROMPT_FILE` and
  `OUTPUT_FILE` to `command` at invocation time; the connector reads its
  prompt from `PROMPT_FILE` and writes its JSON response object to
  `OUTPUT_FILE`. The connector's exit code distinguishes success (0)
  from failure (non-zero). This is the contract every custom connector
  must satisfy. Enforced at `src/schemas/connector.ts` and
  `src/connectors/custom.ts`.

  Minimal custom connector example:

  ```yaml
  relay:
    connectors:
      echo-reviewer:
        kind: custom
        name: echo-reviewer
        command: [node, ./scripts/echo-reviewer.ts]
        prompt_transport: prompt-file
        output: { kind: output-file }
        capabilities:
          filesystem: read-only
          structured_output: json
  ```

  ```js
  // scripts/echo-reviewer.ts
  import { readFileSync, writeFileSync } from 'node:fs';

  const [, , promptFile, outputFile] = process.argv;
  const prompt = readFileSync(promptFile, 'utf8');

  writeFileSync(
    outputFile,
    JSON.stringify({
      verdict: 'accept',
      summary: `Reviewed ${prompt.length} prompt characters.`,
    }),
  );
  ```

  Runtime policy:

  - `command[0]` is passed to Node's `child_process.spawn` directly.
    There is no shell, no `/bin/sh -c`, and no relayer-side expansion
    of `$VAR`, backticks, globs, or command separators.
  - Relative executable paths and bare executable names follow normal
    `spawn` lookup from the Circuit process current working directory
    and inherited `PATH`.
  - The subprocess inherits the Circuit process current working
    directory and `process.env`, plus the resolved-selection projection
    below. Inherited variables never collide with it: the `CIRCUIT_RELAY_`
    prefix is reserved.
  - When the relay's resolved selection carries a model, the subprocess
    environment carries `CIRCUIT_RELAY_MODEL` (the model string) and
    `CIRCUIT_RELAY_MODEL_PROVIDER` (the provider). When it carries an
    effort, the environment carries `CIRCUIT_RELAY_EFFORT`. Unset fields
    leave the variables absent, not empty. This is how a
    `power_tiers.<name>` tier reaches a worker whose CLI the engine
    cannot drive directly: the wrapper reads `CIRCUIT_RELAY_MODEL` and
    maps it onto its own model flag.
  - `stdin` is ignored. The prompt is available only through
    `PROMPT_FILE`.
  - `stdout` is debug output only. The canonical response is the first
    parseable JSON object extracted from `OUTPUT_FILE`.
  - `stderr` is captured for failure messages and capped.
  - The default timeout is 120 seconds unless the relay step provides
    a timeout. On timeout, the runtime sends `SIGTERM` to the child
    process group and then `SIGKILL` after a short grace period.
  - `OUTPUT_FILE` is rejected if it is empty or larger than the runtime
    output cap.
  - Circuit generates the receipt id as
    `custom:<connector-name>:<timestamp>`.

  **Capability caveat.** `capabilities.filesystem: read-only` is a
  Circuit routing promise, not an OS sandbox. Circuit refuses to route
  read-only custom connectors to implementer roles, but the wrapper is
  still a trusted local process with the inherited cwd and environment.
  Writable isolated custom workers require a later isolated mode.

- **connector-I4 — `ConnectorRef` is a 3-variant discriminated union with
  transitive `.strict()`.** The variants are `BuiltInConnectorRef`
  (`{kind: 'builtin', name: EnabledConnector}`), `NamedConnectorRef`
  (`{kind: 'named', name: ConnectorName}`), and `CustomConnectorDescriptor`
  (`{kind: 'custom', name: ConnectorName, command: string[]}`). Each
  variant is `.strict()` so surplus keys (authorial typos like
  `{kind: 'named', names: 'gemini'}`) are rejected at parse time, not
  silently stripped. The discriminant is `kind`; the union uses
  `z.discriminatedUnion` so a malformed `kind` fails fast with a
  clear error path. This union is the full connector-identity surface;
  it shows up in `RelayStartedTraceEntry.connector` and as the runtime
  value the relayer calls. Enforced at `src/schemas/connector.ts`.

- **connector-I5 — `ConnectorReference` (registry-layer reference) refuses
  inline custom descriptors; every custom connector MUST be registered.**
  `ConnectorReference` (in `src/schemas/config.ts`) is the 2-variant
  discriminated union `{kind: 'builtin', name: EnabledConnector} |
  {kind: 'named', name: ConnectorName}`. It is the type used inside
  `RelayConfig.roles` and `RelayConfig.circuits`. Inline
  `CustomConnectorDescriptor` is NOT a legal `ConnectorReference`.
  **Rationale.** If `relay.roles` and `relay.circuits` could
  inline descriptors, three problems arise: (1) the same connector
  might be defined differently in three places and the relayer
  would have no canonical definition to audit; (2) registry-closure
  checks (connector-I8) become impossible because there is no single
  registry; (3) operator-facing connector lists (`circuit list connectors`
  in Stage 2) can't enumerate connectors that only appear inline. Custom
  connectors MUST be registered in `relay.connectors` exactly once and
  referenced by name thereafter. The asymmetry with `ConnectorRef`
  (which DOES admit inline custom descriptors) is load-bearing:
  `ConnectorRef` is the runtime value the relayer resolves TO;
  `ConnectorReference` is what config files contain POINTING AT an
  connector. Enforced at `src/schemas/config.ts` via `.strict()`
  discriminated-union with no `custom` variant.

- **connector-I6 — `RelayRole` is a closed 3-variant enum; orchestrator
  is rejected.** The enum is `['researcher', 'implementer', 'reviewer']`.
  `orchestrator` is an **executor** (per step.ts / step.md STEP-I1), not
  a role; attempting to register `relay.roles.orchestrator = ...`
  is a schema error because `orchestrator` is not a legal record key
  under `z.record(RelayRole, ...)`. This mirrors Step's executor-vs-
  role distinction and prevents the category confusion the existing
  Circuit carries. Enforced at `src/schemas/step.ts` (definition) and
  `src/schemas/config.ts` (consumer).

- **connector-I7 — Relay resolution precedence is total, ordered, and
  its category + disambiguator is recorded in
  `RelayStartedTraceEntry.resolved_from`.** The precedence order at
  relay time (top wins, first match returns):
  1. **Explicit** — the operator passed `--connector <ref>` at
     invocation; the flag's value is the `ConnectorRef` used.
  2. **Role** — the step has a `RelayRole` and
     `RelayConfig.roles[role]` is present; its `ConnectorReference`
     is resolved (via `relay.connectors` if named).
  3. **Circuit** — `RelayConfig.circuits[flow_id]` is present;
     its `ConnectorReference` is resolved similarly.
  4. **Default** — `RelayConfig.default` is consulted. If the
     default is a `EnabledConnector` name or a registered
     `ConnectorName`, relay uses it directly. If the default is the
     sentinel `'auto'`, relay defers to the host-aware auto fallback.
  5. **Auto** — the fallback selects the worker connector that matches
     the current host when available: `codex` for the Codex host,
     `claude-code` for the Claude Code host, and `claude-code` as the
     generic-shell fallback. Runtime host identity wins before config.
     If no runtime host is supplied, layered `host` config composes by
     normal layer precedence; omitted `host` means "no opinion", while an
     explicit `host: {kind: generic-shell}` resets lower-precedence host
     config to the generic-shell fallback.

  The resolution record emitted on every `RelayStartedTraceEntry` is
  `resolved_from: RelayResolutionSource`, a discriminated union
  whose `source` discriminant names the winning precedence category
  and carries the disambiguator identifying *which* entry within the
  category contributed:
  - `{source: 'explicit'}`
  - `{source: 'role', role: RelayRole}`
  - `{source: 'circuit', flow_id: CompiledFlowId}`
  - `{source: 'default'}`
  - `{source: 'auto'}`

  The discriminated union closes the category-only-provenance gap
  pre-emptively (same shape as SEL-I7's `applied[]` entries for
  selection). An audit reading `RelayStartedTraceEntry.resolved_from`
  can identify the winning precedence category and — for the `role`
  and `circuit` categories — the exact role/flow entry that won;
  the v0.1 drafting's flat `z.enum` could identify only the
  *category*. Enforced at `src/schemas/trace-entry.ts`; the union itself
  is exported from `src/schemas/connector.ts` as
  `RelayResolutionSource`.

  **Scope caveat — default/explicit/auto provenance is singleton by
  design (closes Codex MED #6 at the prose layer).** `{source:
  'default'}`, `{source: 'explicit'}`, and `{source: 'auto'}` carry
  no disambiguator at v0.1. For `default`, this is because the
  applied `default` on a merged Config is a single composed value
  — which config *layer* (user-global, project, invocation)
  contributed the winning `default` is lost after the layer merge
  (`src/schemas/config.ts`). Adding a `layer: ConfigLayer` field is
  a v0.2 consideration driven by real audit needs. For `explicit`,
  the original `--connector` CLI token is recoverable from the
  invocation trace_entry elsewhere in the run trace; promoting it onto
  `resolved_from` would duplicate provenance that already exists
  out-of-band. For `auto`, the host branch is intentionally not
  duplicated in `resolved_from`; it is available from the runtime host
  context and the resolved connector itself. v0.2 revisits all three
  based on evidence from real runs. The contract does NOT claim these
  three identify the specific config layer or host branch that won at
  v0.1.

  **Role ↔ resolved_from.role binding (closes Codex HIGH #4).** On a
  `RelayStartedTraceEntry`, when `resolved_from.source === 'role'`, the
  trace_entry's `role` field MUST equal `resolved_from.role`. An trace_entry with
  `role: 'researcher'` paired with `resolved_from: {source: 'role',
  role: 'reviewer'}` parses each field independently but violates
  the role-provenance binding. Enforced at `src/schemas/trace-entry.ts`
  via a cross-field `superRefine` at the `TraceEntry` discriminated-union
  level (mirrors the `Step` pattern — variants stay plain
  `ZodObject`s so `z.discriminatedUnion` can admit them; cross-field
  refinements hoist to the union).

- **connector-I8 — Registry closure: every named reference resolves to a
  registered descriptor.** For every `ConnectorReference` in
  `RelayConfig.roles[*]`, `RelayConfig.circuits[*]`, and for a
  string `RelayConfig.default` that is neither a `EnabledConnector`
  nor the `'auto'` sentinel: the referenced name MUST be a key in
  `RelayConfig.connectors`. The runtime lookup is therefore total by
  construction. Invalid references fail at PARSE time with a clear
  error path (`['roles', 'researcher']: role connector not registered:
  gemini`), not at relay time (which might be deep inside a Run
  after a partial-progress trace). Closure is one-directional: a
  descriptor CAN be registered in `relay.connectors` without being
  referenced (it is available for `--connector` at invocation time or
  for manual relay). Enforced at `src/schemas/config.ts` via
  `RelayConfig.superRefine`.

- **connector-I9 — Transitive `.strict()` rejection across the relay
  surface.** `.strict()` is applied on `RelayConfigBody` (top-level
  surplus-key rejection), every `ConnectorRef` variant, every
  `ConnectorReference` variant, every `RelayResolutionSource` variant,
  and `CustomConnectorDescriptor`. Surplus keys are **rejected**, not
  stripped — a silent strip turns an authorial typo (`{kind: 'named',
  nmae: 'gemini'}`) into a named reference with no name, which then
  fails closure (connector-I8) with a misleading error far from the
  typo. Rejecting at parse time points the operator at the typo
  directly. Enforced at `src/schemas/connector.ts`, `src/schemas/config.ts`,
  and `src/schemas/trace-entry.ts`.

- **connector-I10 — A resolved connector MUST NOT be a pre-resolution
  named reference (closes Codex HIGH #1).** `RelayStartedTraceEntry.connector`
  is typed `ResolvedConnector`, a 2-variant discriminated union of
  `BuiltInConnectorRef` and `CustomConnectorDescriptor`. The
  `NamedConnectorRef` variant (`{kind: 'named', ...}`) is a
  pre-resolution pointer at the `relay.connectors` registry; it MUST
  be dereferenced into the registered `CustomConnectorDescriptor` (or
  a `BuiltInConnectorRef` for built-in names) before the relayer
  emits a `RelayStartedTraceEntry`. An trace_entry with `connector: {kind:
  'named', name: 'gemini'}` would mean "we relayed TO a symbolic
  reference" which is not an executor and is not replay-sufficient.
  Enforced at `src/schemas/connector.ts` (the `ResolvedConnector`
  definition) + `src/schemas/trace-entry.ts` (the trace_entry's `connector` field
  type).

- **connector-I11 — Registry key and descriptor `name` must agree
  (closes Codex HIGH #2).** For every entry in
  `RelayConfig.connectors`, the record key and the embedded
  `descriptor.name` field MUST be equal. `{connectors: {gemini:
  {name: 'ollama', command: [...]}}}` parses syntactically (both
  `gemini` and `ollama` satisfy `ConnectorName`) but produces two
  identities for a single registered executor: trace_entries would carry
  `connector.name: 'ollama'` while role/circuit references resolve to
  key `gemini`. An audit could not cross-reference the two without
  inverting the descriptor index. Enforced at `src/schemas/config.ts`
  via `RelayConfig.superRefine`.

## Pre-conditions

- An `ConnectorRef` is produced by parsing a runtime relay decision
  (CLI flag, config lookup, or auto-detect) into an object and passing
  it to `ConnectorRef.safeParse`.
- A `RelayConfig` is produced by layering config files (default,
  user-global, project, invocation) per [docs/contracts/config.md](config.md)
  (pending Stage 1 close Slice 26; tracked as arc-stage-1-close-codex.md §HIGH #3 correlated-miss) and passing the merged record to `RelayConfig.safeParse`.
- Every `ConnectorName` referenced in a `NamedConnectorRef` or an
  `ConnectorReference` (`kind: 'named'`) must exist in the running
  plugin's `relay.connectors` registry at load time (connector-I8 at
  parse time makes this total by construction).
- A `RelayStartedTraceEntry` is emitted by the relayer immediately
  before the connector spawn; its `connector: ConnectorRef` and
  `resolved_from: RelayResolutionSource` must agree with the
  resolution the relayer performed.

## Post-conditions

After an `ConnectorRef` is accepted:

- `kind` is one of `'builtin' | 'named' | 'custom'`.
- `builtin` variant's `name` is a `EnabledConnector` enum value.
- `named` variant's `name` is an `ConnectorName`; closure is separately
  enforced at the registry layer.
- `custom` variant's `command` is a non-empty argv of non-empty strings.

After a `RelayConfig` is accepted:

- `connectors` is a record keyed by unique `ConnectorName`s, disjoint from
  `EnabledConnector` enum values and from the `'auto'` literal (connector-I2).
- Every named reference in `roles`, `circuits`, and (when named)
  `default` has a corresponding entry in `connectors` (connector-I8).
- `roles` keys are drawn from the `RelayRole` enum (connector-I6).
- No surplus keys at the top level or in any nested connector-surface
  object (connector-I9).

After a `RelayStartedTraceEntry` is accepted:

- `connector` is a fully-resolved `ResolvedConnector` (built-in or
  inline custom descriptor), NOT a pre-resolution named reference
  (connector-I10).
- `resolved_from` is a `RelayResolutionSource` whose `source`
  discriminant names the winning precedence category and whose
  payload fields (where present — `role` or `flow_id`) identify
  the exact contributing entry within that category (connector-I7).
- When `resolved_from.source === 'role'`, the trace_entry's `role` field
  equals `resolved_from.role` (connector-I7 binding).
- **Scope caveat — schema validates shape, not resolver agreement
  (closes Codex HIGH #5).** The v0.1 schema validates the trace_entry's
  fields in isolation (and the role binding as a single cross-field
  refinement). It does NOT bind `connector` to `resolved_from`: an
  trace_entry with `connector: {kind: 'builtin', name: 'codex'}` and
  `resolved_from: {source: 'circuit', flow_id: 'explore'}`
  parses successfully even if the project config's
  `circuits.explore` override actually pointed at `gemini`. Binding
  `connector` to `resolved_from` requires the resolver's side of the
  relay procedure; it is covered by the Stage 2 property
  `connector.prop.resolved_from_agrees_with_resolution`. The schema
  is not audit-sufficient at v0.1 — only the pair (schema +
  resolver) is, and the resolver does not exist yet (Stage 2). An
  auditor reading a v0.1 trace_entry can reconstruct (a) the category
  and (for role/circuit) the specific entry that won, and (b) the
  resolved executor; they cannot independently verify the two
  agree without the resolver-level property test.

## Property ids (reserved for Stage 2 testing)

- `connector.prop.resolution_is_total_and_first_match_wins` — For any
  valid `RelayConfig`, any `step` with any `role`, and any
  `invocation` context, running the resolution procedure produces
  exactly one `ConnectorRef` per step; the first matching precedence
  category wins and later categories are ignored. Property fuzzes
  over adversarial role/circuit/default overlap patterns.

- `connector.prop.resolved_from_agrees_with_resolution` — For any
  relay resolution, the `RelayStartedTraceEntry.resolved_from`
  category matches the precedence category that actually won, and
  its disambiguator (role / flow_id) matches the config entry
  whose `ConnectorReference` was consumed. The "projection is a
  function" analog for relay resolution: `connector` is the
  effective value; `resolved_from` is the provenance trace; they
  must agree.

- `connector.prop.registry_closure_preserved_under_config_merge` —
  When `Config` layers are merged (default < user-global < project
  < invocation), the merged `RelayConfig` still satisfies
  connector-I8 (registry closure). A per-layer merge that introduces
  a role connector referencing a name registered only in a more-
  specific layer's `connectors` map must be rejected, because the
  merged config at a coarser layer would carry a dangling
  reference. Property fuzzes over layer merges and verifies closure.

- `connector.prop.custom_command_direct_exec_semantics` — For any
  valid `CustomConnectorDescriptor`, the relayer's invocation
  argv is exactly `command ++ [promptFile, outputFile]`, with no
  shell wrapping and no env-var expansion performed by the
  relayer. Adversarial cases fuzz command vectors with shell-
  meaningful substrings (`"; rm -rf /"`, `$HOME`, backticks) and
  verify they are passed literally.

- `connector.prop.custom_command_environment_isolation` — Future
  hardening property for the custom connector process environment.
  v0.1 deliberately documents and tests the current inherited cwd/env
  policy; this property stays reserved for the later choice to either
  ratify that policy under a property harness or replace it with an
  explicit filtered environment / isolated cwd policy.

- `connector.prop.reserved_name_disjointness_across_layer_merge` —
  The reservation check (connector-I2) holds not only within a
  single config layer but after merging layers. A custom connector
  named `codex` in project config that doesn't collide with a
  user-global layer's connectors would still fail if the merged
  `connectors` record contained both the custom entry and the
  built-in reservation applied to the merged view.

## Cross-contract dependencies

- **step** (`src/schemas/step.ts`) — `RelayRole` is declared here
  (`z.enum(['researcher', 'implementer', 'reviewer'])`) and consumed
  by `RelayConfig.roles` and `RelayStartedTraceEntry.role`. The
  connector contract constrains how roles are consumed; the step
  contract owns role's existence. Cross-reference
  [docs/contracts/step.md](step.md) STEP-I1 for the executor/role distinction.

- **selection-policy** (`src/schemas/selection-policy.ts`) — A step's
  resolved connector and resolved selection are orthogonal dimensions
  at relay time: the connector determines WHICH executor runs; the
  selection determines WHICH model/effort/skills/invocation_options
  that executor runs WITH. They compose at relay. Both are present
  on `RelayStartedTraceEntry`.

- **trace_entry** (`src/schemas/trace-entry.ts`) — `RelayStartedTraceEntry.connector:
  ConnectorRef` and `RelayStartedTraceEntry.resolved_from:
  RelayResolutionSource`. The latter is newly promoted to a
  discriminated union in this slice (prior v0.1 drafting used a flat
  `z.enum`; the flat enum cannot identify the specific role/circuit
  that won, and an audit reading the trace_entry could not reconstruct the
  chosen connector's provenance — same gap selection.md closed at
  HIGH #1 with its discriminated-union `applied[]` entries).

- **config** (`src/schemas/config.ts`) — `RelayConfig.default`,
  `RelayConfig.roles`, `RelayConfig.circuits`, and
  `RelayConfig.connectors` all consume connector scalars. The
  reservation check (connector-I2) and closure check (connector-I8) are
  implemented in `RelayConfig.superRefine`. Config reorganization
  (layer materialization, merge semantics) is out of scope for this
  contract; see [docs/contracts/config.md](config.md) (pending Stage 1 close
  Slice 26).

- **flow** (`src/schemas/compiled-flow.ts`) — `RelayConfig.circuits`
  is keyed on `CompiledFlowId`, so flow existence is a soft
  precondition for a circuit-specific connector override. The connector
  contract does NOT enforce that every `circuits[flow_id]` key
  corresponds to an installed flow; circuit-specific overrides
  for un-installed flows are legal (they describe how to relay
  IF that flow runs).

- **ids** (`src/schemas/ids.ts`) — `CompiledFlowId` is used as a
  disambiguator in `RelayResolutionSource.circuit` variant.

## Failure modes (carried from evidence)

- `carry-forward:relay-resolution-folklore` — Prior Circuit
  conflated CLI flag, role, circuit, and default into a single
  imperative resolver function with no structured precedence record.
  Closed by connector-I7: precedence is documented, total, and the
  winning category is recorded per-relay.

- `carry-forward:connector-name-shadowing` — A custom connector named
  `codex` in the operator's user-global config file silently shadows
  the built-in `codex` in `relay.default` resolution. Closed by
  connector-I2's reservation check: connector names are disjoint from
  `EnabledConnector` enum values and the `'auto'` sentinel at parse
  time; a collision is a schema error, not a runtime divergence.

- `carry-forward:inline-custom-descriptor-scatter` — When custom
  descriptors could be inlined in roles/circuits, the same connector
  appeared in three places with three slightly-different commands
  and no single source of truth. Closed by connector-I5: custom
  descriptors MUST be registered in `relay.connectors` and
  referenced by name from roles/circuits.

- `carry-forward:relay-provenance-unaudited` — Prior Circuit
  emitted a flat `resolved_from` category enum with no
  disambiguator; an auditor reading `RelayStartedTraceEntry` could
  tell the RESOLUTION WAS from a role override but not WHICH role,
  and from a circuit override but not WHICH circuit. Closed by
  connector-I7's `RelayResolutionSource` discriminated union with
  role/flow_id disambiguators. The shape deliberately mirrors
  SEL-I7 (selection applied[] entries) so the relay and selection
  provenance surfaces stay consistent.

- `carry-forward:argv-shell-wrapping` — A custom-connector command
  ambiguously interpreted as "shell command" vs "argv vector"
  silently rewrites authored commands under `/bin/sh -c`, enabling
  shell interpolation the author did not intend. Closed by
  connector-I3: direct exec with positional `PROMPT_FILE OUTPUT_FILE`
  appended; no shell wrapping, no `${VAR}` expansion, no `cmd ; cmd`
  splitting.

- `carry-forward:empty-argv-element-silent-noop` — `command: ['']`
  or `command: ['codex', '']` parsed under v0.0 drafting because
  `z.array(z.string()).min(1)` does not constrain element content.
  An empty argv element is either a bug (authored nothing) or a
  silent gotcha (shell would drop it; `execve` does not).
  Closed by connector-I3's element-level `.min(1)`.

- `carry-forward:surplus-key-silent-strip-relay` — Prior to this
  slice, `RelayConfigBody` was not `.strict()`. An authorial typo
  in `relay.adpaters` (transposition) was silently stripped and
  the intended custom-connector registry was empty, resulting in a
  registry-closure failure pointed at a named reference that
  "did not exist" (it did — the author spelled it right in the
  reference, wrong in the key). Closed by connector-I9's transitive
  `.strict()`.

## Evolution

- **v0.2 (local worker lane slice, 2026-06-11)** — additive: the custom
  connector subprocess environment gains the `CIRCUIT_RELAY_MODEL` /
  `CIRCUIT_RELAY_MODEL_PROVIDER` / `CIRCUIT_RELAY_EFFORT` projection of
  the relay's resolved selection (`selectionEnv` in
  `src/connectors/custom.ts`). The authored argv contract is unchanged;
  connectors that ignore the variables behave exactly as before. This is
  the engine half of the local worker lane (power tiers driving an
  OpenCode/Ollama wrapper); the wrapper half is operator config,
  documented in `docs/configuration.md`.

- **v0.1 (this draft)** — connector-I1..I11 enforced at the schema layer.
  **Codex adversarial property-auditor pass 2026-04-19** produced
  opening verdict REJECT with 5 HIGH + 3 MED + 1 LOW. All 5 HIGH + all
  3 MED + the 1 LOW folded in directly before commit (no deferrals to
  v0.2 except where the deferral itself is named as the resolution —
  MED #6 default-layer provenance and connector-I3's cwd/env semantics).

  Schema-level landings for this slice:
  - `ConnectorName` regex already in place; no change.
  - `CustomConnectorDescriptor.command` tightened to
    `z.array(z.string().min(1)).min(1)` (element-level `.min(1)` added).
  - `ConnectorReference` in `config.ts` promoted from `z.union` to
    `z.discriminatedUnion` with per-variant `.strict()` AND **exported**
    (Codex MED #8 fold-in).
  - `RelayConfigBody` gets `.strict()`.
  - `RelayConfig.superRefine` extended with: reserved-name
    disjointness check (`connectors` key MUST NOT be a `EnabledConnector`
    or `'auto'`); own-property-only closure checks using
    `new Set(Object.keys(...))` — fixes the `constructor`/`toString`/
    `hasOwnProperty` bypass via prototype chain (Codex HIGH #3);
    registry-key ↔ descriptor-name parity check (connector-I11 / Codex
    HIGH #2).
  - `RelayResolutionSource` added to `src/schemas/connector.ts` as a
    5-variant discriminated union; `RelayStartedTraceEntry.resolved_from`
    in `src/schemas/trace-entry.ts` retyped from `z.enum([...])` to
    `RelayResolutionSource`.
  - `ResolvedConnector` added to `src/schemas/connector.ts` as a 2-variant
    discriminated union (built-in + custom descriptor);
    `RelayStartedTraceEntry.connector` in `src/schemas/trace-entry.ts` retyped
    from `ConnectorRef` (which admits named references) to
    `ResolvedConnector` — named references are pre-resolution pointers
    and MUST NOT appear in the trace (connector-I10 / Codex HIGH #1).
  - `TraceEntry` discriminated union wrapped in a cross-variant `superRefine`
    enforcing the `role === resolved_from.role` binding when
    `resolved_from.source === 'role'` (connector-I7 binding clause /
    Codex HIGH #4). Mirrors the `Step` union's pattern for cross-
    field constraints.
  - Prose tightenings: post-condition for `RelayStartedTraceEntry`
    explicitly scopes `connector`↔`resolved_from` agreement to Stage 2
    (Codex HIGH #5 honesty fold-in); `{source: 'default'}`,
    `{source: 'explicit'}`, and `{source: 'auto'}` are explicitly
    singleton-at-v0.1 with v0.2 revisit rationale (Codex MED #6);
    auto-rationale claim removed from connector-I7 (Codex MED #7 — the
    auto variant carries no rationale field, and the test suite
    rejects surplus keys on it, so the original prose claim was
    self-contradictory); cwd/env/path semantics explicitly deferred
    to Stage 2 with property-id tags (Codex LOW #9).

- **v0.2 (Stage 1)** — Ratify `property_ids` above by landing the
  corresponding property-test harness at
  `tests/properties/visible/connector/`. Decide whether
  `RelayResolutionSource.explicit` should carry the literal
  `--connector` CLI arg text for post-hoc flag reproduction (would add
  `{source: 'explicit', argv: string[]}` — currently deferred because
  the flag text is recoverable from the invocation trace_entry elsewhere).
  Decide whether `relay.default` should admit a full
  `CustomConnectorDescriptor` inline (currently it accepts only a string
  name → BuiltIn/registered ConnectorName). Precedent from connector-I5
  suggests "no, register it first"; v0.2 will reconfirm with evidence
  from real flows.

- **v1.0 (Stage 2)** — Ratified invariants + property tests +
  relay-resolution implementation with `connector.prop.*` as
  acceptance check + the auto-detect heuristic formalized (Stage 2
  decides what `'auto'` does).
