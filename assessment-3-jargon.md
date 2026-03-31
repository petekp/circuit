## Jargon & Conceptual Accessibility Audit

### Summary Verdict
**NOT READY**

The README is well-structured and the Quick Start is strong, but a newcomer from an X post hits a wall of unexplained domain-specific terminology within the first 30 seconds of reading. "Artifact chains," "relay scripts," "dispatch," "synthesis," "quality gates," "convergence," "circuit breakers," and "manage-codex" all appear without definitions or are defined too late. The session-start banner is clean, but the README's middle sections read like leaked architecture docs. With 4-5 targeted edits, this becomes launch-ready.

---

### Glossary of Domain-Specific Terms in README.md

| Term | First appearance (line) | Explained before first use? | Understandable to a Claude Code skill user without explanation? |
|------|------------------------|-----------------------------|---------------------------------------------------------------|
| circuit | 8 | Yes (lines 8-12) | Yes, with the explanation given |
| artifact | 9 | Partially ("durable artifact") | No -- "artifact" in software usually means build output; here it means a markdown file that tracks workflow state |
| artifact chain | 9 | No -- used casually, defined later at line 122 | No -- sounds like a blockchain concept or CI pipeline term |
| worker / workers | 15 | Partially ("parallel processes") | Somewhat -- Claude Code users know subagents but "workers" is ambiguous |
| dispatch | 14 | No | No -- could mean event dispatch, message dispatch, job dispatch |
| converge / convergence | 16, 104 | No | No -- sounds like ML convergence or git merge |
| interactive checkpoints | 16-17 | Yes (contextually clear) | Yes |
| relay scripts | 63 | No | No -- "relay" is entirely opaque; could mean network relay, signal relay, etc. |
| quality gates / gates | 125-127 | Partially (line 125-127 explains what they do) | No -- "gate" is CI/CD jargon not everyone knows; "quality gate" sounds like SonarQube |
| synthesis | 119 | Defined at line 119 | Somewhat -- but only after reading the table |
| circuit breaker | Not in README (in CIRCUITS.md line 3, SKILL.md files) | No | No -- sounds like an electrical engineering term or the resilience pattern (Hystrix) |
| manage-codex | 41 (as AGENTS.md reference), 219 | No | No -- "codex" alone is ambiguous (OpenAI Codex? Codex CLI?); "manage-codex" sounds like an admin command |
| compose-prompt.sh | 155, 213 | No (mentioned in Domain Skills section) | No -- implementation detail |
| batch state | 40 | No | No |
| prompt header | Not in README (in SKILL.md files) | N/A | No |
| handoff | Not in README (pervasive in SKILL.md files) | N/A | Somewhat -- common enough in engineering |
| seam / seam proof | Not in README (in SKILL.md files) | N/A | No -- "seam" is a Working Effectively with Legacy Code term that most people have not read |
| ADR | Not in README (in SKILL.md files) | N/A | No -- Architecture Decision Record is niche |
| intent lock | Not in README (in SKILL.md develop diagram) | N/A | No -- sounds like a mutex |
| slice | Not in README directly (in SKILL.md files) | N/A | Somewhat -- but overloaded (vertical slice? pizza slice?) |

---

### Findings (ordered by severity)

#### Finding 1: "Artifact chain" is used 6 times before it is explained
- **Location:** `README.md`, lines 9, 96-98, 108-109, 122-123, 147-148, 265
- **Current state:** Line 9: *"A circuit is a structured, multi-phase workflow where every step produces a durable artifact that feeds the next."* Line 96-98: *"An artifact chain tracks progress in `.relay/circuit-runs/`. For the default workflow: `scope.md` -> `scope-confirmed.md` -> `execution-handoff.md` -> `done.md`."*
- **Impact on launch:** A visitor from X reads "artifact chain" and either thinks blockchain, CI artifacts, or has no idea. The concept is actually simple (each step writes a markdown file, the next step reads it), but the name makes it sound arcane. The term is used casually 4 times before the "How Circuits Work" section finally explains it at line 122.
- **Recommendation:** At line 9, replace "durable artifact" with plain language: "...every step writes a file to disk that the next step reads." Then at the Quick Start (line 96-98), instead of "An artifact chain tracks progress," say "A chain of markdown files tracks progress." Keep "artifact chain" as a named concept only in the How Circuits Work section, where it is properly defined.
- **Priority:** MUST FIX

#### Finding 2: "Relay scripts" in Installation is completely opaque
- **Location:** `README.md`, lines 63-64
- **Current state:** *"After installing, set up relay scripts in your project. These are the shell scripts that circuits use to assemble Codex worker prompts and manage batch state."*
- **Impact on launch:** A newcomer just installed the plugin and now must run a setup command for something called "relay scripts" that "assemble Codex worker prompts and manage batch state." Every noun in that sentence is jargon. They don't know what relay means, what Codex worker prompts are, or what batch state is. This is the moment they close the tab.
- **Recommendation:** Reframe as: *"After installing, run the setup script to copy a few helper scripts into your project. Circuits use these scripts to dispatch work to background processes and track progress."* Drop the term "relay" entirely from user-facing text -- it is an implementation detail. If the directory must stay named `scripts/relay/`, that's fine, but the README should not force the reader to understand the metaphor.
- **Priority:** MUST FIX

#### Finding 3: "How Circuits Work" section is architecture-doc content that leaked into the README
- **Location:** `README.md`, lines 111-141
- **Current state:** The section introduces three "action types" (Interactive, Dispatch, Synthesis) with a table, then explains quality gates with reopening semantics, then shows a 5-phase diagram of the develop circuit with internal step names like `intent-lock`, `external-probe`, `adversarial`, `prove-seam`, and `tradeoff`.
- **Impact on launch:** A newcomer who just read "add a dark mode toggle" in Quick Start now encounters a taxonomy of action types and a circuit diagram with 10+ internal terms. This is the exact content that belongs in ARCHITECTURE.md (which already exists). The README should tell people *what circuits do for them*, not *how the engine works internally*.
- **Recommendation:** Replace lines 111-141 with a much shorter section. Something like: *"Every circuit follows the same pattern: break work into phases, write a file at each phase, and let a fresh session pick up where the last one left off. Some phases involve you (setting priorities, confirming scope). Others run autonomously in background processes. If something goes wrong, the circuit stops and asks you."* Then link to ARCHITECTURE.md for the full model. Remove the develop circuit diagram from README entirely -- it is overwhelming for a newcomer and already exists in CIRCUITS.md.
- **Priority:** MUST FIX

#### Finding 4: "Dispatch" and "Synthesis" as named action types assume insider knowledge
- **Location:** `README.md`, lines 115-119; `hooks/session-start.sh`, line 39; `CIRCUITS.md`, line 3; plugin.json line 3
- **Current state:** README line 118: *"**Dispatch** | A worker process (Codex or Agent) | Heavy research, implementation, or review runs in an isolated session."* Session banner line 39: *"Heavy implementation is dispatched to workers automatically"*. plugin.json: *"powered by Codex workers and artifact chains"*.
- **Impact on launch:** "Dispatch" is not a term Claude Code users encounter. They know "subagents" or "Agent tool." "Synthesis" sounds like it produces a summary, but actually means "Claude reads files and writes a new one without spawning a worker." These terms are useful internally but the README should use plain language: "runs in a background process" and "Claude reads the files and writes the next one."
- **Recommendation:** In the README, avoid "dispatch" and "synthesis" as named concepts. Use them only in ARCHITECTURE.md. In the session banner, replace "dispatched to workers" with "delegated to background processes." In plugin.json, replace "powered by Codex workers and artifact chains" with "Structured multi-phase workflows for complex engineering tasks."
- **Priority:** SHOULD FIX

#### Finding 5: Session-start banner references "manage-codex" without explanation
- **Location:** `hooks/session-start.sh`, line 62
- **Current state:** *"Use `/manage-codex` to orchestrate workers directly without a circuit wrapper."*
- **Impact on launch:** A newcomer sees this in the reference table footer and has no idea what manage-codex is, what "orchestrate workers" means, or why they would want to bypass circuits. This is a power-user escape hatch shown to everyone on first session.
- **Recommendation:** Remove this line from the session-start banner entirely. It belongs in CIRCUITS.md or a "Power User" section. The banner should focus on getting people started, not exposing internal orchestration tools.
- **Priority:** SHOULD FIX

#### Finding 6: "Convergence" appears without definition
- **Location:** `README.md`, lines 104; `CIRCUITS.md`, lines 28, 138; `skills/run/SKILL.md`, lines 7, 104, 255
- **Current state:** README line 104: *"Implementation, review, and convergence happen in parallel worker processes."* CIRCUITS.md line 138: *"runs a convergence assessment"*
- **Impact on launch:** "Convergence" in ML means a model stabilizing. In git it means branches merging. Here it means "a final check that verifies all the pieces work together." The reader has to guess.
- **Recommendation:** On first use in README, say "a final verification pass" instead of "convergence." In CIRCUITS.md, add a parenthetical: "convergence (a final verification that all pieces work together)."
- **Priority:** SHOULD FIX

#### Finding 7: "Circuit breaker" used in CIRCUITS.md and SKILL.md files without definition
- **Location:** `CIRCUITS.md`, line 3; `skills/run/SKILL.md`, lines 363-373; `skills/develop/SKILL.md`, lines 797-803
- **Current state:** CIRCUITS.md line 3: *"includes gates, circuit breakers, and resume logic"*. SKILL.md line 363: *"## Circuit Breaker"* section header.
- **Impact on launch:** "Circuit breaker" is a resilience pattern (think Netflix Hystrix) that most frontend-leaning Claude Code users will not recognize. It also creates confusion with the "circuit" metaphor itself -- is this breaking the circuit?
- **Recommendation:** In CIRCUITS.md, replace "circuit breakers" with "automatic stop conditions" or "safety limits." In SKILL.md files, rename the section to "## Safety Limits" or "## When to Stop." The internal naming can stay for developers, but user-facing text should be plain.
- **Priority:** SHOULD FIX

#### Finding 8: plugin.json description is jargon-dense
- **Location:** `.claude-plugin/plugin.json`, line 3
- **Current state:** *"Structured workflow circuits for Claude Code. Disciplined multi-phase approaches to complex engineering tasks, powered by Codex workers and artifact chains."*
- **Impact on launch:** This is the first thing someone reads in the marketplace. "Disciplined multi-phase approaches" is vague corporate-speak. "Powered by Codex workers and artifact chains" means nothing to someone who hasn't read the README.
- **Recommendation:** Something like: *"Break complex coding tasks into structured, multi-step workflows. Each step writes a file, so work survives session crashes and can be reviewed."* Lead with the benefit, not the mechanism.
- **Priority:** SHOULD FIX

#### Finding 9: "Dry Run" circuit description uses "10 mechanical dimensions"
- **Location:** `CIRCUITS.md`, lines 117-121
- **Current state:** *"checks all 10 mechanical dimensions per step (setup completeness, path resolution, command validity, artifact chain closure, header compliance, template contamination, placeholder leaks, action-type consistency, gate validity, topology match)"*
- **Impact on launch:** This parenthetical is an implementation dump. A newcomer reading the circuit catalog does not need to know there are exactly 10 dimensions, let alone what "template contamination" or "placeholder leaks" mean.
- **Recommendation:** Simplify to: *"checks each step for mechanical correctness (valid paths, complete setup, consistent configuration)"* and link to ARCHITECTURE.md for the full checklist.
- **Priority:** NICE TO HAVE

#### Finding 10: "manage-codex" section in CIRCUITS.md uses "implement -> review -> converge loop"
- **Location:** `CIRCUITS.md`, lines 134-141
- **Current state:** *"manage-codex is the execution engine that several circuits delegate to for code delivery. It is not a circuit itself -- it is a batch orchestrator that runs an `implement -> review -> converge` loop using Codex workers."*
- **Impact on launch:** This section is useful for power users but uses every piece of jargon at once: "batch orchestrator," "implement -> review -> converge loop," "convergence worker," "COMPLETE AND HARDENED," "circuit breakers trigger."
- **Recommendation:** Rewrite the opening sentence to lead with what it does for the user: *"manage-codex handles the code-writing phase that several circuits share. It breaks work into slices, implements each one, runs an independent review, and verifies everything works together."* Move the detailed loop mechanics to ARCHITECTURE.md.
- **Priority:** NICE TO HAVE

#### Finding 11: Skill frontmatter descriptions are good but inconsistent in jargon use
- **Location:** `skills/run/SKILL.md` line 3-9; `skills/router/SKILL.md` line 3-6; `skills/develop/SKILL.md` line 3-7
- **Current state:** run/SKILL.md: *"Default circuit for tasks that benefit from structured execution but don't match a specialized circuit. 4 steps across 3 phases: Scope -> Execute -> Summary. Auto-scopes the work, shows the plan for confirmation, then runs implement/review/converge."* The term "implement/review/converge" appears in the frontmatter, which is read by the router and shown to users.
- **Impact on launch:** The frontmatter descriptions are generally clear, but "implement/review/converge" in the run skill and "Alignment -> Evidence -> Decision -> Preflight -> Delivery" in develop are phase names that only make sense after reading the full SKILL.md. For the description field (which may surface in help text), these should be simpler.
- **Recommendation:** In run/SKILL.md frontmatter, replace "then runs implement/review/converge" with "then implements with independent review." In develop/SKILL.md, the phase names are fine since they are descriptive English words, but consider adding a one-line plain summary before the phase list.
- **Priority:** NICE TO HAVE

---

### What's Already Working Well

1. **The Quick Start example is excellent.** Line 86-88: `/circuit:run add a dark mode toggle that persists to localStorage` is concrete, instantly understandable, and shows the user exactly what to type. This is the strongest moment in the README.

2. **The "What's Inside" table is scannable and well-organized.** Lines 19-33 give a clean table with circuit names, invocation commands, and plain-English "Best For" descriptions. A newcomer can scan this in 5 seconds and know what is available.

3. **The session-start banner is focused and clean.** Lines 32-61 of `hooks/session-start.sh` lead with the one command to remember (`/circuit:router`), give a one-paragraph explanation, and show the reference table. This is a good first impression -- the only issue is the manage-codex line at the end (Finding 5).

4. **The "When Circuits Overlap" and "Decision Boundaries" sections in CIRCUITS.md (lines 144-174) are genuinely helpful.** They anticipate real user confusion and resolve it with clear "use X, not Y" guidance. This is the kind of content that builds trust with a power user audience.
