# Codex Plugin Package

This is the Codex package for Circuit. End users should start from the root
[`README.md`](../../README.md) and use `/circuit:run` as the normal Circuit
entry point.

## What Lives Here

- `.codex-plugin/plugin.json`: hand-authored manifest and marketplace text.
- `skills/<id>/SKILL.md`: generated host instructions that Codex reads.
- `commands/<id>.md`: generated command mirrors.
- `flows/<id>/*.json`: generated compiled flow files.
- `hooks/`: hand-authored SessionStart hook support.
- `runtime/circuit.js`: generated bundled runtime.
- `.mcp.json` and `mcp/`: generated, dormant Codex MCP config and bundled server.
- `scripts/circuit.ts`: hand-authored wrapper that launches the bundled runtime.

## Editing Rule

Codex skills are generated host instructions, not local operator skill sources.
Do not hand-edit generated skills, commands, flow JSON, `runtime/circuit.js`, or
the MCP outputs.
Edit the source under `src/`, then run `npm run emit-flows` or
`npm run build-plugin-runtime` as appropriate. `npm run check-flow-drift` proves
the package is still in sync.
