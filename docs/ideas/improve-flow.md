# Improve flow: Circuit's outer loop

Status: `current-proposal`. Product and flow design only. Nothing here is
shipped behavior.

## One line

Add an `Improve` flow that studies past Circuit runs, ranks the signals that
matter, and proposes one bounded change to a flow, check, Skill Hook, Power
policy, eval, or doc. The result should be a branch or proposal packet backed by
Trace, Report, Evidence, and Git refs, not an invisible self-modifying system.

## Why this belongs in Circuit

The interview's useful point is not "agents should loop forever." It is that the
loop becomes the product once the system can learn from its own work without
turning human judgment into a bottleneck.

Circuit already has the right raw material:

- a Flow is the named kind of work;
- a Schematic is the authored definition;
- a Run writes a Trace, Reports, and Evidence into a Run folder;
- Checkpoints capture operator decisions at declared boundaries;
- Skill Hooks record deterministic signals and can inject local expertise;
- Power is already a run-level model dial that materializes per relay.

`Improve` is the flow that turns those records into a controlled outer loop. It
should not replace Build, Fix, Explore, Review, or Prototype. It studies them
afterward and asks: "What should be made sharper before this kind of work runs
again?"

## What Improve is not

`Improve` is not an autonomous daemon that edits `main`.

It is not memory authority. History recall and memory can suggest where to look,
but they cannot satisfy proof, policy, route, checkpoint, recovery, or
verification authority.

It is not the until-loop. The until-loop repeats work inside a run until a
condition is proven. `Improve` is the outer loop: it reads many runs and proposes
changes to the system that will run next time.

It is not a generic "make Circuit better" prompt. Each run should leave one
bounded proposal or say "no change worth making."

## Operator story

An operator runs:

```bash
./bin/circuit run improve --goal "Find one high-leverage improvement for Fix from the last two weeks"
```

Circuit reads the recent run folders and any configured Git or CI evidence. It
groups repeated failures, evidence gaps, false-done catches, costly retries,
Skill Hook misses, repeated checkpoint choices, Power escalations, and operator
corrections. It ranks them. Then it proposes exactly one change.

The proposal might be:

- add a deterministic check to a Schematic;
- adjust a Skill Hook policy or hook surface;
- add or update an eval;
- revise a flow contract or authoring doc;
- tighten a Power floor or ceiling;
- open a focused follow-up branch;
- say that the evidence is too weak and stop.

The operator sees the evidence packet first. Any write happens behind a
Checkpoint or explicit branch/PR step.

## Flow shape

V1 can be a normal single-pass flow. It does not need a new engine loop.

1. **Frame.** Resolve the target: one flow, one time window, and one allowed
   proposal kind. Record the budget and the no-go areas.
2. **Gather signals.** Read run folders, traces, reports, operator summaries,
   history index entries, Git commits, test output, and optional CI metadata.
3. **Rank signals.** Prefer repeated, recent, expensive, operator-confirmed, or
   correctness-affecting signals. Down-rank single noisy failures.
4. **Build a claim inventory.** Separate repo facts, observed run evidence,
   operator-declared intent, external-source context, and strategy inference.
5. **Choose one proposal.** Pick the smallest change with the strongest evidence
   and a clear verification path.
6. **Draft the change packet.** Emit a typed proposal report with files, risk,
   evidence refs, verification plan, and expected behavior.
7. **Checkpoint.** Ask the operator whether to stop at the proposal, create a
   branch, or apply a narrow patch.
8. **Close honestly.** Report accepted proposal, rejected proposal, or
   insufficient evidence. Never close as improved just because the budget ran
   out.

## Report shape

The first version should bias toward inspectable reports over new runtime magic.

`improve.signals@v1`

- `target_flow`
- `window`
- `signals[]`
- `source_refs[]`
- `excluded_signals[]`
- `cost_observations[]`

`improve.proposal@v1`

- `proposal_kind`
- `summary`
- `evidence_refs[]`
- `claim_inventory[]`
- `risk`
- `files_or_surfaces`
- `verification_plan`
- `why_one_change`
- `why_not_auto_apply`

`improve.result@v1`

- `status`: `proposed`, `applied`, `declined`, `insufficient_evidence`, or
  `blocked`
- `proposal_ref`
- `branch`
- `verification_evidence[]`
- `remaining_questions[]`

## Signal policy

Good signals:

- the same check fails across several runs;
- a reviewer repeatedly catches the same evidence gap;
- a Checkpoint receives the same operator decision several times;
- a Skill Hook fires too late, too often, or misses an obvious file surface;
- Power escalates reactively on the same role or flow;
- a run stops honestly for a reason that could become a deterministic check;
- operator feedback says the same flow step is confusing or wasteful.

Bad signals:

- one-off model weirdness with no recurrence;
- stale history with no current source check;
- memory-only claims;
- "the agent thinks this would be better" with no evidence;
- broad architecture rewrites with no bounded first proof.

## First useful slice

Start with a proposal-only `Improve` flow for one target flow and a local run
window. It reads existing run artifacts, emits `improve.signals@v1` and
`improve.proposal@v1`, and stops at a Checkpoint before any write.

The first build should not add live mutation, background scheduling, or a daemon.
If it cannot produce a strong proposal, that is a valid result. A quiet no-change
answer is part of the product.

## Later slices

- Branch mode: apply one approved docs or eval change on a new branch.
- Flow mode: propose Schematic or check edits, verified by flow drift and
  focused tests.
- Skill Hook mode: suggest hook policy changes from repeated file or evidence
  signals.
- Power mode: suggest conservative Power bounds from repeated escalation or cost
  evidence.
- Batch mode: run across several flows and return only the highest-leverage
  proposal.
- Scheduled mode: run weekly, but only notify when the evidence clears a high
  threshold.

## Constraints

- Keep flows as the operator-facing entry point. `Improve` should be a Flow, not
  a hidden subsystem.
- Keep the runtime flow-neutral. Flow-specific improvement logic belongs in the
  flow package, reports, registries, or docs.
- Keep history hint-only. The proposal must cite authoritative traces, reports,
  files, commits, checks, or operator-declared decisions.
- Keep writes explicit. V1 should stop at a Checkpoint before patching.
- Keep cost bounded. A run needs a fixed window, max signals inspected, max
  proposal count, and relay budget.
- Keep the human on the loop. The operator approves policy, Schematic, docs, and
  eval changes before they become durable.

## Relationship to nearby ideas

Three of these notes were consolidated into
[`deprioritized-ledger.md`](./deprioritized-ledger.md); their readings still
hold.

- The self-improving-circuit note is the older seed: learn from runs and
  propose updates to maintained docs. `Improve` generalizes that into a public
  flow that can propose checks, evals, Skill Hooks, Power policy, and docs.
- `until-loop.md` is an inner-loop engine primitive. `Improve` can use it later,
  but V1 does not need it.
- The local-sqlite read-model note would make the signal gathering fast, but
  the read model should remain derived. Traces and run artifacts stay
  authoritative.
- The skill-hooks uncovered-cases note is a good first target class: repeated
  uncovered cases can become `Improve` signals.

## Claim inventory

| Claim | Kind | Confidence | Evidence posture |
| --- | --- | --- | --- |
| Circuit already records run traces, reports, evidence, checkpoints, Skill Hooks, and Power decisions. | repo fact | high | Check current contracts, run-process docs, and trace schemas before building. |
| History and memory should remain hint-only. | product constraint | high | Matches current Circuit history posture; do not let Improve treat recall as authority. |
| The interview's "agent recipe" idea maps better to Circuit's Schematic plus run evidence than to a renamed file format. | strategy inference | medium | Useful framing, not implementation truth. |
| A proposal-only Improve flow can ship before any new engine loop. | architecture inference | medium | Needs a Schematic and report design, but no obvious new runtime primitive. |
| Branch/apply mode should wait until proposal quality is proven. | safety inference | high | Avoids self-modifying slop and keeps operator authority clear. |

## Starter build goal

```text
/goal Design and implement the first proposal-only Circuit Improve flow, verified by a generated public flow package, focused flow/catalog drift checks, report-schema tests for improve.signals@v1 and improve.proposal@v1, and one fixture or proof run that reads local run evidence and stops at an operator checkpoint before writes, while preserving existing Run semantics, hint-only history authority, flow-neutral runtime boundaries, and explicit operator approval for durable changes. Use only /Users/petepetrash/Code/circuit, the existing docs/contracts, src/flows authoring model, run artifacts, and local test commands. Between iterations, inspect the newest verification or compatibility result, patch the smallest defensible gap, and keep the flow proposal-only until the evidence says branch/apply mode is safe. Before completion, adversarially review the result against this Goal, classify findings by severity, and resolve all medium, high, and critical findings. After a clean review, run one more adversarial review; complete only after two consecutive reviews have no medium-or-above findings. If blocked or no defensible path remains, stop with attempted paths, evidence gathered, unresolved findings, blocker, and next input needed.
```

## Open questions

- Should `Improve` target one flow per run, or can a project-wide run pick the
  flow with the strongest signal?
- What minimum recurrence threshold prevents noise without missing one severe
  correctness issue?
- Which proposal kinds are safe to patch automatically after approval, and which
  should always stop at a spec?
- Should cost and token evidence become first-class trace summaries before
  `Improve` relies on them?
- What is the first proof dataset: Fix false-done catches, Build evidence gaps,
  Skill Hook misses, or Power escalation patterns?
