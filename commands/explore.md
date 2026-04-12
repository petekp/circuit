---
description: "Investigate, understand, choose among options, or shape an execution plan."
---

Direct slash-command invocation for `/circuit:explore`.

Launch the `circuit:explore` skill immediately.
Use hook-authored helper wrappers from `.circuit/bin/` instead of rediscovering plugin paths or cache layout.
If the request is an explicit smoke/bootstrap verification of the workflow, bootstrap and validate run state, then stop without unrelated repo exploration.
Valid smoke evidence is the real `.circuit` run state and workflow scaffold on disk; repo hygiene or branch status alone does not count.
For smoke/bootstrap requests, manual `Write`/`Edit` creation of `.circuit/current-run`, `circuit.manifest.yaml`, `events.ndjson`, `state.json`, `artifacts/active-run.md` is a failure; use `.circuit/bin/circuit-engine bootstrap` instead.
Inside that skill, execute its compiled contract block before unrelated repo exploration.
Do not reinterpret this command as a generic repo-understanding request.
