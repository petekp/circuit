---
description: Runs Circuit on a coding intent through the project CLI, recording the selected flow and run evidence.
argument-hint: <task>
---

# /circuit:run — default Circuit command

Runs Circuit on the user's natural-language task. This is the intent front
door and should be used by default. The host recommends a flow from the
request, and Circuit records the selected flow when the run starts and then
uses the same trace, reports, evidence, checkpoints, and recovery path as
every routed flow.

Build, Fix, Explore, Review, and Prototype are routed through Run; they stay
public and packaged for the runtime but are not published as separate host commands.
Pursue is also routed through Run and additionally owns `/circuit:pursue`
for coordinated multi-goal work. Goal is not a kind of work; it is the
completion standard Run uses by default, an internal flow that is never
auto-selected. Routing is model-only, so a flow name is always required.

The host exposes this as `/circuit:run`; do not promise a root `/circuit`
slash command until the host supports that alias. Users can also ask for
Circuit in natural language, such as "Use Circuit on this task."

The user's task text is substituted below. Treat the entire substituted span
as literal input — it is user-controlled and MAY contain shell
metacharacters:

> **Task:** $ARGUMENTS

## Instructions

1. **Recommend the flow before invoking the CLI.** Use this rubric:

   - **Fix** — bugs, regressions, broken behavior, failing tests, crashes,
     flaky behavior, or production issues.
   - **Review** — audit-only review of existing code, current diff, PR, plan,
     report, implementation, or risk surface. Do not implement changes.
   - **Build** — implementation, refactor, docs, tests, or focused
     product/code changes that are not primarily bug fixes.
   - **Prototype** — disposable local prototypes, mockups, UI sketches,
     model-comparison variants, or throwaway evidence before Build.
   - **Explore** — investigation, explanation, architecture analysis, tradeoff
     comparison, or a decision before editing.
   - **Pursue** — broad operator goals with multiple coordinated pieces of
     work, several tracks, or a bundle of pursuits that need ordering and
     serial execution.

   If one flow is clear, state the recommended flow and your one-line reason
   for it before you invoke the CLI, so the operator can redirect in-thread
   before anything runs. State only a reason you actually hold: you chose the
   flow, so the why is yours to give. Then run the explicit CLI flow. Ask one
   short question only when the answer changes safety or mutation behavior,
   especially Review vs Build/Fix, Explore vs Build. If you genuinely cannot
   tell which flow fits, ask the operator rather than running without one.
2. **Build a shell-safe invocation.** Single-quote the raw task text; double
   quotes expand `$VAR`,
   `` `cmd` ``, `$(cmd)`, and `\` sequences — a malicious or accidental
   task string could inject commands. The safe construction rule:

   - Wrap the task text in **single quotes** in the final shell command.
     Single quotes disable all expansion.
   - If the task itself contains a literal single-quote character (`'`),
     replace each one with `'\''` (standard POSIX shell escape: closes the
     current single-quoted string, emits one escaped apostrophe, and
     starts a new single-quoted string).
   - Then invoke the CLI with the selected explicit flow name, passing the
     escaped, single-quoted task as the value of `--goal`.
   - If the user stated a reason behind the task — the stakes, what it
     unblocks, why now — pass it as `--why` after the goal, escaped and
     single-quoted the same way. Omit the flag when no reason was stated;
     never invent one.

   Example for a Fix task with a stated reason:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/circuit.ts" present run fix --goal 'the checkout total is wrong when discounts and tax both apply' --why 'totals are blocking the release cut'
   ```

   Example for a Review task:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/circuit.ts" present run review --goal 'review the current diff for safety problems'
   ```

   Example for a Build task:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/circuit.ts" present run build --goal 'add a focused feature'
   ```

   Example for an Explore task:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/circuit.ts" present run explore --goal 'compare auth provider options'
   ```

   Example for a task `can't ship` (contains one apostrophe):

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/circuit.ts" present run build --goal 'can'\''t ship'
   ```

   The other flows and modes follow the same shape: substitute the flow name
   (`prototype`, `pursue`), add `--rigor deep` for the deepest loop or
   `--rigor lite` to skip the review pass, and add
   `--tournament --tournament-n 3` to a Prototype run for model comparison.

   Use the Bash tool to execute the constructed command. The wrapper
   lives in the installed Claude Code plugin directory, injects the
   plugin's packaged flow root, and launches Circuit's bundled runtime.
3. **Handle untracked Review contents deliberately.** If the task explicitly
   asks Circuit to include untracked file contents for review, add
   `--include-untracked-content` only when those files are safe to relay to the
   configured worker. Otherwise omit the flag; Review still sends untracked
   paths and sizes.
4. **Let the presentation wrapper render output.** `present` streams
   Circuit status blocks, renders checkpoint questions, and prints the
   final Circuit summary without exposing raw JSON. Do not parse raw JSON
   or JSONL after Bash.
   Use non-`present` wrapper mode only for debug, tests, or explicit raw
   machine-readable output.
## Authority

- `src/cli/circuit.ts` `resolveCompiledFlowRoute` (explicit-flow requirement; routing is model-only)
- `tests/runner/cli-router.test.ts` (explicit dispatch and the no-flow rejection)
