# Run report — task-aware assembler rebuild

> Status: **living report, updated as phases land.** Date 2026-06-18.
> The scientific spine is the pre-registration in
> [`assembler-rebuild-preregistration.md`](assembler-rebuild-preregistration.md),
> committed before any eval data. The gate this builds on is
> [`dynamic-assembly-shape-check.md`](dynamic-assembly-shape-check.md).
> Decision rule, task set, and rubric are LOCKED there; this report records what
> was built and what the data said, then applies the rule.

---

## 0. The question

The gate found `circuit create` **task-blind**: it discarded the task text,
hardcoded `surface_area: small` / `risk: low`, and could emit only two shapes
(build folded / build full). This run builds a **task-aware assembler** and
decides — against the pre-registered rule — whether the dynamic / JIT-workflow
direction is now **viable**, **promising**, or **research-grade-not-ready**.

---

## 1. Phase 1 — the task-aware assembler (SHIP) — DONE

Three new resolver/assembler modules + a rewired create path, no engine edit:

- **`src/flows/resolvers/signals.ts`** — reads the one-line task description into
  `AssemblySignals` (`family`, `surface_area`, `risk`, `domain`, `signals_used`).
  Deterministic, pure, no model. Cues are matched at a **word-boundary start** so
  a stem (`migrat`) matches its inflections but a cue never fires mid-word
  (`hang` cannot match inside "changelog" — the bug the first cut had). Cue lists
  are exported data the tests and report cite.
- **`src/flows/resolvers/archetype.ts`** — picks an archetype **family** from the
  signals and **instantiates** a task-appropriate `FlowSchematic`: editorial,
  fix, review, research, prototype, or build. The build family is **composed**
  (the structure resolver folds the spine to whole/decomposed from
  surface/risk); the rest **instantiate** a proven family seed. Every family
  reuses a **registered contract family** (`build.*`, `fix.*`, `explore.*`,
  `review.*`, `prototype.*`, `explainer.*`) whose bodies are registered globally
  by namespace, and single-producer is checked **per-graph** — so a custom-slug
  flow that reuses a proven family passes the fail-closed catalog + kind gates
  exactly as the built-in does. This is the Phase 1 line: **reuse** registered
  families. Inventing novel contracts from raw blocks is the Phase 2 frontier.
- **`src/flows/compiled-flow-file-plan.ts`** — a per-mode family (fix, research,
  prototype carry depth/tournament `route_overrides`) compiles to a **per-mode
  package**: one graph per runtime mode. The planner lays them out the way the
  runtime loader expects — the largest graph to `circuit.json`, remaining modes
  to `<mode>.json` siblings.
- **`src/cli/create.ts`** — now reads the task (`extractAssemblySignals`), picks
  + instantiates a shape (`resolveArchetype`), compiles, plans the per-mode
  files, validates each, and publishes the whole package. The shape facts
  (family, composition, signals read) are recorded in the draft's
  `validation-result.json` and the operator summary's new **## Shape** section.

### Architecture decisions made (and why)

- **The manifest stays identity-only (M9-C honored).** M9-C deliberately removed
  the custom-flow `archetype` field (it used to mean "this is a build clone" and
  drove by-id resolution). The descriptor schema is `.strict()` and a contract
  test asserts it *rejects* an `archetype` key. The chosen family is pure
  **legibility**, so it lives in the validation-result sidecar + operator
  summary — never on the descriptor the runtime trusts. The runtime resolves by
  slug → `flow_path` and loads per-mode siblings by **disk presence**; it never
  needs the family. Net: the existing `archetype === undefined` manifest
  assertion still holds, unchanged.
- **Per-mode publish scope = full package; default mode runs live.** The trust
  gate (`publishedCustomFlowMatches`) matches the loaded fixture against the
  manifest's single `circuit.json` `flow_path`, so the **default** mode of a
  per-mode custom flow runs live today. Non-default modes (`<mode>.json`
  siblings) are published and loadable by disk, but the trust gate does not yet
  bless them — a genuine security-sensitive seam recorded as a **bounded
  follow-up**, not bolted on. (STOP-AND-REPORT item, per the run's rails.)
- **No engine edit.** The assembler rides the create/resolver layer. The
  resolvers live under `src/flows/resolvers/` (shared cross-flow infra), so their
  reuse of each family's `assembly-spec` is unrestricted intra-flows composition,
  not a boundary crossing. `create.ts` touches only the shared assembler infra.

### Built-ins stay byte-identical (the rail) — PROVEN

- `tests/runner/task-aware-assembler.test.ts` pins that the **build family is
  byte-identical** to the structure-resolver path the old seam used
  (`resolution.schematic` deep-equals `assembleFlowSchematic(applyStructure(...))`).
- `npm run check-flow-drift` confirms every generated built-in flow surface
  (commands, skills, `generated-surfaces.md`) is in sync. The only drift was the
  host runtime JS **bundle** (it compiles in `create.ts`), regenerated with
  `npm run build-plugin-runtime` — expected, not a flow-byte change.

### Verification

`npm run verify` green (full canonical gate). Focused proof: the task-aware
suite (6/6), `structure-chooser`, `utility-cli` (38/38, including the live
end-to-end run), the descriptor contract tests, and the engine↔flow boundary +
catalog-completeness contracts (allowlists updated for the two new resolvers and
the file-plan module).

### Classifier honesty (a documented limitation, not fitted away)

The classifier is a deterministic **keyword heuristic**, not a semantic model.
The word-boundary fix kills the mid-word collision class
(`changelog`↛`hang`). A residual collision class remains and is reported
honestly: a build verb governing a noun that is also a family cue —
"Build an **audit** log" classifies as review, "Build a file **explor**er" as
research. This is the **same** precedence mechanism that *correctly* sends
pre-registered task T1 ("**build** an interactive **explainer** website") to
editorial; a keyword classifier cannot have one without the other. Resolving it
needs semantics (or an operator override, which exists via `--name`). All 8
pre-registered tasks classify exactly as expected (verified before any scoring).

---

## 2. Phase 2 — genuine-generation spike (DO NOT commit) — DONE

Offline spike: can an **automated composer** build a **valid** (compiles +
catalog-gate-clean + primary_result) and family-appropriate **novel** flow — a
topology that is none of the 6 built-in families — from individual typed catalog
blocks, deterministically and without inventing unregistered contracts? This is
the Phase 1 line's opposite: Phase 1 **instantiates** a whole proven family seed;
Phase 2 tries to **compose from blocks**. The spike runs the SAME fail-closed
gates the engine runs, so a "valid" verdict would be a real valid flow.

Prototype (surfaced, **git-untracked, never merged** per the run's rail):
`experiments/flow-lab/phase2-genuine-generation-spike.ts`. `$0` model spend.

### Verdict: **RESEARCH PROBLEM** (not a feature yet)

Three consistent angles:
- **Positive control** — the real `review` family spec passes the same gate
  (**VALID ✅**). So the harness is sound; a correctly-authored flow is accepted.
- **Perturbation** — take the valid `review` family and make ONE minimal novel
  edit a generator might make (duplicate the audit step so two steps produce
  `review.verdict@v1`). The gate **rejects it** (`schematic item is unreachable
  from starts_at`): the duplicate is not wired into the route DAG. Even a
  one-line automated edit breaks validity unless routes are correctly re-wired.
- **Novel-from-scratch** — three genuinely novel topologies (a diagnose-only
  *triage*; a *fix-then-prototype* hybrid; a *research-then-build* weld).
  **0 / 3 valid.** Each hit a *fail-closed assembler wall* **before the contract
  gates even ran.**

### Why — the evidence (the wall sequence)

A naive linear composer that selects blocks and wires `continue` routes hits a
**sequence of eight distinct fail-closed walls**, each demanding per-block or
per-flow authoring knowledge that **is not in the typed block catalog**
(`docs/flows/block-catalog.json` carries contracts in/out, not these):

1. compose steps need explicit `check` / `required` data;
2. relay steps need `pass` values;
3. the flow needs a `stageLabels` map;
4. a step must **not restate** a block's default output (e.g. `close-with-evidence`'s `flow.result@v1`);
5. relay steps need explicit request / receipt / result **paths**;
6. a partial canonical stage path needs a `stagePathRationale` (≥20 chars);
7. a step must **not restate** a block's default **execution**;
8. a **multi-execution-kind block** (`intake` allows compose / checkpoint / sub-run / fanout) **must be disambiguated** — and the allowed-kinds table lives in the engine, not the catalog.

To clear all eight you must either **lift the entire per-step scaffolding from a
shipped family** (that is Phase 1 instantiation, not novel generation) or
**author the missing pieces yourself** (a human or a model in the loop). The
typed blocks are deliberately **not self-describing enough** to drop into a novel
topology — the hand-authored assembly spec carries flow-specific *intent* (which
execution kind, why a stage is skipped, how generics alias to flow actuals, the
route DAG) that a deterministic block-selector cannot infer. The gates are
**fail-closed by design** (Circuit's safety thesis: a flow cannot widen a
contract, drop a producer, or strand a step); the "walls" are that safety system
working, not a bug.

### What a FEATURE path would require (decision-ready spec)

Genuine block-composition becomes an engineering feature only if the composer is
given what it currently lacks:
1. **A per-block execution-capability table** in the catalog (allowed kinds +
   default) so multi-kind blocks can be disambiguated mechanically.
2. **A contract-alias solver** that binds generic contracts (`flow.brief@v1`,
   `flow.result@v1`) to flow-specific actuals satisfying single-actual / anti-widening.
3. **A route-DAG synthesizer** guaranteeing reachability from `starts_at` and
   correct `@complete` / `@stop` terminal binding.
4. **A check-data / relay-path defaulting layer** so steps need no hand-authored boilerplate.
5. **A source of intent** for the genuinely non-mechanical choices (which kind
   for a multi-kind block; why skip a stage) — this is the irreducible part that
   wants a model in the loop.

Until (1)–(4) exist, genuine generation is a research track, not a shippable
feature. Phase 1 (instantiate-and-fold) is the viable, shippable path today.

---

## 3. Phase 3 — test thoroughly (breadth + depth)

### 3a. Breadth (offline, structural) — DONE

Harness: `experiments/flow-lab/assembler-breadth-eval.ts`. It reproduces the
shipped create path EXACTLY (`extractAssemblySignals` → `resolveArchetype` →
compile), generates each pre-registered task N=10, and scores against the LOCKED
§3 rubric. `$0` model spend (offline + deterministic).

Per-task result (NEW assembler vs OLD stub), one row per pre-registered task:

| Task | Expected | NEW family / grain | Signal used | Valid | Features (forbidden) | Det. | PASS | OLD signal-used / pass |
|---|---|---|---|---|---|---|---|---|
| `explainer-paper` | editorial | editorial / instantiated | ✅ | ✅ | 1.00 (0) | ✅ | **YES** | ✗ / ✗ |
| `feature-darkmode` | build / whole | build / whole | ✅ | ✅ | 1.00 (0) | ✅ | **YES** | ✅ / ✅ |
| `fix-race` | fix | fix / instantiated | ✅ | ✅ | 0.833 (0) † | ✅ | **YES** | ✗ / ✗ |
| `research-state` | research | research / instantiated | ✅ | ✅ | 1.00 (0) | ✅ | **YES** | ✗ / ✗ |
| `review-auth` | review | review / instantiated | ✅ | ✅ | 1.00 (0) ‡ | ✅ | **YES** | ✗ / ✗ |
| `migrate-billing` | build / decomposed | build / decomposed | ✅ | ✅ | 1.00 (0) | ✅ | **YES** | ✗ / ✗ |
| `tweak-rename` | build / whole | build / whole | ✅ | ✅ | 1.00 (0) | ✅ | **YES** | ✅ / ✅ |
| `proto-hero` | prototype | prototype / instantiated | ✅ | ✅ | 1.00 (0) | ✅ | **YES** | ✗ / ✗ |

**Decision-rule inputs (§5), computed not asserted:** `P = 8/8`, `E = 1.00`
(editorial feature overlap vs the explainer reference), `D = 7` distinct
**structural** shapes (8 by literal full-compiled hash — `feature-darkmode` and
`tweak-rename` are the same `build/whole` shape with different purpose text),
`V = 8/8` valid. OLD stub: **1** distinct shape, **2/8** pass (only the two
small/low build tasks, by luck of the hardcoded `whole`).

**Breadth tier: VIABLE** (`P≥7 ∧ E≥0.60 ∧ D≥5 ∧ V=8`).

**Two pre-registered predicates were mis-specified (disclosed + discounted per
§8, never rewritten):**
- † **fix has no `plan` stage.** The hand-authored fix goes
  frame → diagnose(analyze) → act → verify → close. The rubric's "a plan"
  over-specified the family, so fix scores 0.833 (5/6) on the literal rubric —
  but the fix *reference itself* also scores 5/6, so the generated fix is **at
  the reference bar**. Discounting the bad predicate, fix shape is appropriate
  (5/5). It still clears the 0.75 PASS threshold either way.
- ‡ **review's audit is an `analyze/relay`, not a `review/relay`.** The detector
  recognizes an audit relay in the review *or* analyze stage — faithful to the
  structural intent ("a relay that audits"), not the stage label.
- (Validity: §3.3 said "returns a single package"; the per-mode families
  fix/research/prototype return a valid **per-mode** package. Validity counts a
  per-mode package as valid when it compiles, the catalog gate is clean, and
  **every** mode binds `primary_result`.)

**Honesty caveat — what the high numbers do and do not mean.** `E = 1.00` and the
near-1.0 feature overlaps reflect that Phase 1 **instantiates proven family
seeds** (the editorial arm clones the explainer schematic; fix/research/review/
prototype clone their seeds; build is folded by the structure resolver). The
overlap is high *because it is reuse*. What is genuinely new and measured is the
**diversity across families**: the assembler now reads the task and lands the
right family **and** the right build grain, where the OLD stub could only ever
emit one shape. Within-family novelty (composing a *new* shape from blocks) is
**not** claimed here — that is the separate Phase 2 question.

### 3b. Depth (live, budget open) — DONE

Two task types executed end-to-end with a **real worker** (`claude` 2.1.181),
each from a flow the NEW assembler generated and published, run via
`circuit run <slug> --flow-root … --autonomous`. Both reached `@complete`.

| Live arm | Family / shape | Outcome | Primary result | On-task proof |
|---|---|---|---|---|
| `fix-sum` | **fix** (per-mode, custom slug) | `complete`, verdict `accept` | `result.json` written | bug genuinely fixed (`arr.length - 1` → `arr.length`); `npm test` passes |
| `add-multiply` | **build / whole** | `complete` | `result.json` written | `multiply` implemented; `npm test` passes |

The **fix** arm is the strongest evidence: it exercises a **NEW family** (not the
byte-identical build path), is a **per-mode** package whose default mode the
trust gate blesses, runs under a **custom slug**, and a real worker drove it from
diagnose → fix → verify → review → close. The §6 success criteria
(reach a terminal, write `primary_result`, produce operator-judgeable on-task
output) are met on both arms.

One honest setup note: the first `fix` launch aborted **honestly** at the frame
step (`package.json does not exist` — it could not choose verification commands).
That is the §6-anticipated "known rough edge handled as setup," not a shape
defect; adding a `package.json` test script (the operator's job) cleared it and
the rerun completed.

**Live-failure downgrade (§6): NOT triggered.** The cleanest coding arm executed
successfully, so the breadth tier stands.

The third intended arm — an **explainer on a real paper** — is reported
**not-run, with reason** (per §6, not silently skipped): the explainer's
delegated sub-run builds an interactive website (scaffold + build-timeout rough
edges flagged in the pre-registration), a long heavy run whose marginal signal
over the two successful arms did not justify the open-ended wall-clock in this
session. The ≥2-task-type bar is already met by `fix` + `build`.

---

## 4. Headline

**The dynamic / JIT-workflow direction is VIABLE — by selection-and-instantiation,
not by genuine generation.** Apply the pre-registered decision rule (§5) to the
measured inputs: `P = 8/8`, `E = 1.00`, `D = 7` distinct structural shapes,
`V = 8/8` → **VIABLE**. The live confirmation did not downgrade it: a real worker
drove a NEW-family generated flow (fix) and a build flow end-to-end to
`@complete`, both producing correct, on-task results.

Three things are now true and measured, not asserted:

1. **The assembler reads the task.** Where the old stub discarded the text and
   emitted one shape for everything (1 distinct shape, 2/8 tasks "right" by the
   luck of a hardcoded grain), the new assembler lands the **right family** and
   the **right build grain** on all 8 pre-registered tasks (7 distinct shapes).
   That is the gate finding closed.

2. **Phase 1 reaches the bar by reuse, not novelty.** The near-perfect feature
   and editorial overlap (`E = 1.00`) is **instantiation** of proven family seeds
   — honest and shippable, but it is not composing a new shape. The genuine-
   diversity that *is* new is **across** families (task → family + grain), not
   **within** a family.

3. **Genuine generation is a research problem, not a feature.** The Phase 2 spike
   showed an automated block-composer cannot produce a valid novel flow today: it
   hits eight fail-closed authoring walls before the contract gates even run,
   because the typed catalog does not carry the per-block / per-flow intent the
   safety gates require. A feature path exists but needs catalog enrichments
   (execution-capability table, alias solver, route synthesizer) plus a model for
   the irreducibly intentional choices.

**Is the dynamic-vs-reference experiment worth real budget?** **Yes — for the
instantiation path.** Run a generated, instantiated flow against the hand-authored
reference on a real task and measure quality/cost. The live arms already show the
generated flows *run* and *finish on-task*; the open question that experiment
answers is whether they finish *as well as* the hand-authored bar, and at what
cost. Do **not** yet spend budget on the genuine-block-composition arm — that is
gated behind the Phase 2 spec's catalog enrichments.

**Recommended next step.** Ship Phase 1 (done — committed, verify-green). Then
scope the **dynamic-vs-reference live experiment** on the two cleanest families
(fix, build) where the live arms already succeed, comparing instantiated-generated
vs hand-authored on a small held-out task set with the cost-capture instrument.
Hold genuine block-composition as a separate research track behind the Phase 2
catalog enrichments (§2).

---

## 5. Actual spend

- **Phase 1** (assembler): `$0` model spend — deterministic + offline path.
- **Phase 2** (genuine-generation spike): `$0` — the composer + gates are offline.
- **Phase 3 breadth**: `$0` — offline structural scoring, N=10 deterministic.
- **Phase 3 depth (live)**: two real `circuit run --autonomous` executions with a
  live worker (`fix-sum`, `add-multiply`). Small coding tasks, ~13 and ~5 steps;
  real but modest model spend (not separately metered this run — the cost-capture
  instrument is the dynamic-vs-reference experiment's job, not this confirmation's).
- Total deliberate model spend was confined to the two live confirmation runs;
  every measurement that feeds the §5 decision rule is `$0` and deterministic.
