# Release Proofs

`runs/` contains committed release proof files captured by the release proof
scripts. These are not casual examples. They are fixtures that back public
release claims and are parsed by the release infrastructure tests.

Update them with:

```bash
npm run capture-proofs:golden-runs
```

The release tests enforce that proof paths stay under `docs/release/proofs/runs`
and that the old `examples/runs` location does not come back.

## Lifecycle

Every scenario in `index.yaml` has a `status`. Only `verified_current` proofs
back public claims. Any other status is treated as planned and blocks the
readiness IDs that scenario references.

**When to regenerate.** Run `npm run capture-proofs:golden-runs` whenever you
change something a proof asserts:

- runtime control flow, recovery routes, or terminal outcomes
- a flow's stage path, report schema, or operator-summary shape
- checkpoint envelope content or the resume contract
- a scenario's command, expected flow, or expected outcome in `index.yaml`
- a new public claim or readiness ID that needs evidence behind it

If you only edited code no scenario exercises, you do not need to regenerate.

**How to review the diff.** Capture writes scrubbed output. Diff each touched
file before committing:

- `run/reports/**` — expect structural diffs only; IDs, paths, and timestamps
  are scrubbed. A real shape change should be intended.
- `operator-summary.md` — read it as a user would. If the wording got worse,
  the product regressed; do not paper over it by committing the new bytes.
- `result.json` — compare verdict, outcome, and next-action fields against
  the scenario's `summary_contract` in `index.yaml`.

**When missing or stale proofs block release.** `npm run check-release-infra`
fails on:

- declared `required_files` missing on disk
- a scenario referenced by a public claim or readiness ID whose status is
  not `verified_current`
- a relay stub whose body no longer satisfies its flow's current report
  schema, **or** a committed proof that has drifted from current behavior
  (the stub-freshness and recency guard). It runs every scenario through the
  real runtime without writing proofs, and fails loudly on either class:
  - **stale stub** — the run aborts on a report-schema mismatch. When a flow
    tightens a report schema, its capture stub can silently drift and the next
    full capture aborts mid-run. The guard names the stale stub and schema.
  - **stale proof** — a clean run's terminal outcome or top-level report-file
    set no longer matches the committed proof. Behavior moved but the golden
    run was never refreshed. The guard names the scenario, the drifted field,
    and both values.

  It compares semantic fields only — the outcome and the set of report file
  names, never bytes or timestamps — so the known noise classes below do not
  make it flaky. Run it directly with `npm run check-proof-stubs:nobuild`
  (after a build); fix a stale stub by updating the relay stub body, fix a
  stale proof by recapturing
  (`npm run capture-proofs:golden-runs -- --scenario <slug>`), then review the
  diff.

There is no automated gate on stray files inside `runs/`; capture should
write only declared paths, and leftovers are caught by reviewing
`git status` after a recapture.

Fix by regenerating, not by downgrading the scenario's status.

## Known noise classes

Captures are deterministic in every semantic field: outcomes, report
shapes, claims, and timestamps (the capture script injects a fixed
clock). A back-to-back recapture still produces small diffs in:

- runtime-measured relay and verification `duration_ms` values (a few
  milliseconds of wobble)
- tournament child run ids (child runs mint random UUIDs, not values
  derived from the parent run id)
- the doctor transcript (it spawns a real run)

Diffs in those fields are expected. A diff in any other field means the
product changed; review it as a behavior change, not noise.

## Adding a scenario

A proof scenario has four coupled pieces. Add all of them in one change:

1. **Capture entry** in `scripts/release/capture-golden-run-proofs.ts`:
   add a `Scenario` to the `scenarios` list with a unique slug, a unique
   `runId`, and a unique `startMs`. If the flow writes code or runs
   verification, give it a `prepareProject` fixture (a scenario-local git
   repo; see `preparePursueProofProject`) and make every relayer stub
   write its claimed file changes into the fixture before claiming them.
   For flows whose act step carries the changed-files-on-disk acceptance
   criterion (build, fix), that is what lets the honesty gate evaluate
   genuinely instead of being stubbed around; for flows without it, the
   writes keep the stub's claims true and give the live verify step a
   genuinely mutated tree. Stub relay bodies must satisfy the flow's
   report schemas in `src/flows/<id>/reports.ts`.
2. **Index entry** in `index.yaml`: id `proof:<name>`, the exact
   reproduction command (it must mirror the capture argv; a test pins
   this), `required_files`, `backing_paths` for the reports the flow
   writes, and `status: verified_current`.
3. **Test pins** in `tests/release/release-infrastructure.test.ts`: add
   the scenario to the expected-outcome map and to the command-string
   consistency map; pin the flow-level result report if the flow has one.
4. **Regenerated release surfaces**: `npm run capture-proofs:golden-runs`
   (use `--scenario <slug>` to capture just the new one), then
   `npm run emit-release` so the capability and readiness surfaces pick
   up the new scenario counts.

Then run `npm run check-release-infra` and the release tests before
committing the new `runs/<slug>/` tree.
