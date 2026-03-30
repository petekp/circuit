#!/usr/bin/env bash
# session-start.sh — Outputs the Circuit plugin session banner as markdown
#
# Called by hooks.json on SessionStart. Checks prerequisites and lists
# available circuits.

set -uo pipefail

# ── Prerequisite check: Codex CLI ─────────────────────────────────────
if command -v codex >/dev/null 2>&1; then
  DISPATCH_BACKEND="codex"
else
  DISPATCH_BACKEND="agent"
  cat <<'NOTE'
> **Dispatch backend: Agent (Codex CLI not found)**
>
> Dispatch steps will use Claude Code's **Agent tool** (`isolation: "worktree"`)
> instead of `codex exec`. Circuits work fully in this mode -- the artifact chain,
> gates, and resume logic are identical regardless of backend.
>
> For better parallelism, you can optionally install Codex CLI:
> ```
> npm install -g @openai/codex
> ```

---

NOTE
fi

# ── Banner ────────────────────────────────────────────────────────────
cat <<'BANNER'
# Circuit

```
/circuit <describe your task>
```

Structured execution with planning, review, and convergence. Routes automatically to the right workflow.

For a specific circuit: `/circuit:develop`, `/circuit:decide`, `/circuit:repair-flow`, `/circuit:cleanup`, `/circuit:migrate`, `/circuit:harden-spec`, `/circuit:ratchet-quality`
Full catalog and help: `/circuit:router` or see CIRCUITS.md
BANNER

# ── Project setup hint (only if relay scripts are missing) ───────────
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
if [[ -n "$PLUGIN_ROOT" && ! -f "./scripts/relay/compose-prompt.sh" ]]; then
  cat <<SETUP

> **Project setup needed:** Run this to install relay scripts:
> \`\`\`
> "${PLUGIN_ROOT}/scripts/setup.sh"
> \`\`\`
SETUP
fi
