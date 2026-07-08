# Sweep e2e fixture

A tiny real project that stands in for a codebase with a mechanical-finding
backlog. `tests/runner/sweep-e2e.test.ts` copies this tree into a fresh temp
directory per case (workers mutate it) and drives the Sweep flow through
`runCompiledFlow`. The census, partition, and rescan steps spawn these scripts
as real subprocesses, so the assertions run against genuine exit codes — only
the fanout workers and the judge are faked, exactly like `fix-until-green`'s
e2e.

## The oracle: dual-channel scanner + suppression audit

- `npm run scan` walks `src/**/*.ts` and reports one finding per file that still
  carries the `NEEDS_FIX` marker and has not been suppressed. It prints
  `{ "findings": [...] }` on stdout (the work-list the census and partition
  read) and exits non-zero while any finding remains (the honesty floor the
  rescan reads). One script, two channels — the whole point of the pinned
  rescan.
- `npm run audit` counts files carrying a `sweep-suppress` directive, prints the
  count, and exits non-zero once any exists. This is the anti-cheat floor: a
  worker that silences a finding instead of fixing it clears the scan but trips
  the audit, so `overall_status` is still `failed`.

## How a worker changes the tree

- A real fix removes the `NEEDS_FIX` marker from the file → the next scan drops
  that finding.
- A suppression adds a `sweep-suppress` directive (keeping `NEEDS_FIX`) → the
  scan passes but the audit fails.
- Editing `tsconfig.json` (the declared frozen path) or rewriting the `scan`
  package-script body are the two tamper vectors the engine's frozen-eval guard
  and oracle-command pin latch against; the e2e drives both.

`tsconfig.json` is never compiled here (the node scanner is the oracle); it
exists only as the frozen config surface the `frozen_paths` flag protects.
