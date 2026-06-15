# E2 spec: equipment scope, manifest-first

> Written 2026-06-14. This is **B3(a)** of the E1 backlog. It is a **spec only**:
> it designs primitive 3b ("equipment scope") as a declared, enforced field, but
> implements nothing. Implementation waits until after the first-class-composition
> migration merges (it would otherwise collide with M8's typed-seam work in
> `src/schemas/` and `src/flows/`). Grounding: the
> [`primitive-readiness-audit.md`](primitive-readiness-audit.md) found 3b fully
> absent today; this is the design that fills it. See also the
> [`exploration-substrate-two-track-plan.md`](exploration-substrate-two-track-plan.md)
> (E2) and the [`e1-implementation-brief.md`](e1-implementation-brief.md).

## The one-line goal

Make "how much equipment a worker gets" a **declared field on a step**, not an
accident of which flow you picked. Equipment scope is the dial that turns E1's
coarse whole-flow contrast (`fix` = wide, `build --depth high` = split) into a
per-harness knob you can set without authoring a new flow.

## Why this is the holism/separation dial

The audit established the mechanism E1 uses today: it varies decomposition grain
by choosing between two *whole flows*. That is a blunt instrument. Decomposition
grain is really two independent choices:

1. **How many leaves** the work is split into (sequence/fan-out structure). This
   is composition surface (primitive 4).
2. **How much each leaf can see and do** (its reads and its tools). This is
   equipment scope (primitive 3b).

A *holistic* arrangement is one wide-envelope harness: broad reads, full tool
set, one work step. A *separated* arrangement is several narrow-envelope
harnesses: each leaf reads only its slice and holds only the tools its slice
needs, then the outputs reassemble. Today the only way to narrow a leaf is to
pick a different flow. With a declared equipment-scope field, an experiment sets
the envelope per step and measures what the narrowing bought or cost. After E2,
an experiment is config, not a new flow.

## The manifest-first rule (and why it matters here)

The hard constraint, straight from the migration's scar tissue: **author the
field on the manifest, never as a by-id package lookup.** The `engine_flags`
field had to be unwound in M3b precisely because it had become a by-id package
field that M4 then had to dissolve (see the audit's primitive 1 and the
`Post-M4 ... sole authority` note at `src/runtime/run/binding-legibility.ts:85`).
Equipment scope must not repeat that mistake. Concretely:

- The field lives on the **schematic step** (`src/schemas/flow-schematic.ts`,
  authored) and is compiled onto the **compiled-flow step**
  (`src/schemas/compiled-flow.ts`, runtime), exactly like `optional_inputs` and
  the existing per-step `role` (`src/schemas/step.ts:177`). It travels with the
  manifest bytes that the run captures at bootstrap.
- The engine reads it from `flow` / the step, never from a catalog keyed by flow
  id. A composed flow that reorders or substitutes steps carries its equipment
  scope inline, so there is nothing for a future M4-style dissolution to clean
  up.

## The declared field

Proposed shape (spec, not code), declared on a relay/work step:

```
equipment_scope:
  reads:   "wide" | "narrow" | { paths: string[] }   # context envelope
  tools:   "full" | { allow: string[] }              # capability set
  write_tier: "isolated_worktree"                     # where edits land
             | "parent_checkout_diff_capture"
             | "pre_safe_apply_trusted_write"
```

Notes on each:

- **`reads`** is the context envelope this step's worker is given. `"wide"` is
  today's default (broad reads, the holistic envelope). `"narrow"` or an explicit
  `paths` list is the separated envelope: the leaf sees only its slice. This is
  the field the two-track plan calls "hand-set reads."
- **`tools`** is the capability set. `"full"` is today's implicit default. An
  `allow` list is the per-harness tool list the plan calls for. The three-value
  `role` (`researcher | implementer | reviewer`) stays as the coarse identity;
  `tools` is the fine-grained kit *within* a role. A researcher with a narrow read
  scope and a read-only tool list is a different harness from a researcher with
  wide reads and full tools, without inventing a new role.
- **`write_tier`** reuses the vocabulary that already exists as
  `WorkRootKind` in `src/schemas/change-packet.ts`
  (`isolated_worktree | parent_checkout_diff_capture | pre_safe_apply_trusted_write`).
  It declares where this step's edits are allowed to land, which is the
  enforcement hook (next section).

All three are optional with a "wide/full/isolated" default, so every existing
flow's behavior is unchanged when the field is absent. That is the
backward-compatible, zero-by-correction property the M5 gate already expects of a
new declaration.

## Write-tier enforcement

A declared field is only a dial if something checks it. Enforcement has two
layers, both reusing machinery the audit located:

1. **Read/tool scope is enforced at relay dispatch.** The connector that builds a
   worker's prompt already injects and withholds skills via skill-hooks
   (surfaced as `injected_skills` / `withheld_skills` / `unavailable_skills` in
   `src/schemas/operator-summary.ts`). Equipment scope generalizes that from
   skills to reads and tools: the declared `reads`/`tools` become the allow-list
   the dispatcher hands the worker, and any use outside it is a recorded
   violation in the trace (the same shape as `unavailable_skills`). This is a
   *declared boundary checked at dispatch*, not a post-hoc observation.

2. **Write tier is enforced at apply.** The `write_tier` value gates which
   `WorkRootKind` the step's edits may use, and the existing safe-apply outcome
   types (`SafeApplyAction` = `rejected | accepted_for_review | applied`,
   `SafeApplyOutcome` = `pass | fail` in `src/schemas/change-packet.ts`) are the
   verdict surface. A step declared `isolated_worktree` whose edits try to land as
   a trusted parent write is rejected. This is the "write-tier enforcement" the
   brief asks the spec to define: the declared tier is the upper bound on where a
   worker's changes are allowed to go.

The honest limit: full enforcement of the *body* a worker hands back across a seam
(not just where it wrote) needs the typed seam. That is why this is E2-spec, not
E2-build, and why the dependency points at M8 (see
[`e1-implications-for-m8.md`](e1-implications-for-m8.md)).

## How an experiment uses it

Once the field exists, E1's variant matrix (`experiments/e1/matrix.ts`) gains a
new column kind. Today a column is a whole flow plus args
(`{ variant_label, flow_id, extra_args }`). With equipment scope, a column can be
*the same flow* with a different per-step envelope:

- `holistic`: every work step `reads: wide, tools: full` (today's `fix`).
- `separated`: each leaf `reads: narrow, tools: { allow: [...] }`, reassembled at
  a wide-envelope compose step.

The measurement loop is unchanged. The matrix already records verdict vs
`done_when`, the honesty signal, and cost per cell, so the new question
("did narrowing the envelope change the verdict or the cost?") is answered by the
same `ExperimentMatrix` the fixture lane proves.

## Explicitly out of scope (deferred to implementation, post-merge)

- **No code.** No edits to `src/schemas/`, `src/flows/`, `generated/`, or
  `plugins/`. This collides with the migration's M6-M9 work on exactly those
  paths; implementing now would race it.
- **No new engine branch.** Per the two-track plan's must-not list, equipment
  scope is data over existing execution kinds and existing enforcement surfaces
  (skill-hook dispatch, safe-apply). If implementation finds it needs a new engine
  branch, that is a finding handed to Track A, not a hack.
- **No typed body validation here.** That is M8's job; this spec only declares the
  envelope and the write tier. The body-level "did the leaf produce the contract
  it promised" check is specified separately.

## Open questions for the implementation pass

1. Is `reads` better as a tri-state (`wide | narrow | paths`) or always an
   explicit path/glob list with `wide` as sugar? Explicit is more legible but
   more verbose per step.
2. Should `tools` deny-list or allow-list by default? Allow-list is safer
   (fail-closed) and matches the M5 gate's posture.
3. Does `write_tier` belong on the step or on the route into the step? Recovery
   routes (`narrow_scope`, `safe_apply_reject`) already imply a tier change, so
   the tier may want to be route-aware rather than step-static.
4. How does equipment scope interact with sub-runs? A child flow has its own
   per-step scopes; does the parent's sub-run step cap them, or are they
   independent? (This is the same self-similarity question primitive 1 raises.)
