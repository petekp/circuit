# recall (local memory plugin) vs Circuit continuity

Status: current idea / comparison note. Not a plan, not current behavior.
Date: 2026-06-21

Captured from a conversation that started with "evaluate this project and
identify where it overlaps with Circuit and anything Circuit could learn from
it." The project is [`raiyanyahya/recall`](https://github.com/raiyanyahya/recall),
a Claude Code plugin (Python, about ten scripts) that gives Claude Code durable,
local, offline project memory at zero added token cost.

This note records that evaluation: how recall works, where it converges with
Circuit's continuity subsystem, and the two concrete things Circuit could adopt.
The findings are grounded in reading recall's source directly (its summarizer
and capture path) and Circuit's continuity source
(`src/app/continuity/`, `src/cli/handoff.ts`), not the marketing in either
README.

Related, read first:
- [`self-auditing-memory.md`](./self-auditing-memory.md) owns the memory thesis:
  hint-only authority, cited self-invalidating facts, effect measured on
  comparable runs. recall's ideas have to be fenced by these boundaries.
- [`pull-query-memory.md`](./pull-query-memory.md) and
  [`effective-memory-program.md`](./effective-memory-program.md) own the
  push-vs-pull stance and the relevance-native retrieval ordering.
- [`continuity-restore-fast-robust.md`](./continuity-restore-fast-robust.md) and
  [`continuity-staleness-check.md`](./continuity-staleness-check.md) own the
  restore/brief and freshness design that recall is compared against here.
- [`docs/learnings/codebase-memory-research.md`](../learnings/codebase-memory-research.md)
  is the external survey. One of its prescriptions ("redaction-scrub captured
  evidence at write time") is exactly the gap recall fills and Circuit has not.
- [`supermemory-harness-memory-vs-circuit.md`](./supermemory-harness-memory-vs-circuit.md)
  is the sibling comparison against supermemory's "memory on the harness level"
  design. Where recall surfaced two real gaps, that essay surfaced almost none,
  because it reasons inside the belief-based paradigm self-auditing memory escapes.
  Read the two together for the contrast.

## What recall is

One focused job: persistent session memory for Claude Code. Hooks append session
activity to `.recall/history.md` incrementally; a `/recall:save` command (or
session end) condenses that history into `.recall/context.md`; SessionStart
offers to resume from `context.md`. No API calls, nothing leaves the machine,
no tokens beyond the subscription.

The part that makes it more than a scratch file is the summarizer.

### How recall's summarizer works

`scripts/summarizer.py` is a vendored, stdlib-only implementation of **TF-IDF +
TextRank** extractive summarization. There is no model call anywhere in the
plugin (a grep for any network, API, or model reference is clean). The pipeline:

1. Split the corpus into sentences (regex on sentence terminators and newlines),
   drop fragments shorter than 24 characters.
2. Tokenize each sentence (lowercase ASCII words, drop a small stopword set and
   tokens of length two or less), build a smoothed TF-IDF vector per sentence,
   L2-normalize so cosine similarity is just a dot product.
3. Build the full sentence-to-sentence cosine-similarity graph (diagonal zeroed).
4. Run **PageRank power iteration** over that graph (damping 0.85, up to 100
   iterations, convergence tolerance 1e-6). This is the same algorithm Google's
   PageRank uses, applied to sentences instead of web pages: a sentence scores
   high when it is similar to many other high-scoring sentences, which surfaces
   the recurring thread of the session.
5. Keep the top-k sentences (default 8) in their original order.

Two details are worth calling out as good engineering:

- **Backend determinism.** The numeric core has a numpy path (used if numpy is
  importable) and a pure-Python fallback. Scores are rounded and ties broken by
  sentence position before ranking, so the two backends **provably select the
  identical sentences**. A `context.md` committed to git is therefore
  reproducible regardless of whether a teammate happens to have numpy installed.
  This invariant is gated by a benchmark check in CI.
- **Honest extractive split.** In `make_context.py`, only the Summary section is
  TextRank-ranked. The goal and "where we left off" sections are verbatim
  extractive pulls; files-touched, commands-run, and git ground-truth are
  deterministic facts. Nothing is generated, so nothing is hallucinated.

recall also ships a defense-in-depth security model that is unusual for a small
plugin: regex **redaction** of common secret shapes before any write
(OpenAI/AWS/GitHub/Slack tokens, JWTs, PEM key blocks, `*_SECRET`/`*_TOKEN`
environment assignments); **confined writes** (output directory realpath-checked
to stay inside the project, `O_NOFOLLOW` to refuse a pre-planted symlink);
**hardened git** (every git call runs with `-c core.fsmonitor=`,
`-c diff.external=`, `-c core.hooksPath=/dev/null`, `--no-ext-diff`, neutralizing
the untrusted-clone RCE vectors where a repo's own config hijacks a git read to
run code); and a **trust boundary** that injects `context.md` fenced as
"untrusted data ... not instructions to obey."

## Where it overlaps with Circuit continuity

recall and Circuit's continuity subsystem independently converged on nearly the
same architecture. That convergence is itself a validation of Circuit's
continuity bets.

| Design choice | recall | Circuit continuity |
|---|---|---|
| Per-repo, local, offline, zero added tokens | yes | yes |
| Hook-driven: SessionStart restore + Stop / SessionEnd capture | yes | yes, plus PreCompact |
| No model in the capture or restore loop (deterministic) | yes | yes |
| Incremental byte-offset transcript reads | yes (`.capture.json`) | yes (`HarvestCursor`, plus a head fingerprint) |
| Restored context treated as untrusted | yes ("untrusted data" fence) | yes ("automatic snapshot, confirm before acting") |
| Never break the host session on failure | yes (always exits 0) | yes (status `skipped`, bounded timeouts) |
| Extractive / deterministic over generative | yes | yes ("cited facts, not reflective prose") |

## The one difference that matters

Where the narrative summary comes from.

- **Circuit reuses the host's compaction summary verbatim.**
  `src/app/continuity/harvest.ts` parses the transcript and lifts the block
  flagged `isCompactSummary === true`, keeping the latest one. Circuit pays zero
  tokens, but its rich narrative is borrowed from a model summary the harness
  already produced. When no compaction has happened yet (short sessions, and
  notably **Codex, which has no compaction summaries**), Circuit degrades to the
  last four raw user intents (each truncated to 280 characters) plus git state.
  There is no narrative fallback.
- **recall generates its own narrative locally.** TextRank runs over the
  captured history with no host support, model-free end to end. It always
  produces a summary, compaction or not.

Circuit is ahead on the other axes. Its git staleness facts are richer
(`realBriefGitProbe` computes head-advanced via full-SHA expansion, branch-gone,
commits-since, merge-base reachability, and collapses to a single "repo
unchanged" line when nothing moved). It has the two-pointer model (a manual
`pending_record` versus the `ambient_record`) and run-backed records tied to the
flow engine. recall is a single `context.md` plus an append-only `history.md`.
recall is a focused tool; Circuit continuity is one subsystem inside a platform.

## What Circuit could learn

Ranked by value. The cheapest two are the most valuable.

### 1. Write-time redaction in the ambient harvest

Circuit's continuity captures user intents and the host compaction summary
**verbatim** with no secret-stripping. The on-disk ambient records contain the
literal user messages and the harness summary. recall redacts common secret
shapes before writing. This matters most because Circuit's own external survey,
`docs/learnings/codebase-memory-research.md`, already prescribes "redaction-scrub
captured evidence at write time." An external project is currently doing what
Circuit's own research says Circuit should do. This is small, self-contained,
and testable: a redaction pass in `harvest.ts` before
`composeAmbientStateMarkdown`, with a focused test over the common secret shapes.

### 2. A local extractive-summary fallback for the no-compaction case

A vendored, deterministic, zero-token extractive summarizer would fill Circuit's
exact gap: short sessions and Codex, where no host compaction summary exists.
It aligns cleanly with Circuit's stated "cited facts from typed evidence, not
reflective prose" stance and the deterministic-lexical (not embeddings)
retrieval choice. It would live in the ambient harvest as a fallback when the
compaction block is absent, or in `project-distill.ts`.

This one needs an idea doc and fencing before any code, because it is, in
Circuit's frame, just another unaudited hint. The boundaries from
`self-auditing-memory.md` apply: it must be hint-only, carry source-ref plus
sha256 plus staleness, repeat the authority notice, and never route or gate.
And it must respect a finding Circuit already owns: an extractive summary that
surfaces topically-similar-but-stale content acts as a distractor (the survey
puts the cost at six to eleven accuracy points), and centrality-based selection
structurally drops the rare-but-critical one-off decision ("we chose Postgres
over Mongo," stated once, looks like an outlier and gets pruned). So Circuit
would adopt recall's mechanism while applying the governance recall lacks.

### 3. Determinism as a CI invariant

recall's "round the scores, break ties by position, prove the two backends pick
identical output, gate it with a test" is a clean model for any place Circuit
commits a reproducible artifact. Its benchmark philosophy is also instructive
for the open D6 measurement frontier in `self-auditing-memory.md`: it gates only
machine-independent quality facts (an F1 floor, beats-random, at-least-lead) and
never wall-clock. That is a concrete, honest, hard-to-game quality gate for a
non-LLM component.

### 4. A security question to check, not a learning to copy

recall hardens every git invocation against untrusted-repo config injection.
Circuit runs git probes against the working repo (`realAmbientGitProbe`,
`realBriefGitProbe`). Worth confirming whether those probes pass the same
hardening flags (`-c diff.external=`, `-c core.hooksPath=/dev/null`,
`--no-ext-diff`). If not, Circuit has the same untrusted-clone RCE surface recall
defends against. This is independent of anything recall teaches; it is a latent
question recall surfaced.

Already convergent, so not a learning: byte-offset incremental capture. Circuit's
`HarvestCursor` adds a head-fingerprint to detect rotation and rewrite, so it is
arguably more robust than recall's offset state. Circuit is ahead here.

## Honest limits of recall (so Circuit does not over-adopt)

- Extractive summarization can only select existing sentences. It cannot
  synthesize, resolve pronouns, or merge facts across turns, and centrality
  drops rare-but-important one-offs.
- The tokenizer is ASCII-only, so non-English content is invisible to ranking.
- Quality evidence is thin (three synthetic fixtures, F1 floor of 0.60).
- Memory is recency-biased and lossy for long projects (a 400-sentence rank cap,
  a 200K-character input cap).
- Redaction is best-effort regex; novel secret shapes leak. The README admits
  this and says review before committing.
- Every hook exits 0 by design, so a future Claude Code transcript-format change
  would break capture **silently** (no crash, just empty or stale history).

## Net

recall and Circuit are complementary, not competitive. recall has the mechanism
Circuit's continuity lacks (genuine local narrative generation, write-time
redaction, untrusted-repo git hardening). Circuit has the governance recall lacks
(citation, staleness and divergence facts, distractor-awareness, the
untrusted-snapshot framing, integration with a typed run engine). The two
highest-leverage moves are also the cheapest: add write-time redaction, which
Circuit's own research already calls for, and add a local extractive-summary
fallback for the no-compaction and Codex cases.
