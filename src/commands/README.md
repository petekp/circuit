# Command Sources

This directory contains hand-authored source files for direct Circuit commands
that are not owned by a flow package: `run`, `handoff`, and the CLI-only
`create` utility.

A flow package can own its own command source at `src/flows/<id>/command.md`,
declared with `paths.command` in that flow's `data.ts`. Pursue declares one
today and is published as a separate host command on both hosts
(`/circuit:pursue`); the other built-in flows route through Run and ship no
separate host command.

For generated Claude and Codex command/skill destinations, edit rules, and drift
checks, use [docs/generated-surfaces.md](../../docs/generated-surfaces.md). For
the host-ready flow-authoring checklist, use
[docs/flows/authoring-model.md](../../docs/flows/authoring-model.md#adding-a-flow).
