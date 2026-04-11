---
description: "Build features, scoped refactors, docs, tests, or mixed changes."
---

Direct slash-command invocation for `/circuit:build`.

Launch the `circuit:build` skill immediately.
Resolve installed Circuit helpers through `.circuit/plugin-root` (written by the Circuit hook for `/circuit:*` prompts) or `$CLAUDE_PLUGIN_ROOT` when already present. Do not inspect the plugin cache or repo structure to rediscover them.
If the request is an explicit smoke/bootstrap verification of the workflow, bootstrap and validate run state, then stop without unrelated repo exploration.
Valid smoke evidence is the real `.circuit` run state and workflow scaffold on disk; repo hygiene or branch status alone does not count.
For Build smoke/bootstrap requests, manual `Write`/`Edit` creation of `.circuit/current-run`, `circuit.manifest.yaml`, `events.ndjson`, `state.json`, or `artifacts/active-run.md` is a failure; use `circuit-engine.sh bootstrap` instead.
Do not inspect skill files, runtime directories, plugin cache layout, or CLI help output before bootstrap. Use the direct bootstrap contract immediately.
Inside that skill, execute its direct-invocation/bootstrap contract before unrelated repo exploration.
Do not reinterpret this command as a generic repo-understanding request.
