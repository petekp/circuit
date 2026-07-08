# Sweep flow — build-ready spec

Status: design, ready to build (internal-first). Written 2026-07-07.

This is a design spec, not a build. Writing it is allowed under the v1
freeze (design is not a feature). Sweep would ship `visibility: 'internal'`
and emit no public host surface until a separate post-launch promotion
decision, which is Pete's call.

The spec was produced by a grounded design pass and then hardened by two
adversarial reviews against real engine source. The first verified the flow
design and changed it in four load-bearing places (Section 4). The second
red-teamed the two engine primitives' implementation and reshaped both: it
re-rated the fanout-output change from a correctness bug to an evidence-integrity
one, and it found that the oracle-command pin as first sketched is a false floor
for the one command shape `fix-until-green` ships (Sections 6.2 and 7). Those
changes are folded in below so we do not regress to the first-pass design.

---

## 1. What Sweep is

Sweep clears a whole backlog of the same mechanical finding by driving an
external tool to a zero-finding exit. You point it at a tool that reports a
countable list of findings and exits nonzero while any remain (tsc, ESLint,
Clippy, go vet, golangci-lint, an accessibility scanner). Sweep partitions
the findings into independent units, fans out one worker per unit, re-runs
the tool as the evidence gate, and loops until the tool reports zero for the
same set it started on.

The tool is the oracle. "Done" is not a judge's opinion; it is the tool's own
exit code. While the tool exits nonzero, the loop cannot close clean, because
the until-loop evidence floor disposes the judge's `goal_met` against the
tool's verification status, which is schema-bound to the measured exit code
(`src/schemas/verification.ts:96-125`). A worker cannot hand-write a green
report and cannot wrap the command in `|| true` (`SHELL_BINARIES` guard,
`src/schemas/verification.ts:70-81`).

Canonical job: flip on TypeScript strict mode, inherit roughly 300 errors
across 80 files, and drive `tsc --noEmit` to a clean exit with a recorded
count trajectory (300, 140, 30, 0).

---

## 2. When to use Sweep, and when not to

**Use Sweep when all of these hold:**

- The work is a **set**, not one target. Many findings of the same class
  across many files.
- The findings are **machine-readable**. A tool emits a countable list and
  exits nonzero while any remain.
- The findings are **mostly file-local**, so the set partitions into units
  that can be worked in parallel without racing each other's files.
- The tool's **exit code is trustworthy** as the definition of done.
- You run at **autonomous depth**. That is the only depth at which the loop
  re-enters (`activate_when_depth_at_least: autonomous`,
  `src/flows/types.ts:217-219`). Below it, Sweep runs one wave, one rescan,
  and a disposed judgment: still honest, but it does not sweep to zero.

**Do not use Sweep when:**

- You have a **single target** that loops until one command goes green. That
  is exactly `fix-until-green`. Sweep over one file is pure ceremony.
- The findings are **not machine-readable**, or the tool cannot report a
  countable list with a nonzero exit. Sweep's oracle binding requires the
  exit code to drive status.
- The legitimate fix **must edit the tool's own config** (a genuine tsconfig
  migration). Sweep freezes the config surface, so that latch would fire on
  every wave and the loop could never complete. This is a real migration,
  which is the Migrate flow's job, not Sweep's.
- **"Fixed" is a matter of taste.** Sweep's entire safety story is that the
  oracle, not a judge's prose, decides done.
- The finding class is one where **a fix and a silence are indistinguishable
  to the tool** and the silence is in-language rather than a config edit or a
  suppression directive. Concretely: a rule that can be satisfied by casting
  to `any` / `as unknown as T`, by renaming a symbol so the rule stops
  matching, or by wrapping code in a dynamically-typed boundary. Sweep's
  ungameable guarantee holds only for finding classes where **every path to
  silence is either a config edit (frozen), a suppression directive (audited),
  or dropping a targeted input (set-identity check)**. If a class has an
  in-language silence path with no directive to count, Sweep degrades to the
  soft judge check for that class and its guarantee is qualified. This is a
  hard scope boundary, stated up front, not a footnote.

---

## 3. Why Sweep is net-new, not a reskin of fix-until-green

The distinction is structural, expressible as two graph differences an author
can point at.

**1. The loop-body head is a different engine step kind.** `fix-until-green`'s
body head is a single relay: one implementer, one target
(`src/flows/fix-until-green/assembly-spec.ts`, `body_steps` head is
`act-step`, `kind:'relay'`). Sweep's body head is a **dynamic fanout**: N
workers, one per partition unit (`kind:'fanout'`, `fanout.branches` dynamic,
`src/schemas/step.ts:379-400`). Two different engine step kinds occupy the
head slot. This is legal: a fanout is an execution kind, not a loop flag, and
the only mutual exclusion is between the two loop flags themselves
(`iteratesSliceLoop` vs `iteratesUntilCondition`, `src/flows/types.ts:238-243`).
Fanout and until compose freely at the flag layer, which the adversarial
review confirmed no validator forbids.

**2. The loop condition is a set count, not a single pass/fail.**
`fix-until-green`'s condition is one command going green. Sweep's condition is
the tool's own re-scan **count over a set** reaching zero, carried on
`stop_judge.progress_path = 'remaining_count'`. The steering is "clear this
entire class of finding until the tool reports the set empty," not "fix this
one bug until the test passes."

Sweep is `fix-until-green`'s fan-out-over-a-set generalization. The
generalization is the dynamic-fanout head plus the count-to-zero condition
plus a real frozen config surface.

The review found two honest corrections to this framing. First, the
generalization is **not free**: it needs two small general engine additions
(Section 7). Second, the "both additions harden `fix-until-green` for free"
story is only half true and is scoped honestly here. The fanout-output primitive
does nothing for `fix-until-green` (it has no fanout), and the oracle-command pin
closes only the plan-file-argv narrowing vector for it, leaving the dominant
`npm run <script>` body-swap and config-narrowing vectors open (Section 6.2).
Sweep is still the flow that motivates hardening the loop substrate, which is a
stronger launch story than "zero engine edits" as long as the hardening claim is
stated at its true scope, not oversold.

---

## 4. Adversarial review outcome

An adversarial pass verified every claim in the first-pass design against
engine source. The core held. Four load-bearing claims did not, and are fixed
in this spec.

### What is sound and verified

| Property | Evidence |
|---|---|
| Exit code drives verification status; a worker cannot hand-forge a green report | `src/schemas/verification.ts:96-125`; engine measures exit via `spawnSync shell:false`, `src/shared/proof-plan.ts:178-201` |
| `\|\| true` and shell wrapping are blocked | `SHELL_BINARIES` guard, `src/schemas/verification.ts:70-81` |
| Config tampering latches an honesty-ledger key nothing clears | `FrozenEvalGuard`, `src/runtime/run/frozen-eval.ts:30-64`; latch `graph-runner.ts:1350-1358` |
| "Ran out of waves" cannot read as success | exhaustion routes to a non-`@complete` terminal, `needs_attention_route`, `src/flows/types.ts:160-165` |
| Fanout and until compose at the flag layer | no validator forbids a fanout step as a loop body step; `until-corridor.isLoopBodyStep` scopes any body step |

### What the first-pass design got wrong (now fixed)

| Claim in first pass | Verdict | Fix (in this spec) |
|---|---|---|
| "The oracle command cannot be gamed; frozen_paths covers tampering." | **Critical.** The scan command list is read each wave from `plan.json` inside the run folder, which is inside the worker's editable tree (`fix-until-green/writers/verification.ts:34-37`; run folder `.circuit/runs/<runId>/`, `run-boundary.ts:22-49`). A worker narrows the argv; the next rescan exits 0 on a narrower set and closes `@complete` with debt intact. `frozen_paths` is a static list; the per-run path is unknowable at authoring time. | Snapshot the resolved oracle command into engine loop state at loop entry and stop re-reading `plan.json` in the loop body (Section 6.2, Approach B; the tail-seam re-fingerprint variant has a confirmed restore-before-check TOCTOU). The pin alone closes only plan-argv editing; the full floor also needs the script-body fingerprint, the set-identity invariant (Section 6.4), and per-wave config re-derivation (Section 6.3). |
| "The changed_files overclaim gate rejects a worker claiming a fix it did not make." | **Critical.** `acceptance_criteria` is schema-forbidden on non-relay execution (`flow-schematic.ts:494-498`); `FanoutRelayBranchExecution` has no such field (`step.ts:294-308`). The gate does not apply to fanout workers. | Retract the claim. The oracle re-scan is the real backstop: a claimed-but-unmade fix leaves the finding, the count does not drop, the loop re-enters (Section 6.5). Per-worker diff-honesty via a sub-run is a fast-follow. |
| "No engine edits; the corridor iteration-scopes the fanout like any body step." | **Medium (re-rated down from High).** The fanout executor is iteration-unaware: `branchesDir()` / `aggregateRef()` are fixed paths with no iteration component (`src/runtime/executors/fanout.ts:29-39, 89, 241`). But the wave verdict is built from an **in-memory** outcomes list, not a disk re-read (`fanout.ts:214/276/315/333`), so the close is already wave-correct. The real defect is evidence integrity: wave 1's stale per-branch dirs linger and are ingested by the run-history extractor (`src/app/history/extract.ts:416`, keyed with no wave component), surfacing a branch set that never co-existed in any single wave. | Clear the branch dir at the head of each wave, gated on the already-threaded `activeSliceIndex` (Section 7, engine change 1). Not path-scoping the writes: that desyncs the shared fixed-path report resolver. The close stays oracle-gated and wave-correct regardless; this is for an honest run record, not for the verdict. |
| "The partition re-partitions each wave; per-file units are independent." | **High.** `partition-step` was a run-once preamble; nothing rewrote the partition between waves. And per-file independence is empirically false for the flagship tsc-strict case: fixing file A surfaces new errors in importers B..Z (`independenceArgument` contradicted). The disjoint-files refinement proves write-safety, not fix-independence. Project-level findings have no file to group by. | Move `partition-step` **inside** the loop as the head. Reframe independence as a per-wave falsifiable hypothesis the oracle settles. Add serial-fallback-on-stall and a project-level bucket (Section 5.4). |

Plus three lesser gaps, all addressed below: config discovery is open-ended so a
worker can create a new nested config the static freeze never enumerated
(Section 6.3); test/fixture deletion is uncaught for test-runner-style oracles
(Section 6.6, scope boundary); the count is not enforced monotone so oscillation
burns the iteration budget (bounded by `max_iterations`, Section 5.2).

---

## 5. Revised design

### 5.1 Steps

One preamble census, then a four-step loop body. The key change from the first
pass: **partition is inside the loop**, so every wave re-derives its units from
the latest survivor list.

```
census-step            (preamble, runs once)
  |
  v  loop body (head -> tail), re-enter route 'advance'
partition-step  ->  fanout-step  ->  rescan-step  ->  judge-step
  ^                                                       |
  |_______________________ advance ______________________|
```

**`census-step`** — preamble, runs once. Resolves the scanner command, the
suppression-audit command, and the config surface. Runs the tool once in
machine-readable mode. Emits the initial finding list, the suppression
baseline, the config fingerprints, and (new) the **scanner fingerprint**, the
**script-body fingerprint** (when the scanner resolves to `npm run <script>`,
the fingerprint of that script's `package.json` body), and the **targeted set**
(the scope the scanner covers). `kind: 'compose'`,
deterministic writer, no worker edit surface. Maps to `fix-until-green`'s
`plan-step`.

- out: `sweep.census@v1 { objective, scanner: VerificationCommand,
  scanner_fingerprint, script_body_fingerprint, targeted_set,
  suppression_audit: VerificationCommand, suppression_baseline[],
  config_surface[], config_fingerprints[], findings[], total_finding_count }`
- also seeds `sweep.findings@v1` (the latest-survivors report the loop reads;
  see 5.3) with the census finding list, so wave-1 partition has input.
- check: `scanner`, `scanner_fingerprint`, and `suppression_baseline` must be
  present or the flow cannot census. routes `{ continue: 'partition-step',
  stop: '@stop' }`.

**`partition-step`** — HEAD of the loop, runs every wave. Reads the latest
survivor findings (`sweep.findings@v1`), groups them into units by the stated
criterion, and proves write-disjointness of concurrent units. `kind: 'compose'`,
deterministic. This is the step the review moved inside the loop.

- in: `sweep.findings@v1` (census-seeded on wave 1, rescan-written thereafter)
- out: `sweep.partition@v1 { units: { unit_id, files[], finding_ids[],
  independence: 'isolated'|'shared'|'serial'|'project', fix_prompt }[],
  covers_all_findings: boolean }` with a Zod `superRefine` enforcing
  pairwise-disjoint files across concurrent (non-serial) units
- check: `units` present; the refinement fails loudly on any shared file
  across concurrent units; `covers_all_findings` asserts every survivor
  finding id landed in exactly one unit (no silent drop). routes
  `{ continue: 'fanout-step', stop: '@stop' }`.

**`fanout-step`** — first body step after the head. Dynamic fanout: one
implementer relay per unit, MCP-closed, fixing findings by changing code only.
`kind: 'fanout'`, `fanout.branches` dynamic, modeled on `explore`'s
proposal fanout. This is the structural net-new versus `fix-until-green`'s
single act relay.

- template: `goal = '$item.fix_prompt'`, `report_schema = 'sweep.unit-fix@v1'`,
  `provenance_field = 'unit_id'`. Per-worker file scoping is trusted guidance
  in the prompt (the fanout relay template carries no `equipment_scope` field,
  `step.ts:294-308`). Hard containment comes from MCP-closed workers plus the
  disjoint-file partition plus the oracle re-scan, not from an enforced lock.
  Optionally pin the branch connector to `claude-code` if you want enforced
  tool scope rather than the codex trusted downgrade
  (`FanoutRelayBranch.connector`, `step.ts:318`).
- join: `on_child_failure: 'continue-others'`, `join.policy:
  'aggregate-survivors'`, bounded concurrency (max 4), `max_branches` capped.
- out: `sweep.wave-aggregate@v1` (join aggregate). routes
  `{ continue: 'rescan-step' }`.

**`rescan-step`** — the evidence floor. Re-runs the **pinned** scanner over the
**whole targeted set**, runs the suppression audit, and re-derives the effective
config. `kind: 'run-verification'`, engine-owned command runner, direct-argv
only.

- in: the snapshotted scanner and audit commands (Section 6.2 pins these at loop
  entry; the loop body is served the cached command instead of re-reading the
  plan, and the script-body fingerprint is checked before the wave runs)
- out: `sweep.scan@v1 = VerificationResult` extended with `remaining_count`,
  `suppression_count`, `findings[]` (fresh survivor list, written to
  `sweep.findings@v1` for the next wave's partition), `effective_config[]`
  (re-derived, Section 6.3), `new_config_files[]`, `scanner_fingerprint_ok`,
  `set_covers_census` (Section 6.4)
- check: `overall_status` is exit-code-bound. `passed` requires **all of**:
  scanner exits 0 (`remaining_count == 0`), suppression audit exits 0
  (`suppression_count <= baseline`), `scanner_fingerprint_ok`, `set_covers_census`,
  and no new config file weakening a rule. Any failure makes `overall_status =
  'failed'`, contradicting the proof, and the floor blocks `goal_met`. routes
  `{ continue: 'judge-step', revise: 'judge-step', stop: '@stop' }` (a red
  rescan still reaches the judge with failure evidence).

**`judge-step`** — TAIL of the loop. Reviewer relay bound to
`converge.judgment@v1` (reused verbatim): proposes `goal_met`, writes a lesson
for the next wave, surfaces `remaining_count`. `kind: 'relay'`, reviewer.

- `goal_met` is **disposed** by the engine against the evidence floor, never
  trusted as prose (`graph-runner.ts:491-501`). An empty-claim while
  `remaining_count > 0`, or a suppression rise, or a config drift, or a fingerprint
  mismatch, is a blocked false-done and the loop re-enters.
- routes `{ continue: '@complete', advance: 'partition-step', close: '@stop' }`.
  `advance` re-enters the head. `close` is a normal route (not recovery), so an
  exhausted clean pass does not trip the no-failure-evidence guard.

### 5.2 Loop design

- **body_steps**: `['partition-step', 'fanout-step', 'rescan-step',
  'judge-step']`. head `partition-step`, tail `judge-step`, re-enter route
  `advance`. Census runs once outside the loop. Every body step is
  iteration-scoped by the until-corridor, so each wave is a fresh partition and
  a fresh fanout.
- **condition**: stop-clean only when the judge proposes `goal_met = true` AND
  the floor confirms the latest rescan is `passed` (all five conditions in 5.1)
  AND no honesty-ledger latch is open. Anything else re-enters. "Set is empty"
  is mechanically unreachable while the tool reports findings, because status is
  exit-code-bound and the floor reads it, not the judge's words.
- **cap**: `max_iterations: 5` (`fix-until-green` ships 3; a large set with
  cross-file residue needs more waves). Hard cap regardless of the stop judge.
  On exhaustion the loop takes `needs_attention_route: 'close'` to `@stop`, a
  non-`@complete` terminal.
- **ledger**: `stop_judge { goal_met_path, lesson_path, progress_path:
  'remaining_count' }`. `carried_notes` inlines the prior wave's lesson into
  the next wave (the compounding mechanism). `no_progress_ceiling: 2`:
  `progress_path` is compared by opaque equality (`types.ts:152-158`), so an
  unchanged count for two waves exits to needs-attention. Honest limit: the
  engine does not enforce monotone decrease, so a count that oscillates (fix A
  regresses B) reads as progress each wave; the real bound on oscillation is
  `max_iterations`. `frozen_paths`: the census config surface. **No cumulative
  budget cap initially**: caps are fail-closed and a fanout child with no usage
  would abort the loop prematurely (`types.ts:177-186`); add a cap only after
  every fanout child's usage is confirmed on the trace.

### 5.3 Reports

- **`sweep.census@v1`** — preamble output. Scanner + audit commands, their
  fingerprints, the targeted set, the initial finding census, the suppression
  baseline, and the config surface with fingerprints.
- **`sweep.findings@v1`** — the latest survivor finding list. Census seeds it;
  `rescan-step` overwrites it each wave (latest-wins, like `fix-until-green`'s
  verify report). `partition-step` reads it. This is the seam that makes
  re-partition-each-wave real rather than asserted.
- **`sweep.partition@v1`** — the disjoint unit set for this wave, with the
  stated criterion, the disjointness refinement, and `covers_all_findings`.
- **`sweep.unit-fix@v1`** — per-worker branch report: `unit_id`, `changed_files[]`
  (min 1), `verdict: 'fixed'|'partial'|'blocked'`, `rule_fixed`, `evidence`.
- **`sweep.wave-aggregate@v1`** — fanout join with `unit_id` provenance,
  modeled on `explore.tournament-aggregate@v1`.
- **`sweep.scan@v1`** — oracle re-run: `VerificationResult` (exit-code-bound
  status) extended with `remaining_count`, `suppression_count`, fresh
  `findings[]`, `effective_config[]`, `new_config_files[]`,
  `scanner_fingerprint_ok`, `set_covers_census`.
- **`converge.judgment@v1`** (reused) — the tail judge's disposed `goal_met`,
  carried `lesson`, `summary`, `verdict`.

### 5.4 Partition strategy

The first pass claimed per-file independence as a property. The review showed
it is false for the flagship case. The revised strategy treats independence as
a **hypothesis the oracle settles each wave**, not an axiom.

- **Unit criterion (default)**: one unit per file. All of a file's findings go
  to one worker; each worker owns one file. Concurrent workers are
  write-disjoint by construction, proved by the `superRefine`. This is a
  **race-safety** property, and the spec now labels it as exactly that, not as
  fix-independence.
- **Independence is a per-wave falsifiable claim.** Fixing file A can surface
  new errors in importers B..Z (true for tsc strict). That is fine, because
  partition runs every wave: the next `partition-step` reads the fresh survivor
  list from `sweep.findings@v1`, which now includes B..Z's new errors, and
  builds units for them. A bad independence guess shows up as a
  non-decreasing count, never as a false done. The count trajectory is itself
  the honest proof the partition was adequate.
- **Project-level and file-less findings** (tsc TS6059/TS18003, config-level
  eslint errors, go vet package-level diagnostics) have no file to group by.
  They go into one dedicated **`project` unit** worked by a single serial
  worker. `covers_all_findings` asserts they were not silently dropped. Never
  bucket a project-level finding under a fake file.
- **Shared units**: when the tool itself reports a multi-file finding, collapse
  it into one unit whose `files[]` lists every touched file, so one worker owns
  the whole cross-file edit and no two workers race.
- **Serial-fallback-on-stall** (new): the partitioner cannot see the import
  graph, so it cannot know at census time that A's finding is fixed only by
  editing B. It does not need to. If a wave's `remaining_count` does not
  strictly decrease, the next `partition-step` collapses the remaining findings
  into **one serial unit** worked by a single worker (Sweep degrades to a
  `fix-until-green`-shaped worker for the coupled residue). This is the honest
  answer to fix-coupling the partitioner cannot discover: stop guessing, go
  serial, let the oracle confirm. `no_progress_ceiling` and `max_iterations`
  bound the rest.

---

## 6. The honesty gate

### 6.1 What the oracle guarantees

The close receipt is trustworthy for exactly one reason: the tool's exit code,
not a judge's prose, decides done, and the exit code is measured by the engine
(`spawnSync shell:false`) and bound to status (`verification.ts:96-125`). Three
threats are closed by existing engine mechanics: hand-forged green reports
(exit-code binding), `|| true` wrapping (`SHELL_BINARIES`), and config
weakening of an enumerated file (`FrozenEvalGuard` latch). The additions below
close the paths the review found still open.

### 6.2 Engine addition: pin the oracle command (snapshot at loop entry)

**The hole.** The scanner and audit command list is read each wave from
`plan.json` in the run folder, which lives under the project root inside the
worker's editable tree. A worker edits it to narrow the scan (drop a flag,
point at a subdir, add an ignore path). The next rescan runs a narrower scan
that exits 0, and the loop closes `@complete` with debt intact. `frozen_paths`
cannot cover this: the run-folder path carries a per-run id unknowable at
authoring time. This is latent in `fix-until-green` today, not unique to Sweep.

**The fix (Approach B: snapshot at loop entry).** Snapshot the resolved scanner
and audit command list into engine loop state once, on the first read of the
loop-body verification step, and serve that cached list on every later wave
instead of re-reading `plan.json`. Once the command is snapshotted, the loop
body never re-reads the worker-editable plan file, so there is nothing left to
narrow. Gate the snapshot on `context.honestyLedger` being present (seeded only
for an until-loop with a stop judge, `run-context.ts:113-120`) and key it to the
specific plan-reading step id, so single-pass verification and the stateful
per-wave writers (`fix.baseline-snapshot`, `fix.regression-rerun`,
`build.touch-area`) keep re-deriving exactly as today. Capture lazily on the
first `loadCommands` call (wave 1, after the preamble wrote the plan, before any
body edit re-runs), not at corridor construction, because the plan does not
exist yet at construction. The change is engine-only (`graph-runner.ts` +
`executors/verification.ts`); the writer contract and the flow package stay
byte-identical. `rescan-step` still surfaces `scanner_fingerprint_ok`; since the
argv is served from the snapshot it cannot drift, so the meaningful signal that
flag now carries is the script-body match (below), not the tokens.

**Why not Approach A (fingerprint-and-latch at the tail seam).** The first pass
proposed fingerprinting the command at loop entry and re-checking it against the
run folder at every tail seam. The review confirmed a real time-of-check /
time-of-use hole. The step order is act -> verify (reads `plan.json`) -> judge
tail seam. A worker narrows `plan.json`, the narrowed scan exits 0, and then the
worker **restores `plan.json` to its loop-entry bytes** during the edit-capable
judge relay before the tail-seam re-check runs. The re-check sees zero drift and
the narrowed scan already counted. Snapshotting removes the read entirely, so it
is strictly stronger than racing the restore.

**Hard limit the review found (must ship bundled with the pin).** Approach B
pins the **argv tokens**, not the work they name. `fix-until-green`'s resolver
emits `npm run <script>` (`verification-resolver.ts:106`), and the real scan
lives in `package.json`'s `scripts[<script>]`, which is in the worker-editable
tree and is **not** snapshotted. Preflight only checks the script is a string,
never its content (`proof-plan.ts:159`). So a worker rewrites `"verify": "true"`,
the pinned `npm run verify` tokens stay byte-identical, no drift is seen, the
no-op runs green, and `@complete` closes with debt intact. The pin as argv-only
is a **false floor** for the one command shape `fix-until-green` actually ships.
Closing it requires also fingerprinting the target script **body**
(`package.json scripts[<script>]`, plus the resolved cwd's `package.json`
identity) into the same snapshot and comparing it before each wave, and
hardening the preflight to reject a drifted body. Ship the script-body
fingerprint **with** the pin, or scope the claim down to "the honest argv tokens
run," never "the honest scan runs."

**Honest scope.** The pin plus the body fingerprint closes command narrowing via
the plan file and via the run script. It does **not** by itself close
config-driven set-narrowing (a tool re-reading `tsconfig` / `.eslintignore` at
runtime, Section 6.3) or in-language recasting (Section 2). And it does **not**
"harden `fix-until-green` for free": `fix-until-green` declares no `frozen_paths`
and no config re-derivation, so the pin closes only the plan-argv vector for it,
plus the script-swap vector once the body fingerprint lands, and leaves the
config hole open. The full honesty floor is the pin **plus** the script-body
fingerprint **plus** the set-identity invariant (6.4) **plus** per-wave config
re-derivation (6.3), not the pin alone.

### 6.3 Config-discovery hardening: re-derive the effective config each wave

**The hole.** ESLint and tsc config resolution is hierarchical and
discovery-based. A worker adds a new nested config at an unfrozen path (a new
`src/foo/.eslintrc.json` turning the rule off for that subtree) and the scanner
honors it. A static `frozen_paths` list cannot enumerate future-created config
locations.

**The fix.** `rescan-step` re-derives the **effective** config from the tool
itself each wave (`eslint --print-config <file>`, `tsc --showConfig`) and
fingerprints the resolved result, not just the enumerated source files. It also
records `new_config_files[]`: any config file present now that was not in the
census `config_surface`. A changed effective config, or a new config file that
weakens a rule, fails the rescan. This closes the open-ended discovery hole that
a fixed freeze list cannot.

### 6.4 Set-identity invariant

**The hole.** Nothing asserted that the final zero-rescan targeted the same set
the first scan did. Combined with 6.2, a narrowed final scan could read as an
honest 300-to-0 trajectory.

**The fix.** `census-step` records `targeted_set` (the scan scope). Every
`rescan-step` asserts `set_covers_census`: the set the rescan actually targeted
is a superset of the census set. `@complete` is unreachable unless the final
zero-finding scan covered at least the set Sweep started on. This rides on the
same pin as 6.2.

### 6.5 Retracted claim: the overclaim gate does not apply to fanout workers

The first pass claimed the changed_files overclaim gate rejects a worker
claiming a fix it did not make. It does not: `acceptance_criteria` is
schema-forbidden on fanout execution (`flow-schematic.ts:494-498`;
`FanoutRelayBranchExecution` has no such field). The claim is retracted.

Why the security story survives the retraction: for Sweep specifically, the
oracle re-scan is the structural backstop the overclaim gate would have been.
A worker that claims a fix it did not make leaves the finding in place; the
rescan still counts it; `remaining_count` does not reach zero; the loop
re-enters. The oracle catches false-fix claims by construction, without needing
the diff gate. What the disjoint partition (not the overclaim gate) prevents is
a worker touching a file outside its unit and racing another worker.

Fast-follow if per-worker diff-honesty is wanted: move each unit's fix into a
`FanoutSubRunBranch` whose child relay can carry `acceptance_criteria`, so the
overclaim gate applies inside each branch. Deferred; not in the baseline.

### 6.6 Residual limits (stated, not solved)

- **Test/fixture deletion.** If the oracle is a test runner or a fixture-based
  scanner, a worker can delete the failing spec, add `.skip`, or empty the
  fixture. `frozen_paths` covers only config, and the overclaim gate does not
  distinguish a fix from a deletion. Mitigation for test-runner-style oracles:
  add a **test-inventory audit** as a second rescan command (count test files,
  test cases, and assertions; fail if the inventory drops below the census
  baseline). Without such an audit for a given tool, test-deletion is a real
  gap, and Sweep's guarantee for that tool is qualified. Prefer Sweep on
  static analyzers (tsc, ESLint, Clippy, go vet) where the finding source is
  the code itself, not a deletable test.
- **In-language recasting.** Casting to `any`, renaming a symbol so the rule
  stops matching, wrapping in a dynamically-typed boundary: these reduce the
  count with no directive to count. This is the Section 2 scope boundary. The
  audit's completeness is bounded by the directives the author enumerates.
- **Oscillation.** The count is not enforced monotone (opaque-equality
  progress). A partial-silence strategy can wobble the count and burn the
  iteration budget. It is bounded by `max_iterations`, and it degrades
  availability, not honesty (an oscillating run exhausts to needs-attention, it
  does not close clean).
- **Argv smuggling.** `SHELL_BINARIES` checks argv0 basename only; `node -e`,
  `npx <x>`, `env VAR=x <tool>` are not in the set. The commands are authored by
  a deterministic compose writer, not a worker, so this rests on the writer
  never emitting such argv rather than a schema guarantee. Tighten the writer's
  allowed-argv check as a small hardening; low severity because the command is
  not worker-controlled once pinned (6.2).
- **frozen_paths false positives.** A legitimate fix that must touch a frozen
  file latches the loop. Freeze only config and eval files, never source under
  repair (`types.ts:213-215`).
- **Resume.** Until-loop resume is fenced off in the engine (per-iteration
  counts are not persisted). A checkpointed Sweep restarts from wave 0. Do not
  promise resumable Sweep for v1.

---

## 7. Engine changes Sweep requires

Sweep does **not** compose only shipped primitives with zero engine edits. It
needs two small, general engine additions (a third, the script-body fingerprint,
ships bundled with the second). Neither is flow-specific code in the engine
(which the catalog boundary forbids). Both are engine-only and gate on
already-threaded until-loop signals, so both are strict no-ops for every current
flow. This is the boundary-honest list.

1. **Iteration-scoped fanout output paths (per-wave clear).** Clear the fanout
   `branches_dir` at the head of each wave, gated on the already-threaded
   `context.activeSliceIndex` (populated for until-body steps; `graph-runner.ts`
   sets it from the corridor iteration index). One executor edit; no new
   RunContext field and no schema change. **Not** path-scoping the write paths:
   the shared report resolver `reportPathForSchemaInRuntimeFlow`
   (`runtime-index.ts:132-153`) returns fixed paths and is the close /
   verification read side for every flow, so iteration-scoping writes would
   desync reads across build/explore/prototype/fix/converge. Today the fanout
   paths are fixed (`src/runtime/executors/fanout.ts:29-39, 89, 241`). The wave
   verdict is already correct (built from in-memory outcomes, not a disk
   re-read), so this is **evidence integrity, not close correctness**: it stops
   stale branch dirs from being ingested by the run-history extractor
   (`src/app/history/extract.ts:416`). General: any fanout inside any loop needs
   it. Note: this primitive does nothing for `fix-until-green`, which has no
   fanout.
2. **Oracle-command pin, snapshot-at-loop-entry (Approach B) + script-body
   fingerprint.** Snapshot the resolved run-verification command list into engine
   loop state on first read and stop re-reading `plan.json` in the loop body,
   gated on `honestyLedger` and keyed per step (Section 6.2). **And** fingerprint
   the target script body (`package.json scripts[<script>]`) into the same
   snapshot, because pinning argv alone is a false floor for the `npm run
   <script>` shape `fix-until-green` ships. General, but scoped: for
   `fix-until-green` it closes the plan-argv vector and, with the body
   fingerprint, the script-swap vector; it does **not** close config-driven
   narrowing there, since `fix-until-green` has no `frozen_paths` and no config
   re-derivation.

Precedent for shipping a general engine primitive ahead of its first flow
customer: `frozen_paths` itself landed on `UntilLoopEngineFlag` before any flow
wired real repo paths into it (`src/flows/types.ts:206-216`). These are the same
shape of change.

Explicitly **not** taken in the baseline (deferred as schema fast-follows):
`equipment_scope` on the fanout relay template (per-worker enforced file lock),
and `acceptance_criteria` on fanout branches (per-worker overclaim gate via
`FanoutSubRunBranch`).

---

## 8. Probes before build

Per AGENTS.md rule 7, run these before locking the build. Each answers a
question the design depends on.

1. **Findings carry files?** Run the target tool in machine-readable mode on a
   real repo (`eslint --format json` items have `filePath`; tsc diagnostics
   carry `file`; `clippy --message-format=json` carries spans). Question: can
   findings be partitioned by file at all, and how many are file-less
   project-level findings (the `project` unit's real load)?
2. **Config surface fully enumerable?** Enumerate every config the tool
   discovers on a real repo and diff against what `census-step` would freeze,
   then run `eslint --print-config` / `tsc --showConfig` and confirm the
   effective-config re-derivation (6.3) catches a planted nested config. Question:
   does 6.3 actually close the discovery hole for this tool?
3. **Suppression audit is mechanical?** Confirm the tool has a suppression-audit
   mode or a countable ignore directive that runs as a direct-argv command with
   no shell. Question: is the inline-suppression gate mechanical for this tool,
   or does it fall to the soft judge check?
4. **Fanout-in-loop writes are iteration-safe?** Before relying on engine change
   1, run a two-wave fanout and confirm wave 2 does not overwrite wave 1's
   branch dir and aggregate. Question: is engine change 1 implemented correctly,
   or do artifacts still collide?
5. **Command pin holds, both vectors?** After engine change 2, edit `plan.json`
   mid-run to narrow the scanner and confirm the loop still runs the snapshotted
   full command (the narrowed plan is ignored, not merely detected). Then rewrite
   the `package.json` verify-script body to a no-op and confirm the script-body
   fingerprint blocks the close. Question: are both the plan-argv and the
   script-swap narrowing attacks actually closed?

Probes 4 and 5 gate the two engine changes. Do not build the flow package on top
of unverified engine changes; land and probe the engine changes first
(Section 11 ordering).

---

## 9. E2E test plan

Per the standing e2e rule, build a fixture repo under
`tests/fixtures/sweep-fixture/` with a known N seeded findings (a tsconfig with
strict on producing exactly 12 tsc errors across 5 files, or an `.eslintrc`
enabling a rule that flags exactly N violations across M files). The oracle is
the real tsc/eslint binary invoked as the run-verification scanner, not a mock,
so assertions run against genuine exit codes. Five assertions in
`tests/runner/sweep-e2e.test.ts`, each targeting the engine's disposition (floor
blocked, latch open), not prose, plus the standard flow-facts,
catalog-completeness, and check-flow-drift coverage.

- **A. Happy path.** Run Sweep at autonomous depth. Assert the recorded count
  trajectory across `sweep.scan@v1` reports ends at 0, the run closes
  `@complete` only on a zero rescan, and no `@complete` occurs while
  `remaining_count > 0`.
- **B. Suppression anti-cheat.** Force a worker to "fix" a finding by inserting
  an inline `// eslint-disable-next-line` / `@ts-expect-error` instead of real
  code. Assert the scanner count dropped for that file BUT the suppression-audit
  exit is nonzero, so `overall_status = 'failed'`, `goal_met` is disposed false,
  and the run exits needs-attention via `close`. Proves count-zero alone cannot
  close the loop.
- **C. Config-tamper anti-cheat.** Force a worker to weaken the frozen config
  (lower a rule to off). Assert the `FrozenEvalGuard` fingerprint drifts, the
  latch opens, and the run can only end needs-attention even though the naive
  count is now 0.
- **D. Command-narrowing anti-cheat** (new, gates engine change 2). Two vectors.
  (D1, plan-argv) Force a worker to edit `plan.json` to narrow the scanner argv;
  assert the rescan still runs the **snapshotted full command** (the narrowed
  plan is ignored, not merely detected), so `remaining_count` cannot reach zero
  by narrowing. (D2, script-body) Force a worker to rewrite the `package.json`
  verify-script body to a no-op while leaving `npm run verify` intact; assert the
  script-body fingerprint drifts, `scanner_fingerprint_ok` is false, the rescan
  fails, and the run cannot close `@complete` even though the no-op exits 0. D2
  is the acceptance test for the bundled script-body fingerprint; ship it green
  or the pin is a false floor. Also add a restore-before-tail-seam TOCTOU test
  proving the rejected Approach A would have missed D1.
- **E. Nested-config-create anti-cheat** (new, gates Section 6.3). Force a
  worker to create a new nested config disabling the rule for a subtree. Assert
  the re-derived effective config changes / `new_config_files[]` is non-empty,
  the rescan fails, and the run cannot close clean.

B and C prove the two silence paths the first pass covered; D and E prove the
two the review found open. Together they establish that "succeeded" is
unreachable except by real fixes over the full census set.

---

## 10. Files to create and edit

Flow package (`src/flows/sweep/`), modeled on `fix-until-green` throughout:

- `flow.ts` — one-line adapter: `export const sweepFlowDefinition =
  defineFlowData(sweepFlowData)`.
- `data.ts` — `sweepFlowData`: `id: 'sweep'`, `visibility: 'internal'`,
  `paths.schematic`, `schematic: assembleFlowSchematic(sweepAssemblySpec)`,
  reports, `structuralHints` (reuse `convergeJudgmentRelayShapeHint`).
- `assembly-spec.ts` — the heart. `sweepAssemblySpec`: the five `BlockStepUse`
  steps, `stageLabels`, `contract_aliases`, `axes { supports_autonomous: true }`,
  and `engine_flags.iterates_until_condition` (head `partition-step`, tail
  `judge-step`, `body_steps` the four loop steps, `reenter_route: 'advance'`,
  `max_iterations: 5`, `stop_judge` with `progress_path: 'remaining_count'`,
  `needs_attention_route: 'close'`, `carried_notes`, `no_progress_ceiling: 2`,
  `frozen_paths` the census config surface, `activate_when_depth_at_least:
  'autonomous'`).
- `reports.ts` — Zod schemas with globally-unique names: `SweepCensus`,
  `SweepFindings`, `SweepPartition` (disjoint-files `superRefine`),
  `SweepUnitFix`, `SweepWaveAggregate`, `SweepScan` (VerificationResult
  extended). Reuse `VerificationCommand`/`VerificationResult` and
  `converge.judgment@v1`.
- `relay-hints.ts` — reuse `convergeJudgmentRelayShapeHint`; add a
  `sweep.unit-fix@v1` worker hint: fix by changing code only; never add a
  suppression directive; never touch the config.
- `writers/census.ts` — resolves scanner + audit + config surface, fingerprints
  the scanner argv and (for `npm run <script>` shapes) the resolved script body,
  runs the scanner once, parses the finding list, records the targeted set and
  suppression baseline.
- `writers/partition.ts` — groups survivors into per-file / shared / serial /
  project units, emits the disjoint-refined report with `covers_all_findings`,
  and applies serial-fallback-on-stall.
- `writers/verification.ts` — rescan: runs the pinned scanner + audit, derives
  status from observed exit codes, parses `remaining_count`, `suppression_count`,
  fresh `findings[]`, re-derives effective config, checks fingerprint and
  set-identity.
- `schematic.json` — generated by `npm run emit-flows`, never hand-authored;
  check-flow-drift enforces it.

Edits:

- `src/flows/catalog.ts` — add `sweepFlowDefinition`. No engine edits for the
  flow package itself; registries derive from the catalog.
- `tests/fixtures/retained-flow-ids.ts` — add `'sweep'`.
- `tests/fixtures/sweep-fixture/` — e2e fixture repo (happy path, suppression
  cheat, config tamper, command narrowing, nested config create).
- `tests/runner/sweep-e2e.test.ts` — the five assertions.

Engine (general primitives, land and probe first, Section 7):

- `src/runtime/executors/fanout.ts` — per-wave branch-dir clear, gated on
  `activeSliceIndex` (not path-scoping; the aggregate stays fixed-path and
  in-memory).
- `graph-runner.ts` + `src/runtime/executors/verification.ts` — oracle-command
  pin (snapshot the resolved command at loop entry, serve the cached list in the
  loop body, gated on `honestyLedger`, keyed per step) plus the `package.json`
  script-body fingerprint. No writer or schema edit.

---

## 11. Build-readiness verdict and ordered plan

**Verdict.** Sweep is worth building and is buildable. Its core honesty story is
sound and verified. It is **not** a zero-engine-edit flow: it needs two small
general engine primitives, and its anti-cheat gate needs the four additions in
Section 6. With those, "succeeded" is unreachable except by real fixes over the
full census set, which is the property that makes Sweep a credible flagship
evidence demo. Ship internal first under the freeze.

**Ordered build plan:**

1. Land engine change 1 (per-wave fanout branch-dir clear, gated on
   `activeSliceIndex`) with its own unit test, plus a run-history-ingest guard
   test; run probe 4.
2. Land engine change 2 (oracle-command pin, snapshot-at-loop-entry) **bundled
   with the `package.json` script-body fingerprint** — never the argv pin alone,
   which is a false floor for the `npm run <script>` shape. Unit tests: the
   narrow-plan-mid-loop test, the restore-before-tail-seam TOCTOU test (proves
   the rejected Approach A is insufficient), and the script-body-swap test; run
   probe 5. Add a `fix-until-green` regression for the plan-argv and script-body
   vectors only (config narrowing there stays open by design).
3. Run probes 1, 2, 3 on a real target repo to lock the per-tool specifics
   (file-less finding volume, config enumeration, suppression audit mode).
4. Build the `src/flows/sweep/` package against the now-landed engine primitives.
5. Build the fixture repo and the five e2e assertions; get A through E green.
6. `npm run verify` (full, not fast, because this touches bundled surfaces and
   engine paths), then hand to Pete for the internal-versus-public promotion
   decision.

**Launch implication (Pete's call).** Sweep as the flagship also motivates a
general honesty hardening of the loop substrate (the two engine primitives).
That is a stronger, more honest launch narrative than "composes only shipped
primitives." It also hardens `fix-until-green`, though only partially: the pin
plus script-body fingerprint closes command narrowing there, but the
config-narrowing vector stays open until `fix-until-green` gets its own
`frozen_paths` and config re-derivation, so do not sell it as making
`fix-until-green` fully honest. The alternative is to hold Sweep for a
fast-follow and lead the launch with the existing five flows. Either is
defensible; this spec makes Sweep ready if we want it.
