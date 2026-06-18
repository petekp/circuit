# Dynamic-assembly shape check: can the generated path produce an explainer-shaped flow?

> Status: **measurement, complete. Decision: gate FAILS, fix the assembler first.**
> Run 2026-06-17, offline. Quadruply verified (three source reads, an offline
> assemble+compile harness, a real-CLI cross-check, and a three-lens adversarial
> refutation). No source changed; the only new file is the throwaway harness
> `experiments/flow-lab/dynamic-shape-check.ts`.
>
> **Headline:** the dynamic path is **not** viable for the explainer, and the
> bottleneck is the **assembler (the shape it can generate), not the context
> passing.** The task text is not even in the loop. The one natural-language
> entry point (`circuit create`) is deterministic, offline, task-blind, and emits
> build's spine, folded or full. A flow created from "build an explainer for paper
> X" binds its terminal output to `build.result@v1`. It is build, renamed.
>
> **Recommendation:** do **not** proceed to full dynamic-vs-reference runs. Fix
> the assembler's seed breadth and shape vocabulary first. Details in
> [§7](#7-recommendation).

This gated the full dynamic-vs-reference experiment and was meant to isolate
whether the bottleneck is the assembler or the context passing. It answers both.

---

## 1. The question and the gate

The plan: build an interactive explainer website for a research paper through
Circuit's *dynamic* path (generate a flow from the natural-language task), and
compare it to the hand-authored `explainer` flow. Before spending on real runs,
check the cheap thing first: does the generated path even produce a flow of the
right *shape*? Generate it ten times, score the distribution objectively, never
execute.

The gate (finding #1) was: *"Determine how the dynamic path generates a flow from
a natural-language task. If it is not cleanly invocable for an arbitrary NL task,
stop and report that."*

**The gate is subtle and the honest answer is two-part:**

1. The path **is** cleanly invocable. `circuit create --description "<task>"`
   takes any natural-language string and produces a compiled, valid flow,
   offline, in ~0.2 s, for $0. So we did not hard-stop at the literal gate.
2. But invocability is necessary, not sufficient. The path is **task-blind**: it
   reads the description as a label and a slug, never as a signal that shapes the
   flow. Every task produces build's spine. So the real finding is one level
   deeper than "can we invoke it": **what it generates cannot be the explainer.**

---

## 2. How the dynamic path generates a flow

Three candidates were named. Only one accepts an arbitrary NL task; it is the
only "dynamic path" that exists.

| Candidate | Takes an arbitrary NL task? | What it actually is |
|---|---|---|
| **`circuit create`** (`src/cli/create.ts`) | **Yes** | The real entry point. See below. |
| **A JIT / runtime assembler** | No | Does not exist. `src/cli/run.ts:331` rejects inferring a flow from goal text: *"Routing is model-only: the host or operator names the flow. There is no deterministic classifier to guess one from the goal text."* |
| **The flow-lab generation path** (`experiments/flow-lab/recompile-demonstrator.ts`) | No | Seeds from `buildAssemblySpec` and *reshapes* it with the resolvers. Not NL-driven; a measurement substrate, not a generator. |

### What `circuit create` does (`assembleCustomFlow`, `src/cli/create.ts:207`)

```
seed        = { ...buildAssemblySpec, id: slug, purpose: description }   // always build
resolution  = resolveStructure( structureTaskFromCreate(description, --decompose) )
grained     = applyStructure(seed, resolution)                          // whole | decomposed
schematic   = assembleFlowSchematic(grained)
compiled    = compileSchematicToCompiledFlow(schematic)
```

Two facts make the shape task-invariant:

- **`structureTaskFromCreate` (`create.ts:179`) hardcodes** `surface_area: 'small'`,
  `risk: 'low'`. The description string is passed through as `summary` and never
  read. The only live lever is the operator's `--decompose` flag.
- **`resolveStructure` (`structure.ts:71`) returns one of exactly two grains**,
  `whole` or `decomposed`, and **`applyStructure` (`structure.ts:164`) materializes
  only those two**: `decomposed` returns build's full spine; `whole` folds build by
  dropping four fixed steps (`analyze-step`, `build-baseline`, `build-touch-area`,
  `review-step`), leaving `frame -> plan -> act -> verify -> close`.

So the **reachable shape space for any task is two flows**, both build:

- **whole** (default, no flags): 5 steps.
- **decomposed** (`--decompose`): build's full 9-step spine.

The equipment resolver (`equipment.ts`) can inject skill slots into existing
relay steps; it cannot add or reorder steps, so it cannot change the shape.

---

## 3. Method

Everything offline, no execution, no model in the generation path.

- **Harness** (`experiments/flow-lab/dynamic-shape-check.ts`) reproduces
  `assembleCustomFlow` byte-for-byte and runs it for the explainer task: ten draws
  of the default (whole) plus the `--decompose` variant. It hashes each compiled
  flow (determinism), scores each with the flow-lab quality scorer
  (`collectFlowQualityIssues`), and extracts structural metrics. It loads
  `src/flows/explainer/schematic.json` as the reference and scores it the same way.
- **CLI cross-check.** Ran the real `bin/circuit create` (whole and `--decompose`)
  into throwaway homes and compared the compiled step spine to the harness output.
  They match exactly, which proves the harness measures production bytes.
- **Adversarial verification.** Three independent Explore agents, each on a
  different lens (composition, host/runtime/model-drafting, seed-breadth), tried
  to *refute* "no NL->novel-flow generation path exists" by finding a
  counterexample. All three returned *claim-survives*, zero refuters.

The explainer task used: *"build an interactive explainer website for the research
paper 'Attention Is All You Need'."* Paper choice is irrelevant: the path ignores
the text.

---

## 4. The ten flows (the distribution)

The generation is deterministic and offline. There is no model, no sampling, no
temperature. **Ten draws of the default collapse to one flow** (a single distinct
compiled hash across all ten). The "distribution" is a point mass. Exercising the
one lever (`--decompose`) adds a second, also deterministic, shape. That is the
entire reachable space.

| | Reference: `explainer` (hand-authored) | Dynamic *whole* (default, ×10) | Dynamic *decomposed* (`--decompose`) |
|---|---|---|---|
| Steps | 11 | 5 | 9 |
| Canonical stages | 7 of 7 (strict) | 5 (`frame, plan, act, verify, close`) | 7 of 7 |
| Operator checkpoints | **2** (PICK at `plan`, SIGN-OFF at `review`) | 1 (frame brief) | 1 (frame brief) |
| Fanout (tournament) | 1 | 0 | 0 |
| Sub-run (delegated build) | 1 | 0 | 0 |
| Compose / relay / verify | 5 / 1 / 1 | 2 / 1 / 1 | 2 / 3 / 3 |
| **Editorial features (of 8)** | **8** | **0** | **1** (false positive\*) |
| Compiles + passes catalog gate | yes | yes | yes |
| `primary_result` binding | `explainer.result@v1` | **`build.result@v1`** | **`build.result@v1`** |
| Quality issue count | 12 | 3 | 3 |
| Determinism (10 draws) | n/a | 1 distinct hash | deterministic |
| Compiled hash | n/a | `649c29ce9b29c0f2` | `4fe3729727e587a8` |

The reference spine, step by step:
`intake (frame/compose) -> digest (analyze/compose) -> ideate (plan/compose) ->
tournament (plan/fanout) -> harden (plan/relay) -> PICK (plan/checkpoint) ->
spec (plan/compose) -> build (act/sub-run) -> verify (verify) ->
SIGN-OFF (review/checkpoint) -> close (close/compose)`. Its intellectual body
lives in the `plan` stage: five distinct editorial steps.

The dynamic *whole* spine:
`frame (checkpoint) -> plan (compose) -> act (relay) -> verify -> close (compose)`.
One generic plan step, one generic implement step. The dynamic *decomposed* spine
is build's full nine: `frame -> analyze -> plan -> build-baseline -> act ->
verify -> build-touch-area -> review -> close`.

\* **The decomposed flow's one editorial bit is a false positive.** The detector
counts any `analyze`-stage step as a "digest." Build's `analyze-step` is a
*codebase-search researcher relay* producing `diagnosis.result@v1`. For a
paper-to-site task there is no codebase to search; it is not a paper digest. The
honest editorial score for both dynamic shapes is effectively **0 of 8**.

---

## 5. Scores against the objective rubric

**SHAPE.** Generic-build-shaped. Editorial features present: 0 of 8 (whole), 0 of
8 (decomposed, after discounting the false positive). None of fanout/tournament,
sub-run build, a creative PICK checkpoint, a fidelity SIGN-OFF checkpoint, or the
digest/ideate/spec compose chain is reachable. The single checkpoint the dynamic
flow has is build's frame brief, which is a "confirm the brief" gate, not a
decision among generated candidates.

**CONTEXT SCOPING.** Thin and uniform, not degenerate. The work is not crushed
into one step (no `single-step-flow` issue fires), but the dynamic flow has a
*single* `plan` compose and a *single* `act` relay where the explainer spreads
five scoped steps across the `plan` stage (ideate, tournament, harden, pick,
spec) and delegates build to a child run. The dynamic flow's per-step scoping is
build's scoping, applied to a task it was never shaped for.

**REFERENCE overlap.** This is where the trap lives, and the two numbers tell
opposite stories on purpose:

- **Canonical-stage Jaccard: 0.71 (whole), 1.0 (decomposed).** The decomposed
  flow touches the *exact* canonical stage set as the explainer. If you only look
  at "does it hit the right stages," it looks like a bullseye.
- **Editorial overlap: 0.0 (whole), 0.125 (decomposed, all of it the false
  positive).** Once you look at what the steps *do*, the match is skin deep: same
  engine skeleton, none of the body. The canonical stages are the universal
  scaffold every flow rides; matching them is free and means nothing about fit.

**CONSISTENCY.** Perfect, but trivially so. Ten draws, one shape. There is nothing
to be inconsistent: no model, no sampling. Convergence here is determinism, not
quality.

**VALIDITY.** Both shapes compile and pass the fail-closed catalog gate, with a
bound `primary_result`. Note the dynamic flows score *fewer* quality issues than
the reference (3 vs 12), and that is **not** a sign they are better. The scorer
counts well-formedness deficits; the reference's 12 are all `excess-contract-aliases`
(it declares 18 aliases against a budget of 6, because a rich editorial flow needs
them). Lower issue count here just means "thinner flow," not "better flow." The
scorer measures hygiene, not fitness-for-explainer.

**Aggregate (best / median / worst over the ten):** identical. Best = median =
worst = the whole-grain build fold, editorial score 0, editorial overlap 0.0.

---

## 6. Is the dynamic path viable, and where is the bottleneck?

**Viable for the explainer: no.** The generated flow is build with the paper task
as a label. It has none of the structure that makes an explainer an explainer.

**Bottleneck: the assembler (what shape it can generate), not the context
passing.** The evidence is direct:

- **Context passing is not even in the loop.** The task text is read as a slug and
  a purpose string and discarded. `surface_area` and `risk` are hardcoded. So a
  context-passing defect cannot be the cause; there is no context path to be
  defective. Even a perfect NL-to-signal extractor feeding `resolveStructure`
  would only flip `whole` <-> `decomposed`. Both are build.
- **The assembler has no shape vocabulary beyond build.** `applyStructure`
  produces exactly two materializations of one hardcoded seed. There is no
  mechanism that selects a fanout block, a sub-run, or a second checkpoint in
  response to a task. The assembler (`assembleFlowSchematic`) is a faithful
  *expander* of a pre-authored block sequence; it generates nothing. The eight
  built-in flows, including the explainer, are all hand-authored schematics.

The three-lens refutation closed the remaining doubt: there is no composition
caller that picks blocks from a task, no host/connector/MCP/model that drafts a
flow's *shape* from NL (models fill step *outputs* inside a fixed flow), and no
seed-swap or `--from <flow>` template that could start from anything but build.

---

## 7. Recommendation

**Do not proceed to full dynamic-vs-reference runs.** Running the dynamic arm
today measures "build executed on a paper task," not "a generated explainer." The
comparison would be a foregone, uninteresting loss, and it would burn real model
spend to learn what this offline check already shows.

**Fix the assembler entry and shape first.** In rough order:

1. **Seed breadth.** `circuit create` is hardwired to `buildAssemblySpec`. Until
   the path can start from (or compose toward) a non-build shape, no task can
   reach an editorial flow. This is the smallest unblock: a seed-selection or
   `--from <flow>` / template seam.
2. **Shape generation, not just grain.** The decision vocabulary is `whole` vs
   `decomposed` of one spine. The explainer needs blocks the dynamic path never
   reaches: a `plan`-stage fanout, a `sub-run`, a second checkpoint, editorial
   composes. This is the real gap and the larger build. It is the "generate a
   shape from the task" capability that genuinely does not exist yet, and it is
   what the decision-layer / recursion work (see
   [`decision-layer-exploration.md`](decision-layer-exploration.md) §,
   [`deepfork-uniform-recursion-e3-spec.md`](deepfork-uniform-recursion-e3-spec.md))
   is circling.
3. **Context passing comes last, and only then matters.** `surface_area`/`risk`
   are hardcoded; wiring a real NL-to-signal step is wasted effort until there is
   a shape vocabulary for those signals to choose among. Today it would only
   toggle a grain.

A reasonable interim: if the goal is specifically a paper explainer, the
*hand-authored* `explainer` flow already exists and is the right tool. The
dynamic path is the wrong instrument for this target until step 2 lands.

---

## 8. Reproduce

```bash
# offline harness: 10 draws + decomposed, scored against the explainer reference
npx tsx experiments/flow-lab/dynamic-shape-check.ts

# real CLI cross-check (writes throwaway drafts; offline, ~0.2s, $0)
node bin/circuit create --description "build an interactive explainer website for the research paper Attention Is All You Need" --home /tmp/circuit-shape-whole
node bin/circuit create --description "build an interactive explainer website for the research paper Attention Is All You Need" --decompose --home /tmp/circuit-shape-dec
# inspect drafts/<slug>/circuit.json: starts_at, steps[], runtime_surface.primary_result == build.result@v1
```

## 9. Spend and honesty notes

- **Generation spend: $0.** The dynamic path is deterministic and offline; there
  is no model in it. The "bounded generation spend (drafting only)" the plan
  budgeted for does not exist, because there is no model-driven drafting. That
  absence is itself a finding.
- **Measurement spend** was the recon and the one three-lens verification
  workflow (3 Explore agents); no execution, no flow runs.
- **The editorial detector is structural, not name-based**, so it is fair to a
  dynamic flow that used different step ids. Its one false positive (build's
  `analyze` counted as a digest) is called out and discounted in §4 and §5.
- **Lower quality-issue count is not better.** §5 explains why the reference's
  higher count is a richness signal, not a defect.
- **No source changed.** The only new artifact is the throwaway harness under
  `experiments/flow-lab/`.
