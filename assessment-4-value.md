## Value Proposition & Differentiation Audit

### Summary Verdict
**READY WITH CAVEATS**

The core value proposition is real and substantive. Circuitry solves a genuine problem that Claude Code power users hit regularly: long tasks that lose coherence, crash mid-session, or require babysitting. The writing is clear, concrete, and avoids hype. However, the README never explicitly addresses the "I can just prompt Claude to do this" objection, never shows a before/after comparison, and the plugin.json description reads like internal architecture docs rather than a marketplace pitch. These gaps mean a skeptical X visitor will bounce before the value clicks.

---

### Findings (ordered by severity)

#### Finding 1: No before/after comparison anywhere in the README
- **Location:** `/README.md`, lines 1-17 (opening pitch) and lines 84-109 (Quick Start)
- **Current state:** The opening describes the problem abstractly ("stacking skills manually and hoping the agent holds it together doesn't cut it") and the Quick Start describes what happens after invocation. Neither section ever shows: "Here is what you'd do without Circuitry. Here is what you do with it."
- **Impact on launch:** A Claude Code power user reading the GitHub page will think: "I already scope my own tasks with prompts, and I can tell Claude to write artifacts." They need to see a concrete side-by-side to understand what Circuitry actually changes. Without one, the value feels theoretical.
- **Recommendation:** Add a short before/after block between the opening pitch (line 17) and the "What's Inside" table (line 19). Something like:

  > **Without Circuitry:** You paste a task into Claude Code. It starts coding immediately. Halfway through a 12-file change, the session crashes. You restart, re-explain the context, and hope it remembers the decisions it already made. For bigger tasks, you manually break the work into phases, write your own prompts for each one, and stitch the results together.
  >
  > **With Circuitry:** You type `/circuit:run add a dark mode toggle`. The circuit scopes the work, shows you the plan, and on confirmation dispatches parallel workers to implement, review, and converge. If the session crashes, a fresh one reads the artifact chain on disk and picks up at the exact step that failed. You confirm scope once; the rest is autonomous.

- **Priority:** MUST FIX

#### Finding 2: The "I can just prompt Claude to do this" objection is never addressed
- **Location:** `/README.md`, entire file (no section addresses this)
- **Current state:** The README never names the alternative approaches a Claude Code user already has (raw prompting, CLAUDE.md instructions, manually chaining skills, using the Agent tool) or explains why Circuitry is better than each.
- **Impact on launch:** This is the single most predictable objection from the X audience. Power users will say: "I already have a CLAUDE.md with multi-phase instructions" or "I just tell Claude to write artifacts." If the README doesn't preempt this, the objection becomes the conversation instead of the value.
- **Recommendation:** Add a short "Why not just prompt it?" section (or FAQ) after the Quick Start. Address the three main alternatives directly:
  1. **"I can write multi-phase instructions in CLAUDE.md"** -- You can. But CLAUDE.md instructions are suggestions that live in the context window. They degrade as the window fills. Circuits produce durable files on disk that survive session crashes and feed deterministically into the next step.
  2. **"I can stack skills manually"** -- Skills tell Claude how to do a task. They don't enforce ordering, produce artifacts, or handle crashes. Circuits are the coordination layer above skills.
  3. **"I can just use the Agent tool"** -- The Agent tool is a single worker. Circuits dispatch multiple workers in parallel (implement, review, converge) and coordinate their outputs through artifact chains.
- **Priority:** MUST FIX

#### Finding 3: plugin.json description is architecture-speak, not marketplace-speak
- **Location:** `/.claude-plugin/plugin.json`, line 3; `/.claude-plugin/marketplace.json`, line 13
- **Current state:** `"Structured workflow circuits for Claude Code. Disciplined multi-phase approaches to complex engineering tasks, powered by Codex workers and artifact chains."`
- **Impact on launch:** In a marketplace listing, this reads like an internal architecture doc. "Structured workflow circuits" and "disciplined multi-phase approaches" are descriptions of the mechanism, not the outcome. A browser scanning the marketplace needs to understand the benefit in one line.
- **Recommendation:** Rewrite to lead with the outcome:
  `"Autonomous multi-phase workflows for Claude Code. Your task gets scoped, implemented by parallel workers, independently reviewed, and resumed if a session crashes."`
  Or even shorter: `"Turn complex Claude Code tasks into crash-resistant, multi-phase workflows with parallel workers and automatic resume."`
- **Priority:** MUST FIX

#### Finding 4: The Quick Start describes process, not value
- **Location:** `/README.md`, lines 90-109
- **Current state:** The five numbered steps explain the mechanics ("Circuit routes your task automatically", "An artifact chain tracks progress", "Workers handle the heavy lifting"). Each step describes what happens procedurally.
- **Impact on launch:** A reader skimming the Quick Start gets a process description. They don't get a visceral sense of "this saved me 45 minutes" or "this caught a bug my implementation missed." The steps are accurate but feel like documentation, not a pitch.
- **Recommendation:** Either (a) rewrite the steps to emphasize outcomes alongside process (e.g., step 4 could say "Workers implement, review, and converge in parallel -- you get independent code review without asking for it"), or (b) add a one-line outcome statement before the steps: "In about 2 minutes of wall-clock time, you get scoped implementation with independent review, convergence, and a summary of what changed. Here's the breakdown:"
- **Priority:** SHOULD FIX

#### Finding 5: The single most compelling "aha moment" is buried
- **Location:** `/README.md`, lines 107-109
- **Current state:** `"Resume awareness means a fresh Claude Code session can pick up exactly where the last one stopped. The artifact chain is the state, not the chat history."`
- **Impact on launch:** Session crash recovery is the killer feature. Every Claude Code user has lost work to a crashed session or a filled context window. This is mentioned as item 5 in a numbered list, below the fold. It should be the headline.
- **Recommendation:** Elevate crash recovery / resume awareness to the opening pitch (lines 1-17). Consider making it the second sentence after describing the problem: "Circuits are the next layer up... And if a session dies mid-task, a fresh one reads the artifacts on disk and picks up exactly where the last one stopped." (This sentence already exists on line 11, which is good, but it's buried in a dense paragraph. Consider pulling it out as a standalone line or bolding it.)
- **Priority:** SHOULD FIX

#### Finding 6: Opening paragraph assumes pain the audience may not yet have
- **Location:** `/README.md`, lines 3-6
- **Current state:** `"But for complex work with phases, competing options, and real research, stacking skills manually and hoping the agent holds it together doesn't cut it. Context windows fill up. Sessions crash. The agent forgets what it already decided three steps ago."`
- **Impact on launch:** The first two pain points (context windows filling up, sessions crashing) are universally recognized. The third ("the agent forgets what it already decided") is real but more subtle -- not everyone has noticed this pattern yet. The phrase "complex work with phases, competing options, and real research" is abstract; a reader who hasn't tried to do multi-phase work with Claude Code won't self-identify.
- **Recommendation:** Lead with the two concrete, universal pain points (crashes and context window limits). The "forgets decisions" point can follow as the less obvious insight. Consider rephrasing the opening to start with the pain everyone has felt: "Claude Code sessions crash. Context windows fill up. The agent forgets what it already decided three steps ago. For anything beyond a single-file change, you're babysitting."
- **Priority:** NICE TO HAVE

---

### What's Already Working Well

1. **The writing is sharp and jargon-light.** The README avoids AI hype, marketing fluff, and unnecessary abstraction. Sentences are concrete and direct. The "Skills tell Claude how to do a task" opening is an excellent anchor for the audience.

2. **The "What's Inside" table is immediately scannable.** A power user can see the full circuit catalog in 5 seconds and understand which one applies to their situation. The "Best For" column uses natural language that maps to real tasks.

3. **The develop circuit visualization (lines 129-138) is genuinely compelling.** The ASCII phase diagram makes the multi-phase structure tangible in a way that prose alone cannot. It shows that this is a real system with real structure, not a wrapper around a prompt.
