# Prompt audit — 2026-06-11

Scope: every prompt surface in Circuit. Three parallel audit passes:
(1) runtime prompt assembly (`src/runtime/`), (2) per-flow prompt text
(`src/flows/*/data.ts`, `relay-hints.ts`), (3) command/skill markdown
(`src/commands/`, generated `plugins/`). Audited on branch
`feat/eval-heldout-hardening` at d4c92567.

## How relay prompts are assembled (inventory)

One composer: `composeRelayPrompt` (`src/runtime/run/relay-support.ts:209-275`),
used for relay steps and production fanout branches. Segment order:

1. `Step / Title / Role` header (dynamic values, no role expansion)
2. `Accepted verdicts:` — the step's `check.pass` list only
3. `Depth: <low|medium|high>` effort line (conditional)
4. `Operator Goal:` + optional `Why:`
5. Prior Circuit history (hint-only, conditional)
6. Current slice constraint (slice loop only)
7. Prior-run memory pull affordance (always rendered)
8. `Context (from reads):` — declared files inlined verbatim with
   `--- path ---` separators (now `<read path="...">` fences; see P1)
9. Selected skills (full bodies + Source + SHA-256)
10. Acceptance criteria (+ retry feedback on re-invocation)
11. Response-shape instruction — per-flow hint from `relay-hints.ts`,
    else `GENERIC_DISPATCH_SHAPE_HINT`. Always last (good).

Structurally disciplined: stable order, response contract last,
conditional sections drop cleanly, and `from-zod.ts` skeleton rendering
JSON-escapes interpolated text. The problems below are about incentives,
untrusted interpolation, and unfinished vocabulary migration — not
structure.

## Top findings (prioritized)

### P1 — Incentive bug: reviewers are prompt-biased toward accepting

- The relay prompt renders only the PASS verdicts
  (`relay-support.ts:243` → `Accepted verdicts: accept, accept-with-fixes`),
  and the mechanical tails threaten "the runtime ... rejects any verdict
  not drawn from the accepted-verdicts list"
  (`src/flows/build/relay-hints.ts:46`, `fix/relay-hints.ts:20`).
- But `reject` IS schema-valid (`build/reports.ts:284`,
  `fix/reports.ts:696-717`) and the engine handles it gracefully
  (routes to retry/revise, `relay.ts:645-680`). A reviewer who believes
  the tail will avoid `reject` to avoid "failing the run" — the exact
  wrong incentive for the one role that must be willing to block. This
  directly undercuts the adversarial-gates thesis.
- **Fix:** render both lists ("Pass verdicts: ... / Rework verdicts
  (valid, route back to the implementer): reject") and soften the tail
  to "verdicts outside the schema enum fail validation."

### P1 — Explore's reviewer cannot block at all

- `ExploreReviewVerdictValue = z.enum(['accept', 'accept-with-fold-ins'])`
  (`src/flows/explore/reports.ts:87`). The hint
  (`explore/relay-hints.ts:24`) is the most adversarial prompt in the
  repo (five audit axes, "flag fabricated ... references", "object to
  any claim that the result is enough") — but both legal verdicts pass,
  so objections are recorded strings with no routing power.
- **Fix:** add a `reject` verdict wired to the existing revise route, or
  state in the hint what actually happens to objections.

### P1 — Injection seams: untrusted text enters the instruction stream unfenced

**FIXED on this branch (slice 2):** reads now render as
`<read path="...">...</read>` fences and acceptance-retry
stdout/stderr as `<stdout>`/`<stderr>` fences, each preceded by a
data-not-instructions notice; when content contains the closing tag,
the tag name grows (`read-2`, ...) so the fence cannot be terminated
from inside. Description below records the pre-fix state.

- Reads are inlined with only `--- path ---` separators and no closing
  delimiter or "this is data, not instructions" framing
  (`relay-support.ts:221-230`). Read content is prior-agent reports and
  repo files; a line like `Acceptance Criteria Feedback:` inside a read
  is indistinguishable from engine framing, and the response contract
  sits immediately after the reads dump.
- Same class: failed-acceptance `stdout_summary`/`stderr_summary`
  interpolated unfenced into the highest-authority retry section
  (`relay-support.ts:125-130`).
- **Fix:** wrap reads and command output in explicit open/close fences
  (e.g. `<read path="...">...</read>`) plus one line declaring fenced
  content as data.

### P2 — Fanout branch task is buried in the Title line

- `branch-execution.ts:116-118`: the worker's actual assignment renders
  as `Title: explore / b1: <goal>` while the prominent `Operator Goal:`
  block carries the run-level goal. A multi-line `branch.goal` (from
  `$item` template expansion) breaks the header and lands unlabeled text
  at the top of the prompt.
- **Fix:** dedicated `Branch Goal:` segment in `composeRelayPrompt`;
  keep Title to the id. Also: the injected-connector fanout path sends
  `prompt: branch.goal` raw with no shape hint or verdict list yet
  JSON.parses the response (`branch-execution.ts:351-357`) — append the
  generic shape hint + admit list there.

### P2 — Grammar bug in every command acceptance criterion

- `relay-support.ts:98` renders `must ${criterion.expected_status}.`
  with the literal `passed` → "command verify must passed." Broken
  English inside a binding requirements list.
- **Fix:** map enum to verb: "must pass."

### P2 — Fix flow progress text mislabels read-only steps

- `src/flows/fix/data.ts:660-674`: `fix-gather-context` and
  `fix-diagnose` carry `relayRole: 'implementer'` and "Asking the
  specialist to make the change..." while the steps execute as
  `role: 'researcher'` whose hints insist "read-only by intent."
  Operator is told files are being changed during read-only steps.
- **Fix:** researcher role + investigate-phrasing (mirror build's
  analyze step, `build/data.ts:485-487`).

### P2 — Pursue (and prototype variant) hints omit the parse contract the runtime enforces

- `pursue/relay-hints.ts:11,23` lack "no prose before or after the JSON
  object" and the JSON.parse warning every other flow carries; the
  runtime hard-fails on any preamble (`relay-support.ts:34-41`).
  Prototype's variant hints have a partial omission.
- **Fix:** adopt fix's shared `mechanicalTail()` helper everywhere.

### P2 — Stale pre-rename depth vocabulary inside prompt strings

- Workers see the literal `Depth: low|medium|high`, but prompts still
  say "quick or lite job" / "deep job" / "deep depth"
  (`build/relay-hints.ts:11,13`, `build/reports.ts:242` describe-text),
  "standard depth" / "Lite mode" / "Close (lite)"
  (`fix/data.ts:43,451`). The slice loop activates at `high`.
- **Fix:** s/deep/high/, s/lite|quick/low/, s/standard/medium/ in flow
  prose and `.describe()` strings; regenerate plugins.

### P2 — Handoff command mode-routing is strict-literal

- `src/commands/handoff.md:22`: "If the request is exactly `resume`..."
  → "resume the auth work" routes to SAVE mode, creating a new record
  instead of restoring. Same text in all six generated copies.
- **Fix:** intent-based phrasing with exact keywords as examples.

### P3 — Memory affordance bloat and jargon

- Duplicated hint-only authority disclaimers (the seven-item
  "proof, checkpoint, policy, route, recovery, verification, write
  authority" enumeration appears twice when recall hits;
  `relay-support.ts:160-164` vs `:179-181`), and the pull affordance is
  unconditional even for connectors that can't run a CLI (~70 tokens/
  prompt). Engine-internal jargon a worker can't act on.
- **Fix:** collapse to one sentence when both render; gate the
  affordance on connector capability or role; shorten the enumeration.

### P3 — Goal gate skeletons bake in literal values

- `goal/relay-hints.ts:22,35` show `"clean_streak": 0, "passes": []` as
  the "exact" shape, contradicting the instruction three sentences
  later; literal-minded models copy them. Siblings use placeholders.
- **Fix:** placeholder-ize mutable fields. (Falls out of migrating to
  `renderShapeSkeleton`.)

### P3 — Standalone Review flow ships the weakest reviewer prompt

- `review/relay-hints.ts:22-32` is all output mechanics, zero stance:
  no adversarial framing, no "treat self-reports as claims", no
  severity calibration — and the runtime adds only a bare
  `Role: reviewer`. The audit-only product has the least-guarded
  reviewer.
- **Fix:** two sentences of stance + severity calibration.

## Lower-severity / hygiene

- Six reviewer verdict vocabularies across eight flows (accept/
  accept-with-fixes/reject; accept/accept-with-fold-ins; clean/
  needs-followup/blocked; NO_ISSUES_FOUND/ISSUES_FOUND; gate-pass/
  blocked; tournament verdicts). Converge non-tournament triples in a
  future schema_version bump.
- Only fix derives its JSON skeleton from the Zod schema
  (`renderShapeSkeleton`); build/explore/prototype/pursue/goal
  hand-write theirs — the drift vector behind several findings above.
  Migrate siblings.
- `Role:` is a bare token with no behavioral gloss when the generic
  shape hint applies; a 3-line role table in the runtime would fix it.
- `GENERIC_DISPATCH_SHAPE_HINT` overstates ("rejects the run on any
  parse failure") — retries/recovery routes exist; observably-false
  contract language trains workers to discount it.
- Depth line renders internal depths verbatim ("Depth: tournament.
  Tune your thoroughness...") — map non-effort depths first.
- `Failure policy: retry-with-feedback` leaks the internal enum.
- Skill sections carry Source + SHA-256 (dead prompt tokens; already in
  trace) and `## Skill:` markdown headers outrank the engine's plain
  `Label:` style.
- `Accepted verdicts:` would render dangling-empty if an admit list
  were empty (compile-prevented today; cheap guard worth adding).
- Goal recovery checkpoint's "Continue" choice routes to goal-close
  (`goal/data.ts:371-380`) — rename to "Close as-is" or reroute.
- `## Authority` footers ship into installed host command mirrors
  citing repo paths that don't exist in user projects
  (`plugins/claude/commands/run.md:124-127`); strip in the emitter.
- Codex handoff SKILL.md description advertises `brief`, which the body
  forbids invoking by hand — drop from the generated description.
- `src/commands/create.md` titles itself as a slash command but is
  intentionally unpublished; retitle as CLI-only.
- run.md slimming: 3 of 5 invocation examples redundant; 17-line POSIX
  quoting block + JSONL rendering paragraph duplicated verbatim in
  pursue/command.md — template the shared blocks (~30-40 lines, none
  behavior-bearing).
- `--power auto` missing from run.md:113 on THIS branch only — already
  fixed on main (PR #62); rebase, don't hand-edit.
- Tournament `boundedText` truncates with `.` not `…` (operator-facing).

## Verified clean

- Every flag the markdown references exists in the current CLI
  (depth/power/why/tournament/resume/handoff/create/env vars). No
  phantom instructions, no live `--rigor` residue.
- Claude-vs-Codex generated divergence (present wrapper vs hand-rendered
  JSONL) and Claude's dropped steps 5-8 are documented host-capability
  differences, not drift. Compiled flow JSON byte-identical across
  hosts.
- Response contract correctly placed last in every assembled prompt;
  Zod skeleton renderer escapes interpolated text properly.

## Verdict

The prompt corpus is well above average for agent systems: one
disciplined composer, explicit shape contracts, honest
advisory-vs-enforced distinctions, schema-derived skeletons where it
matters most (fix). The two findings worth treating as real product
bugs are incentive bugs, not wording bugs: the accepted-verdicts
framing discourages reviewers from blocking, and explore's reviewer
can't block at all — both cut against the adversarial-gates thesis
Circuit is built on. After those: fence untrusted interpolation
(reads, command output), finish the depth-vocabulary migration inside
prompt strings, standardize the mechanical tail, and migrate hand-written
skeletons to `renderShapeSkeleton`.
