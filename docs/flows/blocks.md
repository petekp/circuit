---
name: flow-blocks
description: Canonical first-principles inventory of reusable flow blocks for Circuit.
type: product-architecture
date: 2026-04-28
status: active
---

# Flow Blocks

Circuit should build toward a small set of reusable blocks that operators can
assemble into clear flows, rather than a long list of one-off flow
schematics.

Typed block definitions live in `src/schemas/flow-block-definitions.ts`; the
machine-readable companion catalog is generated at
[docs/flows/block-catalog.json](block-catalog.json). The authoring model is
described in
[docs/flows/authoring-model.md](authoring-model.md). The Pursue and Coordinate
Pursuits blocks are explained in [docs/flows/pursue.md](pursue.md).

## Core Idea

A flow should be assembled from blocks.

Each block has:

- a clear purpose;
- structured inputs;
- a prompt or tool call rendered from those inputs;
- a typed output;
- checks that decide whether the output can be trusted, including relay
  acceptance criteria when a delegated worker result needs step-level proof;
- routes that decide what can happen next.

The prompt is a delivery format, not the source of truth. The runtime
should pass structured state between blocks whenever possible, and only
render prompts at the connector boundary.

## Contract Fit Rule

Not every block works after every other block.

A block can run only when previous outputs satisfy its input contract.
This lets the runtime reject impossible flow assemblies early.

Example:

- a Fix block can consume a diagnosis;
- a Verify block can consume implementation evidence plus proof commands;
- a Close block can consume the required evidence for that flow;
- a Fix block should not consume only a vague idea list.

Some blocks have more than one valid input shape. Act is the first
important case: it can work from a plan, from a diagnosis, or from both,
as long as the brief is also present. The machine-readable catalog records
those alternatives so schematic validation can reject under-specified
steps without forcing every flow to include a separate Plan block.

Close With Evidence also has more than one valid input shape. A reviewed
close should consume review evidence. A low-depth close that intentionally
skips Review can consume the brief and verification result, but it should
be a separate schematic step so the skipped-review path stays visible.

## Canonical Block List

| Block | Purpose | Typical inputs | Typed output | Common next routes |
|---|---|---|---|---|
| Intake | Capture the user's goal and requested mode. | Goal text, explicit flow, entry mode, project context. | Normalized task intake. | Route, Frame, Human Decision. |
| Route | Choose the flow or block sequence. | Intake, known flow catalog, shortcut rules. | Route decision with reason. | Frame, Human Decision, Stop. |
| Frame | Define the work boundary and proof needed. | Intake, selected flow, constraints, known context. | Brief with scope, constraints, proof plan. | Human Decision, Plan, Diagnose, Act. |
| Clarify | Turn a rough request into a clear task for the selected flow. | Intake, selected flow, target guidance. | Clarified task with outcome, proof, constraints, scope, assumptions, and stop conditions. | Flow-specific contract, Human Decision, Stop. |
| Human Decision | Pause for an operator choice and record it. | Question, options, default policy, mode policy, current evidence. | Decision report with selected option and source. | Continue, revise, stop, hand off, escalate. |
| Gather Context | Collect facts before deciding or acting. | Brief, target paths, search instructions, allowed tools. | Context packet with sources and confidence. | Plan, Diagnose, Review, Human Decision. |
| Diagnose | Explain what is wrong or unknown. | Brief, context packet, repro instructions, observed behavior. | Diagnosis with cause, confidence, repro status, diagnostic path. | Act, Gather Context, Human Decision, Stop. |
| Plan | Choose an implementation or investigation path. | Brief, context, diagnosis, constraints. | Plan with steps, risk notes, proof strategy. | Human Decision, Act, Batch. |
| Act | Make or delegate the change. | Brief or plan, diagnosis when relevant, allowed scope, model/tool policy. | Implementation evidence with changed files and rationale. | Verify, Review, Human Decision. |
| Run Verification | Execute declared proof commands and capture results. | Proof plan, command list, timeout/output policy, current work evidence. | Verification result with commands, exit status, and evidence. | Review, Act retry, Human Decision, Close. |
| Review | Independently judge the result. | Brief, plan/diagnosis, implementation evidence, verification result. | Review result with findings, confidence, and required fixes. | Act retry, Verify retry, Close, Human Decision. |
| Goal | Turn a user objective into a bounded contract with proof, recovery, and completion-gate policy. | Intake, route decision. | Goal contract with done claims, allowed flow targets, and gate policy. | Continue, child flow, Human Decision, Stop. |
| Goal Child Run | Run the statically selected child flow for a goal contract. | Goal contract. | Child run record with the static target and result pointers. | Goal Attempt, Stop. |
| Goal Attempt | Summarize one child-flow attempt against the goal contract. | Goal contract. | Attempt record with flow target, result path, and outcome. | Goal Evaluate, Stop. |
| Goal Evaluate | Compare attempt evidence to done claims and choose the next typed route. | Goal contract, attempt record. | Evidence evaluation with claim results, gaps, and next route. | Gate review, recovery, Human Decision, Stop. |
| Goal Recover | Choose a typed recovery action when an attempt falls short. | Evidence evaluation, attempt record. | Recovery decision with reason and selected route. | Retry, child flow, checkpoint, Stop. |
| Goal Checkpoint | Pause for operator judgment on a goal recovery decision. | Question, recovery decision. | Decision record with selected option and source. | Continue, blocked, hand off, Stop. |
| Goal Gate Review | Run one safety-review pass over the goal evaluation before close. | Goal contract, evidence evaluation. | Gate review with lens applied and evidence checked. | Run next gate pass, recovery, Close (retry or Stop on a failed check). |
| Goal Close | Emit the final goal result from the contract, attempt, and evaluation. | Goal contract, attempt record, evidence evaluation. | Goal result with outcome, evidence pointers, and follow-ups. | Complete, Stop. |
| Pursue | Turn a rough operator idea into an autonomous ownership contract. | Goal text, route, project context, safety defaults. | Pursuit contract with scope, estimated touch set, proof plan, and check-in triggers. | Coordinate Pursuits, Human Decision, Stop. |
| Coordinate Pursuits | Prioritize pursuits by dependency, conflict risk, and composition. | Pursuit contract, estimated touch sets, proof policy. | Pursuit graph with serial groups and parallel read-only groups. | Plan, Batch, Human Decision, Stop. |
| Queue | Turn broad work into ordered items. | Survey/context, safety criteria, prioritization rule. | Work queue with item state and risk class. | Batch, Human Decision, Close. |
| Batch | Process a bounded set of queue items. | Queue, batch size, safety policy, proof policy. | Batch result with completed, skipped, blocked, and failed items. | Verify, Queue, Human Decision, Close. |
| Risk/Rollback Check | Decide whether continuing is safe. | Current diff/evidence, risk policy, rollback or recovery options. | Risk decision with allowed next action. | Continue, split, revert plan, Human Decision, Stop. |
| Close With Evidence | End honestly. | Required reports, verification, review when required, residual risks. | Flow result with outcome, evidence pointers, follow-ups. | Complete, stop, hand off, escalate. |
| Handoff | Persist enough state to resume later. | Current goal, completed blocks, pending evidence, next action, debt. | Continuity record or handoff report. | Stop, Resume later. |
| Review Intake | Frame an independent review and capture the working-tree state. | Intake, route decision. | Review intake with scope and working-tree status. | Independent Audit, Stop. |
| Prototype Variant Evidence | Capture provider evidence for the model-comparison variants before verifying them. | Brief, variant options, variant aggregate. | Provider evidence with captured count and per-variant attribution. | Verify variants, Stop. |
| Prototype Checkpoint | Pause for the operator to decide a verified prototype's disposition. | Prototype artifact, verification result. | Decision record with the selected disposition and source. | Continue, Stop. |

## Fix-Derived Reusable Blocks

The old Repair flow is useful reference evidence, but the clearer v1
product schematic is Fix: understand a concrete problem, make the smallest
safe change, prove it, and close honestly.

Fix should contribute these reusable blocks:

| Block | Why it is reusable |
|---|---|
| Regression Contract | Many change flows need expected behavior, actual behavior, and proof target. |
| Diagnose Problem | Fix needs it directly; Review also needs "why this is risky or broken" analysis. |
| No-Repro Decision | Any flow can hit uncertain evidence and need operator choice. |
| Optional Review Branch | Low-depth paths can skip review only when mode and evidence allow it. |
| Conditional Close | Some flows close as fixed, not reproduced, partially complete, skipped, or handed off. |

## Human Decision Block

Human Decision should be a first-class block, not a Claude-specific
instruction.

The flow-level input is structured:

```json
{
  "decision_id": "fix.no_repro_next_step",
  "question": "The bug did not reproduce. What should Circuit do next?",
  "options": [
    {
      "id": "instrument",
      "label": "Add diagnostics",
      "effect": "Continue with probes or logging"
    },
    {
      "id": "stop",
      "label": "Stop here",
      "effect": "Close as not reproduced"
    },
    {
      "id": "handoff",
      "label": "Hand off",
      "effect": "Record state for later"
    }
  ],
  "default": "instrument",
  "mode_policy": {
    "low": "use_default",
    "medium": "ask",
    "high": "ask",
    "autonomous": "use_default_or_escalate"
  }
}
```

The connector maps that request to the host's native mechanism:

- Claude Code can use its user-question tool.
- Codex can use the interactive question mechanism exposed by its host.
- A non-interactive host can use the declared default, pause the run, or
  fail clearly, depending on the mode policy.

The output is structured:

```json
{
  "decision_id": "fix.no_repro_next_step",
  "selected": "instrument",
  "answered_by": "operator",
  "source": "host_user_question",
  "rationale": "Try one diagnostic pass before closing no-repro."
}
```

## How This Changes Flow Planning

Future work should start by asking:

1. Which blocks does this flow compose?
2. Which inputs and outputs are already available?
3. Which evidence is flow-specific?
4. Which routes are allowed by mode?
5. Which block is missing and should be built generically?

This means Build, Fix, Review, Pursue, and custom flows are not necessarily
separate implementation towers. They should be different schematics over
a shared set of blocks.

## Product Direction

Do not treat feature parity as the only goal.

The better opportunity is to make Circuit a flow assembly system: a small
catalog of trustworthy blocks that can be composed into built-in flows and,
eventually, user-authored flows. Old Circuit's flow list is a source of
examples, not a ceiling.
