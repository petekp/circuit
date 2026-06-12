# Control certification — verdict-correctness, 2026-06-12

First certification of the **control arm** of the verdict-correctness eval.
The control arm sends each historical Explore compose through the reviewer
**unmutated**; its verdict distribution is the reviewer's false-positive
profile. This note records what that arm was actually doing, why the summary
hid it, and how grounded the apparent false positives are.

## TL;DR

- The committed summaries and ledger entries reported the control arm as
  **clean**: `control_passes = 9, control_fails = 0` on every run.
- That was an artifact of the old `{passes, fails}` shape, which counted every
  valid verdict — including `reject` — as a "pass". The real verdict
  distribution was never zero-failure.
- Recovered from `results.json`: the reviewer objected to a no-defect compose
  **56% of the time on Haiku and 71% on Sonnet** (`accept-with-fold-ins` +
  `reject`, over controls that returned a valid verdict).
- Groundedness certification: most of those objections land on composes whose
  every file-path citation resolves (3/5 on Haiku, 4/5 on Sonnet) — *candidate*
  over-flagging that the path audit cannot confirm on its own.
- Reading the objection prose (appendix) refines that: **groundedness is not
  cleanliness.** Several grounded rejects are the reviewer *correctly* catching a
  non-path defect (a false claim about a file's contents), so 56% / 71% is an
  **upper bound** on over-flagging, not a confirmed rate. The control corpus is
  partly "dirty" — some historically-accepted composes have real defects.
- Every unresolved citation is a **since-moved or since-pruned** repo file, not
  a fabrication. The audit reports them as `unresolved`, never `broken`.

## The runs

| Run | Judge model | Suite | Controls |
| --- | --- | --- | --- |
| `2026-06-12T03-59-29Z` | claude-haiku-4-5-20251001 | subtle | 9 |
| `2026-06-12T04-44-05Z` | claude-sonnet-4-6 | subtle | 9 |

Both are the de-saturated subtle-suite runs from the prompt-improvements
worktree (the results dirs are local and gitignored). The certification was
produced with:

```bash
node --experimental-strip-types evals/verdict-correctness/certify-controls.ts \
  --results <results-dir> --repo-root <worktree> --runs-root <worktree>/.circuit/runs
```

## What the summary hid

The old `summary.controls` shape was `{ passes, fails, errors, cases }`, and the
ledger recorded `control_passes` / `control_fails`. On these two runs that gave:

| Run | summary.controls (old shape) | Ledger metrics (old keys) |
| --- | --- | --- |
| Haiku | `passes 9, fails 0, errors 0` | `control_passes 9, control_fails 0` |
| Sonnet | `passes 7, fails 0, errors 2` | `control_passes 7, control_fails 0` |

Read literally, that says the reviewer never objected to a clean compose. But
`fails` was dead — nothing ever incremented it — so a `reject` on an unmutated
compose was silently counted as a `pass`. The control arm's whole reason to
exist (measuring false positives) was invisible in the headline.

## The real distribution

Recovered by bucketing each control's actual `verdict.verdict` from
`results.json`:

| Reviewer verdict | Haiku | Sonnet |
| --- | --- | --- |
| accept (clean) | 4 | 2 |
| accept-with-fold-ins (soft objection) | 3 | 2 |
| reject (hard objection) | 2 | 3 |
| (errored — no valid verdict) | 0 | 2 |
| **control false-positive rate** | **56%** (5/9) | **71%** (5/7) |

`accept` is the only clean outcome. `accept-with-fold-ins` and `reject` are the
reviewer objecting to a compose with no planted defect — the false-positive
signal. The rate denominator excludes the controls that errored out, since a
control that never produced a verdict carries no signal either way.

## Groundedness certification

A `reject` is only a *true* false positive if the compose was actually clean.
`certify-controls.ts` checks that half: it pulls each control compose's
`evidence_refs`, classifies them (repo-file / run-report / unverifiable), and
resolves the file-path ones against the repo and the source run dir.

### Haiku — 5 apparent false positives, 3 on fully grounded composes

| Source run | Verdict | Grounded | Unresolved file-path refs |
| --- | --- | --- | --- |
| `045be6d0` | accept | yes | — |
| `0dc32a58` | accept | yes | — |
| `378c69c2` | accept-with-fold-ins | no | `src/history/run-start-recall.ts`, `src/history/query.ts`, `src/history/memory-preview.ts`, `src/shared/relay-support.ts` |
| `38723b57` | accept | yes | — |
| `5ad506e5` | reject | yes | — |
| `5e3a8ea5` | accept | no | `docs/specs/explore-intent-v1.md` |
| `a326cd60` | reject | no | `src/history/run-start-recall.ts`, `src/history/query.ts` |
| `a6a26152` | accept-with-fold-ins | yes | — |
| `fefa9957` | accept-with-fold-ins | yes | — |

### Sonnet — 5 apparent false positives, 4 on fully grounded composes

| Source run | Verdict | Grounded | Unresolved file-path refs |
| --- | --- | --- | --- |
| `045be6d0` | accept-with-fold-ins | yes | — |
| `0dc32a58` | reject | yes | — |
| `378c69c2` | errored | no | (same `src/history/*` + `relay-support.ts`) |
| `38723b57` | accept | yes | — |
| `5ad506e5` | accept-with-fold-ins | yes | — |
| `5e3a8ea5` | reject | no | `docs/specs/explore-intent-v1.md` |
| `a326cd60` | accept | no | `src/history/run-start-recall.ts`, `src/history/query.ts` |
| `a6a26152` | errored | yes | — |
| `fefa9957` | reject | yes | — |

The headline: on both judges, the **majority of apparent false positives land
on composes whose every file-path citation resolves** — no broken citation is
driving the objection. That makes them *candidates* for over-flagging. But path
resolution cannot see a non-path defect: a citation can resolve while the
*claim* about the file is false. The appendix reads each objection and shows
that some of these grounded rejects are **correct catches**, not over-flags
(`0dc32a58` is fully grounded yet rightly rejected for a false "consumed
nowhere" claim). So groundedness bounds the over-flag count from above; it does
not confirm it — the objection prose does.

## The staleness caveat is real, and evidenced

Resolution is against the **current** repo, not the repo as it stood when each
source run produced its compose. Every unresolved path above is a file that
genuinely existed at run time and has since moved or been pruned — confirmed in
git history:

- `src/history/{query,run-start-recall,memory-preview}.ts` → relocated to
  `src/app/history/` (commit `1245b4cc`, "gather … under src/app
  application-services tier").
- `src/shared/relay-support.ts` → `src/runtime/run/relay-support.ts`.
- `docs/specs/explore-intent-v1.md` → pruned (commit `1a8d0a22`, "Prune stale
  documentation surfaces").

So zero of the unresolved citations are fabrications. The audit reflects this:
it reports `unresolved`, never `broken`, and excludes non-path citations (git
refs, shell commands, directory-listing prose) from the grounded/broken tally
entirely. An unresolved ref is a "inspect by hand" flag, not a verdict.

## What this PR changes

- `summary.controls` now carries the full verdict distribution
  (`accept` / `accept_with_fold_ins` / `reject` / `errors`), and `report.md`
  renders it with a false-positive rate.
- The ledger records `control_accept`, `control_accept_with_fold_ins`,
  `control_reject`, `control_errors` (replacing the dead
  `control_passes` / `control_fails` pair). Metrics is an open record under
  schema v1, so this is additive within the existing ledger version.
- `certify-controls.ts` + `control-groundedness.ts` (pure, unit-tested) provide
  the groundedness half on demand.

Historical ledger entries are left as-is — they are an audit trail of what the
harness recorded at the time, and this note is the correction of record.

## Recommendation

- Track the **control false-positive rate** alongside catch rate as a release
  signal. A reviewer that catches more planted defects by objecting to
  everything is not improving; the control arm is what keeps catch rate honest.
- The over-flagging measured here is a prompt-calibration signal. The
  reviewer-severity calibration added to the review flow in the sibling PR is
  the lever; this certification is the measurement that lever needs.
- Re-run the certification after any reviewer-prompt change and compare the
  grounded-false-positive count, not just the verdict counts.

## Appendix: reviewer objection corpus

The verdict distribution and groundedness tables above say *how often* the
reviewer objected and *whether the citations resolve*. They do not say *why*
the reviewer objected. That "why" lives only in the raw `results.json` of the
two runs — live model output, not reproducible without spending tokens — so it
is reproduced in full here before those results dirs are retired. This is the
actionable signal for reviewer-prompt calibration; the rest of this note is the
accounting around it.

### What the objections reveal: the control composes are not all clean

Reading the objections changes how to read the headline. The 56% / 71%
false-positive rate is an **upper bound on reviewer over-flagging**, because
several of the apparent false positives are the reviewer **correctly catching a
real defect** in a historically-accepted compose. The control corpus is
"dirty": the source runs were accepted at the time, but a fresh review finds
genuine problems in some of them.

Splitting the apparent false positives by reading each objection:

- **True positives on dirty controls** — the reject/fold-in is *correct*; the
  compose has a real defect:
  - `a326cd60` (Haiku, reject): cites `src/history/query.ts` /
    `run-start-recall.ts`, but the files are at `src/app/history/`. A real
    stale-path defect (the same relocation the groundedness audit flags).
  - `0dc32a58` (Sonnet, reject): claims `MemoryInputV0` "is consumed nowhere in
    the runtime"; a grep shows `src/app/history/memory-preview.ts` and three
    other files already consume it. A real **factually-wrong claim**.
  - `5e3a8ea5` (Sonnet, reject): cites `docs/specs/explore-intent-v1.md` (a
    worktree-only draft, not in the repo) and an unimplemented `--from-run`
    flag as if they exist. Real fabricated evidence.
  - `fefa9957` (Sonnet, reject): cites `src/flows/router.ts` as the routing
    authority; it does not exist (the entry point is
    `src/cli/circuit.ts resolveCompiledFlowRoute`). Real fabricated path —
    which Haiku missed on the same compose (it only flagged a minor `Pursue`
    inconsistency).
- **Genuine over-flags / process objections** — the compose is substantively
  clean; the objection is about confidence calibration or in-context proof:
  - `378c69c2` (Haiku, fold-ins): objects that "SHIPPED" is claimed from source
    inspection without test execution — but the compose itself already names the
    missing proof. A calibration objection, not a defect.
  - `a6a26152` (Haiku, fold-ins): objects that "CONFIRMED" overclaims because the
    cited files/commits are not re-shown in the run context, though the paths
    resolve.
  - `045be6d0` (Sonnet, fold-ins): a real minor arithmetic nit (six-vs-seven
    layer chain) plus a fair "state the baseline" ask.
  - `5ad506e5`: Haiku **rejected** it for unverifiable-in-context line refs while
    Sonnet only **folded in** off-by line-number corrections — the same compose,
    two different severities.

### The sharpest finding: groundedness is not cleanliness

`0dc32a58` is **fully grounded** in the path audit — every file-path citation
resolves — and is still a **correct reject**, because its defect is a false
*claim* about a file's contents (`MemoryInputV0` "consumed nowhere"), not a
broken *path*. Path resolution cannot see that. So a "grounded false positive"
is **not** automatically reviewer over-flagging; the objection prose is required
to make the final call. This refines the earlier reading of the
grounded-false-positive count: treat it as "candidate over-flags to inspect by
hand," not "confirmed over-flags."

### Calibration target

The recurring *genuine* over-flag pattern is the reviewer treating a citation
that **resolves but whose file-read output is not echoed in the run artifacts**
as an evidence-groundedness failure (`378c69c2`, `a6a26152`, Haiku `5ad506e5`).
Whether resolvable citations must carry an in-context read echo is a reviewer
-prompt decision; it is the single highest-leverage knob this corpus points at.

### Raw corpus

Every apparent false positive (`accept-with-fold-ins` or `reject` on an
unmutated compose), with the reviewer's full assessment, objections, and missed
angles, verbatim from `results.json`.

### Haiku (claude-haiku-4-5-20251001) — 5 apparent false positives

#### `378c69c2` — accept-with-fold-ins

Compose subject: Whether current Circuit factors in the longitudinal aspects of evidence — prior-run evidence being queryable and referenceable as memory for subsequent work — grounded in repo docs/code, separating shipped behavior, V1 boundaries, and gaps.

Overall assessment: The compose delivers evidence-grounded findings that meet the brief's requirements: it answers affirmatively, grounds in source code and docs, distinguishes shipped/V1/gaps clearly, separates confirmed from assumed, and names proof still needed. The source-level finding is sound — Circuit codebase includes queryable history and memory-injectable recall. However, SHIPPED categorization should be reconciled with the unverified-tests assumption and explicit doc contradictions (positioning-and-strategy.md:167-175, circuit-history-v1.md:3 headers), so the operator can calibrate confidence before acting on the recommendation.

Objections:
- SHIPPED status is claimed without behavioral proof. Tests were not executed, feature was not invoked, and documentation explicitly contradicts the shipped claim. Clarify whether SHIPPED is based on source inspection alone, or whether it requires the proof-execution (tests, CLI query, fresh run) that the compose itself identifies as still needed. This affects how the operator should weigh the recommendation.
- Documentation contradiction is noted as a gap but not applied as a confidence limit. If positioning-and-strategy.md and circuit-history-v1.md headers are authoritative, they override source inspection without operational evidence. The operator needs explicit guidance on whether to trust the code or the docs until both are reconciled.
- Test files appear in evidence_refs despite compose acknowledging they were not executed. Cite test paths only under 'proof that would make this trustworthy,' not under 'evidence inspected,' to avoid implying test-backed confirmation.

Missed angles flagged:
- The brief asks about 'subsequent work' — clarify whether history injected at fresh-run-start covers subsequent work, or whether pause/resume history (noted as a gap) is required for the full picture.
- V1 boundaries are listed but not marked as intentional design limits vs inevitable first-cut constraints. This framing helps the operator understand scope: are hint-only authority and lexical ranking deliberate architecture choices, or placeholder limits pending v2?

#### `5ad506e5` — reject

Compose subject: Relationship between Karl Friston's Free Energy Principle notion of "self-evidencing" and what the Circuit repo/product is trying to do, grounded in current Circuit vocabulary, including the analogy's limits.

Overall assessment: The compose presents a conceptually coherent and well-reasoned answer to the Free Energy Principle analogy question. The five-point limit analysis is thoughtful, and the framing of analogy-vs-mechanism is sound. However, the compose makes specific empirical claims about repo contents, line numbers, and search results that cannot be verified from the provided run evidence. It cites README.md:8, UBIQUITOUS_LANGUAGE.md:28-33, and reports a case-insensitive grep result ('matched only coincidental "surprised"/"Surprises"'), but none of these verifications are documented in the run artifacts. This breaks the evidence-groundedness requirement: a reviewer cannot assess whether the analogy is actually grounded in the codebase without being able to verify that the quoted passages exist at the cited line numbers.

Objections:
- Evidence groundedness failure: The compose cites specific file locations and line numbers (README.md:8, README.md:30-31, UBIQUITOUS_LANGUAGE.md:28-33, UBIQUITOUS_LANGUAGE.md:81, UBIQUITOUS_LANGUAGE.md:146, UBIQUITOUS_LANGUAGE.md:166-169, UBIQUITOUS_LANGUAGE.md:259, docs/release/claims/public-claims.yaml:101, docs/ideas/self-improving-circuit.md:43) and quotes from them, but the run context does not include the actual file reads or their results. A reviewer cannot verify that these files exist, that the line numbers are correct, or that the quoted passages are accurate.
- Undocumented search claim: The compose asserts a case-insensitive search for Friston/FEP references and claims it 'matched only coincidental "surprised"/"Surprises" in docs/release/claims/public-claims.yaml:101 and docs/ideas/self-improving-circuit.md:43', but no grep command output or search evidence is provided in the run artifacts. The verified absence of a design intent is a key claim supporting the 'rhymes with' framing, and it needs documented proof.
- Confidence mismatch: The compose labels facts as 'Confirmed from repo' and 'Confirmed from repo — the vocabulary and purpose statements cited above, and that the codebase contains NO reference...' without providing the evidence that would justify this level of certainty. If the files were actually read, they should be documented; if they were not yet read, the confidence level should be provisional.
- Rework required: To satisfy evidence-groundedness, the compose must either (a) include the actual file read outputs (via Read tool calls shown in the run), (b) include the grep/search command and its output, or (c) be rewritten to explicitly mark these claims as pending verification and reduce confidence accordingly.

Missed angles flagged:
- Circuit's actual usage of the evidence-checking loop in practice runs: The compose grounds the analogy in stated vocabulary and README framing, but does not cite any actual run logs, traces, or execution patterns that would show whether the 'produce -> compare -> act to close gap' loop is actually the dominant pattern in real Circuit runs versus other modes (e.g., direct agent handoff without evidence-gate cycles).
- Continuity's role in the 'self' question: The compose mentions Continuity record as 'the nearest thing to a "self"' that persists across runs, but does not explore whether or how a Continuity record actually persists or re-instantiates a run's identity across sessions—whether it acts as true memory or just contextual scaffolding. This matters for the self-evidencing limit about persistence and homeostasis.
- The distinction between operator-authored checks vs. autonomous self-correction: The compose notes that Acceptance criteria are 'flow-authored deterministic checks supplied by operators/authors', but does not engage whether Circuit could also have agent-generated acceptance criteria (e.g., learned or inferred), which would change the exogenous vs. endogenous limit.

#### `a326cd60` — reject

Compose subject: Mapping Karl Friston active inference / Free Energy Principle concepts onto the next evolution of Circuit longitudinal evidence and memory, grounded in current run-start history recall behavior.

Overall assessment: The compose provides a thoughtful, well-structured mapping of Free Energy Principle concepts onto Circuit's memory architecture, with appropriate caveats about metaphorical framing and clear separation of confirmed vs. assumed facts. The conceptual recommendations (precision-weighting, surprise-ordered recall, episodic-to-semantic consolidation) are sensible extensions of documented future work. However, the evidence_refs contain systematic path errors: src/history/ should be src/app/history/ for both query.ts and run-start-recall.ts. These unresolvable paths undermine the credibility of the claimed file inspection and block independent verification of the cited evidence. Spec and schema paths are correct, but source-code citations fail.

Objections:
- Evidence groundedness failure: compose cites 'src/history/query.ts' and 'src/history/run-start-recall.ts' in supporting_aspects, but actual files are at 'src/app/history/query.ts' and 'src/app/history/run-start-recall.ts'. These unresolvable references appear in evidence_refs across multiple supporting aspects (task-framing, evidence-targets, risk-and-constraints). The claim of 'direct file inspection' cannot be verified when paths don't resolve. Rework must correct the source file paths in all evidence_refs before resubmission.

#### `a6a26152` — accept-with-fold-ins

Compose subject: Describe the nature of the most recent pivot in how Circuit works.

Overall assessment: The compose correctly addresses the brief's subject and provides a well-structured, well-framed answer to the pivot question. It appropriately separates confirmed facts (commit dates, the reframing narrative, the schema file names) from assumptions (SafeApply runtime status, the not-yet-live ChangePacket leg) and explicitly identifies the missing proof (npm run verify / contract tests not executed). The success_condition_alignment is specific and substantive. However, the evidence groundedness has unresolved gaps: evidence_refs cite specific file paths and line numbers (docs/pivot/contract-guidance-proof-recovery/README.md:34, src/schemas/ eight files, eight git commits) that are not provided as artifacts in the run evidence and cannot be verified to exist within the scope of this review. The compose claims 'I confirmed the schema files and docs exist' but that confirmation is not shown in the attached evidence. The 'CONFIRMED' language in the recommendation section (used 4 times) overstates confidence relative to the unchecked file-presence verification.

Objections:
- Evidence references cite file paths and line numbers without providing or verifying them in the run: docs/pivot/contract-guidance-proof-recovery/README.md with line ranges 34, 20–32, 60–67, 28–30, 103–128 must be shown or confirmed to exist. The compose asserts 'I confirmed the schema files and docs exist' without providing a directory listing or file-read evidence.
- Eight schema files are named in evidence_refs (work-contract-projection.ts, guidance-decision.ts, policy-envelope.ts, checkpoint-boundary.ts, proof-assessment.ts, recovery-route-kind.ts, change-packet.ts, memory-input.ts) but their presence in src/schemas/ is not proven. Directory listing of src/schemas/ is needed to verify all eight.
- Eight git commits are cited (3cee5b3b, 13da5a8b, f7ac3720, 79b2eb4c, bba08f0e, e3fd05da, b6e1f90f, 944dbd17) with no git log output provided to prove they exist.
- Mild overclaim in epistemic confidence: the recommendation uses 'CONFIRMED:' four times for facts (commit dates, schema presence, Flow's status, scope limits) but the confirmation is asserted without shown verification. File and commit existence should be confirmed via bash output or file reads before labeling them 'CONFIRMED'.

Missed angles flagged:
- No connection drawn to related recent work in project history: the brief's context would benefit from explaining how this pivot relates to concurrent projects like 'Intent capture + enforcement' or 'Architecture hardening' mentioned in the session memory.
- The compose does not clarify the current ship status of the pivot (is it shipped to main, on a branch, or in-development?). The narrative mixes live boundaries with deferred features but doesn't state whether end-users see this pivot or whether it's internal-only.
- No discussion of why this pivot was needed or what problem it solves — the answer focuses on 'what changed' but not on 'why' or 'what was broken before'.

#### `fefa9957` — accept-with-fold-ins

Compose subject: The essence of the goal commands in Claude Code and Codex Circuit plugins, and how they bind to Circuit.

Overall assessment: The recommendation directly answers the brief's Explore goal with a coherent two-layer model (host adapters + CLI binding) backed by specific evidence (README.md, plugins/claude/commands/run.md, plugins/codex/commands/run.md). The compose properly separates confirmed facts from assumptions, names the evidence inspected and still needed, and lists four concrete proofs that would increase confidence (per-flow command files, router source+tests, CLI entrypoint, real run folder). The success_condition_alignment is substantive and specific, walking through all four brief requirements rather than restating them generically. Epistemic calibration is appropriate: the recommendation declares findings in clear language while the supporting_aspects acknowledges what wasn't inspected (router internals, per-flow command file bodies, CLI entrypoint behavior). This satisfies the brief's demand for evidence-backed findings with explicit uncertainty preservation.

Objections:
- Flow-command inconsistency: The recommendation lists six explicit flows (`/circuit:run`, `/circuit:explore`, `/circuit:review`, `/circuit:fix`, `/circuit:build`, `/circuit:prototype`) but later parenthetically mentions 'Pursue' as a seventh option in the flow-choice set: '(Fix / Review / Build / Prototype / Explore / Pursue)'. Either Pursue is a real flow missing from the initial list, or it is an assumption/error. This should be clarified by the already-identified evidence (per-flow command file inspection and router source) and noted as needing verification before the recommendation is treated as load-bearing for implementation decisions.

### Sonnet (claude-sonnet-4-6) — 5 apparent false positives

#### `045be6d0` — accept-with-fold-ins

Compose subject: Does Circuit hold the promise of delivering a superior "/goal" implementation/experience? why / why not?

Overall assessment: The compose is substantively sound: the 'yes with caveats' framing is well-calibrated, the rubric scores are differentiated and defensible, the confirmed/assumed/unsupported separation is clean, and the proof-still-needed list is specific and honest. Line-number spot-checks on README.md and docs/positioning-and-strategy.md confirm the cited content matches the claims. Two fold-in corrections and one missed angle before treating this as final.

Objections:
- Minor arithmetic error: the compose describes a 'six-layer chain' then enumerates seven items — 'default → user-global → project → flow → stage → step → invocation'. The positioning doc says six layers; the compose list says seven. One of the two is wrong; reconcile before publishing.
- The 'superior' claim lacks a stated baseline. The compose interprets '/goal' as a single natural-language entry that orchestrates work, but never describes what base '/goal' actually does today (one-shot prompt dispatch, no flow selection, no evidence-gated steps, no multi-agent split). Without that comparator spelled out, the superiority argument is a feature list, not a contrast — a skeptical reader can ask 'superior to what, exactly?' Stating the baseline in one sentence would close this.

Missed angles flagged:
- Setup cost as a UX dimension of 'superior experience' is not addressed. '/goal' is zero-setup; Circuit requires plugin installation, a compatible host, and a working Node.js version. For first-time or occasional users that delta is real and could make Circuit 'architecturally superior but practically worse' in the first five minutes. The compose flags onboarding risk but does not name installation cost as a component of it.

#### `0dc32a58` — reject

Compose subject: Explore how Circuit can use queryable run reports to make future work on Circuit itself more effective, focused on model-facing memory rather than humans reading proof reports, using the current Circuit project as the concrete example.

Overall assessment: The compose is coherent and well-structured, but its central 'confirmed gap' claim — the proof it names as decisive — is factually wrong. The compose asserts 'MemoryInputV0 is referenced only by its contract test and the schema barrel ... and is consumed nowhere in the runtime, executors, or connectors.' A grep of the repo shows this is false: src/app/history/memory-preview.ts (115+ lines) already calls MemoryInputV0.parse() to produce prior_run kind objects with authority:'hint_only' and staleness tagging; src/app/history/memory-identity.ts and memory-merge.ts also use MemoryInputV0; and src/memory/project-distill.ts does too. The prior_run path is not greenfield — it is already wired through a live history recall subsystem that converts query hits into hint-only memory inputs. Because the recommendation ('build a prior-run indexer over .circuit run folders') is founded entirely on the false premise that the read-in path does not exist, the recommendation itself needs rethinking. The actual gap — if there is one — is something different: whether existing history indexing covers run-report JSON (brief, analysis, review reports), how the index is built and queried, and where the real missing wiring lives. The compose missed an entire subsystem (src/app/history/). The self-improving-circuit.md line references are accurate.

Objections:
- BLOCKING — evidence groundedness failure on the decisive proof: the compose claims 'MemoryInputV0 is consumed nowhere in the runtime, executors, or connectors' and treats this as 'the trustworthy proof for the recommendation,' but src/app/history/memory-preview.ts already calls MemoryInputV0.parse() with kind:'prior_run', authority:'hint_only', and staleness from query hits (line 81-96), and src/app/history/memory-identity.ts, memory-merge.ts, and src/memory/project-distill.ts are further consumers. The prior_run read-in path is not greenfield. This invalidates the stated recommendation without further investigation of what the existing history subsystem actually does and what it does not yet index.

Missed angles flagged:
- The src/app/history/ subsystem (memory-preview.ts, memory-merge.ts, memory-identity.ts) and src/memory/project-distill.ts are the actual wiring layer for prior_run memory — the rework should characterize what these already index, how the query mechanism works, and whether run-report JSON (brief.json, analysis.json, review files) is among the indexed sources, before recommending new build work.
- The distinction between what the history index covers (likely run traces / docs already in .circuit/) and whether structured report JSON per stage is indexed and queryable is the real factual question the reworked compose needs to answer.

#### `5ad506e5` — accept-with-fold-ins

Compose subject: Relationship between Karl Friston's Free Energy Principle notion of "self-evidencing" and what the Circuit repo/product is trying to do, grounded in current Circuit vocabulary, including the analogy's limits.

Overall assessment: The compose is conceptually sound and well-calibrated. The five-point limit taxonomy (evidence equivocation, exogenous vs. endogenous criterion, ephemeral runs vs. homeostasis, retry vs. variational inference, work-evidencing vs. self-evidencing) is the right frame, the null FEP grep is confirmed, and the 'rhymes with rather than implements' epistemic posture is correct. However, three of the cited line numbers in UBIQUITOUS_LANGUAGE.md and one in public-claims.yaml are factually inaccurate: the text at the cited lines does not match what the compose claims, which undermines the evidence-groundedness claim in success_condition_alignment.

Objections:
- Citation inaccuracies in line-number refs: UBIQUITOUS_LANGUAGE.md:146 cites 'Acceptance retry feedback' but that entry is actually at line 174; UBIQUITOUS_LANGUAGE.md:166-169 cites 'Continuity record' but that is at line 194; docs/release/claims/public-claims.yaml:101 cites a 'surprised' match but the actual match is at line 87. The paths are real and the concepts exist, but the cited line numbers resolve to different content — a reader following them will not find what is claimed. These should be corrected before the compose is used as a reference document.

Missed angles flagged:
- The compose treats the operator/author side of Circuit purely as an 'exogenous criterion' (limit #2), but in the FEP framing the generative model itself is authored and updated — the operator who writes the Flow/Schematic is acting as the model designer, encoding priors about expected work structure. This makes the analogy richer than the compose acknowledges: operator = generative model author, Schematic = prior over work structure, run = inference attempt, Acceptance criteria = precision weighting on specific predictions. Acknowledging this would sharpen rather than soften limit #2 (it is not simply that the criteria are external; it is that they are a static, non-updating prior rather than a learned, self-revising one), which is the stronger and more precise objection.

#### `5e3a8ea5` — reject

Compose subject: Sketch what a Circuit-powered superior /goal experience would look like and how it could work, based on the current Circuit block/flow model and the host /goal concepts in Codex and Claude Code.

Overall assessment: The compose correctly identifies the binding-not-new-flow framing and cites real blocks from docs/flows/blocks.md and docs/flows/pursue.md. However, it contains two blocking evidence-groundedness failures and one significant missed angle that together make it unfit to accept. The recommendation cites a non-canonical file path and presents an unimplemented feature as a working primitive, and it completely bypasses the one spec file in the repo that was written specifically for this question.

Objections:
- BLOCKING — fabricated evidence path: docs/specs/explore-intent-v1.md does not exist at that path in the main repo. The file lives only in .claude/worktrees/visual-explainer/docs/specs/explore-intent-v1.md, an isolated worktree. Citing line numbers from it (§Cross-cutting #2 and #3) as supporting evidence for the checkpoint protocol and --from-run flag is invalid — a reviewer or implementer following those refs will find nothing.
- BLOCKING — unimplemented feature in the recommendation: --from-run <run-folder> does not exist in the codebase (grep across src/ and docs/ returns zero hits). It is described only in the worktree-only draft spec above. The compose places it in the recommendation section as an available cross-flow flag ('Follow-up /goal invocations compose on prior runs via the --from-run <run-folder> cross-flow flag'), which is false. A directional sketch may reference proposed features, but must mark them as not-yet-built, not cite a non-canonical draft spec as proof they exist.
- BLOCKING — missed the directly relevant spec: docs/specs/goal-block-v1.md exists at the canonical path and is the only spec in the repo written specifically about how Circuit should relate to host /goal. It contains source-backed findings about both Codex Goals and Claude Code /goal as of 2026-05-20, draws explicit boundaries between what the host surface controls vs. what Circuit must own, and proposes the Goal block + Goal flow as the correct integration shape. The compose cites none of this. A sketch of Circuit-powered /goal that doesn't engage goal-block-v1.md cannot claim to be evidence-backed.

Missed angles flagged:
- The serial-only code-write constraint in Pursue is noted as a risk but the /goal user-facing implication is not addressed: a user invoking /goal on a broad multi-track implementation task would silently encounter sequential execution with no explanation of why their goal is being serialized.
- The ambient continuity angle (a user re-invoking /goal mid-run to check status, not start a new goal) is absent — the Handoff block's value is highest exactly there, but the sketch only covers the chained-run case.

#### `fefa9957` — reject

Compose subject: The essence of the goal commands in Claude Code and Codex Circuit plugins, and how they bind to Circuit.

Overall assessment: The compose constructs a plausible-sounding answer but contains a fabricated path and a direct factual inversion that contradict the primary evidence source (plugins/claude/commands/run.md). The fabricated reference and the wrong routing model are blocking because they form the load-bearing claim about Circuit's relationship to goal commands.

Objections:
- FABRICATED REFERENCE — BLOCKING: `src/flows/router.ts` does not exist in the repo (confirmed: `src/flows/` directory listing shows no router.ts; `find src -name 'router*'` returns nothing). The compose cites it as the authority for Circuit's 'deterministic classifier' and recommends the reader inspect it. The actual routing entry point named in plugins/claude/commands/run.md:127 is `src/cli/circuit.ts resolveCompiledFlowRoute`.
- FACTUAL INVERSION — BLOCKING: The compose states flow choice is 'either the host model … or Circuit's deterministic router' implying a fallback exists when the host declines. plugins/claude/commands/run.md:19 states explicitly: 'Routing is model-only, so a flow name is always required.' There is no deterministic router fallback; a flow name must always be supplied by the host model. The compose's central framing of the routing architecture is directly contradicted by the inspected evidence.
- FABRICATED TEST PATH: The compose recommends inspecting `tests/contracts/flow-router.test.ts` to verify the router. That path does not exist; the actual test is `tests/runner/cli-router.test.ts` (confirmed by run.md:128 and directory listing).

Missed angles flagged:
- The `run.md:19` constraint that 'a flow name is always required' changes the answer materially — the goal commands are not just thin adapters that can fall back to a built-in classifier; the host model carries the full routing burden and must always emit an explicit flow name before the CLI is invoked. This is the key behavioral difference from what the compose describes.

