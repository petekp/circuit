# First Run

Use this path when you want the smallest safe proof that Circuit is installed,
can see its packaged flows, and can write a run folder.

The MCP path in Codex currently supports macOS. It requires Node.js 22.18 or
newer and Codex 0.144.3 or newer. A single MCP approval is normal on first use.
If Codex tries to run Circuit through a shell or asks for sandbox escalation,
the setup has failed. Stop instead of approving that workaround.

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
node "$HOME/.claude/plugins/cache/circuit/circuit/<version>/scripts/circuit.js" doctor
```

Public Codex marketplace install:

```bash
ls "$HOME/.codex/plugins/cache/circuit/circuit/"
node "$HOME/.codex/plugins/cache/circuit/circuit/<version>/scripts/circuit.js" doctor
```

Codex plugin from this checkout:

```bash
node plugins/codex/scripts/circuit.js doctor
```

Synced Codex development-only plugin cache:

```bash
ls "$HOME/.codex/plugins/cache/circuit-local/circuit/"
node "$HOME/.codex/plugins/cache/circuit-local/circuit/<version>/scripts/circuit.js" doctor
```

Claude Code package from this checkout:

```bash
node plugins/claude/scripts/circuit.js doctor
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
<!-- path-ok:begin -->
Each host package ships a small `scripts/circuit.js` front door. It checks the
Node version, prints a legible error on anything older than 22.18, and then
hands off to the real `scripts/circuit.ts` wrapper that launches the bundled
runtime. Invoke `circuit.js`. In this checkout the packages are
`plugins/claude/scripts/` and `plugins/codex/scripts/`.
<!-- path-ok:end -->


## 2. Preview Before You Spend

In Codex, first ask the installed MCP server for a free readiness check:

```text
Use Circuit to list recent Circuit runs for this workspace. Do not start a run.
```

The response should identify the current workspace and start no worker. This
proves the real plugin loader and Circuit tool are available before model spend.

Before your first real run, look at what a run would do without paying for one.
`circuit preview` is spawn-free: it never runs a connector, so it costs nothing.
For a flow, it shows each relay step's resolved connector, model, and effort, and
where each choice came from.

CLI from this checkout:

```bash
./bin/circuit preview review
```

With no flow named, it surveys every public flow at the current dial:

```bash
./bin/circuit preview
```

Turn the Power dial and see the effect before committing. `--matrix` shows one
flow across all three dials, high, medium, and low, side by side:

```bash
./bin/circuit preview review --matrix
```

Add `--power <auto|low|medium|high>` to preview a single dial, or `--json` for
machine-readable output.

### Cost and time

Time to first value is about ten minutes: install, doctor, this preview, and a
first Review result. Per-run cost is not a fixed number. It depends on the
connector and model each relay resolves to and on the Power dial, which trades
depth for spend. Use `circuit preview` above to see the exact model and effort
each relay would use at a given dial before you run, then turn the dial down if
you want a cheaper first pass. Review is read-only, so it never edits your
checkout.

## 3. Run Review First

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

## 4. Know What Can Write

Build, Fix, and Prototype may invoke a write-capable worker:

> A worker can edit this checkout.

Use `claude-code` for trusted Claude Code writes, `codex` for first-class Codex
worker writes, and `cursor-agent` for Cursor CLI implementer branches.
