# Host Packages

Circuit ships host packages for Claude Code and Codex. They give each host a
self-contained way to run the same local Circuit engine.

| Path | What it is | Edit posture |
| --- | --- | --- |
| [`plugins/claude/`](claude/) | Claude Code plugin package. | Manifests and hooks are hand-authored. Commands, flow mirrors, the runtime bundle, and the `scripts/launcher-core.ts` mirror are generated (the launcher mirror's single source is `plugins/shared/launcher-core.ts`). | <!-- path-ok -->
| [`plugins/codex/`](codex/) | Codex plugin package. | Manifests and hooks are hand-authored. Commands, skills, flow mirrors, the runtime bundle, and the `scripts/launcher-core.ts` mirror are generated (the launcher mirror's single source is `plugins/shared/launcher-core.ts`). | <!-- path-ok -->

Short rule:

```text
edit source under src/ -> regenerate -> verify generated surfaces
```

Use [docs/generated-surfaces.md](../docs/generated-surfaces.md) for the exact
source-to-output map.
