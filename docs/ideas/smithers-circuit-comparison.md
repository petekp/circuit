# Smithers And Circuit: Comparison And Takeaways

> Status: research / idea doc, written 2026-06-03. This is source-backed
> comparison and recommendation only. It is not an implementation plan, roadmap
> commitment, or current behavior claim.

## Short version

Smithers and Circuit are trying to make coding-agent work less ad hoc. Both
package repeatable work patterns, route work through multiple agents or models,
record what happened, and care about review loops. That is the shared ground.

The split is deeper than the overlap. Smithers is a general durable workflow
runtime. You write or generate a TypeScript/JSX workflow tree, Smithers renders
it, schedules ready tasks, persists outputs to SQLite, and exposes operating
surfaces such as events, evals, metrics, Gateway, MCP, approvals, replay, and
agent adapters.

Circuit is an opinionated host plugin and flow engine for coding-agent process.
It starts from an operator intent, chooses or receives a flow, runs a compiled
flow through steps, checkpoints, relay workers, checks, reports, traces, and
evidence. Circuit's strength is not "you can author any workflow in code"; it is
"the right bounded process runs in your coding host and leaves proof behind."

The recommendation is straightforward:

1. Do not turn Circuit into Smithers.
2. Do copy Smithers' best operating ideas: better run inspection, eval suites,
   explicit lifecycle event categories, richer starter/workflow catalog
   discoverability, and stronger resume/replay language where Circuit can
   actually support it.
3. For Skill Moments, Smithers is a useful warning: make the event and evidence
   contract real before actuation. A report-only first slice fits that lesson.

## Working hypotheses

I tested three hypotheses while reading the sources:

1. **Same job, different layer.** Smithers and Circuit both organize agent work,
   but Smithers owns a general workflow runtime while Circuit owns a curated
   process layer inside coding hosts.
2. **Smithers has product surface Circuit should copy.** The likely imports are
   not React/TSX itself. They are run legibility, evals, examples, lifecycle
   events, and operator control surfaces.
3. **Smithers has strategic surface Circuit should avoid.** Gateway, hosted
   control plane, broad workflow-code authoring, and prompt optimization are
   expensive platform commitments unless Circuit first proves the narrower user
   value.

The evidence supports all three.

## What Smithers is, in Circuit terms

Smithers calls itself a durable runtime for long-running AI coding agents. Its
main model is a composable TypeScript tree: the workflow renders to tasks,
tasks run, outputs are validated with Zod, and state is persisted to SQLite so
runs can survive crashes and resume from completed work. The public docs describe
the loop as render, extract, schedule, execute, persist, and re-render. They also
name the frame as the unit of progress for resume, hot reload, observability, and
time travel.

In Circuit vocabulary, Smithers is closest to a general-purpose flow runtime
with:

- authored workflows as TSX code,
- steps as `<Task>` nodes,
- routes and control flow as JSX constructs such as `<Sequence>`, `<Parallel>`,
  `<Branch>`, `<Loop>`, and approval nodes,
- reports as Zod-validated task outputs,
- trace and evidence as persisted events, frames, output rows, attempts, and
  observability data,
- connectors as CLI or SDK agent integrations,
- checkpoints as approval and human-task nodes.

That mapping is useful, but it is not exact. Smithers is not just a bigger
Circuit flow package. It is a lower-level runtime and operating platform that
lets workflows define their own graph at render time.

## What Circuit is, in Smithers terms

Circuit gives coding agents repeatable work patterns through host-visible flows.
The normal front door is `/circuit:run`. The host may recommend a flow, or the
CLI can route the goal mechanically. Runtime execution loads a compiled flow,
opens a run folder, advances graph steps, relays work to configured connectors,
evaluates checks, writes reports and evidence, and records an append-only trace.

In Smithers vocabulary, Circuit is closer to a curated workflow pack plus an
opinionated host integration than to a general workflow runtime:

- flows are cataloged packages, not arbitrary TSX files,
- schematics and blocks are compiled into generated surfaces,
- the engine derives registries from the flow catalog,
- runtime behavior is contract-tested through trace, run, selection, connector,
  skill, and report schemas,
- model, effort, skill, depth, and invocation options resolve per relay step,
  not as one global run choice,
- connector routing is config-driven and recorded in `relay.started`,
- skills are loaded into relay prompts through explicit selection channels, with
  `skills.loaded` evidence when they resolve.

Circuit is more constrained. That is not a weakness by itself. It is the reason
Circuit can be understandable inside Claude Code or Codex as a product, rather
than a framework the operator has to program.

## Commonalities

### 1. Both reject one giant agent

Smithers says the best results come from task-specific and project-specific
workflows, with sequencing, fan-out, branching, loops, approvals, evals, and
review loops.

Circuit's README makes the same product argument in different words: stop
remembering process by hand; let a repeatable flow choose stages, relay work,
apply skills, and check evidence.

This is the core overlap. Both tools are a bet that agent quality improves when
the process is structured.

### 2. Both separate orchestration from worker execution

Smithers can run CLI agents such as Claude Code and Codex, SDK agents through
the AI SDK, and mixed workflows where different tasks use different agents.

Circuit has built-in relay connectors for `claude-code`, `codex`, and
`cursor-agent`, plus custom connector descriptors. It resolves connector choice
from role, flow, default, and host-based auto rules.

The difference is posture. Smithers presents agent/harness portability as a
central framework capability. Circuit presents connector routing as a way to
make a flow run correctly inside a host-centered product.

### 3. Both care about durable records

Smithers persists task outputs, node state, attempts, frame snapshots, events,
approvals, and signal state. Events can be read from NDJSON logs and routed into
metrics and OpenTelemetry.

Circuit writes run folders with a manifest snapshot, trace, reports, evidence,
checkpoint state, and projections. Its run contract enforces bootstrap, sequence,
run id, closure, and projection invariants. Its trace schema includes relay,
skill, check, proof, safe-apply, checkpoint, sub-run, fanout, and run closure
entries.

Both tools understand that the agent's answer is not enough. The system needs a
record that can be audited after the run.

### 4. Both make review and validation explicit

Smithers validates outputs with Zod, retries schema failures, ships eval suites,
supports scorer results, and includes review workflows and multi-agent review
examples.

Circuit validates typed reports, records deterministic checks, supports relay
acceptance criteria, records proof assessments, and treats safety review passes
as part of the Goal completion contract.

Smithers leans toward repeatable workflow regression. Circuit leans toward
evidence and contract integrity inside a flow.

### 5. Both are agent-operated

Smithers says the coding agent drives Smithers on the operator's behalf. It can
install a Smithers skill and register an MCP server into several coding agents.

Circuit is also host-operated. Claude Code and Codex expose `/circuit:run`, and
the host command may recommend the flow before invoking the CLI.

Smithers is more aggressive about spreading across many agents. Circuit is more
focused on the plugin host and worker split.

## Differences

### 1. Runtime shape: reactive workflow runtime vs compiled process engine

Smithers repeatedly renders a workflow tree. The workflow body reads persisted
state through `ctx`; the rendered tree changes as outputs appear. This gives a
React-like model: the plan is a derived value from state, and re-rendering
computes what can run next.

Circuit loads a compiled flow graph and advances through authored steps and
routes. It has fanout, sub-runs, checkpoints, relay steps, verification steps,
and report composition, but the normal product path is not "write a reactive
program that renders the next graph." Flow-specific behavior belongs in flow
packages and generated surfaces, not in engine branches.

Takeaway: Smithers is more expressive. Circuit is more bounded.

### 2. Authoring model: TypeScript/JSX vs flow catalog and generated surfaces

Smithers makes workflow code a first-class user artifact. The built-in workflows
are normal TSX files that can be run, edited, forked, or generated by an agent.

Circuit treats flow authoring as a product/compiler path. The catalog is the
single source of truth. The emit script regenerates command, skill, schematic,
block catalog, compiled-flow, and plugin outputs. The agent guide explicitly
says the engine should not need edits for normal flow additions.

Takeaway: Smithers makes authoring approachable to TypeScript teams. Circuit
makes shipped flow behavior governable.

### 3. Durability: completed-node resume vs checkpoint/run-folder continuity

Smithers makes a strong public durability promise: completed tasks are persisted
and not re-executed on resume. It also exposes rewind, fork, replay, hot reload,
stale-run supervision, and frame-based inspection.

Circuit has a strong run-folder contract and checkpoint resume, but the current
operator docs do not make the same broad public promise that any crashed run can
resume from the first incomplete step without re-running completed work. Circuit
does have handoff continuity and checkpoint resume, but that is not the same
product surface as Smithers' durable runtime.

Takeaway: Circuit should not imply Smithers-grade crash recovery unless it builds
and tests that exact contract. It can still borrow the operator-facing idea of
"why is this run blocked, and what can resume safely?"

### 4. Observability: production telemetry vs local evidence record

Smithers has an explicit observability stack: event categories, NDJSON logs,
Prometheus metrics, OpenTelemetry traces, Grafana/Tempo/Loki examples, HTTP/SSE,
Gateway, and MCP tooling.

Circuit has progress events, trace entries, reports, evidence, release proof
runs, and contracts. Those are strong local audit surfaces, but they are not the
same as a production observability platform.

Takeaway: Circuit should copy the event-category discipline before copying the
whole observability stack.

### 5. Evaluation: workflow eval suites vs release proofs and checks

Smithers has an operator-facing eval command. JSON/JSONL cases run a workflow,
write suite reports, and can fail CI. Smithers also layers prompt optimization on
top of eval suites.

Circuit has verification commands, release proof runs, golden runs, trace
contracts, drift checks, and flow-specific tests. These prove the shipped
system, but there is no similarly simple "eval this flow pack against these
task cases" operator surface in the docs I read.

Takeaway: this is one of Smithers' clearest imports for Circuit.

### 6. Human control: approval nodes vs checkpoints

Smithers has `needsApproval`, `<Approval>`, `<HumanTask>`, Gateway approval
resolution, and CLI approval operations. Approvals are part of workflow
composition.

Circuit has checkpoints that pause at declared decision points and resume with a
choice. It also supports autonomous checkpoint resolution where the flow allows
safe defaults.

Takeaway: Circuit's checkpoint model is simpler and more product-shaped. But
Circuit could improve the inbox/inspection side: list waiting checkpoints,
explain why they are waiting, and show the safest next action.

### 7. Scope: platform runtime vs host plugin product

Smithers is comfortable being a platform. It has docs for Gateway, MCP,
control-plane storage, hosted boundaries, alerting, production hardening, and
remote sandbox providers.

Circuit is more local and host-bound. That is a real product choice. The
operator starts from a coding host and a goal, not from a platform API.

Takeaway: broad platform surface is a later decision, not a default next step.

## What Circuit should take from Smithers

### 1. A better run inspection surface

Smithers has a clear mental model around `ps`, `events`, `inspect`, `tree`,
`node`, `why`, `scores`, approvals, and run watching. Circuit already has rich
trace and report data, but the operator-facing inspection surface is thinner.

Circuit should add or sharpen a small set of run-inspection commands before it
adds more automatic behavior:

- `runs list`: what is active, waiting, failed, or complete.
- `runs why <run>`: why the run is blocked, failed, or waiting.
- `runs events <run>`: filtered trace by kind, step, and attempt.
- `runs checkpoint <run>`: pending checkpoint options and the safest resume
  command.
- `runs evidence <run>`: reports, evidence, checks, and proof refs in one view.

This fits Circuit better than a full Gateway. It turns existing run-folder
truth into operator power.

### 2. Eval suites for flows

Smithers' eval surface is a strong idea because it lets a workflow carry
repeatable cases, expected status, and JSON reports that CI can check.

Circuit already has release proof runs and tests, so the raw material exists.
The missing product move is a simple flow-eval contract:

- case id,
- flow or router mode,
- goal,
- optional config fixture,
- expected outcome,
- expected trace/report/check predicates,
- generated eval report.

This would help Circuit answer: "Did Build still behave well on these common
work requests?" and "Did Review still catch the important class of issue?" It
would also give future prompt or skill changes a real score surface.

Do this before copying Smithers-style prompt optimization. Optimization without
trusted eval cases rewards the wrong thing quickly.

### 3. Lifecycle event categories

Smithers' event categories are easy to understand: run, frame, node, approval,
tool-call, agent, output, revert, workflow, scorer, token, timer, memory,
sandbox, snapshot, supervisor.

Circuit's trace kinds are already structured, but the product docs mostly group
them by serialized names. Circuit should add a small human category layer over
trace kinds:

- run lifecycle,
- step progress,
- relay work,
- checks and verification,
- skills,
- checkpoints,
- evidence and reports,
- proof and review,
- recovery and safe apply,
- child runs and fanout.

This helps the operator read the run. It also helps future metrics or external
export without needing to copy Smithers' whole OTEL stack now.

### 4. Starters and examples as a product surface

Smithers has a strong "start here" story: `init` installs workflows, `starters`
browse plain-English starting points, examples show real patterns, and workflows
are editable.

Circuit has a flow guide and good docs, but it could make the starting catalog
more concrete:

- "I need to fix a bug" -> Fix.
- "I need a decision" -> Explore.
- "I need current diff review" -> Review.
- "I need a scoped feature" -> Build.
- "I need a disposable UI sketch" -> Prototype.
- "I need coordinated cleanup" -> Pursue.

That catalog should be executable from the host, not just documentation. The
point is not to copy `.smithers/workflows/`. The point is to make Circuit's
opinionated flow set feel as tangible as Smithers' workflow pack.

### 5. Agent support fanout

Smithers can install skills and MCP config across many coding agents. Circuit
already ships Claude and Codex plugin packages and has clear host/worker terms.
The Smithers lesson is packaging discipline: make agent setup boring,
detectable, and inspectable.

Circuit should consider a doctor/report surface that answers:

- Which host plugins are installed?
- Which worker connectors are available?
- Which local skills are discoverable?
- Which flow surfaces are generated and current?
- Which configured connector/model/effort pairings will fail before spawn?

This is more valuable than adding another host too early.

### 6. A cautious durability upgrade

Smithers' "completed task is never re-executed" contract is a product-grade
promise. Circuit should only copy it if it can prove it through trace, manifest,
step attempt, report, and connector idempotency rules.

A narrower first move would be better:

- explain what can resume today,
- make checkpoint resume easier,
- detect stale or invalid run folders clearly,
- report whether a run can be safely resumed or must restart,
- later consider step-level crash recovery where evidence supports it.

## What Circuit should not copy

### 1. Do not make TSX the default Circuit authoring model

Smithers' React model is powerful, especially for TypeScript teams. But it
would change Circuit's center of gravity. Circuit's vocabulary, generated
surfaces, host packages, and flow catalog are built around flows, schematics,
blocks, stages, steps, routes, traces, reports, and evidence.

Circuit can learn from Smithers' composability without adopting JSX as the
operator-facing default. If Circuit wants more dynamic authoring, it should
first explore whether schematics, custom flows, or host-native workflow
generation can cover the need.

### 2. Do not chase Gateway/control-plane surface yet

Smithers' Gateway, MCP server, production hardening, alerting, and control plane
make sense for a durable workflow platform. Circuit does not need to become a
hosted orchestration service to improve its current product.

For Circuit, the useful first slice is local run legibility and proof, not
multi-tenant org/project/billing/usage/audit primitives.

### 3. Do not copy prompt optimization before eval maturity

Smithers' optimization depends on eval suites. Circuit should not add an
optimizer until the evaluation target is boring and trusted. Otherwise it will
optimize prompts, skills, or flow text against weak signals.

Circuit's better path is:

1. flow eval cases,
2. stable reports and trace predicates,
3. measured regressions,
4. only then optimization.

### 4. Do not turn every flow into user-editable code

Smithers treats editable workflow files as a feature. Circuit should be careful.
The value of Circuit's built-ins is that they are named, reviewed, generated,
and tested product surfaces. If every operator starts editing flow logic, Circuit
inherits framework support costs while losing the clarity of a curated process.

Custom flows are still useful. They should remain explicit and checked, not the
default path for every operator.

### 5. Do not broaden connector ambition faster than worker safety

Smithers' "any agent, any model" posture is compelling. Circuit already supports
multiple built-in connectors and custom connectors, but its connector contract is
careful about boundaries, provider/effort support, and custom connector trust.

Circuit should keep that caution. More connectors are useful only when their
filesystem behavior, model/effort support, result parsing, and trace evidence
are crisp.

## Skill Moments implication

Naming note: current repo files still use the `skill_hooks` / "Skill Hooks"
name for the scaffolded policy and alternatives doc. This section uses Skill
Moments for the product idea under discussion and Skill Hooks when referring to
current repo surfaces.

Smithers makes one lesson very plain: durable systems win by recording lifecycle
facts before they automate more behavior. Its event model, persisted outputs,
approval rows, eval reports, and observability surfaces make runtime behavior
inspectable.

That supports the current Skill Moments recommendation: ship the report-only
first slice before any actuator. If Circuit detects a moment such as
`after:verification-failed`, it should record a `run.skill-moment` event with:

- the moment name,
- the real source signal, such as `check.evaluated:fail`,
- the policy decision,
- planned skills,
- missing or unavailable skills,
- no claim that a skill "ran" unless there is host-observed evidence.

Do not ship all 14 moments just because the vocabulary exists. Smithers works
because its workflow/event/runtime surfaces have producers. Circuit should avoid
a vocabulary whose half the names cannot fire from real signals. The current
Skill Hooks alternatives doc makes that same warning for the scaffolded
vocabulary.

If Circuit later actuates, Smithers points toward two possible directions:

- **Doer injection:** closer to Smithers' task prompt model and faster to
  demonstrate, but it improves production rather than judging.
- **Judge-frame verification:** closer to Circuit's durable value if Circuit is
  mainly the judge, but it needs stronger per-step evidence to be satisfying.

The first slice should stay report-only either way.

## Concrete next moves for Circuit

### Near-term

1. Add a source-backed design note for `runs why` and `runs events`, using the
   current trace and run-folder contract.
2. Define a flow eval case format that can target existing flows and trace/report
   predicates.
3. Add a human category layer over trace kinds in docs and, if useful, in a small
   projection helper.
4. Build the Skill Moments report-only slice only for moments with real signal
   producers.

### Medium-term

1. Turn release proof runs into a reusable flow-eval suite instead of leaving
   them only as release evidence.
2. Add a connector/host/skill doctor that reports installed host surfaces,
   available workers, local skills, and invalid model/effort routes.
3. Improve checkpoint inbox and resume ergonomics before promising broad crash
   recovery.

### Later, only if evidence asks for it

1. Consider remote or hosted run control after local run inspection is strong.
2. Consider prompt or skill optimization after eval suites are trusted.
3. Consider more dynamic flow authoring only after custom flow demand is real and
   current schematics cannot cover it.

## Claim inventory

| Claim | Confidence | Evidence |
| --- | --- | --- |
| Smithers is a durable runtime for long-running AI coding agents with composable workflows, crash recovery, retries, approvals, replay, and observability. | High | Smithers home page and GitHub README. |
| Smithers' execution model repeatedly renders a workflow tree, extracts tasks, schedules ready work, executes tasks, persists outputs/state, and re-renders. | High | Smithers "How It Works". |
| Smithers validates task outputs with Zod and persists outputs to SQLite. | High | Smithers home page, "How It Works", and GitHub README. |
| Smithers ships a default workflow pack through `init`, including planning, implementation, review, debugging, tickets, audits, and long-horizon missions. | High | Smithers Default Workflows and GitHub README. |
| Smithers supports CLI agents and SDK agents, including Claude Code and Codex. | High | Smithers Integrations / CLI Agents docs and GitHub README. |
| Smithers exposes lifecycle events, NDJSON logs, event categories, and metrics mappings. | High | Smithers Events docs. |
| Smithers has eval suites from JSON/JSONL cases and a prompt optimization command layered on evals. | High | Smithers Eval Suites Quickstart, Workflow Optimization, and GitHub README. |
| Smithers includes Gateway, MCP, and production/control-plane docs. | High | Smithers Gateway, MCP Server, Control Plane, and Production Hardening docs. |
| Circuit's normal product front door is `/circuit:run`, with host recommendation or CLI routing. | High | Circuit README, Operator Guide, and Run Process Spec. |
| Circuit resolves model, effort, skills, depth, connector, and invocation options per relay step rather than once globally at run start. | High | Run Process Spec and Selection Contract. |
| Circuit's flow catalog is the source of truth for engine-derived registries and generated surfaces. | High | `src/flows/catalog.ts`, docs/repository-map.md, and docs/generated-surfaces.md. |
| Circuit records runs as a manifest snapshot, append-only trace, reports, evidence, and derived snapshot/run-folder state. | High | Run Contract, Runtime Architecture, and TraceEntry schema. |
| Circuit's current public docs do not promise Smithers-style crash recovery where a killed run resumes from the first incomplete task and never re-executes completed tasks. | Medium | Operator Guide and Runtime Architecture describe checkpoint resume and run-folder validity, not the stronger completed-node durability contract. |
| Skill hook/moment policy is currently deterministic policy only and does not dispatch skills by itself. | High | Configuration "Skill Hook Policy" and Skill Hooks alternatives doc. |
| The Smithers `llms.txt` index advertised fragment URLs, but direct `curl` access to those fragment paths returned 404 during this research. | Medium | Local `curl -fsSL https://smithers.sh/llms-core.txt` and related fragment attempts on 2026-06-03. |

## Source notes

Smithers sources, accessed 2026-06-03:

- [Smithers home page](https://smithers.sh/)
- [Smithers Introduction](https://smithers.sh/introduction)
- [Smithers How It Works](https://smithers.sh/how-it-works)
- [Smithers Default Workflows](https://smithers.sh/workflows/overview)
- [Smithers Events](https://smithers.sh/runtime/events)
- [Smithers Eval Suites Quickstart](https://smithers.sh/guides/evals-quickstart)
- [Smithers Workflow Optimization](https://smithers.sh/guides/workflow-optimization)
- [Smithers Integrations](https://smithers.sh/integrations/integrations)
- [Smithers CLI Agents](https://smithers.sh/integrations/cli-agents)
- [Smithers Gateway](https://smithers.sh/integrations/gateway)
- [Smithers MCP Server](https://smithers.sh/integrations/mcp-server)
- [Smithers Alerting](https://smithers.sh/guides/alerting)
- [Smithers Control Plane](https://smithers.sh/deployment/control-plane)
- [Smithers Production Hardening](https://smithers.sh/deployment/production-hardening)
- [smithersai/smithers GitHub README](https://github.com/smithersai/smithers)

Circuit sources:

- [README.md](../../README.md)
- [UBIQUITOUS_LANGUAGE.md](../../UBIQUITOUS_LANGUAGE.md)
- [docs/operator-guide.md](../operator-guide.md)
- [docs/configuration.md](../configuration.md)
- [docs/architecture/run-process.md](../architecture/run-process.md)
- [docs/architecture/runtime.md](../architecture/runtime.md)
- [docs/contracts/run.md](../contracts/run.md)
- [docs/contracts/selection.md](../contracts/selection.md)
- [docs/contracts/connector.md](../contracts/connector.md)
- [docs/ideas/skill-hooks-alternatives-v1.md](skill-hooks-alternatives-v1.md)
- [src/flows/catalog.ts](../../src/flows/catalog.ts)
- [src/schemas/trace-entry.ts](../../src/schemas/trace-entry.ts)
- [src/shared/selection-resolver.ts](../../src/shared/selection-resolver.ts)

## Gaps and limits

- I did not run Smithers locally. Smithers claims here are documentation and
  public-repo claims, not hands-on behavior verification.
- I did not inspect the full Smithers source tree beyond the public README and
  docs. The comparison is product/API-level, not a code audit.
- I did not claim Smithers' hosted or production surfaces are production-proven.
  I only claim they are documented product surfaces.
