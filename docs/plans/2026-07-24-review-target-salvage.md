# Review target salvage plan — 2026-07-24

Working document for executing the salvage of the uncommitted Review-target
rebuild. Written by the audit session on 2026-07-24; execute in a fresh
session. Keep this file untracked until execution finishes, then fold the
outcome into a short audit note and delete it (several paths named below are
deleted by the plan itself, so committing this file would trip doc-path
gates).

## Situation (verify before starting)

A ~10-hour Codex session rebuilt Review target selection and was aborted
mid-fix on 2026-07-24 at 8:06am. All of its work is **uncommitted on
`main` @ `1cbc8221`**. Expected starting state:

- `git log -1` → `1cbc8221`; `git status --porcelain | wc -l` → ~105
  modified/untracked files (Review flow, connectors, codex-mcp host,
  tests, regenerated `plugins/` bundles, refreshed release proofs).
- `npm run check` passes. `npm run lint` fails on exactly two files left
  unformatted at the abort: `src/flows/registries/start-preflight.ts`,
  `src/hosts/codex-mcp/production-runtime.ts`.
- `npm run test:fast` → 12 failures across 9 files (baseline list in
  Stage 6).
- Do **not** resume Codex thread `019f6336-…` against this tree.

What the audit concluded (full detail in Claude memory
`project_codex_review_marathon_audit.md`):

- Sound kernel worth keeping (~1k lines of value): the `ReviewTarget`
  model, symbolic-ref → pinned-OID resolution, exclusive target evidence
  (commit reviews no longer leak dirty-tree diffs), fail-closed
  unavailable targets, and the prompt-only sealed reviewer on both
  connectors. Engine boundary respected via the
  `relay_uses_prompt_only_context` engine flag.
- Regressions to undo: the goal parser refuses common phrasings (bare
  "review", "review my recent changes", "code review please", "review
  this PR"); any untracked file under the default metadata-only policy
  forces a non-CLEAN verdict; PR targeting can never succeed (requires
  `refs/circuit/...` refs nothing creates); cursor-agent/custom
  connectors are refused for Review; the new parser gate masks the
  shipped state-dir diagnosis; ~80 git spawns + a double-read
  "working tree changed, retry" flake surface per review.
- Test mass: ~10.4k new/changed test lines, ~600 cases; ~3–3.5k lines
  are duplication (cut list in Stage 6).

## Decisions (defaults pre-encoded; edit this section to override)

Execute the defaults unless Pete has edited them. Each default reverses a
choice the Codex session made unilaterally.

- **D1 — fuzzy goals: DEFAULT = warn-and-default.** Unmatched review
  phrasings resolve to the working tree (`mode: all`) with a prominent
  named-assumption warning in intake, operator summary, and result
  ("Assumed target: current working tree — name a commit, range, staged,
  or unstaged target to override"). Explicit-but-malformed forms (bad
  ref, bad range) still fail closed. The alternative (keep strict
  refusal) is what broke "code review please".
- **D2 — untracked files: DEFAULT = warning, not verdict.** Metadata-only
  untracked evidence produces a warning + confidence limitation, as
  before the marathon; it no longer forces `ISSUES_FOUND`/stopped.
  `--include-untracked-content` stays as the opt-in for full content.
- **D3 — connectors: DEFAULT = keep the seal for claude-code/codex; other
  connectors run Review unsealed with a loud warning** ("reviewer had
  repository access") instead of being refused.
- **D4 — path subsets/exclusions ("review only docs/"): DEFAULT = keep
  the stop**, but rewrite the refusal message to say what to run instead.
  (Fail-closed here is a defensible honesty stance; the current message
  is just unhelpful.)
- **D5 — PR targeting: DEFAULT = remove until a real fetch story
  exists.** "Review PR #N" gets a clear "not supported yet — check out
  the PR branch locally, then review the working tree or
  `base...head`" message.

## Sequence

Run stages in order; each ends at a checkable gate. Stages 2–5 are
mostly independent in content but sequenced deletions-first so later
repairs touch less code.

### Stage 0 — Branch and baseline (~15 min)

1. `git worktree list` first (hygiene), stay in the main checkout.
2. Create branch `pkp/review-target-salvage` from the current state so
   `main` stops carrying uncommitted work:
   `git checkout -b pkp/review-target-salvage`.
3. Format the two mid-edit files:
   `npx biome check --write src/flows/registries/start-preflight.ts src/hosts/codex-mcp/production-runtime.ts`.
4. Kill leftover marathon processes before any test runs (they flake the
   live suites): look for `circuit-mcp-supervisor-*` worker/supervisor
   pairs and a `circuit-installed-doctor-*` node process in `$TMPDIR`
   (`ps aux | grep -E "circuit-mcp-supervisor|circuit-installed-doctor"`).
   Safe to kill if no Codex app session is actively mid-run.
5. Commit everything as-is: `wip: codex review-target marathon (frozen at
   2026-07-24 abort)` — one revertable baseline commit containing the
   untouched marathon state.
6. Gate: `npm run check && npm run lint` green; `npm run test:fast`
   reproduces (approximately) the 12-failure baseline in Stage 6.

### Stage 1 — Deletions (~1–2h)

All in `src/flows/review/writers/intake.ts` unless noted.

1. **PR machinery (D5):** delete `src/shared/github-repository.ts`
   (185 lines), `assertPullRequestRepository` (~intake.ts:2199–2259) and
   the PR parse/resolution paths, the PR merge-ref logic in
   `src/hosts/codex-mcp/safe-git-reader.ts` (~120 lines), and the PR
   paragraphs in `src/commands/run.md` +
   `src/hosts/codex-mcp/run-skill.md`. Keep cheap PR-phrase *detection*
   so the not-supported message is specific. Delete
   `tests/unit/github-repository.test.ts` and PR wiring/parser cases;
   keep exactly one test asserting the friendly refusal message.
2. **Legacy spike fields:** delete the optional `committed_diff` /
   `target_*` fields on working-tree evidence and their read paths in
   `src/flows/review/reports.ts` and
   `src/flows/review/writers/intake-projection.ts` (~150 lines). Nothing
   writes them (grep-verified during audit).
3. **Double-read + per-command config re-audit:** keep OID pinning and
   ONE up-front hardened-config audit per collection; delete the second
   full working-tree read, the byte-comparator, and the per-command
   config re-audit (~500 lines, ~40 git spawns per review). This removes
   the "working tree changed while Review evidence was being collected"
   retry-flake class.
4. **Orphaned reader op:** delete the `submodules` operation from
   `src/shared/runtime-git-reader.ts` (it has no production dispatcher)
   unless Stage 4's gitlink work ends up needing it.
5. Gate: `npm run check && npm run lint`; focused suites
   `npx vitest run tests/runner/review-runtime-wiring.test.ts
   tests/mcp/safe-git-reader.test.ts` — expect failures only in areas
   Stages 2–3 will touch; record them.

### Stage 2 — Parser replacement (D1, D4, D5) (~2–3h)

The core repair. Current parser: `parseReviewTarget` at
~intake.ts:1612, plus its ~1,320-line support region (~lines 585–1900):
alias rewriting, determiner word-lists, negated-clause masking. Replace
with an explicit-form matcher (~120–150 lines):

- Recognized forms: staged/unstaged keywords; `commit <ref>`;
  `<a>..<b>` / `<a>...<b>`; `HEAD`, `HEAD~N`, `HEAD^` and a SHORT
  "latest/last commit" alias list; inline supplied material (the `goal`
  target kind) via the existing supplied-material classifier; PR
  phrases → D5 message; path subset/exclusion → D4 stop message.
- Anything else → working-tree default + named-assumption warning (D1).
  The warning must be machine-readable in `review-intake.json`, and
  surfaced by `intake-projection.ts`, `result-projection.ts`,
  `result-html.tsx`, and `operator-summary/projections.ts`.
- Malformed *explicit* forms still fail closed — at availability
  validation (`validateReviewTargetAvailability`, kept as-is), not at
  phrasing.
- **Gate-order fix:** in `src/cli/run.ts` /
  `src/flows/registries/start-preflight.ts` /
  `src/hosts/codex-mcp/production-runtime.ts`, the connector state-dir
  diagnosis must run BEFORE target preflight (the failing
  `tests/runner/run-preflight-refusal.test.ts` case is the regression
  test — make it pass, don't rewrite it).
- **Post-relay throw fix:** `result-projection.ts` currently re-parses
  the goal and can throw after the paid relay ran. Change it to consume
  the persisted intake target from `review-intake.json` instead of
  re-parsing (kills the whole failure class).
- Keep `start-preflight.ts` as the dispatch shim, but note in a comment
  it should become catalog-derived if a second flow ever adopts targets.
- Rewrite `tests/unit/review-target-parser.test.ts` to the new grammar:
  ~60–80 cases, 1–2 phrasings per behavior. Keep the genuinely tricky
  ones: "this changes" verb trap, curly-apostrophe negation, `#123oops`,
  PR dedup (now → message), malformed-boundary fence. The probe set from
  the audit is the acceptance list: bare `review`, `review my recent
  changes`, `code review please`, `take a look at my diff`, `review the
  new API endpoints` must all resolve to working-tree-with-warning;
  `review the latest commit` → commit HEAD; `review src/cli/run.ts` →
  D4 stop; `review this PR` → D5 message.
- Gate: parser suite green; wiring suite target-selection blocks green.

### Stage 3 — Verdict and evidence policy (D2) (~1h)

1. In `src/flows/review/writers/result-projection.ts`, restore
   metadata-only untracked files to warning + confidence limitation;
   remove the forced medium finding `circuit-review-evidence-incomplete`
   → `ISSUES_FOUND` → stopped path for that case. Truly unavailable or
   truncated *explicit targets* keep their fail-closed handling.
2. Fold the four copies of evidence-usability logic
   (`result-projection.ts`, `result-html.tsx`,
   `operator-summary/projections.ts`, `reports.ts` superRefine) into the
   new `src/flows/review/writers/evidence-completeness.ts` as the single
   owner (~-350 lines).
3. Relax `runtimeGitTextIsValidUtf8` in
   `src/shared/runtime-git-reader.ts` to reject only on real decode
   failure, not on content that merely contains U+FFFD.
4. Revert the golden-proof hack in
   `scripts/release/capture-golden-run-proofs.ts` (drop
   `--include-untracked-content` from the review scenario argv and
   restore the stub's confidence_limitations) so the proof exercises the
   default path again. Proof regen happens in Stage 6.
5. Gate: `npx vitest run tests/unit/review-projections.test.ts
   tests/unit/shared/operator-summary/projections.test.ts
   tests/unit/shared/html/review-result.test.ts` green after updating
   the policy-encoding cases.

### Stage 4 — Connector and host-path policy (D3) (~1h)

1. `src/runtime/executors/relay.ts` (~lines 29–31, 51–53): replace the
   cursor-agent/custom refusal with unsealed-reviewer warning wiring per
   D3. Keep prompt-only sealing for claude-code and codex.
2. `src/connectors/claude-code.ts` equipment-scope tightening (per-block
   tool_use policing for ALL equipped relays): keep — it's genuine
   hardening — but confirm the cross-tool-build flow and ordinary
   equipped relays still pass (`tests/runner/parse-claude-code-stdout.test.ts`,
   connector suites).
3. `safe-git-reader.ts` submodule/gitlink behavior: diagnose the failing
   live test (`does not let diff.ignoreSubmodules hide selected gitlink
   diffs or stats`, 93s) — decide restore-roster vs fix-op, coordinated
   with the Stage 1 `submodules`-op decision.
4. Gate: `npx vitest run tests/mcp/safe-git-reader.test.ts
   tests/mcp/safe-git-reader-live.test.ts tests/runner/connector-cwd-forwarding.test.ts` green.

### Stage 5 — Green the suite, trim the test mass (~2–4h)

Baseline failures from the audit run (some will already be fixed by
Stages 1–4; diagnose any survivor before touching its test):

1. `review-runtime-wiring.test.ts` ×3 — ISSUES_FOUND verdict must close
   `stopped`, not `aborted` (mid-abort preflight ordering); workspace-root
   unavailable; untracked-metadata stop (Stage 3 changes this case's
   expectation to warning).
2. `run-preflight-refusal.test.ts` — fixed by Stage 2 gate-order work.
3. `cli-process-derivation.test.ts` Review clamp silence.
4. `package-lifecycle-acceptance.test.ts` older-commit relay;
   `package.test.ts` extracted-archive start.
5. Doctor contracts: `claude-host-plugin.test.ts`,
   `codex-host-plugin.test.ts`, `installed-plugin-doctor.test.ts` ×2.
   If the new ~135-line review smoke in `plugins/claude/scripts/circuit.ts`
   / `plugins/codex/scripts/circuit.ts` (hand-authored wrappers, not
   generated) is the cause and doesn't earn its keep, trim it back.
6. `safe-git-reader-live.test.ts` gitlink — Stage 4.

Then the trim (cut list verified by the test audit; ~3–3.5k lines):

- Wiring file: delete one side of each direct-vs-injected duplicate pair
  (~lines 3914/4012, 5055/5099, 4862/4925, 1481/1547) and the
  hostile-git blocks already unit-proven in `safe-git-reader.test.ts`
  (fsmonitor/filters/includes/grafts/alternates/symlink-gitdir; keep one
  representative). Split the 5.8k-line single describe into ~4 files:
  compose-writer basics / target selection / evidence honesty /
  hostile-git.
- `tests/unit/shared/html/review-result.test.ts`: drop duplicated
  staged/unstaged/all loops and truncation re-checks; keep one render
  smoke per state.
- `tests/mcp/run-skill.test.ts` / `server.test.ts`: reduce exact-prose
  pins to 3–4 anchor sentences.
- Try reverting the widened timeouts in `local-worker-lane.test.ts` /
  `supervisor.test.ts` (8s→30s waitFor) once the suite slims; keep if
  still needed.
- Must-stay list (do not cut): dirty-tree exclusion (wiring ~1993 +
  package-lifecycle older-commit case), fail-closed unavailable targets
  (wiring ~2629/4179/4209 + projection backstops), merge-commit
  first-parent + blob rejection (~4311/4399), truncation honesty
  (~3315/3391/3819), CLI boundary (`cli-router.test.ts` invalid target →
  exit 2 before run creation), MCP boundary (`production-runtime`
  rejects before loading assets), and the `ISSUES_FOUND → stopped` /
  `CLEAN → complete` pair (~4794/4837).

Gate: `npm run test:fast` fully green, then `npm run verify:fast`.

### Stage 6 — Regenerate, prove, full verify (~1h + suite time)

1. Regenerate all bundles/mirrors once, from the settled tree:
   `npm run emit-flows`. (Never regen mid-stage on a churning tree.)
2. Re-capture the review golden proof
   (`scripts/release/capture-golden-run-proofs.ts` path) so
   `docs/release/proofs/runs/review/**` reflects final semantics — this
   also restores the `operator-summary.html` the marathon deleted.
3. Update `docs/operator-guide.md`'s Review row to match final behavior
   (the marathon's wording documents strict refusal; under D1 it's
   wrong). Same pass over `src/commands/run.md` and
   `src/hosts/codex-mcp/run-skill.md` target guidance.
4. `npm run verify` (FULL — bundled surfaces changed; `verify:fast`
   does not run the release-infra/plugin-runtime gates).
5. Smoke by hand, no paid relay: `bin/circuit preview review`; the
   parser acceptance list from Stage 2 via the parser suite.

### Stage 7 — Land

- Commit per stage on `pkp/review-target-salvage` (each stage message
  names its decision IDs), PR against `main` titled "Review targets:
  salvage and slim the target-selection rebuild". PR body: link the
  decisions section of this plan verbatim, note the D1–D5 calls.
- After merge: delete this file, add a dated close-out note under
  `docs/audits/` if wanted, and update the Claude memory
  (`project_codex_review_marathon_audit.md` → SALVAGED status).

## Gotchas (earned elsewhere, apply here)

- `verify:fast` ≠ full `verify`: only full verify runs the
  release-infra and plugin-runtime drift gates; this branch changes
  bundled surfaces, so the final gate must be full `verify`.
- `emit-flows-drift` flake signature: a ~3s failure is a spawn hiccup —
  rerun before digging.
- Generated run SKILL surfaces have a wrap-sensitive contract test;
  biome cares about quote style around apostrophes in embedded strings.
  Edit `src/commands/run.md` / `run-skill.md` prose carefully and re-run
  the contract tests.
- The relay path has a 180s bound that can make silent suites look hung;
  don't kill slow MCP suites early (`codex-host-plugin` alone runs
  ~7 min).
- Vitest v4 swallows `console.log` from tests; write probe output to a
  file if you need it.
- Review loops run away: cap any adversarial re-review of this salvage
  at 2 rounds, block only on critical/high, and never adopt a
  "N consecutive clean reviews" finish line.

## Definition of done

1. Full `npm run verify` green on `pkp/review-target-salvage`.
2. Parser acceptance list behaves per D1–D5 (Stage 2 list).
3. A review of a dirty tree with untracked files can close CLEAN again
   under the default policy (D2).
4. Commit reviews relay only the pinned commit diff (exclusivity kept).
5. Net hand-written line count vs. pre-marathon `main` is in the
   ~1.5–2.5k range (production + tests), not ~15k.
