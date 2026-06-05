# Frontier-Lab Circuit Strategy

Status: current-strategy-context, 2026-06-05. This is a strategy proposal, not
current behavior, roadmap commitment, or implementation instruction.

## Short Version

A seasoned AI/ML engineer who knows the frontier-agent field would probably
tell us this:

Circuit should not race to become one more autonomous coding agent. It should
become the coordination and trust layer around coding agents.

The product should stay simple at the front door: run a named Flow, see what is
happening, approve the hard calls, and get a useful final answer. Under that
simple surface, Circuit should get much deeper: typed Reports, Evidence,
Checks, Trace records, Checkpoints, history, evals, Skill Hooks, Connectors, and
safe background Runs.

The winning direction is:

- make agent work easier to start;
- make agent work harder to fake;
- make long-running work easier to supervise;
- make prior Runs useful to the next Run;
- make flow authoring feel like shaping a team process, not programming a graph;
- make every serious product claim backed by checked evidence.

The next year should optimize for trust and habit formation before breadth.

## Boundaries And Assumptions

This note does not claim private frontier-lab knowledge. It uses public sources,
current Circuit docs and code paths, and strategic inference from those sources.
Public web sources were accessed on 2026-06-05.

Confirmed repo facts live in the claim inventory. Product recommendations are
strategy, not proof that the capability already ships.

## What This Engineer Would Notice

They would notice that Circuit already has a rare substrate:

| Circuit surface | Current capability | Strategic meaning |
| --- | --- | --- |
| Flow | A named kind of work such as Build, Fix, Explore, Prototype, Pursue, or Review. | The first-mile handle should stay plain and human. |
| Schematic and Block | Authored work shapes with typed inputs, outputs, routes, and evidence requirements. | This is the reusable process model. Do not turn it into generic prompt glue. |
| Run folder | Trace, Reports, Evidence, resume state, and close output. | This is the durable record that most agent tools still lack. |
| Check and acceptance criteria | Deterministic checks before a relay result can advance. | This is the anti-fake-done layer. |
| Checkpoint | Declared choices, pause/resume, and validated operator decisions. | This is the governance primitive for longer Runs. |
| Relay selection | Per-step Connector, model, effort, skill, and option resolution. | This lets Circuit route the right worker to the right kind of work. |
| Skill Hooks | Deterministic skill injection from runtime signals. | This is the first active expertise-routing surface. |
| History | Bounded, cited, hint-only recall and pull over prior Runs. | This can become agent-native project memory if it stays auditable. |
| Evals and release proofs | Claim levels, dry checks, and checked release evidence. | This can become the product's credibility engine. |
| Host adapters and Connectors | Host presentation is separate from worker execution. | This gives Circuit room to work across Claude Code, Codex, and future hosts. |

The strong opinion: these are not just implementation details. They are the
product.

## Outside Signal

The public agent field is moving in a few clear directions:

1. OpenAI's agent docs now center workflow building, tools, state, approvals,
   traces, evals, and trace grading rather than one-off chat calls. The Codex
   app also exposes Skills and Automations, and OpenAI's Codex safety writeup
   emphasizes bounded environments, high-risk review, and agent-native
   telemetry.
2. Anthropic's agent guidance draws a sharp line between workflows and agents.
   It recommends routing, parallelization, orchestrator-worker patterns, and
   clear tool boundaries when the task shape is knowable. Claude Code now has a
   rich extension layer: Skills, subagents, hooks, MCP, plugins, and memory.
3. GitHub, Cursor, Codex, Devin, and Factory are all pushing background or
   delegated coding agents: give a task, run in an isolated environment, produce
   a branch or PR, and ask a human to review.
4. Open-source frameworks such as LangGraph, AutoGen, and OpenHands are
   converging on durable execution, human-in-the-loop control, memory,
   tracing/observability, type-safe agent SDKs, and distributed or long-running
   agent systems.
5. Protocol work is splitting the world into clearer boundaries. MCP is the
   agent-to-tool/data edge. A2A is the agent-to-agent edge. Circuit should not
   duplicate either. It should decide when and how those edges are safe to use.
6. Agent evals are becoming more trace-aware and less benchmark-naive. OpenAI
   has warned that SWE-bench Verified is no longer a good frontier-launch
   signal because of contamination and flawed tests. Production-agent research
   still finds reliability and human evaluation at the center of real
   deployments.
7. PR-lifecycle research suggests the future is not "agents merge code by
   themselves." Even where agents initiate and carry work forward, terminal
   merge authority remains overwhelmingly human.

That points to a product gap: people need a way to delegate more while staying
able to understand, validate, and steer the work.

Circuit is well-shaped for that gap.

## Major Product Directions

### 1. Make Circuit A Trust Layer, Not Just A Flow Runner

The most important product decision is to make trust the center of gravity.

The user should not experience Circuit as "a process template." They should
experience it as: "I can hand work to agents and still know what happened, why
it happened, what was checked, and what needs my decision."

Recommended work:

- Add a "judge mode" or "claim check" surface that can inspect a diff plus a
  claimed outcome, run the right checks, and emit a verdict.
- Promote claim schemas: what the agent says it did, what files changed, what
  proof exists, what remains uncertain.
- Make Close output more decision-shaped: merge, review manually, retry, stop,
  or split.
- Keep model judgment secondary to deterministic evidence wherever possible.

Tradeoff: this may feel less magical than autonomous building, but it is more
durable. Better models make proof-carrying claims more valuable, not less.

### 2. Build The Evidence And Eval Engine First

Circuit should become unusually serious about proof.

Recommended work:

- Ship flow eval suite manifests over the existing eval runners.
- Keep claim-grade status rare and hard to earn.
- Add trace-aware review of failed Runs: where did the flow drift, where did the
  worker overclaim, where did Check or Review catch it?
- Add a public proof demo: same task with and without Circuit, focused on
  evidence produced, not a rigged quality win.
- Add an internal "claim inventory" for every public product claim.

Tradeoff: this slows marketing. That is good. Circuit's credibility should come
from checked claims, not unchecked confidence.

### 3. Turn History Into Pull-Based Project Memory

Circuit's durable edge is the Run record. The next product move is making that
record useful during future work.

Recommended work:

- Ship a host-facing History Ask surface over existing history query/pull.
- Keep history hint-only. It must not route, approve, prove, or close work.
- Record whether pulled history was used, ignored, helpful, or misleading.
- Add failed-attempt memory as the first high-value use case.
- Add "why is this code like this?" answers backed by cited prior Reports.

Tradeoff: useful memory takes time to earn. Day-one value still needs to come
from Flow shape and proof. Memory is the compounding layer.

### 4. Make Long-Running Work Supervised, Not Unattended

The field is clearly moving toward background agents. Circuit should support
that, but with visible governance.

Recommended work:

- Add a read-only Run inspection surface before adding more autonomy.
- Add clearer waiting, blocked, failed, stopped, and checkpoint states.
- Add multi-channel Checkpoint delivery as a gateway around the existing
  Checkpoint primitive.
- Prototype a heartbeat supervisor for long Runs: read the Run record, write
  visible correction notes, and escalate when the Run drifts.
- Keep work isolated by branch or worktree before allowing background writes.

Tradeoff: long-running autonomy creates operational surface area. Do not build a
multi-worker swarm before one supervised background Run is easy to inspect.

### 5. Make Skill Hooks The Expertise Router

Skills are becoming a shared unit across hosts. Circuit's advantage is that it
can load them from typed runtime signals, not from hidden model guesses.

Recommended work:

- Keep hooks deterministic and signal-based.
- Add observability for why a hook fired, what skill was injected, and why a
  hook was muted or unavailable.
- Add skill evals: a skill should be testable, not just described.
- Let teams bind skills by project policy, flow, stage, step, and file surface.
- Avoid storing concrete local skill ids in public flow definitions.

Tradeoff: this is easy to overcomplicate. V1 should explain three things well:
what happened, what skill was loaded, and what evidence changed.

### 6. Make Flow Authoring Feel Like Process Design

Circuit should eventually let users create and improve flows, but not through a
freeform graph builder.

Recommended work:

- Start with flow packs: curated families of flows for code review, release,
  migrations, docs, incident response, and frontend QA.
- Add a guided Create path that composes known Blocks and known report shapes.
- Let Circuit propose flow improvements from repeated Run evidence, but keep
  them as suggestions until an operator accepts and evals cover them.
- Preserve the rule that normal flow additions do not require runtime edits.

Tradeoff: dynamic flows are strategically interesting and dangerous. The
compiler should reject under-specified work before runtime sees it.

### 7. Build The Friendly First Mile

Depth will not matter if the first five minutes feel heavy.

Recommended work:

- Make `/circuit:run` explain the chosen Flow in one sentence.
- Add a "what is happening now?" view over progress events and Reports.
- Improve final summaries so they read like a human handoff, not a schema dump.
- Add one proof-oriented first-run demo for Fix and one exploration-oriented demo
  for Explore.
- Keep command naming boring. Build, Fix, Explore, Pursue, Review. Do not lead
  with "typed coordination" as a user-facing noun.

Tradeoff: this is not less technical work. It is the work that makes the
technical depth usable.

## 12-Month Roadmap

### Quarter 1: Trust And First Mile

Goal: make the current product easier to try and easier to believe.

Ship:

- History Ask over existing history query/pull.
- Run inspection: list Runs, show status, show why the Run is waiting or failed,
  and link to Reports.
- Flow eval suite manifests and `check-ideas`/`check-evals` style validation.
- One public proof demo for false-done prevention.
- Skill Hook observability: fired, muted, unavailable, injected.
- First-run copy and summaries for Build, Fix, Explore, and Review.

Do not ship:

- new broad autonomy modes;
- dynamic flow generation;
- marketplace surfaces.

### Quarter 2: Supervised Background Work

Goal: let work continue while the operator is away, without hiding control.

Ship:

- Multi-channel Checkpoint delivery V1 with declared choices only.
- Background Run status board.
- Worktree or branch isolation for write-capable background Runs.
- Close Preview Checkpoint for external writes such as tracker output or PR
  updates.
- Failure/blocked digest that names what the operator should do next.

Do not ship:

- arbitrary free-form checkpoint replies;
- agent-chosen approvals;
- multi-executor swarms.

### Quarter 3: Flow Packs And Claim Checks

Goal: turn Circuit from a fixed set of built-in flows into an extensible process
toolbox.

Ship:

- A guided custom-flow path over known Blocks.
- One external flow pack, likely review/release or migration oriented.
- Claim Check / judge-mode pilot for a diff plus a claimed outcome.
- Flow pack eval requirements: every pack needs at least smoke and regression
  proof before distribution.
- Better Connector policy for GitHub, tracker, CI, and MCP-backed tools.

Do not ship:

- arbitrary user-defined Block code as the default extension path;
- hidden adaptive defaults that memory can change silently.

### Quarter 4: Ratchet And Distribution

Goal: let Circuit improve from evidence without becoming self-modifying magic.

Ship:

- Helped/misled tracking for history pulls.
- Flow improvement suggestions from repeated Run evidence.
- A small pack registry or catalog with proof status.
- Product copy that only uses checked claims.
- Release readiness that ties public claims to eval suites and proof Runs.

Do not ship:

- automatic flow mutation;
- public claims that are not backed by a named proof or eval result.

## Near-Term Bets

If the next 30-45 days matter most, do these:

1. **History Ask.** Smallest step toward project memory. High leverage, low
   authority risk.
2. **Run inspection.** Operators need to see what happened before trusting
   longer Runs.
3. **Flow eval suite manifests.** Turn existing eval work into an auditable
   product system.
4. **Skill Hook observability.** Make the new expertise-routing surface legible.
5. **False-done proof demo.** Show the exact pain Circuit solves.
6. **First-run summary polish.** Make the tool feel calm, not ceremonial.

## What Not To Build Yet

- A visual graph builder. It will make Circuit look approachable while making
  contracts weaker.
- Model-authored dynamic flows that execute immediately. Suggest first, prove
  later.
- Memory that silently changes routing, proof, approval, or close behavior.
- Free-form multi-channel approval parsing. Declared choices first.
- A universal MCP gateway that treats every external tool as equally safe.
- Multi-executor background swarms. One supervised executor first.
- Public benchmark claims from discovery or smoke evidence.
- Enterprise dashboards before the individual engineer habit is real.

## Claim Inventory

| ID | Claim | Confidence | Evidence | Boundary |
| --- | --- | --- | --- | --- |
| C01 | Circuit currently runs named Flows over typed Blocks, Steps, Routes, Reports, Evidence, and Traces. | confirmed | `UBIQUITOUS_LANGUAGE.md`, `docs/flows/authoring-model.md`, `docs/architecture/run-process.md` | This does not mean every future Block exists. |
| C02 | Run resolves connector, model, effort, skills, and invocation options per relay rather than once at startup. | confirmed | `docs/architecture/run-process.md`, `docs/contracts/connector.md`, `docs/configuration.md` | Shipping flows do not yet have perfect curated per-step defaults. |
| C03 | Human Decision and Checkpoint are already host-neutral concepts. | confirmed | `docs/flows/authoring-model.md`, `docs/contracts/host-adapter.md`, `docs/architecture/run-process.md` | Multi-channel delivery is proposed, not shipped. |
| C04 | History recall/query is useful but bounded and non-authoritative. | confirmed | `docs/reference/history-pull.md`, `docs/ideas/pull-query-memory-engineering-proposal.md` | Helped/misled tracking is not yet implemented. |
| C05 | Circuit has eval claim levels and treats claim-grade evidence differently from smoke, regression, and discovery evidence. | confirmed | `evals/README.md`, `docs/ideas/flow-eval-suites-implementation.md` | Suite manifests remain proposal material. |
| C06 | OpenAI's public agent platform emphasizes tools, state, approvals, traces, evals, and trace grading. | confirmed | [OpenAI Agents SDK docs](https://developers.openai.com/api/docs/guides/agents), [OpenAI trace grading docs](https://developers.openai.com/api/docs/guides/trace-grading) | Public docs, not private internal strategy. |
| C07 | OpenAI's Codex direction includes Skills, Automations, bounded execution, high-risk review, and telemetry. | confirmed | [Introducing the Codex app](https://openai.com/index/introducing-the-codex-app/), [Running Codex safely at OpenAI](https://openai.com/index/running-codex-safely/) | Product surfaces may keep changing. |
| C08 | Anthropic's public guidance distinguishes structured workflows from more autonomous agents and recommends routing, parallelization, and orchestration patterns. | confirmed | [Anthropic: Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents) | This is guidance, not a full product roadmap. |
| C09 | Claude Code's extension layer now includes Skills, subagents, hooks, MCP, and plugins. | confirmed | [Claude Code extension overview](https://code.claude.com/docs/en/features-overview), [Claude Code subagents](https://code.claude.com/docs/en/sub-agents), [Claude Code hooks](https://code.claude.com/docs/en/agent-sdk/hooks) | Host behavior can change quickly. |
| C10 | MCP is a standard agent-to-tool/data integration boundary, while A2A targets agent-to-agent interoperability. | confirmed | [Anthropic MCP announcement](https://www.anthropic.com/news/model-context-protocol), [MCP specification](https://modelcontextprotocol.io/specification/2024-11-05/index), [A2A specification](https://google-a2a.github.io/A2A/specification/) | Circuit should integrate at boundaries, not replace these protocols. |
| C11 | Background and delegated coding agents are becoming normal across major tools. | confirmed | [GitHub Copilot cloud agent docs](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent), [Cursor background agent docs](https://docs.cursor.com/background-agent), [OpenAI Codex](https://openai.com/codex/), [Cognition Devin](https://cognition.ai/), [Factory](https://www.factory.ai/) | The products differ sharply in safety and review posture. |
| C12 | Open-source agent frameworks are converging on durable execution, human oversight, memory, observability, and type-safe SDKs. | confirmed | [LangGraph](https://github.com/langchain-ai/langgraph), [AutoGen](https://www.microsoft.com/en-us/research/project/autogen/), [OpenHands SDK overview](https://docs.openhands.dev/sdk/arch/overview) | These are framework trends, not direct competitors in every use case. |
| C13 | Production-agent research still finds reliability and human evaluation central. | supported | [Measuring Agents in Production](https://arxiv.org/abs/2512.04123) | Survey findings may not perfectly match coding-agent users. |
| C14 | Frontier software-agent benchmarking needs fresh, contamination-aware evals. | confirmed | [OpenAI: Why SWE-bench Verified no longer measures frontier coding capabilities](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/) | This does not make all existing evals useless. It makes claim discipline more important. |
| C15 | PR-lifecycle research suggests agents can initiate work while humans retain merge authority. | supported | [Collaborator or Assistant?](https://arxiv.org/abs/2605.08017) | This is early research and should be treated as directional. |
| C16 | AlphaEvolve-like systems show that search plus automated evaluators can unlock stronger coding-agent loops in narrow domains. | supported | [Google DeepMind AlphaEvolve](https://deepmind.google/discover/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/) | Circuit should borrow the eval loop idea, not claim algorithm-discovery parity. |

## Source Quality

| Source group | Authority | Used for |
| --- | --- | --- |
| Circuit docs and code paths | High for current Circuit behavior | Capability map and implementation boundaries. |
| OpenAI, Anthropic, Google, GitHub, Cursor, Microsoft, OpenHands official docs | High for each vendor or project | Public direction of agent platforms and coding agents. |
| arXiv / research papers | Medium to high | Production-agent and PR-lifecycle evidence. |
| Existing `docs/ideas/` notes | Medium | Prior strategy context, not current behavior. |

## Final Recommendation

The highest-value version of Circuit is not a smarter agent. It is the system
that makes agent work safe enough, legible enough, and repeatable enough that
people can actually delegate more.

Keep the first screen simple. Deepen the evidence layer. Make memory pull-based.
Make long Runs supervised. Make flow authoring constrained and testable. Make
every product claim earn its proof.

That is the path that still makes sense if models get much better.
