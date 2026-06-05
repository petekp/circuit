# Schemas

`src/schemas/` owns the persisted and public contracts Circuit depends on:
config, traces, reports, flow files, generated manifests, and host-facing
shapes.

Schemas are Zod first and TypeScript second. Prefer a schema when a shape is
stored, parsed, relayed, or shown to a host.

The root barrel, `index.ts`, stays complete for public/schema consumers. Family
barrels are reader aids for internal imports:

- `run-index.ts`
- `flow-index.ts`
- `host-index.ts`
- `policy-index.ts`
- `evidence-index.ts`

## Main Groups

| Files | Own |
| --- | --- |
| `compiled-flow.ts`, `flow-schematic.ts`, `flow-blocks.ts` | Flow authoring and compiled graph contracts. |
| `step.ts`, `stage.ts`, `route-policy.ts`, `check.ts` | Step, stage, route, and check contracts. |
| `run.ts`, `run-status.ts`, `trace-entry.ts`, `operator-summary.ts`, `result.ts` | Run-folder, trace, summary, and final result shapes. |
| `runtime-evidence.ts`, `process-evidence.ts`, `proof-assessment.ts` | Runtime and process evidence contracts. |
| `config.ts`, `selection-policy.ts`, `connector.ts`, `skill.ts` | Config, selection, connector, and skill contracts. |
| `host.ts`, `progress-event.ts`, `runtime-source.ts`, `manifest.ts` | Host and plugin manifest-facing shapes. |

Product vocabulary belongs in [UBIQUITOUS_LANGUAGE.md](../../UBIQUITOUS_LANGUAGE.md).
Keep serialized names exact, but avoid teaching schema internals in product prose.
