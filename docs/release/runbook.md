# Release runbook

How to cut and publish a Circuit plugin release. This is the standing
process; every release follows it, alpha or stable. The publish scripts
enforce most of it, so the value here is the order, the two manual gates,
and the gotchas that are not encoded anywhere else.

The version source of truth is `plugins/version.json`. Tags look like
`circuit--v<version>`.

## Preconditions

- CI is green on `main`.
- Working tree is clean, branch is `main`, `HEAD` matches `origin/main`.
  The release command refuses to run otherwise.
- Docker is available (the first-run lab needs it).

## 1. Pre-release first-run lab (required gate)

```bash
experiments/first-run-lab/run-lab.sh all
```

The lab replays the documented install funnels in clean containers: fresh
box, no config, no sign-ins, no credentials, no model spend. Read every
transcript under `experiments/first-run-lab/runs/` (gitignored). A
regression in install, first command, `circuit doctor`, or the honest
failure paths is a release blocker; fix it and rerun before going further.

At this point the CLI and Claude funnels test current `main` and the Codex
funnel tests the previous published tag, because containers install over
the network. That is the point: this run proves the funnel you are about
to ship from.

`all` skips the `npm` scenario on purpose: it installs from the live
registry, so before publishing it would only retest the previous version.
It runs in step 8.

Let the machine settle before moving on. The lab is heavy on disk and
network, and steps 5 and 6 run the full gate suite; starting them into the
lab's I/O wake has correlated with gate children being killed mid-run. A
killed gate now says so (it records the signal), but the cheaper fix is not
to stack them back to back.

## 2. Bump the version

```bash
npm run publish:plugins:bump -- --version <next-version>
```

This syncs six files: `plugins/version.json`, both host plugin manifests,
`.claude-plugin/marketplace.json`, the root `package.json`, and the
Codex install ref in `README.md` (`--ref circuit--v<next-version>`).
The lab's codex scenario reads the ref out of the README, so it follows
the bump with no further change. The `check` and `release` targets treat
any of these six drifting apart as a version mismatch.

## 3. Rebuild the runtime bundles

```bash
npm run build
npm run build-plugin-runtime
```

Order matters: the bundles embed the version and are built from `dist/`,
so `build` must run first or the bundles carry stale code under the new
version number.

## 4. Verify, commit, push

```bash
npm run verify
```

Commit everything as `chore(release): bump to v<next-version>`, push to
`main`, and wait for CI. The release command requires `HEAD` to match
`origin/main`, so this push is not optional. Note the README now names a
tag that does not exist yet; publish promptly after CI is green.

## 5. Dry-run the release

```bash
npm run publish:plugins:release
```

Without `--yes` this runs the full gate suite (flow drift, `verify`,
`check-release-ready`, plugin validation, both bundled doctors, a Claude
install smoke) and skips the effectful steps. Read the report it writes.
If `check-release-ready` reports an eval-cadence blocker, run the demanded
evals (they spend real model tokens) or record a waiver before retrying.

As of 0.1.1 no eval carries the `release-or-milestone` cadence, so the
eval-cadence gate stays quiet on a routine release. Two evals moved to
`ad-hoc` when the vanilla-comparison claim was retired:

- **fix-vs-vanilla** measured Circuit against a plain agent run, a claim we
  no longer make. Keep the harness as an on-demand Fix regression instrument:
  run the Circuit arm alone for the false-fixed rate and skip the vanilla arm,
  which only re-measures the dead claim.
- **verdict-correctness** backs the honesty-floor claim (judges catching
  false-done work). Run it before a release only when that release changes
  verdict admission, judge prompts, or review-step machinery. Otherwise skip.

The deterministic gates below the eval line do the every-release work: the
golden-run proofs, the parity matrix, and the `false-done-fix` test-suite
gate are free and run each time. If we ever publish an eval number again,
restore that eval's `release-or-milestone` cadence the same day so the gate
guards it. A published number and a release gate move together.

## 6. Publish

```bash
npm run publish:plugins:release -- --yes
```

This creates and pushes the `circuit--v<next-version>` tag via
`claude plugin tag`, then verifies the Codex side by adding and upgrading
the marketplace at that tag. Confirm the tag exists on origin afterwards:

```bash
git ls-remote --tags origin | grep <next-version>
```

## 7. Publish the CLI to npm (manual, needs a real terminal)

```bash
npm publish --access public
```

The plugin release and the npm package are two separate publications, and
nothing in the scripts does this one. Skipping it is the quiet failure
mode: the tag and both host plugins move to the new version while
`npm install -g @petepetrash/circuit` keeps serving the old one, bugs and
all. This step needs an interactive terminal because the npm login is a
browser flow, so an agent session cannot do it. Confirm afterwards:

```bash
npm view @petepetrash/circuit version
```

## 8. Post-publish first-run lab (required gate)

```bash
experiments/first-run-lab/run-lab.sh all
experiments/first-run-lab/run-lab.sh npm
```

Same battery, different meaning: the Codex funnel now installs the tag you
just published and the Claude funnel installs the bumped `main`. The `npm`
scenario is the only one that proves what the registry actually serves, so
it runs here and only here, pinned to the version in
`plugins/version.json`. These transcripts are the release's first-run
proof. Read them before announcing or closing out; a finding here is a
fast-follow fix, not something to sit on.

Every funnel ends in nonzero exits by design, because the containers have
no connectors and no credentials. Read them as shapes, not failures:
`doctor` exits 1 with a per-connector Fix line, `demo` exits 1 by refusing
at the connector gate before spending anything, a Review of untracked
files exits 1 at the consent gate, and usage mistakes exit 2. An exit 0
where one of those belongs is the real regression.

## 9. Release notes

If the release changes operator-visible behavior, add
`docs/release/<version>-notes.md` following the existing alpha notes.
