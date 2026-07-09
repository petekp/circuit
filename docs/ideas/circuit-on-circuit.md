# Circuit on Circuit

Status: current-proposal. A program note. The practice half is allowed work
under the v1 freeze; every build move in it is post-v1.
Date: 2026-07-08
Source: operator strategy question, 2026-07-08: what is the smartest,
most high-leverage way to use Circuit in the evolution of Circuit itself?
Related: [`improve-flow.md`](./improve-flow.md),
[`run-close-learning-capture.md`](./run-close-learning-capture.md),
the self-improving-circuit entry in
[`deprioritized-ledger.md`](./deprioritized-ledger.md),
[`flow-ideas.md`](./flow-ideas.md),
[`intra-run-decision-carry-forward.md`](./intra-run-decision-carry-forward.md),
[`dynamic-flow-ratchet.md`](./dynamic-flow-ratchet.md)

## Short Version

The highest-leverage use of Circuit on Circuit is not dogfooding for QA.
It is making Circuit development the first corpus for the compounding
loop: the run-to-flow-improvement back-edge that the pitch promises and
the codebase does not have.

Every run already leaves a durable record under `.circuit/runs/`. Nothing
reads those records back to make the flows better. Build that back-edge
report-only, and feed it with Circuit's own development runs first.
Circuit development is the one place with a steady stream of real runs,
real friction, and an operator who notices when a proposed improvement is
wrong.

The reframe: Circuit on Circuit is not a QA program. It is user zero for
the compounding feature.

## Why This And Not More Dogfooding

Three things line up on this one move.

1. **It is the stated frontier.** The encode half shipped: five public
   flows, `circuit generate`, the promote spike. The compound half, "your
   process gets better because you ran it," is still prose. This program
   builds it.
2. **It dissolves part of the eval problem.** The eval program fights
   synthetic task sets, hidden checks, and judge calibration. Circuit dev
   tasks are live evals with free ground truth: did verify pass, did the
   PR merge, did the release ship, did the operator bail out of the flow
   into raw chat. No judge needed for those outcomes.
3. **It is the launch story after the launch story.** "Circuit ships
   Circuit releases, and its flows improve from their own run history" is
   a receipt with evidence behind it. Per the honesty rule, none of that
   may be claimed until it is true.

## What Already Exists

This doc is the program, not the first design in the space. The
mechanisms are already sketched; what none of them name is the corpus and
the sequencing.

- [`improve-flow.md`](./improve-flow.md) is the mechanism: study prior
  runs, rank signals, propose one bounded change, stop at a Checkpoint
  before any write. This program gives Improve its first corpus and its
  priority slot.
- [`run-close-learning-capture.md`](./run-close-learning-capture.md) is
  the memory lane: one cited, hint-only lesson per run, read by later
  runs of the same flow. Complementary, not competing. A lesson points
  attention inside an unchanged flow; the back-edge changes the flow.
  Both read the same run evidence.
- The self-improving-circuit note (consolidated into
  [`deprioritized-ledger.md`](./deprioritized-ledger.md)) is the doc
  lane: propose diffs to docs the operator already owns.
- [`flow-ideas.md`](./flow-ideas.md) ranks Improve and Promote in the
  post-v1 stack. The distinctions matter: `generate` writes a flow from a
  description, `promote` graduates a run into a new flow, and Improve
  reads accumulated runs and proposes an edit to a flow that already
  exists. The third one is the compounding edge.
- The v1 launch plan's deferred list names "Circuit developing Circuit,
  the compounding loop" in one bullet. This doc is now that bullet's
  home.

## The Program

Three moves, sequenced around the freeze.

### Move 1: instrument the runs we already do (now, zero code)

Run the v1 release work itself through the public flows wherever a flow
is load-bearing. While doing that, keep a friction ledger as a plain
committed doc: one line per run.

A ledger line records: date, flow, run id, what fought the work, and how
much it cost. "What fought the work" means a check that misfired, a
checkpoint the operator overrode, a prompt that pushed against the task,
or the operator abandoning the flow for raw chat.

Bail-to-chat is the single most valuable signal. Treat it as data, not
failure. A bail event marks exactly where the encoded process and the
real process diverge, which is exactly what the back-edge needs to learn.

Suggested home: `docs/release/friction-ledger.md`, since the release push
is the first arena. It can move if the practice outlives the release.

This move is allowed under the freeze. Running flows on release work is
release mechanics; the ledger is a doc.

### Move 2: build the back-edge, report-only (first feature after the announcement)

Build the Improve flow's first slice as specified in
[`improve-flow.md`](./improve-flow.md), pointed at the accumulated
Circuit-repo run folders plus the friction ledger. One bounded proposal
per invocation, cited to run evidence, stopped at a Checkpoint. The
operator accepts, edits, or rejects. An accepted proposal lands as a
normal reviewed change.

Nothing auto-applies. That floor is already settled in the memory docs
and it holds here: no self-editing flow, no automatic schematic mutation.
A bad proposal must be annoying, never dangerous.

### Move 3: encode the first full dev process (the release runbook)

The release process is the best first candidate for a fully encoded
Circuit-dev flow. It recurs every release. It is checklist-heavy and
expensive to get wrong. Half of it is already mechanical: the
version-surface gate machine-writes and checks all six version surfaces,
and the first-run container lab is a standing pre-release step. A release
flow turns the rest of the runbook into steps with checks and evidence.

Second candidate: the add-a-flow playbook in
`docs/flows/authoring-model.md`, which is already a step-by-step process
in prose.

Each encoded process feeds Move 2: its runs become more corpus.

## Guardrails

- **The ceremony trap.** The per-relay process-skills experiment returned
  null: 6 of 12 in both arms, ceremony not leverage. So the rule is to
  route work through a flow only when the flow is load-bearing:
  multi-step, gated, or evidence-demanding. Forcing one-line fixes
  through flows distorts the corpus and burns operator patience, and the
  back-edge would learn from distorted data.
- **Report-only floor.** Proposals never auto-apply. Same floor as the
  memory lane's non-goals.
- **Honesty rule.** No public claim that Circuit improves itself until
  the back-edge ships and has receipts.
- **The freeze.** Nothing in Moves 2 or 3 builds before the
  announcement. Move 1 starts immediately.

## Success Test

Within two releases of the back-edge shipping:

1. The friction ledger has entries from real runs, including at least one
   bail-to-chat event.
2. An Improve run reads the run folders and the ledger and proposes one
   flow edit with cited evidence.
3. The operator disposes of it at a Checkpoint.
4. At least one accepted proposal traces back to a ledger entry.
5. The release that ships this ran through a flow itself.

That would make the compounding half of the pitch demonstrated, not
asserted.

## Non-Goals

- No auto-applied flow or schematic edits, ever, under this program.
- No forcing all Circuit dev work through flows. Load-bearing work only.
- No new memory schema. The memory lane is a sibling, not a dependency.
- No replacement for the eval program. Live dev runs give cheap breadth
  and real stakes; controlled evals give comparisons. Both stay.
- No claim of self-improvement before the receipts exist.

## Open Questions

- Ledger grain: one line per run, or one line per friction event?
- Does the back-edge read `.circuit/runs/` directly, or through a derived
  read model? The local-sqlite read-model idea (consolidated into
  [`deprioritized-ledger.md`](./deprioritized-ledger.md)) sketched one.
- How many runs does the corpus need before proposals beat noise? The
  stress-test logic from the self-improving-circuit note applies: dry
  run the judgment manually first, and if signal-to-noise is bad, fix the
  trigger threshold before building more.
- Does the release flow live as an internal flow first, like sweep and
  cross-tool-build, and graduate on the same evidence bar?
