# react-doctor inspect / fix / re-inspect loop: spike learnings

> Spike, 2026-06-02. Branch `feat/react-doctor-fix-loop`. Goal: build the smallest
> honest version of the loop, test it, and learn what a larger build-out needs
> before committing to one. This note is the deliverable that records what we learned.

## What we set out to learn

Can Circuit run a skill (react-doctor) as an inspector after a step, hand its
findings to a fixer, and loop until the inspector is clean? And how much of that
needs new engine code, before we invest in a real build-out?

## The headline

The whole loop runs on machinery that already ships. No new engine code, no new
schema, no new trace kind, no engine flag. The demonstrator is a runtime test that
drives the real graph-runner across three paths with a stubbed connector, and
produces a real recorded trace. All three paths pass:

1. clean on first inspection completes with no fix,
2. issues then clean loops once through the fixer,
3. persistent issues stop at the safety cap.

## What the existing machinery carried, unchanged

1. **Skill as inspector.** A relay step with role `reviewer` plus a step-level
   skill selection injects react-doctor's body into the inspector's prompt. Proven
   by the `skills.loaded` trace entry on the inspect step.
2. **Verdict routing.** Putting only `NO_ISSUES_FOUND` in the step's `check.pass`
   makes `ISSUES_FOUND` a check failure, which is exactly the "issues, go fix"
   branch. No custom routing was written.
3. **The loop.** A `retry` route pointing at a different step auto-derives a
   `narrow_scope` recovery binding (the work-contract projection does this) whose
   allowed causes include `failed_check`. The recovery corridor then lets the fixer
   re-enter the inspector. The loop is real and replayable.
4. **The cap.** The fixer's default recovery `max_attempts` (2) stops a
   never-clean loop. The run aborts with "exhausted max_attempts". No new cap logic.
5. **Findings carrier.** The inspector writes its result (the findings) to a file.
   The fixer lists that path in `reads`, and `composeRelayPrompt` inlines the file
   into the fixer's prompt. Findings reach the fixer with zero new plumbing. This is
   the same report-passing the `fix` flow already uses to hand a diagnosis to its act
   step (there it is declared a level up, as an `input` contract that the compiler
   turns into a `reads` entry; same mechanism).

## The genuinely new pieces, and their real cost

Both turned out to be authoring, not engineering:

- **Skill as inspector:** cost is picking the skill and putting it on the step
  (`selection.skills`). Zero code.
- **Findings carrier:** cost is one `reads` entry pointing at the inspector's
  result path. Zero code.

So the "build" for a real version is a flow definition, not engine work.

## A guard caveat, stated plainly

The inspector injects react-doctor through `step.selection.skills` (per-step skill
pinning). The earlier design work flags this exact channel as a known soft spot: the
safety ratchet that enforces the no-binding-matrix rule guards `step.skill_moments`,
not `step.selection.skills`, and is a source-text grep blind to the runtime
`resolvedSelection.skills` it resolves to
(`docs/ideas/skill-moments-alternatives-v1.md:679-685, 1004-1010`). So per-step skill
pinning is held in check by authoring discipline, not by the schema or the ratchet.
This spike does per-step pinning. That is fine for a demonstrator, but a real
build-out must honor the no-binding-matrix intent by design and not assume the green
ratchet covers this channel, because it does not.

## What surprised me

- I budgeted for a new trace kind, a new cross-step carrier, and an engine flag
  (the original Skill Moments framing assumed all three). None were needed.
- The recovery corridor, which I expected to be the hard part, already supports a
  two-step inspect / fix loop once you make the inspector the corridor origin.
- The unlocking insight is small: "issues found" maps cleanly onto "check failed".
  A review verdict routes through the same primitive as any check result
  (`result_verdict`), so an LLM review can drive the same recovery loop a failing
  check would. To be precise: there is no deterministic command-check kind here;
  `result_verdict` is specifically the relay/sub-run verdict channel. The check
  definition declares its producer (`source.kind: relay_result`), and the
  `check.evaluated` trace entry records the `result_verdict` check kind, the outcome,
  and the failure reason (e.g. "connector declared verdict 'ISSUES_FOUND' which is not
  in check.pass"). So provenance stays honest. This is a routing-layer equivalence,
  not a claim that an LLM verdict is a deterministic test.

## What a larger build-out should KEEP

- The reuse posture. This loop is a flow, not an engine feature. Keep new engine
  surface out of it.
- The verdict-as-check-failure mapping for the issues-to-fix branch.
- The `reads` carrier for findings. No bespoke carrier is warranted.

## What a larger build-out must ADD or DECIDE (the honest gaps)

This spike proves the plumbing with a stubbed connector. It does not prove that a
real react-doctor produces good, structured findings. For a real version:

1. **Structured inspector output.** The demonstrator's inspect step has no
   registered report schema, so only the bare `verdict` is enforced and the stub
   volunteered the `findings[]`. A real inspector should reuse the review flow's
   verdict schema (`review.verdict@v1` / `ReviewRelayResult`, whose five required
   fields are verdict, findings, assessment, verification, and
   confidence_limitations) so a real worker is required to emit findings, not just a
   verdict. That is reuse, not new schema. Relatedly, the auto-derived `narrow_scope`
   recovery binding declares `required_refs` of `proof_assessment` and `runtime_diff`,
   but this loop carries findings via the `reads` file instead, and routing matches on
   the failure cause only (it does not enforce those refs). So the binding's declared
   proof contract is nominal here; a real version should furnish those refs or pick a
   binding whose contract matches what the loop actually carries.
2. **react-doctor must speak the verdict shape.** react-doctor today reviews React
   quality; it does not emit `NO_ISSUES_FOUND` / `ISSUES_FOUND` plus findings. Either
   the reviewer shape-hint instructs the shape (it already exists for the review
   flow) or react-doctor's body gains a short "emit this verdict" preamble. Decide
   which.
3. **Topology ordering.** The demonstrator orders steps produce, inspect, fix, with
   the inspector as the corridor origin, so the first inspection happens before any
   fix. Keep that ordering. A fixer-first ordering would need a richer corridor and
   buys nothing.
4. **Promote to a catalog flow.** The demonstrator is a test fixture. A real version
   is a registered flow (data, reports, writers, relay-hints, catalog entry,
   emit-flows). That is mechanical authoring and is the bulk of the remaining work.
5. **The inject-vs-judge choice still stands.** This loop is the "inject findings
   into a fixer" actuator, the production-side answer. The judge-frame alternative
   (run the skill as an independent verifier and record its verdict as evidence) is a
   separate, heavier path we deliberately did not build here. The earlier design
   work flagged this as the strategic fork; this spike does not settle it.

## Evidence

- `docs/learnings/evidence/react-doctor-loop-trace.ndjson`: a real recorded run of
  the richest path (path 2: issues, then fix, then clean), generated with the
  committed test's exact run_id and react-doctor body so it is a faithful recording of
  that test's path-2 run. Key entries, in order: `skills.loaded` on inspect
  (react-doctor injected); `relay.completed` with verdict `ISSUES_FOUND` then
  `NO_ISSUES_FOUND`; `check.evaluated` `result_verdict` fail then pass;
  `step.completed` inspect/retry, fix/pass, inspect/pass; `run.closed` complete.
- `tests/runner/react-doctor-fix-loop.test.ts`: the three-path demonstrator that
  drives the real graph-runner. All three paths (clean-first, fix-then-clean,
  cap-reached) are proven by the test; the trace above captures path 2.

## One unrelated note

`npm run verify` is green on everything this change touches (check, lint, build,
test, flow-drift). It also reports a pre-existing plugin-runtime bundle drift
(`plugins/*/runtime/circuit.js`) that is independent of this change: the test lives
in `tests/` and the bundle derives from `src/`, the bundle is not dirty here, and
deps are identical. Worth a separate look on `main`.
