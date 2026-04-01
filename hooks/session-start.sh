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

# ── Prerequisite check: Python 3 ────────────────────────────────────
if ! command -v python3 >/dev/null 2>&1; then
  cat <<'NOTE'
> **Python 3 not found** -- relay scripts require Python 3 for batch state
> management. Install with: `brew install python3` (macOS) or
> `apt install python3` (Linux).

---

NOTE
fi

# ── Banner ────────────────────────────────────────────────────────────
cat <<'BANNER'
# Circuitry

```
/circuit:router <describe your task>
```

Circuits are structured, multi-phase workflows where each step writes a durable file on disk that feeds the next. Heavy implementation is dispatched to isolated worker sessions automatically (via **Codex CLI** when installed, or **Claude Agent** as fallback). If a session crashes, a fresh one reads the files and resumes exactly where it stopped.

The router picks the right circuit for your task. Start there.

---

### Reference: All Circuits

| Circuit | Invoke | Use When |
|---------|--------|----------|
| **Router** | `/circuit:router` | Unsure which circuit fits — start here |
| **Run** | `/circuit:run` | Clear task that benefits from planning and review |
| **Develop** | `/circuit:develop` | Feature delivery with unclear approach (`--spec-review` for existing specs) |
| **Decide** | `/circuit:decide` | Architecture choices with real tradeoffs |
| **Repair Flow** | `/circuit:repair-flow` | Fix a broken or flaky end-to-end flow |
| **Ratchet Quality** | `/circuit:ratchet-quality` | Autonomous overnight quality improvement |
| **Cleanup** | `/circuit:cleanup` | Dead code and stale docs sweep |
| **Migrate** | `/circuit:migrate` | Framework swaps, dependency replacements, architecture transitions |
| **Circuit Create** | `/circuit:create` | Author a new circuit from a workflow description |
| **Dry Run** | `/circuit:dry-run` | Validate a circuit skill's mechanical soundness |
| **Setup** | `/circuit:setup` | Discover skills and generate circuit.config.yaml |

Use `/circuit:workers` to orchestrate workers directly without a circuit wrapper.
BANNER
