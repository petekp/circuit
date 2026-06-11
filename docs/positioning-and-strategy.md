# Circuit — Positioning & Strategy

Working notes from a positioning workshop. Captures pitch development, code-grounded audit of marketing claims, strategic gaps & opportunities, and the major insight that emerged: Circuit's distinctive value lies in being the substrate for **structured project memory** for both humans and agents.

These are internal working notes, not polished external copy. Some claims are honest about today's shipping reality; others are flagged as forward-looking and require build-out before they can be used externally. Before reusing any claim in public docs, check it against code, tests, generated release truth, and checked-in proof evidence.

---

## 1. Audience

**Center of gravity:** people burnt out by keeping up with coding-agent best practices who want working with coding agents to be simpler.

- **Primary:** engineers building real things over time who have felt agent drift, hallucinated completion, and "speed over correctness" pain. They have urgency and budget.
- **Secondary:** product designers entering coding-agent flows. They feel the same pain but typically aren't the wedge market.
- **Out of scope:** the "winging it, waiting for models to improve" cohort. Real audience, but not Circuit's. Don't dilute messaging trying to win them.

## 2. The pitch

### Headline

> **Stop reinventing your flow. Ship the product.**

Tested for universality (earlier "Design the product" leaned designer-specific).

### Long pitch (post-audit version, recommended for marketing surfaces)

> Most people drive a coding agent with one long chat and hope. Circuit gives that work a shape — named ways to explore, build, fix, and review.
>
> Each flow encodes the moves experienced AI engineers actually reach for: investigate before you build, plan before you act, verify before you review. The implementer isn't the reviewer — Circuit runs them as separate workers, the way frontier labs do. Flows leave typed reports and evidence behind, and relay steps can enforce declared acceptance criteria before the work moves on. Patterns most people only land on after months of trial and error. You get them as defaults.
>
> Pick how it runs. Flows declare the depth and autonomy they support, so you can ask for a quicker pass, a deeper pass, a tournament decision, or unattended checkpoint resolution when that flow supports it.
>
> Each step is a self-contained module — a unit of capability with one clear job. Modules upgrade independently, so as best practices change, your flows inherit the improvements. Customize which skills apply at a step, a flow, or across your whole setup.
>
> The field changes weekly. The shape of your work doesn't have to.

### Elevator (~30 words)

> Most people drive a coding agent with one long chat and hope. Circuit gives that work a shape — named flows that encode the moves experienced AI engineers actually reach for, with typed reports, evidence, and acceptance checks where flows declare them. Stop reinventing your flow. Ship the product.

### Beats (in order)

1. **Felt problem** — one long chat and hope. Circuit gives the work a shape via named flows.
2. **Provenance** — flows encode patterns experienced AI engineers reach for. Concrete proof points: separate implementer/reviewer workers, typed reports and evidence, relay acceptance checks where declared.
3. **Depth modes** — low / medium / high / autonomous. User agency over depth without redesigning anything.
4. **Modularity** — each step is a self-contained module; modules upgrade independently; skills customizable at any level.
5. **Closer** — *The field changes weekly. The shape of your work doesn't have to.*

### Discarded framings (and why)

- *"Design system for working with coding agents"* — design-system metaphor too GUI-coded for designers.
- *"Staged schematics"* — both terms felt too internal as lead language.
- *"We sweat the meta. You ship the product."* — strong tagline but currently overclaims; no active update channel ships yet.
- *"Borrowed taste"* — too designer-specific once audience recalibrated to fatigue persona broadly.
- *"Anti-rationalization" / "the agent can't fake done"* — true claim, but VexJoy Agent (see Section 9) has staked the rhetorical position. Find different language for the same property; lean on the records-as-receipts angle they don't emphasize.

## 3. Code audit — where the messaging is supported, stretched, or unsupported

| Claim | Status | Evidence |
| --- | --- | --- |
| Named ways to explore, build, fix, review | **Supported** | `src/flows/` directories; signal-routed entry per flow |
| Flows encode patterns experienced AI engineers reach for | **Strongly supported** | Build's stages: Frame→Plan→Act→Verify→Review→Close; explicit `evidence_requirements`; separate implementer/reviewer roles |
| Each step is a modular unit of capability | **Supported** | `StepExecutionKind` enum: `compose | relay | verification | checkpoint | sub-run | fanout` |
| Modules upgrade independently; flows inherit improvements | **Partially supported** | Versioning bone structure exists (`schema_version`, per-flow `version`, `candidate/active/deprecated`), but no distribution / auto-update channel exists yet |
| Customize skills at step / flow / setup level | **Strongly supported** | `selection-resolver.ts` resolves across config layers; `SkillOverride` modes: `inherit | replace | append | remove` |
| Variable model and effort per step | **Architecturally supported; defaults missing** | `SelectionOverride` carries optional `model` (openai/anthropic/gemini/custom) and `effort` (none/minimal/low/medium/high/xhigh) across a six-layer chain (default → user-global → project → flow → stage → step → invocation). Shipping flow definitions don't currently include curated per-step selection blocks — capability is real, opinionated defaults aren't. |
| "Best practices change every week. Circuit keeps up so you don't have to." | **Not yet supported** | No update channel. Architecture supports it; shipping reality doesn't. **Soften or build the channel before using.** |

## 4. Underused features that should be in the messaging

These are real, demonstrable, and pointed at the fatigue audience's actual pain:

- **Run controls per flow** — Build, Fix, and Explore support `low`, `medium`,
  `high`, and `autonomous`; Explore also supports `tournament`; Pursue supports
  `medium` and `autonomous`; Review is medium-only. *"Pick how thorough you
  want to be when the flow supports that choice."*
- **Evidence and acceptance checks as anti-fakery** — flows name the evidence a
  step must produce, and relay steps can declare deterministic
  `acceptance_criteria` that Circuit checks before advancing. This is the
  grounded version of the "prove it before moving on" claim.
- **Checkpoints with safe defaults** — schematics carry declared defaults, and
  checkpoint choices are recorded in the trace. Human-in-the-loop remains
  first-class. *"Pause for you when it matters; continue only when the safe
  choice is declared."*
- **Multi-agent review by default** — Build runs implementer and reviewer as separate workers (`role: "implementer"` vs `role: "reviewer"`). Frontier-lab pattern most users don't manually wire up.
- **Variable model and effort per step** — `SelectionOverride` supports model (openai/anthropic/gemini/custom) and effort (none/minimal/low/medium/high/xhigh) at six layers of granularity, including per-step. Enables frontier-lab pipeline patterns: cheap/fast model for Frame, high-effort reasoning model for Plan, *different* model for Review (real cognitive diversity, not two instances of the same model). *"Different models for different jobs, on by default — you don't have to pick."* **Caveat:** capability is shipping; curated per-step defaults in flow schematics aren't yet — build item before this graduates from architectural to demonstrable.
- **Structured report and evidence trail** — see Section 7. Currently treated as plumbing; should be a co-equal lead beat.

## 5. Strategic position

### Why Circuit has a window

- **Structural quality is orthogonal to model capability.** Smarter compilers didn't subsume linters, type systems, or test frameworks — they coexist. External invariants (evidence requirements, multi-agent review, forced verification) get *more* useful with capability, not less, because the model can actually meet them rather than hallucinating around them.
- **The substrate just stabilized.** Claude Code as a plugin host, SKILL.md as vocabulary, MCP as standard, sub-agents as a pattern — all landed inside the last ~12 months. The abstraction layer above these building blocks is wide open for ~6–12 months before either Anthropic ships something native or someone else fills it.
- **"No one else is doing this" reads as timing, not lack of demand.**

### Real gaps

1. **No discovery surface yet.** Where does a user encounter Circuit? Plugin marketplace? GitHub? Twitter? Pick the wedge.
2. **First-run experience is the first-mile risk.** A structured-flow product lives or dies in the first 5 minutes. Day-1 cost is the most expensive bug.
3. **The keep-up-for-you channel doesn't exist.** Architecture supports it; the actual update mechanism doesn't. Build the channel before scaling the marketing claim.
4. **No demonstrated proof.** The strongest claim — *"the agent can't fake completion"* — is unproven externally. A 30-second clip showing it would be worth more than the entire pitch document.
5. **Naming gap.** Plugin? CLI? Service? Pick the noun. Affects every messaging decision.

### Real opportunities

1. **Lead with reliability over fatigue.** *"Coding agents lie about being done. Circuit makes them prove it."* Sharper for engineers (the actual wedge) than the fatigue framing.
2. **Frontier patterns as product.** Multi-agent review, separate implementer/reviewer, evidence-required steps — well-documented in agent research, operationally hard to set up. *"Frontier-lab patterns, on by default."*
3. **The report and evidence trail as feature, not plumbing.** See Section 7 — this is the biggest under-sold differentiator.
4. **Plugin, not competitor.** Frame Circuit as making Claude Code better, not replacing it. Lower threat surface to Anthropic; ride their distribution.

### Risks to track

- **Anthropic absorbing the abstraction.** Real risk over 12–18 months. Mitigation: stay opinionated where a platform won't, and be a plugin not a competitor.
- **Complexity tax.** If using Circuit is more work than not, the audience rejects it. Pitch promises simplicity; first run must deliver simplicity.
- **Purist rejection.** Some engineers see opinionated flows as constraints, not guardrails. Not the audience. Don't dilute trying to win them.
- **Cold-start problem.** The compounding-memory value (Section 7) doesn't exist on day 1. Pitch needs to acknowledge that flow value is immediate, memory value compounds.

## 6. Validating proof demo — the comparison demo

Highest-leverage near-term work. *"Same task, two runs (with and without Circuit). Look at what gets produced."*

### What makes it work

- Lead with **evidence produced**, not outcome quality. *"Even when both runs work, only one produces something you can trust."* Less rigging-smell than "Circuit makes it succeed."
- Multiple runs per condition (≥3) to show distribution, not anecdote.
- Commit prompt + state publicly so anyone can rerun.
- Capture the killer moment if you can engineer it: agent says *done* → Circuit's verification demands evidence → agent runs verification → it fails → the agent realizes its own claim was wrong. *Circuit forces the agent to be honest with itself.*

### Three comparisons worth running

1. **Bug fix.** Plant a known bug. Tell: does the without-Circuit run produce a regression test, or just edit and declare done? *Probably the strongest single demo.*
2. **Feature with non-obvious edge case.** Tell: does the without-Circuit run skip planning and pay for it later?
3. **Multi-file refactor.** Tell: does the without-Circuit run leave the codebase in a worse state than it started?

### Format

Annotated blog post first (1–2 days, transcripts + screenshots + honest commentary). Video/GIF second, derived from the strongest moment in the post. Don't start with polished video.

## 7. The big positioning insight: structured project memory

The strongest standalone differentiator. Probably worth elevating to co-equal status with flow shape in the marketing pitch.

### The problem with MEMORY.md (the de facto industry pattern)

- **Lossy compression.** Reasoning gets flattened into summaries; alternatives considered drop out.
- **No provenance.** No timestamp, no link to the work that produced the decision, no evidence trail.
- **Self-overwriting.** Agents rewrite the file the same way they wrote it; detail decays each iteration.
- **Not queryable.** Single prose document; no schema; no axis for "all plans where verification failed."
- **No multi-axis recall.** Forces the agent to keyword-scan everything for relevance.

### Why structured reports are categorically different for agents

This is also where the *"smarter models will subsume this"* counter-argument is weakest — bigger models exploit structured memory **harder**, not less:

- They can **combine reports across runs** (multiple briefs + plans + verifications → coherent project narrative).
- They can **reason about provenance** (decision was made at time X, in context Y, after considering Z).
- They can **retrieve by schema** (`verification.failed = true`) instead of scanning.
- They can **detect contradiction** between past plans and current briefs.

### Working framings

> *Git tracks what changed in your code. Circuit tracks why your codebase is the way it is.*

> *MEMORY.md is the Google Doc strategy. Circuit is the database.*

### What's real today vs. what needs to be built

| Capability | Status |
| --- | --- |
| Per-run reports (brief, plan, verification, review, result) written to `reports/` | **Real** |
| Schema-versioned, machine-readable JSON | **Real** |
| Within-run continuity (pause/resume single run) | **Real** (`runtime/checkpoint.ts`, `schemas/continuity.ts`) |
| Cross-run query / recall surface | **Real but bounded** — `circuit history query` and `circuit history pull` can retrieve cited prior-run records; exact prior-failure queries are the strongest current case |
| Agent-side consumption (load relevant past reports at session start) | **Partial** — run-start recall can surface cited hints; broad recall quality and measured usefulness still need release evidence |

The next gap is not "make memory exist." It is proving that broad recall is
useful instead of noisy, and then reflecting that proof in release copy.

### The pitch this enables

The marketing now has two distinct payoffs operating on different time horizons:

1. **Day-one value (flow shape).** *Stop reinventing your flow. Ship the product.* Hooks the user.
2. **Compounding value (project memory).** *Circuit can build cited prior-run context over time, instead of leaving the next agent cold.* Justifies long-term commitment without overclaiming broad intelligence.

### Strategic implications

- **Moat shifts from flow schematics (replicable) to accumulated project history (real switching cost).** Once a user has a year of Circuit reports and evidence, leaving means losing institutional memory, not just retraining muscle memory.
- **Audience expands** from fatigue persona to *anyone running long-lived projects with coding agents* — including teams, agencies, enterprises.
- **Competitive surface upgrades** from "category of one" to a visible category
  (vs. memory files and repo-rule ecosystems). Being in a visible category
  beats being a category of one.
- **Circuit becomes the substrate for "agent observability."** Whether you build that layer or someone else does, owning the underlying data is leverage.

## 8. Capabilities brainstorm — sober tiers

What new capabilities are unlocked by queryable reports? Compared honestly against git history (the obvious existing tool).

### Strong (genuinely new value)

1. **Failed-attempt memory.** Agents repeat failed approaches because they can't see the past failures. Git doesn't preserve abandoned attempts; MEMORY.md compresses them out. Circuit captures every run including `@stop` and `revise` outcomes. *Uniquely Circuit territory.*
2. **Intent recovery for agents.** *"Why does the auth module retry 3 times?"* — agent retrieves the actual recorded brief instead of reverse-engineering from code. Database lookup, not reasoning under uncertainty.
3. **Trust calibration analytics.** *"How often does my agent's claimed completion actually pass verification on first try?"* Cannot be computed without structured runs. No git or MEMORY.md equivalent.
4. **Pre-task context loading for agents.** Before a new task, agent loads cited, relevant past reports from related work. Invisible UX, compounding payoff. Exact prior-failure hints are the current strongest case; broad usefulness still needs proof.

### Marginal (real but redundant with existing tools)

5. **Click-to-provenance for humans.** Better than git, but disciplined PR culture covers most of it. Don't lead with this — but the *agent-facing version* (above) is much stronger.
6. **Decision DAG visualization.** Cool demo; niche utility.
7. **Onboarding narrative.** Generated walkthrough of "how this codebase came to be." Most teams answer this with docs or by reading code.
8. **Decision-level debugging for humans.** `git bisect` + reading PRs covers a lot. Sharper for *agent debuggers* than for humans.

### Speculative

9. **Cross-project pattern recognition.** Limited audience; speculative.
10. **Decision-diff for code review.** Powerful in theory; requires deep report corpus to be useful.

### How Circuit compares to git, honestly

- **Git: code state over time.** Authoritative for *what* changed.
- **Circuit: decision state over time.** Authoritative for *why*.

Two different layers, complementary. Don't claim Circuit replaces git. The strongest comparison framing is the **MEMORY.md** one, not the git one — that's where Circuit's distinctiveness is sharpest.

### The sober conclusion

The thing that's genuinely new isn't any one UX innovation. It's the **data layer** — structured, schema-versioned records of agent decisions across a codebase's lifetime. The interesting downstream capabilities (failed-attempt memory, intent recovery, trust analytics, pre-task context) are real and hard to replicate without it. Some of the demo-friendly ideas (click-to-provenance, DAG visualization) are real but marginal vs. existing tools.

> *Circuit is the substrate for agent-native project memory. Most of what you build on top of it is plumbing, not innovation. The innovation is producing the substrate consistently in the first place.*

That's defensible.

## 9. Competitive landscape

Findings from a market scan in May 2026. The point: who is operating in the same shape-of-the-work space as Circuit, where they overlap, where Circuit is genuinely differentiated.

### Direct competitors (closest to Circuit's shape)

- **VexJoy Agent (`notque/vexjoy-agent`)** — 366 stars, 7 weeks old, very active. Multi-runtime (Claude Code / Codex / Gemini / Factory). Single-command intent routing (`/do <task>`) into a 6-step pipeline (ROUTE → PLAN → EXECUTE → VERIFY → DELIVER → LEARN). 44 domain agents, 106 skills, 71 hooks blocking incomplete work, 93 deterministic scripts. Key claim: *"Anti-Rationalization"* — exit codes, not assertions, count as evidence. **The closest analog Circuit has.** Their README leads with the exact unfurl marketing structure we developed (one command, steps dramatized, receipts at the end).
- **Superpowers (`obra/superpowers`)** — Active, official Anthropic marketplace listing. One opinionated 7-stage methodology (brainstorm → worktree → plan → subagent routing → TDD → review → finish) with skills library. Single methodology, not a flow taxonomy. Markdown-based records, not schema-versioned.
- **GSD / Get Shit Done (`gsd-build/get-shit-done`)** — Very active. 6 steps (Initialize → Discuss → Plan → Execute → Verify → Ship), parallel-wave execution, atomic commits per task, multi-runtime. `.planning/intel/` markdown+JSON store. The other close direct competitor.

### Adjacent (worth watching but not directly competing)

- **BMAD-METHOD (`bmad-code-org/BMAD-METHOD`)** — agile-roles-as-personas (PM, Architect, SM, Dev, QA). Different theory of the work — "what's missing is roles" vs Circuit's "what's missing is flows."
- **Spec Kit (`github/spec-kit`)** — GitHub-backed, agent-agnostic, 4-step spec→plan→tasks→implement. Will normalize spec-driven framing as default mental model. Platform risk, not feature risk.
- **shinpr's Claude Code flow repo** — niche stars (~333), strong execution on multi-agent role separation (task-executor + code-reviewer as separate agents). Worth watching as a smaller competitor with similar multi-agent discipline.
- **claude-mem (`thedotmack/claude-mem`)** — passive session memory capture with vector store. Complementary to Circuit, not competing.
- **Agent OS (`buildermethods/agent-os`)** — coding-standards injection layer for Cursor/Claude Code/Antigravity. Adjacent.
- **claude-task-master (`eyaltoledano/claude-task-master`)** — drop-in AI task management. Could feed into Circuit; not directly competing.

### Circuit's defensible differentiators (verified against the field)

The four properties Circuit has and direct competitors don't:

1. **Flow taxonomy.** Competitors ship one pipeline. Circuit ships distinct shapes for Build, Explore, Fix, and Review. *Different work needs different shapes* is a different theory of the field than *one universal pipeline.*
2. **Schema-versioned typed records.** Competitors produce markdown. Circuit's typed JSON reports are queryable in ways markdown isn't — the foundation for the project-memory positioning in Section 7.
3. **Six-layer override chain + depth modes.** No other project found has this granularity. Per-step model/effort selection plus low/medium/high/autonomous as per-invocation choice is genuinely unique.
4. **Custom flow shapes.** Circuit can author typed schematic flows that the engine runs as first-class peers to the built-in ones. The current Create path is CLI-only and experimental, while the product direction is Circuit proposing reusable flow shapes at the right moment. Most competitors offer skill/agent extensibility, not flow-shape extensibility. (See Section 10 for the personalized-flow direction.)

### Where Circuit is NOT differentiated (drop from lead)

- **TDD / evidence requirements** — VexJoy, Superpowers, GSD all do this. No longer category-defining.
- **Multi-agent routing** — commodity.
- **Claude-Code-plugin shape** — commodity.
- **Skills integration** — commodity.
- **Single-command unfurl marketing** — VexJoy's README does this; the structure is becoming category table-stakes.
- **"Anti-rationalization" framing** — VexJoy owns the rhetorical claim. Find different language.

### Open ground (no competitor found doing this)

- **YAML/JSON-defined flows as a product** (not a framework). Circuit's CLI-only Create utility proves the underlying shape, and the product opportunity is making that authoring feel proposed and timely rather than menu-driven.
- **Per-step model/effort overrides** at six layers of granularity.
- **Standalone Review surface** as a peer to Build (not a step inside Build).
- **Different flow shapes for thinking, changing, fixing, and reviewing** — the kinds of work the universal-pipeline competitors don't address well.

### Implications for the lead pitch

The lead should surface flow taxonomy *early* and *visibly*. The current pitch has it in the second sentence (*"named ways to explore, build, fix, and review"*) but doesn't make the philosophical bet explicit. A reader pattern-matching to VexJoy or Superpowers will assume "named flows" means "one pipeline with named stages" rather than "different flow shapes for different kinds of work."

Probable adjustment: make the *core-flow* and the *different-shapes-for-different-work* claim louder. *"One universal pipeline doesn't fit all your work. Circuit ships distinct shapes for thinking, changing, fixing, and reviewing."* Forces the reader to choose between the two theories of the field instead of conflating them.

### One-line answers for direct comparisons (before pitch ships)

- *vs. VexJoy:* "VexJoy ships one pipeline that routes everything. Circuit ships distinct flows for distinct kinds of work, with typed schema-versioned records you can query."
- *vs. Superpowers:* "Superpowers is one methodology. Circuit is a taxonomy of flows for different kinds of work."
- *vs. GSD:* "GSD ships a staged pipeline. Circuit ships routed flows with schema-versioned records and per-step model selection."

## 10. Flow customization — beyond "here are the pieces"

The lazy version of custom flows is *"here's the schematic format, build your own."* That treats personalization as a 2%-power-user feature. The bar in 2026 is higher: Circuit should *infer* a personalized flow from real signals and propose it.

### The tier structure of personalization

Useful mental model — not all "customization" is the same thing:

- **Tier 0** — Use the defaults. Most users.
- **Tier 1** — Tune knobs (depth, skills, model overrides). Easy.
- **Tier 2** — Adopt a Circuit-proposed flow variant. *This is where the personalization story should live.*
- **Tier 3** — Iterate on a flow conversationally with Circuit. *"Add a security-review checkpoint after Act."*
- **Tier 4** — Author a schematic from scratch. Power user only.

Circuit's distinctive bet should be making Tiers 2 and 3 effortless. Tier 4 is the existing lazy story; pushing users toward it is not the move.

### Concrete capabilities (from real signal, not vibes)

1. **Project-shape detection on install.** Read `package.json`, infer test runner, build command, lint command, framework. Propose flow defaults. *"I see Vitest. Build's verify step is `npm test`. I see Husky pre-commit. Verify adds those checks. Confirm?"*
2. **`/circuit:propose <description>`** — operator describes how they work in plain English; Circuit composes a flow shape from existing modules; shows a diff against the closest built-in flow; user accepts, edits, or rejects.
3. **Adaptive defaults from past runs.** *"Your Build runs revise at Plan 60% of the time. Suggest deeper Frame on default."* Concrete adjustment, surfaced to the user, opt-in.
4. **Conversational flow editing.** Schematic-as-data means edits can be natural-language requests that produce typed diffs.
5. **Flow-from-prose for new shapes.** The user describes the shape they want; Circuit produces a real, editable, exportable schematic.

### Why this is consistent with driver-stays-in-control

Every personalization move uses *real signal* (codebase shape, past runs, stated preferences) — not vibes-based AI inference. Every move is *transparent* (the user sees the proposed schematic, can read it, can edit it). Every move is *opt-in*. The output is a regular schematic — auditable, editable, exportable. Personalized but accountable.

### Working pitch line

> *Most agent tools give you templates and tell you to fill them in. Circuit watches your project, reads your past runs, and listens to what you tell it — then proposes flows that fit how you actually work. You stay in the driver's seat; Circuit handles the road.*

### Sober status

- **Today (architecture supports):** custom flow authoring via the CLI-only Create utility; schematic-as-data so changes are auditable, editable, exportable.
- **Near-term (small builds):** project-shape detection at install; `/circuit:propose <description>`; flow-diff visualization; conversational editing.
- **Aspirational (real product work):** adaptive defaults from past runs (depends on cross-run recall surface); behavior-based personalization (observing what the user actually does).

Don't ship the aspirational stuff in marketing. The near-term capabilities are enough to make the personalization claim concrete and verifiable.

### Risk to flag

"AI-personalized everything" is a tired marketing trope. The audience for Circuit will reject vibes-based claims instinctively. The defense: be aggressively concrete about what signals Circuit uses. Don't say *"learns how you work"* — say *"reads your package.json, looks at your past Circuit runs, and asks you three questions."* That's the version that survives the BS detector.

## 11. Open decisions

1. **Is project memory a co-equal lead beat, or the second beat under flow shape?**
   Working answer: flow leads (immediate hook), memory is the strong second beat. But the *Twitter-ready* one-liner is the memory framing — that's what travels.
2. **Build the cross-run recall surface (`circuit history`) before or after the comparison demo?**
   Working answer: build it first. Strengthens the demo (next session benefiting from previous reports) and makes memory positioning demonstrable.
3. **Decide on the keep-up channel.** Build it (and ship the moat) or stop promising it (and rephrase to architecture-supports-it).
4. **Pick the wedge audience for first launch.** Working answer: engineers, not designers — they have urgency and budget. Designers are second wave.
5. **Pick the noun.** Plugin, CLI, framework, service? Affects every downstream messaging choice.

## 12. Recommended near-term sequence

In order:

1. **Build the proof demo** (comparison demo: bug-fix run with vs. without Circuit, annotated blog post format).
2. **Prove broad `circuit history` recall quality** with release evidence before using stronger project-memory claims.
3. **Polish the first-run experience** until it's friction-free for new users.
4. **Build (or sunset) the keep-up channel.**
5. **Then invest in marketing.** Marketing without proof, polish, and target is what makes formative products feel like vapor.
