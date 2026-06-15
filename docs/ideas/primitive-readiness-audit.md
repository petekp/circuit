# Primitive-readiness audit: the six substrate primitives at M5

> Superseded — grounded in the pre-M6 (M5) codebase; M6–M9 have since landed (uniform composed runtime, the block-to-schematic assembler, the typed routing seam, fail-closed checkpoints), so several primitives marked missing/partial here are now present. Refresh before relying on this.

> Written 2026-06-14. This is **B2** of the E1 backlog (see
> [`e1-implementation-brief.md`](e1-implementation-brief.md)). It grounds the
> six-primitive substrate analysis from
> [`exploration-substrate-two-track-plan.md`](exploration-substrate-two-track-plan.md)
> in the *current* codebase, so the next experiments (E2 onward) are scoped
> against what actually exists rather than against a plan. Read-only: this audit
> touches no `src/`. For each primitive it answers three questions: what
> implements it today (with file:line), what is still missing, and which
> track/gate it sits on.

## What "current" means here

This audit reads the worktree at branch `exp/e1-variant-harness`, based on
`c0f2619a` (composition milestone **M5**). What has landed:

- **M1** — route-conditional input availability (`303de751`).
- **M2/M3** — declaration-aware legibility; build/prototype engine flags rehomed
  onto the manifest.
- **M4** — the by-id flow package dissolved; `findCompiledFlowPackageById` is
  gone and the compiled manifest is the sole authority (`d4058992`).
- **M5** — the catalog check flipped to a fail-closed compile gate (`c0f2619a`).

What has **not** landed (and several gaps below depend on these): **M6** (collapse
data/schematic), **M7** (the assembler), **M8** (typed Zod seam + anti-widening
gate), **M9** (composed runtime). The migration is mutating `src/` concurrently
on its own branch, so re-check a citation before acting on it; line numbers are
accurate as of M5 on this branch.

## Readiness at a glance

| # | Primitive | Track / gate | Readiness | Anchor in code | The gap in one line |
|---|---|---|---|---|---|
| 1 | self-similar unit (flow = composite harness) | Track B, gated on M4 | **partial** | `src/runtime/executors/sub-run.ts`, `src/runtime/run/binding-legibility.ts:85` | sub-runs invoke a child flow, but a flow is not yet substitutable for a *leaf step* |
| 2 | typed + enforced seam | **is** M5 (enforce) + M8 (type) | **half** | `src/flows/compile-schematic-to-flow.ts:703` | enforcement landed; payload bodies are still string-named, not typed |
| 3a | context envelope | M1, already shipped | **done (narrow)** | `src/schemas/flow-schematic.ts:194,848` | availability is proven, but path-specific producer binding is not |
| 3b | equipment scope | Track B, start now | **absent** | nearest: `src/schemas/step.ts:19` (`RelayRole`) | no declared per-step tool/read kit; only a 3-value role |
| 4 | legible composition surface + repair edges | Track B, partial M7 | **partial** | `src/schemas/recovery-route-kind.ts:5`, `src/schemas/flow-schematic.ts` | structure is authorable-by-hand; arrangement and repair are not composition-as-data |
| 5 | isolation / change-packets | Track B, start now | **half** | `src/runtime/fanout/worktree.ts:4` | worktree isolation is real; change-packets + disjoint-apply join are not built |
| 6 | commensurable traces | Track B, mostly exists | **mostly done** | `src/schemas/result.ts:40`, `src/schemas/operator-summary.ts:104` | shared schemas exist; cost meter is best-effort (`partial` honesty bit) |

The shape of the answer: three primitives (3a, 5, 6) are at or near ready and are
exactly the three E1 already exercised end to end. Two (1, 4) are genuinely
gated on the spine (M4 landed for 1; M7 still open for 4). One (2) is half-built
by construction: M5 gave it teeth, M8 will give it types. One (3b) does not exist
yet and is the cleanest start-now build.

---

## Primitive 1 — self-similar unit (flow = composite harness)

**The claim.** A built-in flow, a composed flow, and a nested sub-tree should be
the same kind of thing, so recursion is uniform instead of a hand-authored
special case. M4 (dissolving the by-id lookup) was its precondition.

**What implements it today.**

- The unit is the compiled manifest. Post-M4 the runtime resolves a flow's
  behavior from the manifest itself, not a catalog lookup:
  `src/runtime/run/binding-legibility.ts:85` states it outright ("Post-M4 the
  compiled manifest is the sole authority"). `findCompiledFlowPackageById` is
  deleted (grep: zero hits in `src/`).
- A flow can already invoke *another whole flow* as a step. The `sub-run`
  execution kind resolves a child flow through
  `context.childCompiledFlowResolver` (`src/runtime/executors/sub-run.ts:112-129`),
  runs it to its own `result.json`, and checks the child's `verdict` against the
  parent step's `check.pass`. That is real recursion: a parent step whose body is
  an entire child run.
- The compiled-flow shape is one schema (`CompiledFlow`, `schema_version` 3) in
  `src/schemas/compiled-flow.ts`, and the authored shape is `FlowSchematic` in
  `src/schemas/flow-schematic.ts`. Both built-ins and any future composed flow
  pass through the same compiler.

**What is still missing.**

- A flow is invocable as a *child run* (sub-run) but not yet substitutable for a
  *leaf step*. There is no composition primitive that says "this step's body is
  sub-tree X" and treats X exactly as it would treat a single relay. The two are
  different code paths, so "flow = composite harness" is true for the run-a-child
  case and not yet for the inline-subtree case.
- No authoring surface for composed flows. Built-ins are hardcoded in
  `src/flows/catalog.ts`; there is no command or assembler that emits a new
  manifest from parts. That is M7/M9 territory.

**Track / gate.** Track B, gated on M4 (landed). The remaining work (true
leaf-substitutability) is E3 and waits on M7's assembler to be worth doing.

---

## Primitive 2 — typed + enforced seam

**The claim.** The seam between composed units should carry real typed payload
bodies *and* be enforced fail-closed. Per the analysis, this primitive **is** M5
(enforcement) plus M8 (typing).

**What implements it today — the enforced half (M5, landed).**

- `compileSchematicToCompiledFlow` (`src/flows/compile-schematic-to-flow.ts:703`)
  opens with the fail-closed catalog gate: it calls `collectSchematicCatalogIssues`
  *before any framing*, and on any issue it `fail()`s with the precise mismatch.
  The header comment makes the intent explicit ("here it is enforced"). This is
  what stops a catalog-incompatible composed flow from ever compiling.
- The validator behind the gate is
  `validateFlowSchematicCatalogCompatibility` in `src/schemas/flow-schematic.ts`,
  checking block existence, route allowance, input/output contract compatibility,
  evidence requirements, and execution-kind fit.

**What implements it today — the typed half (M8, NOT landed).**

- Seam payloads are referenced by *name*, not validated by *body*. A step's
  `input` is `z.record(..., FlowContractRef)` where the ref is a string like
  `goal.recovery@v1` (`src/schemas/flow-schematic.ts:184` region). There is no
  Zod body schema asserting the shape of that payload.
- The engine ships only a tiny set of built-in report-body schemas:
  `BUILTIN_REPORT_SCHEMAS` (`src/schemas/builtin-report-schemas.ts:48`) is a
  frozen record of just `runtime-proof-canonical@v1`, `runtime-proof-strict@v1`,
  and `fanout-aggregate@v1`. The abstract routing contracts that flows actually
  pass across seams have no registered body schema.

**What is still missing.** The typed payload bodies, a runtime check that a read's
consumed body matches its declared schema, and the anti-widening gate that M8 owes
(so one generic contract id cannot alias two structurally divergent bodies). Until
then E1-style findings are name-matched and must be labeled shape-finding, per the
two-track plan's "no production claims before M5/M8."

**Track / gate.** This primitive *is* the spine at this seam: M5 is done, M8 is
the remaining half. E5 consumes it.

---

## Primitive 3a — context envelope

**The claim.** The set of contracts available at each step, narrowed by route. The
analysis marks this **done** via M1.

**What implements it today.**

- A step declares which reads it tolerates being absent via
  `optional_inputs` (`src/schemas/flow-schematic.ts:194`), validated to name real
  input keys at lines 252-257.
- Availability is computed two ways over the route graph:
  `collectRouteAwareAvailability` (intersection, line 848) for required inputs and
  `collectRouteAwareAvailabilityUnion` (union, line 892) for optional inputs. The
  validator at line 1039 onward enforces that required reads are present on *every*
  reaching path and optional reads are present on *at least one*.
- Real use: `goal-close` declares `optional_inputs: ['recovery', 'gate']` because
  the recovery payload exists only on the failure branch and the gate payload only
  on its own branch.

**What is still missing.**

- The check proves a contract is produced *somewhere reachable*; it does not prove
  the compiled producer binding reaches the consumer on *its specific* path. The
  known case: `goal-close` reads `goal.recovery@v1`, produced only on the failure
  branch, and the success path tolerates the missing file silently. A
  path-specific binding-correctness gate is unscheduled.
- Availability is route-aware for inputs but not for evidence: there is no
  `optional_evidence`, so route-disjoint evidence generation has no clean
  declaration.

**Track / gate.** Already shipped (M1). Genuinely done for the narrow job of input
availability; the binding-correctness refinement is a separate, later gate.

---

## Primitive 3b — equipment scope

**The claim.** A per-harness "kit": the declared, enforced set of tools and reads a
worker is given. The analysis says this is **not on the migration line** and should
be started now. The audit confirms it does not exist yet.

**What exists in the neighborhood.**

- The closest declaration is the relay's role: `RelayRole` is a three-value enum
  (`researcher | implementer | reviewer`) at `src/schemas/step.ts:19`, attached to
  a step as `role: RelayRole` (line 177). A role is a coarse identity, not a tool
  or read list.
- Skill availability is handled *after the fact* by skill-hooks, surfaced as
  outcomes (`injected_skills`, `withheld_skills`, `unavailable_skills`) in
  `src/schemas/operator-summary.ts` rather than as a pre-declared boundary.

**What is still missing (i.e., the whole primitive).**

- No first-class `equipment_scope` / `kit` / `allowed_tools` / read-list field on
  any step or role. Grep for `equipment_scope|allowed_tools|tool_list` across
  `src/` returns nothing.
- No write-tier enforcement of such a scope, and nothing to compare a declared kit
  against what a worker actually used.
- E1 *fakes* this dial today only as the difference between two whole flows (`fix`
  = wide; `build --depth high` = the act/verify split). The crude per-harness dial
  the two-track plan describes (hand-set reads + a per-harness tool list) is not
  expressible as data yet.

**Track / gate.** Track B, start now. This is the cleanest additive build and the
direct subject of the B3 spec
[`e2-equipment-scope-spec.md`](e2-equipment-scope-spec.md): author it
manifest-first so it never reintroduces a by-id package field of the kind M4 had to
dissolve.

---

## Primitive 4 — legible composition surface + repair edges

**The claim.** Arrangement (sequence, recurse, fan-out, loop) and the upward
design-repair edge should be legible, authorable data. The analysis marks this
partial (M7), with the surface itself unscheduled.

**What implements it today.**

- The composition surface is the authored `FlowSchematic` (`.json` next to each
  flow), compiled to a `CompiledFlow`. Structure is a list of steps with
  `execution.kind`, `input`/`output` contracts, `routes` (outcome to target), and
  `check` (pass verdicts). `fanout` and `sub-run` are real execution kinds, so
  parallelism and recursion exist as authored steps.
- Repair edges exist as recovery routes. `RecoveryRouteKind`
  (`src/schemas/recovery-route-kind.ts:5`) enumerates the repair vocabulary:
  `retry_same_step_with_feedback`, `narrow_scope`, `run_verification`,
  `run_independent_review`, `checkpoint_authority`, `safe_apply_reject`,
  `stop_unsafe`, `escalate`, `handoff`. A recovery binding gates which failure
  causes may take a route and with what evidence, enforced at runtime by
  `recoveryBindingVerdict` (`src/runtime/run/recovery-binding-verdict.ts`).

**What is still missing.**

- The surface is authorable *by hand*, not *as composition data*. A flow author
  writes each step and each route string individually; there is no higher-order
  primitive to declare "run A, B, C in parallel, merge at D, on any failure
  escalate" as one composable statement. That language is M7's job and is not
  built.
- Repair is real but not a *first-class edge abstraction*. Routes are bare
  `outcome -> target` strings, and recovery semantics are bolted on out of band via
  the work-contract layer rather than declared on the edge itself. A composed-flow
  author cannot legibly say "if this fails, route to recovery X" in the schematic.
- No assembler (M7): nothing turns a sparse block list into task-specific steps.

**Track / gate.** Track B, gated on M4 (landed) with M7 (open). This is E4, and it
is the primitive least ready of the "build" set.

---

## Primitive 5 — isolation / change-packets

**The claim.** Run two arrangements without collision (isolation), and generalize
that into change-packets with a disjoint-apply join.

**What implements it today — isolation (real).**

- `gitWorktreeRunner` (`src/runtime/fanout/worktree.ts:4`) is the whole mechanism:
  `add` provisions a worktree via `git worktree add -b <branch> <path> <baseRef>`,
  `remove` tears it down with `--force`, and `changedFiles` diffs `<baseRef>..HEAD`.
  Each branch gets its own worktree at a shared base commit.
- It is used by the fanout executor (`src/runtime/executors/fanout.ts`) and defined
  as the `WorktreeRunner` interface in `src/runtime/run/child-runner.ts`. **E1's own
  live runner reuses this exact runner** (`experiments/e1/runner.ts` imports
  `gitWorktreeRunner`) rather than inventing isolation, which is the two-track
  plan's "reuse, don't special-case" rule in practice.

**What is still missing — change-packets (not built).**

- `src/schemas/change-packet.ts` is only *enums*: `WorkRootKind`
  (`isolated_worktree | ...`), `SafeApplyAction`, `SafeApplyOutcome`. There is no
  `ChangePacket` *payload* schema (base, branch, diff, metadata as one object).
- The `disjoint-merge` join policy is *documented* (`src/schemas/check.ts`: all
  children must close complete, be pairwise file-disjoint, then merge) but there is
  no runtime that collects isolated changes into packets, verifies pairwise
  disjointness, and applies them back with conflict/rollback handling.

**Track / gate.** Track B, start now for the isolation half (done); the
change-packet generalization is E2 and the sandboxed-pursuits substrate.

---

## Primitive 6 — commensurable traces

**The claim.** Every run emits the same measurable record, so two arrangements are
comparable. The analysis marks this **mostly exists**.

**What implements it today.**

- **Verdict / outcome:** `RunResult` (`src/schemas/result.ts:40`) carries
  `outcome` (`RunClosedOutcome`), an optional terminal `verdict`, and
  `manifest_hash`, all under one `schema_version`.
- **Cost:** `OperatorRunReceiptSpend` (`src/schemas/operator-summary.ts:104`)
  carries per-role `cost_usd_reported` (optional), `total_cost_usd_reported`
  (optional), a `roles[]` breakdown, and a `partial` boolean honesty bit (true when
  any completed relay lacked usage or a usage lacked a reported cost).
- **Evidence:** `ProcessEvidenceProjection` (`src/schemas/process-evidence.ts`)
  carries `evidence_refs` and `missing_evidence` (claim id + reason + next action).
- **Event stream:** `trace.ndjson` entries share `TraceEntryBase`
  (`src/schemas/trace-entry.ts`: `schema_version`, `sequence`, `recorded_at`,
  `run_id`), so any run reconstructs to the same ordered graph. **E1's extractor
  reads exactly these four artifacts** (`experiments/e1/extract.ts`), which is the
  proof the traces are commensurable across `fix` and `build`.

**What is still missing.**

- The cost meter is best-effort, not guaranteed: `cost_usd_reported` is optional and
  `partial` flags when it is incomplete. A comparison must treat a `partial` or
  unmetered run honestly (E1's matrix already carries a `none`/`mixed` cost meter
  for exactly this). This is a soft gap, not a structural one.
- Report *bodies* still vary per flow (each flow declares its own report schema);
  the *envelope* (result/receipt/evidence/trace) is uniform, which is what makes
  cross-flow comparison work. Tightening per-flow body shape is M8's concern, not
  this primitive's.

**Track / gate.** Track B, mostly exists; ratchet separately. E1 is the proof it is
already comparable enough to measure on.

---

## What this means for the next experiments

- **E1 (done) leaned on exactly the three ready primitives:** 3a (the envelope it
  varies by choosing whole vs split flows), 5 (worktree isolation, reused verbatim),
  6 (the result/receipt/trace it normalizes). That is why E1 was buildable now with
  thin glue.
- **The cleanest next build is 3b (equipment scope),** because it is fully absent,
  fully additive, off the migration line, and it is what turns E1's coarse
  whole-flow dial into a real per-harness knob. B3 specs it manifest-first.
- **Primitive 2's typed half (M8) is the one hard external dependency** for turning
  shape-findings into production claims; everything E1-E4 produces stays labeled
  shape-finding until it lands. B3's
  [`e1-implications-for-m8.md`](e1-implications-for-m8.md) records which payload
  shapes M8 must express so these seams become locally checkable.
- **Primitive 4 is the least ready of the build set** and is correctly gated on M7;
  do not front-run it.
