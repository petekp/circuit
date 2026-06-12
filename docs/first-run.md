# First Run

Use this path when you want the smallest safe proof that Circuit is installed,
can see its packaged flows, and can write a run folder.

## 1. Run Doctor

Run the doctor for the package you are testing.

For local checkout testing, refresh the installed host caches before you run
host-surface checks:

```bash
npm run plugins:refresh-local
```

From a checkout, `npm run doctor:plugins:installed` resolves the current
version and doctors both installed host caches. The commands below cover the
no-checkout case. Substitute `<version>` with the installed version; list the
cache directory to find it.

Claude Code marketplace install:

```bash
ls "$HOME/.claude/plugins/cache/circuit/circuit/"
node "$HOME/.claude/plugins/cache/circuit/circuit/<version>/scripts/circuit.ts" doctor
```

Codex plugin from this checkout:

```bash
node plugins/codex/scripts/circuit.ts doctor
```

Synced Codex plugin cache:

```bash
ls "$HOME/.codex/plugins/cache/circuit-local/circuit/"
node "$HOME/.codex/plugins/cache/circuit-local/circuit/<version>/scripts/circuit.ts" doctor
```

Claude Code package from this checkout:

```bash
node plugins/claude/scripts/circuit.ts doctor
```

Doctor checks the packaged plugin files, command wrapper, generated flows,
bundled runtime, and basic Review/checkpoint behavior. A passing doctor prints
JSON with:

```json
{
  "status": "ok",
  "runtime_source": "bundled"
}
```

`runtime_source: bundled` means the host package is using the runtime it
shipped with, not a `circuit` binary from `PATH`.

The checked-in doctor proof is
[`docs/release/proofs/runs/doctor/output.txt`](release/proofs/runs/doctor/output.txt).
The wrapper is `scripts/circuit.ts` inside each host package; in this checkout
that is `plugins/claude/scripts/circuit.ts` and
`plugins/codex/scripts/circuit.ts`.

## 2. Run Review First

For the safest first real run, use Review. Review is read-only:

Claude Code:

```text
/circuit:run review this checkout for obvious release blockers
```

Codex:

```text
/circuit:run review this checkout for obvious release blockers
```

CLI from this checkout:

```bash
./bin/circuit run review --goal 'review this checkout for obvious release blockers'
```

The Review proof shows the expected final shape:

- [`docs/release/proofs/runs/review/operator-summary.md`](release/proofs/runs/review/operator-summary.md)
  is the user-facing summary.
- [`docs/release/proofs/runs/review/result.json`](release/proofs/runs/review/result.json)
  records `selected_flow`, `outcome`, `run_folder`, and report paths.
- [`docs/release/proofs/runs/review/run/trace.ndjson`](release/proofs/runs/review/run/trace.ndjson)
  is the trace.
- [`docs/release/proofs/runs/review/run/reports/review-result.json`](release/proofs/runs/review/run/reports/review-result.json)
  is the typed Review report.

Every normal run writes the same kind of evidence under a run folder:

```text
.circuit/runs/<run-id>/
  manifest.snapshot.json
  trace.ndjson
  reports/
    result.json
    operator-summary.md
    <flow-specific reports>.json
```

## 3. Know What Can Write

Build, Fix, Prototype, and Pursue may invoke a write-capable worker:

> A worker can edit this checkout.

Use `claude-code` for trusted Claude Code writes, `codex` for first-class Codex
worker writes, and `cursor-agent` for Cursor CLI implementer branches.
