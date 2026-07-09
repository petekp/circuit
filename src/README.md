# Source Map

Start here when a change touches TypeScript source. Pick the narrowest owner,
then read that layer's local README if you need more detail.

| Path | Owns |
| --- | --- |
| `src/cli/` | CLI commands and user-visible output. |
| `src/commands/` | Hand-authored command sources mirrored into host packages. |
| `src/connectors/` | Built-in worker connectors. |
| `src/flows/` | Built-in flows, flow catalog, compiler support, and flow-owned writers. |
| `src/history/` | Run-corpus and history-store primitives shared by app history and memory. |
| `src/memory/` | Project memory storage, injection, and memory-input helpers. |
| `src/policy/` | Flow-domain policy: flow-kind rules, fanout join, policy envelope, rubric scoring. |
| `src/runtime/` | Engine mechanics for running compiled flows. |
| `src/schemas/` | Zod contracts for config, traces, reports, flows, and host surfaces. |
| `src/selection/` | Flow-safe relay and connector planning contracts used before runtime connector resolution, plus the Power dial: tier materialization (`power-tiers.ts`) and the auto-dial power inference (`power-inference.ts`). |
| `src/shared/` | Helpers used by more than one source layer. |
| `src/skill-hooks/` | Skill Hook matching, actuation policy, and loaded-skill projection. |
| `src/app/` | Application services that compose the engine for the CLI (run envelope, run status, history, process evidence). |
| `src/release/` | Release metadata helpers. |
| `src/index.ts` | Public package export surface. |

Types come from Zod schemas in `src/schemas/`; prefer a schema first when a
shape is stored, parsed, relayed, or shown to a host.

## Read Next

- Runtime changes: [src/runtime/README.md](runtime/README.md).
- Schema changes: [src/schemas/README.md](schemas/README.md).
- Flow changes: [src/flows/README.md](flows/README.md).
- Shared helper changes: [src/shared/README.md](shared/README.md).
- Flow authoring: [docs/flows/authoring-model.md](../docs/flows/authoring-model.md).

Generated host mirrors belong under `plugins/` and `generated/`. Edit the
source file and regenerate.
