# Implementation guide — recommended follow-ups (F7, F9, F10, F6 residual)

Status: work order written 2026-07-03 against main @2b697de7. These are the
open items from the v1 surface-test "recommended, not blocking" bucket
(numbering follows [v1-surface-test-results.md](v1-surface-test-results.md)).
They are hardening gates and proof coverage, not behavior bugs — Circuit works
as advertised without them. Each item is independent; land them as separate
commits (or separate PRs), smallest first.

Already closed, do not redo: F8 (proofs README no longer claims a stray-file
gate), the Node-floor guard (19af262c), the proof-stub freshness guard
(2c397dd6), and F14 slice 1 (2b697de7). F14 slices 2/3 have their own handoff
at [f14-interrupted-run-recovery-handoff.md](f14-interrupted-run-recovery-handoff.md)
and are NOT part of this work order unless Pete says so.

## Ground rules for the executor

1. Read `AGENTS.md` first. Its rules apply, especially: failing test first for
   any behavior change; plain-English operator-facing text; the engine
   (`src/runtime/`) does not get edited for any of these items.
2. `npm run build` before anything that executes scripts against `dist/`
   (proof capture and the stub guard both need a fresh build).
3. Full `npm run verify` must be green before each commit. `verify:fast` does
   NOT run the release-infra gates these items touch — do not trust it as the
   final check here.
4. Known lint gotchas: biome enforces import sort and template literals; run
   `npx biome check --write <file>` before hand-fixing. Some contract tests
   are wrap-sensitive on generated docs.
5. None of these items should touch `src/` (except possibly F9's probe
   findings — see below). If you find yourself editing engine or CLI source,
   stop and re-read the item; the design avoids it on purpose.
6. Proof recaptures churn known-noise fields (see "Known noise classes" in
   [proofs/README.md](proofs/README.md)): relay/verification `duration_ms`,
   tournament child run UUIDs, the doctor transcript. Diffs in ONLY those
   fields are fine to commit; a diff in any other field is a behavior change —
   investigate before committing.

---

## Item 1 — F9: golden proof for the standard (non-tournament) Explore path

**Smallest item. Do it first.**

**Problem.** Both committed Explore proofs (`explore-decision`,
`explore-autonomous-decision`) pass `--tournament`. The standard Explore path
— the one a first-time operator most likely runs — has no golden proof.

**Probe before building** (rule 7 in AGENTS.md). Confirm what the standard
path actually does before writing the scenario:

```bash
npm run build
./bin/circuit run explore --goal "decide: React vs Vue" --run-folder /tmp/f9-probe --progress jsonl
```

with a stub relayer if needed — look at how existing scenarios in
`scripts/release/capture-golden-run-proofs.ts` inject `relayer`. Answer two
questions from the probe: (a) does the standard path reach a checkpoint
(tradeoff-request) like the tournament path does, and therefore need a
`resumeChoice` in its scenario? (b) which report files does it write (they
become `backing_paths`)? Do not guess either answer.

**Build the scenario** following the four-coupled-pieces procedure in
[proofs/README.md](proofs/README.md) § "Adding a scenario", using the existing
`explore-decision` scenario as the template:

1. `Scenario` entry in `scripts/release/capture-golden-run-proofs.ts` — slug
   `explore-standard` (or similar), unique `runId`, unique `startMs`, argv
   WITHOUT `--tournament`. Relayer stub bodies must satisfy Explore's report
   schemas in `src/flows/explore/reports.ts`. Explore does not write code, so
   no `prepareProject` fixture is needed (mirror what `explore-decision`
   does).
2. `docs/release/proofs/index.yaml` entry — id `proof:explore-standard`,
   command mirroring the capture argv exactly (a test pins this),
   `required_files`, `backing_paths` from the probe, `status:
   verified_current`.
3. Test pins in `tests/release/release-infrastructure.test.ts` — add to the
   expected-outcome map and the command-string consistency map.
4. Regenerate: `npm run capture-proofs:golden-runs -- --scenario
   explore-standard`, then `npm run emit-release`.

**Done when:** the new `runs/explore-standard/` tree is committed, `npm run
check-release-infra` passes (this now includes the stub-freshness guard, which
will exercise your new stub), release tests pass, and full verify is green.
No other scenario's proof bytes changed (if they did, you recaptured too much
— revert them).

---

## Item 2 — F7: proof-recency gate

**Problem.** Nothing detects that committed proofs have gone stale relative to
current behavior. F1 (capture crashing at a stale stub) stayed invisible for
weeks because the only automated pressure on proofs was the eval cadence gate.
The stub-freshness guard (2c397dd6) closed the *abort* class: a scenario that
now crashes on a schema mismatch fails the gate. It does NOT close the *drift*
class: a scenario that still runs fine but produces a different outcome or
different reports than the committed proof claims.

**Recommended design: extend the existing guard, do not build a new harness.**
`scripts/release/capture-golden-run-proofs.ts` already has a
`--validate-stubs` mode that runs every scenario through the real runtime into
a temp folder without persisting proofs (`validateScenarioStubFreshness`).
That fresh run is exactly the evidence a recency gate needs — today we only
check its `reason` for schema-failure signatures and throw the rest away.
Extend the same pass to also compare the fresh run against the committed proof:

1. After the fresh run completes (and is not a schema failure), load the
   committed `docs/release/proofs/runs/<slug>/result.json`.
2. Compare **semantic fields only**, starting minimal:
   - `outcome` (fresh vs committed) — this is the core recency signal; the
     index.yaml `expected_outcome` is prose, `result.json.outcome` is the
     machine truth.
   - the SET of report files produced under the run's `reports/` directory
     (names only, not bytes) vs the committed run's report set.
   Do NOT compare bytes or timestamps — the known noise classes make that a
   flaky gate, which is worse than no gate.
3. On mismatch, fail with a message that names the scenario, the field, both
   values, and the fix: `npm run capture-proofs:golden-runs -- --scenario
   <slug>`, then review the diff per the proofs README.
4. Keep it in the same npm script (`check-proof-stubs:nobuild`) — one pass,
   two checks — but update the script's failure text and the proofs README
   bullet (§ "When missing or stale proofs block release") to say it now
   catches both stale stubs and drifted outcomes. Consider renaming the npm
   script only if you also update every reference (grep first); keeping the
   name is fine.

**Scope discipline.** Start with the two comparisons above. Do not add
per-field report-content comparison in this pass — that is a deeper design
with real false-positive risk, and the minimal version already catches the F1
class one step earlier. If you see an obvious cheap extension, note it in the
commit message instead of building it.

**Watch-outs:**
- Scenarios with `resumeChoice` produce their final outcome only after the
  resume leg — `validateScenarioStubFreshness` already handles this; make
  sure you compare the post-resume outcome.
- The `abort` scenario intentionally aborts. Its committed outcome IS
  `aborted`; the comparison must treat that as a match, not special-case it
  away.
- The doctor and handoff captures are not `Scenario` entries and are out of
  scope — the gate covers the scenarios list only, same as today.

**Test.** The guard is a script, so prove it the way 2c397dd6 was proven, and
leave the proof executable: add a test (or extend the release-infra tests)
that runs the validator against a scenario whose committed `result.json`
outcome has been copied to a temp fixture and tampered with, asserting the
gate goes red naming the scenario and field, and green on the untampered
fixture. If wiring a fixture through the script is disproportionate, a
narrowly-scoped unit test of the comparison function is acceptable — but the
comparison logic must then live in an exported function, not inline.

**Done when:** tampering with a committed outcome (locally, unstaged) turns
`npm run check-proof-stubs:nobuild` red naming the drift; restoring turns it
green; the proofs README documents the widened gate; full verify green.

---

## Item 3 — F10: cross-repo gate on the landing dial matrix

**Problem.** The landing page (repo `~/Code/circuit-land`) vendors the output
of `circuit preview --matrix --json` (the dial/model allocation table). Nothing
detects when the engine's matrix changes and the landing copy silently drifts.
The surface test found them equal today (T2.9) by manual comparison only.

**This item spans two repos — its blast radius is outward (the public landing
page). Implement it, but flag the PR to Pete rather than merging circuit-land
changes autonomously.**

**Recommended shape (option a): the gate lives in circuit-land and treats
circuit as the source of truth.**

1. In circuit-land, locate the vendored matrix data (grep for the dial values
   or `preview` in the landing source; memory says it was vendored from
   `preview --matrix --json` when the dial section shipped in circuit-land
   #17/#18).
2. Add a script to circuit-land (e.g. `scripts/check-dial-matrix.mjs`) that: <!-- path-ok -->
   - regenerates the matrix from the pinned circuit version. Prefer
     installing circuit at the tag circuit-land currently advertises
     (`npx github:petekp/circuit#circuit--v0.1.0-alpha.9 preview --matrix
     --json`, or clone-at-tag + `npm ci && npm run build` if npx cannot
     execute the repo directly — probe which works before committing to one),
   - normalizes both sides (stable key order, no timestamps),
   - diffs against the vendored data and fails with the exact mismatch and
     the refresh command.
3. Wire it into circuit-land's existing CI/gate script chain (it already has
   gates from the doc-rot work — follow the local convention).
4. Add a companion refresh script (`--write` flag on the same script) so
   fixing a legitimate drift is one command, not hand-editing.

**Why not a gate in the circuit repo (option b):** circuit's CI would need the
landing repo checked out, inverting the dependency and coupling engine CI to a
marketing repo. The landing page is the consumer; the consumer checks its own
vendored copy. If installing-at-tag in circuit-land CI proves too slow or
flaky, the fallback is a committed checksum: circuit-land stores the sha256 of
the normalized matrix JSON it vendored plus the circuit tag it came from, and
the gate just recomputes the checksum of the vendored data — that catches
accidental landing-side edits (the likelier drift) at zero install cost, and
tag bumps force a deliberate refresh. State in the PR which variant you built
and why.

**Done when:** circuit-land CI fails if the vendored matrix is hand-edited or
the pinned engine's matrix changes (or, in the checksum variant, if the
vendored data is edited without the deliberate refresh); the refresh path is
one command; the PR is open against circuit-land and flagged for Pete —
do not merge it yourself.

---

## Item 4 (optional, lowest priority) — F6 residual: harvest subprocess test

**Problem (residual only).** `handoff-harvest.test.ts` covers harvest logic
in-process, and `plugin-node-floor.test.ts` proves the harvest `.js` shim
survives old Node. What is still untested is the middle: the real
`plugins/claude/hooks/harvest.js` → `harvest.ts` path executing end-to-end as
a subprocess on CURRENT Node with realistic host hook-input JSON on stdin
(AGENTS.md rule 6: hooks read workspace identity from stdin, never cwd).

**Shape:** one test file, spawn `node plugins/claude/hooks/harvest.js` with a
fixture hook-input JSON (find the shape the Claude host sends — grep the hook
source for what it parses from stdin) and a temp project root; assert it exits
0 and writes the ambient record where the project root (not cwd) dictates.
Run it from a DIFFERENT cwd than the project root to actually pin rule 6.

**Done when:** the test fails if someone reintroduces a `process.cwd()`
dependency in the hook path, and full verify is green. If the hook's stdin
contract turns out to be undocumented and ambiguous, stop and write down what
you found instead of guessing — that finding is worth more than the test.

---

## Sequencing and commit discipline

Order: **F9 → F7 → F6 residual → F10** (F10 last because it needs Pete's
review anyway and lives in the other repo; everything else lands on circuit
main independently).

Per item: one commit, message explains the WHY (the gap, not just the
mechanism), full verify green before committing, push circuit items to main,
open a PR for the circuit-land item. If any item turns out to be bigger than
described here (e.g. the F9 probe reveals the standard explore path is broken,
or the vendored matrix cannot be located), stop that item, write down exactly
what you found, and move to the next — do not improvise a redesign.
