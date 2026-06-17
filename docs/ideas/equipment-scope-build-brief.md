# Equipment-scope build brief — the "scoped skills/tools" axis

> Status: **BUILT — this batch shipped.** Build brief written 2026-06-14; status
> updated 2026-06-16. The "scoped skills/tools" axis it describes is now real on
> `main`: the tools half landed as **PR #89** (declared + enforced per-step tools,
> honest downgrade), and the skills half as **PRs #96/#97** (the `equipment`
> resolver chooses the kit; real house-style injection rides `skill_slots`; the
> skill-slot quality ratchet dropped 15 → 1). Of the four micro-harness scopes this
> brief names (context, equipment, model/effort, structure), **equipment moved from
> absent → real here**. See
> [`equipment-scope-enforcement-report.md`](equipment-scope-enforcement-report.md)
> and [`north-star-status.md`](north-star-status.md). Builds on
> `e2-equipment-scope-spec.md` (the design), the #88 equipment resolver prototype
> (trusted-suggest), and `decision-layer-exploration.md` §7 (the
> mechanism-vs-smarts split).

## Why this batch

The north-star micro-harness has four scopes: **context, equipment (skills/tools),
model/effort, and structure.** Three are real-ish today; **equipment is the one
that's entirely absent** — a step carries only a placeholder `skill_slot`, no real
scoping or injection. This batch turns "scoped skills/tools" from *absent* → *real*.
It's the most ready significant advance (spec'd, prototyped, no grain-data or
ratification gate), it's tangible (the "React work → React skills" example), and
it's measurable: the flow lab's quality ratchet baselines **19 skill-slot gaps**,
which should drop as steps gain real equipment.

## Scope: build the MECHANISM, not the smarts

The critical boundary. This batch builds the *capability* for a step to be
equipped with scoped skills/tools and for the engine to provide and enforce them.
It does **NOT** build the auto-detection chooser ("notice this step is React work
and pick React skills") — that's a later **resolver** (a decision, like the
structure chooser), and building it now would be premature smarts. Build the
mechanism a human author (or, later, a chooser) will use; leave the *choosing* for
later. If you find yourself selecting skills by work-type, stop — out of scope.

## The two increments (sequence trusted → enforced)

1. **Declared + trusted (lower risk, first).** A step declares its equipment
   (skills/tools) via a manifest field — authored **manifest-first**, never a
   by-id or engine branch. The engine *provides* the declared skills to the step
   as guidance. Prove it on a representative flow; watch the skill-slot-gap
   ratchet drop.
2. **Enforced (the meaningful safety piece).** The step is actually *restricted*
   to its declared equipment at the **write tier** — per the original debrief,
   enforcement matters most where a step changes files. Make **enforced-vs-trusted
   an explicit, declared, tested property** of each binding; never display a
   trusted binding as though it were enforced.

## The likely fork to surface

*How* to enforce "only these tools" at the write tier depends on how the runtime
grants tools to a relay/worker — a genuine design question. Ground it against the
runtime and **surface a recommendation** rather than guessing; if there's no
obviously-correct mechanism, stop-and-report.

## Measurement

The flow lab's quality ratchet (`tests/contracts/flow-quality.test.ts`) baselines
19 skill-slot gaps. As built-in steps gain declared equipment, that count should
fall — ratchet it down. This is the cheap, offline proof the mechanism works
before any real-codebase test.

## Rails

- **Production rails** (this touches `src/`, unlike #88's offline work):
  failing-test-first for every `src/` change; full `npm run verify` green before
  "done"; **never special-case the engine** (equipment rides the manifest/data);
  adversarial review to the cap; fresh PR; **hold merge** for the operator.
- **Isolation:** own worktree/branch.
- **Scope fence:** the auto-detection chooser is OUT (later resolver).
- **Stop-and-report** at the write-tier-enforcement fork if it's genuinely
  ambiguous; a clean partial + report beats a forced "done."

## Ground against

- `docs/ideas/e2-equipment-scope-spec.md` — the design.
- `experiments/resolvers/` (#88) — the trusted-suggest prototype + `SHARED-SHAPE.md`.
- `docs/ideas/decision-layer-exploration.md` §7 — why the mechanism/smarts split matters.
