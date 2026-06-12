# Baseline eval runs — 2026-06-11

First live eval execution on the post-rearchitecture codebase, and the
first-ever live execution of the claim-grade fix-vs-vanilla held-out set.
Five runs total: fix-vs-vanilla held-out at two model tiers, and
verdict-correctness with the reviewer judge at three model tiers.

## Provenance

- Repo: main at `f361e5f5` (PR #57 merged). A concurrent session landed
  `ea13ff87` (wip power tiers) mid-baseline; both fix rows ran against the
  same `dist/` built from the pre-wip tree (`--skip-build`), so the engine
  under test is identical across rows despite the differing recorded commit.
- Harness: `evals/fix-vs-vanilla/run-fix-comparison.ts` (circuit-mode
  `default`), `evals/verdict-correctness/index.ts` (judge `claude-code`).
- Judge model selection is not exposed by the verdict runner; per-tier runs
  used a PATH shim injecting `--model` into the spawned `claude`, mirroring
  the fix harness's own wrapper pattern. Result dirs are stamped with
  `model.txt` and a model suffix.
- Raw results (gitignored, local only):
  - `evals/fix-vs-vanilla/results/2026-06-11T05-00-35-157Z-held-out` (Haiku)
  - `evals/fix-vs-vanilla/results/2026-06-11T05-22-21-778Z-held-out` (Sonnet)
  - `evals/verdict-correctness/results/2026-06-11T05-00-5*-claude-code-{haiku,sonnet,opus}`

## fix-vs-vanilla, held-out set (5 tasks, both arms per task)

| Row | False-fixed C/V | Fixed C/V | Proof C/V | Circuit wallclock | Vanilla wallclock | Claim |
| --- | --- | --- | --- | ---: | ---: | --- |
| Haiku 4.5, medium | 0% / 0% | 100% / 100% | 3.0 / 3.0 | 185s/task | 62s/task | Not supported (tie) |
| Sonnet 4.6, medium | 0% / 0% | 100% / 100% | 3.0 / 3.0 | 150s/task | 63s/task | Not supported (tie) |

Zero environment failures in either row. Every Circuit run completed the
full proof chain (baseline snapshot, act, verify, change-set, regression
re-run, independent review, close) on current main.

**Headline finding: the held-out set is saturated.** Both arms fix all five
tasks cleanly at both tiers, so the primary metric (false-fixed rate) is a
0%-vs-0% tie, and the claim rule's strict inequality can never pass. The
instrument cannot discriminate at this task difficulty. The claim outcome
"not supported" means "no measurable difference on tasks this easy," not
"Circuit lost." What Circuit's proof chain measurably costs here is
wallclock: 2.4-3.0x vanilla.

To make this eval informative, the held-out set needs tasks hard enough
that the vanilla arm sometimes false-fixes (multi-file bugs, misleading
symptoms, tests that pass while the real defect remains). Per the README's
own rule, tuned-on tasks move to regression and fresh held-out tasks
replace them.

## verdict-correctness, reviewer judge by model tier (54 cases each: 9 composes x 5 defects + 9 controls)

| Judge | Catch rate | Misses | Protocol errors | Control rejects | Median/call |
| --- | ---: | ---: | ---: | ---: | ---: |
| Haiku 4.5 | 97.6% (41/42) | 1 | 3 (5.6%) | 0 | 38.9s |
| Sonnet 4.6 | 100% (42/42) | 0 | 3 (5.6%) | 0 | 50.2s |
| Opus 4.8 | 100% (45/45) | 0 | 0 | 0 | 47.3s |

Errored cases drop out of the catch-rate denominator, which is why the
denominators differ.

**Detection quality is near-ceiling at every tier; what separates tiers is
protocol discipline.**

- Haiku's 3 errors are out-of-vocabulary verdicts: it detected an egregious
  defect and answered outside the accepted verdict list (tried to reject
  where the schema allows only accept-family verdicts plus objections).
  Detection succeeded; protocol failed.
- Sonnet's 3 errors: one invented extra key (`missed_angles_note`), two
  prose-before-JSON parse failures. Same class: protocol, not judgment.
- Opus: clean on both axes.
- All three judges accepted all 9 unmodified controls (no false-positive
  rejects).

Implication for Depth x Power: in production these protocol failures are
exactly what the runtime's schema gate catches and routes to recovery, so a
cheap judge's failure mode costs a retry rather than a wrong verdict. On
this suite, defect detection itself barely degrades with tier. That is
direct evidence for the tier-table bet that lower power is viable where
Circuit's structural guardrails absorb the failure mode, with the caveats
that n is small (9 source composes), the defect suite is the standard one
(May's "subtle" suite was harder: 88.9% at the then-default judge), and
single-shot review prompts are the easiest relay class.

## Harness defects found while running

1. **Stale flag after the depth rename.** `circuitModeArgs()` in
   `run-fix-comparison.ts` still emits `--rigor lite|deep`; the CLI now
   takes `--depth low|medium|high` (PR #56). Default mode passes no flag,
   which is why this baseline worked. Lite/deep rows are broken until the
   runner is patched.
2. **Judge model is not selectable.** The verdict runner exposes `--judge
   <connector>` but no `--model`; the connector only passes `--model` when
   a resolved selection exists, which the eval never provides. The PATH
   shim works but belongs in the harness (the providers.ts wrapper already
   exists for exactly this).
3. **Result dirs do not record the model.** Three concurrent claude-code
   judge runs produce dirs distinguishable only by timestamp. Stamped
   manually this time (`model.txt` + dir suffix); the runner should record
   the resolved model in `summary.json`.
4. **No committed verdict trail.** All results are gitignored; without a
   scrubbed summary committed per run, catch-rate movement across the
   rearchitecture is unmeasurable. Same recommendation as the eval-state
   review: commit scrubbed `summary.json` + `report.md`.

## Suggested follow-ups (in value order)

1. Harden the held-out set: add 3-5 tasks where a strong vanilla prompt
   plausibly false-fixes; that is the only way the claim-grade eval can
   ever discriminate.
2. Patch the three harness defects above (small, mechanical).
3. Re-run the subtle defect suite per tier to get a non-saturated judge
   comparison before locking power-tier defaults for the reviewer role.
4. Wire release cadence: `check-release-ready` asserts release-or-milestone
   evals have results newer than the last release tag, or a recorded waiver.
