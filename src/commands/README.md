# Command Sources

This directory contains hand-authored source files for direct Circuit commands
that are not owned by a flow package: `run`, `handoff`, and the CLI-only
`create` and `uninstall` utilities.

A flow package can own its own command source at `src/flows/<id>/command.md`,
declared with `paths.command` in that flow's `data.ts`. The catalog
(`src/flows/catalog.ts`) is the source of truth for which flows declare a
command and which route through Run.

For generated Claude and Codex command/skill destinations, edit rules, and drift
checks, use [docs/generated-surfaces.md](../../docs/generated-surfaces.md). For
the host-ready flow-authoring checklist, use
[docs/flows/authoring-model.md](../../docs/flows/authoring-model.md#adding-a-flow).
