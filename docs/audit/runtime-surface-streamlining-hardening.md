# Runtime Surface Streamlining + Hardening Audit

Date: April 11, 2026

## Scope Brief

- Area under review: runtime surface only
  - `scripts/runtime/engine`
  - hooks
  - generated prompt/install surfaces
  - cache/install tooling
- Fixed contracts during analysis:
  - Hooks: `hooks/session-start.sh`, `hooks/user-prompt-submit.js`
  - Bundled CLIs and wrappers: `continuity`, `verify-install`, `catalog-compiler`, `circuit-engine`
  - Generated/runtime surfaces: `scripts/runtime/generated/prompt-contracts.json`, `scripts/runtime/generated/surface-manifest.json`, generated command shims, generated skill contract blocks
  - Build runtime flow: `bootstrap`, `request-checkpoint`, `resolve-checkpoint`, `dispatch-step`, `reconcile-dispatch`, `resume`, `render`
- Out of scope:
  - product behavior changes
  - public contract changes
  - broad architecture rework outside the named runtime seam
  - manual host-surface smoke unless code/tests left a host-only gap
- Priority signal used:
  - April 9-11, 2026 churn, then user impact, side effects, and contract sensitivity
- Output mode: artifact mode

## Validation Baseline

Evidence commands run:

```bash
cd scripts/runtime/engine && npm run typecheck
cd scripts/runtime/engine && npm test
node scripts/runtime/bin/catalog-compiler.js generate --check
scripts/verify-install.sh --mode repo
```

Results:

- `npm run typecheck`: passed
- `npm test`: passed (`28` files, `245` tests)
- `catalog-compiler generate --check`: passed
- `scripts/verify-install.sh --mode repo`: passed (`9` checks)

Manual host-surface smoke harness was not needed. Static, integration, and repo-mode verification were enough to prove or disprove the main hypotheses below.

## Coverage Ledger

| Slice | Entrypoints / files | Invariants checked | Risk | Status |
|---|---|---|---|---|
| Prompt-surface control plane | `prompt-surface-contracts.ts`, `public-surface.ts`, `generate-targets.ts`, `generate.ts`, `surface-inventory.ts`, `verify-installed-surface.ts` | one semantic owner for generated surfaces, no duplicated block patching, manifest inventory matches generator output | High | done |
| Hook and continuity flow | `continuity.ts`, `cli/continuity.ts`, `cli/session-start.ts`, `cli/user-prompt-submit.ts`, hook wrappers | handoff resume/done correctness, passive session-start continuity, git-root slugging, plugin-root persistence, wrapper recovery | High | done |
| Install/cache/verification tooling | `scripts/sync-to-cache.sh`, `scripts/verify-install.sh`, `cli/verify-install.ts`, `surface-roots.ts` | installed/repo verification parity, drift detection, cache alias recovery, no shell-owned copy of surface inventory | Medium | done |
| Build runtime seam pass | `command-support.ts`, `checkpoint-step.ts`, `dispatch-step.ts`, `complete-synthesis.ts`, `render-active-run.ts`, `bootstrap.ts`, `cli/circuit-engine.ts` | state-machine correctness, shallow seam duplication, no-op/retry/resume behavior, event-backed rendering | Medium | done |

Slice hypotheses used:

### 1. Prompt-Surface Control Plane

- Generated-surface code still has more than one source of truth.
- Prompt-surface centralization moved prose into one file but did not fully remove duplicated registries or patching logic.
- Manifest inventory projection may be rebuilding generator output through a second path.

### 2. Hook And Continuity Flow

- Hook behavior may still depend on temporary prompt wording rather than normalized command intent.
- Continuity resolution may have redundant layers, but pointer fallback and git-root slugging are likely correctness-critical residue worth keeping.
- Plugin-root persistence and helper wrapper generation may be broader than necessary.

### 3. Install/Cache/Verification Tooling

- Install verification and cache sync may still duplicate filesystem/surface policy.
- Cache alias and marketplace logic may be verbose but safety-motivated rather than accidental complexity.
- Repo vs installed verification may be intentionally redundant because the shipped diagnostic must prove the installed surface, not just tests.

### 4. Build Runtime Seam Pass

- Step commands may repeat the same state-machine skeleton and event choreography.
- Render/bootstrap may still be doing work that should live behind a deeper module boundary.
- Retry/no-op/reconcile logic may be correct but shallow and therefore costly to evolve.

## Ranked Findings

### 1. Manifest inventory projection still rebuilds generated surfaces through a second target pipeline

- Severity: High
- Type: simplification opportunity, contract fragility
- Status: Confirmed
- Confidence: High
- Exact location:
  - `scripts/runtime/engine/src/catalog/surface-inventory.ts:34-60`
  - `scripts/runtime/engine/src/catalog/surface-inventory.ts:85-125`
  - `scripts/runtime/engine/src/catalog/generate-targets.ts:25-53`
  - `scripts/runtime/engine/src/catalog/generate.ts:95-123`
- Impacted behavior:
  - shipped `surface-manifest.json` file hashes
  - `catalog-compiler generate --check`
  - `verify-install` drift detection
- Observed evidence:
  - `surface-inventory.ts` manually reconstructs generated projections for `.claude-plugin/public-commands.txt`, `prompt-contracts.json`, skill block patches, and command shims instead of consuming the same target pipeline used by `generate-targets.ts`.
  - It also carries its own block patcher (`patchGeneratedBlock`) with the same marker and `DO NOT EDIT` behavior already implemented in `generate.ts`.
- Inference:
  - The code now has one registry for writing generated outputs and another for hashing/manifesting those same outputs.
  - Any future target addition or patching-rule change must land in two places or the manifest can drift from the generator even when authored sources are correct.
- What I checked:
  - direct source comparison across `surface-inventory.ts`, `generate-targets.ts`, `generate.ts`
  - `catalog-compiler generate --check`
  - `scripts/verify-install.sh --mode repo`
  - `scripts/runtime/engine/src/catalog/generate.test.ts:128-197`
  - `scripts/runtime/engine/src/catalog/verify-installed-surface.test.ts`
- Smallest credible next action:
  - Introduce one shared generated-target/projection helper that both the generator and manifest inventory consume.
  - Move block patching into that shared helper before changing any emitted text.

### 2. Prompt-surface centralization did not actually collapse the slug registries or repeated prose blocks

- Severity: High
- Type: simplification opportunity, code-quality issue
- Status: Confirmed
- Confidence: High
- Exact location:
  - `scripts/runtime/engine/src/catalog/prompt-surface-contracts.ts:55-157`
  - `scripts/runtime/engine/src/catalog/prompt-surface-contracts.ts:159-229`
  - `scripts/runtime/engine/src/catalog/prompt-surface-contracts.ts:297-497`
  - `scripts/runtime/engine/src/catalog/prompt-surface-contracts.ts:598-706`
  - `scripts/runtime/engine/src/catalog/public-surface.ts:19-27`
  - `scripts/runtime/engine/src/catalog/prompt-surface-contracts.ts:574-582`
- Impacted behavior:
  - generated skill contract blocks
  - generated command shims
  - generated prompt-contract manifest
  - generated CIRCUITS smoke block
- Observed evidence:
  - One file now owns the semantics, but it still contains separate registries for helper wrappers, surface summaries, fast-mode payloads, skill block targets, and repeated Build smoke prose.
  - The Build bootstrap command shape is repeated across `FAST_MODE_CONTRACTS.build_smoke`, `renderBuildContractBlock`, `renderRunContractBlock`, and `renderCircuitsSmokeContract`.
  - `firstSentence()` normalization is duplicated in both `public-surface.ts` and `prompt-surface-contracts.ts`, even though RFC ownership says description normalization is a fixed rule.
- Inference:
  - This is better than the pre-April-11 spread, but it is still “one giant file with several internal sources of truth,” not a single table-driven contract model.
  - The module is now the hottest cleanup candidate because a workflow rename or smoke-contract wording change still requires synchronized edits across multiple in-file registries and renderers.
- What I checked:
  - direct source read of `prompt-surface-contracts.ts`, `public-surface.ts`, `generate-targets.ts`
  - generated-surface freshness and full test suite
  - April 11, 2026 churn history (`b5eafa5`, `b209ae0`)
- Smallest credible next action:
  - Keep emitted text byte-for-byte stable, but split the module into:
    - normalized contract data tables
    - shared text fragments/render helpers
    - target registration
  - Centralize description normalization in one utility used by both public-surface and shim rendering.

### 3. `user-prompt-submit` fast-mode routing is still wording-driven for correctness-critical paths

- Severity: High
- Type: correctness risk, contract fragility
- Status: Confirmed
- Confidence: High
- Exact location:
  - `scripts/runtime/engine/src/cli/user-prompt-submit.ts:28-77`
  - `scripts/runtime/engine/src/cli/user-prompt-submit.ts:181-216`
- Impacted behavior:
  - Build smoke bootstrap interception
  - legacy smoke bootstrap interception
  - `/circuit:review current changes`
  - `/circuit:handoff done`
  - `/circuit:handoff resume`
- Observed evidence:
  - Routing uses `lower.includes(...)` checks for slash commands and manual phrase lists like `"smoke bootstrap"`, `"bootstrap path"`, `"workflow surface"`, `"current changes"`, and artifact filenames.
  - The generated `prompt-contracts.json` holds the fast-mode payloads, but not the selection logic that decides when to use them.
- Inference:
  - The system centralized the emitted contracts, but not the intent parser.
  - That means the most correctness-sensitive hook behavior still depends on prompt wording instead of normalized command tokens plus structured fast-mode intent.
- What I checked:
  - `scripts/runtime/engine/src/cli/user-prompt-submit.ts`
  - `scripts/runtime/engine/src/user-prompt-submit.integration.test.ts:77-290`
  - repo-mode `verify-install`
  - installed-copy execution path covered by the integration test
- Smallest credible next action:
  - Harden before simplifying: add a normalized slash-command parser for `/circuit:<slug>` plus argument-tail intent detection.
  - Keep using generated payloads, but stop keying interception on raw substring matches.

### 4. Dedicated prompt-surface regression coverage was removed before the contract layer became narrow enough

- Severity: Medium
- Type: hardening risk
- Status: Confirmed
- Confidence: Medium
- Exact location:
  - April 11, 2026 commit `b209ae0` (`Remove stale prompt-surface regression coverage`)
  - current remaining coverage:
    - `scripts/runtime/engine/src/catalog/generate.test.ts:128-197`
    - `scripts/runtime/engine/src/build-run-wiring.test.ts:37-160`
    - `scripts/runtime/engine/src/user-prompt-submit.integration.test.ts:77-290`
- Impacted behavior:
  - cross-surface consistency between generated command shims, skill blocks, CIRCUITS block, and fast-mode payloads
- Observed evidence:
  - The April 11 cleanup removed dedicated prompt-surface contract tests.
  - Remaining coverage proves some generated content and several hook-trigger phrases, but it does not directly lock down the full `PromptContractsManifest` or guarantee that repeated smoke text stays consistent across all rendered surfaces.
- Inference:
  - The current coverage is enough to keep the green path stable today, but it is thin for a cleanup pass aimed at the same module that just absorbed the prompt surface.
  - Simplifying this area first without reintroducing narrower golden/contract tests would increase the odds of wording drift across generated surfaces.
- What I checked:
  - `git log --since='2026-04-09' --until='2026-04-12'`
  - current prompt-surface-related test files
  - full test pass
- Smallest credible next action:
  - Add narrow, deterministic contract tests for:
    - `buildPromptContractsManifest()`
    - Build smoke text shared across shim/block/fast-mode projections
    - fast-mode target registration

### 5. Runtime step commands are correct but still shallow: they manually repeat the same event/transition choreography

- Severity: Medium
- Type: simplification opportunity, code-quality issue
- Status: Confirmed
- Confidence: Medium
- Exact location:
  - `scripts/runtime/engine/src/checkpoint-step.ts:66-267`
  - `scripts/runtime/engine/src/complete-synthesis.ts:47-165`
  - `scripts/runtime/engine/src/dispatch-step.ts:135-513`
  - `scripts/runtime/engine/src/command-support.ts:192-228`
  - `scripts/runtime/engine/src/command-support.ts:243-325`
  - `scripts/runtime/engine/src/command-support.ts:420-428`
- Impacted behavior:
  - checkpoint request/resolve
  - synthesis completion
  - dispatch request/reconcile
  - active-run rendering after state changes
- Observed evidence:
  - Each command module repeats the same sequence:
    - load run context
    - require step and type
    - apply the same usable/no-op gate
    - optionally emit `artifact_written`
    - assemble `gate_passed` plus `run_completed` or `step_started`
    - render dashboard
  - `command-support.ts` provides low-level helpers, but not a deeper “step transition” abstraction.
- Inference:
  - This is not failing today; the runtime test surface is strong.
  - It is, however, still a shallow seam: behavior is spread across three command modules plus a helper file, which raises edit cost and makes asymmetry more likely in future changes.
- What I checked:
  - direct source read of the command modules
  - `checkpoint-step.test.ts`
  - `complete-synthesis.test.ts`
  - `dispatch-step.test.ts`
  - `render-active-run.test.ts`
  - runtime CLI integration tests
- Smallest credible next action:
  - After prompt-surface hardening, extract one shared transition helper for:
    - completed-step no-op handling
    - artifact-written event staging
    - route-to-terminal-or-next-step event emission

## Decision Split

### Simplify Now

1. Unify generator target projection and manifest inventory projection.
   - Why now: highest payoff, low public-contract risk, mostly mechanical.
   - Scope: `generate.ts`, `generate-targets.ts`, `surface-inventory.ts`.

2. Centralize shared text/normalization helpers inside the prompt-surface control plane.
   - Why now: safe precursor to larger cleanup.
   - Scope: block patching, description first-sentence normalization, shared smoke command fragments.

3. Table-drive internal prompt-surface registries without changing emitted text.
   - Why now: reduces future churn cost once the projection path is unified.
   - Scope: `prompt-surface-contracts.ts`.

### Harden First

1. Replace substring-driven hook fast-mode selection with normalized slash-command parsing.
   - Reason: this path is correctness-critical and still wording-sensitive.

2. Reintroduce narrow prompt-surface contract tests before refactoring the central prompt module.
   - Reason: April 11, 2026 removed dedicated coverage while the module got larger, not smaller.

### Uncertain / Follow-Up Needed

1. Dispatch result-shape tolerance in `reconcile-dispatch` may be too permissive.
   - Evidence: completion and verdict are inferred from several JSON locations (`dispatch-step.ts:349-374`).
   - Why uncertain: current schema/runtime tests cover the supported shapes and I did not prove a live mismatch.
   - Follow-up: decide whether result JSON should become schema-pinned before further seam cleanup.

2. `findLatestActiveRun()` does a recursive fallback scan when the pointer is missing.
   - Evidence: `continuity.ts:115-149`.
   - Why uncertain: I did not profile large `.circuit` trees; current tests prove correctness, not scale.
   - Follow-up: only revisit if startup latency becomes visible.

### Intentionally Keep

1. Pointer-first, fallback-second continuity resolution.
   - Evidence: `continuity.ts:73-184`, `session-start.integration.test.ts:24-164`.
   - Why keep: recent April 10, 2026 regressions were in this area, and the current behavior protects correctness for resume/done and passive continuity.

2. Thin shell wrapper for `scripts/verify-install.sh`.
   - Evidence: `scripts/verify-install.sh:1-44`, `runtime-cli-integration.test.ts` thin-wrapper assertion.
   - Why keep: the shell is appropriately thin; the real logic already lives in `cli/verify-install.ts`.

3. `sync-to-cache.sh` sourcing installed-surface roots from the bundled CLI instead of a shell keep-list.
   - Evidence: `scripts/sync-to-cache.sh:16`, `61-91`, `124-156`; `sync-to-cache.test.ts`.
   - Why keep: the script is long, but the highest-risk duplication was already removed. Remaining verbosity is mostly operational safety around cache alias recovery and marketplace git hygiene.

4. Broad `verify-install` orchestration beyond manifest drift checks.
   - Evidence: `cli/verify-install.ts:151-406`.
   - Why keep: this is intentional shipped-diagnostic duplication, not accidental architecture drift. It validates real install/runtime behavior that unit tests alone cannot prove.

## Top Ranked Sets

### Top Simplification Candidates

1. Unify generated-target projection and manifest inventory projection.
2. Refactor `prompt-surface-contracts.ts` into tables plus shared render fragments.
3. Extract a shared step-transition helper for checkpoint/synthesis/dispatch commands.

### Top Hardening Risks

1. Wording-driven fast-mode detection in `user-prompt-submit`.
2. Reduced direct prompt-surface regression coverage after April 11, 2026 centralization.

## Start Here

Recommended first cleanup pass:

1. Add narrow golden tests for prompt contracts and fast-mode target registration.
2. Extract shared generated-block patching and description normalization helpers.
3. Make `surface-inventory.ts` consume the same generated-target model as `generate-targets.ts`.

This start-here set has the best payoff-to-risk ratio because it shrinks duplicated control-plane logic without touching the public contracts or the runtime state machine.

## What I Did Not Prove

- I did not run the manual host-surface smoke harness because automated evidence was sufficient.
- I did not profile continuity fallback scanning on very large `.circuit/circuit-runs` trees.
- I did not prove a real-world dispatch result-shape mismatch; I only identified the permissive inference path as something worth a later hardening decision.
