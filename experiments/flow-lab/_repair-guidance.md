# Repairing a rejected flow

A verifier checked the flow you proposed and REJECTED it. The cause is specific:
it might be a step whose required input no earlier step produces, OR a step that
uses a name outside the allowed vocabulary (a wrong stage, block id, or execution
kind). Read the verifier's exact error, match it to a rule below, and change only
what the error names. Revise your role set so it passes.

You will be given: the original task, the flow you proposed, and the verifier's
exact error(s). Read the error and apply the matching rule below.

## Error → fix

- **"expected exactly one report writer for schema 'X.brief@v1'" or "'X.intake@v1'", found 0**
  A step you chose is tied to a specific family ("X") and needs that family's
  opening report, which your flow does not produce. Usually the culprit is an
  optional step. Fixes, in order of preference:
  1. Remove the step that triggers it. `plan` and model-only `diagnose / compose`
     analyze steps are OPTIONAL — drop them for a leaner flow.
  2. If you truly need that step, open the flow with the matching opener.

- **"no input set satisfiable ... needs one of [flow.brief@v1, diagnosis.result@v1] OR [flow.brief@v1, plan.strategy@v1]"** (on an `act` step)
  Your `act` step has nothing to act on. Put a `diagnose` (relay, researcher)
  step OR a `plan` (compose) step BEFORE the `act` step, so the implementer has a
  diagnosis or a plan to work from.

- **"no input set satisfiable ... needs one of [goal.contract@v1]"** (on a `goal-child-run` step)
  A sub-run step requires the supervisor opener. Use `goal / compose` as your
  `frame` step whenever you use one or more `goal-child-run` sub-run steps.

- **"run-verification ... requires reading 'prototype.variant-aggregate@v1'"** (after a fanout)
  After an `act / fanout` step, a separate `run-verification` step is tied to the
  fanout's internals and will not bind. For a fanout flow, do NOT add a
  `run-verification` step — go from the `act / fanout` step to a `review` step
  (relay, reviewer) and then `close`. The fanout's branches verify themselves.

- **"Invalid option: expected one of ..." (naming the stage names)**
  A step's `stage` is not one of the seven allowed stages. Set every step's `stage`
  to one of, and keep them in this order: frame, analyze, plan, act, verify,
  review, close.

- **"... unknown block id"**
  A step's `block` is not in the menu. Use only these exact block ids: frame,
  review-intake, goal, gather-context, diagnose, plan, act, run-verification,
  review, close-with-evidence, goal-close, goal-child-run. Do not invent a block —
  the close block is `close-with-evidence`, not `close`.

- **"no registered actual for <block>/<kind> ..."**
  The block is real but paired with the wrong execution kind. The fixed kinds are:
  frame → compose or checkpoint; plan → compose; gather-context, act, and review →
  relay; diagnose → relay or compose; run-verification → verification (NOT relay);
  close-with-evidence and goal-close → compose; goal-child-run → sub-run; a parallel
  act → fanout. Set this step's `executionKind` to the one its block supports.

## General principles

- A runnable flow keeps its steps in ONE coherent family wherever possible. The
  cleanest runnable shapes are: frame → (gather-context) → diagnose → act →
  run-verification → close, optionally with `loopBackTo: "act"` on verify.
- Leaner is safer. If a step is optional and triggers an error, remove it.
- Always end at a `close` step marked `terminal: true`.

Output ONLY the revised JSON role set (same format as before). No prose.
