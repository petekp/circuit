# Release runbook

How to cut and publish a Circuit plugin release. This is the standing
process; every release follows it, alpha or stable. The publish scripts
enforce most of it, so the value here is the order, the two manual gates,
and the gotchas that are not encoded anywhere else.

The version source of truth is `plugins/version.json`. Tags look like
`circuit--v0.1.0-alpha.9`.

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

## 2. Bump the version

```bash
npm run publish:plugins:bump -- --version <next-version>
```

This syncs four files: `plugins/version.json`, both host plugin manifests,
and `.claude-plugin/marketplace.json`.

## 3. Rebuild the runtime bundles

```bash
npm run build
npm run build-plugin-runtime
```

Order matters: the bundles embed the version and are built from `dist/`,
so `build` must run first or the bundles carry stale code under the new
version number.

## 4. Update the README install ref

Update the Codex install line in `README.md` to the new tag
(`--ref circuit--v<next-version>`). Nothing bumps this automatically. The
lab's codex scenario reads the ref out of the README, so it follows this
edit with no further change.

## 5. Verify, commit, push

```bash
npm run verify
```

Commit everything as `chore(release): bump to v<next-version>`, push to
`main`, and wait for CI. The release command requires `HEAD` to match
`origin/main`, so this push is not optional. Note the README now names a
tag that does not exist yet; publish promptly after CI is green.

## 6. Dry-run the release

```bash
npm run publish:plugins:release
```

Without `--yes` this runs the full gate suite (flow drift, `verify`,
`check-release-ready`, plugin validation, both bundled doctors, a Claude
install smoke) and skips the effectful steps. Read the report it writes.
If `check-release-ready` reports an eval-cadence blocker, run the demanded
evals (they spend real model tokens) or record a waiver before retrying.

## 7. Publish

```bash
npm run publish:plugins:release -- --yes
```

This creates and pushes the `circuit--v<next-version>` tag via
`claude plugin tag`, then verifies the Codex side by adding and upgrading
the marketplace at that tag. Confirm the tag exists on origin afterwards:

```bash
git ls-remote --tags origin | grep <next-version>
```

## 8. Post-publish first-run lab (required gate)

```bash
experiments/first-run-lab/run-lab.sh all
```

Same battery, different meaning: the Codex funnel now installs the tag you
just published and the Claude funnel installs the bumped `main`. These
transcripts are the release's first-run proof. Read them before announcing
or closing out; a finding here is a fast-follow fix, not something to sit
on.

## 9. Release notes

If the release changes operator-visible behavior, add
`docs/release/<version>-notes.md` following the existing alpha notes.
