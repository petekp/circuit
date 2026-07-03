# V1 surface-test results — free/unattended layers

Run 2026-07-02 against tag `circuit--v0.1.0-alpha.9` (e8e3c28f, = main tip)
by executing [v1-surface-test-plan.md](v1-surface-test-plan.md). Covers every
layer that is free and does not require an interactive host session. Live
model runs (Layers 3 connector-smokes / 4 / T6.1 / T6.2) and interactive
host seams (Layer 5) are held at the spend gate below, awaiting sign-off.

## Update 2026-07-02: blocking fixes landed

F1 through F5 are fixed on main after this record was written:

- **F1** — capture pipeline repaired (fence-format prompt parsing plus
  scenario-local git fixtures whose relay stubs write claimed changes
  before claiming them, so the honesty criteria genuinely evaluate). The
  full corpus recaptured cleanly; residual recapture noise is documented
  in `proofs/README.md` under "Known noise classes".
- **F2** — `src/flows/pursue/contract.md` added and pinned by the axis
  test; `proof:pursue` scenario captured (two pursuits, serialized batch,
  live fixture verification, outcome `complete`); add-a-scenario
  procedure documented in `proofs/README.md`.
- **F3** — the three drifted `index.yaml` commands now mirror the capture
  argv, and a new test pins index/capture command consistency.
- **F4** — outcomes pinned for prototype, explore-autonomous-decision,
  explore-decision, and pursue.
- **F5** — `usage()` lists `generate` (the actual gap; `reclaim` was
  already present).

The findings below are kept as the point-in-time record of the sweep.

## Verdict so far

The **released artifact is coherent**: CI green on both OSes at the tag,
drift gates pass, three-way version agreement holds, bundles carry no
absolute paths or dev residue, and every engine behavior the announcement
leans on is proven by the existing suite. **No release-blocking defect was
found in the shipped code.**

The blockers are in the **proof/evidence machinery and one launch-day UX
gap**, exactly where the plan predicted. F1 is real and confirmed. The
biggest *unmeasured* risk is that no flow has ever run against a live model
on the record — the cost and receipt claims in the announcement are backed
only by stub fixtures.

## Layer-by-layer

### Layer 0 — entry gates
- **T0.1 PASS** — `verify` green at e8e3c28f on ubuntu + macos.
- **T0.2 PASS** — `check-release-ready` alive; emits exactly the two
  eval-cadence blockers (fix-vs-vanilla, verdict-correctness) → schedules T4.7.
- **T0.3 working-tree fail, not a release defect** — `publish:plugins:check`
  fails only on the uncommitted `docs/ideas/catalog.json` (biome format, 18
  added lines from the prior flow-ideas session). Tag is clean. Fix: format
  that file before committing.

### Layer 1 — at-the-tag integrity (scratch worktree `.worktrees/tag-alpha9`)
- **T1.1 PASS** — `check-flow-drift` + `check-plugin-runtime` in sync; bundle
  grep clean (no `/Users/`, node_modules, TODO/FIXME, localhost).
- **T1.2 PASS** — `bin/circuit version` = `plugins/version.json` = both
  bundles = `0.1.0-alpha.9`. The `0.0.0-dev` in the bundles is an unreachable
  `DEFAULT_DEV_VERSION` fallback; the resolver returns the literal.
- **T1.3 FAIL — F1 confirmed.** `capture-proofs:golden-runs` crashes at the
  prototype resume (`run is already closed`) after 8/13 scenarios; **146
  files diverge** from the committed corpus (118 M / 25 D / 3 new); the
  checkpoint scenario's fresh capture **deletes** its `build-result.json`.
  The committed proofs are not reproducible by the current engine.

### Layer 2 — CLI conformance sweep (all 13 PASS)
- **T2.1 PASS** — exit codes 2/2/0 (no-arg / unknown / help); unknown option = 2.
  Minor: per-command `-h` shows only generic help (variadic passthrough), a
  legibility nit, not a dispatch defect.
- **T2.2 PASS** — axis rejection proven by `cli-router.test.ts` (rejects
  tournament on non-tournament flows, names the allow-list, exit 2, no run
  folder). Pre-spawn — no spend.
- **T2.3 PASS (6 items)** — matrix JSON for all six flows: zero step problems,
  researcher on the flagship model in every dial column, codex default
  resolves to `gpt-5.5` from the live cache, cross-tool-build moves implementer
  effort per dial, output byte-identical under a scrubbed HOME, no path leaks.
- **T2.4 PASS** — project `defaults.power` overrides the dial; malformed value
  names file **and** key path; bad YAML names file + line/col; power_auto
  floor/ceiling validated; custom connectors `.strict()`-enforced.
- **T2.5 PASS** — live plant-and-strip removed the sentinel block (lines 5–8),
  preserved surrounding content, printed the real host removal commands. 58
  tests green.
- **T2.6 / T2.7 / T2.8 / T2.12 / T2.13 PASS** — engine behaviors proven by
  existing suites (checkpoint depth, untracked-content boundary, retry-tier,
  the false-done floor across 6 scenarios, skill-hook injection with role
  separation + resume re-seed). Dedicated CLI-level tests remain an
  enhancement, not a behavior gap.
- **T2.9 MATCH** — landing dial matrix == engine truth today; but F10 stands
  (no automated cross-repo gate; it can rot silently).
- **T2.10 PASS** — reclaim `--json` and human form work, subdirectory
  invocation works.
- **T2.11 PASS** — roster is exactly six; internal flows rejected through the
  runtime (verified separately in cli-router). Note: preview intentionally
  shows internal flows (dev tool); the wall lives at the installed wrapper.

### Grounding findings F1–F10 — all confirmed
- **F1** confirmed (see T1.3). Blocks any release claiming current proofs.
- **F2** confirmed — pursue is the only flow with **no** `contract.md`, no
  proof run, no `index.yaml` entry.
- **F3** confirmed — `index.yaml` display command for explore-decision
  (`run --goal "decide: React vs Vue"`, no flow positional, no `--tournament`)
  drifts from the capture argv (which passes `--tournament --tournament-n`)
  and would additionally be rejected by the explicit-flow-required CLI.
- **F4** confirmed — no pinned `expected_outcome` for `prototype` or
  `explore-autonomous-decision`.
- **F5** confirmed but **shifted**: at the tag, `usage()` (src/cli/circuit.ts:50)
  now lists `reclaim` but **omits `generate`**. The plan (older SHA) had it
  reversed. One-line fix.
- **F6** confirmed (partial) — harvest.ts has no subprocess-level test and
  hooks.json registration has existence-only coverage. Additive gate.
- **F7** confirmed — no proof-recency gate; only the eval cadence gate exists,
  which is why F1 stayed invisible.
- **F8** confirmed — README (`docs/release/proofs/README.md:49`) claims an
  untracked-files gate over `runs/`; `check-proof-coverage.ts` does not
  implement it.
- **F9** confirmed — both committed Explore proofs are tournament runs; the
  standard path has no proof.
- **F10** confirmed — no cross-repo gate on the landing dial matrix.

### Layer 6 (auto subset)
- **T6.3 PASS** — repo subdirectory, non-git dir, path-with-spaces, dirty
  tree: all work, exit 0, no crashes.
- **T6.6 FINDING (medium, launch-day).** `MIN_NODE_VERSION = 22.18.0` — the
  exact point Node's native TypeScript type-stripping became default. Every
  production entry point invokes a `.ts` file directly (`node
  ".../scripts/circuit.ts"`, and all three hooks are `.ts`). On Node < 22.18,
  the file fails to load with a raw `ERR_UNKNOWN_FILE_EXTENSION: Unknown file
  extension ".ts"` **before** the legible `nodeVersionSupported()` gate
  (circuit.ts:650) can run. The gate message is effectively dead code below
  the floor. A Node-20 user gets a cryptic Node error, not "upgrade to Node
  22.18." Affects run + all hooks.
- **T6.1 / T6.2** — need a live run; held at the spend gate.

### Layer 7 — claims & copy
- **T7.1 done** — every behavioral sentence in `v1-announcement-draft.md`
  mapped. Verified-free: preview-is-free, six-flow roster, dial-by-role
  allocation, the floor, fresh-context isolation, verification-edit guard.
  **Unverified (need Layer 4 live):** "several minutes and a few dollars",
  "receipt shows what each role spent", "Review is read-only" (byte-identity),
  Converge "until the goal is proven met", "reports not-done" on exhaustion.
  Correctly gated: the eval numbers (positioning.md + T4.7).
- **T7.2 done** — README/quickstart commands accurate; `--ref
  circuit--v0.1.0-alpha.9` matches the tag. Two notes: (1) the **Claude Code
  install is not tag-pinned** (`/plugin marketplace add petekp/circuit`
  installs from the default branch, unlike the tag-pinned Codex path — matters
  for T5.1's "version reports alpha.9"); (2) the restated cost claims are the
  same unverified-live ones.

### Layer 3 — the one free item
- **T3.4 partial — FINDING (local env).** `check:host-plugin-caches` passes
  (exit 0, no stale). But `doctor:plugins:installed` **exits 1**:
  `codex_hooks.status: "invalid"` — `~/.codex/hooks.json` SessionStart hook
  points at a **stale** launcher `circuit-local/circuit/0.1.0-alpha.7/scripts/
  circuit.ts` (the cache is now alpha.9), so it is a `missing_launcher`. Codex
  continuity/SessionStart injection is currently broken on this machine
  because the hook launcher path did not follow the version bump. Fix:
  re-run `handoff hooks install` / `plugins:refresh-local`. Possible product
  gap: the hook should point at a version-agnostic path or refresh on install.

## What remains (spend gate)

Everything below spends money or needs an interactive host and is **not yet
run**:

- **Layer 3 connector smokes** (T3.1/3.2/3.3/3.5/3.6/3.7) — ~$3–8. Need
  `AGENT_SMOKE`/`CODEX_SMOKE` and live auth.
- **Layer 4 live flow ledger** (T4.1–T4.6, T4.8a) — ~$15–40. The single
  biggest gap: no committed live-model evidence for any flow. Feeds T7.1's
  unverified cost/receipt/read-only claims.
- **T4.7 eval cadence** — ~$20–50. Blocks the next tag, not the announcement
  (unless the receipts post ships).
- **T6.1 / T6.2** — Ctrl-C mid-relay and the secrets audit; need one live run.
- **Layer 5 host seams** (Claude T5.1–T5.7, Codex T5.8–T5.12, cross-host
  T5.13) — interactive sessions; some scriptable via `claude --print`.
