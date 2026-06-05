# Agent Setup

Thin setup prompt for coding agents working in a Circuit checkout.

Keep durable setup and operating instructions in:

- [docs/first-run.md](first-run.md) for the safest install proof.
- [docs/operator-guide.md](operator-guide.md) for commands, checkpoints, and
  verification.
- [docs/configuration.md](configuration.md) for config and connector routing.
- [docs/generated-surfaces.md](generated-surfaces.md) for generated output
  ownership.

Do not turn this file into a second operator guide.

## Copy-Paste Prompt

Replace `<repo-path>` with the checkout path and paste this into the coding
agent:

```text
You are setting up Circuit in this repo: <repo-path>.

Stay inside that checkout unless I explicitly approve a user-global config
change. First read README.md, docs/README.md, AGENTS.md,
UBIQUITOUS_LANGUAGE.md, docs/first-run.md, docs/operator-guide.md,
docs/configuration.md, docs/agent-setup.md, and docs/generated-surfaces.md.

Check the environment with git status --short, node --version, and
npm --version. If Node is older than 22.18.0, stop and report that blocker. If
dependencies are missing, run npm install from the repo root, then run
npm run build.

Do not hand-edit generated host output. For installed host setup, run
npm run plugins:refresh-local. For config changes, preview the exact YAML before writing either
~/.config/circuit/config.yaml or ./.circuit/config.yaml.

Use Review as the first real run unless I ask for a write-capable flow. Report
commands run, files changed, verification results, and any blocker.
```

## What This Prompt Delegates

- Environment blockers and the safe first Review path:
  [docs/first-run.md](first-run.md).
- Verification and troubleshooting:
  [docs/operator-guide.md#verification](operator-guide.md#verification).
- Config boundaries and connector choices:
  [docs/configuration.md](configuration.md).
- Generated host output and installed host cache refresh:
  [docs/generated-surfaces.md](generated-surfaces.md).

Use Review first because it is audit-only. Build, Fix, Prototype, and Pursue may
invoke a write-capable worker, so do not start one unless the operator asked for
code-changing work.
