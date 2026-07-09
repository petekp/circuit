# Model roster and intensity: two operator knobs over a promoted roster

Status: `current-proposal`. Concept-first design note from a 2026-06-30 design
pass with the operator. Nothing here is built. Every code citation was grounded
against `src/` on that date on branch `fix/policy-max-attempts-per-step`; verify
each against current source before building. See
[`depth-and-power.md`](deprioritized-ledger.md) for the shipped dial this proposal
reshapes, and [`proactive-power-floors.md`](deprioritized-ledger.md) for the
adjacent power-floor idea.

## The problem

Circuit can already route different steps of one flow to different connectors
and models. What it cannot do is let the operator express their model
preferences simply, especially in a mixed-connector flow.

Today a step's model is decided one of three ways: the global power dial mapped
through a hard-coded role-to-tier table and a per-connector tier table; a
per-flow pin; or a per-step pin hand-written in YAML. So the operator's natural
sentence, "Codex 5.5 at xhigh plans, Opus at max reviews, my trusted model
implements," is not expressible as a durable preference. The dial cannot say it
(it ties roles together and caps at `high`), and the tier table is keyed by
connector, not by role.

Goal: collapse every model-related variable into a small set of operator
preferences with smart defaults, while keeping granular controls for power
users.

## The reframe: Circuit already has a roster, it is just frozen

The insight that unlocks this: Circuit already has a roster. It is the
hard-coded `ROLE_POWER_ALLOCATION` table plus the shipped default tiers in
[`power-tiers.ts`](../../src/selection/power-tiers.ts). Every step runs as one
of three roles (researcher, implementer, reviewer), and the dial maps each role
to a tier, which maps per connector to a `(model, effort)` pair. That is a
roster. It is just welded into engine code and shaped like a dial.

The proposal is two moves:

1. Lift that hard-coded roster into operator-editable config. The current
   hard-coded values become the *smart default* roster, so nothing regresses.
2. Turn the dial into a pure intensity scalar over per-connector ladders (next
   section), so it has one honest meaning instead of secretly encoding both
   role differentiation and capability level.

This also dissolves the "power means two things" confusion we kept hitting:
today `high` swaps the model for an Anthropic connector but only raises effort
for Codex. Under the reframe, the per-provider asymmetry moves into the roster
(visible data the operator edits) and the dial means exactly one thing.

## The model: two knobs over a roster

### 1. The roster (set once, smart defaults)

A small table: archetype to `(connector, baseline rung)`.

```
plan      -> codex gpt-5.5, xhigh
review    -> claude opus, max
implement -> claude sonnet, high
```

The *connector* half of this already exists as `relay.roles.<role>.{kind,name}`
in config (grounded in `config.ts`, resolved in
[`resolver.ts`](../../src/connectors/resolver.ts)). What is missing is the
`(model, effort)` half bound to a role. Today role-to-model is reachable only
through the dial, the per-connector tier table, or a per-flow/per-step pin.
There is no "reviewer -> opus, max" as a stable preference. That binding is the
core new capability this proposal adds.

### 2. The intensity dial (per run or per flow)

One scalar with one meaning: how hard this task is. It walks every archetype up
or down a per-connector **intensity ladder**, where each rung is a concrete
`(model, effort)` pair, ordered most to least intense:

```
anthropic:  opus/high  >  sonnet/high  >  sonnet/med  >  haiku/med  ...
codex:      gpt-5.5/xhigh  >  gpt-5.5/high  >  gpt-5.5/med  >  gpt-5.5-mini/med  ...
```

The roster picks each archetype's baseline rung; the dial applies an integer
offset. Whether a given downshift changes the model or the effort is baked into
where the rungs sit, so the operator never reasons about "model versus effort"
as separate knobs. It is one ladder, one offset.

Decision (2026-06-30): intensity downshifts the **model**, not only effort. A
routine task should be able to drop Codex to a mini and Claude to a smaller
model, matching how a research swarm uses a cheap model. The Codex model ladder
falls out of machinery the cross-tool-build work already built: the codex
default-model resolver reads `~/.codex/models_cache.json` sorted by `priority`
(see `src/connectors/codex-default-model.ts` on `feat/cross-tool-build`), and
that same ordering is the model ladder (flagship, next, mini).

### 3. Overrides

A flow or a single step can pin or nudge. This layering already exists:
`defaults.selection` to `circuits.<flow>.selection` to per-step `step.selection`,
across global config (`~/.config/circuit/config.yaml`) and project config
(`./.circuit/config.yaml`), with an invocation layer on top. So "global roster
with per-flow overrides" is close to free once the role binding lands.

## Archetypes are open, and the shape axis

Decision (2026-06-30): ship a gut-feel starter set (plan, implement, review),
but model archetypes as an open, keyed map, not a fixed three-value enum.
Adding one should be config, not engine surgery. Concretely: the archetype set,
the per-connector ladders, and the role-to-tier allocation all become data.

Why open matters, grounded in a real case: a subagent **swarm** doing research
wants a cheap, fast model precisely because it runs many workers in parallel.
But research is normally the *highest* tier. So the same nominal job wants
opposite economics depending on the **shape** of the work: one deep sequential
agent versus many shallow parallel ones. "Deep research" and "swarm research"
are two archetypes with inverted ladders, not one role at two intensities. A
closed enum would force mislabeling a swarm as "implementer at low power,"
which loses the intent.

The swarm archetype is **not** blocked on missing machinery, which corrects an
earlier assumption in this design pass. Circuit has a real parallel fan-out
shape today ([`fanout.ts`](../../src/runtime/executors/fanout.ts)):

- `runWithConcurrency` runs branches concurrently through a bounded pool
  (default 4, configurable per step to any bound or `unbounded`).
- Two branch kinds: **relay** branches (each a single subagent, read-only ones
  run truly parallel) and **sub-run** branches (each a full nested flow run in
  its own git worktree, isolated and parallel).
- Join policies decide the outcome: `pick-winner`, `disjoint-merge`,
  `aggregate-only`, `aggregate-survivors`.
- Each branch already carries its own `selection` and `connector`
  ([`types.ts`](../../src/runtime/fanout/types.ts)), threaded through
  `syntheticRelayStep`. Per-worker model choice inside a fan-out is an existing
  field, not new capability.

So the swarm archetype is an ergonomic layer over existing execution and
existing per-branch selection: a fan-out step names an archetype
("swarm-research"), and the roster staffs every branch at a low ladder rung.
Two honest constraints to carry forward:

- Writable *relay* branches are serialized to concurrency 1 (they share the
  parent checkout with no per-branch write root; see
  `WRITABLE_RELAY_SERIALIZATION_REASON` in `fanout.ts`). Parallel writers must
  be sub-runs, which get worktrees. A research swarm is read-only, so it
  parallelizes freely.
- Today's fan-out reads as small-N *differentiated* branches (each its own goal
  or lens), authored explicitly. A large-N *homogeneous* swarm may need a
  branch-generator to avoid hand-authoring N near-identical branches. Confirm
  how `expandFanoutBranches` sources branches before promising that.

## Setup and verify journey

- **Download, then first run detects connectors.** No connector detection
  exists today (searched `src/connectors/` and the whole tree; the `auto`
  fallback is a hard-coded host default, not a probe). New surface: detect
  which connectors are installed, propose a smart-default roster, let the
  operator accept or tweak. One decision, not a per-step interrogation.
- **First use of a flow shows the resolved roster for its steps, one confirm,
  run.** No new questions unless the flow needs an unstaffed archetype.
- **A plan-preview / verify command.** None exists today, and `--dry-run` is
  explicitly *rejected* (`run-flag-vocabulary.ts`) because an old version faked
  it while really spawning. So this must resolve-without-spawn: print the
  resolved `(connector, model, effort)` for every step and validate every model
  string before any spend. This is the safety net that stops "run it many times
  to discover a typo."

## What exists today versus what is new

Grounded 2026-06-30. Verify before building.

Already present:

- Roles researcher / implementer / reviewer, and the dial's role-to-tier
  allocation (`power-tiers.ts`, hard-coded).
- Connector-per-role binding: `relay.roles.<role>.{kind,name}`.
- Power dial `defaults.power` / `--power` in `{auto, low, medium, high}`.
- Per-connector tier table `power_tiers.<connector>.<tier>.{model, effort}`;
  shipped defaults are claude-code haiku/sonnet/opus and codex effort
  low/medium/high.
- `model` is an open string, `provider` a closed enum
  (`selection-policy.ts`).
- Config layering global to project to invocation, plus per-flow
  `circuits.<flow>.selection` and per-step `step.selection`.
- Real parallel fan-out with per-branch `selection` and `connector`
  (`fanout.ts`, `fanout/types.ts`).

New to build:

- Role-to-`(model, effort)` binding: the roster's missing column.
- The dial as a scalar over per-connector `(model, effort)` ladders, so a
  downshift is uniform and defined (and can change the model, per the
  decision above).
- Connector detection plus a first-run setup that seeds the smart-default
  roster.
- A plan-preview / verify command (resolve-without-spawn, validate model
  strings).
- Default ladders that reach `xhigh`/`max`; today's shipped codex tiers cap at
  `high` effort.

## Recommended first slice

The plan-preview / verify command. Reasons:

- Read-only and safe, and it directly relieves the stated pain: see the
  resolved model for every step and catch a typo'd model string before
  spending.
- It is the reality-testing instrument. Build the thing that shows what any
  config resolves to, then reshape the roster and dial against it.
  Observability before behavior change.
- It may relieve the pain before the larger build lands, because once
  resolution is visible, the existing machinery (per-role connectors,
  per-connector tiers, per-branch fan-out selection) probably does more than
  the operator remembered.

Then role binding, then dial-as-scalar, then detection and setup last as the
polish that makes defaults smart.

## Decisions and open questions

Decided 2026-06-30:

- Roster scope: global, with per-flow and per-step overrides.
- Archetypes: ship a gut-feel starter set (plan, implement, review), model the
  set as open so it can change.
- Intensity downshifts the model, not only effort.

Open:

- Archetype granularity: keep three roles with class specialization (code,
  prose, front-end, back-end) as an override, or promote sub-roles to
  first-class. Leaning: start small, let evidence earn a new dimension.
- The naming of the intensity knob. "Power" leans compute-and-cost and collides
  with the mechanism. If the concept is intent, the label may want to be
  intent-forward. Operator's taste call.
- Large-N homogeneous swarm: does it need a branch-generator, or is explicit
  small-N differentiated fan-out enough for the first swarm archetype? Confirm
  against `expandFanoutBranches`.
