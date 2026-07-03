# V1 surface-test plan

Status: plan for Pete's approval. Written 2026-07-02 against main (8664c748)
and the published tag `circuit--v0.1.0-alpha.9` (e8e3c28f). Grounded in a
full-repo inventory sweep (8 readers over the CLI surface, flow catalog, both
host packages, existing coverage, proof machinery, runtime behaviors, and
public claims, plus a completeness critique) and two direct probes run while
writing this plan. Nothing spend-bearing has been executed yet.

Companion: [v1-launch-plan.md](v1-launch-plan.md) carries the launch
blockers. This plan absorbs blocker 4 (the Pursue proof) as item F2.

---

## 1. The scoping ruling: CLI once, hosts only where they own behavior

The question was whether testing the CLI is sufficient, or whether each host
plugin needs its own full test. The answer is a partition, and the partition
criterion is proven, not assumed:

**One engine, three entry points.** The host slash command on each host is a
generated prompt that instructs the host agent to shell out to that plugin's
bundled runtime (`node "${CLAUDE_PLUGIN_ROOT}/scripts/circuit.ts" present run
<flow> --goal '...'` on Claude Code; the twin under `plugins/codex/runtime/`
on Codex). Same engine code, byte-drift-gated from the same source. So:

1. **Engine semantics are tested once, via the CLI.** Flow execution, checks,
   the dial, checkpoints, resume, run records, history. Testing them again
   per host would prove nothing new.
2. **But the artifact under test must be the published one.** The plugin
   invokes its own bundled runtime, not the dev checkout's `bin/circuit`.
   A stale bundle at the tag is a known near-miss class. So the engine
   sweep runs against the tag and the installed caches, not just the
   working tree.
3. **Per-host testing shrinks to what each host actually owns:** marketplace
   install and command registration, plugin-root resolution, the host
   model's flow recommendation and shell-quoting behavior, hooks firing on
   real session events, tool-wall enforcement (Claude connector), the
   in-session checkpoint conversation, and the Codex sandbox. These cannot
   be reached from the CLI at all. This list is short and enumerable; it is
   Layer 5.
4. **Source-to-generated drift needs no manual testing.** `check-flow-drift`
   and `check-plugin-runtime` are CI-enforced and meta-tested. We run them
   at the tag (Layer 1), never re-diff by hand.

So: CLI-only is not sufficient, but the per-host share is a bounded seam
list, not a second full test pass. That is where all the redundancy savings
live.

## 2. What we deliberately do NOT retest

The suite is 387 test files run by CI on every push to main, on two OSes.
Re-running proven layers would be the main source of wasted effort, so the
exclusions are first-class:

| Already proven | By | Rule for this sweep |
|---|---|---|
| Full `npm run verify` | CI at the release SHA | Check CI is green (`gh run list`); do not rerun locally unless testing an uncommitted candidate |
| Checkpoint/resume engine semantics | 33 tests in `tests/runtime/checkpoint-resume.test.ts` plus router cases | Live-test only the host rendering and one park-and-resume roundtrip |
| Torn-trace healing, atomic writes | `tests/unit/runtime/` | Nothing live; pure filesystem behavior |
| Schema, catalog, composition contracts | `tests/contracts/` (~115 files) | Nothing; grep tests before "fixing" anything they lock |
| Generated mirrors and bundles (drift) | `check-flow-drift`, `check-plugin-runtime`, meta-tested | Run once at the tag, never hand-diff |
| Wrapper mechanics (version gate, PATH fallback refusal, flow-root injection) | `tests/contracts/*-host-plugin.test.ts` spawn the real wrappers | Nothing beyond the installed-cache doctor |
| Power-dial allocation table | `tests/unit/power-tiers.test.ts`, preview tests, live-verified this week | Only the codex-effort-on-a-real-worker slice is untested |
| Recovery corridor, until-loop machinery | dense unit + e2e suites | One live Converge run covers the surface; the rest is proven |

The critic also flagged where one physical action discharges several line
items. The plan books those once: one fresh install per host covers four
inventory items; one `circuit preview` sweep covers six; one live run per
flow feeds the record/history/receipt assertions as piggybacks.

## 3. Findings from grounding (fix or track before testing)

The inventory itself surfaced real defects. These are pre-work, not tests.

**F1. The golden-proof capture pipeline is broken on main (confirmed by
direct run).** `npm run capture-proofs:golden-runs` crashes at the prototype
scenario's resume with `runtime checkpoint resume rejected: run is already
closed`, after capturing 8 of 13 scenarios. Worse: the 8 it does capture
diverge materially from the committed corpus (143 files changed; the
checkpoint scenario's fresh capture loses its `build-result.json`). CI stays
green because gates validate committed bytes only. Meaning: the committed
proofs are not reproducible by the current engine, and nobody would have
noticed at tag time. Fix the capture stubs, recapture all 13, re-review, and
re-pin. This blocks any release that claims current proofs.

**F2. Pursue proof + contract (launch-plan blocker 4).** Confirmed: no
`contract.md`, no proof scenario, no index entry, and the scenario-addition
procedure itself is undocumented. Work: write the contract doc, add a
`proof:pursue` stub scenario to the capture script and `index.yaml`, pin its
outcome in `release-infrastructure.test.ts`, document the add-a-scenario
procedure in the proofs README, and run one live Pursue (T4.6) as the live
leg.

**F3. `index.yaml` display commands drift from capture argv.**
`proof:explore-decision` omits the positional and tournament flags the
script actually passes; `proof:plan-execution` goal text differs. Fix when
recapturing; add the consistency check.

**F4. Two scenarios have no pinned outcome.** `prototype` and
`explore-autonomous-decision` are absent from the expected-outcome map in
`release-infrastructure.test.ts`. Pin them.

**F5. Small legibility drift.** On verification: `usage()` already lists
reclaim; the actual gap was `generate`, listed in the missing-command error
but absent from `usage()`. One-line fix.

**F6. Two free permanent tests missing on the Claude hook surface.**
`plugins/claude/hooks/hooks.json` registration shape (SessionStart matcher,
harvest wiring for Stop/SessionEnd/PreCompact) has existence-only coverage,
and `harvest.ts` has no subprocess-level test (the adapter pattern already
exists for `session-start.ts`; clone it). Add both.

**F7. No proof-recency gate.** The eval ledger has a cadence gate; the proof
corpus does not, which is exactly how F1 stayed invisible. Proposal: mirror
the cadence gate. Fail `check-release-ready` if the newest commit touching
`docs/release/proofs/runs/` predates the newest commit touching
`src/runtime/` without a waiver.

**F8. README claims an untracked-files gate over `proofs/runs/` that does
not exist.** Implement it (one `git status --porcelain` check in
`check-proof-coverage.ts`) or fix the sentence. Check for test-locked
wording first.

**F9. Explore's standard (non-tournament) path has no proof at all.** Both
committed Explore proofs are tournament runs. Add a standard-path scenario
(free, stub relayer).

**F10. The landing dial matrix has no cross-repo gate.** The 9 model cells
in circuit-land's `dial-section.tsx` are hand-copied from preview output and
can rot silently. Add a check to circuit-land's `check-content.mjs` that
diffs them against `circuit preview build --matrix --json` (or a committed
snapshot of it).

## 4. The test layers

Owner key: **auto** = I run it from this machine unattended. **session** =
needs a real interactive host session (Pete, or me driving a scripted
`claude --print` where that substitutes). Cost key: free = no model spend.

### Layer 0: entry gates (free, minutes)

| ID | Item | How |
|---|---|---|
| T0.1 | CI green at the release SHA | `gh run list --workflow verify`; both OS slots. No local rerun. (auto) |
| T0.2 | Release-ready gate alive | `npm run check-release-ready`; expect the eval-cadence blockers, which schedule T4.7 (auto) |
| T0.3 | Publish preflight | `npm run publish:plugins:check` at the release SHA (auto) |

### Layer 1: at-the-tag integrity (free, ~20 min)

The working tree passing gates does not mean the tag is internally
consistent (F1 proves the class). In a scratch worktree under `.worktrees/`
at the tag:

| ID | Item | How |
|---|---|---|
| T1.1 | Drift gates at the tag | `npm ci && npm run check-flow-drift && npm run check-plugin-runtime`; grep both bundles for absolute paths and dev residue (auto) |
| T1.2 | Three-way version agreement | `bin/circuit version` == `plugins/version.json` == the version baked into both plugin bundles (auto) |
| T1.3 | Proof capture exits 0 | `npm run capture-proofs:golden-runs` clean, diff reviewable. Currently fails; F1 gates this (auto) |

### Layer 2: CLI conformance sweep (free, scripted, ~1 hour to build once)

All fixture- or preview-driven, no model spend. Several are worth keeping as
permanent tests afterward (marked ↺).

| ID | Item | How |
|---|---|---|
| T2.1 | Dispatch and exit codes | no-arg, unknown command, `-h` for all 13 commands; exit 2/2/0; no raw Commander tokens (auto) |
| T2.2 | Axis rejection matrix ↺ | 6 flows x depth/power/tournament/autonomous acceptance vs each schematic's declared axes; rejection text names the real allow-list (auto) |
| T2.3 | Preview sweep | `--matrix --json` for all six public flows: zero step problems, researcher on the top tier in every column, codex default model resolves from the real cache, cross-tool-build moves effort per dial, auto caption verbatim under a scrubbed HOME (auto) |
| T2.4 | Config surface matrix ↺ | user-vs-project precedence, explicit pin beats dial, power_auto bounds clamp, custom connector registers and resolves, malformed config errors name file and key path. All through preview, spawn-free (auto) |
| T2.5 | Uninstall against the real install block | plant the block `get-started.tsx` actually writes, run uninstall, assert clean strip and that printed removal commands match the docs (auto) |
| T2.6 | Checkpoint depth matrix (fixture) | auto-resolve at low/medium (`auto_resolved:true` in trace), park at high, resume closes; write-disclosure line appears before the first write-capable relay and never on review (auto) |
| T2.7 | Untracked-content boundary ↺ | canary string in an untracked file; review relay prompt carries path and size, not the canary; flips with `--include-untracked-content` (auto) |
| T2.8 | Retry-one-tier-up (fixture) | fail the implementer relay once; retry selection carries the next tier and `power_escalated:true` (auto) |
| T2.9 | Cross-repo copy drift | script diffing circuit-land's dial-matrix cells and CLI docs flag tables against engine truth; plus circuit-land `check:content` (feeds F10) (auto) |
| T2.10 | `circuit reclaim` ↺ | the only command with zero CLI-level tests: fake worktree layout, removed/kept split, `--json`, subdirectory invocation (auto) |
| T2.11 | Six-flow roster wall | `plugins/*/skills` lists exactly the six; internal flow rejected through the installed wrapper with the named error (auto) |
| T2.12 | The floor (fixture) | verify step forced to fail every attempt; run terminates non-complete, never launders to done (auto) |
| T2.13 | Skill hooks (fixture) | config-gated `before/after:edit-files` hook injects `triggered_skills` into the implementer relay (the one shipped feature no inventory reader owned) (auto) |

### Layer 3: cheap live smokes (~$3-8 total)

The pre-built opt-in live checks, run against the currently installed host
CLIs. These catch host-CLI version drift that frozen fixtures cannot.

| ID | Item | How |
|---|---|---|
| T3.1 | Claude connector live | `AGENT_SMOKE=1 npx vitest run` on the connector smoke + relay roundtrip (auto) |
| T3.2 | Codex connector live | `CODEX_SMOKE=1` smoke + roundtrip; one relay at effort xhigh; one `--output-schema` acceptance; one fresh `codex exec --json` capture through the parser (auto) |
| T3.3 | Tool wall live | one relay with allow-list [Read, Grep]; init tools equal allow-list plus StructuredOutput; one disallowed call actually fails (auto) |
| T3.4 | Installed caches | `plugins:refresh-local` then `check:host-plugin-caches` then `doctor:plugins:installed`; require zero Codex doctor warnings, not just zero failures (auto) |
| T3.5 | Host smoke scripts | `smoke:host:claude` and `smoke:host:codex -- --use-real-user-hooks`; a skip (no auth) counts as a failure for sign-off (auto) |
| T3.6 | Generate live | one draft-only `circuit generate`; plus the claude-CLI-absent path fails with a legible named error (auto) |
| T3.7 | Degraded-connector matrix | per connector: binary missing from PATH, present but logged out; error names host auth, no retry-tier burn on non-model failures, resume works after (auto) |

### Layer 4: live flow ledger (~$15-40, a few hours mostly unattended)

The single biggest gap the sweep found: **no committed live-model evidence
exists for any flow or mode.** All 13 proofs are stub-relayer captures. One
default-dial live run per public flow, on seeded scratch repos, archived as
a live-runs ledger under `docs/release/proofs/`. Each run carries piggyback
assertions so nothing is booked twice.

| ID | Run | Piggyback assertions |
|---|---|---|
| T4.1 | Review on a seeded flawed diff | `git status --porcelain` byte-identical before/after (the "never edits" claim has no test today); secrets canary absent from the run folder; then runs show, history rebuild and query roundtrip (auto) |
| T4.2 | Fix on a seeded one-line bug with a failing test | receipt's minutes and dollars against the "several minutes, a few dollars" claim; spend-per-role line renders with all three roles (auto) |
| T4.3 | Build (medium) on a small feature | worker commits contain no `.circuit/` paths and nothing outside the declared change set (auto) |
| T4.4 | Explore standard + one tournament n=2 | standard path has no proof at all today; the tournament run parks, `circuit inbox --json` lists it with a working resume command, resume closes it (auto) |
| T4.5 | Prototype (medium) | run record completeness: trace, typed reports validating against their schemas, flow id recorded at start (auto) |
| T4.6 | Pursue on two small independent ideas | wave serialization + interference review; this is the live leg of F2 / blocker 4 (auto) |
| T4.7 | Eval cadence runs | live fix-vs-vanilla + verdict-correctness, `append-ledger` (required by check-release-ready before any next tag; ~$20-50, the biggest line item) (auto) |
| T4.8 | Targeted extras, in priority order | (a) Converge live on a genuinely failing check: green at complete with the iteration ledger, and a never-green variant exits needs-attention. Graduating Converge is a v1 positioning claim, so this is in the blocking set. (b) Autonomous fix engineered to need attempt 2: the continuation loop is the least-live-proven promise. (c) cross-tool-build end-to-end: defer, still internal. (auto) |

### Layer 5: host-owned seams (the only per-host layer)

Everything here is unreachable from the CLI. The `circuit-surface-test`
skill codifies most of the Claude side; the Codex side follows
`docs/host-trial-checklist.md`.

Claude Code:

| ID | Item | Owner |
|---|---|---|
| T5.1 | Fresh-profile marketplace install from the published ref, in a directory far from any checkout: palette shows exactly run, handoff, pursue; version reports 0.1.0-alpha.9, not 0.0.0-dev; no error mentions dist/ or node_modules | session |
| T5.2 | Flow recommendation: three canned intents (bug, question, diff) each get the right flow named with a reason before the CLI runs, and result.json records that flow | session |
| T5.3 | Quoting probe: a goal containing an apostrophe and `$(uname -a)` reaches the envelope literally; nothing executes | session |
| T5.4 | Checkpoint round trip in-session: high-depth run parks, a native question appears, answering resumes the same session | session |
| T5.5 | Hooks on real events: handoff saved, new session injects the brief; /clear and /compact variants; harvest lands with source stop or session-end (extend the smoke script for the scriptable part); PreCompact manually | session (partly auto) |
| T5.6 | Digest fidelity: the model's final message matches operator-summary.md; no raw JSON leaks | session |
| T5.7 | Uninstall then reinstall: clean removal including the sentinel block, then a working reinstall with no duplicates | session |

Codex:

| ID | Item | Owner |
|---|---|---|
| T5.8 | Marketplace add with `--ref circuit--v0.1.0-alpha.9` on a temp CODEX_HOME; plugin lists; /circuit:run appears; the run skill also triggers from plain "Use Circuit on this task" (skill triggering has zero automated coverage) | session |
| T5.9 | `handoff hooks install` then doctor then a real SessionStart injection; install twice leaves exactly one sentinel block | session (partly auto) |
| T5.10 | Nested sandbox: one /circuit:run fix reaching a real worker from inside a default-sandbox Codex session. The single highest-value Codex check; nothing simulates it | session |
| T5.11 | Checkpoint conversational leg: the model asks, constructs the resume command correctly, run completes | session |
| T5.12 | Uninstall/reinstall; printed removal commands match Codex's real layout | session |

Cross-host:

| ID | Item | Owner |
|---|---|---|
| T5.13 | A handoff saved in Claude Code resumes correctly in Codex on the same repo (both plugins on one machine, shared .circuit state) | session |

### Layer 6: robustness matrix (critic findings; subset blocks)

| ID | Item | Blocking? |
|---|---|---|
| T6.1 | Ctrl-C mid-relay: no orphaned workers, reclaim cleans, resume works on the torn run (auto) | yes: first thing a real user does |
| T6.2 | Secrets audit: fake API key in .env and an untracked file; grep the full run folder and continuity record after review, build, and a harvest (auto) | yes: launch-day trust |
| T6.3 | Invocation contexts: repo subdirectory, non-git dir, path with spaces, dirty tree (auto) | yes, cheap |
| T6.4 | Two concurrent runs in one repo (one write-capable, one review) (auto) | no: fast-follow, record as known-untested |
| T6.5 | Upgrade from the prior published tag: old run records, handoffs, and config read by the new version (auto) | no: fast-follow for alpha-to-alpha; becomes yes at the first post-v1 release |
| T6.6 | Node 20 and 22.17 against the launchers: gate message is legible, not a syntax error (auto) | yes, five minutes |

### Layer 7: claims and copy conformance

| ID | Item | Owner |
|---|---|---|
| T7.1 | Announcement-draft claim extraction: `v1-announcement-draft.md` is untracked and sits outside every doc gate, yet it is the highest-blast-radius claim surface. Map every behavioral sentence to an engine citation or a Layer 2-4 result | auto |
| T7.2 | New-user read-through: fresh clone at the tag, follow README and quickstart commands verbatim (doubles as the T4.2 setup) | auto |

## 5. The blocking set for the announcement

Everything is worth doing; not everything blocks. Recommended blocking set:

1. **Fixes F1 through F5** (broken capture pipeline, Pursue proof + contract,
   index drift, unpinned outcomes, usage lines). F6 through F10 are strongly
   recommended but are additive gates, not launch risks.
2. **Layers 0 through 3 in full.** All free or under $10.
3. **T4.1 through T4.6**: one live run per public flow. The announcement
   names all six; none has ever run against a live model on the record.
   Plus T4.8a (Converge live), since the loop is a positioning claim.
   T4.7 (evals) blocks the next tag, not the announcement, unless the
   receipts post ships (its gate is positioning.md, Pete's call).
4. **T5.1, T5.2, T5.4, T5.5 on Claude Code and T5.8 through T5.10 on
   Codex**: fresh install, one recommendation pass, one checkpoint round
   trip, hooks alive, and the Codex nested-sandbox run. The install path is
   what every reader hits within five minutes of the post.
5. **T6.1, T6.2, T6.3, T6.6** from robustness. T7.1 and T7.2.

Fast-follow (recorded as known gaps, not launch blockers): T4.8b/c, T5.3,
T5.6, T5.7, T5.11 through T5.13, T6.4, T6.5, cursor-agent live smoke (the
third built-in connector has no live coverage at all; the claim registry
only names it as existing, so a smoke plus a legible missing-binary error
is enough for v1).

## 6. Sequencing and budget

Order matters because later layers consume earlier artifacts:

1. F1 fix and recapture, F2 through F5, then Layer 1 (the tag must be
   provably coherent before anything else claims to test it).
2. Layers 0 and 2 (free, parallel with 1).
3. Layer 3, then Layer 4 (live runs feed the ledger plus T7 measurements).
4. Layer 5 last (caches refreshed by T3.4; live runs already grounded the
   engine, so a host failure isolates cleanly to the host seam).
5. Layer 6 anytime after Layer 2; Layer 7 alongside Layer 4.

Estimated spend: Layers 0-2 free; Layer 3 about $3-8; Layer 4 about $15-40
(plus $20-50 if T4.7 evals run now); Layer 5 about $5-10 of runs plus one to
two hours of interactive session time; Layer 6 under $5. Total without
evals: roughly $30-60 and one focused day, most of it unattended. I can
execute everything marked auto; the session-marked items need an interactive
host (I can script parts via `claude --print`, and will mark exactly what
remains for a human hand).

## 7. What the sweep leaves behind

Not a one-off. The permanent residue:

- A **live-runs ledger** under `docs/release/proofs/` (one archived live run
  per public flow, receipts included), so "no live evidence" can never be
  true again silently.
- **Permanent tests** from the ↺ items: reclaim CLI, axis matrix, config
  matrix, untracked-content boundary, hooks.json registration, harvest.ts
  subprocess (F6).
- **Two new gates**: proof recency (F7) and the cross-repo dial-matrix check
  (F10), plus the index-vs-argv consistency check (F3).
- The **add-a-proof-scenario procedure** documented in the proofs README
  (F2), so the next flow does not need archaeology.
- Upgraded rows in the **host-adapter acceptance matrix** wherever a live
  proof now exists, so claims and coverage stay coupled.
