# Circuit codebase quality audit: opportunities for public release

Date: 2026-06-09 (overnight). Written by Claude at Pete's request while he
slept. Scope: the whole repo, judged on architecture soundness, cruft, agent
legibility, test suite quality, and release readiness. Deliverable is this
prioritized opportunities doc, not fixes. Nothing was modified.

Method: orientation pass (docs spine, metrics, prior audits), then nine
parallel subsystem audits (runtime engine, flows layer, schemas and contracts,
CLI and app layer, tests, docs, build and release pipeline, cruft, release
readiness), then a convergence pass where I re-verified every Critical and
High claim myself with direct reads and live probes. Tooling: grep sweeps,
knip 6.16.1, madge (16 file-level cycles), coverage run, live CLI invocations.

A sibling doc landed the same night from a separate session:
`docs/audits/2026-06-09-strategic-review.md` covers product strategy and
demand. This doc covers whether the house is well built. They meet in one
place: its "first mile" complaint and my Section 1 release blockers are the
same work. Both docs are untracked; keep, move, or delete freely.

How to read findings: each has Severity (Critical / High / Medium / Low),
Status (Confirmed / Likely / Needs follow-up), and the smallest credible next
action. Confirmed means I or an auditor saw the code, ran the command, or
reproduced the behavior. Refuted hypotheses are listed in Section 10 so future
sessions do not re-chase them. File references are clickable `path:line`.

---

## The one-paragraph verdict

The engineering culture here is genuinely strong: byte-exact generated
surfaces, ratchet tests guarding architecture decisions, zero `z.any`, zero
snapshot tests, three runtime dependencies, evidence-checked release proofs.
The 8-stage architecture revamp held. What remains is three kinds of debt.
First, the front door is broken in ways the verify suite cannot see: the
README advertises a CLI invocation that exits with an error, the help output
leaks internals, and the First Run doc pins a stale version. Second, a
handful of oversized or duplicated structures (handoff.ts at 2,932 lines, a
173-line file copied between two flows, dead routing metadata compiled into
every shipped flow) tax every agent session that touches them. Third, the
self-describing docs spine has drifted: the repository map is wrong at every
level and there are two competing glossaries. All of it is fixable in days,
not weeks, and the fix order below is sequenced so the public-facing risk
goes first.

## Top 10, ranked

1. Fix the advertised CLI front door that does not exist (1.1). Hours.
2. Ship the release-governance batch: SECURITY.md, GitHub Releases,
   CONTRIBUTING, repo topics, env-inheritance disclosure, stale tag,
   first-run version pins (1.2, 1.5, 1.6, 1.8). About a day.
3. CLI help and error pass: kill the `(outputHelp)` leaks, add command
   descriptions, friendly unknown-flow message (1.3, 1.4). Half a day.
4. Delete the dead `entry.signals` / `intent_prefixes` routing metadata
   end-to-end (3.1). Hours, high leverage.
5. Make the docs spine truthful: replace repository-map.md, govern
   CONTEXT.md, sync idea-catalog statuses (6.1, 6.2, 6.3). Half a day.
6. Decompose handoff.ts; extract the two run.ts seams (4.1, 4.2). A day.
7. Test-suite DX: move the 85-second drift test out of the default tiers,
   correct AGENTS.md's timing claim, seed shared test scaffolding (5.1,
   5.2). Half a day.
8. Decide apps/designer and the committed-bundle git-bloat policy (8.1,
   8.2). Hours.
9. Duplication batch: git-state.ts copy, report-schema-kit extension,
   writeOrCheck and sync-cache twins, step-entry predicate (3.3, 3.4, 7.2,
   2.2). A day.
10. Paper the conventions: schema versioning note, engineFlags correction,
    env-flag table, tests/README, generated-file markers (4.5, 9.x). A day,
    mostly prose.

Waves: items 1 to 3 before any public pointer goes out. Items 4 to 7 next;
they pay rent on every future agent session. Items 8 to 10 as consolidation.

---

## 1. Release blockers (public-facing surface)

### 1.1 The advertised CLI front door does not exist

Severity: Critical. Status: Confirmed (code read + README read + live probes).

README.md:85 tells a new user to run `./bin/circuit run --goal '<your task>'`.
README.md:100 says "Circuit's deterministic CLI router selects and records
the flow." The code says otherwise at src/cli/run.ts:319-323:

```ts
// Routing is model-only: the host or operator names the flow. There is no
// deterministic classifier to guess one from the goal text.
throw new Error('a flow name is required: pass one of build|fix|review|...');
```

The invocation exits nonzero with a missing-flow error. The same fiction
appears in docs/operator-guide.md:13 and the alpha.7 release notes (line 32).
The shipped plugin prose admits reality, so this is a doc-only fix at three
sites plus the release notes and one spec line. Nothing pins the phrase in
tests. This is the first command a CLI-path stranger will run, and it fails.

Action: change the three doc sites to `run <flow> --goal "<task>"`, correct
the release notes, and add a release check that greps public docs for the
routerless form.

### 1.2 First Run doc pins alpha.6 while alpha.7 is published

Severity: High. Status: Confirmed (docs/first-run.md:20,32).

The marketplace-install doctor command hard-codes
`.../circuit/0.1.0-alpha.6/scripts/circuit.ts`. A fresh install today gets
alpha.7, so the First Run doc's first real command fails with a path error.

Action: replace the literal version with a placeholder plus one line on how
to find it (`ls ~/.claude/plugins/cache/circuit/circuit/`), and add this file
to the release-cut checklist or the public-claims check so it cannot pin
again.

### 1.3 CLI help and bare invocation leak internals

Severity: High. Status: Confirmed (live probes tonight).

- `./bin/circuit` (bare) prints `error: (outputHelp)` and exits 2.
- `circuit history` / `runs` error envelopes embed the same `(outputHelp)`
  string inside versioned JSON.
- `--help` lists eight subcommands with zero descriptions
  (`run [args...]`, `resume [args...]`, ...).
- A rich `usage()` text exists at src/cli/circuit.ts:44-67 but is dead code:
  only a test consumes it. src/cli/commander-support.ts:32-40 handles a
  `helpDisplayed` code that commander does not emit on this path, and the
  friendly missing-command message at circuit.ts:156-158 is unreachable.
- src/cli/memory.ts:165-177 already contains the correct fix (it maps
  commander errors to clean text); it was never propagated to the shared
  helper.

Action: move the memory.ts mapping into a shared `commanderErrorMessage`,
wire the dead `usage()` into the real help path, and add one-line
descriptions per subcommand. Pin with a small CLI characterization test.

### 1.4 CLI silently requires cwd to be the checkout

Severity: High. Status: Confirmed.

Outside the repo, every run fails with
`flow fixture not found: .../generated/flows/review/circuit.json`: internal
"fixture" jargon, no remedy, and the `--flow-root` escape hatch is
undocumented. The plugin wrapper is immune (it passes its own root), so only
CLI-path users hit it. The only test coverage is a negative pin at
tests/runner/cli-router.test.ts:1049.

Action: detect the unknown-flow / missing-root case and print the valid flow
list plus a cwd / `--flow-root` hint; document the cwd requirement in the
README CLI section.

### 1.5 Codex "Start Here" is not walkable; the real install path is hidden

Severity: High. Status: Confirmed.

README's Codex section tells users to run `npm run plugins:refresh-local`,
which presumes an unstated clone plus `npm install`. Meanwhile a remote
one-liner exists and works: `codex plugin marketplace add petekp/circuit
--ref <tag>` (used by scripts/plugins/publish.ts:962 and recorded passing in
the alpha.6 release notes). The README never mentions it.

Action: rewrite the Codex section around the marketplace add command, with
refresh-local demoted to a "from this checkout" path.

### 1.6 Governance and disclosure gaps for a public repo

Severity: High. Status: Confirmed.

- No SECURITY.md, no CONTRIBUTING.md, no GitHub Releases (5 tags, 0
  releases), repo topics null, homepage empty.
- Connector subprocesses inherit the full parent environment
  (src/connectors/subprocess.ts:120, src/connectors/claude-code.ts:197), so
  secrets in the operator's env flow into every connector. The README's
  custom-connector paragraph says env is inherited but does not flag the
  secret implication.
- The plugin installs four lifecycle hooks (SessionStart, Stop, SessionEnd,
  PreCompact) that run in every repo and write `.circuit/continuity`; the
  README mentions hooks zero times, and plugins/claude/README.md:17
  under-describes them.
- `.circuit/` is never gitignored in user repos and no doc says to ignore it.

Action: add SECURITY.md (point at GitHub advisories), a 10-line
CONTRIBUTING, publish Releases from the existing notes, set topics and
homepage, add one Safety Notes sentence on env inheritance and three lines on
the ambient hooks, and write a `.circuit/.gitignore` sentinel (`*`) on store
creation. Skip CoC and issue templates for now; they are ceremony at this
stage.

### 1.7 Release proof claims are loosely bound and one is now false

Severity: Medium. Status: Confirmed.

The "Routed Build" proof's index.yaml records the routerless invocation that
1.1 shows is impossible, status `verified_current`, while its own
result.json says `routed_by: "explicit"`. scripts/release/checks.ts:187-285
validates that proof files exist, not that their recorded command matches the
capture.

Action: rename or retire the Routed Build scenario and add a cross-check
that the scenario command appears in the captured argv.

### 1.8 Small public-polish items

Severity: Low-Medium. Status: Confirmed.

- Stray `v0.2.0` git tag outranks the `circuit--v0.1.0-alpha.*` line
  (verified in `git tag -l`); delete before anyone sorts tags.
- plugins/codex plugin.json says license `UNLICENSED`; repo is MIT. Author
  fields drift between manifests.
- 6 tracked files carry 29 occurrences of `/Users/petepetrash` (surface-test
  skill SKILL.md:246 and references; docs/release/parity/original-circuit.yaml
  points at a pre-rewrite checkout). No personal-email hits anywhere.
- bin/circuit lacks the Node >=22.18 version gate the plugin wrapper has
  (about 4 lines), and silently runs stale dist if you forget to build.
- Release-cut sweep for public exposure: the personal usage-analytics doc
  (mined from ~4,600 of your transcripts), two unbannered strategy docs, and
  two orphan HTML artifacts in docs/architecture (circuit-map.html 26KB,
  system-analysis.html 49KB, zero references). docs/internal is gitignored,
  so the worst case is already handled.

---

## 2. Runtime engine

The engine audit validated the revamp's end state: corridor pattern is
clean, TraceStore is well designed, exhaustiveness is enforced via
`satisfies`, and fail-open vs fail-closed choices are commented at the site.
The findings below are the residue.

### 2.1 graph-runner.ts is a composition root plus three extractable clusters

Severity: High (legibility). Status: Confirmed.

At 1,167 lines, src/runtime/run/graph-runner.ts mixes the step loop with
three separable concerns: close policy (~130 lines, closeRun and
completeCloseProofGap at 507-538), trace forensics (~150 lines at 271-442),
and in-loop skill-hook dispatch (1048-1105).

Action: extract `run/run-close.ts` and `run/trace-evidence.ts`; leave the
loop. Mechanical, test-covered, shrinks the file agents must hold to reason
about any run.

### 2.2 Step-entry transition predicate exists twice

Severity: Medium. Status: Confirmed.

The attempt-budget / cycle-abort decision is implemented at
graph-runner.ts:788-806 and again at run-transition.ts:71-86. They agree
today; nothing forces them to keep agreeing.

Action: single `classifyStepEntryTransition` used by both call sites.

### 2.3 Adding a StepKind touches 8 surfaces; 2 are unguarded

Severity: Medium. Status: Confirmed.

Six surfaces are covered by ratchets or the compiler. The two that would
drift silently: a hand-written `z.enum` at
src/schemas/work-contract-projection.ts:38, and the runtime-index union
defeated by three `as unknown as` casts in
src/flows/registries/runtime-package-index.ts:61,72,74.

Action: derive the enum from the canonical StepKind list and remove the
casts (or pin them with a type-level test).

### 2.4 File-level import cycles are real and unratcheted

Severity: Medium. Status: Confirmed (madge, 16 cycles; spot-checked).

The architecture ratchet (tests/contracts/architecture-boundaries.test.ts:46,
`topLevelGraphCycles`) checks cycles between top-level directories and holds
at zero. madge at file granularity finds 16 cycles. One is type-only and
harmless (domain/step.ts <-> domain/route.ts, both `import type`, verified).
Ten of the sixteen run through one knot:
run-context -> capabilities -> relay / child-runner -> graph-runner. That
knot is the executors-call-back-into-the-runner shape, and it is exactly
where agents get lost tracing control flow.

Action: either break the knot (capabilities should not need graph-runner;
an interface seam at child-runner is the usual cut) or extend the ratchet to
file-level value-import cycles with today's list as the frozen allowlist so
it cannot grow.

### 2.5 Stalled half-migrations: ports and Result wrappers

Severity: Medium. Status: Confirmed.

run-values.ts ports were adopted by 1 of 6 executors; three dead port fields
are built on every run (run-boundary.ts:130-136). The `executeXResult`
wrappers get ceremonially unwrapped at every call site. The state is pinned
by tests/runtime/runtime-context-boundary.test.ts:84 ("without replacing
RunContext yet"), so this is a deliberate pause, but nothing records the
decision.

Action: decide (finish or revert) and write one paragraph in the runtime
README either way. Half-done migrations are the most expensive thing to hand
an agent, because both patterns look canonical.

### 2.6 The engine knows the string 'prototype'

Severity: Medium. Status: Confirmed.

src/runtime/run/connector-planning.ts:23-24 hard-codes a flow id inside the
engine, invisible to the import ratchet (it is a string, not an import).
This is the only place the catalog boundary is pierced by literal.

Action: move the behavior behind an engineFlags entry (the documented escape
hatch) and add a grep-based ratchet asserting no flow ids appear as string
literals under src/runtime/.

### 2.7 Relay prompt assembly duck-types Build internals

Severity: Medium. Status: Confirmed.

src/runtime/run/relay-support.ts:190-207 reaches into Build's slice shape
({id, intent, anticipated_file_extensions}) to render prompt text, and
composeRelayPrompt takes 10 positional parameters.

Action: let the flow package own the rendering (a relay-hints style
callback), and collapse the positional params into one options object.

### 2.8 Dormant vocabulary in the runtime schema surface

Severity: Medium. Status: Confirmed.

Two recovery kinds have no selector; 10 of 15 failure causes have zero
producers; a ~150-line superRefine validates combinations nothing can emit.
Dead vocabulary reads as live contract to an agent and inflates every
schema-reading session.

Action: delete the producer-less kinds and causes (pre-release is the cheap
window), or mark them reserved in one comment if they are intentional.

### 2.9 Small engine items

Severity: Low. Status: Confirmed.

- src/runtime/README.md lists a nonexistent connectors/ dir and omits
  domain/.
- AGENTS.md:114 says engineFlags currently holds one flag; there are three
  (bindsExecutionDepthToRelaySelection, bindsTerminalOutcomeToPrimaryResult,
  iteratesSliceLoop).
- projections/status.ts is test-only; either use it in the product or move
  it to tests.
- Injected test connector paths live inside production executors
  (relay.ts:747-789, branch-execution.ts:332-391); move behind the existing
  injection seam.

---

## 3. Flows layer

### 3.1 entry.signals and intent_prefixes are dead end-to-end

Severity: High. Status: Confirmed (independent grep tonight).

Every flow declares routing metadata (`signals.include/exclude`,
`intent_prefixes`); the schema requires it (flow-schematic.ts:491-501);
create.ts:194-198 generates it for custom flows; the compiler copies it into
every shipped circuit.json (compile-schematic-to-flow.ts:520,619). Nothing
reads it. The grep shows producers only: schema, compiler pass-through, 8
data.ts declarations, test fixtures. It contradicts the stated model
(types.ts:8-9 "Routing is model-only") and the run.ts comment in 1.1.

Action: delete the fields from schema, compiler, create.ts, all data.ts
files, and fixtures, then re-emit. No content pins it. This shrinks every
shipped flow surface and removes a standing lie about how routing works.

### 3.2 Doc contradictions an agent will follow off a cliff

Severity: Medium. Status: Confirmed.

- AGENTS.md:114: the engineFlags sentence is wrong (see 2.9).
- docs/flows/authoring-model.md documents a field named `uses`; the real
  field is `block`. Following the doc produces a schema-invalid schematic.
- src/flows/README.md:12 claims no flow ships a command.md; pursue does.
- Flow index.ts barrels are test-mandated, but the authoring guide reads as
  if they are optional.

Action: four one-line fixes. These are the highest trust-per-minute fixes in
the repo, because agents treat these files as ground truth.

### 3.3 git-state.ts is a 173-line byte-identical copy in two flows

Severity: Medium. Status: Confirmed.

fix/ and build/ each carry the same file, with an in-source comment already
promising the unification. A babysitter drift test exists solely to verify
the copies stay identical.

Action: move to src/shared/git-state/, delete the drift test (it exists only
to police the duplication), update both flows.

### 3.4 Schema duplication with an established fix pattern

Severity: Medium. Status: Confirmed.

- A ~35-line schema block is byte-identical between
  flows/registries/report-schemas.ts:26-66 and
  runtime/run-files/report-validator.ts:6-41. The name
  `TEST_FIXTURE_SCHEMAS` lies: 'fanout-aggregate@v1' in that set is the
  production default (fanout.ts:320).
- The severity enum appears 4 times, the finding shape 3-4 times,
  ContextSource twice, byte-identical.
- report-schema-kit.ts already exists as the precedent, and the
  referential-identity ratchet explicitly permits aliasing.

Action: move the shared block to src/schemas/ under an honest name; extend
report-schema-kit with severity/finding/ContextSource; leave the goal and
review variants alone (they differ on purpose).

### 3.5 Proven shape-hint renderer, unused by 6 of 7 flows

Severity: Medium. Status: Confirmed.

A from-zod JSON skeleton renderer exists, is used by fix, and is tested. The
other flows hand-write JSON skeletons in prompt text with zero drift checks,
plus 16 copies of "Do not wrap the JSON in Markdown code fences."

Action: adopt the renderer per flow opportunistically (it is a content
change, so re-emit and eyeball each diff); hoist the fences sentence into the
shared prompt scaffold.

### 3.6 Four blocks have zero schematic users

Severity: Medium. Status: Confirmed.

intake, route, queue, and risk-rollback-check appear in no schematic; intake
and route also have zero test exercisers. The orphan-blocks test header is
stale and uses the deprecated term "scalar".

Action: delete intake/route/queue or mark them reserved with a reason;
risk-rollback-check is already slated for refinement in the block audit (see
memory: 18 preserve / 1 refine). Fix the test header while there.

### 3.7 Flow-layer governance notes

Severity: Low-Medium. Status: Confirmed.

- iteratesSliceLoop is a 7-field control-flow DSL inside an engine flag.
  Fine today; add a contract assertion capping engineFlags key count so flag
  creep gets a speed bump.
- Deprecated vocabulary on shipped surfaces: prototype's "artifact" schema-id
  family, pursue command.md:122 "dispatch". Pre-release is the only cheap
  rename window for schema ids.
- Cosmetics: ghost router.ts allowlist entry; goal/data.ts S8/S9 codenames.
- Scale note for the elegance question: the smallest public flow (review) is
  ~1,176 lines across 11 files; prototype/data.ts is a ~718-line literal.
  The boilerplate is honest (no hidden magic), but a flow-authoring agent
  reads ~1,200 lines to learn the pattern. The from-zod renderer (3.5) and
  kit extension (3.4) are the two cheapest reducers.

---

## 4. CLI and app layer

### 4.1 handoff.ts is 2,932 lines holding seven domains

Severity: High. Status: Confirmed (wc tonight).

src/cli/handoff.ts contains: Codex hooks install (1010-1449), ambient
harvest (1865-2360, 2563-2793), save/resume/clear (1485-1863), brief
rendering (296-849), the SessionStart adapter (851-1008), and git probes
(2384-2511). These have near-zero coupling. Continuity is the only major
domain with no src/app service; everything else already moved.

Action: extract handoff-codex-hooks.ts, app/continuity/harvest.ts,
app/continuity/records.ts. The line map above is the cut list. This is the
single biggest legibility win in src/: today any continuity question forces
an agent through a 3k-line file.

### 4.2 run.ts has two clean extraction seams left

Severity: Medium. Status: Confirmed.

runExecutionCommand is ~520 lines (run.ts), containing an inline recovery
attempt-executor closure (1007-1106) and three inline stdout envelope
compositions (631-653, 903-940, 1123-1179).

Action: extract a recovery-attempt-runner and a composeRunStdoutEnvelope.

### 4.3 Operator summary screen-scrapes its own projections

Severity: Medium. Status: Confirmed.

src/app/operator-summary/writer.ts:353-391 parses 14 magic string prefixes
back out of strings the same module family produced ("Next step:" vs "Next
action:" drift has already happened once). A per-flow switch at 311-336
contradicts the file's own header claim of flow-agnosticism.

Action: widen SummaryProjection with structured fields; keep prefix-scraping
only as a fallback for old records. Do this before the output-model digest
redesign builds on top of the scraping.

### 4.4 Control-plane path and IO duplication

Severity: Medium. Status: Confirmed.

`.circuit/runs` is spelled in 7 places, `.circuit` in 4 more, atomic
temp-rename is implemented ~6 times, stdout writeJson 3 times. Per-flow
presentation logic lives in 4 homes, and shared/ does IO (json.ts:8) despite
the layer's purity framing.

Action: shared/control-plane-paths.ts plus a writeJsonAtomic; write the
"where presentation lives" rule into the src/app README and move the one IO
helper.

### 4.5 Undocumented operator surface

Severity: Medium. Status: Confirmed.

`history`, `memory`, `runs`, and `version` have zero operator docs
(operator-guide greps clean). The memory/history domain is also split across
src/app/history (memory-*.ts files), src/memory, and src/history (1 file).

Action: a short "utility commands" section in the operator guide; fold
src/history's single file into one of the two real homes.

### 4.6 Small CLI items

Severity: Low. Status: Confirmed.

- src/commands/create.md is formatted as a host command but none is
  generated; the framing test pins that it must NOT exist as a plugin
  command. Reword the file header so an agent does not "fix" it.
- Inert --json flag on handoff write actions; 4 distinct error-envelope
  dialects across commands. Unify when touched, not as a campaign.

---

## 5. Tests

The suite's fundamentals are excellent: zero snapshot tests, zero
skips/todos/onlys, env-gated live tiers, deliberate behavioral-contract
layer, 165 uses of two-arg assertions with messages.

### 5.1 One test costs 85 seconds and the guide lies about it

Severity: High (DX). Status: Confirmed (measured 85.25s).

tests/unit/emit-flows-drift.test.ts runs `npm run build` in beforeAll,
copies the full tree, and spawns 6 emit subprocesses, for one test. It is
included in BOTH `test` and `test:fast` (the fast tier excludes only
cli-router, per package.json:18). AGENTS.md:53 claims cli-router is the
"only true outlier; ~10s"; the real outlier is 8x that. Every agent
iteration loop pays it.

Action: move it to an env-gated slow tier next to the live tests (drift is
already enforced by `npm run verify`'s emit --check step, so the default
tiers lose nothing), and fix the AGENTS.md sentence. If you want it kept,
drop the in-test build and reuse dist.

### 5.2 No shared scaffolding; 100+ hand-rolled fixtures

Severity: Medium. Status: Confirmed.

108 inline `stages:[` literals across 28 files, 18 local readTrace clones,
43 files hand-parsing trace.ndjson. tests/helpers/runtime-flow.ts (913
lines) has 5 importers while runtime-fixtures has 63.

Action: add makeMinimalFlow and a shared readTrace to runtime-fixtures;
migrate opportunistically (new tests use them; old tests convert when
touched). Do not do a big-bang rewrite; the suite is load-bearing.

### 5.3 Placement rules exist but are unwritten

Severity: Medium. Status: Confirmed.

tests/runner/ is a 109-file, 36.5k-line grab-bag; the real placement rule
(unit vs runner vs runtime vs contracts) is consistent enough to infer but
written nowhere; 3-4 files are clearly misplaced.

Action: 10-line tests/README stating the rule; move the few strays.

### 5.4 Operator-facing wording is frozen in four layers

Severity: Medium. Status: Confirmed.

Summary wording is pinned by operator-summary-writer.test.ts (134 toContain,
48 toBe), host-plugin tests (:992), release-infrastructure tests (which pin
script SOURCE text at 531-533), and 24 frozen proof operator-summary.md
files. Any wording change (including the planned output-model digest
redesign) pays a 4-layer update tax.

Action: designate the writer test as the single wording-pin suite; loosen
the other three layers to structural checks (presence, ordering, schema)
before starting the digest work.

### 5.5 Small test items

Severity: Low. Status: Confirmed.

- Golden/proof re-baselining is genuinely good (sha256 self-consistency,
  UPDATE_GOLDEN gate, live schema re-parse); one opaque sha256 could carry a
  "what to do when this fails" comment.
- event-log-round-trip.test.ts uses a deprecated term as its name;
  tests/unit/smoke.test.ts is trivial; soak/ README over-promises.
- Cross-layer checkpoint duplication is layered-by-surface and justified
  (~6-8 files per semantics change); worth one paragraph in tests/README so
  nobody "deduplicates" it.

---

## 6. Documentation spine

### 6.1 repository-map.md is wrong at every level it speaks at

Severity: High. Status: Confirmed (tree lists a nonexistent file; checked).

It is Read-First #2 in the docs spine, and: the After map omits 4 of 15 src
layers plus apps/, evals/, and schemas/yaml; line 55 lists
docs/architecture/codebase-walkthrough.md, which does not exist (verified);
the payload is buried at line 44 behind migration archaeology; README.md:90
and 184 promise it as the repo map. The link checker passes because a drawn
tree is not a markdown link. src/README.md, by contrast, is accurate.

Action: delete the before/after tree and migration rationale (the revamp
shipped; the archaeology belongs in the plan doc), point the file at
src/README.md plus a 20-line top-level map, and fix README's description of
it.

### 6.2 Two glossaries, one orphaned, using each other's banned words

Severity: High. Status: Confirmed.

CONTEXT.md (192 lines) is referenced by zero maps but treated as authority
by 20+ specs and idea docs. It uses "phase" and "artifact" as headwords;
UBIQUITOUS_LANGUAGE.md deprecates both. An agent landing on CONTEXT.md via a
spec inherits the banned vocabulary.

Action: add CONTEXT.md to the docs README Document Classes with one
precedence line ("UBIQUITOUS_LANGUAGE.md wins on vocabulary"), and align its
headwords. Or fold it into UL and redirect. Either way, end the dual
authority.

### 6.3 Idea-catalog statuses lag shipped reality

Severity: Medium. Status: Confirmed.

continuity-restore-fast-robust is cataloged "current-idea" but PR #44
shipped it; intent-capture is "current-proposal" but PR #48 shipped. A
future session reading the catalog could re-implement shipped work.

Action: sync the two entries now; extend scripts/docs/check-ideas-catalog.ts
to require an in-file Status header that must agree with the catalog, so
this drifts loudly next time.

### 6.4 Generated-surface protection has two holes

Severity: Medium. Status: Confirmed.

- The deny list misses four generated families: schemas/yaml/**,
  plugins/*/runtime/circuit.js, plugins/*/scripts/launcher-core.ts,
  docs/release/*.generated.md.
- Zero of 74 emitted files carry an in-file generated marker, so the
  protection is repo-local: any agent or human outside this repo's settings
  edits them blind. Determinism is otherwise perfect (byte-exact emit
  checks).

Action: add the four deny patterns; emit an HTML-comment header (and a
generated_by key in JSON) from scripts/flows/emit.ts and friends.

### 6.5 docs/architecture is ungoverned

Severity: Medium. Status: Confirmed.

No README index; two orphan tracked HTML artifacts (circuit-map.html 26KB,
system-analysis.html 49KB, zero inbound references); the de facto
archive-in-place practice (status field in the catalog) is not what the
written archive policy describes.

Action: delete the two HTML files, add a 10-line index, and amend the
archive policy line to match practice.

### 6.6 Map sprawl

Severity: Medium. Status: Confirmed.

Eight "where things live" surfaces exist; ~8 of AGENTS.md's 21 table rows
duplicate docs/README.md or src/README.md. Per the agent-legibility research
(redundancy is the lever, and it cuts both ways), every duplicated row is a
future contradiction.

Action: crown docs/README.md the canonical map, trim AGENTS.md's table to
the rows agents need every session (verification, catalog, generated
surfaces), link the rest.

### 6.7 Small doc items

Severity: Low. Status: Confirmed.

- "Edit source, not output" stated in 9 prose sites plus 2 mechanical
  layers; collapse prose sites to pointers at the mechanical truth.
- Deprecated vocabulary in active docs: ~10 "artifact" + ~7 "dispatch" hits;
  run-process.md has a "Post-Run Artifacts" heading; UL's exemption list
  does not cover contracts that intentionally use runtime names like
  relay-hints. Add the exemption, rename the heading.
- specs/ is simultaneously classed "Archived" and home to the canonical
  narration-display-profiles.md; move the live doc or amend the class row.
- Always-loaded surface is healthy: 126 lines, ~28 imperatives. Keep it
  lean; resist adding rules here that a ratchet could enforce instead.

---

## 7. Build and release pipeline

### 7.1 verify compiles the world three times

Severity: Medium (DX). Status: Confirmed.

`npm run verify` triggers full tsc via `build`, then again inside
`check-yaml-schemas`, then again inside `check-release-infra` (each script
chain re-runs `npm run build` per package.json). No incremental cache. The
repeat costs ~5.5s locally and doubles across the two CI OSes; worse, the
inlined steps silently depend on whichever build ran earlier.

Action: either add `"incremental": true` to tsconfig.build, or (better) a
small scripts/verify.ts orchestrator that builds once and runs the checks
against it.

### 7.2 Script-layer duplication

Severity: Medium. Status: Confirmed.

writeOrCheck is verbatim-duplicated (scripts/release/shared.ts:78-94 and
scripts/schemas/emit-yaml-schemas.ts:33-50); sync-claude-cache and
sync-codex-cache are ~85% identical twins (147/163 lines), which is exactly
where a safety fix lands in one and not the other; 8 scripts hand-roll the
--check dual mode; 3 argv idioms coexist.

Action: scripts/shared/ with writeOrCheck and a tiny args helper; extract a
syncHostCache core with two thin wrappers.

### 7.3 audit-public-docs fails open

Severity: Medium. Status: Confirmed.

scripts/release/audit-public-docs.ts:62 continues when a listed file is
missing, and its incident regexes decay as docs move. This is the same
failure class as the circuit-land alpha.6 incident (grep-gate with
nonexistent paths passed while the page was wrong).

Action: error on missing files; add a self-test fixture that the gate can
still catch a planted violation.

### 7.4 CI hardening one-liners

Severity: Medium. Status: Confirmed.

verify.yml lacks `concurrency` cancellation, `timeout-minutes`, and
`permissions: contents: read`. Three lines, real wins (cancel superseded
runs, bound a hang, drop default token write scope).

### 7.5 Small pipeline items

Severity: Low. Status: Confirmed.

- script-inventory.md is stale (5 scripts and 4 owner dirs missing; ~150 of
  172 lines are archaeology). Update the table, archive the history.
- scripts/architecture/codegraph-boundary-crosscheck.ts is dead (zero refs;
  CodeGraph-trial residue). Delete.
- evals/ is hygienic but dormant since 2026-05-19; check-evals validates
  wiring, not content; scoring.ts placement is split-brain; biome ignores
  evals. One README sentence on its status, move scoring.ts, decide whether
  fixtures ship in the public tarball.
- package.json version 0.0.1 vs plugins/version.json authority: one comment
  line saying which is real. publish:plugins has a duplicate alias. soak
  re-runs verify plus a fourth build.
- Versioning authority itself is sound (single source, four synced files,
  CI-fatal drift): keep.

---

## 8. Cruft and repo hygiene

### 8.1 apps/designer is a parked experiment coupled to live schemas

Severity: High. Status: Confirmed.

Zero inbound references, untouched since 2026-05-07, all 23 source files
unused per knip, 5 files still use the deprecated term "Recipe", it owns a
270KB lockfile, and it imports src/schemas without ever being typechecked by
CI (silent coupling: schema changes can rot it invisibly, or worse, someone
"fixes" schemas to suit it).

Action: delete it (git history keeps it recoverable) or move it to its own
repo. If it must stay, give it a README stating its status and a knip/tsc
exclusion that is explicit rather than accidental.

### 8.2 Committed runtime bundles have bloated .git to 68MB

Severity: Medium. Status: Confirmed.

Two ~2.5MB bundles (plugins/*/runtime/circuit.js) have each been rewritten
in ~103 commits. Fresh clones pay it forever.

Action: rebundle only on release commits (the drift check can compare
against built output instead of committed bytes between releases), and add
shallow-clone guidance to CONTRIBUTING. Rewriting history would fix the
68MB but is probably not worth the disruption mid-alpha; deciding the
go-forward policy is.

### 8.3 Dead code is rare; the export surface lies

Severity: Medium. Status: Confirmed (knip + manual verification).

Only 2 truly dead functions (statusTextFromHeadline at
src/shared/progress-output.ts:54; maybeResolveSourcePath at
src/app/history/query.ts:403) and 1 dead re-export
(verification-resolver.ts:5). But knip reports 141 unused exports and 84
unused types, meaning most `export` keywords are speculative API, and an
agent cannot tell which exports are contract vs habit. Three per-flow
index.ts barrels (goal, pursue, runtime-proof) are dead AND each compiles
its flow a second time at import (a divergence trap). trace-fields.ts
exports two helpers that runtime-run-folder.ts:62,67 re-implements privately
while importing the same file.

Action: delete the 2+1 dead items and the 3 dead barrels; commit a knip.json
with real entry points so "unused export" becomes a signal; de-export
opportunistically when touching files. Note executeXResult export names are
test-pinned (runtime-context-boundary.test.ts:70-72); leave those.

### 8.4 Env-flag surface is undocumented

Severity: Medium. Status: Confirmed.

16 CIRCUIT_* flags exist; 11 are undocumented; CIRCUIT_RANK_PROJECT_FACTS
has zero setters anywhere (the Stage 0 recall experiment flag, default-off);
CIRCUIT_NO_AUTO_OPEN is operator-meaningful and unfindable.

Action: a reference table in docs/configuration.md; decide
RANK_PROJECT_FACTS (ship it on, or delete the branch; a flag nothing sets is
dead weight either way).

### 8.5 Small hygiene items

Severity: Low. Status: Confirmed.

- 15 status-done/superseded docs sit in public-facing dirs; the proofs tree
  is 332 files with no retention policy. One retention sentence each.
- .claude/workflows/circuit-pr-review.js is a committed host artifact cited
  as a specimen by docs; move it beside the doc that cites it or add a
  header comment saying why it lives there.
- CI pins node '22' while engines say 22.18; use node-version-file.
- canonical-stage-policy.ts exports two aliases for the same values
  (knip-confirmed); pick one name each.
- Dependency hygiene is excellent: 3 runtime deps, all load-bearing, 0
  vulnerabilities. Do not add deps to fix anything in this doc.

---

## 9. Agent legibility (the cross-cutting lens)

Most findings above are also legibility findings. The distinct items:

1. The repo's strongest legibility asset is the ratchet culture: an agent
   that violates a boundary gets a failing test naming the rule. Extend that
   pattern to the gaps found here: file-level cycles (2.4), flow-id literals
   in the engine (2.6), StepKind surfaces (2.3), idea-catalog status (6.3).
   Prose rules decay; ratchets do not.
2. The biggest single legibility tax is oversized files: handoff.ts (2,932),
   run.ts (1,185), graph-runner.ts (1,167). Each forces full-file reads for
   single-domain questions. The three decompositions (4.1, 4.2, 2.1) are
   the highest-value structural work in this doc.
3. Half-states confuse agents more than either endpoint: the ports
   migration (2.5), the barrels with zero importers (below), the
   test-fixture name that is production (3.4). Decide and document; do not
   leave both patterns looking canonical.
4. The five schema family barrels (flow-index, host-index, policy-index,
   run-index, evidence-index) have ZERO importers (grep-verified tonight:
   496 deep imports, ~34 root-barrel imports, 0 family); 3 of the 4
   schemas-barrel tests police structure nothing uses. Delete the five files
   and the policing tests, or wire real consumers. Empty structure that
   tests defend is the most confusing kind.
5. Schema versioning: 5 coexisting conventions, none documented, parsed by
   nothing; near-collision between goal-contract@v1, goal.contract@v1, and
   run.goal-contract@v0; schema_version is a string in 3 places and a
   number in 35. A 15-line versioning note in src/schemas/README.md plus
   normalizing the 3 strays ends it.
6. Error-string quality: config-loader.ts:61 and the flow-definition seam
   dump raw zod JSON at operators; humanizeZodIssueMessage already exists
   (flow-kind-policy.ts:17-44) and is used once. Reuse it at both seams
   (~20 lines).
7. src/types/ is an empty shell (README only, zero consumers, pinned by a
   documentation-surface test and 3 map links; one plan doc falsely claims
   it is live). Fold the README content into src/README.md and delete.
8. Contract docs under docs/contracts/ are substantively accurate (good),
   with 2 stale line-number citations (step.md:70, selection.md:383).
   Switch citations to symbol names repo-wide; line numbers rot.

---

## 10. What is strong, and what was checked and cleared

Keep these; do not let cleanup churn them.

- Catalog-derivation boundary holds: flows compile from
  src/flows/catalog.ts; no engine edits needed per flow (one literal
  exception, 2.6).
- Byte-exact generated surfaces with --check twins everywhere, including
  stale-file sweeps. Determinism verified.
- Ratchet tests guard the revamp's decisions; top-level cycles are zero.
- Zero z.any in src; only 2 z.unknown, both commented and re-parsed.
- Zero snapshot tests; zero skipped/todo tests; env-gated live tiers.
- Three runtime dependencies; zero npm audit findings.
- Release-evidence institution genuinely cross-checks claims (1.7 is the
  one loose joint found).
- TraceStore, corridor pattern, satisfies-exhaustiveness, fail-open/closed
  comments: engine idioms worth preserving as the house style.
- 111/111 markdown links resolve. Always-loaded agent surface is lean.

Hypotheses checked and refuted (do not re-chase):

- Corridors and fanout do NOT duplicate attempt bookkeeping.
- The dual-host pipeline is NOT two diverging generators: one compile, thin
  per-host renderers; only regex-surgery brittleness, already
  assertion-guarded (harden with replaceOrThrow when touched).
- The 0%-coverage files are type-only modules, not dead code.
  (src/app/operator-summary/projector.ts from the early lead list never
  existed.)
- src/app is NOT a grab-bag; its boundaries are mostly sound (4.4's IO leak
  is the exception).
- docs/internal exposure: gitignored, zero tracked files. The public
  exposure list is exactly the short list in 1.8.
- runtime-proof flow isolation from public surfaces is clean.

## Coverage gaps (honest)

- Connectors got a disclosure-level review, not a deep behavioral audit
  (subprocess lifecycle, kill semantics, output truncation untested by me).
- Windows: known debt, honestly commented in CI; not exercised tonight.
- No live host-plugin end-to-end run (install into a fresh Claude Code and
  walk first-run) was performed; 1.2/1.5 are inferred from files plus
  recorded release notes, not a fresh-machine reproduction.
- Memory/history internals were sampled, not exhaustively traced.
- Performance beyond test wall-time (engine runtime, bundle startup) was
  not measured.
- Security review was disclosure-and-config level, not a penetration test.

## Metrics appendix

| Surface | Size |
|---|---|
| src/ | 342 files, 63,461 LOC |
| tests/ | 268 files, 86,865 LOC |
| docs/ | 199 markdown files, 55,842 lines (ideas/: 59 files, 23,275) |
| scripts/ | 39 files, 8,878 LOC |
| Largest files | handoff.ts 2,932; run.ts 1,185; graph-runner.ts 1,167 |
| Runtime deps | 3 (commander, yaml, zod); 0 audit findings |
| .git | 68MB (2 committed 2.5MB bundles x ~103 commits each) |
| Test wall-time | dominated by one 85.25s drift test (in both tiers) |
| Cycles | 0 top-level (ratcheted); 16 file-level (madge, unratcheted) |
| knip | 141 unused exports / 84 types / 51 unused files (mostly apps/designer); 2 dead functions + 1 dead re-export confirmed real |
| Commits since 2026-05-01 | 426 |

Re-runnable probes: `npx madge --circular --extensions ts src`,
`npx knip`, `grep -rn "intent_prefixes" src tests scripts`,
`./bin/circuit` (bare; shows the outputHelp leak), `git tag -l`.
