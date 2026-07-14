# First-run and agentic setup precedents (2025-2026)

Research context gathered 2026-07-13 for the turnkey first-run design
(`docs/ideas/turnkey-first-run.md`). Web-verified where sources are
linked. This records what other tools do on first invocation, where
agentic setup has shipped, and where users have pushed back.

## The headline findings

1. **No shipping tool runs an LLM agent at install time to write its own
   config unprompted.** The agentic config-writers that exist (Claude
   Code `/init`, Codex `/init`, Gemini `/init`, OpenCode `/init`, VS Code
   Copilot "Generate Instructions") are all post-install, user-invoked,
   in-session, and reviewable before commit. Running the agent on install
   is unclaimed territory, and every adjacent precedent argues for holding
   the agentic step until the user is present and the output is
   reviewable.
2. **The field converged on deterministic-detect plus minimal-ask.** The
   respected first-runs (Claude Code, Codex, Gemini, Cursor CLI) ask only
   identity (auth), trust (scope), and taste (theme). Everything
   project-specific is detected at task time or generated later by an
   explicit init command. gh detects existing SSH keys; mise reads the
   `.nvmrc` the project already has; Renovate detects package files and
   commit conventions. Asking a question the environment can answer reads
   as a defect (ESLint `--init` asking about TypeScript with
   tsconfig.json sitting right there).
3. **Generated config that restates the discoverable is net-negative.**
   The documented `/init` backlash: generated CLAUDE.md files are
   dominated by rediscoverable facts (scripts, frameworks, structure),
   burn always-loaded context budget, and rot silently. One community
   benchmark measured generated context files decreasing success rates
   and raising cost about 20 percent versus no file (single source, treat
   the number as low confidence and the direction as medium). The
   consensus repair: keep it short, decision-shaped, and only what is
   undiscoverable.
4. **The praised counterexample is Renovate's onboarding PR**: on enable
   it scans the repo and opens a PR containing the proposed config, with
   detected package files, a summary of each auto-chosen decision and the
   evidence behind it, and what to expect next. It changes nothing until
   the PR merges. Machine-written config earns trust when every line is a
   decision with its evidence, presented as a reviewable artifact that
   stays inert until accepted.
5. **Communicate-after works as one-line receipts with the undo inline.**
   git's init.defaultBranch hint is the archetype: default applied,
   rationale in one clause, override command in the same breath. Codex's
   welcome screen shows the model and approval mode it picked as status
   with the change-command adjacent. direnv prints the exact env diff it
   applied. End with the next command to run.

## Precedent table (condensed)

| Precedent | Trigger | Detects | Asks | Writes | Communicates |
| --- | --- | --- | --- | --- | --- |
| Claude Code first-run | first `claude` | env API key, prior state | theme, auth, per-dir trust | `~/.claude.json` | wizard, then status line |
| Claude/Codex/Gemini/OpenCode `/init` | user-invoked | whole repo | approval of output | agent-context file | diff for review |
| Cursor CLI | first run | prior login | browser login only | session creds | minimal |
| gh auth login | user-invoked | existing SSH keys | host/protocol/method (flag-skippable) | keychain token | success one-liner |
| direnv | cd into dir | .envrc content hash | one-time allow per content version | allow-list | env diff every load |
| mise | cd / tool call | .nvmrc, mise.toml | none | tool installs | warn lines with remedy |
| pre-commit | first commit | config file | none | hook + cached envs | announces one-time latency |
| Renovate | app enabled | package files, conventions | merge the PR | config as a PR | evidence + what-to-expect in PR body |
| ESLint --init | user-invoked | almost nothing | 5-question interview | config + deps | prompt flow (dated pattern) |
| create-vite | npm create | none | 3 prompts, sub-second | scaffold | "Done. Now run:" |
| cargo new | invocation | dir name | none | scaffold | one hint line |
| aider | first run in repo | tree-sitter repo map | one gitignore question | gitignore line only; map stays ephemeral | startup lines |
| Next.js telemetry | first command | nothing | none (opt-out) | flag file | one-time notice + disable command (backlash: opt-out default) |

## Design principles extracted

1. Never put the agent between the user and their first result. If setup
   takes more than about two seconds it runs concurrently, after, or on
   explicit request.
2. Detect, don't interview. Legitimate questions are identity, trust, and
   genuine preference forks the environment cannot answer. Every prompt
   needs a flag equivalent for CI.
3. Deterministic floor, agentic ceiling. Probes do the bulk; the agent
   layer is progressive enhancement that degrades to "skipped, run X
   later" offline.
4. The agent may only write the undiscoverable and the decided. Short,
   decision-shaped, each entry justified by the evidence that produced it.
5. Propose as a reviewable artifact and stay inert until accepted, or act
   and show the diff. Reviewable-artifact for consequential config; silent
   write plus receipt for trivially reversible choices.
6. One-line receipts with the undo inline; end with the next command.
7. Ask trust once, key it to content, remember it forever. A repeated
   question is a bug (Claude Code's trust-dialog re-ask issue class).
8. Announce latency, prove it is one-time, cache aggressively
   (pre-commit's forgiven minutes; an unexplained pause is not forgiven).

## Failure modes to design against

- Agentic setup failing usually looks like plausible-but-generic output,
  not a crash, and it silently degrades every later session. Mitigations:
  hard length budget, validate generated entries against deterministic
  probes, label output as generated with a regenerate command, and never
  make the agentic artifact load-bearing (the engine must run on the
  deterministic floor alone).
- No network: the floor must behave like create-vite (fully works); the
  agent layer declares itself skipped.
- No credentials: degrade to a named remedy per connector, doctor-style,
  never block the rest of setup.
- Non-TTY and scripted use must never prompt (gcloud `--quiet` lesson;
  create-next-app's flags-ignored bug #62494).
- Abort mid-setup must leave nothing or a valid floor state.
- Staleness: anything written about the repo will eventually be wrong.
  Keep agentic knowledge ephemeral (aider's regenerated map cannot rot) or
  timestamp it and re-verify cheaply.
- Anything phoned home must be announced before first send with the
  disable command in the notice (Homebrew, .NET, Next.js telemetry
  backlash).

## Sources

Claude Code quickstart and trust-dialog issues (#6797, #3366), Codex CLI
docs, Gemini CLI get-started and command reference, Cursor CLI blog, gh
auth manual and headless issue #12592, direnv issue #812, mise
configuration docs, pre-commit issue #1458, Renovate onboarding docs,
ESLint getting-started, create-next-app issue #62494, VS Code custom
instructions docs, OpenCode rules docs, aider repo-map docs, "Never Run
Claude /init" (aihero.dev), "Claude.md is RUINING Claude Code"
(chaseai.io), HumanLayer "Writing a good CLAUDE.md", Homebrew analytics
issue #142, .NET telemetry docs, Next.js telemetry issues #23183 and
#59686, gcloud scripting docs.
