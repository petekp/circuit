# Flow Packages

`src/flows/` owns Circuit's built-in flows. `src/flows/catalog.ts` is the
locked source of truth for the flow set and which flows are internal.

Most public flows have:

| File | Purpose |
| --- | --- |
| `data.ts` | Source of the flow shape. Start here for behavior. |
| `reports.ts` | Flow-specific report schemas. |
| `command.md` | Optional source for a direct command surface. Pursue ships one today (`src/flows/pursue/command.md`, the flow-owned source for `/circuit:pursue`). |
| `relay-hints.ts` | Worker-facing guidance. |
| `writers/` | Flow-specific report and summary writers. |
| `schematic.json` | Generated output. Do not edit directly. |
| `contract.md` | Contract notes when the flow needs them. |

Use [docs/flows/authoring-model.md](../../docs/flows/authoring-model.md) for
the flow-authoring playbook and [docs/generated-surfaces.md](../../docs/generated-surfaces.md)
for generated output ownership.

Public flow packages emit host mirrors under `plugins/` and compiled files under
`generated/flows/`. Internal packages emit generated flow files only.
