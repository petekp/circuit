---
description: "Systematic codebase sweeps: cleanup, quality passes, coverage improvements, docs-sync."
---

Direct slash-command invocation for `/circuit:sweep`.

Launch the `circuit:sweep` skill immediately.
Resolve installed Circuit helpers through `.circuit/plugin-root` (written by the Circuit hook for `/circuit:*` prompts) or `$CLAUDE_PLUGIN_ROOT` when already present. Do not inspect the plugin cache or repo structure to rediscover them.
If the request is an explicit smoke/bootstrap verification of the workflow, bootstrap and validate run state, then stop without unrelated repo exploration.
Valid smoke evidence is the real `.circuit` run state and workflow scaffold on disk; repo hygiene or branch status alone does not count.
Do not inspect skill files, runtime directories, plugin cache layout, or CLI help output before bootstrap. Use the direct bootstrap contract immediately.
Inside that skill, execute its direct-invocation/bootstrap contract before unrelated repo exploration.
Do not reinterpret this command as a generic repo-understanding request.
