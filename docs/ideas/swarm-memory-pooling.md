# Pooling Circuit Memory Across an Agent Swarm

Status: proposal (2026-06-08). Design-only, not built. Author: an overnight
research and design pass (8 research agents, 5 designed approaches, a 4-judge
panel, 1 synthesizer), then an adversarial verification pass (5 critic lenses,
per-finding independent verification) that found and fixed 1 critical and 5
high defects in the first draft. All load-bearing code claims were
independently re-verified against source. External research citations were not
byte-verified the way code claims were. Several arXiv IDs cited below were
emitted after the January 2026 model knowledge cutoff and are flagged as
unverified in the references; link-check each before trusting its numbers.

## The question

Circuit's product memory is per-worktree and isolated: each worktree's
`.circuit/memory/project.v1.jsonl` is its own store, written during a run and
recalled at the start of the next one. The question this doc answers: what does
**pooling** memory (and the runs behind it) across multiple agents unlock, and
how should Circuit approach (or decline) a merge-safe shared substrate? Two
regimes are in scope, because both were asked about:

- **Same-machine swarm.** Several agents or worktrees on one operator's machine.
  Circuit's own Workflow tool already spawns worktree-isolated agents, so this
  is not hypothetical. The concurrency bug below is real and immediate here, and
  there is no cross-person trust surface. There is, however, a cross-worktree
  code-trust surface once a shared pool exists (a worktree running untrusted
  code, a malicious dependency, or a prompt-injected sub-agent can write to it).
- **Cross-machine team.** Teammates on different machines and clones. Same
  substrate plus the full antibody stack (identity across people, quarantine,
  redaction, trust weighting).

## The answer in one line

Build the **same-machine swarm pool first**. It is both the denser and the
safer first target. The densest kernel is a **re-anchored, cite-and-verify-backed
pooled read projection**: make recall query-rankable and corroboration-aware
(read-only, ships value today), then stand up an append-only pool outside the
repo whose cited-artifact bytes are replicated so verification still works on a
fact another agent produced. That single seam (a) removes the write race that
blocks all pooling, (b) converts a foreign fact from "stale by construction"
into something that can be graded, which is the densest interaction with
cite-and-verify, and (c) lets parallel worktrees pool what each other proves,
which manufactures the cross-run corpus density Circuit's dormant measurement
loop has never had. Cross-machine team sharing is a later, lower-priority
attachment on the same substrate.

One caveat the first draft got wrong and this version fixes: the pool's
race-freedom comes from writing **one file per (cluster, observing run)**, not
from a single content-addressed file per fact. The fact id is keyed on the
failure cluster, not on file bytes, so two agents observing the same cluster
would collide on one path. See Stage 2b.

## How memory works today (the constraints map)

These are the facts the design has to respect. Each was verified against source.

- **The write path is not append-only.** `appendProjectFact` reads the whole
  file, drops the matching id, and rewrites the entire file via a pid-scoped
  temp file plus atomic rename (`src/memory/project-store.ts:138-181`). The
  rename is atomic, but the read-modify-write around it is a classic
  **lost-update race**: two agents that each read N records and rewrite N+1 end
  with last-rename-wins, silently destroying one agent's write. There is no
  lock, no `O_APPEND`, no version check anywhere in the memory module. This is
  the #1 blocker to pooling, and the fix is structural (stop rewriting the whole
  file), not a fancier algorithm.
- **The auto-distiller is built but unwired.** `distillProjectFacts`
  (`src/memory/project-distill.ts:187`) has no non-test caller. The only
  production writer of the store is the operator CLI `circuit memory note`. So
  today a pool would contain hand-written notes only. Wiring harvest is a
  prerequisite for pooling to deliver more than what people type by hand.
- **Reverify is anchored to the local run folder.** At recall, each fact is
  re-hashed against `<repoRoot>/.circuit/runs/<run_id>/<path>`
  (`src/memory/project-injection.ts:48,71`). A fact citing another agent's
  `run_id` fails `existsSync` and grades hard **stale**, sinking to the bottom
  tier. Cross-agent facts are stale by construction unless verification is
  re-anchored. This is the central tension with cite-and-verify under pooling.
- **The record schema has no seat for identity.** `MemoryInputV0` is `.strict()`
  (`src/schemas/memory-input.ts`), so there is nowhere to put an author, an
  agent id, or a per-record project id without a breaking schema change. The
  authority field is the literal `hint_only`, which is the invariant that keeps
  a poisoned fact at attention-degradation and never lets it seize control.
- **Project facts ride unranked at recall.** Recall is flow-scoped; prior-run
  query-relevance hits lead; project facts follow in store-insertion order
  (`src/app/history/run-start-recall.ts`); an earned-precision gate then tiers
  by measured effect and freshness and fills a budget of 3. Only a
  measured-harm fact (`correlated_negative`) is hard-suppressed; stale and
  unknown facts merely sink to a lower tier and stay eligible. As a pool grows,
  insertion order, not relevance, decides which facts survive the budget.
  Project facts need to be query-rankable.
- **The shared key already exists, with caveats.** The project id is the
  normalized git-remote-origin URL hashed to a stable value, stamped once in
  `.circuit/memory/manifest.json`, and the slice-5 spec already describes it as
  "the key a future cross-worktree shared store would use." Reuse it. But it
  both over-merges and under-merges (see the project-id risk below), so a shared
  pool needs an opt-in `project_id` pin, not blind reuse.
- **`memory_id` is a per-producer path-safe stem, not a uniform content hash.**
  There is no single hash of the whole record. Operator notes hash
  `flowId\0appliesTo\0text\0source.sha256` (`src/cli/memory.ts:236-237`); the
  distiller derives `proposalMemoryId` from the failure-cluster key
  `flowId\0normalizedHead` (`src/memory/project-distill.ts:112-114,248`). So
  identical-cluster facts converge to one id, which is a dedup win but also
  collapses independent rediscoveries, destroying the corroboration count
  pooling is supposed to produce. Dedup has to move from "identity" to read-time
  "grouping" (below), and the pool has to store one file per observation so two
  observers of one cluster do not overwrite each other.

## What pooling unlocks

Three tiers, grounded in the external research (numbers are as reported by the
cited work; treat post-cutoff sources as unverified). The headline distinction:
cited verifiable facts gain little from pooling because verification already
settles them. The thing pooling **uniquely** adds is confidence for the
**non-verifiable tail** plus corpus density.

**Tier 1, stop paying for the same lesson twice.** A new agent or worktree
starts experienced instead of blank; parallel agents stop re-deriving each
other's discoveries; a failed run becomes a teaching artifact for the next
agent. Reported analogues in the literature: cross-agent memory reuse improves
embodied-task success and QA accuracy with no framework change (G-Memory);
shared memory cuts redundant tool calls substantially at high query overlap
(Collaborative Memory); a shared skill library reaches milestones markedly
faster (Voyager reports up to 15.3x). The unit that travels well is a verified
artifact (a recurring-failure cluster, a reproducible fix, a reusable check),
not a subjective note.

**Tier 2, memory that corroborates and corrects itself.** A fact independently
rediscovered by several genuinely-independent agents is stronger evidence than
one agent asserting it. This is the tier that needs author identity (to count
distinct contributors) and the tier where the value lives, but only for facts
that are not cheaply verifiable at recall: judgments, conventions, "this
approach failed" lessons, and facts whose cited evidence has since vanished. For
verifiable facts, verification dominates and corroboration is at most a
tiebreaker.

**Tier 3, corpus density for the dormant measurement loop.** Circuit's honest
standing caveat is that failures do not recur on one thin repo, so the
self-auditing measurement ratchet may never fire. Pooling several agents'
comparable (same-flow) runs against shared facts is a principled way to
manufacture the recurrence the ratchet needs. This is a non-obvious second
reason to pool, separate from knowledge-sharing.

## The strategic insight: cite-and-verify changes the calculus

Every shared-memory system in the literature is built to solve a problem Circuit
has largely defined away. Truth-discovery engines exist because they have no
ground truth and must infer which claims are true from agreement patterns.
Circuit's facts are not bare assertions: each carries a citation (`run_id` /
`flow_id` / `step_id` + sha256 + captured_at) and is re-verified against that
cited source before use.

The consequence, stated precisely: **cite-and-verify converts merge-correctness
(a hard, global-agreement problem) into read-time admissibility (an easy, local,
per-record check).** A superseded, stale, or poisoned record does not have to be
ordered, garbage-collected, or even removed at merge time. It simply fails
re-verification against its cited source at recall and is ranked down. This is
what lets Circuit run the dumbest possible merge (append-only union, no clocks,
no tombstones) and still be correct, because trust is recomputed per record on
read.

It is also a partial poisoning defense. A hallucinated fact with no surviving
real source fails reverify and therefore cannot rank as fresh, which similarity
-based RAG swarms cannot do (this is why PoisonedRAG reports high attack success
against them with a handful of injected documents). Grounding to real artifacts
raises the bar.

**The honest limit, stated out loud and load-bearing.** Cite-and-verify catches
source drift and forgery-of-source. It does **not** catch a sincere-but-wrong
fact cited to a real, unchanged artifact. And on failure a fact currently
**sinks** to a lower tier rather than dropping, so it stays injectable into the
budget of 3. There is one more limit that the pool introduces and that the first
draft missed: once verification re-anchors to a content-addressed evidence pool
the fact's own author can write, "the bytes hash to their own hash" is trivially
satisfiable, so the artifact moat only holds against an attacker who cannot write
the pool (see Security posture). The residual (sincere error, in-place
replacement, attacker-controlled evidence) is exactly where corroboration,
quarantine, the write boundary, and the hint-only floor have to do the work
cite-and-verify cannot. Any design that sells cite-and-verify as a complete
antibody is overclaiming and will be falsified in review.

## Recommended path

Same-machine swarm, built read-side first, then the substrate payoff. Each stage
is independently mergeable, behind a flag, and reversible, with the rollback
caveat noted at Stage 2.

### Stage 0. Query-rank project facts in recall (small)

Route project facts through the same lexical scorer prior-run hits already use,
so they carry a real relevance score into the earned-precision gate instead of
riding in raw insertion order. Keep the current prior-run-leads ordering as the
final stable tiebreak. Behind a recall-side flag.

Why first: the external research is directionally clear that **retrieval, not
capture, is the bottleneck**. Reported results indicate that improving the
retrieval method moves end-task accuracy substantially more than improving the
write strategy, with retrieval precision strongly correlated to final accuracy
(the precise figures come from a post-cutoff source flagged in the references
and should be link-checked before being quoted). Only the directional claim is
load-bearing here, and it is corroborated across several independent lines of
the prior art. This pays off on one machine today, needs no schema or write-path
change, and de-risks the recall path every later slice inherits. Grep the recall
ordering assertions first and update the pinned ordering tests deliberately
(behavior change, test changes with it).

### Stage 1. Corroboration counter, tier-invariant sub-rank, eviction view (medium)

Pure read-model. For each content-id group, count **distinct run_ids** citing it
and collapse same-run repeats (stops within-run ballot-stuffing). Apply a
**sublinear** (sqrt or log-odds) dampener as a tiebreak **within a tier only**,
never across tiers and never rescuing a stale or suppressed fact, gated to the
non-verifiable tail. Add the count to the recall audit sidecar as raw provenance
("found across N runs"), never as a probability. Add a report-only eviction view
that marks hard-stale facts (cited source gone) as evictable, using the existing
reverify as a deterministic staleness signal stronger than heuristic decay.

What it is and is not: this counts distinct run_ids, which stops one run from
voting for itself many times, but it is **not** Sybil-resistant against one actor
who re-runs the same flow N times. A `run_id` is minted per run via
`randomUUID()` with no cost and no identity binding, so distinct-run count is an
advisory floor, not an independence measure. Genuine independence (a distinct
model, seed, or person) arrives only in the cross-machine regime. Present the
count as advisory provenance, sublinear and tier-invariant, exactly so a cheap
flood cannot promote a fact across tiers.

Sequencing honesty: this counter has nothing real to count until Stage 2 exists.
Pre-pool, the distiller already collapses a cluster's per-run occurrences into
one proposal with the run-ids buried in hint **text**
(`src/memory/project-distill.ts:235-251`), so a local "distinct run_ids per
group" is always 1. Build Stage 1 to read run_ids from the Stage 2b observation
envelope, not by parsing hint text, so Stage 2 does not obsolete it. Until the
pool supplies multi-run inputs, Stage 1 is inert-but-correct (it degenerates to
today's sort at count=1) and effectively untested on real corroboration inputs.

### Stage 2. The same-machine pool (the payoff)

Four sub-slices, each green on its own behind a dual-read fallback that keeps the
local store readable.

- **2a, wire the distiller, report-only first (medium).** Call
  `distillProjectFacts` from the app-layer run-finalize path in
  `src/cli/run.ts`, after the engine returns and the `RunResult` is parsed (near
  `src/cli/run.ts:570`), which is outside `src/runtime` and honors the engine
  boundary. (Note: the `run.completed` progress event is emitted by the engine
  itself at `src/runtime/projections/progress.ts:821`; do not hook there. The
  first draft's "near where `run.completed` is emitted in `cli/run.ts`" was
  wrong on both the symbol's location and the layer.) Propose-first: emit the
  proposed fact, do not write it, to measure the close-path cost. Fail-open: a
  thrown harvest never affects the run result. Gate on a terminal outcome. This
  is the prerequisite every pooling approach shares, paid once at the cheapest
  setting.
- **2b, append-only per-observation pool (medium, and the fix to the first
  draft's critical bug).** A pool at
  `~/.circuit/pools/<projectId>/{facts,artifacts,proposed}`. **Do not** write
  one `facts/<id>.json` per fact: the distiller's `proposalMemoryId` is the hash
  of the cluster key (`flowId\0normalizedHead`), not of the file bytes
  (`src/memory/project-distill.ts:112-114,248`), so two agents distilling the
  same failure cluster compute the **same** path but **different** bytes (the
  per-run `source.sha256`, the per-observer run-id list in the hint, and the
  wall-clock `captured_at` all differ). A temp-plus-rename to that shared path is
  last-writer-wins and silently destroys the other observer's record and its
  run-ids, rebuilding the exact race we set out to kill and overwriting the
  corroboration count the pool exists to produce. Instead, write one file per
  **(cluster, observing run)**: `facts/<memory_id>/<observed_in_run>.json`,
  append-only, never rewritten. Concurrent writers now touch genuinely disjoint
  paths, so the per-file atomic rename is race-free and the lost-**update** race
  is structurally impossible. Recall groups files by `<memory_id>` at read time
  and unions distinct run_ids across them, which is what makes Stage 1's count
  real instead of overwritten. The pool lives outside the repo, so it is
  gitignored by location, has no git-history exfil surface, and reverts with
  `rm -rf`. Wrap each observation in an Observation envelope (`observed_by` /
  `observed_in_run` / `observed_at` / `project_id` around the unchanged
  `MemoryInputV0`) so the pool can later evolve into a full append-only event log
  without a second backend. Ship a named concurrency test: two distillers, same
  cluster, different run sets, assert both writes survive and the merged
  corroboration count reflects both run sets.
- **2c, evidence pool and re-anchored reverify (medium, the densest
  cite-and-verify interaction, and the slice with the most security weight).**
  On harvest, copy the cited artifact's bytes to `artifacts/<source.sha256>`
  (content-addressed, idempotent, dedups identical artifacts). Order the writes
  **artifact first**: copy and fsync `artifacts/<sha>` and rename it into place
  **before** the 2b fact rename, so any committed fact's artifact is always
  present (the reverse leaves a benign, GC-able orphan, but a fact without its
  artifact is not benign, see below). In `reverifyStaleness`, keep the local
  run-folder fast path, then fall back to `artifacts/<sha256>`. Split today's
  binary absent-equals-unknown into two outcomes: a cited source that is
  **verified absent** (the run folder is gone and no artifact was ever
  replicated) stays `unknown` as today; a cited source whose artifact is merely
  **not yet replicated** becomes a distinct `pending` outcome, ranked like
  unknown but **not corroboration-eligible**, so Stage 1 never counts a fact
  whose evidence has not landed. A partial-directory read during the copy window
  is an expected transient false-absent and must not flap a fact's grade
  permanently.

  Three corrections to the first draft, all load-bearing:

  1. **The evidence pool is a new forgery surface; say so and bound it.** Reverify
     uses `fact.source.sha256` as both the lookup key and the equality target
     (`src/memory/project-injection.ts:39,53`), so "the bytes at `artifacts/H`
     hash to `H`" verifies fresh for any `H` an attacker who can write the pool
     chose. The original run-folder anchor is not self-referential like this: its
     path is `join(runsBase, runId, relPath)` under the engine-written
     `.circuit/runs/` tree, which a fact author cannot mint for a run that never
     executed. Mitigation: evidence bytes are written **only** by the trusted
     run-finalize harvester (the Stage 2a terminal-outcome-gated path), never by
     an arbitrary observe or promote call, and the harvester confirms the cited
     bytes against the live run folder it just finalized before replicating. Do
     not claim this slice is "strictly widening with nothing regressing": it adds
     a writer-controlled verification target that did not exist before.
  2. **Artifacts cannot be redacted without breaking reverify, so they ship raw.**
     The first draft claimed the evidence pool "inherits the distiller's
     normalized-fields-only redaction so raw stdout never lands." That is false.
     The distiller redacts the **fact's** text fields and writes no artifacts
     (`src/memory/project-distill.ts:30-31`); the only artifact it cites is the
     whole `trace.ndjson`, whose `source.sha256` is the hash of the entire file
     (`:140,263`), and that trace can inline stdout/stderr fragments and session
     ids. Because reverify hashes the **exact** cited bytes
     (`src/memory/project-injection.ts:52-53`), any redaction changes the hash
     and breaks verification. Redaction and verifiability are mutually exclusive
     for the artifact. Mitigation: run a secret-shaped-bytes scan that flags
     loudly before any artifact is admitted; accept that on one machine the blast
     radius is the operator's own `~/.circuit/`; and require any cross-machine
     reuse (Stage 3) to default to artifact-by-reference, never raw bytes.
  3. **"Unknown" is not a gate.** `tierFor()` collapses both `stale` and
     `unknown` into the same tier (`src/app/history/recall-precision.ts:53`);
     only `correlated_negative` is hard-suppressed (`:49`); the budget of 3 fills
     best-tier-down (`:128-136`). So on the thin, cold pool this doc describes, a
     foreign fact that grades `unknown` (no run folder and no replicated
     artifact) is still injected, ungraded, into the budget. The protection for a
     forged or unverifiable foreign fact is the layered floor (hint-only,
     budget-of-3, corroboration, write boundary, and Stage-3 quarantine), **not**
     cite-and-verify, which here only prevents the fact ranking as fresh. This is
     the same honest limit stated above; the two sections must be read together.
- **2d, pooled recall branch, sharing on (medium).** When a pool exists for the
  resolved project id, read pooled facts in addition to the local store, reverify
  each via the two-root reverify, and route them through the same earned-precision
  gate and budget of 3 (now query-ranked and corroboration-aware from Stages 0
  and 1). **Re-validate every pooled record's inner `MemoryInputV0` through
  `MemoryInputV0Schema.parse` (the same `.strict()` / `authority:
  z.literal('hint_only')` path the local store uses on read) before it can become
  a recall candidate; a parse failure drops the record loudly as a warning, never
  coerces it.** Reverify recomputes staleness only and does not validate
  authority, so it cannot substitute for this parse; the hint-only invariant is
  only as absolute as its enforcement point. Add a one-line operator indicator
  that pooled facts are in play. Extend `circuit memory list` to show pool
  provenance and add `circuit memory promote` for the propose-first staging tier.
  Single-operator regime, so there is no cross-person Sybil, trust, or redaction
  surface to build yet; the cross-worktree code-trust surface is handled by the
  write boundary (2c) and the hint-only floor.

After Stage 2 the live worktrees pool what each other prove, the lost-update race
is gone, and the ratchet has corpus density for the first time. No
schema-of-record change, no engine edit, and reversible (with the foreign-fact
rollback caveat below).

### Stage 3. Portable evidence bundles for a cross-machine team (large, on demand)

Only when real teammates exist and the swarm has produced a corpus worth
exporting. `circuit memory export` / `import` / `review` / `accept`: a
content-addressed bundle carrying the unchanged `MemoryInputV0[]` payload plus
`artifacts: {sha256 -> bytes-or-ref}` plus provenance on the bundle envelope.
Import re-hashes bytes against their keys (a fail-closed integrity gate),
re-anchors reverify against in-bundle artifacts, and lands survivors in a
**quarantine** staging tier that requires explicit operator accept before
anything is model-facing. Quarantine is non-negotiable here precisely because
in-bundle artifacts are attacker-shippable (the 2c forgery surface crosses a real
machine boundary at this stage): a teammate can ship both a fact and a matching
artifact, so import integrity proves the bundle is internally consistent, not
that it is true. Default to artifact-by-reference (no raw bytes leave the machine)
unless the operator opts in, with a redaction pass that holds back secret-shaped
facts loudly.

This is the on-record recommended first cross-machine shape ("portable evidence
bundles, not ambient cloud memory") and the strongest team posture: nothing is
model-facing until reviewed, so it never re-creates the ambient shared-bank
precondition the dominant attack needs. It reuses Stage 2c's evidence pool and
re-anchored reverify wholesale, so it is mostly CLI plus one bundle schema, and
it inherits 2c's forgery and redaction constraints, which is why operator review
is the primary defense at this tier.

## Approaches considered

Five end-to-end approaches were designed and scored head-to-head by four judges
(value-density, architectural-fit, security-adversary, pragmatist-sequencing).

| Approach | Summary | Verdict |
|---|---|---|
| **A5** Retrieval-first | Make recall query-ranked and corroboration-aware before any sharing | **Adopt** as Stages 0-1, the mandatory foundation |
| **A2** Same-machine swarm pool | Append-only per-observation pool, evidence replication, pooled recall for parallel worktrees | **Adopt** as Stages 2a-2d, the centerpiece |
| **A1** Substrate-first | Rewrite the local store into an append-only event log, ship no sharing in-slice | **Fold in**: its Observation-envelope and event-log discipline into A2's internals, do not pay the full rewrite up front |
| **A3** Portable evidence bundles | Explicit export/import of redacted, verified, operator-reviewed bundles | **Defer** to Stage 3, on demand, when teammates appear |
| **A4** Tracked git-shared tier | Commit a `.circuit-shared/` tier into the repo, teammates sync via git pull | **Reject as written** |

Judge rankings (best first): value-density A2>A5>A1>A3>A4; architectural-fit
A1>A5>A2>A3>A4; security-adversary A3>A2>A5>A1>A4; pragmatist-sequencing
A5>A2>A1>A3>A4. A4 is unanimously last. A5 and A2 are in every panel's top
three.

**Why A4 is rejected.** It fuses four hard-to-revert decisions into one slice: a
breaking `MemoryInputV0` change, a tracked tier carved out of `.gitignore`, the
full cross-machine antibody stack, and standing recall debt. A tracked tier in
git history is a permanent one-way door: a single redaction miss is a secret
pushed to every clone's history, which a revoke-tombstone cannot scrub. It most
fully re-introduces the ambient shared-bank poisoning precondition with repo
push-access as the only trust boundary. If ambient git-native team sync ever
becomes a hard requirement, it should be a separate, considered decision, with
A3 (bundles) tried first as the reversible alternative.

## Key design decisions

| Decision | Choice | Rejected alternatives |
|---|---|---|
| Where the pool lives | `~/.circuit/pools/<projectId>/`, outside any repo, one append-only file per (cluster, observing run), grouped at read time | A4's tracked `.circuit-shared/` (permanent exfil door); a single content-addressed `facts/<id>.json` per fact (the id is the cluster hash, not the bytes, so two observers collide and last-writer-wins); JSONL + `merge=union` (reorders lines, no dedup, and GitHub server-side merge ignores `.gitattributes`); A1's in-place rewrite (largest build, no sharing in-slice) |
| How cross-agent facts stay verifiable | Replicate cited bytes (artifact-first) into a sha256-keyed evidence pool written only by the trusted harvester; reverify falls back run-folder, then `artifacts/<sha>`, then `unknown` or `pending` | Git-visible-blob anchor (pulls toward tracked history); leave reverify as-is (every pooled fact stale forever); trust the claim without bytes (no grounding at all) |
| Who may write evidence | The terminal-outcome-gated run-finalize harvester only, after confirming bytes against the live run folder | Any observe/promote call (turns reverify into an attacker-satisfiable tautology) |
| Schema-of-record | `MemoryInputV0` (.strict, `hint_only`) touched zero times; provenance rides a new Observation envelope; corroboration count rides only on the recall audit sidecar; pooled records re-parsed through the strict schema on read | Provenance sub-object on `MemoryInputV0` (strains the schema-of-record and its contract tests); trusting the envelope's inner object without re-parsing (bypasses the hint-only floor) |
| Corroboration math | Count distinct run_ids per content-id group, collapse same-run repeats, sublinear dampener, tiebreak within a tier only, gated to the non-verifiable tail, presented as raw advisory provenance (not Sybil-proof) | A truth-discovery / Bayesian source-fusion engine (rejected by ROI, below); counting distinct content-ids (collapses rediscoveries); letting corroboration cross tiers or rescue a stale fact; presenting the count as an independence guarantee |
| Distiller wiring | App-layer run-finalize in `src/cli/run.ts` after the engine returns, report-only first, fail-open, terminal-outcome gated | Inside `src/runtime` (violates the engine boundary); hooking the engine's `run.completed` event (wrong layer); auto-record on every close (changes hot-path before cost is proven); ship hand-notes only (pool shares almost nothing) |
| Regime order | Same-machine pool fully before any cross-machine work; reject A4 | Lead with cross-machine (over-built, needs a corpus that does not exist); build A1's full substrate first (correct but ships no sharing) |

## What not to build

- **No truth-discovery engine.** The decisive ROI finding from the truth-discovery
  literature: sophisticated source-reliability and copy-detection models beat
  plain majority voting by a small margin while costing roughly one to two orders
  of magnitude more runtime, and several are unstable across runs. They exist to
  infer ground truth from agreement; cite-and-verify already supplies ground
  truth. For verifiable facts, verification dominates voting. Corroboration earns
  its keep only for the non-verifiable tail, and there a simple distinct-run
  count with an independence caveat captures nearly all the value.
- **No sequence CRDTs, operational transforms, or vector clocks.** A fact store
  is an unordered set, not a collaboratively-edited document. A grow-only set
  with union merge is the minimal correct substrate. Borrow at most a "dot" (an
  author id plus a local counter, the standard CRDT primitive for tracking which
  writer produced which update) if supersession ordering is ever needed.
- **No LLM in the merge or conflict path.** Keep resolution deterministic: the
  model may cluster candidates, but code picks the winner by version marker. The
  grow-only-set and per-record-determinism argument above already settles this on
  first principles; external work reports that LLM merge degrades sharply under
  weak backbones (specific figures are from a post-cutoff source flagged in the
  references, verify before quoting).
- **No ambient cloud memory, no universal cross-project brain.** The prior art
  lists these under what-not-to-build-first, and the cautious posture is
  load-bearing for trust.
- **No softening of reverify to similarity matching.** A substantial fraction of
  post-hoc citations are post-rationalized (the source does not actually support
  the claim). Circuit's sha256-pinned, byte-identical reverify is stronger than
  typical attribution precisely because it checks the exact bytes. Keep it.

## Security posture and threat model

Pooling re-introduces the shared-bank precondition that project-local scope
deliberately removed (the MINJA memory-injection attack reports very high
injection success and works specifically because records carry no author
identity). The layered floor that replaces scope-as-blast-radius-limit:

- **Hint-only authority, absolute, and enforced at the read point.** A poisoned
  fact degrades attention; it never seizes control. This mirrors the host
  platform's own move (Claude Code removed user memories from the system prompt to
  cut the high-trust override path; verify the exact version before citing it).
  The invariant is only as absolute as its enforcement, so the pooled-read branch
  must re-parse every inner record through the strict schema (Stage 2d) and never
  trust the envelope's inner object as-is.
- **Attacker-controlled evidence is a new forgery surface.** Re-anchoring reverify
  to a content-addressed pool the writer controls makes the integrity check a
  tautology: the lookup key and the equality target are both
  `fact.source.sha256`, so any bytes the attacker writes verify against their own
  hash. This is the sharpest new exposure and it is why evidence bytes are written
  only by the trusted run-finalize harvester (Stage 2c), and why Stage 3 import
  keeps everything in quarantine. The artifact moat holds only against an attacker
  who cannot write the evidence pool. A code-trust adversary on one machine who
  can run real flows can manufacture genuinely-reverifiable evidence across two
  run_ids and satisfy a 2-run threshold, so the residual is broader than "sincere
  error."
- **Budget of 3 plus tiering is isolate-then-aggregate, not a poisoning bound.**
  Isolate-then-aggregate (the RobustRAG principle) means each retrieved item is
  processed separately and then combined, so no single item dominates the answer.
  But under pooling the budget of 3 becomes an adversarial ranking contest:
  stale and unknown poisoned facts remain pushable (only measured-negative is
  hard-suppressed, `src/app/history/recall-precision.ts:49,129`), and a novel attacker
  fact is never measured-negative on first recall, so a flooder writing many
  query-relevant facts can occupy several of the three slots for a targeted query.
  Hint-only caps the damage of any single slot but does **not** bound how many
  slots are poisoned. The actual structural defense before Stage 3 is the write
  boundary (same-machine equals a single operator's trusted runs only). The
  load-bearing assumption is that benign facts outnumber malicious; consider a
  per-source cap on pool facts per recall if that assumption weakens.
- **Distinct-independent corroboration, never raw count.** Same-machine agents
  share a base model and co-hallucinate, so a high count is weak agreement. Count
  distinct run_ids, collapse same-run repeats, keep it sublinear, present it as
  raw advisory provenance, and treat real independence (distinct model, seed, or
  person) as arriving only in the cross-machine regime. Remember run_ids are free
  to mint, so the count is not Sybil-proof.
- **Quarantine before model-facing (Stage 3).** Imported team facts land in a
  staging tier and require explicit operator accept. Write-time admission control
  beats read-time content filtering, which is an arms race the defender loses.
- **Append-only closes the in-place-replacement hole.** The current
  read-rewrite-last-write-wins path is replacement-native, the one attack class
  even the best read-time defenses miss. Per-observation append-only writes make
  replacement detectable.

State the cite-and-verify limit explicitly in any shipped design: it catches
drift and forgery-of-source, not sincere error and not attacker-authored
evidence, and on failure it sinks rather than drops.

## Biggest risks and mitigations

- **Empty-pool cold start.** The distiller is unwired and the thin solo corpus
  rarely meets the 2-independent-runs threshold, so the auto-pool may be empty at
  first. Mitigation: Stage 2a wires it; pooling concurrent worktrees is itself
  the mechanism that reaches the threshold faster than one machine can; hand
  notes work day one; frame value as ramping, not instant.
- **Homogeneous co-hallucination and free run_ids.** Same-model agents agreeing
  is weak corroboration, and one actor can mint many run_ids. Mitigation:
  sublinear, tier-invariant, tail-gated, raw advisory provenance not a
  probability, hint-only absolute, count framed as a floor not a guarantee.
- **Cite-and-verify over-claimed.** Mitigation: document the limit (drift and
  forgery only, plus the attacker-evidence tautology); rely on the layered floor,
  the write boundary, and, for the team regime, operator review as the primary
  defense against sincere-but-wrong and attacker-authored facts.
- **Rollback loses pool-only value.** The pool holds foreign facts the
  per-worktree, flow-scoped, `.strict()` local store cannot represent, so "roll
  back to the local store" silently discards every pool-originated fact and its
  corroboration. Mitigation: state it plainly (acceptable for a flagged
  experiment), keep the local store as a write-through mirror of **this**
  worktree's own harvested facts for one release, and scope the projection-parity
  test to the locally-originated subset it can actually assert parity for. The
  "reversible" claim above means reversible minus any value that existed solely in
  the pool.
- **Scope creep in Stage 2.** Mitigation: land 2a-2d independently behind a
  dual-read fallback; keep the local store as a write-through mirror for one
  release so rollback re-reads it; run `npm run verify` before claiming done.
- **Harvest near the engine boundary.** Mitigation: wire at the app/CLI layer in
  `src/cli/run.ts` after the engine returns, gate on terminal outcome,
  report-only first, fail-open.
- **Project-id collision and split.** The git-remote-hash key over-merges and
  under-merges. Over-merge: a fork keeps `origin` on upstream until re-pointed, so
  fork and upstream share one pool (`normalizeGitRemoteUrl` preserves
  host/owner/repo and cannot tell a fork from the original,
  `src/memory/project-identity.ts:59`); a monorepo's two subdir worktrees share
  one origin and one pool spanning unrelated subprojects. Under-merge: a remote
  rename, org transfer, host migration, or SSH host alias re-keys the same project
  to a different id, silently splitting the pool and resetting corroboration, and
  the instability warning fires only when there is no remote at all
  (`:128`). Mitigation: recommend pinning `project_id` in config for any
  shared pool and soften the "stable across clones" framing.
- **A future cross-machine path mis-built toward A4.** Mitigation: keep all
  pooled artifacts under `~/.circuit/` through Stage 2; for Stage 3 default to
  artifact-by-reference with a fail-closed redaction gate and explicit accept.

## Open questions

- **Observer identity granularity on one machine.** Per-worktree (distinct
  lineage but homogeneous model) versus one machine-wide id (no independence
  signal). Recommendation: per-worktree as the v0 swarm id, documented as weak
  corroboration, counted as advisory provenance only.
- **Harvest latency at run-finalize.** Unknown until wired; Stage 2a is
  structured to measure it report-only before enabling writes.
- **Evidence-pool growth, eviction, and orphans.** Artifacts dedup by content
  hash and are size-capped, but the pool still grows, and the artifact-first write
  ordering deliberately tolerates orphan artifacts (artifact written, fact never
  committed). When is evicting an unreferenced or orphan artifact safe, and is it
  operator-confirmed or automatic?
- **Project-id convergence for the no-git-remote fallback.** Two such worktrees
  do not share a pool and pooling silently disables. Is extending the existing
  instability warning enough, or should the operator be prompted to set
  `project_id` (which is also the fix for the fork over-merge and rename split
  above)?
- **The display threshold for corroboration.** On a thin corpus most claims sit
  at count=1. The distinct-run count at which surfacing provenance changes
  operator behavior rather than adding noise is empirical.

## How this slots into the existing lineage

This is the explicitly-deferred cross-worktree tier of Circuit's three-thesis
memory lineage, not a fourth thesis. It realizes the Self-Auditing Memory s5
prescription (append-only events folded into state, transitions validated in the
store rather than in per-record Zod) by making the pool an append-only log and
recall a projection over it. It reuses the git-remote-hash project id chosen for
exactly this (with the new opt-in pin to fix its over- and under-merge), the
content-id group key, the `hint_only` authority, the existing reverify, and the
earned-precision tiers. It keeps the engine untouched. And it serves the
Effective Memory Program's correction directly: measurement is the last gate, not
the foundation, so the near-term value here is bounded knowledge-sharing plus the
corpus density that might finally let measurement fire, not a promise that a
cross-agent ratchet works on day one.

## Selected references

Numbers attributed to these sources are as the cited work reports them. The
second group was emitted after the January 2026 model knowledge cutoff and could
not be verified from model training; link-check each arXiv ID resolves to the
claimed paper, and re-confirm any figure, before relying on it.

**Verifiable (pre-cutoff or non-arXiv).** Substrate and merge: Shapiro et al.,
CRDTs (INRIA RR-7506); git `merge=union` (git-scm gitattributes); Fowler, Event
Sourcing; IPFS Merkle-DAG. Grounding and verification: Chain-of-Verification
(arXiv 2309.11495); "Correctness is not Faithfulness in RAG Attributions" (cite
venue/ID before quoting the post-rationalization figure). Poisoning and trust:
MINJA (arXiv 2503.03704); RobustRAG (arXiv 2405.15556); PoisonedRAG (USENIX
Security 2025); OWASP ASI06 (2026). Corroboration and truth-discovery:
Knowledge-Based Trust / Knowledge Vault (VLDB 2015, KDD 2014);
Dong/Berti-Equille/Srivastava source-dependence (PVLDB 2009); Waguih and
Berti-Equille truth-discovery evaluation (QCRI 2014). Pooling value and
retrieval: Collaborative Memory (arXiv 2505.18279); Voyager (arXiv 2305.16291);
MemGPT (arXiv 2310.08560); Generative Agents (arXiv 2304.03442); G-Memory
(NeurIPS 2025).

**Post-cutoff, unverified (link-check before trusting any figure).** SSGM (arXiv
2603.11768); Portable Agent Memory (arXiv 2605.11032); RAGShield (arXiv
2604.00387); SuperLocalMemory (arXiv 2603.02240); "Don't Ask the LLM to Track
Freshness" (arXiv 2606.01435); "Diagnosing Retrieval vs. Utilization
Bottlenecks" (arXiv 2603.02473, the source for the Stage 0 retrieval-dominance
figures). The Stage 0 sequencing decision rests on the directional finding that
retrieval dominates capture, which is corroborated across several of the
verifiable sources above; do not let its precise figures stand on the
post-cutoff citation alone.
