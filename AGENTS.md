# Agent Guide — circuit

## What this project is

`circuit` is a Claude Code and Codex plugin that runs configurable
developer flows. The product surface is `src/` (TypeScript), `tests/`, the
generated host plugin packages under `plugins/`, the flow packages
under `src/flows/`, the engine contracts under `docs/contracts/`,
and the flow design notes under `docs/flows/`.

Only this guide defines agent rules. Anything else is context.

See [`UBIQUITOUS_LANGUAGE.md`](UBIQUITOUS_LANGUAGE.md) for the canonical product
vocabulary (flow, schematic, block, route, relay, check, trace, report,
evidence). Use that vocabulary in product-facing prose.

## Rules that earned their place

1. **Read before Write.** Always read existing files before overwriting
   them.
2. **Tests for behavior we care about.** When fixing a bug, write a
   failing test first. When changing behavior, the test changes with it.
3. **Plain English with the operator.** Short sentences, one idea each.
   No project-internal jargon — no codename ids, no review-result-class
   language. If a name matters, describe what it is.
4. **Task list for multi-step work.** Three or more steps → use the
   task tools.
5. **Root-cause discipline.** Enumerate two or three hypotheses before
   acting on one.
6. **Host hooks use hook input for identity.** Hook scripts must read the
   host's stdin JSON for workspace identity and pass explicit project roots.
   Do not treat `process.cwd()` as the project authority inside hooks.
7. **File-set audits need probes.** Before a rename, conversion, or migration
   batch, state the partition criterion and run the grep or script that proves
   it. If the plan depends on a runtime contract, run a small probe before
   locking the plan.

## Verification

Use `npm run verify` before claiming a change is done. Use `verify:fast`
during iteration when you need a faster broad check.

```bash
npm run check        # tsc --noEmit
npm run lint         # biome check
npm run test         # vitest (full suite)
npm run test:fast    # vitest excluding the two subprocess-driven outliers: tests/runner/cli-router.test.ts (~10s CLI integration) and tests/unit/emit-flows-drift.test.ts (~30s build+emit subprocesses)
npm run test:coverage # vitest run --coverage (info, no thresholds)
npm run build        # tsc -p tsconfig.build.json
npm run verify       # full canonical check; CI runs this
npm run verify:fast  # check + lint + build + test:fast + the fast gate scripts (~40% faster)
```

`verify` is the canonical check and what CI enforces. Use `verify:fast`
during iterative loops; run full `verify` before claiming a change is
done. Both must pass before commit on changes to `src/`, `tests/`, or
generated host packages.

Choose focused proof before the final check: flow authoring changes need the
`tests/runner/flow-facts.test.ts` and catalog completeness tests plus
`check-flow-drift`; runtime path changes need runtime-context and runtime
tests; generated host package changes need `check-flow-drift`; release-surface
changes need `check-release-infra`.

## Where things live

| File or output | Path |
|---|---|
| Claude Code plugin package | `plugins/claude/` |
| Claude Code plugin manifest | `plugins/claude/.claude-plugin/plugin.json` |
| Claude Code slash commands (generated) | `plugins/claude/commands/<id>.md` |
| Claude Code compiled flow output (generated) | `plugins/claude/skills/<id>/circuit.json` for public flows |
| Codex plugin package | `plugins/codex/` |
| Direct command sources | `src/commands/<id>.md` |
| Flow-owned command sources | `src/flows/<id>/command.md` |
| Generated surface source map | [`docs/generated-surfaces.md`](docs/generated-surfaces.md) |
| CLI entrypoint | `bin/circuit` |
| Engine source | `src/runtime/`, `src/cli/`, `src/schemas/` |
| Flow packages | `src/flows/<id>/` (FlowData, schematic, output schemas, command, contract, writers, relay hints) |
| Flow catalog | `src/flows/catalog.ts` (single source of truth the engine derives from) |
| Tests | `tests/` |
| Documentation map | [`docs/README.md`](docs/README.md) |
| Repository map | [`docs/repository-map.md`](docs/repository-map.md) |
| Engine contracts | `docs/contracts/` |
| Flow design notes | `docs/flows/` |
| Release proof runs | `docs/release/proofs/runs/` |
| Ubiquitous language | [`UBIQUITOUS_LANGUAGE.md`](UBIQUITOUS_LANGUAGE.md) |
| Block catalog | [`docs/flows/block-catalog.json`](docs/flows/block-catalog.json) |

Internal file names such as `relay-hints.ts` are intentional runtime names.
Do not rename them while adding a flow unless there is an explicit
terminology migration in progress.

## Adding a flow

Use [`docs/flows/authoring-model.md`](docs/flows/authoring-model.md#adding-a-flow)
as the flow-authoring playbook. It covers package files, command ownership,
`paths.command`, generated Claude and Codex command/skill surfaces, Codex cache
sync, release metadata, and verification.

Keep this guide short. Link deeper flow playbooks instead of copying them.

The engine (`src/runtime/`) does not need edits for normal flow additions —
registries derive from the catalog. If you find yourself editing engine files
to add a flow, the boundary is being violated.

`CompiledFlowPackage.engineFlags` carries opt-in switches the engine
branches on. See `CompiledFlowEngineFlags` in `src/flows/types.ts` for
the current set and which flows set each flag. Add a flag entry there
if your flow needs special engine behavior — never put flow-specific
code into the engine itself.
