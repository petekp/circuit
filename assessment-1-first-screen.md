## First-Screen Impact Audit

### Summary Verdict
**READY WITH CAVEATS** for tonight's X post

The README communicates a genuine problem and a clear solution. A Claude Code power user will understand the value proposition within the first two paragraphs. However, five specific issues reduce the 10-second clarity and setup speed -- three of which are fixable in under 30 minutes.

---

### Findings (ordered by severity)

#### Finding 1: The install command is below the fold -- a visitor cannot identify how to get started without scrolling
- **Location:** `README.md` lines 46-49
- **Current state:** The `claude plugin install petekp/circuitry` command appears at line 49, well below the first-screen cutoff (~30 rendered lines). Lines 1-34 contain the pitch and the table, but no install command.
- **Impact on launch:** The X post audience has 10 seconds. "How do I try this?" is the question that converts interest into installation. Right now it requires scrolling past the entire "What's Inside" table plus a "Prerequisites" section. A visitor who only reads above the fold sees no actionable next step.
- **Recommendation:** Add a one-liner install command immediately after the opening pitch, before the table. Something like:

  ```
  ## Get Started

  ```bash
  claude plugin install petekp/circuitry
  ```

  Then `/circuit:run <your task>` to go.
  ```

  This gives the visitor both the install and the invocation in a two-line block before they need to scroll at all.
- **Priority:** MUST FIX

#### Finding 2: The plugin.json description uses two jargon terms that require Circuitry-specific knowledge
- **Location:** `.claude-plugin/plugin.json` line 3
- **Current state:** `"Structured workflow circuits for Claude Code. Disciplined multi-phase approaches to complex engineering tasks, powered by Codex workers and artifact chains."`
- **Impact on launch:** This string renders as the repo subtitle on GitHub (and in `claude plugin search` results). "Codex workers" assumes knowledge of the Codex CLI integration. "Artifact chains" is an internal Circuitry concept that means nothing to a first-time visitor. The first sentence is fine; the second sentence is insider language.
- **Recommendation:** Replace the second sentence with something outcome-oriented that a Claude Code user immediately gets. Example: `"Structured workflow circuits for Claude Code. Research, plan, implement, and review in autonomous multi-step runs that survive session crashes."`
- **Priority:** MUST FIX

#### Finding 3: "The next layer up" (line 8) reads as marketing without an anchor
- **Location:** `README.md` line 8
- **Current state:** `"Circuits are the next layer up."`
- **Impact on launch:** The phrase "next layer up" implies a stack, but the stack is never named. Up from what? The preceding paragraph says "skills," but it describes the *problem* with skills, not a layer model. A reader who knows Claude Code skills will infer the meaning, but it adds a half-second of cognitive friction at the exact moment the pitch needs to land.
- **Recommendation:** Make the layer explicit: `"Circuits sit on top of skills."` or `"Circuits are what you build on top of skills."` -- anything that names both ends of the relationship in one phrase.
- **Priority:** SHOULD FIX

#### Finding 4: The "What's Inside" table name column says "Do" but the invoke column says `/circuit:run`
- **Location:** `README.md` line 23
- **Current state:** `| Do | /circuit:run <task> | The default: any clear task that benefits from planning and review |`
- **Impact on launch:** The human-readable name "Do" and the invocation `circuit:run` are mismatched. Every other row's name roughly matches its command (`Develop` / `circuit:develop`, `Decide` / `circuit:decide`). "Do" / `circuit:run` breaks the pattern and costs a cognitive beat ("is Do different from Run?"). This is a naming artifact from the recent rename chain (`do` -> `default` -> `run`).
- **Recommendation:** Either rename the "Circuit" column entry to "Run" to match the command, or add a parenthetical: `"Run (default)"`. Consistency across all 11 rows matters for scannability.
- **Priority:** SHOULD FIX

#### Finding 5: Five jargon terms in lines 1-35 that require prior knowledge of Circuitry internals
- **Location:** `README.md` lines 1-35 and `.claude-plugin/plugin.json` line 3
- **Current state:** The following terms appear without definition and require Circuitry-specific context:
  1. **"artifact chain"** (plugin.json line 3, README line 98) -- the concept of sequential file outputs is explained in lines 9-12, but the exact phrase "artifact chain" only appears much later (line 98, 122). The plugin.json description uses it before the README ever defines it.
  2. **"durable artifact"** (README line 9) -- "durable" is load-bearing but unexplained. It means "a file on disk that persists across sessions." A reader might assume it just means "saved."
  3. **"workers"** (README line 15) -- introduced with bold but defined only as "parallel processes." A Claude Code user doesn't know whether this means subagents, Codex CLI calls, or background threads.
  4. **"quality gates"** (README line 125-126) -- not in lines 1-35 but referenced in plugin.json keywords. Within the first screen it doesn't appear, so this is a minor concern.
  5. **"relay"** (plugin.json keywords line 19) -- internal infrastructure term. Does not appear in lines 1-35 of README but is a keyword in plugin.json and appears in setup instructions (line 63).
- **Impact on launch:** Within the literal first 35 lines, only terms 1-3 above apply. Of those, "workers" at line 15 is the most likely to cause a reader to pause. "Durable artifact" is close to self-explanatory in context. The net effect is that a Claude Code power user can likely parse lines 1-35 without confusion, but the plugin.json description (which renders *above* the README as a repo subtitle) front-loads the two hardest terms.
- **Recommendation:** Fix the plugin.json description (Finding 2 covers this). In the README, consider adding a parenthetical on line 15: `"Circuits dispatch heavy work to **workers** (parallel Codex or Agent sessions that run in isolated worktrees):"` -- just enough to anchor the term.
- **Priority:** NICE TO HAVE (except for plugin.json, which is MUST FIX per Finding 2)

---

### Answers to Specific Assessment Questions

1. **What does a visitor learn in the first 5 lines?** They learn that skills alone are insufficient for complex multi-phase work, and that context windows and session crashes are the failure modes. This is effective -- it names the pain before the solution. However, they do *not* yet learn what Circuitry *is* until line 8. The ratio is fine for a technical audience.

2. **Does the opening paragraph distinguish Circuitry from "a collection of skills"?** Yes. Lines 3-6 frame the problem (skills alone break down), and lines 8-12 introduce circuits as a different category of thing (structured, multi-phase, artifact-producing, resumable). The distinction is clear.

3. **Is "the next layer up" meaningful without context?** Partially. See Finding 3. It conveys "more than skills" but doesn't name the relationship precisely.

4. **Can you identify `/circuit:run <task>` within 10 seconds?** On a GitHub render, the table starts at roughly the halfway point of the first screen. A fast scanner will see it. But the single most important call-to-action (install + run) is not above the table -- it's 15 lines below it. See Finding 1.

5. **Jargon count in lines 1-35:** Three terms that require Circuitry-specific knowledge: "durable artifact" (line 9), "workers" (line 15), "artifact chain" (implicit from plugin.json, explicit later). See Finding 5 for the full enumeration.

---

### What's Already Working Well

1. **The problem statement (lines 3-6) is sharp and resonant.** "Context windows fill up. Sessions crash. The agent forgets what it already decided three steps ago." Every Claude Code power user has felt this pain. It's concrete and avoids marketing language.

2. **The "What's Inside" table (lines 21-33) is well-structured and scannable.** Eleven circuits, each with a one-line description. The three-column format (name, command, use case) lets a reader quickly identify which circuits match their work. The descriptions are outcome-oriented ("Taking a feature from idea to shipped code") rather than implementation-oriented.

3. **The resume/crash-recovery narrative is a genuine differentiator.** Lines 10-12 ("if a session dies mid-task, a fresh one reads the artifacts on disk and picks up exactly where the last one stopped") are the single most compelling feature for an audience that has lost work to session crashes. This lands well and is positioned early enough to matter.
