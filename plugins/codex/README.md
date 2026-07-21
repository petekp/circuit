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
- `.mcp.json` and `mcp/`: generated Codex MCP config and its self-contained runtime files.
- `scripts/circuit.ts`: hand-authored wrapper that launches the bundled runtime.

## MCP Status

The packaged MCP bridge is experimental. Start and resume require live host,
metadata, asset, and nested-sandbox checks. The bridge fails closed when any
check is missing or uncertain; it does not fall back to the ordinary CLI or a
weaker configuration. Nested workers use a practical Codex-equivalent boundary.
Codex may expose host-managed shared temporary directories; Circuit treats them
as untrusted, never uses them for credentials or MCP control state, and does not
block a run for that host limitation. Proof commands remain under a stricter
Seatbelt boundary. The package remains experimental until the real plugin
loader, trusted workspace metadata, and the public flow lifecycle pass the
fresh-host proof.

## Editing Rule

Codex skills are generated host instructions, not local operator skill sources.
Do not hand-edit generated skills, commands, flow JSON, `runtime/circuit.js`, or
the MCP outputs.
Edit the source under `src/`, then run `npm run emit-flows` or
`npm run build-plugin-runtime` as appropriate. `npm run check-flow-drift` proves
the package is still in sync.
