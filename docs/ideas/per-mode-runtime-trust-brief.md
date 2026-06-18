# Brief — close the per-mode runtime-trust gap

> Status: **implementation-spec. Decision-ready; builds in `src/`.** Date
> 2026-06-18, grounded on `main` at HEAD `c8026ef2`. This is a recorded follow-up
> from the task-aware assembler integration review
> ([`assembler-rebuild-run-report.md`](assembler-rebuild-run-report.md) §1, §4 —
> "Per-mode runtime trust"). It is a **trust-surface decision deliberately not
> made unilaterally** in the assembler PR; this brief frames the two options and
> recommends one.

---

## 0. The gap (why this, why now)

The task-aware assembler produces, for some families (fix / research / prototype),
a **per-mode package**: one graph per runtime mode, laid out as `circuit.json`
(the **default** mode) plus `<mode>.json` siblings (e.g. `low.json`, `high.json`).
Publish copies all of them. The runtime mode loader picks a mode's file **by disk
presence** of `<mode>.json`. But the **trust gate blesses only the manifest's
single `circuit.json` `flow_path`** — so running a published custom flow in a
**non-default** mode resolves to an unblessed sibling and is rejected with a
**confusing, generic** error:

> `error: unsupported runtime invocation: explicit --fixture/--flow-root inputs
> must point at generated flows, trusted generated mirrors, or published custom
> flows`

It **fails closed** (safe — an unblessed file never runs), but the operator is
told nothing useful: the mode *is* published, it just is not blessed. This will
bite the moment anyone runs a published custom fix/research/prototype flow at a
non-default depth — including, plausibly, the dynamic-vs-reference experiment.

---

## 1. Current state (grounded in `src/`)

- **The trust gate.** `publishedCustomFlowMatches(flowRoot, fixturePath)` in
  `src/cli/runtime-routing-policy.ts` reads the sibling `manifest.json`, walks
  `custom_flows[]`, and returns true only if `resolve(entry.flow_path) ===
  fixturePath`. Each entry's `flow_path` is the single `circuit.json` written at
  publish. It is called from `fixtureEligibleForRuntime` → `applyFixturePolicy`,
  and the reject text comes from `RUNTIME_POLICY_REASONS.externalFixtureOrRoot`,
  surfaced in `src/cli/run.ts` as `unsupported runtime invocation: <reason>`.
- **The manifest.** Published flows are recorded in `manifest.json` (written by the
  publish path in `src/cli/create.ts`); each entry carries identity + the single
  `flow_path` (the M9-C rule: the manifest records **identity, not shape** — the
  archetype family is legibility metadata that never reaches the runtime; "the
  runtime resolves by slug → flow_path and loads per-mode siblings by disk
  presence"). The descriptor schema (`src/schemas/custom-flow-descriptor.ts`) is
  `.strict()` and pins `compiled_flow: 'circuit.json'`.
- **The per-mode layout.** `planCompiledFlowFiles` (`src/flows/compiled-flow-file-plan.ts`)
  emits `circuit.json` for the **default** mode's graph plus `<mode>.json` siblings;
  `publishDraft` in `create.ts` clears the target dir then copies **all** files the
  draft owns (the siblings included).
- **The mode loader.** `resolveCompiledFlowPath(flowName, modeName, override, flowRoot)`
  in `src/cli/compiled-flow-loading.ts`: if a mode is requested and
  `<flowName>/<modeName>.json` exists on disk, it returns that sibling; else falls
  back to `circuit.json`. From `circuit run <slug> --depth low`, the axis → mode name
  maps to `low`, resolves to `low.json`, then hits the trust gate, which does not
  bless it → the confusing reject.

So: the loader resolves `<mode>.json`, the trust gate trusts only `circuit.json`,
and the two disagree.

---

## 2. The two options

### Option A — bless the siblings into the manifest (full per-mode trust)
Record the per-mode sibling paths in the manifest at publish, and accept any blessed
sibling in the trust gate. Then a published custom flow runs in **any** mode it
published. Touches: the manifest write (`create.ts` publish path), the descriptor /
manifest schema (add a `mode_flow_paths` map or a `flow_paths` list — keep it
`.strict()` and identity-only in spirit: these are *paths this flow published*, not
shape), and the trust-gate comparison (`publishedCustomFlowMatches` accepts the main
path **or** any recorded sibling). Security note: safe — the siblings are emitted by
the same trusted assembler, written only into the publish dir (which `publishDraft`
clears first), and the manifest names exactly which siblings belong to the flow, so
nothing unrelated is blessed.

### Option B — clean "mode unsupported" message (keep default-only trust)
Keep blessing only `circuit.json`. Detect, in the reject path, that the resolved
file is a **known published sibling of a blessed flow** but is not itself blessed,
and emit a clear, actionable error — e.g. `error: mode 'low' is not published for
flow '<slug>'. Only the default mode is available; re-publish to enable other
modes.` Touches: a small detector near the trust gate and the reject site in
`run.ts`. No schema change. Security note: equally safe — the unblessed file still
never runs; only the *message* improves.

---

## 3. Recommendation

**Do Option A** — bless the siblings — **because the per-mode packages are a real,
shipped capability and the whole point of emitting them is to run them.** Option B
makes a clearer error for a capability we would otherwise be choosing *not* to ship,
which is the worse trade now that fix/research/prototype routinely produce siblings.

But A carries a genuine trust-surface change, so it must be done carefully and is the
operator's call to ratify. **Recommended scope:** implement A as the primary fix,
**and keep B's clean message as the fail-closed fallback** for any sibling that is
present on disk but *not* recorded in the manifest (a tampered or stale file) — so
the gate still fails closed with a legible reason, never the generic one. That gives
both: published modes run, and an unrecorded sibling is rejected *clearly*.

If the operator prefers to **not** widen the trust surface yet, fall back to **B
only** (clean message, default-mode-only trust) — a safe, smaller change that at
least stops the confusing error. **STOP-AND-REPORT for the operator's choice
(A+fallback vs B-only) before building**, since it is a trust decision.

---

## 4. Rails / out of scope

- **Fail-closed is non-negotiable.** Whatever the option, an unblessed/unrecorded
  fixture must **never run**. The change improves *which blessed files run* (A)
  and/or the *message on rejection* (B); it never opens execution of an untrusted
  file.
- **Manifest stays identity-only in spirit (M9-C).** If A adds sibling paths, they
  are *published-path* facts, not shape/archetype. Do not reintroduce an `archetype`
  field; keep the descriptor `.strict()` and keep the contract test that rejects an
  `archetype` key passing.
- **Engine boundary holds.** This is CLI/runtime-routing + publish (`src/cli/**`,
  `src/schemas/custom-flow-descriptor.ts`), not the flow packages or the engine
  graph runner.
- **No behavior change for the default mode.** Running a published custom flow in
  its default mode must remain byte-for-byte the same trust decision it is today.

## 5. Verification (failing-test-first)

- Add a failing-test-first case for **running a published custom flow in a
  non-default mode** (the gap currently has no test — research confirmed). Mirror
  `tests/runner/runtime-routing-policy.test.ts` (trust-gate / fixture policy) and the
  publish tests (`tests/unit/create-publish-cleanup.test.ts`,
  `tests/unit/compiled-flow-file-plan.test.ts`).
- **Option A:** assert a published per-mode flow run in a recorded mode is **blessed
  and runs**, and an on-disk sibling **not** recorded in the manifest is **rejected
  with the clean message** (the fail-closed fallback), not the generic one.
- **Option B (if chosen):** assert the non-default-mode run rejects with the clear
  "mode unsupported" message, and the default mode is unaffected.
- Keep the descriptor contract test (`tests/contracts/custom-flow-descriptor.test.ts`)
  green — the `.strict()` / no-`archetype` invariant must still hold.
- Full `npm run verify` green; focused proof per AGENTS.md (release-surface / CLI
  routing → the routing-policy + CLI runtime tests).

## 6. Definition of done / safe-to-merge

- `npm run verify` green (full canonical gate).
- The chosen option implemented with its failing-test-first now passing; the
  non-default-mode run path is covered by a new test.
- Fail-closed proven: an unblessed/unrecorded sibling still does not run, and now
  rejects with a **clear** reason (never the generic "unsupported runtime
  invocation" for a known-published mode).
- M9-C invariant intact: descriptor `.strict()`, no `archetype` key, manifest
  identity-only.
- Default-mode trust decision unchanged.

---

## Hand-off prompt for Claude Code

Copy-paste the block below into Claude Code (run from the repo root,
`/Users/petepetrash/Code/circuit`).

```text
You are implementing a brief in the Circuit repo. Work from the repo root and stay
inside it.

1. Read docs/ideas/per-mode-runtime-trust-brief.md in full, then AGENTS.md and the
   grounding files it cites: src/cli/runtime-routing-policy.ts
   (publishedCustomFlowMatches + RUNTIME_POLICY_REASONS), src/cli/run.ts (the reject
   site), src/cli/create.ts (the publish path + manifest write),
   src/schemas/custom-flow-descriptor.ts, src/flows/compiled-flow-file-plan.ts, and
   src/cli/compiled-flow-loading.ts (resolveCompiledFlowPath). Follow the repo rails:
   read before write, FAILING-TEST-FIRST, plain English with the operator, and
   enumerate 2-3 hypotheses before acting.

2. This is a TRUST-SURFACE decision. Before writing code, STOP-AND-REPORT to me with
   the two options (A: bless per-mode siblings into the manifest, plus B's clean
   message as the fail-closed fallback for unrecorded siblings; or B-only: clean
   "mode unsupported" message, default-mode-only trust) and your recommendation (the
   brief recommends A+fallback). Wait for my choice before implementing.

3. After I choose: create branch feat/per-mode-runtime-trust and implement the chosen
   option. Write the failing test FIRST (running a published custom flow in a
   non-default mode — the gap has no test today). Honor the rails in §4: fail-closed
   is non-negotiable (an unblessed/unrecorded fixture NEVER runs); manifest stays
   identity-only (M9-C — no archetype key, descriptor stays .strict()); engine
   boundary holds (CLI/routing/publish only); default-mode trust is unchanged.

4. Run `npm run verify` (full) — it must be green.

Definition of "safe enough to merge" (all must hold):
  - npm run verify is green (full canonical gate).
  - The chosen option is implemented with its failing-test-first now passing, and the
    non-default-mode run path is covered.
  - Fail-closed proven: an unblessed/unrecorded sibling still does not run and now
    rejects with a CLEAR reason (a test asserts this), never the generic "unsupported
    runtime invocation" for a known-published mode.
  - The descriptor contract test still passes: .strict(), no archetype key, manifest
    identity-only.
  - The default-mode trust decision is unchanged (git diff + a test confirm).

Merge handling: when the above hold, commit with a conventional message (e.g.
"feat(create): bless per-mode published flows in the trust gate" or "fix(create):
clear mode-unsupported message for published custom flows"). If a GitHub remote + gh
CLI are available and the repo uses PRs (it does — history is "Merge pull request
#NNN from petekp/..."), open a PR, wait for CI green, then merge. Otherwise no-ff
merge into main locally. Then update docs/ideas/north-star-status.md (the §2
task-aware-`create` follow-ups note and the §7 "Next" item) to mark this follow-up
closed, and report: branch, commits, verify result, the option chosen, files
changed, and any blocker.

If anything would weaken fail-closed, reintroduce shape into the manifest, or change
the default-mode trust decision, STOP and report instead of merging.
```
