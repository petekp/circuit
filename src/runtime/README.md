# Runtime

`src/runtime/` is the engine layer. It follows a compiled flow, records the
trace, writes reports, handles checkpoints, and closes the run.

It should not own flow-specific product behavior. Add or change a flow in
`src/flows/<id>/`, then let the runtime execute the compiled result.

## Main Areas

| Path | Owns |
| --- | --- |
| `run/` | Graph advancement, checkpoints, child runs, result writing, and close behavior. |
| `executors/` | Step execution for compose, relay, verification, checkpoint, sub-run, and fanout steps. |
| `manifest/` | Loading and validating executable flow packages. |
| `run-files/` | Run-folder paths, report validation, and persisted files. |
| `trace/` | Append-only trace storage. |
| `projections/` | Progress, status, and checkpoint projections. |
| `fanout/` | Parallel branch mechanics. |
| `domain/` | Runtime-internal types for flows, steps, routes, runs, and traces. |

Connector implementations live in `src/connectors/`, and connector
resolution lives in `src/connectors/resolver.ts`.

Use runtime tests for engine mechanics and flow tests for flow behavior.
