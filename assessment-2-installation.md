## Installation & Setup Friction Audit

### Summary Verdict
**READY WITH CAVEATS**

Circuitry installs cleanly via `claude plugin install` and the session-start hook surfaces the right commands. But there is a mandatory post-install step (running `setup.sh`) that copies relay scripts into the user's project, and the instructions for this step have path-finding problems, an incorrect "next steps" command, and no guidance for marketplace installs. A first-time user arriving from an X post will likely stall at the "project setup" step, not at the install step. Five findings below, three of which are MUST FIX before a launch-night post.

---

### Step-by-Step Path from Install to Working `/circuit:run`

1. `claude plugin install petekp/circuitry` -- one command, clean.
2. Open a Claude Code session in your project. Session-start hook fires and shows the banner.
3. If relay scripts are missing, the hook shows a "Project setup needed" notice with the `setup.sh` command.
4. User runs `setup.sh` (but which path? see Finding 1).
5. `setup.sh` copies `compose-prompt.sh`, `dispatch.sh`, `update-batch.sh`, and 7 reference templates into `./scripts/relay/` in the project.
6. `setup.sh` prints "Next steps: Create AGENTS.md ... Invoke a circuit: `/circuit:router <describe your task>`"
7. User creates AGENTS.md (or does not -- see Finding 3).
8. User types `/circuit:run add dark mode` and it works.

**Count: 4 distinct actions** (install, open session, run setup.sh, type the command). AGENTS.md creation is a 5th if you count it; see below.

---

### Findings (ordered by severity)

#### Finding 1: setup.sh path is unknowable for marketplace installs
- **Location:** `README.md` lines 63-72, `hooks/session-start.sh` lines 66-74
- **Current state (README):**
  ```
  # Use the setup helper (recommended)
  ~/.claude/plugins/local/circuitry/scripts/setup.sh

  # Or if installed from marketplace
  # Check your install path with: ls ~/.claude/plugins/cache/*/circuitry/*/
  ```
- **Current state (session-start.sh):**
  ```bash
  PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
  if [[ -n "$PLUGIN_ROOT" && ! -f "./scripts/relay/compose-prompt.sh" ]]; then
    cat <<SETUP
  > **Project setup needed:** Run this to install relay scripts:
  > \`\`\`
  > "${PLUGIN_ROOT}/scripts/setup.sh"
  > \`\`\`
  SETUP
  fi
  ```
- **Impact on launch:** The session-start hook correctly uses `$CLAUDE_PLUGIN_ROOT` to show the exact command, which is great. But the README tells marketplace users to `ls ~/.claude/plugins/cache/*/circuitry/*/` and figure out the path themselves. A user reading the README (the more likely path from an X post) has no single copy-pasteable command. Meanwhile the hook only fires once a session is opened, and only if the user is in a project directory without relay scripts. If someone reads the README first and tries to set up before opening a session, they hit a wall.
- **Recommendation:** Add a single universal install command to the README that works for both local and marketplace installs. Options: (a) tell users to just open a Claude Code session and follow the banner prompt (the hook handles it), or (b) provide a one-liner like `$(find ~/.claude/plugins -name circuitry -type d | head -1)/scripts/setup.sh`. Option (a) is simpler and more reliable.
- **Priority:** MUST FIX

#### Finding 2: setup.sh "next steps" prints wrong command
- **Location:** `scripts/setup.sh` line 77
- **Current state:**
  ```
  echo "  2. Invoke a circuit: /circuit:router <describe your task>"
  ```
- **Impact on launch:** The recommended quick-start in the README (line 87) is `/circuit:run add a dark mode toggle...`. The setup.sh output tells the user to use `/circuit:router` instead. This is not wrong (the router works), but it introduces an unnecessary decision point for a brand-new user. The README sells the experience of typing `/circuit:run <task>` and things just happening. The setup script sends them to a different entry point. Also, `/circuit:router` requires an extra confirmation step before dispatching, adding friction for someone who just wants to see it work.
- **Recommendation:** Change line 77 to: `echo "  2. Try it: /circuit:run <describe your task>"` to match the README's quick-start messaging.
- **Priority:** MUST FIX

#### Finding 3: AGENTS.md prerequisite is unclear about consequences
- **Location:** `README.md` lines 41, `scripts/setup.sh` lines 75-76, `skills/manage-codex/SKILL.md` line 54
- **Current state (README):**
  ```
  - **AGENTS.md** in your project root so workers understand your codebase conventions
    (see `skills/manage-codex/references/agents-md-template.md` for a starter template)
  ```
- **Current state (manage-codex/SKILL.md):**
  ```
  - If `AGENTS.md` is missing, create it from `references/agents-md-template.md`
  ```
- **Impact on launch:** The README lists AGENTS.md as a prerequisite, which implies things break without it. But manage-codex/SKILL.md says "if missing, create it from template," meaning the system auto-recovers. The setup.sh output also says "Create AGENTS.md" as step 1, making it sound mandatory before you can do anything. A first-time user does not know what AGENTS.md is, what goes in it, or how urgent it is. The template at `agents-md-template.md` is a placeholder with `{Project Name}` and `{build_command}` tokens that require manual filling. This is a speed bump right when the user wants to try the tool.
- **Recommendation:** (a) Downgrade from "prerequisite" to "recommended for best results." (b) In setup.sh output, reword to: "Optional: create AGENTS.md for project-aware workers (template: ...)" (c) Clarify in the README that circuits work without it, and workers will auto-create a default if missing.
- **Priority:** SHOULD FIX

#### Finding 4: Python 3 + PyYAML dependency poorly surfaced before failure
- **Location:** `README.md` line 40, `scripts/verify-install.sh` lines 53-71, `scripts/relay/update-batch.sh` line 109, `scripts/relay/compose-prompt.sh` line 217, `scripts/relay/dispatch.sh` lines 69-85
- **Current state (README):**
  ```
  - **Python 3** (required by `update-batch.sh` for deterministic state management)
  ```
- **Impact on launch:** Python 3 is used by three relay scripts: `update-batch.sh` (the entire script is an inline Python program), `compose-prompt.sh` (for YAML config parsing), and `dispatch.sh` (for YAML config parsing). Most macOS users have Python 3 via Xcode Command Line Tools, but it is not guaranteed. The README mentions Python 3 but buries it in a prerequisite list. PyYAML is only mentioned in `verify-install.sh` (line 70: "Install with: `pip3 install pyyaml`"). Neither `setup.sh` nor `session-start.sh` checks for Python 3. If Python 3 is missing, `update-batch.sh` fails at runtime during the first dispatch with an opaque error, not during install or setup. There is no early failure.
- **Recommendation:** (a) Add a Python 3 check to `session-start.sh` (alongside the Codex check) that warns on session start. (b) Note that PyYAML is only needed if using `circuit.config.yaml` for skill customization, not for basic operation. (c) Consider making the config-file parsing fall back gracefully when PyYAML is missing (the `compose-prompt.sh` already does `2>/dev/null || true` but `dispatch.sh` does not handle the failure path cleanly).
- **Priority:** SHOULD FIX

#### Finding 5: No explanation of WHY relay scripts must be copied into the project
- **Location:** `README.md` lines 63-64, `scripts/setup.sh` lines 1-12
- **Current state (README):**
  ```
  After installing, set up relay scripts in your project. These are the shell
  scripts that circuits use to assemble Codex worker prompts and manage batch state.
  ```
- **Current state (setup.sh header):**
  ```
  # Copies relay scripts (compose-prompt.sh, dispatch.sh, update-batch.sh) and
  # manage-codex reference templates into the target project's scripts/relay/
  # directory. This is needed because circuits dispatch work via these scripts
  # from the project root.
  ```
- **Impact on launch:** A Claude Code user familiar with plugins expects `claude plugin install` to be the entire setup. Having to run a separate script to copy files into their project is unusual. The README says what the scripts are but not why they cannot live inside the plugin directory. The setup.sh comment says "This is needed because circuits dispatch work via these scripts from the project root" but does not explain why dispatching from the project root requires local copies. A user might skip this step thinking it is optional, and nothing would fail until they actually try to dispatch a worker (the SKILL.md references `./scripts/relay/` with relative paths). The session-start hook does catch this (Finding 1), but only after a session is already open.
- **Recommendation:** Add one sentence to the README explaining the "why": workers execute in isolated worktrees and need these scripts accessible relative to the project root. Consider whether `$CLAUDE_PLUGIN_ROOT/scripts/relay/` could be used directly in skill references to eliminate this step entirely.
- **Priority:** NICE TO HAVE

#### Finding 6: verify-install.sh is only reachable by path, not by a circuit command
- **Location:** `README.md` lines 75-78, `scripts/verify-install.sh`
- **Current state:**
  ```
  ~/.claude/plugins/local/circuitry/scripts/verify-install.sh
  ```
- **Impact on launch:** The verification script is thorough (checks Python 3, PyYAML, bash version, all skill dirs, relay scripts, and runs a smoke test). But it suffers the same path-discovery problem as `setup.sh` for marketplace installs. More importantly, a first-time user from an X post is unlikely to run a verification script. They will go straight to `/circuit:run`. This is fine if everything works, but if something is misconfigured, they get a runtime error instead of a diagnostic. The script is a great safety net that is hard to reach.
- **Recommendation:** Consider adding a `/circuit:verify` skill that runs these checks interactively, or fold the critical checks (Python 3, relay scripts present) into the session-start hook.
- **Priority:** NICE TO HAVE

---

### What's Already Working Well

1. **The session-start hook is well-designed.** It detects missing relay scripts, uses `$CLAUDE_PLUGIN_ROOT` to generate the exact setup command, and clearly shows the dispatch backend status (Codex vs Agent). This is the single best piece of onboarding UX in the plugin. A user who just opens a session gets actionable guidance.

2. **The Codex/Agent fallback is transparent.** Both the hook and the README clearly communicate that Codex CLI is optional and everything works without it. There is no hard dependency that blocks first-time use. The dispatch.sh and compose-prompt.sh auto-detect the backend cleanly.

3. **The README's "What's Inside" table (lines 19-33) is immediately scannable.** Every circuit has a name, an invoke command, and a one-line description. A power user can grok the full surface area in seconds. The Quick Start section (lines 84-109) shows a concrete example with a clear walkthrough of what happens. This is strong launch-night messaging.
