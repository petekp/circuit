# Modern Engineering Practices: Circuit Proposals

Status: proposal, 2026-06-04. Not current shipped behavior unless a section says
otherwise.

Source prompt: compare Circuit with Christoph Nakazawa's "Modern Engineering
Values" workflow and write detailed proposals for the four practices that fell
out of that comparison:

3. Changed-file feedback.
4. Codiff-like close output.
5. Project concurrency guard.
6. Fast iteration versus final proof.

The blog post's relevant claims are simple: agent speed depends on strong
guardrails, fast feedback, tools that operate on changed files, repo-local
context, and human review at the end. The post also says the author is
ineffective at running multiple agent sessions in one project, and uses Codiff
to generate a walkthrough of uncommitted changes before shipping:
https://cpojer.net/posts/modern-engineering-values.

Circuit already shares the underlying posture. Run records a flow, steps,
checks, trace, reports, evidence, and post-run outputs. Fix already proves a
regression before editing, verifies after editing, computes the actual change
set, reviews, and closes with evidence. The proposals below are about making
that discipline faster and more visible, not making Circuit more free-form.

## Current Circuit Anchors

- Run is already the front door that chooses a flow, loads config and policy,
  opens a run folder, and hands a compiled graph to the runtime
  (`docs/architecture/run-process.md`).
- Relay selection already happens per relay step, so skill, model, effort, and
  connector decisions can be made at the last responsible moment
  (`docs/architecture/run-process.md`, "Relay-Step Decisions").
- Skill Hooks are the natural home for project-owned feedback. On the current
  `feat/skill-hooks-dispatch` branch, edit-file hook support is in flight:
  `before:edit-file` can read Build's predicted file extensions, and
  `after:edit-file` can read Fix's runtime-computed change set
  (`docs/ideas/skill-hooks-dispatch-spec.md`,
  `src/skill-hooks/surface-sources.ts`).
- Fix has the strongest actual touched-file proof today:
  `fix.change-set@v1.observed` is computed from git state and compared against
  the implementer's declared `changed_files` (`src/flows/fix/reports.ts`).
- Build already carries predicted file extensions before act and declared
  changed files after act (`src/flows/build/reports.ts`,
  `src/flows/build/contract.md`).
- Post-run output already writes operator summary, run-envelope shadow, process
  evidence, and run envelope in a fixed non-fatal sequence
  (`src/cli/post-run-artifacts.ts`).
- The current Claude present wrapper still prefers the compact run surface over
  the richer operator summary when both exist
  (`plugins/claude/scripts/present-rendering.ts`,
  `tests/unit/present-rendering.test.ts`).
- Writable relay fanout branches are already serialized because they share the
  parent checkout (`src/runtime/executors/fanout.ts`). That is a local runtime
  precedent for treating shared checkout writes as a real safety boundary.
- The repo already has a useful fast/final verification split:
  `npm run verify:fast` and `npm run verify` (`package.json`).

## Proposal 3: Changed-File Feedback

### User Workflow

The operator wants fast feedback that scales with the size of the change, not
the size of the repo. The agent should not have to remember "this touched React,
run the React checks" or "this touched schema, run the schema checks." Circuit
should notice the file surface deterministically and route the right feedback.

### V1 Scope

Build a deterministic edit-surface feedback layer on top of Skill Hooks:

- `before:edit-file:<filter>` fires from a predicted surface before an
  implementer relay runs.
- `after:edit-file:<filter>` fires from actual touched files after a step writes
  a trusted change report or a runtime-computed change-set report.
- The v1 filter stays deliberately small: extension suffixes such as `.ts`,
  `.tsx`, `.test.ts`, `.sql`, and a bare key for "any edit". Full path globs can
  come later when the table has enough real use.
- Policy lives in project or user config, not in flow steps:

```yaml
schema_version: 1

skill_hooks:
  policy:
    before:edit-file:.tsx:
      mode: auto
      skills:
        - react-useeffect
    after:edit-file:.tsx:
      mode: auto
      skills:
        - react-doctor
    after:edit-file:.sql:
      mode: ask
      skills:
        - migration-review
```

The important product behavior is plain: "when a step is about to edit or just
edited files like this, prepare the relevant skill or check."

### Implementation Seams

- Keep detection rule-based. Do not ask a model to infer file surfaces from the
  goal or prose.
- Use the existing `EDIT_FILE_SURFACE_SOURCES` table shape for report schema to
  surface extraction. It keeps flow names out of the dispatcher while still
  letting each flow own its report fields.
- Fill the missing after-report arm for relay self-reports. Build's
  `build.implementation@v1.changed_files`, Prototype's `created_files`, and
  Pursue's `actual_touch_set` are relay reports, so the graph runner has to pass
  the completed step's `writes.report` schema and path into the dispatcher.
- Treat Fix's `fix.change-set@v1.observed` as the highest-trust actual surface.
  It is runtime-computed against the baseline snapshot and catches undeclared
  extras, missing declared files, moved HEAD, and hidden index flags.
- Use the existing skill-loading and policy channels for actuation. If a hook
  injects skills into a relay, it must do so before relay guidance is planned so
  the prompt, trace guidance, and relay plan stay consistent.

### Risks

- Predicted surfaces can be wrong. That is acceptable if they are advisory and
  the after-step actual surface can correct them.
- Extension-only filters may underfit project conventions. That is still a good
  v1 because it is understandable and testable.
- Persistent injected skills can over-apply to later implementer relays. Keep the
  role gate: edit-oriented skills should not leak into researcher or reviewer
  relays.
- A missing skill under strict policy must not silently degrade. Strict missing
  skills should produce a decision packet or fail closed, not half-inject.

### Verification

- Unit-test filter matching for bare, suffix, multi-dot, and non-matching keys.
- Runtime-test Build `before:edit-file:.ts` from `build.plan@v1`.
- Runtime-test Fix `after:edit-file:.ts` from `fix.change-set@v1.observed`.
- Add a focused test for the relay self-report arm before extending to
  `build.implementation@v1.changed_files`.
- Prove no config means no `run.skill-hook` trace entries.
- Keep `tests/contracts/run-centered-v1-safety.test.ts` green so hook policy
  does not become a flow-step skill matrix.
- Finish with `npm run verify:fast` during iteration and `npm run verify` before
  claiming done.

## Proposal 4: Diff Walkthrough Close Output

### User Workflow

At the end of a run, the operator wants the review affordance Codiff provides:
what changed, why it changed, what proof ran, what deserves attention, and what
the next human review should look at. Circuit should not only say "Done"; it
should hand over a compact walkthrough of the Run's evidence.

### V1 Scope

Add a "change walkthrough" section to the readable close output. Prefer the
existing operator summary as the v1 home rather than creating a new top-level
output:

- The close output should include changed files or touched surfaces when the
  flow reports them.
- It should summarize the intended change, actual change, proof commands,
  review findings, missing evidence, and residual risks.
- It should link to the concrete reports and trace evidence that support each
  claim.
- It should stay one authored markdown surface across hosts. HTML can remain an
  enhancement where the flow already has an HTML projector.

The v1 goal is not a full visual diff app. It is a reliable Circuit-authored
walkthrough over the current Run folder.

### Implementation Seams

- Start in `src/shared/operator-summary-writer.ts` and
  `src/shared/operator-summary/projections.ts`. Those already own readable
  operator summaries.
- Reuse current process evidence and run-envelope links. They already provide
  stable report refs and surface status.
- Fix the delivery problem before adding lots of content. The current present
  helper prefers `run_surface_markdown_path` over
  `operator_summary_markdown_path`; if the richer walkthrough lives in operator
  summary, the host must actually show it.
- Do not make Codiff a dependency. The blog practice is the walkthrough, not the
  specific external tool. Circuit should own its stack and keep the output
  report-backed.
- Add a small flow-owned projection table for changed-file fields, similar in
  spirit to edit-file surface sources. This avoids making the summary writer
  parse arbitrary report bodies without a contract.

### Risks

- The close output can become verbose. Keep it outcome-shaped: what happened,
  proof, risks, review target.
- If the walkthrough uses live `git diff`, it can drift from the Run's recorded
  reports. Prefer report-backed facts first; bounded git diff stats can be a
  secondary clue.
- Host rendering changes can become two-host drift. Update the host-rendering
  contract and both generated host surfaces together.

### Verification

- Unit-test operator-summary projection for Build, Fix, Review, failed runs, and
  checkpoint-waiting runs.
- Test that the final rendered markdown path chooses the readable walkthrough
  when it exists, or that the compact run surface includes the walkthrough
  content after convergence.
- Golden-proof at least one Build or Fix run and read the produced markdown as
  the operator would.
- Run `npm run check-flow-drift` if generated host surfaces change.
- Finish with `npm run verify`.

## Proposal 5: Project Concurrency Guard

### User Workflow

The operator wants one active write-capable agent lane per project. They may work
on several projects at once, but two unsupervised write-capable runs in the same
checkout create review load, hidden conflicts, and false confidence.

### V1 Scope

Add a project-level active write guard at Run start:

- The guard is keyed by project root, not run folder.
- It applies to runs whose compiled graph can perform writes, for example a
  graph with an implementer relay or a write-capable custom step. Read-only
  Review and read-only Explore paths should be allowed by default.
- When another write-capable Run appears active, Circuit should warn and require
  an explicit operator choice before starting a new write-capable Run.
- In non-interactive mode, `ask` and `block` should fail clearly unless the
  operator passed an explicit override; `warn` may continue after recording the
  warning.
- Stale guards should be recoverable by inspecting the referenced run folder and
  clearing the guard when the trace is closed or invalid-stale.

Future config sketch:

```yaml
schema_version: 1

run:
  project_write_guard:
    mode: ask # ask | warn | block | off
    stale_after_minutes: 240
```

Suggested override:

```bash
./bin/circuit run build --goal '...' --allow-concurrent-write-run
```

### Implementation Seams

- Put the guard before runtime bootstrap, after the compiled flow is loaded and
  support checks have enough information to classify whether the run can write.
- Store the record under `.circuit/` in the project root, separate from
  `.circuit/runs/<run_id>`, for example `.circuit/active-write-run.json`.
- Record run id, flow id, project root, host kind, started_at, run folder,
  write-capable reason, and last observed trace status.
- Use existing run-status projection when checking whether a referenced run is
  still open. Do not invent a second trace reader.
- Keep it advisory at first. This is not a security lock; it is an operator
  safety rail.
- Reuse the fanout precedent: writable branches are serialized because they
  share the checkout. The same rule applies at project level.

### Risks

- PID locks are brittle across terminals, hosts, and crashed processes. Prefer
  run-folder trace status over process liveness.
- A too-strict default would slow users who intentionally use worktrees. The
  guard should be per project root, and worktree paths should naturally get
  distinct guards.
- Review-only runs should not be blocked by a write guard. Blocking read-only
  judgment would undermine the author's actual workflow.
- Starting the guard too late can miss concurrent runs; starting it too early
  can block harmless route failures. The pre-runtime, post-routing seam is the
  right first cut.

### Verification

- CLI tests: first write-capable run creates the guard; a second one with the
  same project root produces the expected warning/checkpoint/failure.
- Read-only Review can run while a write guard exists.
- Closed or stale run references are cleaned up or downgraded to a warning.
- Override flag is recorded in stdout and trace guidance.
- Worktree paths do not collide unless they share the same project root by
  explicit config.
- `npm run verify` before shipping.

## Proposal 6: Fast Iteration Versus Final Proof

### User Workflow

During implementation, the agent needs fast feedback. Before close, the
operator needs strong proof. Those should be separate named promises, not one
vague "run tests" instruction.

### V1 Scope

Make verification profiles first-class:

- `iteration` proof: fast, scoped, repeatable checks used after small changes or
  retries.
- `completion` proof: the final check set required before a Run can claim done.
- Each flow report should record which profile ran, what command list was used,
  and whether the run closed with iteration-only proof or completion proof.
- Project config can declare defaults, while flow reports can still carry
  task-specific commands.

Future config sketch:

```yaml
schema_version: 1

verification:
  profiles:
    iteration:
      commands:
        - id: verify-fast
          argv: ["npm", "run", "verify:fast"]
          timeout_ms: 120000
          max_output_bytes: 20000
    completion:
      commands:
        - id: verify
          argv: ["npm", "run", "verify"]
          timeout_ms: 300000
          max_output_bytes: 40000
```

For this repo, `verify:fast` and `verify` already provide the natural example.
For other repos, the same concept must be config-driven.

### Implementation Seams

- Extend the verification command/report model rather than hard-coding package
  scripts. The current `VerificationCommand` shape is already direct argv,
  bounded timeout, and bounded output.
- Build and Fix should use iteration proof after Act and retry steps, then
  require completion proof before Close when the run is claiming complete.
- `after:verification-failed` Skill Hooks should route remediation skills based
  on which profile failed.
- Close reports should name the highest proof profile passed. This prevents a
  Run from closing as "done" after only a narrow fast check unless the selected
  mode explicitly allows it.
- Lite mode can still choose a weaker completion policy, but that choice should
  be visible in the result.

### Risks

- Running full proof too often can destroy the speed benefit. Keep full proof at
  close unless the flow or operator asks for stronger iteration.
- A config-only final proof can be absent or stale. If completion proof is
  required and no command is available, the run should close needs-attention, not
  invent confidence.
- "Fast" must not mean "careless." It should mean smaller scope and lower
  latency, with recorded limits.
- This can overlap with Skill Hooks. Keep the boundary clean: verification
  profiles choose commands; Skill Hooks choose optional expertise or remediation
  around those command results.

### Verification

- Schema tests for verification profiles and direct-argv constraints.
- Runtime tests proving an iteration profile can fail and trigger retry without
  marking the run complete.
- Runtime tests proving completion requires the completion profile unless mode
  policy explicitly says otherwise.
- Close-output tests showing the final proof profile and any proof limits.
- For Circuit itself, focused proof can use `npm run verify:fast`; final proof
  remains `npm run verify`.

## Suggested Build Order

1. Finish the Skill Hooks edit-file path enough to make changed-file feedback
   useful. It is the strongest match to the blog's fast changed-file tooling
   point.
2. Productize verification profiles next. They give every flow a clear
   iteration/final proof vocabulary.
3. Improve close output once the evidence is richer. A walkthrough is valuable
   only if it can cite changed files and proof cleanly.
4. Add the project concurrency guard as a small run-start policy slice. It is
   useful, but it should not block the core feedback loop work.

## Open Questions

- Should a bare `after:edit-file` mean any changed file, or should v1 require an
  explicit suffix to avoid broad over-injection?
- Should the close walkthrough live only in operator summary, or should the run
  surface and operator summary converge into one readable output?
- What should non-interactive `ask` do for a project write guard: fail closed,
  warn and continue, or use a config default?
- Should completion proof be required for all write-capable Build/Fix runs, or
  should lite mode be allowed to close with scoped proof when the result is
  clearly marked?

## Non-Goals

- Do not add model-based hook detection.
- Do not make Codiff a required dependency.
- Do not allow parallel write-capable agents in one checkout by prompt promise.
- Do not hard-code this repo's `npm run verify:*` scripts as universal behavior.
