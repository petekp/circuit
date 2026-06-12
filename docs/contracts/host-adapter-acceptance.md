---
contract: host-adapter-acceptance
status: draft-v0.1
version: 0.1
last_updated: 2026-04-30
depends_on: [host-adapter, host-rendering, host-capabilities]
---

# Host Adapter Acceptance

This contract defines what Circuit is allowed to claim about each host adapter.
It separates deterministic package and adapter proof from live host smoke
evidence.

## Support States

- `supported`: deterministic contract tests and simulated adapter tests cover
  the capability.
- `experimental`: the capability exists, but installed-host behavior is not
  proven enough for a support claim.
- `unsupported`: the capability is intentionally not available.
- `not-applicable`: the host does not use that surface.

## Capability Matrix

| Capability | Claude Code | Codex |
|---|---|---|
| packaged command invocation | supported | supported |
| packaged flow lookup | supported | supported |
| progress JSONL rendering contract | supported | supported |
| handoff brief command | supported | supported |
| SessionStart hook script | supported | supported |
| bundled SessionStart registration | supported | unsupported |
| user-level SessionStart registration | not-applicable | supported |
| real installed-host injection | experimental | experimental |

## Coverage Map

Each `supported` matrix entry MUST have at least one row here. Real-host smoke
scripts may add confidence, but they do not upgrade a capability to
`supported` by themselves.

| Capability | Host | Coverage |
|---|---|---|
| packaged command invocation | Claude Code | `tests/runner/plugin-command-invocation.test.ts` |
| packaged command invocation | Codex | `tests/contracts/codex-host-plugin.test.ts` |
| packaged flow lookup | Claude Code | `tests/contracts/claude-host-plugin.test.ts` |
| packaged flow lookup | Codex | `tests/contracts/codex-host-plugin.test.ts` |
| progress JSONL rendering contract | Claude Code | `tests/contracts/host-experience-docs.test.ts` and `tests/contracts/codex-host-plugin.test.ts` |
| progress JSONL rendering contract | Codex | `tests/contracts/codex-host-plugin.test.ts` |
| handoff brief command | Claude Code | `tests/runner/utility-cli.test.ts` |
| handoff brief command | Codex | `tests/runner/utility-cli.test.ts` |
| SessionStart hook script | Claude Code | `tests/runner/handoff-hook-adapters.test.ts` |
| SessionStart hook script | Codex | `tests/runner/handoff-hook-adapters.test.ts` |
| bundled SessionStart registration | Claude Code | `tests/contracts/host-adapter-acceptance.test.ts` |
| user-level SessionStart registration | Codex | `tests/runner/utility-cli.test.ts` |

## Real-Host Smoke

Real-host smoke scripts are optional proof tools. They MUST report structured
JSON with `status: "pass" | "fail" | "skip"` and enough evidence to explain
the result.

Default smoke behavior MUST be safe:

- use a temporary project root
- generate a unique handoff token
- avoid persistent host configuration changes unless an explicit flag requests
  them
- return `skip` when a host CLI, auth state, feature flag, or plugin setup is
  unavailable
- return `fail` only when prerequisites are present and behavior is wrong

The V1 smoke scripts are:

```bash
npm run smoke:host:codex
npm run smoke:host:codex -- --use-real-user-hooks
npm run smoke:host:claude
```

## Current Boundaries

Codex V1 does not support bundled plugin hook registration. Codex loads
`plugins/codex/hooks/hooks.json` by default when that file exists, and runs <!-- path-ok -->
hook commands from the session working directory. Circuit therefore keeps the
supported Codex path on the user-level hook installed by:

```bash
circuit handoff hooks install --host codex
```

Real installed-host injection remains `experimental` for both Claude Code and
Codex until smoke evidence is reliable enough to automate.
