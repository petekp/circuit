# Claude Code Plugin Package

This is the Claude Code package for Circuit. End users normally install it from
the marketplace and start from the root [`README.md`](../../README.md).

For from-checkout testing:

```bash
claude --plugin-dir ./plugins/claude
```

## What Lives Here

- `.claude-plugin/plugin.json`: hand-authored manifest.
- `commands/<id>.md`: generated slash-command files.
- `skills/<flow>/*.json`: generated compiled flow files.
- `hooks/`: hand-authored hooks. `session-start.ts` runs on SessionStart to
  surface saved continuity; `harvest.ts` runs on Stop, SessionEnd, and
  PreCompact to harvest the session into `.circuit/continuity` (see
  `hooks/hooks.json`).
- `runtime/circuit.js`: generated bundled runtime.
- `scripts/circuit.ts`: hand-authored wrapper that launches the bundled runtime.

## Editing Rule

Do not hand-edit generated commands, flow JSON, or `runtime/circuit.js`. Edit
the source under `src/`, then run `npm run emit-flows` or
`npm run build-plugin-runtime` as appropriate. `npm run check-flow-drift` proves
the package is still in sync.
