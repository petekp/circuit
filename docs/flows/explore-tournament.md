---
name: explore-tournament-decision-mode
description: Focused design for Explore Tournament decision mode.
type: product-architecture
date: 2026-04-29
status: implemented
---

# Explore Tournament Decision Mode

This note records the implemented Explore Tournament contract. The tournament
mechanics are backed by runtime tests, generated release truth, and the
`proof:explore-decision` golden run. The deterministic `decide:` intent router
described in early drafts was removed; routing is model-only today.

## Goal

Explore Tournament is the decision mode for consequential choices.

When the operator runs:

```bash
./bin/circuit run explore --goal "choose the architecture path for <topic>" --tournament
```

Circuit runs a real tournament over options, stresses the result, pauses for
the tradeoff decision, and closes with a readable decision receipt.

The value is not "more analysis." The value is that Circuit makes the decision
process visible:

- What options were considered.
- Why each option could be right.
- What evidence or assumptions support each option.
- What risk each option carries.
- Which tradeoff needs operator judgment.
- What should happen next after the decision.

## Operator Contract

There is no deterministic `decide:` router. Routing is model-only and a flow
name is always required (`src/cli/run.ts`). Tournament mode is entered two
ways:

- explicit CLI axes:
  `./bin/circuit run explore --goal "<decision question>" --tournament
  [--tournament-n 2|3|4]`;
- host-model flow choice through `/circuit:run`, where the model selects
  Explore and the tournament axis for decision-shaped goals.

Deterministic `decide:` intent routing is a tracked capability gap
(`router:intent:decide` in
[docs/release/readiness-report.generated.md](../release/readiness-report.generated.md)).

The first run is allowed to stop at `checkpoint_waiting` after the proposal
stress pass. After the operator answers the checkpoint, the resumed run closes
with an Explore decision and result.

The operator summary must include:

- the decision question;
- the options considered;
- the recommended option or the reason there is no clear winner;
- the core tradeoff;
- the evidence and assumptions behind the recommendation;
- the residual risks;
- one exact next action.

If the user names options, Circuit uses those options. If the user only names a
decision question, Circuit infers two to four plausible options and marks them
as inferred. If Circuit cannot infer fair options, it asks for the missing
choice boundary instead of fabricating a weak tournament.

## Non-Goals

Explore Tournament is not a new public flow or command. It is an Explore mode.

Explore Tournament is not a code-change tournament. The first public slice does
not merge branch worktrees or pick a code winner. It compares decision
proposals.

Explore Tournament is not implemented by routing `decide:` to ordinary Explore
with a tournament depth label. The mode needs distinct reports, checkpoint
behavior, and proof.

## Flow Shape

The tournament path should share normal Explore framing and analysis, then
branch into a decision path.

```text
Frame
  -> Analyze
  -> Draft Options
  -> Proposal Fanout
  -> Stress Proposals
  -> Tradeoff Checkpoint
  -> Compose Decision
  -> Close With Result
```

Default Explore keeps its current investigation path:

```text
Frame -> Analyze -> Synthesize -> Review -> Close
```

Tournament mode uses `route_overrides` after Analyze so the default path stays
unchanged. The schematic also needs a `plan` stage entry with an operator-facing
title such as `Decision`. Default mode can auto-omit that stage; tournament
mode reaches it.

The tournament canonical stage path is:

```text
Frame -> Analyze -> Decision -> Close
```

`Draft Options`, `Proposal Fanout`, `Stress Proposals`, `Tradeoff Checkpoint`,
and `Compose Decision` are all Decision-stage steps. Tournament does not add a
separate canonical Review stage. The critique is embedded in the Decision stage
and recorded as decision evidence, matching the original parity axis of
`Plan or Decision` rather than introducing an extra `Review` stage.

## Step Details

### 1. Frame

Reuse the existing Explore brief step for the general subject and success
condition.

Output:

- `explore.brief@v1`

### 2. Analyze

Reuse the existing Explore analysis step for shared context. This keeps all
proposal branches grounded in the same baseline.

Output:

- `explore.analysis@v1`

Route behavior:

- default depth: continue to the normal findings path;
- tournament depth: continue to Draft Options.

### 3. Draft Options

Compose the decision option set from the brief, analysis, and original goal.

Output:

- `explore.decision-options@v1`

Minimum fields:

- `decision_question`
- `success_criteria`
- `constraints`
- `options`
- `unknowns`
- `option_source`: `explicit`, `inferred`, or `mixed`

Each option should carry:

- `id`
- `label`
- `summary`
- `best_case_prompt`
- `risk_prompt`
- `evidence_targets`

If fewer than two fair options exist, the step should route to a checkpoint or
stop with a clear reason. A one-option "tournament" is not a tournament.

### 4. Proposal Fanout

Run one proposal branch per option.

Output:

- `explore.tournament-aggregate@v1`
- branch reports shaped as `explore.tournament-proposal@v1`

Each proposal branch should answer:

- What is the strongest case for this option?
- What assumptions must hold?
- What evidence supports it?
- What risks or failure modes matter?
- What would be the next action if this option wins?

Important implementation choice:

The existing runtime `fanout` step is sub-run and worktree oriented. That is
right for implementation branches, but awkward for decision proposals. The
tournament slice should extend fanout so a branch can be a relay branch, not
only a sub-run branch.

The compiled shape should keep `kind: "fanout"`, but branch execution should
gain a discriminator:

- `execution.kind: "sub-run"` for the existing worktree/child-flow behavior.
- `execution.kind: "relay"` for proposal branches.

Relay branches do not need git worktrees. They must still keep the normal relay
evidence trail. Each proposal branch should write:

- branch request;
- branch receipt;
- branch raw result;
- typed `explore.tournament-proposal@v1` report.

Those files should live under the fanout branch directory, and the aggregate
report should include enough proposal summary and provenance to let downstream
stress review cite the branch that produced each claim. For relay branches, the
compiled branch must name the provenance field that proves identity. In the
first Explore Tournament slice, `result_body.option_id` must exactly match the
fanout `branch_id` (`option-1` through `option-4`) before the branch can be
admitted into the aggregate.

Join policy:

- Use `aggregate-only` for Explore Tournament.
- Do not use `pick-winner` for the first slice.

The stress reviewer and operator should select the decision after seeing all
proposals. The fanout join should only prove that every proposal branch produced a
parseable report.

### 5. Stress Proposals

Relay a fresh stress pass over the option set and proposal aggregate. This is a
Decision-stage step, not a canonical Review-stage step.

Output:

- `explore.tournament-review@v1`

Minimum fields:

- `verdict`: `recommend`, `no-clear-winner`, or `needs-operator`
- `recommended_option_id`
- `comparison`
- `objections`
- `missing_evidence`
- `tradeoff_question`
- `confidence`

The stress pass is adversarial. It should not simply summarize proposals. It
should look for weak assumptions, hidden costs, and cases where two options are
closer than the proposal writers claimed.

### 6. Tradeoff Checkpoint

Pause for the operator after the proposal stress pass.

Output:

- checkpoint request and response files;
- optionally `explore.tradeoff-selection@v1` if the checkpoint writer needs a
  typed report for downstream compose steps.

The checkpoint prompt should be short:

- recommended option;
- one sentence for why;
- main tradeoff;
- choices that can safely advance into Compose Decision.

For the first implementation slice, every allowed checkpoint choice must map to
a valid selected option. That means:

- accept the recommendation;
- choose one of the other listed options.

Do not offer `ask for more evidence` or `stop` as checkpoint choices until those
choices have executable route semantics. The current checkpoint runtime treats
an allowed selection as a passing check and advances to the next step. If a
future checkpoint offers `ask for more evidence` or `stop`, the schematic and
runtime must prove that those selections route to more evidence or stop instead
of falling through into Compose Decision.

Tournament depth already waits at checkpoint steps. This is the right behavior:
the first run may end as `checkpoint_waiting`, and a resumed run can close.

Autonomous decision behavior is separate. If an autonomous Explore mode later
uses this path, it must carry ambiguity forward or choose only when a declared
default or policy-controlled checkpoint resolution exists and is recorded in
the trace.

### 7. Compose Decision

Compose the durable decision report from the options, proposals, stress pass,
and checkpoint response.

Output:

- `explore.decision@v1`

Minimum fields:

- `decision_question`
- `selected_option_id`
- `decision`
- `rationale`
- `rejected_options`
- `evidence_links`
- `assumptions`
- `residual_risks`
- `next_action`
- `follow_up_workflow`

`follow_up_workflow` is the serialized field name in the report schema. In
prose, call it the follow-up flow. It should be explicit when the decision
naturally starts Build, Fix, Review, or another Explore run.

### 8. Close With Result

Close with the normal flow result, expanded for tournament evidence.

Output:

- `explore.result@v1`

The result should link to:

- `explore.brief`
- `explore.analysis`
- `explore.decision-options`
- `explore.tournament-aggregate`
- `explore.tournament-review`
- checkpoint receipt or `explore.tradeoff-selection`
- `explore.decision`

The close writer should produce an operator-facing summary that reads like a
decision receipt, not a raw trace.

## Implemented Runtime Shape

### Schematic And Compiler

- Schematic authoring supports `fanout`.
- Compiled fanout supports relay branches while keeping existing sub-run fanout
  behavior unchanged.
- Explore tournament mode routes from Analyze into the Decision stage without
  changing default Explore behavior.
- The emitted tournament path reports canonical stages as Frame, Analyze,
  Decision, and Close. The stress pass does not appear as an extra canonical
  Review stage in the parity matrix.
- Checkpoint choices all advance safely into Compose Decision. Non-advancing
  choices such as "ask for more evidence" or "stop" remain out of the
  checkpoint until they have executable route semantics.
- Tests cover the tournament path and the default Explore regression path.

### Explore Reports And Writers

Add Zod schemas and writer/relay hints for:

- `explore.decision-options@v1`
- `explore.tournament-proposal@v1`
- `explore.tournament-aggregate@v1`
- `explore.tournament-review@v1`
- `explore.tradeoff-selection@v1`, if needed
- `explore.decision@v1`

Update `explore.result@v1` so tournament evidence links are valid without
breaking the default Explore result path.

### Router

There is no router. Routing is model-only: the CLI requires an explicit flow
name and never classifies goal text (`src/cli/run.ts`, `src/commands/run.md`).
Intent hints are empty in `generated/release/current-capabilities.json`, and
the readiness report tracks `router:intent:decide` as a known gap.

### Operator Summary

The fallback host summary for Explore Tournament must read the final
`reports/explore-result.json` and follow evidence links to the decision report.
If the run stops at checkpoint, the summary must show the checkpoint prompt,
the recommendation, and the option-selection choices without pretending the
decision is final.

TODO: Revisit whether Explore Tournament should emit a final rich HTML summary
at all. Rich HTML is most useful for active choice surfaces where visual
comparison helps the operator decide. After the checkpoint is resolved, the
final summary can likely stay in the chat thread, while any rich artifact should
belong to the waiting checkpoint state.

## Acceptance Tests

Minimum tests that clear the release blocker:

- Schematic compile: Explore emits a tournament entry mode whose path includes
  Plan/Decision-stage option drafting, fanout, stress pass, checkpoint,
  decision, and close, without adding a canonical Review stage to the
  tournament path.
- Regression: default Explore keeps the existing synthesize and critique work,
  but exposes it inside the canonical Plan/Decision stage.
- Fanout: relay fanout writes request, receipt, raw result, and one typed
  proposal report per option, plus an aggregate report that downstream stress
  review can consume.
- Checkpoint: tournament depth pauses after the stress pass and records a
  checkpoint request whose allowed choices (`option-1` through `option-4`) all
  map to valid selected options.
- Resume: after a checkpoint response, the run writes `explore.decision@v1` and
  `explore.result@v1`.
- Release truth: the generated readiness report tracks `router:intent:decide`
  as a known gap; the tournament capability itself is proven by the golden
  run, not by intent routing.
- Golden proof: `proof:explore-decision` captures progress, operator summary,
  and result reports for a synthetic architecture decision.

## Release Truth Rules

- `generated/release/current-capabilities.json` carries no intent hints;
  the readiness report records `router:intent:decide` as a tracked gap.
- `generated/flows/explore/tournament.json` exposes the tournament path.
- [docs/release/proofs/index.yaml](../release/proofs/index.yaml) marks
  `proof:explore-decision` as verified current.
- [docs/release/readiness-report.generated.md](../release/readiness-report.generated.md)
  remains the current release truth
  after regeneration.
- `check-release-ready` passes unless a future release blocker is introduced.

## Implementation Decisions

- Relay fanout is an extension of `fanout`, not a separate compiled step kind.
- `explore.tradeoff-selection@v1` is a checkpoint contract name only for now.
  Decision composition reads the raw checkpoint response because checkpoint
  report branching is not executable yet.
- The first executable slice uses stable ids `option-1` through `option-4`.
  The option labels preserve user-named choices when they can be parsed from the
  decision prompt, then fill remaining slots with bounded fallback choices such
  as `Hybrid path` and `Defer pending evidence`.
- `no-clear-winner` still reaches the bounded checkpoint; the checkpoint offers
  only final option choices that can safely advance into Compose Decision.
- The public surfaces are `/circuit:run` (model-routed) and the CLI's
  `run explore --tournament` axes. There is no direct `/circuit:tournament`
  command and no `decide:` prefix routing.

## Implemented Order

1. Add the report schemas and a stubbed design test for the tournament path.
2. Add schematic/compiler support for fanout authoring and relay fanout.
3. Add the Explore tournament graph and writers.
4. Add router support for `decide:` (since removed; routing is model-only
   today).
5. Regenerate release truth.
6. Add the golden proof before clearing the remaining readiness blocker.

This order keeps the strongest public claim last, after the behavior can be
inspected.
