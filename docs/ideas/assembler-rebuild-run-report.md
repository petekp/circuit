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

## 2. Phase 2 — genuine-generation spike (DO NOT commit) — PENDING

Offline spike: genuine composition of a novel flow from typed blocks (not
instantiating a pre-designed archetype). Verdict to come: **FEATURE** vs
**RESEARCH PROBLEM**, with evidence, per pre-registration §7. Stays a surfaced
spike + spec; never merged to `src/`.

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

### 3b. Depth (live, budget open) — IN PROGRESS

Execute the best generated flow end-to-end for ≥2 task types (a build/fix coding
task is the cleanest arm; an explainer on a real paper if tractable). Live runs
are **confirmatory**, not part of the §5 numeric gate — but the **live-failure
downgrade** (§6) applies: if the cleanest coding arm fails to execute, the tier
drops one step. Results recorded here as the runs land.

---

## 4. Headline — PENDING

To be written once Phase 3 data is in and the decision rule is applied. Will
state: is the dynamic / JIT path viable; is the dynamic-vs-reference experiment
worth real budget; recommended next step.

---

## 5. Actual spend

- Phase 1: `$0` model spend (the assembler path is deterministic + offline).
- Phase 2/3: recorded as those phases run.
