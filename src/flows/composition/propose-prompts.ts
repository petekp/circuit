// Flow-shape composition (experimental, default-OFF): the proposer prompts.
//
// These two constants are the EXACT bytes of the method artifacts that were
// validated by the proposer spike:
//   experiments/flow-lab/_proposer-prompt.md  -> PROPOSER_PROMPT
//   experiments/flow-lab/_repair-guidance.md  -> REPAIR_GUIDANCE
//
// They are inlined here (not read from disk) on purpose: propose.ts ships in the
// built package under dist/, and `tsc` does not copy .md files, so a runtime
// fs read would fail in the installed plugin. Importing this module is inert —
// it only defines two strings.
//
// A byte-equality test (tests/contracts/composition-propose.test.ts) pins these
// constants to the .md files, so any future edit to a prompt that is not mirrored
// here fails CI. The .md file stays the human-readable canonical copy; this is the
// shippable mirror.

export const PROPOSER_PROMPT = `# Flow proposer — turn a task into a flow shape

You are designing a **developer workflow** for one specific task. A workflow is an
ordered list of **steps**. Each step runs one **block** (a unit of work) in one
**execution kind**. The engine runs your steps in order, threading each step's
output to later steps, and closes with a result.

Your job: read the TASK, then emit a JSON **role set** — the ordered list of steps
that best fits this task. Pick the shape the task actually needs. Do not pad.

## The block menu (this is the whole vocabulary — you may only use these)

Each entry is \`block / executionKind\` and what it is for. Stages run in this order:
**frame → analyze → plan → act → verify → review → close**. A step's \`stage\` must
be one of these and steps must be in stage order (a stage may repeat or be skipped,
but never go backwards).

**frame (open the flow — pick exactly one opener):**
- \`frame / compose\` — state the task and success criteria (the standard opener).
- \`frame / checkpoint\` — same, but pause for an operator OK before proceeding (use when the work is expensive or risky to start).
- \`review-intake / compose\` — opener for an **audit-only** task (no code change).
- \`goal / compose\` — opener for a **supervisor** task that will delegate to a whole child flow.

**analyze (understand before acting):**
- \`gather-context / relay\` (relayRole: \`researcher\`) — a worker collects the relevant code/context.
- \`diagnose / relay\` (relayRole: \`researcher\`) — a worker roots-causes the problem.
- \`diagnose / compose\` — model-only analysis (use when no worker delegation is needed, e.g. a research/decision task).

**plan (decide the approach — optional):**
- \`plan / compose\` — write the approach/strategy before acting.

**act (do the work — pick what fits):**
- \`act / relay\` (relayRole: \`implementer\`) — a worker makes the change (the standard "do it" step).
- \`act / fanout\` — run **2+ child flows in parallel** as competing candidates, then keep the survivors. Requires \`fanoutBranches: [{branchId, flowId, goalText}, ...]\` with ≥2 branches. Use for "compare N approaches / generate variants."
- \`goal-child-run / sub-run\` — run **one entire child flow** as this step. Requires \`flowId\` (one of \`fix|build|review|explore|pursue\`) and \`goalText\`. Use when a sub-task is itself a whole flow (supervisor/delegation).

**verify (prove it works):**
- \`run-verification / verification\` — run the checks/tests. Add \`loopBackTo: "act"\` to **retry the change** when verification fails (a bounded recovery loop). Use the loop when failure is likely and worth re-attempting.

**review (independent second look — optional):**
- \`review / relay\` (relayRole: \`reviewer\`) — a different worker reviews the change before close.

**close (terminate — pick exactly one, mark it \`terminal: true\`):**
- \`close-with-evidence / compose\` — close with a result + evidence (the standard close for most flows).
- \`goal-close / compose\` — close for a \`goal\`-opened supervisor flow.

## The four shapes you can build

1. **Linear** — frame → analyze → act → verify → close. The default. Most tasks are this.
2. **Loop** — a linear flow whose verify step has \`loopBackTo: "act"\` so a failed verification retries the change. Use when verification is likely to fail and retrying helps.
3. **Fanout** — an \`act / fanout\` step running 2+ competing child flows in parallel. Use for "compare/try N approaches."
4. **Sub-run** — a \`goal-child-run / sub-run\` step running a whole child flow. Use when a sub-task is itself a full flow (delegation/supervision).

## House patterns (lean toward these)

- Default to the linear spine; only add steps the task needs. A 5–6 step linear flow is normal; a 2-step flow is almost always too thin.
- frame/plan/close → \`compose\`; analyze/act → \`relay\` (researcher then implementer); verify → \`verification\`; review → \`relay\` reviewer.
- Always end at a \`close\` step marked \`terminal: true\`.
- Reach for loop / fanout / sub-run ONLY when the task shape calls for it. Picking the right shape matters more than using a fancy one.

## Output format

Emit ONLY this JSON (no prose, no markdown fence), filling in the roles:

\`\`\`
{
  "id": "kebab-case-id",
  "title": "Short title",
  "purpose": "One sentence: what this flow does for the task.",
  "roles": [
    { "stage": "frame", "block": "frame", "executionKind": "compose" },
    { "stage": "analyze", "block": "gather-context", "executionKind": "relay", "relayRole": "researcher" },
    { "stage": "act", "block": "act", "executionKind": "relay", "relayRole": "implementer" },
    { "stage": "verify", "block": "run-verification", "executionKind": "verification" },
    { "stage": "close", "block": "close-with-evidence", "executionKind": "compose", "terminal": true }
  ]
}
\`\`\`

Per-role fields: \`stage\`, \`block\`, \`executionKind\` always; add \`relayRole\` for relay
steps; \`loopBackTo\` to make a verify step retry; \`flowId\`+\`goalText\` for a sub-run;
\`fanoutBranches\` for a fanout; \`terminal: true\` on the close step.

## Common mistakes to avoid

- Use ONLY the exact block ids and execution kinds from the menu above. The close
  block is \`close-with-evidence\`, not \`close\`. \`run-verification\` runs as
  \`verification\`, not \`relay\`. Every \`stage\` must be one of: frame, analyze, plan,
  act, verify, review, close.

Output ONLY the JSON object for the TASK below. No explanation.
`;

export const REPAIR_GUIDANCE = `# Repairing a rejected flow

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
  1. Remove the step that triggers it. \`plan\` and model-only \`diagnose / compose\`
     analyze steps are OPTIONAL — drop them for a leaner flow.
  2. If you truly need that step, open the flow with the matching opener.

- **"no input set satisfiable ... needs one of [flow.brief@v1, diagnosis.result@v1] OR [flow.brief@v1, plan.strategy@v1]"** (on an \`act\` step)
  Your \`act\` step has nothing to act on. Put a \`diagnose\` (relay, researcher)
  step OR a \`plan\` (compose) step BEFORE the \`act\` step, so the implementer has a
  diagnosis or a plan to work from.

- **"no input set satisfiable ... needs one of [goal.contract@v1]"** (on a \`goal-child-run\` step)
  A sub-run step requires the supervisor opener. Use \`goal / compose\` as your
  \`frame\` step whenever you use one or more \`goal-child-run\` sub-run steps.

- **"run-verification ... requires reading 'prototype.variant-aggregate@v1'"** (after a fanout)
  After an \`act / fanout\` step, a separate \`run-verification\` step is tied to the
  fanout's internals and will not bind. For a fanout flow, do NOT add a
  \`run-verification\` step — go from the \`act / fanout\` step to a \`review\` step
  (relay, reviewer) and then \`close\`. The fanout's branches verify themselves.

- **"Invalid option: expected one of ..." (naming the stage names)**
  A step's \`stage\` is not one of the seven allowed stages. Set every step's \`stage\`
  to one of, and keep them in this order: frame, analyze, plan, act, verify,
  review, close.

- **"... unknown block id"**
  A step's \`block\` is not in the menu. Use only these exact block ids: frame,
  review-intake, goal, gather-context, diagnose, plan, act, run-verification,
  review, close-with-evidence, goal-close, goal-child-run. Do not invent a block —
  the close block is \`close-with-evidence\`, not \`close\`.

- **"no registered actual for <block>/<kind> ..."**
  The block is real but paired with the wrong execution kind. The fixed kinds are:
  frame → compose or checkpoint; plan → compose; gather-context, act, and review →
  relay; diagnose → relay or compose; run-verification → verification (NOT relay);
  close-with-evidence and goal-close → compose; goal-child-run → sub-run; a parallel
  act → fanout. Set this step's \`executionKind\` to the one its block supports.

## General principles

- A runnable flow keeps its steps in ONE coherent family wherever possible. The
  cleanest runnable shapes are: frame → (gather-context) → diagnose → act →
  run-verification → close, optionally with \`loopBackTo: "act"\` on verify.
- Leaner is safer. If a step is optional and triggers an error, remove it.
- Always end at a \`close\` step marked \`terminal: true\`.

Output ONLY the revised JSON role set (same format as before). No prose.
`;
