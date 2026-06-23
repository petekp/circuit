# supermemory ("memory on the harness level") vs Circuit

Status: current comparison note. Not a plan, not current behavior.
Date: 2026-06-22

Captured from an evaluation of Dhravya Shah's essay
[*Memory on the harness level*](https://dhravya.dev/writing/memory-on-the-harness-level/)
(the design philosophy behind supermemory). The prompt was "evaluate whether
there's anything useful that could be applied to Circuit." This note records
that evaluation: what the essay argues, how each of its mechanisms maps onto
Circuit's memory and continuity surface, and the one place worth acting.

The verdict in one line: the essay is a clean map of the memory *design space*,
but as a source of things to *build* it is almost entirely subtractive. Eight of
its ten ideas are already in Circuit, refuted by Circuit's own recorded evidence,
or mis-fitted to a coding harness. The reason is structural and worth holding
onto: the essay reasons entirely inside the "store a belief, derive a profile,
hope it helps" paradigm, and Circuit's memory architecture is built to escape it.

Related, read first:
- [`self-auditing-memory.md`](./self-auditing-memory.md) owns the memory thesis
  this comparison leans on: memory as a hypothesis tested against comparable
  runs, hint-only authority, cited self-staling facts, no reflective-prose
  lessons. Every supermemory idea is judged against those boundaries.
- [`recall-vs-circuit-continuity.md`](./recall-vs-circuit-continuity.md) is the
  sibling comparison (the local `recall` plugin). It found two real gaps Circuit
  should still close; this note found almost none, and the contrast is the point.
- [`effective-memory-program.md`](./effective-memory-program.md) and the
  superseded [`pull-query-memory.md`](./pull-query-memory.md) own the push-vs-pull
  stance and relevance-native retrieval ordering.
- [`continuity-restore-fast-robust.md`](./continuity-restore-fast-robust.md)
  owns the restore/latency reasoning the essay's two-axis lens restates.
- [`docs/architecture/continuity-first-principles-evaluation.md`](../architecture/continuity-first-principles-evaluation.md)
  owns the Step 0 NO-GO that settles the essay's "recent is not important" claim.
- [`docs/learnings/codebase-memory-research.md`](../learnings/codebase-memory-research.md)
  is the external survey that grounds the distractor cost, the centrality-drops-
  rare-facts hazard, and the model-self-report-is-unfaithful finding.

## What the essay argues

Memory design is "far more nuance than markdown files with an MCP." Every memory
strategy is a position on two axes: tokens consumed and latency added to the
user-facing turn. There is "no universally correct dot"; different agent types
sit at different positions. The essay then taxonomizes:

- **Write**: explicit (the model calls `remember()` on-thread; "blind writes"
  unless it `recall()`s first) vs implicit (an out-of-band observer model watches
  the transcript and maintains a consolidated, contradiction-reconciled profile).
- **Read**: explicit (the model writes a query and chains lookups until satisfied;
  a filesystem interface, smfs, where the agent drives memory like a repo with
  `ls`/`grep`/`cat`) vs implicit (the harness pre-fetches top-k and injects before
  the model runs; one fixed hop).
- **The profile**: instead of pulling, *push* a small, prompt-cacheable,
  auto-updating profile into every turn, split into a static part (name, role)
  and a dynamic part (current work). It solves non-literal queries ("find me the
  best monitor" works because the profile already says you are a CEO who codes).
- Plus **dreaming** (an out-of-band observer "connects the dots" to keep
  improving the profile), **intentional forgetting** (facts that stop mattering
  decay away), and a **fact-based rich graph** substrate the profile derives from
  (never rewrite the markdown from scratch).

For a coding agent specifically, the essay prescribes the quality pole: explicit
write, explicit recall, filesystem, because the latency "disappears into work the
user already expects to take time."

## Idea-by-idea, against Circuit's actual surface

Each row was source-verified against the current checkout. "Already-done",
"refuted/refined", and "not-applicable" mean what they say; only one row is a
genuine open action.

| Essay idea | Verdict | Grounding |
|---|---|---|
| Two-axis lens (tokens × latency); coding agent favors quality | Already settled | Circuit reached the same conclusion by its own analysis: `continuity-restore-fast-robust.md` finds "Raw restore latency is not the bottleneck" (brief injects ~0.16s against a 3000ms timeout) and rejects a resident daemon because the latency saving is trivial while the operator's hand re-derivation dwarfs it. The depth × power dials (`src/cli/circuit.ts`) are a real two-axis product surface. Circuit's axes are latency × robustness, not tokens × latency, but the operative conclusion is identical. Useful only as docs vocabulary. |
| Implicit/observational write (a model-observer consolidates) | Reasoned + deferred, mis-fitted | The off-hot-path principle is shipped, but *deterministically*: `src/app/continuity/harvest.ts` makes zero model calls. The consolidation/lifecycle (reconcile, update-in-place, retire) is designed in `self-auditing-memory.md` §5 and deferred. A model-observer specifically collides with the no-model harvest and with the D6 finding that model self-report is unfaithful by construction (Turpin, up to 36% accuracy swing). |
| Explicit/tool-call write (informed `remember()`) | **Partial — the one real gap** | The recall half is shipped and the cited-fact substrate that answers the essay's "blind writes" complaint exists (`MemoryInputV0`: source + sha256 + staleness + `authority:hint_only`). But the model never proposes a write: `RunMemoryUpdateEvent` (proposed/recorded/skipped/rejected) is schema-complete, yet `memory_update_events` is always `[]` because no caller feeds `memoryUpdates`. See "the one place to act". |
| Explicit recall via filesystem (`ls`/`grep`/`cat`, chain until satisfied) | Already covered + partly refused | The sound half ships twice: `circuit history pull` (slice 4, logged to `pull-log@v1`) and the typed `context_request` channel (`src/runtime/run/context-pull.ts`, budget 3, refuses an everything-ask, "No retrieval, no semantic engine, no everything channel"). The pull affordance is rendered into every relay prompt (`relay-support.ts`). The unbounded "enough tokens guarantees the right context" premise is refuted by the measured 6-to-11-point distractor cost of topically-similar-but-stale context. |
| Implicit/harness recall (pre-fetch top-k, one hop) | Already done, twice | The SessionStart continuity brief and run-start recall (`applyEarnedPrecision`, budget 3) are both single harness-driven prefetch hops, keyed on session/recency/relevance, never on the live user message. There is no `UserPromptSubmit` hook and there should not be: a per-turn message-keyed hop re-creates the "user types hi, retrieves nothing" failure. |
| The pushed profile (static + dynamic, cacheable, per-turn) | Partial, by design | The static/dynamic split exists as two channels: recency-anchored continuity ("what was I doing") plus cited project facts ("what is durably true"). Per-turn injection and prompt-caching are deliberately absent: a per-run harness amortizes one injection across many steps, so the latency optimization the profile exists for does not apply. |
| "Recent is not important" (swap recency for an importance classifier) | Refuted / refined | The exact remedy was run as a controlled experiment. The Step 0 probe (134 transcripts, blind gold labels) failed both gates: 0.74x false-resurrection against a 0.50x gate, 10.4% over-burying, 58% land in a "cannot-tell" coin-flip because the deciding signal is semantic and the no-model harvest cannot carry it. The signal that *does* split the corpus is provenance (explicit-save 81% open vs ambient-only 83% satisfied), already encoded as resolver precedence. Durably-important static facts are handled by a separate cited channel, not by re-weighting the temporal record. |
| Dreaming (out-of-band generative enrichment) | Refuted | Circuit adopts the out-of-band *timing* but inverts the content: `memory-merge`/`memory-effect` *measure* whether a memory correlated with better runs; they never invent connections. Generative dot-connecting with no outcome feedback is the precise self-reinforcing-loop pitfall `self-auditing-memory.md` §4/§9 refuses ("cited facts from typed evidence, not reflective prose"). |
| Intentional forgetting / decay (facts fall away over time) | Refuted as time-decay | Circuit's freshness signal is deterministic source-hash staleness (`reverifyStaleness`): a fact marks itself stale when its cited source changes, not when a timer fires. Time/usage decay is actively hazardous for a cited-fact harness because centrality/age pruning silently drops the rare-but-critical one-off ("we chose Postgres over Mongo," said once). The legitimate variant, outcome-coupled retire, is designed in §5 and deferred. |
| Fact-based rich graph substrate | Refuted / not worth it | Circuit already derives from cited facts instead of model-rewriting markdown, but with a flat typed-record store, not a graph. A graph reconciles a human's contradictory, entity-rich profile across thousands of chats; a Circuit fact is binary (hash matches = fresh, else stale), so entity-resolution barely arises. The deterministic distiller that would feed a graph emits nothing on the real corpus (cold-start, recurrence never reaches two runs). |

## The one place to act

**An opt-in, informed, model-driven write-back at run close.** This is the only
row that is a real gap rather than a settled question. Circuit has the recall
half and the cited substrate; what is missing is a producer that proposes a
write. The honest framing matters:

- A *deterministic* sibling already exists: `distillProjectMemory`
  (`src/memory/project-distill.ts`) builds well-formed `proposed`
  `RunMemoryUpdateEvent`s citing every contributing run. It is unwired on purpose,
  because on the real corpus it proposes nothing (it gates on two distinct runs
  and the failure recurrence never gets there). So the experiment is not "fill an
  empty array." It is "can a model-in-loop proposer see grounded, write-worthy
  facts the deterministic miner cannot?"
- Shape: a closing in-flow step (start with build) that may propose 0-1 updates,
  is allowed to `recall()` existing project facts first so it reconciles instead
  of blind-appending (the essay's "informed write"), threads `updates` into the
  existing mapper (no schema work), gates behind a default-off flag mirroring
  `CIRCUIT_RANK_PROJECT_FACTS`, stays `authority:hint_only`, and is propose-first
  (an operator confirms; never a silent recorded write).
- Never in the Stop/harvest hook. Step 0 settled that a no-model per-turn judge
  loses to recency. The write belongs where the model is already running.
- The load-bearing risk is exactly the one the essay walks into: the model
  reporting on its own usefulness. The success metric must be the memory-on vs
  memory-off ablation on objective run outcomes, never the model's claim that the
  fact helped. Without that measurement attached, this only manufactures
  unconfirmed proposals an operator has to triage.

Bill it as the first live test of the model-driven write half, not as closing
deferred plumbing. It is cheap, reversible, and opt-in.

## What Circuit should keep refusing

The essay presents these as frontier features. For a cited-fact coding harness
they are settled negatives, each backed by Circuit's own evidence:

- A model-observer on the continuity path (Step 0 NO-GO; no-model harvest grain; D6).
- "Dreaming" / generative dot-connecting (self-reinforcing-loop pitfall; replaced
  by out-of-band measurement).
- A fact-graph substrate (mis-fitted to binary fresh/stale facts; starved by cold-start).
- Time/usage decay (drops rare-but-critical one-offs; source-hash is the right signal).
- A per-turn `UserPromptSubmit` recall hook (re-creates "hi retrieves nothing").
- An importance classifier on harvest (classifier cannot beat recency).

## Honest limits, so Circuit does not over-read the contrast

- Circuit's "better answers" are mostly *posed and scaffolded*, not *won*. The
  measurement loop is report-only and inert on a thin corpus, `CIRCUIT_RANK_PROJECT_FACTS`
  is default-off with unmeasured efficacy, and the distiller emits nothing. Circuit
  has the better question (measured effect, not belief); it has not yet demonstrated
  the payoff. supermemory ships a working belief-based product, which is not nothing.
- The reason 8 of 10 ideas are already-done or refuted is structural, not a sign
  the author is behind. supermemory is horizontal memory infrastructure: to be
  agent-agnostic it must be evidence-agnostic, and evidence-agnostic forces it
  back into belief-based memory with no way to measure effect. Circuit reaches the
  measurement paradigm only by being vertical (a closed flow alphabet that makes
  runs comparable). The wall between the two is horizontal-vs-vertical, not
  smart-vs-dumb.
- The one place the essay is plainly right, that recency loses durably-important
  static facts, is exactly the gap Circuit fills with a separate cited project-fact
  channel. That channel's *efficacy* is still unproven, so state it as "mechanism
  exists, effect unmeasured," not "solved."

## Net

This essay is, for Circuit, a vocabulary borrow at most: the two-axis framing is
a clean way to explain in a public design-rationale page why Circuit chose
explicit-write over pushed/ambient inference. Every mechanism it proposes,
Circuit already has a more rigorous version of, or has recorded a reason for
refusing. The single genuine action it surfaces, the informed model-driven
write-back, was already on Circuit's own deferred list and is worth taking only
as a measured experiment, not as plumbing completion. If the goal is real memory
headroom, the sibling note `recall-vs-circuit-continuity.md` points at the two
gaps that actually matter (write-time redaction and a local extractive-summary
fallback); this one does not.
