# Circuit

Circuit is the product context for making delegation to coding agents more trustworthy, repeatable, and useful. Its central product insight is that skilled humans use tried-and-true processes because judgment works better with structure; Circuit explores what that same kind of process unlocks for coding agents. Circuit is a better working environment for capable agents, not a correction mechanism for bad agents.

## Language

**Circuit**:
A framework for agentic coding that gives coding agents a better working environment: powerful, repeatable work patterns, timely skills, evidence to evaluate against, and lessons from previous attempts.
_Avoid_: agent drift fixer, workflow orchestrator

**Agentic coding**:
Software work delegated to coding agents that can plan, act, check, and revise across more than one step. Circuit is for people leaning into more autonomous agentic coding, where the agent needs a human-readable process, evidence, and decision points.
_Avoid_: AI coding, vibe coding

**Delegation**:
Handing software work to a coding agent with enough context, process, and evidence expectations that the agent can carry more of the work independently.
_Avoid_: prompting, using an agent

**Confidence**:
The operator's trust that the agent did its best work, did not take shortcuts, did not spin its wheels wastefully, and is learning from past evidence instead of repeating mistakes.
_Avoid_: control, micromanagement

**Flow**:
A repeatable process for a kind of developer work. A flow gives an agent the same kind of helpful structure that a good team process gives a human. Flow should remain lightly visible to users as feedback about the process Circuit chose, but users should not have to start by choosing a flow.
_Avoid_: workflow, pipeline, making flow selection the primary user burden

**Run-first model**:
Circuit should feel like a coherent operating system for agentic coding work, not a toolbox of disconnected commands. Run is the dominant default command: the operator describes the task, Circuit selects the appropriate flow or flows, and the agent follows the right process for that work. Individual flows still exist as internal process machinery or expert controls, but they should not be surfaced as equal top-level choices unless user demand proves that need.
_Avoid_: command grab bag, making users pick among many flows up front, presenting every flow as a primary command

**Run routing posture**:
Run should behave as a router by default. If the task is clear enough, Circuit should select the appropriate flow and proceed. Clarification should be conditional, not the default interaction. Circuit already has a Clarify block; current implementation uses Clarify in the Goal flow, while Run's front door still relies on routing instructions and the deterministic classifier. A future conversation-driven goal-alignment flow may be useful, but it should not make ordinary Run feel like open-ended chat.
_Avoid_: turning Run into a chat prelude, asking clarifying questions by default

**Goal-backed Run direction**:
A likely future product model is that Run absorbs the useful Goal primitives and becomes the goal-oriented front door. When invoked, Run decides whether the request needs clarification. If clarity is missing, it uses the Clarify block. If clarity is sufficient, it formulates a well-structured goal, selects and runs the appropriate flow or flows, and continues until the goal is actually met or honestly blocked. Formulating a strong goal is part of equipping the agent with what it needs to succeed, not setup overhead before the real work. In that model, today's Goal flow may be renamed or folded into Run.
_Avoid_: treating Goal as a separate user-facing noun forever, stopping after flow selection instead of goal completion

**Run progress surface**:
Run should show a compact progress story by default: goal, selected process, current stage, checkpoint status when action is needed, and done or blocked outcome. Detailed traces and evidence should remain available, but the default surface should reduce cognitive load rather than replacing one stream of chat with a stream of logs.
_Avoid_: verbose trace by default, log-stream UI, proof-heavy operator output, hiding evidence entirely

**Run final output**:
Run's human-facing final output should be very succinct: what happened, whether it is done or blocked, and any decision or follow-up the operator needs. The richer durable output should be agent-facing: enough context, evidence, and handoff state for future agents or future runs to continue, recover, or improve.
_Avoid_: long human reports, proof bundles as the default final answer, burying required operator action

**Surface output**:
The short human-facing output Circuit shows during or after a run. Surface output should reduce cognitive load and focus on status, outcome, and required operator decisions.
_Avoid_: proof bundle, full trace, agent handoff note

**Checkpoint**:
An exploratory human-in-the-loop surface for digestible decision points during a run. The original product bet was rich HTML UI that lets the operator preview UI changes or compare UI variants; checkpoints later expanded to include clarifying questions. Treat the exact purpose as still in motion, but preserve the bet that generated HTML can make agentic coding workflows easier for humans to judge and steer when judgment is genuinely needed.
Checkpoints should be rare and high-value. Use them when human judgment materially improves the outcome: UI variant choice, risky direction approval, ambiguous goal scope, blocked or uncertain recovery, or visual review. Otherwise the agent should proceed without asking for reassurance.
_Avoid_: plain question prompt only, proof bundle, generic pause with no rich context, routine handholding

**Run artifacts**:
The durable agent-facing outputs from a run: structured reports, evidence, trace entries, checkpoints, handoff state, and memory material. Run artifacts should be complete enough for agents and future runs to continue, recover, evaluate, and improve without making the human read everything. In product prose, name the concrete surface (report or evidence) per UBIQUITOUS_LANGUAGE.md.
_Avoid_: treating artifacts as the primary human output, unstructured chat residue

**Flow authoring**:
A future product capability for creating or customizing flows. Authoring matters to the long-term product, but the near-term value should come from strong prebuilt flows that help users delegate real coding work without first designing a process.
_Avoid_: authoring-first positioning, making setup feel required before value

**Skilled process**:
A tried-and-true way of doing useful work that reduces avoidable mistakes, guessing, and cognitive load. Circuit explores what coding agents can do when they are given the kind of process skilled practitioners use instead of being left to solve every task ad hoc.
_Avoid_: checklist, ceremony

**Ad-hoc agent work**:
Coding-agent work where the agent decides the shape of the task on the fly without a predefined process. Ad-hoc work can succeed, but it leaves more room for shortcuts, repeated mistakes, wheel-spinning, and hidden uncertainty for the operator.
_Avoid_: flexible work, normal chat

**Ad-hoc chat**:
The dominant current working pattern for agentic coding, where the user manages many chat threads, remembers current state, chooses which skill to invoke, and manually asks for routine process steps. Circuit can still operate through chat surfaces; the contrast is that Circuit moves the process burden into repeatable flows.
_Avoid_: state of the art, freeform collaboration

**Root enemy**:
Ad-hoc chat as the default working pattern for serious agentic coding. Manual steering, handholding, cognitive load, and low trust in agent output are the symptoms; the deeper problem is that the user is forced to carry process, state, and routine coordination in chat.
_Avoid_: blaming weak agents, generic workflow pain

**Flawed interaction paradigm**:
The current pattern where capable coding agents are forced to work through ad-hoc chat while the user carries the process, state, and routine prompting burden. Circuit fixes this interaction pattern rather than fixing the agent.
_Avoid_: bad agents, weak models

**Working environment**:
The surrounding conditions that help a coding agent and its operator do good work together. Ad-hoc chat is not a great working environment for the human, and it is not a great working environment for the agent either; Circuit gives both sides a clearer process, shared state, evidence, and lessons from previous work.
_Avoid_: control system, agent cage

**Better working environment**:
The core product posture that Circuit gives capable coding agents the conditions they need to do their best work: clear process, timely skills, evidence, checkpoints, and lessons from previous work. It frames Circuit as improving the environment around agents rather than correcting agents themselves.
_Avoid_: agent control system, agent correction

**Product posture**:
Lead with Circuit as a process layer for coding agents, not as a wholly new UI. Circuit may use existing chat hosts, but it changes the working pattern by equipping agents with repeatable flows, evidence expectations, checkpoints, and memory-informed improvement.
_Avoid_: promising to replace chat UI, interface-first framing

**Product model**:
The conceptual shape of what Circuit is, what value it provides, and how people understand its work. The product model can change when a clearer value prop calls for different concepts.
_Avoid_: implementation architecture

**Value-prop-aligned simplification**:
Simplifying Circuit by making its product concepts and user experience express the current value prop more clearly, even when that means changing older product concepts.
_Avoid_: cleanup for its own sake, preserving the current model by default

**Circuit value prop**:
Circuit helps operators equip coding agents with reliable, repeatable, iteratively self-refining processes that automate much of the manual steering, handholding, and cognitive load that plague agentic coding.
_Avoid_: workflow automation, generic orchestration, agent correction, babysitting agents

**Effectiveness ratchet**:
A future-facing product direction, in active development, where Circuit gradually improves its flows by using the rich historical artifacts and evidence produced by prior runs. This is related to Circuit's memory work, but should remain outside the current core promise until the behavior is more mature. Frame it like a skilled human getting better through prior evidence and experience, not like invisible autonomous mutation.
_Avoid_: magic optimization, hidden self-editing, finalized memory model, promising that Circuit already gets better over time

**Memory posture**:
Memory is primarily agent-facing. It should help future agents and future runs perform better without making the operator manage memory as a product surface. When Circuit updates memory, the human-facing surface should briefly say what changed and why, especially when the update may affect future behavior. The update policy is still TBD, with a current leaning toward automatic memory updates rather than approval-heavy memory management.
_Avoid_: memory management UI by default, silent meaningful memory updates, making users inspect memory artifacts, approval ceremony for every update

**Memory scope**:
Memory scope is still exploratory. The likely starting point is project memory plus flow-specific memory, because both map naturally to run evidence and repeat work in a repo. Operator-level memory may become useful later, but should be explored more carefully because it is broader, more personal, and more likely to affect behavior across contexts.
_Avoid_: locking the memory schema too early, operator-level memory as the default starting point

**Memory use priority**:
Use memory to improve flow execution first. Early memory should help the selected flow run better in the current project: known verification commands, flaky tests, subsystem rules, previous failure causes, risky files, and useful prior evidence. Improving flow selection and evolving flows from memory are valuable later directions, but are riskier and should follow execution wins.
_Avoid_: silent routing changes from memory, premature self-evolving flows

**Memory indicator**:
When memory influences a run, surface a succinct indicator in the human-facing output. The indicator should say enough to make behavior understandable, without turning memory into a report the operator has to inspect.
_Avoid_: spooky invisible memory use, verbose memory explanations

**Human-oriented agent language**:
The writing rule that Circuit should describe agents the way it would describe skilled human practitioners in a good working environment. Prefer ordinary human work language such as process, practice, judgment, evidence, lessons, and experience before introducing product or runtime terms.
_Avoid_: memory, process layer, orchestration, framework-first explanations

**Process**:
The next layer above skills. Process decides when skills are used, how work moves from one step to the next, what evidence is needed, and how the work improves over time.
_Avoid_: process layer, orchestration layer

**Skill**:
A reusable capability an agent can apply during work. A skill teaches a move; a flow combines skills into a repeatable process.
_Avoid_: tool, isolated trick

**Practice**:
A messaging word for the broader discipline or learned way of doing skilled work repeatedly. Circuit should use practice to explain the value of flows, not as a first-class product object. Users create, run, edit, and share flows; Circuit helps improve practices through those flows.
_Avoid_: product object, methodology, framework jargon

**Evidence-driven self-evaluation**:
The feedback loop where an agent evaluates its own work against concrete evidence. Circuit provides the framework for that evaluation: the process shape, required reports, checks, checkpoints, and saved evidence.
_Avoid_: passive logging, agent self-reflection

**Evidence audience**:
Circuit evidence is primarily for agents and future runs. It helps agents check their work, recover, coordinate, remember what happened, and improve over time. Operators usually care less about inspecting proof bundles than about seeing the requested result reflected in the product or codebase. Surface evidence to operators when it clarifies a checkpoint, failure, uncertainty, or follow-up; otherwise keep it available without making it the main output.
_Avoid_: assuming users want to read proof, evidence-first final reports, hiding evidence from agents

**Codex invocation**:
In Codex, describe Circuit as invoked through slash commands such as `/circuit:run`, unless `@Circuit` is proven in the installed host.
_Avoid_: `@Circuit` as the documented Codex entrypoint

## Example Dialogue

> **Dev:** "Is Circuit mainly here because agents drift?"
>
> **Domain expert:** "No. Circuit is here because good process helps capable agents do better work. Less drift is a benefit, not the core story."
>
> **Dev:** "So are skills enough?"
>
> **Domain expert:** "No. A skill is one move. A flow gives the agent the practice for when and how to use those moves."
>
> **Dev:** "Who is doing the self-evaluation: Circuit or the agent?"
>
> **Domain expert:** "The agent evaluates the work. Circuit provides the framework that makes that evaluation evidence-driven."
>
> **Dev:** "Is Circuit trying to keep me in control of every step?"
>
> **Domain expert:** "No. Circuit is trying to preserve confidence while you delegate more. You should know the agent did its best work, checked itself, and learned from prior evidence."
>
> **Dev:** "Why not just let the agent figure out the process?"
>
> **Domain expert:** "Sometimes that works. Circuit exists because useful work benefits from skilled process: fewer shortcuts, less wheel-spinning, clearer evidence, and less guessing for the operator."
>
> **Dev:** "What is Circuit replacing?"
>
> **Domain expert:** "Not the coding agent. Circuit replaces ad-hoc chat with process: the next layer above skills."
>
> **Dev:** "So Circuit is fixing agents?"
>
> **Domain expert:** "No. Circuit gives capable agents the process they need to do their best work. It fixes the ad-hoc interaction pattern around them."
>
> **Dev:** "Who benefits from that?"
>
> **Domain expert:** "Both sides. Ad-hoc chat is not a great working environment for the human, and it is not a great working environment for the agent either."
>
> **Dev:** "Why would the agent benefit from Circuit?"
>
> **Domain expert:** "Because Circuit is a better working environment for the agent: clearer process, better timing for skills, evidence to evaluate against, and lessons from previous attempts."
