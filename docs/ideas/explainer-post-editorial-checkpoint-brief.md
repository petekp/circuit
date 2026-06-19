# Brief — explainer post-editorial checkpoint (the remaining P0)

> Status: **implementation-spec. Decision-ready; builds in `src/`.** Date
> 2026-06-18, grounded on `main` at HEAD `c8026ef2`. This closes the remaining P0
> from the paper-to-site generalization run
> ([`paper-to-site-2nd-run-findings.md`](paper-to-site-2nd-run-findings.md), and
> the north-star §5 findings): "resumable runs / a checkpoint after editorial, so a
> build failure does not throw away correct, expensive editorial output." The other
> P0 (the recovery-binding hard-abort) is already fixed (PR #105).

> **Outcome (2026-06-18) — built on `feat/explainer-post-editorial-checkpoint`.**
> Probe decision (the §2/§6 open question): **checkpoint + recovery binding ("two
> gates"), not checkpoint-only.** A three-arm offline probe against the real engine
> ($0, deterministic) proved a single post-editorial checkpoint is insufficient: in
> autonomous mode the gate auto-resolves `continue`, the build runs, and a build
> failure closes the run **terminally** with the gate already resolved — not
> resumable, so a retry re-runs editorial (Arm 1). Routing the failed build back to
> the already-resolved gate **aborts** (Arm 2). The minimum that preserves editorial
> is a **second, fresh** checkpoint: `build-step`'s `stop` recovery route lands on a
> never-resolved `retry-gate-step`, so a failed build parks the run **resumably** at
> an unresolved checkpoint and the editorial upstream is recorded once and reused
> (Arm 3). Shipped: `build-gate-step` (plan, after spec; routes
> `continue → build-step`, `revise → spec-step`, `stop → @stop`; safe-default
> `continue`) and `retry-gate-step` (act, on `build-step.stop`; routes
> `continue → build-step`, `stop → @stop`; safe-default `stop` so an unattended run
> does not loop on a deterministically-failing build). Pure flow placement + wiring
> in `src/flows/explainer/data.ts`; no engine change.

---

## 0. The problem (why this, why now)

The `explainer` (paper → interactive site) flow does its expensive **editorial**
work first (digest, ideate, a tournament fan-out, an adversarial harden, the PICK
checkpoint, and the spec), then delegates the **build** to a child sub-run. When the
child build fails, the correct, costly editorial output upstream is at risk of being
thrown away and **re-spent** (~$6 of editorial fan-out was re-spent in the 2nd run).
There is no durable boundary between "editorial done" and "build done," so a build
failure or a resume rebuilds editorial from scratch.

The fix: add a **post-editorial checkpoint** — a resumable boundary after the spec
and before the build sub-run — so the editorial output is persisted and **re-used on
resume** instead of re-computed. It reuses the engine's existing, battle-tested
checkpoint + resume machinery (the flow already has two checkpoints); the work is
**placement and wiring**, not new execution logic.

---

## 1. Current state (grounded in `src/`)

`src/flows/explainer/schematic.json` step sequence (id · stage · execution · block):

```
intake-step          · frame   · compose   · frame
digest-step          · analyze · compose   · diagnose
ideas-step           · plan    · compose   · plan
tournament-step      · plan    · fanout    · plan
hardening-step       · plan    · relay     · plan
pick-checkpoint-step · plan    · checkpoint· human-decision   (PICK — operator picks a concept)
spec-step            · plan    · compose   · plan             (← editorial ends here)
build-step           · act     · sub-run   · goal-child-run   (← delegated child build begins)
verify-step          · verify  · verification · run-verification
signoff-checkpoint-step · review · checkpoint · human-decision (SIGN-OFF)
close-step           · close   · compose   · close-with-evidence
```

- **Editorial output to protect:** everything through `spec-step` (digest → ideate →
  tournament → harden → PICK → spec). The `spec` is the synthesis that feeds the
  build.
- **Checkpoint shape to mirror:** `pick-checkpoint-step` and `signoff-checkpoint-step`
  are `human-decision` blocks, `execution.kind: 'checkpoint'`, with a `policy`
  (prompt, choices, `safe_default_choice`, `auto_resolution`), `writes`
  (checkpoint request/response paths), a `check.allow` route set, and `routes`. The
  PICK checkpoint already sits in the plan stage, so a second plan-stage checkpoint
  after `spec` is structurally legal.
- **How a checkpoint persists + resumes:** a checkpoint returns `waiting_checkpoint`,
  writes a request file, and pauses the run (`checkpoint_waiting`). On resume,
  `resumeCompiledFlowResult` (`src/runtime/run/checkpoint-resume.ts`) finds the latest
  unresolved checkpoint in the trace, re-projects + hash-checks the boundary against
  the current flow, validates the selection, and **re-enters at the checkpoint** —
  the steps *before* it are not recomputed (their outputs are already in the run
  folder / trace). That is exactly the preservation mechanism the P0 wants.
- **How a child-build failure propagates:** `src/runtime/executors/sub-run.ts` reads
  the child `RunResult`; if the child closed non-complete and the step has a `stop`
  route, it takes `stop` (it does not crash). The recovery-binding fix (PR #105)
  threads `recoveryRouteBindings` on resume so a failed child **degrades onto its
  recovery route** instead of hard-aborting the parent.

---

## 2. The change (scope)

### Primary — insert a post-editorial checkpoint between `spec-step` and `build-step`

A new `human-decision` / `checkpoint` step in the **plan** stage, after `spec-step`,
before `build-step`. Mirror the existing checkpoints' shape:

- **Prompt:** the editorial work is complete; the spec captures the concept choice
  and house-style direction; build will now construct the site. Confirm to proceed,
  or send back for spec revision.
- **Choices / routes:** `continue → build-step`, `revise → spec-step` (loop back to
  re-spec without re-running the tournament), `stop → @stop`. `safe_default_choice:
  continue`, with an `auto_resolution` so an autonomous run proceeds without a human
  (the explainer runs autonomously in eval).
- **Output contract:** a new explainer-specific actual (e.g.
  `explainer.build-authorization@v1`) so it is the single producer of its own output
  and does not collide with `pick-checkpoint-step`'s output.
- **Writes:** `reports/checkpoints/build-gate-request.json` /
  `…-response.json` (mirror the existing two).

**Why this preserves editorial output:** the checkpoint is a durable
`checkpoint_waiting` boundary. If the build later fails (or the run is killed),
**resume re-enters at the build-gate checkpoint** — digest/ideate/tournament/harden/
PICK/spec are already recorded and are *not* re-run. The expensive editorial output
is preserved by construction.

### Secondary (design decision — confirm before building) — does the checkpoint alone deliver resume-after-build-failure, or is a recovery binding on `build-step` also needed?

A checkpoint makes the *resume entry point* durable. But to get "build failed →
resume reuses editorial," the build failure must land the run in a state that
**resumes at (or after) the build gate**, not one that re-enters editorial. Two
hypotheses, to be probed before locking:

1. **Checkpoint-only is enough.** The post-editorial checkpoint is the latest
   unresolved/!resolved boundary; on resume the engine re-enters there and re-runs
   only `build-step` onward. If the trace + resume logic already behave this way once
   the checkpoint exists, no recovery binding is needed.
2. **Checkpoint + a recovery binding on `build-step`'s `stop` route** is needed, so a
   non-complete child degrades onto a recovery route that returns to the build gate
   (revise/retry) rather than aborting. This mirrors the recovery-binding fix
   (PR #105) and the recovery-route machinery
   (`tests/runner/recovery-route.test.ts`, `recovery-binding-verdict.test.ts`).

**Probe first** (per AGENTS.md "run a small probe before locking the plan"): with the
checkpoint inserted, drive a run where the child build returns non-complete, then
resume, and observe whether editorial is preserved. Build the minimum that achieves
preservation — checkpoint-only if it suffices, checkpoint + recovery binding if not.
**STOP-AND-REPORT** the probe result and the chosen scope before completing.

### Note on the faked editorial steps (P2, not in scope)
`digest`/`ideate` are currently faked compose steps (the separate P2). That does
**not** block this checkpoint: the boundary sits downstream of them, so whatever they
produce (real or placeholder) is what gets preserved. When P2 promotes them to real
model-backed blocks, the checkpoint is unchanged.

---

## 3. Rails / out of scope

- **Reuse the existing checkpoint + resume machinery.** Do **not** invent new
  checkpoint execution or resume logic — the P0 is *placement + wiring*. Mirror
  `pick-checkpoint-step` / `signoff-checkpoint-step` and the resume path.
- **Autonomous-safe.** The explainer runs autonomously in eval; the new checkpoint
  must auto-resolve (safe default `continue`) so it does not deadlock a headless run.
- **Catalog + schema gates must pass.** The new step must satisfy the fail-closed
  gates: single-producer-per-contract (unique output), reachability from `starts_at`
  (it is — `spec-step` routes `continue` to it), the **strict** canonical stage path
  (`stage_path_policy.mode: 'strict'` — the checkpoint is a plan-stage step after
  spec, before the act/build, which preserves the path), and `primary_result` still
  bound at `close-step`. The new actual contract must be registered
  (`src/flows/explainer/reports.ts` / `data.ts`) or aliased to a registered generic.
- **Do NOT touch the P2 fakes, the P1 scaffold gap, or the P3 URL leak.** Those are
  separate findings; this brief is the post-editorial-checkpoint P0 only.
- **Regenerate explainer surfaces** if its bytes move (`npm run check-flow-drift`);
  no *other* flow may drift.

## 4. Verification (failing-test-first)

- Add an explainer checkpoint/resume test (the flow has **no dedicated test today** —
  research confirmed) mirroring `tests/runtime/checkpoint-resume.test.ts` and
  `tests/runner/build-checkpoint-exec.test.ts`: run intake → … → spec, **pause at the
  new build-gate checkpoint**, resume with `continue`, and assert the run proceeds to
  `build-step` **without re-running** the editorial steps (assert their trace entries
  are not re-emitted / their outputs are reused).
- Add the **preservation** test that motivates the P0: drive a build-step
  non-complete outcome, resume, and assert editorial output is **reused, not
  recomputed** (this is the test that proves the ~$6 is saved). If the probe shows a
  recovery binding is needed, the test covers that route.
- Contract/catalog tests: the new step compiles, passes
  `collectSchematicCatalogIssues` and the `FlowSchematic` superRefine, binds a unique
  output, and keeps `primary_result` bound. Add/extend a build-gate boundary test
  mirroring `tests/contracts/checkpoint-boundary-schema.test.ts`.
- Full `npm run verify` green; focused proof per AGENTS.md (flow-authoring change →
  `flow-facts` + catalog completeness + `check-flow-drift`; resume-path coverage →
  the checkpoint-resume + recovery tests).

## 5. Definition of done / safe-to-merge

- `npm run verify` green (full canonical gate).
- The post-editorial checkpoint exists between `spec-step` and `build-step`, mirrors
  the existing checkpoints, auto-resolves for autonomous runs, and compiles clean
  through the fail-closed gates.
- **Preservation proven by test:** after the checkpoint, a build failure + resume
  re-enters at the build gate and **reuses** the editorial output instead of
  recomputing it. The probe decision (checkpoint-only vs + recovery binding) is
  recorded, and the minimum that achieves preservation is what shipped.
- The two existing checkpoints (PICK, SIGN-OFF) and the rest of the explainer are
  behaviorally unchanged except for the inserted boundary; `check-flow-drift` clean
  (only the explainer's own surfaces moved, on purpose).
- No change to the P2 fakes / P1 scaffold / P3 URL findings.

## 6. Open decision (STOP-AND-REPORT)

The §2 secondary decision: **checkpoint-only vs checkpoint + recovery binding on
`build-step`.** Probe it before locking, and report the result + chosen scope before
finishing. Do not over-build (a recovery corridor where a checkpoint suffices) and do
not under-build (a checkpoint that does not actually preserve editorial on a build
failure).

---

## Hand-off prompt for Claude Code

Copy-paste the block below into Claude Code (run from the repo root,
`/Users/petepetrash/Code/circuit`).

```text
You are implementing a brief in the Circuit repo. Work from the repo root and stay
inside it.

1. Read docs/ideas/explainer-post-editorial-checkpoint-brief.md in full, then
   AGENTS.md, paper-to-site-2nd-run-findings.md, and the grounding files:
   src/flows/explainer/schematic.json (the step sequence + the two existing
   checkpoints), src/flows/explainer/{data.ts,reports.ts,contract.md},
   src/runtime/run/checkpoint-resume.ts (resume re-entry), and
   src/runtime/executors/sub-run.ts (child-build failure propagation). Follow the
   repo rails: read before write, FAILING-TEST-FIRST, plain English with the
   operator, and enumerate 2-3 hypotheses before acting (the brief's §2 secondary
   decision is exactly such a case).

2. Create branch feat/explainer-post-editorial-checkpoint.

3. PROBE BEFORE LOCKING (AGENTS.md rule): insert the post-editorial checkpoint
   between spec-step and build-step (mirror pick-checkpoint-step / signoff-checkpoint-step;
   plan stage; output a unique contract like explainer.build-authorization@v1; routes
   continue→build-step, revise→spec-step, stop→@stop; auto-resolve safe-default
   continue for autonomous runs). Then drive a run where the child build returns
   non-complete and resume, to determine whether checkpoint-ONLY preserves editorial
   or whether a recovery binding on build-step's stop route is also required.
   STOP-AND-REPORT the probe result and your chosen scope (checkpoint-only vs
   checkpoint + recovery binding) before completing the implementation.

4. Implement the minimum that achieves preservation. Write the failing tests FIRST
   (§4): a checkpoint/resume test (explainer has none today) asserting editorial is
   NOT re-run on resume, and the preservation test asserting a build failure + resume
   reuses editorial output. Register the new contract in reports.ts/data.ts; keep
   primary_result bound; pass the catalog + FlowSchematic gates.

5. Honor the rails in §3: reuse existing checkpoint/resume machinery (no new
   execution logic); keep it autonomous-safe; do NOT touch the P2 fakes / P1 scaffold
   / P3 URL findings; regenerate explainer surfaces if bytes move and confirm
   check-flow-drift is clean with no OTHER flow drifting.

6. Run `npm run verify` (full) — it must be green.

Definition of "safe enough to merge" (all must hold):
  - npm run verify is green (full canonical gate).
  - The checkpoint exists between spec-step and build-step, compiles clean through the
    fail-closed gates (single-producer, reachability, strict stage path,
    primary_result bound), and auto-resolves for autonomous runs.
  - PRESERVATION proven by a passing test: after the checkpoint, a build failure +
    resume re-enters at the build gate and reuses editorial output (not recomputed).
    The probe decision is recorded in the brief's done-criteria / a short note.
  - The two existing checkpoints and the rest of the explainer are unchanged except
    the inserted boundary; check-flow-drift clean (only explainer surfaces moved).
  - No change to the P2/P1/P3 findings.

Merge handling: when the above hold, commit with a conventional message (e.g.
"feat(explainer): post-editorial checkpoint preserves editorial across a build
failure"). If a GitHub remote + gh CLI are available and the repo uses PRs (it does —
history is "Merge pull request #NNN from petekp/..."), open a PR, wait for CI green,
then merge. Otherwise no-ff merge into main locally. Then update
docs/ideas/north-star-status.md (§5 — mark the post-editorial-checkpoint P0 closed,
and the §7 "Next" item), and report: branch, commits, verify result, the probe
decision (checkpoint-only vs + recovery binding), files changed, and any blocker.

If the §6 open decision is ambiguous after probing, or any safety criterion fails,
STOP and report instead of merging — do not over-build a recovery corridor where a
checkpoint suffices, nor ship a checkpoint that does not actually preserve editorial.
```
