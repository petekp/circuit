# Typed Coordination Alignment Proposal

Status: proposal, 2026-06-04. This is not shipped behavior. It is a direction
for product framing, docs, and near-term architecture choices.

## Summary

Circuit should keep **flows** as the operator-facing entry point, but align v1
around **typed coordination for agent work**.

The current public framing says Circuit runs structured developer flows. That is
true, and it is still the easiest way to explain the first run. The stronger
claim is that Circuit coordinates agent work by deciding what kind of work is
happening, what typed signal it produced, what should be checked, what should be
recorded, what should be resumed, and what support should be routed to the next
worker.

So the adjustment is not:

> Replace flows with a new product noun.

The adjustment is:

> Use flows as the visible handle, and make typed coordination the system model.

## Why change the framing

The current package description leads with "structured developer flows with
per-step configurability, evidence, checks, traces, and reports"
(`package.json`). That wording is accurate, but it makes the most durable parts
sound secondary. The existing positioning notes already call the structured
report and evidence trail an underused differentiator, and say it should be a
co-equal lead beat with flow shape (`docs/positioning-and-strategy.md`).

Run's architecture also already behaves more like a coordination layer than a
workflow template. Run selects or receives a flow, normalizes controls, loads
config and policy, opens a run folder, optionally recalls history, and then
hands a compiled graph to runtime (`docs/architecture/run-process.md`). Later,
per relay step, it resolves connector, model, effort, skills, and guidance and
records the decision in trace evidence. The decision table near the end of the
Run process doc is effectively a coordination ledger: route, axes, fixture,
config, history recall, next step, attempts, checkpoint waits, selection, relay
validity, close outcome, and post-run artifacts.

That means the product can honestly say:

> Circuit does not just give an agent a better recipe. It records and routes the
> work so the next decision has typed evidence behind it.

## The difference

**Structured flows** ask: "Which process should the agent follow?"

That framing is useful when someone is starting work. It makes Build, Fix,
Explore, Pursue, and Review understandable. It also protects Circuit from the
"one universal pipeline" shape: different kinds of work deserve different
shapes.

**Typed coordination** asks: "What work is happening, what signal did it
produce, and what should happen next?"

That framing explains why Circuit has flow ids, stages, steps, routes, checks,
traces, reports, evidence, config layers, history recall, checkpoints,
selection, Skill Hooks, and run folders. They are not a pile of workflow
features. They are the records and decisions needed to coordinate agent work
without relying on one long chat transcript.

Concrete example:

1. A Build run reaches an Act step.
2. The step produces typed implementation evidence.
3. Verification fails and records a check outcome.
4. Circuit can route the failure through declared paths, such as retry, review,
   handoff, or close behavior when the flow declares them, because the failure is
   a typed signal, not just prose in a transcript.
5. Once actuation is live, Skill Hooks can route additional expertise from
   operator policy because the hook fires on a real runtime signal, not a
   model's hidden interpretation.

That is coordination. The flow supplies the shape, but the typed signal supplies
the next safe move.

## Current surfaces as coordination responsibilities

| Surface | Current role | Coordination responsibility |
| --- | --- | --- |
| Flow | Named kind of work, such as Build, Fix, Explore, or Review (`UBIQUITOUS_LANGUAGE.md`). | Choose the broad work shape. |
| Schematic and block | Authored flow shape using reusable work blocks. Blocks consume named facts and produce typed contracts (`docs/flows/authoring-model.md`). | Keep work composable without forcing every run through the same path. |
| Stage and step | Grouped flow part and executable use of a block. | Locate where work is happening without making that location the only policy key. |
| Route | Named outcome path. | Move between declared next states instead of letting the worker invent control flow. |
| Check and acceptance criteria | Deterministic validation before a step may continue. | Turn "done" into a condition that can be tested. |
| Trace | Ordered record of what happened during a run. | Preserve provenance for replay, debugging, history, and later decisions. |
| Report | Typed output written by a step or close stage. | Give future agents queryable facts instead of lossy memory prose. |
| Evidence | Supporting files, facts, checks, and reports. | Separate proof from assertion. |
| Config and selection | Layered operator, project, flow, stage, step, and invocation choices. | Route connector, model, effort, and skills at the point of work. |
| History recall | Hint-only prior-run context. | Bring prior evidence forward without making memory authoritative. |
| Checkpoint | Pause for operator input or safe default. | Keep high-cost judgment with the operator. |
| Skill Hooks | Policy-named moments that may prepare skills. | Route expertise from deterministic signals, without embedding concrete skill ids in public flows. |

## Design direction

### 1. Keep flows as the first-mile story

Do not rename the product around "coordination." The vocabulary guide already
defines a flow as the named kind of work Circuit can run and explicitly avoids
"workflow." The current pitch also gets real mileage from named flows: Build,
Fix, Explore, Pursue, and Review are easy to understand.

The better rule:

- Operator copy starts with flows.
- Architecture docs explain the coordination layer underneath.
- Product claims graduate only when the coordination surface is source-backed.

This keeps the simple front door without under-selling the durable system.

### 2. Move the lead proof from "better process" to "typed receipts"

The current pitch says flows leave typed reports and evidence behind, but the
lead still centers "stop reinventing your flow." That is a good day-one hook.
The proposal is to make the second sentence carry the durable differentiator:

> Circuit runs named agent flows that leave typed receipts behind: reports,
> checks, evidence, and trace records the next agent can use.

This does not overclaim autonomous intelligence. It names what Circuit already
cares about: evidence-backed records.

### 3. Treat Skill Hooks as the first active coordination feature

Skill Hooks should be framed as routing, not as "add skill X to step Y."

The contracts already draw the right line. Step-owned `skill_hooks` are hook
names only; they cannot carry concrete skill ids, policy modes, host invocation
options, or skill matrices (`docs/contracts/step.md`). Config-owned
`skill_hooks.policy` maps hook names to `auto | ask | mute` policy while staying
separate from flow-step skill slots (`docs/contracts/config.md`).

That split should remain load-bearing:

- Flows and steps publish typed moments.
- Project config decides what those moments mean locally.
- Runtime dispatch fires only from real signals already in the run.
- The actuator routes to either guidance, verification, or an operator pause.

This prevents the feature from becoming a hidden per-step skill matrix.

### 4. Prefer kind-first hooks with stage as context

The coordination object is the work kind and signal, not the ordinal step. For
v1, hooks should prefer predicates such as "after a verification failure" or
"before editing files matching this literal suffix" over "after step 4 of Build."

Stage remains useful context. It can narrow policy when needed. But the primary
anchor should be the thing that happened:

- `after:verification-failed` from a failed check
- `after:evidence-gap` from proof assessment
- `before:edit-file:.tsx` from a typed prediction
- `after:edit-file:.tsx` from a typed observation

That is the practical difference between coordination and workflow slots.

### 5. Make the project model boring and auditable

Circuit's project model should be assembled from records it already has or can
produce deterministically:

- run traces
- typed reports
- check outcomes
- proof and evidence records
- history query and pull results
- project config
- operator choices at checkpoints
- accepted and rejected hook actions

Do not make memory authoritative. The Run process doc already states that
history recall is hint-only and does not alter flow routing, checkpoints, proof
authority, or connector selection. Keep that posture. Coordination should use
history as evidence input, not as hidden control flow.

### 6. Record failed coordination as product signal

When Circuit cannot route work cleanly, record the missing mechanism as a gap.
Examples:

- A hook wants actual touched files from a relay report, but the trace does not
  expose the report schema and path at the dispatch seam.
- A hook wants a before-edit prediction, but the flow does not produce a typed
  predicted surface.
- A verification failure needs a richer recovery route than the flow declares.
- A checkpoint asks for operator judgment because `auto` would be unsafe.

These are not just implementation TODOs. They are the cleanest roadmap signals
because they come from places where coordination could not safely act.

## Near-term proposal

1. Update internal positioning around a two-layer story: "flows are the handle;
   typed coordination is the system."
2. In Skill Hooks docs, define hooks as deterministic routing from typed runtime
   signals to one of three actuator classes: inject guidance, run/check
   verification, or ask the operator.
3. Keep the Step contract's no-skill-matrix rule. Skill ids stay in config and
   selection, not public flow steps.
4. Treat `after:verification-failed`, `after:evidence-gap`, `before:edit-file`,
   and `after:edit-file` as the first proof set because they tie to concrete
   runtime signals.
5. Add a small "coordination responsibilities" section to future architecture or
   strategy docs before making any public copy change.
6. Track coordination gaps in idea docs or run reports when a desired route,
   check, hook, or typed surface is missing.

## What not to do

- Do not make "typed coordination" a new operator command or required noun.
- Do not make hooks model-selected.
- Do not store concrete local skill ids in public built-in flow steps.
- Do not treat history recall as routing truth.
- Do not collapse Circuit into a universal staged workflow. Flow taxonomy remains
  part of the advantage.
- Do not use public claims such as "Circuit keeps best practices updated" until
  the update channel exists.

## Current behavior vs. proposed direction

| Claim | Status |
| --- | --- |
| Circuit runs named flows such as Build, Fix, Explore, Pursue, and Review. | Current behavior. |
| Circuit records typed reports, evidence, checks, traces, and run folders. | Current behavior. |
| Run resolves connector, model, effort, and skills per relay rather than once at startup. | Current behavior. |
| History recall can surface prior-run hints. | Current behavior, bounded and non-authoritative. |
| Skill Hook policy is typed and deterministic. | Current behavior at the config/contract level. |
| Skill Hook actuation should route expertise from typed signals. | Active implementation direction; not stable public behavior until the shipped docs, code, and generated host surfaces agree. |
| Circuit should infer and propose personalized flow variants from real project signal. | Proposed direction. |
| Circuit should maintain a full project model that can safely route work by itself. | Future direction; only safe if built from auditable records and operator-visible policy. |

## Source anchors

- `UBIQUITOUS_LANGUAGE.md` defines the core vocabulary and treats **flow** as
  the named kind of work Circuit can run, while avoiding **workflow**.
- `package.json` currently describes Circuit as running structured developer
  flows with per-step configurability, evidence, checks, traces, and reports.
- `docs/architecture/run-process.md` records the Run decision timeline and the
  per-relay selection resolution surface.
- `docs/flows/authoring-model.md` describes blocks as reusable work units with
  named input facts, one output contract, allowed routes, and expected evidence.
- `docs/contracts/step.md` keeps step-authored Skill Hooks to hook names only.
- `docs/contracts/config.md` keeps Skill Hook policy typed, deterministic, and
  separate from flow-step skill slots.
- `docs/configuration.md` describes current local skill loading and the
  operator/project config surfaces that make deterministic local routing
  possible.
- `docs/positioning-and-strategy.md` already identifies structured reports and
  evidence as an underused differentiator that should be elevated.

## Recommendation

Adopt typed coordination as Circuit's internal north star for v1, while keeping
flows as the simple front-door product language.

The payoff is discipline. It tells us which features belong:

- typed records that future agents can query;
- deterministic hooks that fire from real signals;
- checks that convert assertions into proof;
- checkpoints that keep judgment with the operator;
- history that informs without secretly deciding;
- config that routes support without hardcoding local skills into public flows.

It also tells us which features do not belong: model-picked hooks, hidden memory
routing, universal pipelines, and flow steps that carry concrete local skill
matrices.

In short: flows give the work a shape. Typed coordination makes that shape
auditable, resumable, and improvable.
