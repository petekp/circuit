# ponytrail (0xroylee) vs Circuit

Status: current comparison note. Not a plan, not current behavior.
Date: 2026-06-22

Captured from an analysis of [github.com/0xroylee/ponytrail](https://github.com/0xroylee/ponytrail)
(v0.0.1-beta.0). The prompt was "compare/contrast it with Circuit and note
anything we could learn from it." This note records that analysis, dimension by
dimension, with every "Circuit could learn X" claim checked against Circuit's
real source before it was kept.

The verdict in one line: ponytrail is not a threat and barely overlaps Circuit on
the axis Circuit cares about most (it has no flow composition, no generation, no
block vocabulary, and its headline governance feature is a stub that certifies
nothing), so read it as validation plus a small idea source. Of 21 verified
"could learn" claims, 16 held as genuinely additive and 5 were refuted because
Circuit already has the capability, usually ahead of ponytrail.

Method note: this analysis was produced by a fan-out workflow that read both
codebases from real source (ponytrail from raw GitHub, Circuit from local `src/`)
per dimension, synthesized a compare/contrast, then ran an adversarial pass that
tried to refute every learning against actual code. The "did not survive" section
is that refutation pass working as intended.

Related, read first:
- [`adversarial-verification-gates.md`](./adversarial-verification-gates.md) owns
  the refute-threshold gate idea this note recommends building (ponytrail's vote
  tally is the inspiration, not the design).
- [`bespoke-flow-generation-design.md`](./bespoke-flow-generation-design.md) and
  [`north-star-status.md`](north-star-status.md) own the composition/generation
  lead that ponytrail does not contest.
- [`intent-capture-and-enforcement.md`](./intent-capture-and-enforcement.md) owns
  Circuit's scope/guardrail enforcement, which a scope-drift veto would extend.
- [`fallible-executor-audit.md`](./fallible-executor-audit.md) and the
  durability specs own the trace/recovery story the snapshot/revert comparison
  leans on.
- Sibling comparisons: [`recall-vs-circuit-continuity.md`](./recall-vs-circuit-continuity.md),
  [`supermemory-harness-memory-vs-circuit.md`](./supermemory-harness-memory-vs-circuit.md),
  [`smithers-circuit-comparison.md`](./smithers-circuit-comparison.md).

## What ponytrail is

Ponytrail presents two faces. The public-facing one is a snapshot/revert skill: a
bundled agent skill that wraps every file mutation in a two-phase ritual. Before
any create/edit/move/delete the agent records a PRE snapshot (action, purpose,
reason, files, expected outcome, verify command, rollback path) and afterward a
POST snapshot (summary, checks, result). It copies the touched file's bytes into a
store (under a 1 MiB limit) and writes a human-readable per-session commit tree.
It is explicit that snapshots complement git rather than replace it: git is the
preferred revert mechanism, snapshots tell you why and what to revert.

The deeper face, documented in `AGENTS.md` and `docs/architecture.md` but undersold
in the README, is a "requirement-first" gating runtime. No worker agent (Codex,
Claude, or GitHub Copilot CLI) may execute until a raw human request passes a fixed
pipeline: a brainstorm gate that blocks vague requests, drafting the request into a
goal contract, a 4-bot "requirement court" (Product, Project, Engineer, Testing)
that discusses and votes, a non-voting Judge that tallies a fixed 3-of-4 threshold,
and a mandatory human lock. The whole thing is declared in a Zod-validated manifest,
so thresholds and voters are config, not code. The important caveat: the shipped
court is deterministic stub plumbing today. Every bot auto-approves at confidence
0.8, so the 3-of-4 vote always trivially passes, and the gate predicates
(`mayStartWhen` / `mustStopWhen`) are honor-system strings nothing parses. The
gating structure exists; the deliberation does not. The worker-execution subsystem
(the CLI adapters) is also built but not wired: the CLI gates worker execution and
`--worker` is accepted as a no-op "for compatibility."

## The core philosophical contrast

Ponytrail and Circuit answer different questions. Ponytrail asks "should this work
be allowed to start, and is the human in the loop before it does?" It is a
pre-execution, human-gated requirement court sitting in front of one fixed pipeline
that is identical for a typo fix and a multi-system refactor. Circuit asks "what
shape of work does this task need, and how do I build and run that shape safely?"
It composes task-fitted flows from a block vocabulary, picks topology (linear,
loop, sub-run, fanout) and per-block tool scope, and enforces its gates during and
after execution with engine-evaluated predicates backed by ground truth (git diff,
proof-command exit status). Ponytrail's strength is governance-before-work;
Circuit's strength is genuine task-fitted generation plus deterministic
after-the-fact enforcement.

## Dimension by dimension

| Dimension | Ponytrail | Circuit | Verdict |
|---|---|---|---|
| Pre-execution gating | 4-bot requirement court + 3-of-4 vote + hard human lock, all pre-execution. But court is a stub (all bots auto-approve at 0.8); gate predicates are strings nothing parses. | Gates fire during/after execution: relay verdict membership, deterministic verification, close-stage scope + git-proven touch-area gates. One soft pre-execution checkpoint (Build frame-step) that auto-resolves by default. Engine-enforced, not strings. | Different timing; Circuit's enforcement is real, ponytrail's pre-execution court is theater today. Ponytrail genuinely ahead on the hard-human-lock concept. |
| Audit trail + revert | Per-file PRE/POST snapshots with byte copies as a real revert source; working `revert` command in TS. Two divergent producers, plain appendFile, no torn-line tolerance, can log a rollback it cannot perform. | Single durable trace (TraceStore): contiguous sequence numbers, torn-line heal, atomic writes, result regeneration. Fix and Build capture per-file git fingerprints (no byte copies). `safe_apply` is spec-only with no executor; no revert command shipped. | Circuit far ahead on durability; ponytrail ahead on an actual revert source and a shipped revert command. |
| Multi-host worker orchestration | Thin adapter pattern: Claude + Codex + Copilot. But the entire subsystem is gated dead code, never invoked. | Live runtime connector seam (claude-code, codex, cursor-agent, custom escape hatch); compile-time exhaustive dispatch; byte caps, SIGKILL on timeout, `--tools` enforcement. No Copilot. | Circuit decisively ahead (wired vs inert, real governance). Ponytrail covers one host Circuit doesn't. |
| Config model & boundary | One self-validating manifest; lenient self-healing read path (upgrades legacy shapes), strict write. Free-string gate predicates; duplicated rules can drift. | Layered config (default → user-global → project → invocation) + code-level catalog the engine derives everything from. Strict on read and write; typed dot-paths; v1→v2 config migration exists. No upgrade path for persisted run/checkpoint envelopes. | Roughly even, different shapes. Circuit ahead on boundary discipline; ponytrail ahead on self-healing reads. |
| Safety & quality gates | 90% line-coverage floor; npm dependency-recency quarantine (block packages < 30 days old); policy codified in AGENTS.md. | Broad CI verify chain (drift, parity, public-claims, proof-coverage, schema, doc-path) + eval-cadence freshness gate. No coverage threshold, no supply-chain freshness gate, no dependency policy in AGENTS.md. | Circuit's pipeline is broader and release-aware; ponytrail has two concrete defenses Circuit lacks (recency, coverage floor). |
| Flow composition & generation | None. One hardcoded pipeline for every request; the "AI work" steps are deterministic TypeScript. | Genuine block-by-block composition (`circuit generate`): a model proposes a role set, an offline floor verifies, up to 4 verifier-steered repair rounds; four topologies; per-block equipment axis with live `--tools` enforcement. | Circuit decisively ahead. Ponytrail does not compete on this axis. |

## What Circuit could genuinely learn

Only learnings that survived the adversarial refutation pass. Ranked roughly by
value-to-effort.

### High leverage

**Wire the `safe_apply` executor (and retire the orphan risk-rollback-check).**
Circuit has done the hard design work (a guarded-apply contract with
base_mismatch / apply_conflict / touched_files_mismatch reason codes and a
`safe_apply_reject` recovery route) but it is inert: `safe_apply` appears only in
schemas, policy tables, connector classification, and read-side history; no
executor performs apply/reject and nothing emits a `safe_apply.result` trace entry.
Ponytrail ships working file-mutation revert logic (cp to restore, rm to delete,
`assertInside` for path safety). Adopt ponytrail's snapshot-restore plus
path-containment pattern as the file-mutation model, keep Circuit's richer
base_ref / base_mismatch guard as the contract layer ponytrail lacks. Note for
accuracy: ponytrail has no "base_ref check" of its own; that is Circuit's
vocabulary. Single highest-leverage gap. Effort: high. Value: high.

**Ship a refute-threshold fanout join policy.** Circuit's `FanoutJoinPolicy` is a
closed four-member union (pick-winner, disjoint-merge, aggregate-only,
aggregate-survivors); none counts votes or refutations against a declared
threshold. A refute-threshold policy is an explicitly unbuilt idea in
[`adversarial-verification-gates.md`](./adversarial-verification-gates.md), which
even names the change sites (a new union member in `check.ts` plus a branch under
the `assertNever` guard in `policy/fanout-join-policy.ts`). Ponytrail's
`tallyVotes` is the inspiration (approve count ≥ requiredApprovals, with
voter-membership and duplicate-vote enforcement), but be precise: ponytrail's is a
pre-execution approval gate, not a fanout join. Ship it as a net-new Circuit
mechanism (a plural reviewer panel passes only when fewer than K refutations land),
inspired by, not copied from, ponytrail. Directly attacks Circuit's acknowledged
weakness: the worker that does the work also certifies it. Effort: high. Value:
high.

### Solid, lower cost

**Make the human checkpoint a real, configurable hard lock for high-stakes runs.**
Circuit's only pre-execution human gate (`resolveCheckpoint`) parks for a human
only when not autonomous, not unattended, and depth is high or tournament. At
default/medium it auto-resolves and never waits, and there is no
`require_human_lock` / always-park option. Ponytrail mandates a two-stage lock
(court-approved AND human-approved) before any worker starts. Circuit already has
the waiting machinery; the additive move is a per-flow/per-run flag that forces
parking at the frame step regardless of depth for irreversible or
production-touching work. It should resolve to the declared `safe_default_choice`
and fail loudly if none is declared, not auto-continue. Effort: low. Value:
medium.

**Add a dependency-recency quarantine gate.** Circuit has zero supply-chain
freshness defense: no dependabot, no renovate, no `npm audit`, no registry query
anywhere. Ponytrail blocks any npm package published less than 30 days ago, with
the pure logic in `dependency-recency.ts` (`evaluatePackageRecency`, ageDays) and
the registry fetch plus `process.exit(1)` in a thin IO shell. Circuit can mirror
its own `scripts/release/eval-cadence.ts` split (pure decision fn + readers +
composer) and wire it into `verify`. Circuit ships a plugin others install and that
itself orchestrates agent installs, so the asymmetric supply-chain risk is real,
and the tiny direct-dep surface (commander/yaml/zod) makes this cheap and
low-false-positive. Effort: medium. Value: medium.

**Codify the dependency/supply-chain policy as a hard rule in AGENTS.md.**
Ponytrail enforces its recency rule on two levels: mechanical (script + exit 1) and
social (a verbatim hard rule plus a human-gated override). Circuit's AGENTS.md
covers verify/flow-authoring discipline but says nothing about dependency
additions. Pairs with the recency gate above; cheap defense-in-depth. Effort: low.
Value: medium.

**Decide coverage posture per-area instead of blanket no-threshold.** Circuit runs
coverage info-only by deliberate methodology-strip stance, with no per-glob
thresholds. Keep that default globally, but add a narrow branch-coverage floor on
the highest-stakes pure modules (the composer/relay and the release gates
themselves) using vitest's per-glob `thresholds`. Require branch coverage, not just
lines, to avoid ponytrail's own weakness (line-only parsing that vacuously passes
empty LCOV). Effort: low. Value: medium.

**Add a lenient self-healing read path for project config.** Circuit's
config-loader is strict on both ends: it always `Config.parse(raw)` and throws on
any failure. Zod `.default()` fills absent fields, but nothing repairs
present-but-wrong values or sniffs a legacy shape. Ponytrail's
`upgradeManifestInput` repairs legacy shapes on read while keeping writes strict.
The day Circuit ships a schema_version 2 config or renames a field, every on-disk
`.circuit/config.yaml` will hard-fail rather than self-heal. Caveat: Circuit's
config is hand-authored and the engine never writes it programmatically, so the win
concentrates on the read path. Effort: medium. Value: medium.

**Add a scope-drift veto / amendment policy as a flow primitive.** Circuit captures
non_goals/invariants but enforces them only at review-time and close-stage, after
the implementer finishes. `scope_drift` exists as a declared recovery
failure-cause slot and a goal-flow reason, but there is no runtime detector that
classifies a live failure as scope drift, no amendment policy, no `/amend-goal`, no
mid-run halt. Ponytrail makes scope change a first-class gated event
(`amendmentPolicy` + a worker-halting `mustStopWhen`). The additive work is the
live in-flow detector + halt route on the implementer step, activating the
already-declared-but-unused `scope_drift` cause. This is the behavioral analog of
the tool allow-list: equipment restricts what tools a step uses, scope-drift
restricts whether the work stays in scope. Effort: medium. Value: medium.

**Add a guarded-edit baseline that stores byte copies, not just a git fingerprint.**
Circuit's edit-snapshots (Fix and Build both call `src/shared/git-state.ts`) store
only head_sha + per-path git OID fingerprints: nothing restorable, and they
hard-require git. Ponytrail copies the actual bytes (under a size limit) so the
snapshot is a git-independent revert source. The technique already exists in
Circuit for a different artifact: `manifest-snapshot.ts` stores `bytes_base64` of
the flow manifest. So the work is to apply that existing pattern to edited source
files, guarded by a size limit, reusing the atomic stage+rename so the copy store
is itself crash-safe. This gives the long-spec'd `safe_apply` executor a concrete
prior-state to apply against. Effort: medium. Value: medium.

**Ship a revert/rollback action on the surface the agent actually uses.**
Ponytrail's cautionary split-brain: a working `revert` command exists in TS, but
the skill/hook never call it and instead tell the agent to use git. Circuit is in
the same end-state for a different reason: recovery is graph re-routing only, and
`src/commands/` has create/generate/handoff/run/uninstall with no revert/undo. Even
before a full `safe_apply` executor, Circuit could expose a minimal git-driven
revert (back to the Fix baseline HEAD, discard the recorded change-set the
projection already computes). Learn from ponytrail's mistake: put the action on the
surface the operator is told to use. Effort: medium. Value: medium.

**Add GitHub Copilot CLI support.** Circuit's `EnabledConnector` enum is closed to
claude-code | codex | cursor-agent; zero `copilot` hits across all shipping
surfaces. The custom-connector escape hatch does not close the gap (V1 custom is
forced read-only, tool_scope none, prompt-file only, no argument-mode goal
injection). Because `BUILTIN_CONNECTOR_RELAYERS` and `BUILTIN_CONNECTOR_SPECS` both
use `satisfies Record<EnabledConnector, ...>`, adding the enum member forces
matching spec + relayer entries at compile time. Open question that caps the value:
whether `gh copilot suggest` produces machine-parseable structured output (it is
suggest-oriented/interactive). Effort: medium. Value: medium.

### Smaller / lower value

**Co-locate per-edit decision intent at edit granularity.** Circuit captures intent
richly at step/flow granularity (`guidance.decision`) and per-file fingerprints in
both Fix and Build, but not a per-edit, co-located, mandatory
purpose/reason/expected/verify record. A lightweight per-edit intent record
threaded onto the existing trace would tighten the why/what-to-revert story. Keep
it opt-in per flow to avoid the ceremony tax ponytrail itself flags. Effort:
medium. Value: medium.

**Unify the per-host skill/hook installer.** Circuit already has an idempotent
hook-merge installer (`handoff-codex-hooks.ts`, arguably more mature than
ponytrail's, with backup + doctor + install-assurance) and a declarative per-host
surface emit. But the two mechanisms are separate, hook-merge is codex-only, and
there is no copilot/cursor install target. The additive work is unification into a
single per-host target map + broader host coverage, not a wholly-missing
capability. Effort: medium. Value: medium.

**Add an upgrader for persisted run/checkpoint/trace envelopes.** Circuit already
auto-migrates legacy config (v1→v2 via `projectConfigV1ToPolicyEnvelopeV2`,
fail-open by design). What it lacks is the same for persisted run-state:
checkpoint-resume and run-folder do hard `schema_version !== 1` rejects, history
throws on mismatch. The opportunity is narrower than it first looks: an upgrader for
run-state shapes, not config. Effort: low. Value: low.

**Convention-over-config routing by executable basename.** Ponytrail resolves an
adapter from the basename of a command's first token. Circuit's custom connector
routes purely by operator-declared name; nothing recognizes that a declared
command's executable matches a known built-in. A small ergonomic win: route a
custom command whose basename matches `claude`/`codex` to the governed built-in
relayer (with its tool-scope and argv boundary) instead of the read-only custom
path. Match on full identity, not just basename (ponytrail itself flags the `npx`
collision risk). Effort: low. Value: low.

**Logical-model alias table.** To answer "which model does the reviewer use and how
do I swap it," Circuit traces ROLE_POWER_ALLOCATION → tier → power_tiers, or sets a
SelectionOverride at one of seven layers. There is no single named-model rebind
point. Ponytrail's `provider:'configurable'` + logical names give one. Circuit's
spread is partly deliberate (durable aliases + auto-clamp prevent model rot) and the
connector layer already decouples the vendor cleanly, so this is an operator-facing
ergonomic simplification, not a capability gap. Effort: high. Value: low.

## Claims that did not survive verification

Five "Circuit could learn" claims were checked against real code and rejected,
because Circuit already has the capability, often ahead of ponytrail:

- **Request-quality / clarification gate.** Circuit already ships a `clarify` block
  with allowed routes continue/ask/stop and a Zod-enforced gate; the goal flow opens
  with it, and its output schema carries ponytrail's exact fields (desired_outcome,
  proof_needed, in/out bounds, structured missing_information). Real but narrow
  residual: the clarify wiring is internal to the goal flow, and there is no cheap
  deterministic lexical pre-filter on raw intent before the model call.
- **Per-reviewer rubrics.** Circuit already has per-step, per-flow reviewer rubrics
  rendered into the reviewer relay prompt via relay shape hints keyed on each
  reviewer step's output schema (Fix, Build, Explore relay-hints). It even names the
  same failure mode ponytrail does (evidence passes while the request stays unmet).
  The only delta is cosmetic: ponytrail splits into named approval vs reject arrays;
  Circuit folds both into one prose hint.
- **Concurrent drain pattern to avoid deadlock.** Circuit's
  `runConnectorSubprocess` registers both stdout and stderr data handlers up front,
  so libuv drains both pipes concurrently. `appendCapped` is fully synchronous and
  the byte cap discards overflow rather than pausing. The two-pipe deadlock requires
  blocking sequential reads, which Circuit never does. Already deadlock-immune.
- **Append-only evidence ledger with `mustStopWhen`.** Circuit already has the
  machine-checkable equivalent and is ahead: per-step declared stop/route contracts,
  mid-run `detectNoProgress` wired into the continuation loop, an enforced
  equipment-scope leak guard that fails the relay closed on an out-of-list tool, and
  an append-only trace. Ponytrail's `mustStopWhen` is declared-but-unenforced prose
  rendered to an LLM; no source file reads or evaluates it.
- **Optional human-confirm block.** Circuit already ships this as the `checkpoint`
  block/execution-kind, with a runtime executor, a `human_interaction: required`
  block class, the composition proposer already offering "frame / checkpoint", an
  operator-park inbox, and `circuit resume --checkpoint-choice`. Only a targeted
  refinement remains (teach the generate proposer to insert a checkpoint before a
  high-blast-radius act step with auto-resolve off).

## Where Circuit is clearly ahead

- **Flow composition and genuine generation.** The decisive lead. `circuit
  generate` asks a model to propose a CompositionRoleSet, runs an offline floor
  (compose → validity → runnability), and feeds the verifier's exact error strings
  back for up to 4 bounded repair rounds. Four genuinely distinct topologies run
  end to end. The block menu is derived from the live catalog, so new families
  become composable for free. Ponytrail runs one hardcoded pipeline whose "court
  discussion" and "votes" are string interpolation that structurally cannot reject.
- **Per-block equipment axis with live enforcement.** Circuit scopes each worker
  step to a closed tool profile and can hard-enforce it (`resolveEquipmentEnforcement`
  → relay → claude-code passes `--tools` AND post-hoc verifies no out-of-list tool
  was used, honestly downgrading to trusted when a connector can't restrict).
  Ponytrail has zero per-step tool scoping. A category Circuit owns outright.
- **Engine-enforced gates over honor-system strings.** Ponytrail's `mayStartWhen` /
  `mustStopWhen` are human-readable strings nothing parses. Circuit's gates are real
  executable predicates the engine evaluates. A gate that is only a string is intent,
  not control. Worth defending so Circuit doesn't drift toward declarative-only
  predicates when borrowing ponytrail's manifest style.
- **Durable trace authority.** One TraceStore with serialized appends, contiguous
  sequence numbers, a single discriminated-union schema, torn-trailing-line heal
  with byte-offset accounting, atomic stage+validate+rename writes, and result.json
  regeneration. Ponytrail has two divergent producers writing the same JSONL with no
  locking, no atomic write, and no torn-line tolerance.
- **Subprocess governance and compile-time exhaustiveness.** Byte caps,
  SIGTERM→SIGKILL process-group kill on timeout, `--tools` allow-list with a
  parse-time leak guard, and a codex spawn-argv boundary. The connector seam is the
  live runtime path, not gated dead code, and adding a provider is a
  compiler-enforced change.
- **Release-aware verify pipeline + eval-cadence freshness gate.**
  Generated-surface drift, parity, public-claims, proof-coverage,
  marketplace-safe-paths, schema and doc-path checks, all CI-enforced. The
  eval-cadence gate blocks a release whose efficacy/cost numbers are stale relative
  to the code, with a committed single-use waiver that cannot carry forward.
- **Catalog boundary discipline.** The engine derives every registry from one
  `flowPackages` array and imports no flow module directly (verified: zero
  flow-folder imports across `src/runtime/` and `src/cli/`). Worth hardening into a
  CI grep ratchet so a future engine edit that imports a flow folder fails the
  build, not just review.

## Bottom line

Ponytrail is not a threat to Circuit and barely overlaps it on the dimension
Circuit cares about most. It has no flow composition, no generation, no block
vocabulary, and no per-step equipment axis, and its headline governance feature
(the requirement court) is a stub that certifies nothing. It is best read as
validation plus a modest idea source. Validation, because its honest framing
(snapshots complement git, not replace it; capability-control before worker
execution) lands on the same instincts Circuit already implements more rigorously.
Idea source, because two concrete defenses are genuinely missing in Circuit and
cheap to adopt (a dependency-recency quarantine gate and a real revert source /
executor), and a handful of governance primitives (a configurable hard human lock,
a refute-threshold join, a scope-drift veto) are worth building as net-new Circuit
mechanisms rather than copies. The practical takeaway is narrow: finish the inert
`safe_apply`/revert path and add the supply-chain gate, and keep leaning on the
composition + equipment + durable-trace lead that ponytrail does not contest.
