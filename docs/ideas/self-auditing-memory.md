# Self-Auditing Memory: Circuit's Effectiveness Ratchet

Status: partially implemented design thesis. Slices 1-4 are implemented and
Slice 5 is partly implemented; lifecycle promotion/retirement and automatic
run-close fact write-back remain future work.
Date: 2026-05-29

This doc is the synthesis of an extended design pass: a first-cut design panel, three competing investigations (a pull-query "History Ask" proposal, a capture-feasibility prototype, and an other-model capture report), a cited deep-research survey of the memory field, and a first-principles critique of the popular compound-engineering plugin. It pins down the best approach Circuit can take, framed around the advantages only Circuit's architecture has.

It supersedes the framing in [`project-execution-memory.md`](deprioritized-ledger.md), which remains valid as the cited-fact substrate but was missing the loop that makes the substrate worth building. External grounding lives in [`docs/learnings/codebase-memory-research.md`](../learnings/codebase-memory-research.md).

Updated 2026-05-29 after a soundness-and-durability review ([`self-auditing-memory-review.md`](deprioritized-ledger.md)). The thesis and the messaging held, but several build claims overstated what Circuit captures today. They are corrected inline below. The short version: the typed *shapes* exist, but the cross-run memory identity and most efficiency signals do not yet, so the keystone is net-new plumbing and the honest near-term value is the safety posture, not a working measurement loop.

## 1. The thesis

Every memory system in the field stores a belief and hopes it helps. The cited research found the same blind spot in all of them, from mem0 and Zep to GitHub Copilot and the compound-engineering plugin: none can tell whether a stored item actually improved an outcome or quietly misled the work. Measuring usefulness without trusting the model's own word is the field's open frontier.

Circuit is, as far as this survey found, the system best positioned to close that gap, for an architectural reason: Circuit's runs are comparable to each other. (That is a product thesis grounded in the research, not a verified census of every competitor's internals.) Because flows are a closed set of typed steps, contracts, checks, and a completion gate, two runs of the same flow can be compared directly, in a way that two freeform transcripts never can. And the evidence that makes them comparable is produced automatically as a byproduct of running, with no user action and no model self-report.

So the best approach is not "better memory." It is memory that runs the experiment on itself. Every hint is a hypothesis that has to earn its place by measurable effect on real, comparable runs, and the whole loop is a byproduct of Run, never a command the operator has to remember.

## 2. The gap everyone shares

The research was blunt on this point. Recall benchmarks badly overstate usefulness. Vendor accuracy numbers are gamed and contradictory (the same system scores 58 to 84 on the same benchmark depending on who configured it). Model self-report is unfaithful by construction (biasing a model silently moved its answers while its explanation never mentioned the bias, up to a 36 point accuracy swing). The only shipping proxy anyone has is "delete memories nothing ever recalled," which is a usage signal, not an effectiveness signal.

No competitor has a loop that answers "did this memory help or mislead this run?" That is the thing worth owning.

## 3. Why only Circuit can close it

These advantages are load-bearing, not decorative. Each one is required for the loop to exist.

- **A closed alphabet makes runs comparable.** Flows are declared as typed `schematic.json` packages with a finite set of step kinds and report contracts (see [`dynamic-flow-ratchet.md`](./dynamic-flow-ratchet.md)). That commensurability is the precondition for measuring effect across runs. Freeform transcripts cannot be compared this way, which is exactly why no transcript-based tool can measure usefulness.
- **Evidence is typed and automatic.** `completion_gate` outcome, `step.aborted` reasons, attempt counts, and the newly added `verification.command_evaluated` events are produced as a byproduct of running, with no operator effort. The research named efficiency metrics (tokens and turns to resolution) as the most trustworthy signal precisely because they are mechanical. Honesty check, because this is where the doc previously overstated: the typed shapes exist, but not all are populated yet. `verification.command_evaluated` has emitted zero events in the current corpus (it only fires on flows that run verification commands), there is no token-usage field anywhere in the code, the envelope's `clean_streak` is currently coarse (hardcoded by outcome, not a graduated streak), and its `started_at`/`completed_at` are the same snapshot so elapsed time is zero. So the only honestly-measurable per-run signals today are the abort reason and the binary run outcome. The richer efficiency metrics are capture work this design names, not something it can assume already ships.
- **The memory contract is cited, hint-only, and machine-checkable for staleness.** `MemoryInputV0` can carry a source ref plus sha256 plus a staleness state plus `authority:"hint_only"`. The sha256 is optional, and the Zod `superRefine` enforces hash equality only when both the record hash and the ref hash are present, so this makes staleness machine-checkable when a hash exists, not correctness guaranteed. `RunMemoryUpdateEvent` (`src/schemas/run-envelope.ts`) is an event contract with four actions (`proposed`, `recorded`, `skipped`, `rejected`) that requires source refs and an operator indicator. Those actions are the transitions of a memory-item lifecycle, defined in the next section, though the transitions are not enforced today. This staleness check is still more deterministic than the closest shipping analog (GitHub Copilot re-reads a prose citation with the model; Circuit compares a hash).
- **One door.** Run selects and sequences the process. Capture, measurement, and pruning all happen inside a run, so the valuable work cannot be skipped by a busy operator. This is the structural answer to the failure mode of command toolkits, where the step that is supposed to make work compound is gated on the user remembering to invoke it.

## 4. The architecture: a closed loop

Each step leverages a named advantage and defends a named pitfall from the research.

1. **Produce cited facts from typed evidence, not reflective prose.** Distill facts like the repo's verification command (from `verification.command_evaluated`) and recurring abort reasons (from clustered `step.aborted`). Each is cited to a real run artifact with a hash. (A third candidate — "risky subsystems from source paths recurring across aborted runs" — turned out not to be grounded: the Slice 5 spec found `source_path` names a run-artifact slot, not a repo file, so that signal is deferred until a repo-path-bearing primitive exists, the same honesty correction as the `verification.command_evaluated` coverage note in section 3.) *Advantage: typed evidence. Pitfall defended: over-generalization and self-reinforcing loops, which the research tied specifically to narrative "lessons" memory.*
2. **Inject by earned precision, not guessed relevance.** Push only a tiny set of hints with a non-negative measured effect and a fresh source. Everything else is reachable by pull. *Advantage: the measurement loop. Pitfall defended: the distractor effect, where a topically similar but wrong hint costs real accuracy. The precision gate the research demanded, grounded in outcome rather than a heuristic.*
3. **Measure on comparable runs.** `memory_context.memory_input_ids` records which memory inputs a run used (the `memory_id` of each input, not the inner hint id). Tie those ids to that run's objective outcome and compare against comparable runs (same flow, same intent class) that did not use them. *Advantage: commensurability. This is the unique unlock and the field's open frontier.* Implementation update: the content-addressed identity now exists in `src/app/history/memory-identity.ts`, and `history memory-merge` / `history memory-effect` use it. The broader effectiveness claim is still bounded by corpus size and recurrence.
4. **Judge effect as a cited artifact, not a self-report.** Write a memory-merge report whose verdict is an explicit `effect_status` (`not_enough_data`, `correlated_positive`, `correlated_negative`, or `unresolved`), derived from cited outcomes and defaulting to `not_enough_data`, never from asking the model whether it helped. The idea originates in [`longitudinal-evidence-memory.md`](deprioritized-ledger.md); the new point is that Circuit can populate it from comparable runs once enough of them exist. *Pitfall defended: unfaithful self-report.*
5. **Prune and promote from the judgment.** Hints that never correlate with better runs decay. Hints that repeatedly help get promoted. Memory earns its place instead of accumulating. *Pitfall defended: stale drift and prompt bloat.*

## 5. The memory item lifecycle (design, not yet built)

A clarification first, because section 3 was loose on this. `RunMemoryUpdateEvent` is an event contract: each entry is an immutable record that the system took an action on some memory at a point in time. It is not itself a state machine. The lifecycle belongs to the memory item, the candidate fact, and the four actions (`proposed`, `recorded`, `skipped`, `rejected`) are transitions in that item's lifecycle. This section pins the lifecycle down on paper so the governance is explicit. It is design, not a build commitment.

**States of a memory item:**

- **proposed**: a candidate fact distilled from typed evidence, cited and stale-checked, but not yet trusted. Not injected as earned context, or injected only with an explicit unverified marker.
- **recorded**: an active hint. Reached either because the measurement loop earned it, or because the operator filed it directly.
- **skipped**: a candidate that consolidation declined to record this run (weak signal, or contradicted by recent evidence). Not permanent; re-proposable when new evidence arrives.
- **rejected**: explicitly declined (operator said no, or a hard contradiction). Not re-proposed without new evidence.
- **retired**: was recorded, now removed from active injection because its source went stale and was not re-confirmed within the decay window, or its measured effect turned negative. This outcome has no action in the current four-value enum; a `retired` or `demoted` action is the one addition a real build would need.

**Legal transitions (guard in parentheses):**

- evidence to **proposed** (a cited, stale-checked candidate exists).
- **proposed** to **recorded** (measured non-negative effect across at least N comparable runs, fresh source, no unresolved contradiction; emits an operator indicator).
- **proposed** to **skipped** (weak signal or contradicted by recent evidence; re-proposable on new evidence).
- **proposed** to **rejected** (operator declines, or hard contradiction; not re-proposed without new evidence).
- **recorded** to **retired** (source went stale and was not re-confirmed within the decay window, or measured effect turned negative).
- **recorded** to **recorded** (source re-confirmed or re-measured; refresh the last-verified marker).
- operator-filed fact to **recorded** directly (the operator is the source of authority; the fact stays hint-only and stale-checkable like any other).

Illegal by construction: **recorded** to **proposed** (retire and re-propose, never silently demote to candidate), **rejected** to **recorded** (must re-propose first), and recording any fact with a stale source or without a cited ref.

The load-bearing guard is **proposed to recorded**. It is the single place the effectiveness ratchet's policy lives: "earned its place by measured non-negative effect across at least N comparable runs." N and the comparable-run definition are open questions in section 13. Auto-distilled facts must pass this guard. Operator-filed facts enter **recorded** directly because the operator is the authority, though they remain hint-only and stale-checkable.

**Where enforcement lives (not the schema).** Keep the events append-only as the source of truth and compute current state by folding the event log. This is event sourcing. Validate each transition against the projected current state at apply time, in the memory store, not in a Zod `superRefine`, which sees one event in isolation and cannot know history. The schema's job stays "is this event well-formed"; the store's job becomes "is this transition legal given everything before it."

**Why not now.** This lifecycle is gated on two unbuilt prerequisites. First, a state belongs to an identifiable entity, and there is no stable cross-run memory identity yet (today's ids are run-scoped), so there is no item to carry a lifecycle. Second, nothing records memory at all: `memory_update_events` is empty in every run. Building guarded transitions before either exists would harden the lifecycle of something that does not yet exist. The right time is the promotion phase (Slice 3 and later), when memory starts changing behavior and the audit trail begins to matter. Until then the event log stays append-only and unenforced, and Slice 1 does not touch it.

## 6. Delivery model

Hybrid, as the research endorsed. A tiny earned push at run start, plus a gated pull the agent hits at decision points (cited, hint-only, and itself logged into the loop so we learn whether a pulled hint correlated with a better outcome). The key shift is that "precision" stops being a similarity heuristic and becomes a measured property: a hint that has historically misled comparable runs is suppressed, not surfaced.

This also fixes the push-only weakness directly. A hint that gets evicted from context mid-run can be re-fetched by pull at the exact decision point where it matters, rather than relying on it surviving the whole run.

Implementation update: run-start recall now passes the selected flow into
`queryHistory` through `src/app/history/run-start-recall.ts`, so recall is
flow-scoped. A run with no prior same-flow hits may now receive no prior-run
hints, which is the intended narrower behavior.

## 7. The keystone slice

Build step one as a report-only memory-merge artifact. For every run that used memory, link the injected memory input ids to that run's objective outcome. The honestly-retrievable per-run signals today are the abort reason and the binary run outcome (`RunEnvelopeOutcome`); attempt counts and elapsed time must be summed from `trace.ndjson`, and tokens are not captured at all, so the named signal set drops "tokens to close" and treats "time to close" as requiring a new per-run elapsed field. The envelope persists `memory_input_ids` and the gate fields per run, but the history index does not lift them into queryable fields, so a new envelope-aware extractor and a cross-run reader are needed before any join. Note also that only source-owned active runs write a full `run-envelope.json` (resume and non-source runs write a shadow record), so envelope coverage across the corpus must be checked before treating `memory_input_ids` as a broad linkage signal. No behavior change, no judgment yet, just the linkage. Each linkage carries an `effect_status` that starts at `not_enough_data`; only Slice 2's cross-run aggregation can move it to `correlated_positive`, `correlated_negative`, or `unresolved`, and only once enough comparable runs exist.

This one artifact is simultaneously the product mechanism (the substrate for earned precision and pruning) and the validation experiment (memory on versus memory off on objective outcomes) that the team had already decided to build before investing further. It collapses "de-risk the bet" and "build the feature" into the same small, safe, uniquely-Circuit move. If the data shows memory does not measurably help, the loop reports that cheaply, on our own runs, rather than shipping faith.

## 8. Build sequence

Smallest shippable first. Each slice stands alone and is report-only until the data earns behavior change.

1. **Memory-merge report (report-only).** This is net-new plumbing, not a read over already-indexed data: it needs a new `history.memory-merge@v1` report schema, writer, path constant, and contract tests, plus an envelope-aware extractor and a cross-run reader. It **builds the content-addressed memory identity inside this slice** (as `contentIdentity` in `src/history/memory-merge.ts`); that identity is the cross-run join key the later slices consume, and Slice 3 lifts it into a shared `src/history/memory-identity.ts` module. Slice 1 is a **read-only scan of completed run folders** — it does **not** touch the envelope writer. The envelope-writer relaxation (caller-supplied `source_refs`) and the `.max(1)` bound on the update array are **Slice 5's**, not Slice 1's (Slice 1 reads `run.envelope@v0`, it does not write it). Report-only and behavior-neutral, but larger than "just the linkage." (Built; `verify:fast` green.)
2. **Cross-run effect aggregation (report-only).** Per memory item (which uses the stable identity from Slice 1), compare runs that used it against comparable runs of the same flow that did not. The lead metric is the `complete`-close-rate delta; the adverse (`blocked`/`failed`) rate corroborates; the two are kept separate (no composite). Retries and time-to-green are **deferred future capture** (`started_at`/`completed_at` are the same snapshot, no token field, attempt count not lifted into the linkage), not used here — see section 13 Q3's resolution. A verdict is `not_enough_data` until both arms reach the sample floor. Now we can see which hints correlate with better outcomes.
   - *Follow-up (Slice 2.1, tracked):* union the pull-sourced `content_id`s that Slice 4's `history.pull-log@v1` records into the used-arm, so the effect of *pulled* (not just run-start-recalled) memory is measurable. Deferred; owned by the Slice 2 aggregator, not orphaned in Slice 4.
3. **Earned-precision injection (first behavior change).** At run start, suppress hints with measured-negative effect and sink stale ones, ranking the rest by measured effect (Slice 3). This is **stateless per-run push-suppression**, not persistent decay/promotion of stored memory: the prune-and-promote / retire transitions of the lifecycle (section 4 step 5, section 5) are **deferred beyond these five slices** — no slice yet mutates a stored item's standing. Memory earns its *injection* by measured effect.
4. **Gated pull surface.** An agent-invoked, cited, hint-only query at decision points, logged back into the loop.
5. **Cited-fact producer (in parallel).** The `kind:"project"` producer from [`project-execution-memory.md`](deprioritized-ledger.md), propose-first, distilling typed evidence, with command output redacted at capture time.

Slice 1 is the keystone. Slices 3 and 4 are the only ones that change behavior, and they only do so once slices 1 and 2 have shown the effect is real.

Each slice has a build-ready spec keyed to source. Current status: Slice 1
[`self-auditing-memory-slice-1-spec.md`](./self-auditing-memory-slice-1-spec.md)
is implemented; Slice 2
[`self-auditing-memory-slice-2-spec.md`](./self-auditing-memory-slice-2-spec.md)
is implemented; Slice 3
[`self-auditing-memory-slice-3-spec.md`](./self-auditing-memory-slice-3-spec.md)
is implemented; Slice 4
[`self-auditing-memory-slice-4-spec.md`](./self-auditing-memory-slice-4-spec.md)
is implemented; Slice 5
[`self-auditing-memory-slice-5-spec.md`](deprioritized-ledger.md)
is partially implemented. The implemented pieces share one identity space
(`content_id`/`group_key`), one frozen `effect_status` enum, and one fail-open,
push-only-suppression posture so behavior-changing memory never blanks recall
or seizes authority.

Sequencing against the in-flight architecture-hardening work: scope Slice 1 to read only the stable on-disk `run.envelope@v0` record (its `outcome` and `memory_context.memory_input_ids` are not being moved) and avoid importing the runtime trace consumers, the private `sourceStaleness` helper, or history hashing internals while SD-FIX-1/2 are unlanded (REP-R1 and REP-R2 have since landed; only the SD-FIX hashing/enumerator work remains in flight). Target stable contracts (schemas, report paths, refs, run and flow ids, trace kinds, history documents), not current file locations. Prefer implementing Slice 1 as a standalone read-only history command that scans completed run folders, rather than a new post-run writer hook, because the architecture-hardening branch is actively refactoring the post-run artifact extraction path and a read-only scan is far less likely to collide with that work.

## 9. What it refuses to do

- No authority creep. Memory stays hint-only, so a wrong or poisoned fact degrades attention at worst, never control. Project and flow scope removes the shared-bank precondition that memory-poisoning attacks need.
- No required operator invocation for automatic capture or recall. Operator-filed
  `circuit memory note` facts and agent-invoked `circuit history pull` are
  explicit, auditable exceptions; normal run-start recall still happens without
  the operator remembering a separate command.
- No reflective prose lessons. Cited facts from typed evidence only.
- No routing changes and no self-evolving flows yet. Execution first.
- Never a silent meaningful update. When memory is proposed or recorded, surface a one-line `memory_indicator`. The `RunMemoryUpdateEvent` contract already requires an operator indicator, but note it is defined and not yet emitted in practice: every run's `memory_update_events` is empty today.
- Verify summary redaction on any path that feeds memory. The trace stores `stdout_summary` and `stderr_summary`, not raw output, and the history index already strips raw `stdout`/`stderr`, so this is a verification obligation on the summaries, not an unguarded raw-output leak as an earlier draft implied.

## 10. The long arc

The measurement loop is also what makes the strongest ratchet safe. Crystallizing a repeated step-motif into a new typed flow (the endgame in [`dynamic-flow-ratchet.md`](./dynamic-flow-ratchet.md)) is dangerous because frequency alone can fossilize a common but bad pattern. Once outcome effect is measurable, Circuit can crystallize only the motifs that measurably improve runs. Measurement is the gate that turns the speculative endgame into a safe one. So the loop is not only the near-term win, it is the prerequisite for everything above it.

## 11. Honest risks

The whole approach rests on the cross-run comparison in step 3 being statistically meaningful, and our own corpus showed how thin that signal can be: failures did not recur within the project, the corpus is small, and the research noted a cold-start effect where memory shows no benefit for the first ten to twenty sessions. State it plainly: the measurement ratchet structurally requires recurrence the current corpus does not show (four aborts, four distinct causes, the worked failure appears once), and the only flow with both a memory-on and a memory-off run has one run per arm, fully confounded. On a single small repo the loop may report "no detectable effect" indefinitely. That is the system being truthful rather than theatrical, but it means the defensible near-term value is the safety posture (hint-only, cited, self-staling), with the measurement ratchet as the speculative bet that has to earn its keep. The mitigation is that the keystone slice is cheap and report-only, so a long pre-ratchet period costs almost nothing and still produces an honest answer about whether the ratchet is real.

## 12. Messaging: the advantages to lead with

These are the differentiators worth saying out loud, in Circuit's voice. Keep them honest: they describe what the architecture uniquely enables, not behavior that already ships. Per the effectiveness-ratchet posture in CONTEXT.md, do not claim Circuit already gets better over time. Frame it as a skilled practitioner improving through evidence and experience, not a magic optimizer.

- **Memory that can show its work.** Circuit is built so its memory can be checked against real outcomes, because Circuit's runs are comparable to each other. Most tools store a lesson and hope it helps. Circuit is designed to tell whether a lesson actually helped. _Avoid: claiming it already proves this today._
- **The process lives in the system, not in your head.** You describe the work. Circuit selects the process and runs it. Learning from a run is a byproduct of doing the work, not another command you have to remember at the right moment. _Avoid: framing Circuit as a toolbox of commands._
- **Lessons that cannot quietly rot.** Every lesson is tied to the real evidence it came from and checked against the current source. When the ground changes, the lesson marks itself out of date instead of misleading you. _Avoid: "permanent memory," which is the rot trap._
- **Memory that orients but never overrules.** A lesson can point attention at the right place. It can never authorize a route, a checkpoint, a proof, or a write on its own. A wrong or planted lesson can nudge, never seize control. _Avoid: positioning memory as a guardrail or a source of truth._
- **Improvement you can audit.** When memory shapes a run, Circuit says so in one line. Getting better is visible and reviewable, not hidden self-editing. _Avoid: "autonomous," "self-optimizing," "self-mutating."_

The throughline for all five: Circuit treats a lesson as a hypothesis it can test, tied to evidence, that guides without governing, and that improves the work as a byproduct of doing it. That sentence is the position. Every competitor either stores beliefs it cannot test, makes the human carry the process, or lets unverified lessons act as instructions.

## 13. Open questions

1. Comparable-run grouping: what defines "same intent class" for the cross-run comparison, beyond `flow_id`? A coarse intent label, the goal-contract objective, or a cluster over the goal text. **Resolved (Slice 2 spec, D2):** the cohort is `flow_id` and only `flow_id` — the one deterministic, closed-alphabet grouping. The exact-objective sub-partition is rejected (shatters cohorts to n=1) and fuzzy intent-class clustering is deferred as a non-goal until a deterministic key justifies it.
2. Minimum sample: how many comparable runs before an effect estimate is allowed to influence injection, given the small-corpus and cold-start risks. **Resolved (Slice 2 spec, D3):** both arms must reach `MIN_ARM_SIZE` (default 2, echoed and operator-overridable) or the verdict stays `not_enough_data`; two is the floor distinguishing one observation from a minimal repeat, not a claim of adequacy. On today's corpus every verdict is `not_enough_data` by design.
3. Effect metric: which objective signal leads (abort-rate delta, run-outcome delta, and time-to-green once a real per-run elapsed field exists), and how to combine them without inventing fake precision. Note the envelope `clean_streak` is coarse today (hardcoded by outcome, not graduated) and tokens are not captured, so neither is a usable lead metric yet. **Resolved (Slice 2 spec, D4/D5):** the `complete`-close rate leads; the adverse (`blocked|failed`) rate corroborates; the two stay separate (no composite, no fake precision); `needs_attention`/`handoff` are counted as neutral, not forced. Retries/time/tokens stay deferred as future capture.
4. Pull surface authority: the gated pull is the History-Ask idea done as cited, hint-only, and logged. What is the minimal version that does not duplicate the existing query schema (see the prior proposal's findings). **Resolved (Slice 4 spec, D1):** reuse the existing `circuit history query --format memory-input` surface verbatim for the result; add only a `history.pull-log@v1` sidecar (the net-new contract) plus a thin `circuit history pull` wrapper that logs as a side effect of the pull and suppresses measured-negative hints.
5. Where the memory-merge report lives and whether its judgments stay report-only until an independent eval confirms they track real outcomes. Proposed verdict shape: an `effect_status` enum (`not_enough_data` | `correlated_positive` | `correlated_negative` | `unresolved`) rather than a helped-or-misled judgment, so the report can honestly say "not enough comparable data" as its default early state. **Resolved (Slice 1 + Slice 2 specs):** the linkage (`history.memory-merge@v1`) and the verdict (`history.memory-effect@v1`) live in `src/schemas/history.ts` and persist under `.circuit/history/`; both are report-only and behavior-neutral, and the `effect_status` enum is frozen with `not_enough_data` as the default early state. Whether the verdicts gate injection is the separate Slice 3 decision (suppress-negative only, fail-open), and whether they are independently eval-confirmed before that remains open.

## Sources

Circuit code and design (verified at writing time): `src/schemas/memory-input.ts`, `src/schemas/run-envelope.ts` (`RunMemoryUpdateEvent`, `memory_context`, `memory_indicator`, completion gate), `src/schemas/trace-entry.ts` (`verification.command_evaluated`, `step.aborted`), `src/history/query.ts` (`sourceStaleness`, `options.flow`), `src/history/memory-preview.ts`. Related idea docs: [`project-execution-memory.md`](deprioritized-ledger.md), [`longitudinal-evidence-memory.md`](deprioritized-ledger.md), [`self-improving-circuit.md`](deprioritized-ledger.md), [`dynamic-flow-ratchet.md`](./dynamic-flow-ratchet.md). External survey: [`docs/learnings/codebase-memory-research.md`](../learnings/codebase-memory-research.md).
