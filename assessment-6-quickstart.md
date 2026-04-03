## Quick Start Scenario Walkthrough

### Summary Verdict
READY WITH CAVEATS

The Quick Start narrative (README.md lines 84-109) is structurally sound and the artifact chain it describes matches the actual code paths in `skills/run/SKILL.md` and `skills/run/circuit.yaml`. However, two claims are misleading to a first-time reader, and one critical failure mode (missing relay scripts) has no user-facing error message in the Quick Start itself. None of these are blockers for launch, but fixing them would meaningfully reduce the gap between promise and reality for a skeptical visitor.

---

### Findings (ordered by severity)

#### Finding 1: "Circuit routes your task automatically" is misleading for /circuit:run
- **Location:** `README.md` line 92-94
- **Current state:** `1. **Circuit routes your task automatically.** If it needs a specialized workflow (research, architecture decision, debugging), you get one. Otherwise it scopes the work, shows you the plan, and executes on confirmation.`
- **What actually happens:** `/circuit:run` does NOT route. It is the route. The routing behavior described here belongs to `/circuit:router` (see `skills/router/SKILL.md` lines 1-8). What `circuit:run` actually does is an "escalation check" during its auto-scope step (`skills/run/SKILL.md` lines 111-119): if the task signals a specialized circuit, it notes this in the scope and the user decides at the confirmation step whether to switch. This is a soft recommendation, not automatic routing.
- **Impact on launch:** A power user who reads "routes your task automatically" and then invokes `/circuit:run` will not get routing. They chose the circuit directly. If they wanted routing, they should have used `/circuit:router`. The sentence conflates two different entry points. This erodes trust in the first 5 seconds.
- **Recommendation:** Rewrite step 1 to accurately reflect what `circuit:run` does. Two options:
  - (A) Change the Quick Start invocation to `/circuit:router add a dark mode toggle...` (which genuinely auto-routes), or
  - (B) Keep `/circuit:run` but rewrite step 1 to say something like: "Circuit scopes the work automatically. It reads your task and the codebase, writes a structured scope, and shows it to you for confirmation. If the task would be better served by a specialized circuit, it flags that during scoping."
- **Priority:** SHOULD FIX

#### Finding 2: "parallel worker processes" overstates what circuit:run does
- **Location:** `README.md` lines 103-105
- **Current state:** `4. **Workers handle the heavy lifting.** Implementation, review, and convergence happen in parallel worker processes (via Codex CLI when installed, or Agent fallback otherwise).`
- **What actually happens:** The `circuit:run` SKILL.md (Step 3, lines 210-303) delegates to `manage-codex`, which runs an `implement -> review -> converge` loop. The manage-codex SKILL.md (lines 88-102) dispatches workers serially per slice: implement a slice, then review it, then move to the next. Multiple slices can exist, but the orchestrator processes them one at a time through the implement/review cycle. Convergence happens after all slices are done. The word "parallel" is misleading. Workers are independent processes (they run in isolation), but the loop is serial.
- **Impact on launch:** A user who expects parallel execution (like 3 workers running simultaneously) will be confused when they see slices processed one after another. The distinction matters because "parallel" is a selling point that implies speed.
- **Recommendation:** Change "parallel worker processes" to "independent worker processes" or "isolated worker sessions." The key value is independence (separate context, separate review), not parallelism.
- **Priority:** SHOULD FIX

#### Finding 3: Missing relay scripts produce a cryptic failure, not a clear error
- **Location:** `skills/run/SKILL.md` lines 88-93, 262-271; `scripts/setup.sh`; `hooks/session-start.sh` lines 65-75
- **Current state:** All SKILL.md files reference `./scripts/relay/compose-prompt.sh` and `./scripts/relay/dispatch.sh` with paths relative to the user's project root. These scripts only exist there if `setup.sh` has been run. The session-start hook (`hooks/session-start.sh` lines 67-74) does print a setup hint when `./scripts/relay/compose-prompt.sh` is missing, but this only appears at session start, not at the point of failure.
- **What actually happens without setup.sh:** When `circuit:run` reaches the dispatch step and Claude tries to execute `./scripts/relay/compose-prompt.sh`, the script won't exist. The `compose-prompt.sh` script itself has `set -euo pipefail` and checks for argument validity, but the file simply won't be found at the project-relative path. The error would be a shell "No such file or directory" message with no guidance about running `setup.sh`.
- **Impact on launch:** The README Quick Start (lines 84-88) shows `/circuit:run` as the very first thing to try, but the prerequisite "Project setup" section (lines 61-72) is 20 lines above and easy to skip. A user who installs the plugin and immediately runs `/circuit:run` will hit a confusing failure.
- **Recommendation:** Two complementary fixes: (1) Add a one-line note to the Quick Start section: "Make sure you've run project setup first (see Installation above)." (2) Consider having `circuit:run`'s SKILL.md include a check at the top of its Setup section that tests for `./scripts/relay/dispatch.sh` and prints a clear error with the setup command if missing.
- **Priority:** SHOULD FIX

#### Finding 4: "Resume awareness" is mentioned but never explained to the user
- **Location:** `README.md` lines 107-109
- **Current state:** `5. **Resume awareness** means a fresh Claude Code session can pick up exactly where the last one stopped. The artifact chain is the state, not the chat history.`
- **What actually happens:** The resume logic is thoroughly implemented in `skills/run/SKILL.md` lines 345-360 and `ARCHITECTURE.md` lines 153-174. It works by scanning the artifact chain in order and resuming from the first missing or gate-failing artifact. But there are zero user-facing instructions on HOW to resume. The user is told it exists, not what to do.
- **Impact on launch:** A user whose session dies will wonder: do I re-run `/circuit:run`? Do I use a different command? Do I need to pass a flag? The answer (just invoke `/circuit:run` with the same task and it scans `.relay/circuit-runs/` for existing artifacts) is never stated anywhere in the README, CIRCUITS.md, or any user-facing document.
- **Recommendation:** Add a brief "Resuming" subsection to the README or Quick Start: "If a session dies mid-circuit, start a new session and run the same `/circuit:run` command. The circuit reads existing artifacts from `.relay/circuit-runs/` and picks up from the last completed step." One sentence is enough.
- **Priority:** SHOULD FIX

#### Finding 5: Artifact chain path in README is accurate but missing the slug detail
- **Location:** `README.md` line 96-98
- **Current state:** `2. **An artifact chain tracks progress** in '.relay/circuit-runs/'. For the default workflow: 'scope.md' -> 'scope-confirmed.md' -> 'execution-handoff.md' -> 'done.md'.`
- **What actually happens:** The full path is `.relay/circuit-runs/${RUN_SLUG}/artifacts/scope.md` (see `skills/run/SKILL.md` lines 58-60, 125). The README says `.relay/circuit-runs/` which is correct as a parent directory, and the artifact names match the chain in SKILL.md lines 337-338: `scope.md -> scope-confirmed.md -> execution-handoff.md -> done.md`. This is accurate.
- **Impact on launch:** Minimal. A user looking for their artifacts would find the right directory. The slug subdirectory is an implementation detail.
- **Priority:** NICE TO HAVE (no fix needed; mentioning for completeness)

#### Finding 6: Agent fallback is functionally different from Codex dispatch
- **Location:** `README.md` lines 104-105; `scripts/relay/dispatch.sh` lines 109-128
- **Current state:** The README says "via Codex CLI when installed, or Agent fallback otherwise" as if they are equivalent.
- **What actually happens:** When using the Codex backend, `dispatch.sh` (line 106) runs `cat "$PROMPT" | codex exec --full-auto -o "$OUTPUT" -`, which is a real shell command that blocks and writes output. When using the Agent backend, `dispatch.sh` (lines 112-128) does NOT execute anything. It prints structured instructions for the orchestrator (Claude) to use the Agent tool. The orchestrator must then manually create an Agent tool call. This is seamless from the user's perspective (they don't see dispatch internals), but it means the "fallback" is architecturally different: Codex is fire-and-forget shell execution; Agent requires Claude to interpret dispatch output and act on it.
- **Impact on launch:** Low for the user. The experience is seamless because the orchestrator handles both paths. But a contributor reading the code might be confused.
- **Recommendation:** No change needed for launch. The README's claim is accurate from the user's perspective.
- **Priority:** NICE TO HAVE

#### Finding 7: circuit.yaml title says "Do" but the circuit is named "run"
- **Location:** `skills/run/circuit.yaml` line 5
- **Current state:** `title: Do`
- **What actually happens:** The circuit was renamed from "do" to "run" (per commit history: `0e737e4 fix: rename skills/default to skills/run`), but the `title` field in `circuit.yaml` was not updated. The README (line 22) correctly calls it "Do" in the table but invokes it as `/circuit:run`. The SKILL.md (line 12) header says "# Do Circuit". This is a leftover from the rename.
- **Impact on launch:** A user sees "Do" in `circuit.yaml` and the session banner table, but types `/circuit:run`. Minor confusion.
- **Recommendation:** Update `circuit.yaml` title from "Do" to "Run" and the SKILL.md header from "# Do Circuit" to "# Run Circuit".
- **Priority:** NICE TO HAVE

---

### What's Already Working Well

1. **The artifact chain is real and traceable.** The README claims `scope.md -> scope-confirmed.md -> execution-handoff.md -> done.md` and `skills/run/SKILL.md` lines 337-338 confirm this exact chain. The YAML topology (`circuit.yaml`) matches too -- every `produces` and `consumes` field aligns with the prose. A user who reads the Quick Start and then inspects `.relay/circuit-runs/` will find exactly what was promised.

2. **The session-start hook is well-designed.** `hooks/session-start.sh` checks for Codex CLI, explains the Agent fallback clearly, prints a circuit reference table, and warns about missing relay scripts. A new user who installs the plugin and starts a session gets a genuinely helpful orientation.

3. **The escalation check in circuit:run is a thoughtful design.** Rather than silently executing the wrong workflow, `circuit:run` evaluates whether the task belongs in a specialized circuit during its auto-scope step and surfaces this to the user at the confirmation checkpoint. This is exactly the right UX for the Quick Start scenario: the user gets one entry point that handles both "this task fits" and "this task needs something else."
