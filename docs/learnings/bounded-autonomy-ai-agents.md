# Bounded Autonomy for AI Agents and Circuit

Status: external research report
Date: 2026-06-01
Scope: bounded autonomy in AI agents, with design and messaging implications for
Circuit. This is research context, not current product behavior.

## Executive Summary

Bounded autonomy is a useful term, but it is not yet a mature standard term.
The stronger and older evidence base uses nearby language: levels of automation,
human oversight, least privilege, guardrails, traceability, escalation, and
runtime governance. Recent agent-specific sources increasingly use "bounded
autonomy" to mean the same basic pattern: let an agent act independently inside
clear limits, and make the limits observable, enforceable, and revisable. [S1]
[S2] [S3] [S4]

For Circuit, the useful definition is:

> Bounded autonomy means an agent can make local decisions and keep moving inside
> a declared flow, but the flow defines the allowed work, required checks,
> evidence, stop rules, and escalation points.

That maps cleanly to Circuit's vocabulary. A flow gives the agent a work shape.
Routes and checkpoints define where the run can go. Checks define what must be
true before it advances. Trace, reports, and evidence make the run inspectable.
Memory can orient the agent, but it must not authorize proof, routing, or writes.
That is exactly the product posture already implied by Circuit's docs. [C1] [C2]
[C3]

The design lesson is direct: Circuit should not market "full autonomy." It
should own the more credible position: useful autonomy with boundaries. The best
message is not "the agent can do anything." It is "the agent can keep moving
without going off-road."

## Core Findings

### 1. Autonomy is not binary

Human-factors research has treated automation as a set of levels and functions
for decades. Parasuraman, Sheridan, and Wickens divide automation across
information acquisition, information analysis, decision/action selection, and
action implementation, with levels from manual to fully automatic. They also
argue that automation changes human work and creates coordination demands, not
just labor savings. [S5]

NIST's AI Risk Management Framework says human-AI configurations can range from
fully autonomous to fully manual, and that human roles and responsibilities need
to be clearly defined. NIST also cautions that humans may over-assume AI systems
work well in all settings. [S6]

Circuit implication: do not treat "autonomous" as one setting. Model autonomy by
flow, stage, step, action, and consequence. A run can be autonomous for reading,
analysis, and local edits, while still requiring checkpoints for publishing,
deployment, destructive changes, permissions, or scope expansion.

Confidence: High. The term "bounded autonomy" is newer, but the levels-of-
automation and human-oversight base is mature.

### 2. Agents need autonomy, but open-ended autonomy compounds errors

OpenAI defines agents as systems that independently accomplish tasks on a user's
behalf, using models, tools, and instructions. Their guide says agents should
operate within clearly defined guardrails, stop at exit conditions, and hand
control back to the user on failure thresholds or high-risk actions. [S7]

Anthropic draws a useful distinction: workflows follow predefined code paths,
while agents dynamically direct their own processes and tool use. Anthropic also
warns that agent autonomy raises cost and error-compounding risk, and recommends
sandbox testing, guardrails, transparent planning, and careful tool interfaces.
[S8]

Circuit implication: Circuit is best framed as a hybrid. It does not remove the
agent's judgment. It gives that judgment a declared work pattern. The flow
should constrain the path enough to keep the work inspectable, while leaving
room for the agent to handle the messy parts that fixed scripts cannot predict.

Confidence: High. These are primary-source statements from major agent builders.

### 3. The main security failure is excessive agency

OWASP names "Excessive Agency" as a top LLM application risk. The failure is
not only bad model output. It is giving the model too much functionality, too
much permission, or too much autonomy, so a mistake or prompt injection can cause
damage through tools. OWASP's mitigations include narrower tools, scoped
permissions, user review before risky sends, logging, monitoring, and rate
limits. [S9]

Stanford's agentic AI guidance says teams should choose the lowest autonomy that
meets the need, require human approval for external communications, permission
changes, publishing, spending, deletions, deployments, and system-of-record
updates, and keep audit logs of tool calls and actions. [S10]

Circuit implication: every flow should make the blast radius explicit. This is
not only a security concern. It is also product clarity. A Build run should know
what it may edit, what it may only inspect, what it must verify, and what it must
escalate.

Confidence: High. OWASP and Stanford are independent and operationally specific.

### 4. Good oversight is at the right level, not every click

The EU AI Act requires high-risk AI systems to be designed so natural persons can
effectively oversee them. It names proportional oversight, understanding system
capabilities and limits, monitoring for anomalies, avoiding over-reliance,
overriding or reversing outputs, and interrupting the system into a safe state.
[S11]

Anthropic's 2026 agent-governance note makes the same product point: asking for
approval on every action becomes friction, so Plan Mode moves oversight to the
intended strategy while preserving intervention during execution. [S12]

Circuit implication: checkpoints should be strategic. Circuit should avoid
approval spam. It should pause where human judgment changes the run's authority:
unclear goal, risky scope, irreversible action, uncertain evidence, failed proof,
or contested review. Low-risk internal steps can proceed with logging.

Confidence: High for the oversight principle. Medium for the exact UX shape,
because product patterns are still evolving.

### 5. Traceability turns autonomy into accountable work

The UC Berkeley Agentic AI Risk-Management Standards Profile says agentic AI
needs comprehensive logging and traceability, clear escalation pathways, system-
level risk assessment, continuous monitoring, defense in depth, and transparent
documentation of system boundaries. It explicitly says bounded autonomy should
preserve meaningful human responsibility within clear limits. [S1] [S13]

NIST's 2026 AI Agent Standards Initiative also frames agents as systems capable
of autonomous actions that need standards for security, interoperability, agent
authentication, identity infrastructure, and secure human-agent and multi-agent
interactions. [S14]

Circuit implication: trace, reports, evidence, and run folders are not just
debug artifacts. They are the accountability layer. Product messaging should
lead with "inspectable work" and "evidence-backed runs," not vague "AI
autonomy."

Confidence: High for traceability and identity needs. Medium for the exact
future standard shape, because agent standards are still forming.

### 6. Runtime enforcement matters more than advisory prose

Microsoft's Agent Governance Toolkit frames governance as something built into
the execution path by intercepting actions, not as an optional wrapper. Its
lessons include security by default, defense in depth, ongoing monitoring, and
dynamic trust rather than a static trusted/untrusted split. [S15]

Recent preprints use similar design language. One bounded-autonomy architecture
lets language models interpret intent and propose actions, while typed action
contracts, permission-aware capability exposure, scoped context, validation
before side effects, execution boundaries, and optional human approval constrain
what can actually happen. Another preprint separates agency, meaning what the
system can do, from autonomy, meaning how much it acts without human
involvement. It recommends checkpoints, escalation, tool provisioning, tool
fencing, and write staging. [S3] [S4]

Circuit implication: docs and prompts are not enough. If a boundary matters, put
it into the schematic, runtime, connector permission, host permission, check, or
report contract. Product prose should say "Circuit records and checks the work";
it should not imply that prose instructions alone enforce safety.

Confidence: Medium. Microsoft is a primary product source. The preprints are
recent and useful, but not peer-reviewed.

### 7. Memory should orient, not govern

The Berkeley profile calls out memory and long-term state as privacy and
security risk surfaces, and recommends protecting memory against poisoning while
logging reasoning paths for traceability. [S13]

Circuit's own memory posture already takes the right shape: cited, hint-only,
staleness-aware memory. The history pull surface says memory cannot satisfy
proof, checkpoint, policy, route, recovery, verification, or write authority.
[C3]

Circuit implication: bounded autonomy and memory reinforce each other only if
memory stays advisory. A prior failure can change what the agent attends to. It
must not silently change the goal, widen scope, bypass checks, or approve a
route.

Confidence: High for the risk pattern. High for the fit with current Circuit
memory posture.

### 8. Progressive autonomy should be earned by evidence

The emerging bounded-autonomy literature and vendor writing repeatedly describe
progressive autonomy: start narrow, observe behavior, then expand authority only
when the evidence supports it. MongoDB's article is a vendor source, but its
specific message matches stronger sources: agent teams need auditable boundaries,
causal traces, escalation, and evidence for expanding authority. [S2]

Circuit implication: the self-auditing memory and effect-report direction is
aligned with bounded autonomy, but the messaging must stay honest. Circuit can
say it is designed to make improvement auditable. It should not say it already
proves every lesson improves outcomes until the measurement loop has enough
data. [C4]

Confidence: Medium. The design principle is well supported; the exact
"progressive autonomy" phrase is newer and often vendor-led.

## Design Guidance for Circuit

### Make the Autonomy Boundary First-Class

Every flow should make these things explicit:

- Objective: what the run is trying to do.
- Scope: files, systems, and tasks the run may touch.
- Allowed actions: read, write, test, review, publish, deploy, message, or spend.
- Disallowed actions: actions that require a checkpoint or are never allowed.
- Checks: proof required before the run advances.
- Escalation triggers: uncertainty, failed proof, repeated retries, risky action,
  missing authority, or scope expansion.
- Evidence: reports and trace entries the run must leave behind.
- Recovery: how to stop, hand off, revert, or resume.

This is Circuit's core design lane. If the boundary is only in prose, it will
rot. If it is in the schematic, checks, route, connector policy, and reports, it
can be tested.

### Treat Risk as Action-Specific

The useful question is not "is this run autonomous?" The useful question is
"which action can proceed without approval?" Suggested defaults:

| Action class | Default posture |
| --- | --- |
| Read local repo files | Autonomous inside the run scope |
| Search and inspect code | Autonomous, logged |
| Edit scoped local files | Autonomous for low-risk flows, with diff evidence |
| Run tests and linters | Autonomous, with output summarized as evidence |
| Delete data or broad file sets | Checkpoint |
| Change permissions or secrets | Checkpoint or blocked |
| Push, publish, deploy, send external messages | Checkpoint |
| Spend money or mutate systems of record | Checkpoint or blocked by default |
| Expand scope beyond the brief | Checkpoint |

These defaults match OWASP, Stanford, OpenAI, and the EU AI Act's focus on
consequence, reversibility, and human override. [S7] [S9] [S10] [S11]

### Put Oversight at Strategy Points

Circuit should prefer a few high-signal checkpoints over many low-signal
approval prompts. Good checkpoint moments:

- The goal is ambiguous.
- The plan changes the blast radius.
- The run cannot reproduce the problem.
- Verification is missing or failing.
- A review finds material issues.
- A step wants to publish, deploy, push, delete, spend, or message externally.
- Memory suggests a prior failure but current evidence is unclear.

This keeps the operator in control without making them the scheduler for every
small action.

### Keep Relays Bounded Too

If a flow relays work to a worker, the relay should carry its own boundary:

- role
- task
- allowed files or systems
- allowed tools or connector
- expected report schema
- acceptance criteria
- evidence requirements
- stop or escalation trigger

Subagents are where autonomy can quietly multiply. The trace should show which
worker decided what, which evidence it used, and how its output shaped the next
step.

### Keep Memory in the Advisory Lane

Memory should remain:

- cited
- hash or staleness checked when possible
- scoped by project, flow, and file when possible
- surfaced as a hint
- logged when pulled or injected
- unable to satisfy proof, policy, route, checkpoint, or write authority

The Phase 0 failure-legibility work is part of bounded autonomy. It makes the
agent better at recognizing a known stop condition without silently changing the
run's authority.

### Message Current Behavior Separately from Direction

The safe current claim is:

> Circuit gives coding agents repeatable flows with checks, traces, reports, and
> evidence, so autonomous work stays inspectable.

The future-direction claim is:

> Circuit is designed so memory and autonomy can earn more trust from measured
> outcomes over time.

Do not collapse those into "Circuit gets better automatically" unless the
measurement loop proves it on real runs.

## Messaging Guidance

### Positioning Sentence

Circuit is bounded autonomy for coding agents: it lets the agent keep moving
inside a clear flow, with checks, evidence, and checkpoints where judgment or
authority matters.

### Short Copy Options

- "Let the agent move. Keep the work inside the rails."
- "Autonomy inside a flow, not autonomy without a map."
- "Circuit gives coding agents room to work and a process you can inspect."
- "The agent can act independently where it is safe, and stop where judgment
  matters."
- "Repeatable flows for agent work that needs proof, not vibes."
- "More useful than micromanagement. More accountable than open-ended autonomy."

### Product Pillars

1. Flow-bounded work: the run has a declared shape.
2. Evidence-backed progress: checks, reports, and trace entries show what
   happened.
3. Strategic checkpoints: the operator stays in control at meaningful decision
   points.
4. Scoped capability: workers and tools get the authority the step needs, not a
   blank check.
5. Advisory memory: prior runs can orient the agent, but never overrule current
   proof.

### Words to Prefer

- bounded autonomy
- flow-bounded agent work
- scoped autonomy
- inspectable autonomy
- evidence-backed runs
- strategic checkpoints
- accountable agent work

### Words to Avoid or Qualify

- fully autonomous
- self-optimizing
- self-mutating
- no human needed
- permanent memory
- guardrails, when referring to memory
- governance platform, unless the enforcement surface is actually built

## Source Quality Assessment

| Source | Type | Authority | Recency | Use in this report |
| --- | --- | --- | --- | --- |
| NIST AI RMF 1.0 | Government framework | High | 2023 | Human-AI roles, risk management, automation range |
| NIST AI Agent Standards Initiative | Government initiative | High | 2026 | Agent standards, identity, secure agent interactions |
| EU AI Act Article 14 | Regulation | High | 2024 | Human oversight, override, interruption, proportionality |
| OWASP LLM06 Excessive Agency | Security standard project | High | 2025 | Least privilege, excessive functionality, permissions, autonomy |
| OpenAI practical agents guide | Primary vendor guide | High for OpenAI practice | 2026 | Guardrails, failure thresholds, high-risk human oversight |
| Anthropic effective/trustworthy agents posts | Primary vendor guides | High for Anthropic practice | 2024/2026 | Workflows vs agents, planning visibility, human control |
| Stanford agentic AI best practices | University security guidance | Medium-High | 2026 | Practical approval and risk-tier defaults |
| UC Berkeley CLTC Agentic AI Profile | Research/policy profile | Medium-High | 2026 | Bounded autonomy phrase, traceability, escalation |
| Parasuraman/Sheridan/Wickens | Peer-reviewed academic paper | High | 2000 | Levels and functions of automation |
| Microsoft Agent Governance Toolkit post | Primary vendor engineering post | Medium | 2026 | Runtime interception and dynamic trust pattern |
| Recent arXiv bounded-autonomy papers | Preprints | Medium-Low | 2026 | Emerging vocabulary and architecture patterns |
| MongoDB bounded autonomy article | Vendor article | Medium-Low | 2026 | Messaging and multi-agent framing only |

## Gaps and Uncertainties

- "Bounded autonomy" is not yet a standard term with one canonical definition.
  Treat it as a clear positioning phrase, not as a compliance category.
- Agent standards are moving quickly. NIST's AI Agent Standards Initiative is
  current, but many concrete standards are still in progress.
- Vendor sources agree on the broad pattern, but they have incentives to frame
  their products as the answer. Use them for patterns, not proof.
- Recent arXiv papers are useful for vocabulary and design options, but should
  not be treated as settled evidence until peer review, replication, or real
  production data exists.
- Circuit's current architecture supports bounded autonomy, but enforcement
  still depends on the host, runtime, connector permissions, and checks that are
  actually implemented. Do not let messaging outrun the code.

## Sources

[S1] UC Berkeley Center for Long-Term Cybersecurity, "Agentic AI
Risk-Management Standards Profile," version 1.0, February 2026.
https://cltc.berkeley.edu/wp-content/uploads/2026/02/Agentic-AI-Risk-Management-Standards-Profile.pdf
Accessed 2026-06-01.

[S2] MongoDB, "The Case for Bounded Autonomy - From Single Agents to Reliable
Agent Teams," February 25, 2026.
https://www.mongodb.com/company/blog/technical/the-case-for-bounded-autonomy
Accessed 2026-06-01.

[S3] Sarmad Sohail and Ghufran Haider, "Bounded Autonomy for Enterprise AI:
Typed Action Contracts and Consumer-Side Execution," arXiv:2604.14723,
submitted April 16, 2026. https://arxiv.org/abs/2604.14723 Accessed
2026-06-01.

[S4] Damir Safin and Dian Balta, "Autonomy and Agency in Agentic AI:
Architectural Tactics for Regulated Contexts," arXiv:2605.12105, submitted May
12, 2026. https://arxiv.org/abs/2605.12105 Accessed 2026-06-01.

[S5] Raja Parasuraman, Thomas B. Sheridan, and Christopher D. Wickens, "A model
for types and levels of human interaction with automation," IEEE Transactions
on Systems, Man, and Cybernetics - Part A, 2000. DOI 10.1109/3468.844354.
https://pubmed.ncbi.nlm.nih.gov/11760769/ Accessed 2026-06-01.

[S6] NIST, "Artificial Intelligence Risk Management Framework (AI RMF 1.0),"
NIST AI 100-1, January 2023. https://doi.org/10.6028/NIST.AI.100-1 Accessed
2026-06-01.

[S7] OpenAI, "A practical guide to building agents," 2026.
https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/
Accessed 2026-06-01.

[S8] Anthropic, "Building effective agents," December 19, 2024.
https://www.anthropic.com/engineering/building-effective-agents Accessed
2026-06-01.

[S9] OWASP GenAI Security Project, "LLM06:2025 Excessive Agency," 2025.
https://genai.owasp.org/llmrisk/llm062025-excessive-agency/ Accessed
2026-06-01.

[S10] Stanford University IT, "Know Your Risks: Agentic AI Best Practices,"
2026. https://uit.stanford.edu/security/agenticai/best-practices Accessed
2026-06-01.

[S11] European Union, Regulation (EU) 2024/1689, Article 14, "Human oversight."
https://eur-lex.europa.eu/eli/reg/2024/1689/oj Accessed 2026-06-01.

[S12] Anthropic, "Trustworthy agents in practice," April 9, 2026.
https://www.anthropic.com/research/trustworthy-agents Accessed 2026-06-01.

[S13] UC Berkeley Research, "New CLTC Report Provides Framework for Managing
Risks of Agentic AI," February 1, 2026.
https://vcresearch.berkeley.edu/news/new-cltc-report-provides-framework-managing-risks-agentic-ai
Accessed 2026-06-01.

[S14] NIST, "AI Agent Standards Initiative," created February 17, 2026, updated
April 20, 2026.
https://www.nist.gov/artificial-intelligence/ai-agent-standards-initiative
Accessed 2026-06-01.

[S15] Microsoft Open Source Blog, "Introducing the Agent Governance Toolkit:
Open-source runtime security for AI agents," April 2, 2026.
https://opensource.microsoft.com/blog/2026/04/02/introducing-the-agent-governance-toolkit-open-source-runtime-security-for-ai-agents/
Accessed 2026-06-01.

## Circuit Context Sources

[C1] [README.md](../../README.md) - current product shape: repeatable work
patterns, skills, checks, traces, reports, and evidence.

[C2] [UBIQUITOUS_LANGUAGE.md](../../UBIQUITOUS_LANGUAGE.md) - canonical product
vocabulary for flow, schematic, route, checkpoint, check, trace, report, and
evidence.

[C3] [docs/reference/history-pull.md](../reference/history-pull.md) - current
hint-only memory boundary.

[C4] [docs/ideas/self-auditing-memory.md](../ideas/self-auditing-memory.md) -
current memory ratchet thesis and honest messaging constraints.
