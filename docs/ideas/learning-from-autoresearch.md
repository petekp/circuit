# Learning from autoresearch: what to borrow, and what not to

Status: `current-comparison`. This note maps `karpathy/autoresearch` against
Circuit's current code and decides, idea by idea, what is worth borrowing.
Three ideas are being built on `feat/autoresearch-borrow`; two are deliberately
declined. Cited file and line references are from the 2026-06-28 working tree
and drift; re-read before building.

## What autoresearch is

`karpathy/autoresearch` is a small overnight research harness. An AI agent is
handed a single-GPU LLM training setup and told to experiment on its own: edit
`train.py`, train for a fixed 5-minute budget, read `val_bpb` (validation bits
per byte, lower is better), keep the change if the number improved, `git reset`
if it did not, and repeat. About 100 experiments run per night while the human
sleeps. The human never touches the Python. Instead they edit `program.md`, the
Markdown that sets up the loop, the keep-or-discard rule, the ledger schema, and
a simplicity criterion. Karpathy calls that file "a super lightweight skill." The
harness is keep-best hill-climbing on a quantitative metric, ratcheted by git,
with a read-only eval (`prepare.py`) the agent cannot touch, looping forever
until someone interrupts it.

The shapes here rhyme with Circuit's until-loop, but the aim is the opposite.
autoresearch optimizes a number and never stops on its own. Circuit's Converge
loop converges on a proven-done boolean and is bounded three ways by design. That
difference is the whole analysis below.

## The five ideas, ranked

| # | Idea | Leverage | Effort | Recommendation | Why in one line |
|---|------|----------|--------|----------------|-----------------|
| 1 | frozen-eval | high | M | **Build (Slice 1 only)** | Nothing stops a Converge body from editing its own verify command and false-greening; a detective latch on the evidence floor closes it. |
| 2 | experiment-ledger | medium | S | **Build (as a trace projection)** | The operator should see what every pass tried, including discards; derive it from the trace, do not add a fourth state store. |
| 3 | program-as-skill | medium | M | **Build (stripped core only)** | Let `circuit generate` reach the Converge shape it cannot emit today; drop the ML framing and the demo. |
| 4 | optimize-loop | medium | M | **Document** | A keep-best metric ratchet needs an ungameable oracle Circuit does not have, and its natural terminus is the success-through-exhaustion the loop forbids. |
| 5 | bounded-vs-unbounded | low | M | **Skip** | Circuit already has stronger bounds and the opposite (better) stop semantics; naming autoresearch in positioning only imports an ML mental model. |

## Build plans

### 1. frozen-eval: read-only verify surface for the Converge loop

The real gap. `fix-until-green`'s act step is a bare implementer relay with full
default tools and no equipment scope (`src/flows/fix-until-green/assembly-spec.ts`).
It can edit the test files, the `package.json` test script, or the run-folder plan
report that the verify step reads back every pass. The verify step then reports
`passed`, `latestProofContradictsClose` reads a now-green proof
(`src/runtime/run/graph-runner.ts`), and `defaultUntilEvidenceFloor` clean-stops
on a gamed metric. autoresearch blocks this with a hard file partition: only
`train.py` is editable, `prepare.py` is read-only. Circuit can express the same
shape in its own evidence-floor idiom.

Build Slice 1 (the detective latch) only. Skip the connector write-deny: a
path-scoped firewall needs a connector capability that may not exist, and a
preventive firewall is a step away from Circuit's detective-over-preventive
instinct. The incentive case here is also weaker than autoresearch's adversarial
tournament, so the minimal honest version is the right size.

Files and slices:

- Add optional `frozenPaths` to the `iterates_until_condition` engine flag in
  `src/flows/types.ts` (`CompiledFlowEngineFlags`) and the matching manifest and
  assembly-spec shape. Express it generically as "the resolved verify-command
  source," not anything ML-shaped.
- At the tail seam in `src/runtime/run/graph-runner.ts`, before the floor
  disposes `goal_met`, compute the git-proven touched-file set for the iteration
  against a per-iteration baseline.
- On any intersection with `frozenPaths`, open a honesty-ledger overclaim latch
  ("eval surface modified during iteration N"). `hasOpenLatches()` then forces the
  floor to refuse to honor that pass, and the loop re-enters or exhausts to
  needs-attention. This is autoresearch's git-reset-on-cheat, written as a refusal
  to honor a `goal_met` claim from a tampered pass.
- Wire `fix-until-green` to set `frozenPaths` from its own resolved command
  source (the test script plus the plan report path) as the first customer.
  Default off everywhere, byte-identical when absent.

Required e2e (write the failing test first): an offline `fix-until-green` run
whose body edits the test script gets latched open and re-enters or exhausts to
needs-attention instead of stopping `complete`. Pair it with a control run that
leaves the verify surface alone and stops clean, so the latch is proven the sole
cause.

### 2. experiment-ledger: a per-pass record the operator can read

autoresearch's `results.tsv` is the legible record of the night: one row per
experiment, `{commit, val_bpb, memory_gb, status, description}`, including the
discards and crashes the git ratchet throws away. The agent reasons over it
("combine previous near-misses") and the human reads it in the morning. Circuit
has no equivalent operator-facing per-pass record. `carried-notes.ts` is capped,
free-text, and framed as instructions for the next pass; the honesty ledger is
delete-on-resolve, not a history.

The honest fix is still a projection, not a fourth persisted store. But a probe of
the tail seam (AGENTS.md rule 7) corrected the original plan. The plan assumed the
trace already carried every per-pass fact and only a projection was missing. It
does not. At `graph-runner.ts` the judge's `goalProposed`, the computed
`evidenceConfirmed`, and the resulting `disposition` are read, used to pick the
route, and then thrown away. None of them lands on the trace. The single most
valuable row, "the judge proposed done but the floor refused because a latch was
open," is exactly the one the trace cannot currently reconstruct.

So the missing fact is bigger than one index field: it is the judgment itself. The
fix records it as one new trace entry, `run.until-judgment`, written once at the
tail per iteration. This is not the dual-write the plan feared. A dual-write is a
second persisted store kept in sync by hand; this is one more event kind in the
trace, which is the single source of truth, with the projection strictly
downstream of it. The trace stays the only store, and it gains an audit record it
should always have had. The per-iteration judgment entries also serve as the
iteration delimiters, so the separate `until_iteration_index` field the original
plan called for is unnecessary.

Files and slices:

- Add `RunUntilJudgmentTraceEntry` (kind `run.until-judgment`) to
  `src/schemas/trace-entry.ts`: `{step_id, iteration, goal_proposed,
  evidence_confirmed, disposition (stop-clean|reenter|needs-attention),
  no_progress_count, open_latch_count, lesson?}`, with a refine that a stop-clean
  disposition requires both booleans true (mirroring `disposeIteration`). Add it to
  the `TraceEntry` union. Stamp it at the tail seam after the disposition is final,
  only on a judge-gated loop. Byte-stable on every non-until run (no entry emitted).
- Write a pure read-time projection `iterationLedgerFromTrace(trace)` that folds
  the judgment entries into typed per-pass rows and brackets each iteration's relay
  usage by the entries that precede its judgment. A projection cannot drift.
- Render an opt-in Markdown table into the operator summary, gated simply on the
  projection being non-empty (the presence of judgment entries is the gate, so no
  separate engine flag is needed and non-until summaries stay byte-identical).
- Defer feeding the structured ledger back into the head prompt. That is a
  prompt-shape change with its own blast radius and belongs in a later A/B, not
  this slice. An iteration that exhausts its in-step retries before reaching the
  tail emits no judgment entry; surfacing that rarer shape is the next slice.

Required e2e: an offline multi-iteration judge-loop run yields one row per pass
with the correct stop-clean / reenter sequence and populated usage and latch
columns, plus a tamper pass whose row shows `goal_proposed` true but
`evidence_confirmed` false with an open latch, the record `carried-notes` never keeps.

### 3. program-as-skill: let `circuit generate` emit the Converge shape

This is mostly validation (see "What this validates" below), but there is one
buildable gap inside it. The composer builds a schematic but never sets engine
flags; the role vocabulary has `loopBackTo` for bounded recovery but no
until-condition field, so `circuit generate` cannot reach the Converge shape even
though the engine and compile path already support it. `program.md` is a Converge
loop written in Markdown, so closing this leg is on the encode-your-process wedge.

Build the stripped core only. Drop the `program.md` framing, the ML use case, and
the "feed a `program.md` through generate and watch it compose" demo (that demo is
a tweet, not a capability).

Files and slices:

- Slice 1, deterministic, no model: add a `convergeUntil` field to
  `CompositionRole` in `src/flows/composition/composer.ts` and have spec assembly
  emit `engine_flags.iterates_until_condition` wired to the proven `fix-until-green`
  shape (head act, body act/verify/judge, tail judge, stop judge on `goal_met`,
  carried notes, max iterations, needs-attention route).
- Add a gate in `src/flows/composition/evaluate.ts` that rejects a Converge role
  set lacking a run-verification step in the body. This is the load-bearing line:
  it makes a generated Converge flow fail closed exactly like `fix-until-green` and
  inherit the evidence floor, which keeps the generated shape on the
  bounded-honesty thesis instead of drifting toward loop-forever.
- Prove offline that a hand-written Converge role set composes, grades runnable,
  and the compiled flow carries the flag, and that a verify-less Converge role set
  walls.
- Defer the proposer-prompt vocabulary (teaching the model to propose Converge)
  until Slice 1's floor is test-locked. Never build the ingest demo.

Required e2e: an offline composition test where a hand-written Converge role set
compiles to a runnable flow carrying `iterates_until_condition` and passes the
floor, and a sibling verify-less role set is rejected by the new gate.

## Document / skip

- **optimize-loop, document.** A keep-best metric ratchet only stays honest when
  the metric is a read-only oracle the agent cannot touch (autoresearch's
  `prepare.py`). Circuit's analog is a worker-adjacent verify command, so the
  moment the body can influence the number, the ratchet launders Goodhart gaming
  as monotone progress. Worse, an optimizer's natural terminus is
  exhaust-and-keep-best, which is exactly the success-through-exhaustion path the
  until-loop was built to make unreachable. The lineage is captured in
  `until-loop.md` under "Why Converge gates on a boolean, not a metric," with two
  reusable nuggets recorded without the loop: carried-notes could optionally carry
  a verify command's numeric result as read-only context, and `commit-containment.ts`
  could gain a revert-to-champion op if a trustworthy metric oracle ever lands. Do
  not build the loop.

- **bounded-vs-unbounded, skip.** Both halves fail the bar. The bounds,
  comparability, and "human edits the Markdown not the code" framing already exist
  in Circuit, with stronger guarantees: an iteration cap, a fail-closed cumulative
  budget, a no-progress ceiling, and inverted stop semantics that make false-done
  unreachable. The only true gap is the scalar metric hill-climb, which is the
  optimize-loop idea above and a different feature class. Naming autoresearch in
  `positioning.md` would anchor readers on "Circuit is the bounded version of that
  ML thing" and import an optimize-a-number mental model the honesty thesis
  rejects, for near-zero new insight. The one-sentence deferral lives in
  `until-loop.md`, not positioning.

## What this validates

autoresearch is most useful as outside confirmation of two bets Circuit already
placed.

- **Skills-to-circuits, encode-your-process.** Karpathy independently lands on
  "the human edits the Markdown, the agent edits the code, and the Markdown is a
  lightweight skill." That is Circuit's whole premise: a flow is the encoded
  process, and `circuit generate` already turns a plain task into a runnable
  schematic. Circuit goes one step further than autoresearch by putting a validity
  floor under the Markdown (compose, validity, runnability) that `program.md` has
  no equivalent for. The portable `.flow.md` prototype is the same instinct from
  the other direction. So `program.md` validates the wedge and sharpens the
  differentiator: Circuit's version is gated, autoresearch's is interpreted.

- **Bounded vs unbounded autonomy.** autoresearch's `program.md` says "NEVER
  STOP, the human might be asleep." Circuit deliberately chose the opposite: an
  overnight run is safe to leave unattended precisely because it is bounded three
  ways and converges on proven-done rather than looping forever. autoresearch is
  the clean negative example. It works because `prepare.py` is a read-only oracle
  and the metric is ungameable; remove that oracle and loop-forever becomes a
  machine for laundering gamed metrics. That is the failure mode Circuit's evidence
  floor and honesty ledger exist to prevent, and the frozen-eval build above is the
  one place worth importing the oracle's shape (a read-only verify surface) without
  importing the unbounded loop around it.
