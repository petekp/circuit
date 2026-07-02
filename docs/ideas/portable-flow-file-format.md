# Portable flow-file format (exploration)

Status: design + prototype. Experimental. Not wired into the published CLI, not
advertised on the docs site. This explores a third way to get a flow into
Circuit, alongside `circuit create` (describe it) and `circuit generate`
(compose it from a description).

## The ask

A simple, shareable, skill-file-shaped way to encode a flow: one text file you
can hand to a teammate or feed to Circuit, that resolves the skills it needs and
turns into a runnable custom flow. A small DSL is fine. The point is portability:
a flow you can put in a gist, a repo, or a `SKILL.md`-adjacent file, and that
anyone can run without re-deriving it.

## The key insight: a flow-file is the proposer's output, written by hand

Circuit already has the whole pipeline this needs. When you run `circuit
generate`, a model proposes a `CompositionRoleSet` — an ordered list of steps —
and Circuit runs it through an offline floor, then assembles and compiles it:

```
generate:   description ──▶ [model proposes] ──▶ CompositionRoleSet ──▶ floor ──▶ assemble ──▶ compile ──▶ publish
flow-file:  authored file ─────────────────────▶ CompositionRoleSet ──▶ floor ──▶ assemble ──▶ compile ──▶ publish
```

A flow-file is the **durable, hand-authored sibling of the JSON the proposer
emits**. We do not invent a new engine path. We replace the model with a file at
the existing seam, and reuse every gate that already exists. A flow-file that is
wrong fails closed with the same floor errors a bad proposal would, named back to
the author so they can fix it.

The seam, concretely (all of these already exist in `src/flows/composition/` and
`src/flows/`):

| Step | Function | Source |
|---|---|---|
| compose the spec | `composeFlow(roleSet, { definitions })` | `composition/composer.ts` |
| prove it is valid | `evaluateValidity(...)` | `composition/evaluate.ts` |
| prove it is runnable | `evaluateRunnability(...)` | `composition/evaluate.ts` |
| assemble the schematic | `assembleFlowSchematic({ ...spec, id })` | `assemble-flow-schematic.ts` |
| compile to a runnable flow | `compileSchematicToCompiledFlow(schematic)` | `compile-schematic-to-flow.ts` |
| publish | `writeDraft` / `publishDraft` | `cli/custom-flow-package.ts` |

The only new code is the **parser**: text → `CompositionRoleSet`. Everything
downstream is the proven generate path.

## The format

A flow-file is shaped like a `SKILL.md`: YAML frontmatter carrying the flow
definition, then an optional Markdown body for human notes (the parser ignores
the body). The file extension is `.flow.md`.

```markdown
---
id: flake-hunter
title: Flake Hunter
purpose: Prove a flaky test really flakes, fix the cause, and prove it is gone.
steps:
  - { stage: frame,   block: frame }
  - { stage: analyze, block: diagnose,           role: researcher, equipment: read-only }
  - { stage: act,     block: act,                role: implementer, equipment: editor }
  - { stage: verify,  block: run-verification }
  - { stage: review,  block: review,            role: reviewer,    equipment: read-only }
  - { stage: close,   block: close-with-evidence }
skills:
  requires: [flake-triage]
  slots:
    - { id: flake-triage, description: How this team reproduces and isolates a flaky test. }
---

# Flake Hunter

Use this when a test fails intermittently. The diagnosis step stays read-only so
the root cause is found before anything is edited.
```

### Step fields

Each entry in `steps` becomes one `CompositionRole`. Most fields have sensible
defaults so a simple linear flow is terse; you only spell out what is unusual.

| Field | Required | Meaning | Default |
|---|---|---|---|
| `stage` | yes | Canonical stage: `frame`, `analyze`, `plan`, `act`, `verify`, `review`, `close`. | |
| `block` | usually | A block id from the composable set (below). Omit it only on a `kind: sub-run` or `kind: fanout` step, where the parser supplies the block. | |
| `kind` | no | Execution kind: `compose`, `relay`, `verification`, `checkpoint`, `sub-run`, `fanout`. | Inferred from the block. |
| `role` | no | Relay role for a worker step: `researcher`, `implementer`, `reviewer`. | Inferred from the block. |
| `equipment` | no | Tool scope: `read-only`, `editor`, `tester`, `full`. | `full` (the connector's full surface). |
| `terminal` | no | Marks the close step whose result is the run's result. | The `close-with-evidence` step. |
| `loop_back_to` | no | A `verify` step can route a failure back to an earlier block (a retry loop). | |
| `flow` | sub-run | Child flow to run: `fix`, `build`, `review`, `explore`, `pursue`. | |
| `goal` | sub-run | The child run's objective. | |
| `depth` | no | Child depth for a sub-run or fanout branch. | `medium` |
| `branches` | fanout | List of `{ id, flow, goal, depth? }`, at least two. | |

### The composable block set

The format may reference any block, but only a small, validated set composes
today (the same surface `circuit generate` works within). Authoring outside it
fails closed at the floor. The reliable set:

`frame`, `clarify`, `goal`, `gather-context`, `diagnose`, `plan`, `act`,
`run-verification`, `review`, `human-decision`, `close-with-evidence`.

Plus two topology steps you write as a `kind`, not a block id: a `sub-run` step
(run a whole child flow) and a `fanout` step (run several child flows in parallel,
keep the survivors). The parser expands each to its canonical catalog block — a
`sub-run` step becomes the `goal-child-run` leaf, a `fanout` step becomes `act`
running parallel sub-run branches — so the author never has to name the block.

A composed flow still has to satisfy each block's real input contracts, exactly
as `circuit generate` does, and the floor names back any gap. Two that bite most:
`act` reads a `plan.strategy@v1` or `diagnosis.result@v1` (so a flow that acts
needs an upstream `plan` or `diagnose` step), and a `sub-run` to a child flow
needs a `goal.contract@v1` upstream (so it frames with `goal`, clarified first so
the contract binds a precise task). The three samples show each shape running.

### Inference defaults

So a linear flow stays terse, the parser fills these when omitted (the floor is
the safety net — a wrong guess walls honestly and the author corrects):

| Block | Default kind | Default role |
|---|---|---|
| `frame` | compose | |
| `clarify` | relay | researcher |
| `goal` | compose | |
| `gather-context` | relay | researcher |
| `diagnose` | relay | researcher |
| `plan` | relay | researcher |
| `act` | relay | implementer |
| `run-verification` | verification | |
| `review` | relay | reviewer |
| `human-decision` | checkpoint | |
| `close-with-evidence` | compose | |

## Skills resolution

A flow-file declares the skills it expects in a `skills` block. There are two
mechanisms, both already in the engine.

- **`slots`** — named placeholders the flow leaves for the operator to fill. A
  slot id is *not* a skill id. The importing user binds it to one of their local
  skills in config under `skills.bindings.<slot-id>: <skill-id>`. This is the
  portable mechanism: a shared flow-file names slots, never the author's private
  skill ids. Each slot compiles to a `skill_slots` entry on the relevant step.
- **`requires`** — skill ids the flow expects to exist. At import time the parser
  resolves each against the local skill roots (`~/.agents/skills/<id>/SKILL.md`,
  then `~/.claude/skills/<id>/SKILL.md`) and warns about any that are missing, so
  a shared flow-file tells you up front which skills you still need to install.

A future revision can also carry a `hooks` block (a `skill_hooks` policy:
`before:edit-files`, `after:verification-failed`, and so on) that injects skills
into the next implementer relay. Hooks are run configuration rather than part of
the schematic, so they are out of scope for the first prototype.

## What the prototype builds

Additive, inert, and test-locked. Nothing in the shipped flow set imports it,
exactly like `proposeFlow` (importing the module runs no model, no flow, no I/O).

- `src/flows/composition/flow-file.ts` — `parseFlowFile(text)` → a parsed file
  (the `CompositionRoleSet` plus the skills block and notes), and
  `loadFlowFile(text, deps)` → run the file through `composeFlow` + the floor +
  `assembleFlowSchematic` + `compileSchematicToCompiledFlow`, returning either a
  compiled flow or a structured failure carrying the floor's exact errors.
- A skill-`requires` resolver that checks ids against injectable skill roots
  (injectable so tests do not touch the real home directory).
- Tests (`tests/contracts/composition-flow-file.test.ts`, next to the
  `composition-propose` seam test) proving: a valid sample parses to the right
  role set; each of the three samples compiles end to end to a valid
  `CompiledFlow` whose id equals the file's id; malformed files (bad block id,
  missing upstream producer, malformed frontmatter) fail closed at the right gate
  with the floor's real error; an `equipment` value maps to the right scope;
  `requires` resolution flags a missing skill and accepts a present one against an
  injected root.
- Canonical samples under `docs/ideas/flow-file-samples/`: a linear fix-style
  flow (`flake-hunter`), a verify-loop (`tighten-loop`), and a sub-run delegation
  (`ship-with-build`). All three run through `loadFlowFile` to a valid
  `CompiledFlow`.
- A small demo script (`experiments/flow-file/demo.ts`) that loads a sample and
  prints the compiled flow's id, purpose, and step count, so the whole seam is
  exercised offline with no model call.

## Honest limits

- **Experimental.** This is an exploration, not a shipped command. The prototype
  is a tested library plus a demo, not a published CLI surface. The natural next
  step is a `circuit create --from-file <path>` flag that feeds the parser into
  the same draft/publish tail.
- **Narrow surface.** Only the validated composable block set works today. Queues,
  autonomous pursuit, goal loops, risk/rollback, and continuity are out of reach
  until they have reusable registered actuals, the same limit `circuit generate`
  has.
- **Validity, not efficacy.** The floor proves a flow compiles, uses real blocks,
  and never reads a result nothing produced. It does not prove the flow is a
  *good* process. An authored flow-file can be valid and still a poor plan.
- **Equipment is guidance by default.** Profiles map to `trusted` scopes (prompt
  guidance). A hard `--tools` wall is a separate opt-in and is connector-bound
  (real on Claude Code, downgraded honestly elsewhere). See
  `src/schemas/equipment-scope.ts`.
- **Not a session importer.** This encodes a flow you *write*. Turning an existing
  session into a flow is a different, unbuilt path.

## Why this is the right shape

It adds an authoring on-ramp without adding engine surface. The flow-file is the
one artifact the generate path already speaks (`CompositionRoleSet`), made
durable and human-authored. Every safety property of the composed path — the
floor, the catalog gate, the typed-contract wiring — applies to an authored file
for free, because it is literally the same path with the model swapped out for a
file.
