---
name: run
description: >
  The primary Circuit router. Classifies any task into one of five workflows
  (Explore, Build, Repair, Migrate, Sweep), selects a rigor profile
  (Lite, Standard, Deep, Tournament, Autonomous), and dispatches. Also accessible
  as /circuit:run. Quiet by default: routes and proceeds unless
  ambiguity or risk is material.
trigger: >
  Use for /circuit:run, or when the user describes a coding task.
---

# Circuit: Run

The Circuit router. Classifies tasks, selects rigor, dispatches to the right workflow.

## Invocation

```
/circuit:run <task>                  # Router classifies
/circuit:run fix: <task>             # Repair Lite
/circuit:run repair: <task>          # Repair Deep
/circuit:run develop: <task>         # Build Standard
/circuit:run decide: <task>          # Explore Tournament (decision mode)
/circuit:run migrate: <task>         # Migrate Deep
/circuit:run cleanup: <task>         # Sweep Standard (cleanup objective)
/circuit:run overnight: <task>       # Sweep Autonomous
```

## Intent Hint Resolution

Before routing, check for intent hints in the task prefix.

| Prefix | Workflow | Rigor | Action |
|--------|----------|-------|--------|
| `fix:` | Repair | Lite | Skip routing. Dispatch directly. |
| `repair:` | Repair | Deep | Skip routing. Dispatch directly. |
| `develop:` | Build | Standard | Skip routing. Dispatch directly. |
| `decide:` | Explore | Tournament | Skip routing. Dispatch directly. |
| `migrate:` | Migrate | Deep | Skip routing. Dispatch directly. |
| `cleanup:` | Sweep | Standard | Skip routing. Dispatch directly. |
| `overnight:` | Sweep | Autonomous | Skip routing. Dispatch directly. |
| (none) | (classify) | (auto) | Run routing classification. |

**Spec detection:** If the task includes an RFC, PRD, or spec document (file path
or inline), route to Explore Deep with spec input mode.

## Routing Classification

**Quiet by default.** Route and proceed unless ambiguity or risk is material.

### Step 1: Classify Task Kind

Match signal patterns to determine the workflow:

| Signal Pattern | Workflow |
|---------------|----------|
| "broken", "not working", unexpected behavior, error codes, stack traces | Repair |
| Named alternatives, "should we", architecture-level choice, tradeoff | Explore |
| "understand", "investigate", "what does", "how does", exploration language | Explore |
| RFC/PRD/spec provided for review | Explore (spec mode) |
| Strong cleanup signals (dead code, stale docs, >5 files detritus) | Sweep |
| "run overnight", "improve quality", "stability pass", coverage sweep | Sweep |
| Strong migration signals (framework swap, coexistence needed) | Migrate |
| Everything else (features, refactors, docs, tests, mixed changes) | Build |

**Evaluation order:** Migration signals > Repair signals > Sweep signals > Explore signals > Build (default).

### Step 2: Select Rigor Profile

| Signal | Rigor |
|--------|-------|
| Clear task, known approach, < 6 files | Lite |
| Default (no special signals) | Standard |
| Multi-domain, external research needed, no obvious path | Deep |
| Named alternatives, "should we", architecture decision | Tournament |
| "overnight", "while I sleep", unattended | Autonomous |

### Step 3: Trivial Path Check

If the task is trivial (single file, obvious change, < 3 lines, no ambiguity),
say so and do the work inline. No workflow overhead.

> This is straightforward. Doing it inline.

### Step 4: Dispatch

**If classification is confident** (>80% of tasks):

1. Write `active-run.md` to the run root
2. Show a one-line summary:
   > **Build / Standard** -- I'll plan the change, implement with independent review, then close.
3. Load the workflow skill and follow its instructions.

**If genuinely ambiguous** (mixed signals spanning two workflows):

1. Ask ONE sharp question that changes the workflow. Not a probe for the sake of it.
2. After the answer, dispatch immediately.

### Workflow Previews (for the one-line summary)

| Workflow | Rigor | Preview |
|----------|-------|---------|
| Explore | Lite | "Quick investigation. I'll read the code and write up findings." |
| Explore | Standard | "I'll research externally and internally, then synthesize a plan or decision." |
| Explore | Deep | "I'll research, prove the riskiest assumption, then hand off to Build." |
| Explore | Tournament | "I'll generate competing proposals, pressure-test each, and converge the strongest." |
| Explore | Autonomous | "I'll research and synthesize a plan. Checkpoints auto-resolve. Ambiguous findings deferred." |
| Build | Lite | "I'll plan and implement. Quick self-verify." |
| Build | Standard | "I'll plan, implement, and run an independent review." |
| Build | Deep | "I'll research first, prove the seam, then build with independent review." |
| Build | Autonomous | "I'll plan, implement, and run an independent review. Checkpoints auto-resolve." |
| Repair | Lite | "I'll reproduce, fix, and verify the regression test passes." |
| Repair | Standard | "I'll reproduce, isolate root cause, fix, and run independent review." |
| Repair | Deep | "I'll investigate broadly, isolate, fix, and run contract audit." |
| Repair | Autonomous | "I'll reproduce, isolate, fix, and review. Auto-resolve checkpoints. Escalate on no-repro." |
| Migrate | Standard | "I'll inventory, plan coexistence, then migrate in batches with checkpoints." |
| Migrate | Deep | "I'll inventory dependencies, plan coexistence, then migrate in batches." |
| Migrate | Autonomous | "I'll inventory and migrate in batches. Auto-resolve except coexistence plan." |
| Sweep | Lite | "Quick scan. High-confidence items only, 1 batch." |
| Sweep | Standard | "I'll survey, triage by confidence/risk, then clean in ordered batches." |
| Sweep | Deep | "I'll survey with 9-point evidence adjudication, then clean in ordered batches." |
| Sweep | Autonomous | "I'll run a full quality pass: survey, batch improvements, verify, defer ambiguous items." |

## Run Root Setup

Derive `RUN_SLUG` from the task description: lowercase, replace spaces and
special characters with hyphens, collapse consecutive hyphens, trim to 50
characters. Example: "Fix Auth Bug in Login" produces `fix-auth-bug-in-login`.

```bash
RUN_SLUG="fix-auth-bug-in-login"  # derived from task description
RUN_ROOT=".circuit/circuit-runs/${RUN_SLUG}"
mkdir -p "${RUN_ROOT}/artifacts" "${RUN_ROOT}/phases"

# Update the current-run pointer so session-start.sh picks up the right run
ln -sfn "circuit-runs/${RUN_SLUG}" .circuit/current-run
```

Write initial `${RUN_ROOT}/artifacts/active-run.md`:

```markdown
# Active Run
## Workflow
<workflow>
## Rigor
<rigor>
## Current Phase
frame
## Goal
<task objective>
## Next Step
Write brief.md
## Verification Commands
<TBD during Frame phase>
## Active Worktrees
none
## Blockers
none
## Last Updated
<ISO 8601 timestamp>
```

## After Routing

Load the corresponding workflow skill:

| Workflow | Skill |
|----------|-------|
| Explore | circuit:explore |
| Build | circuit:build |
| Repair | circuit:repair |
| Migrate | circuit:migrate |
| Sweep | circuit:sweep |

Follow the workflow skill's instructions from the Frame phase. Pass the rigor
profile as context.

## Dispatch

All worker dispatch uses `dispatch.sh` with the calling circuit. Adapter
routing comes from `--adapter` or `circuit.config.yaml`.

```bash
# --role must be one of: implementer, reviewer, researcher
"$CLAUDE_PLUGIN_ROOT/scripts/relay/dispatch.sh" \
  --prompt "${step_dir}/prompt.md" \
  --output "${step_dir}/last-messages/last-message.txt" \
  --circuit build \
  --role implementer
```

## Domain Skill Selection

When composing a dispatch prompt, pick 1-2 domain skills matching the affected
code and pass them via `--skills`. Never exceed 3 total skills per dispatch.
If no domain skills apply, omit the `--skills` flag entirely.

## Circuit Breakers

Escalate to the user when:
- A dispatch step fails twice (no valid output after 2 attempts)
- Workers: impl_attempts > 3 or impl_attempts + review_rejections > 5
- Architecture uncertainty during Build (transfer to Explore)
- No reproducible signal during Repair after bounded search
- Regression detected during Sweep batch (revert batch, continue next)
- Batch failure during Migrate (halt, write partial result.md)

Include: counter values, failure output, options (adjust scope, skip, abort).

## Single-User Assumptions

Pattern labels assume familiarity with Circuit vocabulary.
This is intentional. Circuit is a single-user power tool.
