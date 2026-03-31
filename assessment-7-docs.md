## Documentation Layering & Navigation Audit

### Summary Verdict
**READY WITH CAVEATS**

The README is well-written and the three-tier documentation gradient (README -> CIRCUITS.md -> ARCHITECTURE.md) exists. However, the README carries too much weight for a 10-second X visitor. At 287 lines, it buries the quick-start under installation mechanics and then continues with 130+ lines of material that belongs in deeper docs. A visitor from tonight's X post will see the strong opening pitch (lines 1-17), hit the "What's Inside" table (lines 19-33), and then wade through setup instructions before reaching the single-command quick start at line 86. After that, they face another 200 lines of system internals, file trees, and domain skill configuration. The core value proposition and "try it now" moment are there; they just need less competition from reference material.

### Findings (ordered by severity)

#### Finding 1: README "How Circuits Work" section is wrong layer for this audience
- **Location:** `/README.md`, lines 111-142
- **Current state:** 31 lines explaining Interactive/Dispatch/Synthesis action types, artifact chain mechanics, quality gates, and a develop circuit phase diagram:
  ```
  Every circuit has three building blocks:
  | Action | Who does the work | What happens |
  ...
  Steps can have **quality gates** that check the output before advancing.
  ```
  Ends with a full ASCII phase diagram of the develop circuit.
- **Impact on launch:** An X visitor who just saw the quick-start does not need to understand the three action types, gate re-derivation behavior, or the develop circuit's five-phase topology. This is architecture documentation surfaced in what should be a landing page. It makes the README feel like it is for contributors, not users.
- **Recommendation:** Replace lines 111-141 with a 3-4 line summary: "Circuits break complex work into phases. Each phase produces an artifact file. If a session dies, a fresh one reads the artifacts and resumes. See ARCHITECTURE.md for the full design." The action-type table, gate mechanics, and develop phase diagram belong in ARCHITECTURE.md (Section 3: Execution Model already covers this).
- **Priority:** SHOULD FIX

#### Finding 2: README "File Structure" section is reference material, not onboarding
- **Location:** `/README.md`, lines 201-263
- **Current state:** 62 lines of directory tree listing every file in the project, plus a 4-line explanation of the circuit.yaml/SKILL.md contract:
  ```
  circuitry/
    .claude-plugin/
      plugin.json               # Plugin manifest (name, version, metadata)
      marketplace.json          # Marketplace listing metadata
    hooks/
    ...
  ```
- **Impact on launch:** A first-time user installing from X does not need to know the file structure. They need to install, run `/circuit:run`, and see value. This section is useful for contributors or people building custom circuits. It currently sits between the "Further Reading" links (line 144) and the "Contributing" section (line 270), making the README feel like it never ends.
- **Recommendation:** Move the entire file structure section to CONTRIBUTING.md (or ARCHITECTURE.md Section 7: Extending the System) and replace with a one-liner: "See CONTRIBUTING.md for the full file structure." CONTRIBUTING.md is 65 lines and has room; the file tree would give contributors the orientation they currently lack.
- **Priority:** SHOULD FIX

#### Finding 3: README "Domain Skills" section is 47 lines of optional config detail
- **Location:** `/README.md`, lines 152-199
- **Current state:** The section explains optional companion skills, lists 5 skills in a table, shows a full `circuit.config.yaml` example (13 lines of YAML), and explains the `--skills` flag and `/circuit:setup`. Opening:
  ```
  Circuits can dispatch workers with domain-specific skills injected into their
  prompts via `compose-prompt.sh --skills`. These skills are **not bundled** with
  the Circuit plugin.
  ```
- **Impact on launch:** Domain skills are explicitly optional. A new user from X has not even run their first circuit yet. Seeing YAML config for skill injection this early raises the perceived complexity of the project ("I need to configure all this?"). The section is well-written but misplaced.
- **Recommendation:** Collapse to 3-4 lines in the README: "Circuits can use optional domain skills (tdd, deep-research, etc.) for specialized guidance. Run `/circuit:setup` to auto-configure, or see CIRCUITS.md for manual setup." Move the config YAML example and the skills table to CIRCUITS.md, which already has a "Choosing a Circuit" section and is the natural home for power-user configuration.
- **Priority:** SHOULD FIX

#### Finding 4: "What's Inside" table is duplicated across README and CIRCUITS.md
- **Location:** `/README.md` lines 19-33 and `/CIRCUITS.md` lines 7-19
- **Current state:** Both files contain nearly identical quick-reference tables. README:
  ```
  | Do | `/circuit:run <task>` | The default: any clear task that benefits from planning and review |
  ```
  CIRCUITS.md:
  ```
  | Do | `/circuit:run <task>` | The default: any clear task that benefits from planning and review |
  ```
  The tables differ only in two cells: CIRCUITS.md says "Taking a non-trivial feature" vs. README's "Taking a feature"; CIRCUITS.md says "Making architecture or protocol decisions" vs. README's "Architecture decisions."
- **Impact on launch:** Drift risk. When a circuit is added or renamed, both tables need updating. The minor wording differences suggest they have already drifted slightly. Not a launch blocker, but a maintenance hazard.
- **Recommendation:** Keep both tables (two entry points is a valid pattern for a catalog doc). But make them identical, and add a comment in each file: `<!-- Keep in sync with {other file} Quick Reference Table -->`. Alternatively, if README is slimmed down per other findings, the README table could link to CIRCUITS.md as the canonical reference.
- **Priority:** NICE TO HAVE

#### Finding 5: Quick Start is at line 84 -- too far down for a 10-second scanner
- **Location:** `/README.md`, lines 84-109
- **Current state:** The install section (lines 35-78) precedes quick start. A visitor scrolling a GitHub README sees: pitch (17 lines), table (14 lines), then 49 lines of installation (prerequisites, GitHub install, local install, project setup, verify) before reaching:
  ```
  ## Quick Start
  /circuit:run add a dark mode toggle that persists to localStorage
  ```
- **Impact on launch:** The person from X already knows what Claude Code skills are. They want to see: what does this do, what does running it look like, how do I install. The current order is: what is it, what's inside, how to install (long), quick start. The "aha" moment at line 86-87 is buried.
- **Recommendation:** Move Quick Start above Installation. The ideal flow for tonight's audience: pitch -> table -> quick start (showing the command and what happens) -> install. The quick-start section already explains the 5-step flow well. Seeing the value before the setup mechanics is standard for dev tool READMEs.
- **Priority:** SHOULD FIX

#### Finding 6: No cross-link from CIRCUITS.md back to README or to ARCHITECTURE.md
- **Location:** `/CIRCUITS.md`, entire file (199 lines)
- **Current state:** CIRCUITS.md has zero outbound links. It never references README.md, ARCHITECTURE.md, or CONTRIBUTING.md. The only doc that links to CIRCUITS.md is README.md (line 146). Meanwhile, CONTRIBUTING.md links to ARCHITECTURE.md twice but never to CIRCUITS.md.
- **Impact on launch:** A reader who lands directly on CIRCUITS.md (e.g., linked from a GitHub search or an X reply) has no navigation path to the overview or to the deep architecture doc. The "learn more" gradient is one-directional only (README -> CIRCUITS.md -> nothing).
- **Recommendation:** Add a brief header or footer to CIRCUITS.md: "For installation and quick start, see [README.md](README.md). For the system design and extension guide, see [ARCHITECTURE.md](ARCHITECTURE.md)." Add a similar link at the top of ARCHITECTURE.md.
- **Priority:** NICE TO HAVE

#### Finding 7: Ideal README length for tonight
- **Location:** `/README.md`, all 287 lines
- **Current state:** 287 lines total. Applying findings 1-3 and 5, the README could be reduced to roughly 130-150 lines:
  - Pitch: 17 lines (keep as-is; strong and specific)
  - What's Inside table: 14 lines (keep)
  - Quick Start (moved up): 25 lines (keep)
  - Installation: 45 lines (keep; could be trimmed but not critical)
  - How Circuits Work: 5 lines (collapsed from 31)
  - Further Reading: 5 lines (keep)
  - Domain Skills: 4 lines (collapsed from 47)
  - Contributing: 13 lines (keep; remove file structure reference)
  - License: 2 lines (keep)
- **Impact on launch:** A 130-150 line README scans in under 30 seconds on a GitHub page. The current 287 lines require scrolling through 4-5 viewport heights on a laptop.
- **Recommendation:** Target approximately 140 lines. The cuts above are all moves to CIRCUITS.md, ARCHITECTURE.md, or CONTRIBUTING.md, not deletions. No content is lost; it just lives at the right layer.
- **Priority:** SHOULD FIX (aggregate of findings 1-3, 5)

### What's Already Working Well

1. **The opening pitch (lines 1-17) is excellent.** It names the problem (context windows, session crashes, agent forgetfulness), names the solution (artifact-driven phases), and names the benefit (autonomous coding you don't have to babysit). No jargon, no preamble. This will land with the X audience.

2. **The three-doc gradient exists and is well-partitioned.** README is overview, CIRCUITS.md is catalog with examples, ARCHITECTURE.md is system design for extenders. The boundaries are conceptually sound. The issue is not the structure but the README leaking deeper-layer content upward.

3. **CIRCUITS.md's "When Circuits Overlap" and "Decision Boundaries" sections (lines 142-198) are unusually strong.** Most tools leave users guessing which feature to use. These sections proactively answer "when do I use X vs. Y?" with concrete decision heuristics. This is a differentiator and will reduce support questions from day one.
