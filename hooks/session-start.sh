#!/usr/bin/env bash
# session-start.sh -- Outputs the Circuitry plugin session banner as markdown
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
# Circuitry

```
/circuit:router <describe your task>
```

Circuits are structured, multi-phase workflows that break complex engineering tasks into artifact chains — each phase writes a durable file that feeds the next. Heavy implementation is dispatched to workers automatically — via **Codex CLI** when installed, or **Claude Agent** as a fallback.

The router picks the right circuit for your task. Start there.

---

### Reference: All Circuits

| Circuit | Invoke | Use When |
|---------|--------|----------|
| **Router** | `/circuit:router` | Unsure which circuit fits — start here |
| **Do** | `/circuit:run` | Clear task that benefits from planning and review |
| **Develop** | `/circuit:develop` | Feature delivery with unclear approach |
| **Decide** | `/circuit:decide` | Architecture choices with real tradeoffs |
| **Harden Spec** | `/circuit:harden-spec` | Turn a rough spec into a build-ready plan |
| **Repair Flow** | `/circuit:repair-flow` | Fix a broken or flaky end-to-end flow |
| **Ratchet Quality** | `/circuit:ratchet-quality` | Autonomous overnight quality improvement |
| **Cleanup** | `/circuit:cleanup` | Dead code and stale docs sweep |
| **Migrate** | `/circuit:migrate` | Framework swaps, dependency replacements, architecture transitions |
| **Circuit Create** | `/circuit:create` | Author a new circuit from a workflow description |
| **Dry Run** | `/circuit:dry-run` | Validate a circuit skill's mechanical soundness |
| **Setup** | `/circuit:setup` | Discover skills and generate circuit.config.yaml |

Use `/manage-codex` to orchestrate workers directly without a circuit wrapper.
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
