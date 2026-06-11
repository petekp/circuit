# Eval ledger

A committed record that a release-grade eval actually ran, and what it scored.

Raw `results/` dirs are gitignored, so without this ledger nobody can tell
whether reviewer or fix quality moved across releases, and the registry's
`cadence: release-or-milestone` field is enforced by nothing. Each ledger
entry is a small, scrubbed JSON file under `evals/ledger/<eval-id>/`.

## What an entry holds

Summary-level numbers only: the eval id, the run timestamp (`ran_at`), the
repo commit it measured, the model, short descriptors (judge, suite, set),
and numeric headline metrics. It holds **no prompts, no absolute paths, and
no task source text**. The builders in `scripts/evals/shared/ledger.ts` are an
allowlist — they copy only named safe fields, so a future summary growing a
new sensitive key cannot leak it here. `scripts/evals/validate-ledger.ts`
(run by `npm run check-evals`, and therefore `verify`) is the second line: it
re-scans every string for path/newline/"prompt" poison and rejects malformed
entries.

## Adding an entry

```bash
# fix-vs-vanilla: model/commit/set come from summary.json; the timestamp comes
# from the result dir name.
node --experimental-strip-types scripts/evals/append-ledger.ts \
  evals/fix-vs-vanilla/results/<dir>

# verdict-correctness: pass the commit and suite (older summaries predate those
# fields); the model comes from model.txt unless you pass --model.
node --experimental-strip-types scripts/evals/append-ledger.ts \
  evals/verdict-correctness/results/<dir> \
  --repo-commit <sha> --suite standard
```

Add `--print` to preview the entry without writing it.

## Cadence gate

`npm run check-release-ready` (the release-time gate, not part of `verify`)
fails if any `release-or-milestone` eval has no ledger entry newer than the
last release tag. The version comes from `plugins/claude/.claude-plugin/plugin.json`;
the last-release marker is the most recent `circuit--v*` git tag.

## Waivers

To ship without a fresh run for one eval, add a file under
`evals/ledger/waivers/` named `<eval-id>-<version>` (any extension, `.md`
suggested) explaining why. The waiver is keyed to that exact version, so it
cannot silently carry forward to the next release.
