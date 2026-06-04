# Claude Code Workflows And Circuit Comparison V1

Status: research note, not current behavior.

Date: 2026-05-28

## Purpose

Claude Code now has built-in dynamic workflows. This note compares that feature
with Circuit's Run-centered flow model and recommends what Circuit should adapt.

Vocabulary note: this document uses **workflow** for Claude Code's feature and
**flow** for Circuit's product model. Circuit product prose should still prefer
`flow`.

## Sources

Official Claude Code source:

- [Claude Code dynamic workflows documentation](https://code.claude.com/docs/en/workflows),
  fetched on 2026-05-28.

Current Circuit source evidence:

- [README.md](../../README.md): product promise, Run front door, host support,
  safety notes, and configuration.
- [src/commands/run.md](../../src/commands/run.md): host Run command behavior,
  routing, JSONL progress handling, and routed flow policy.
- [src/commands/handoff.md](../../src/commands/handoff.md): Handoff continuity
  utility.
- [docs/generated-surfaces.md](../generated-surfaces.md): source-owned host
  surface generation.
- [docs/contracts/run.md](../contracts/run.md): Run trace, projection, and
  guidance-decision contracts.
- [docs/contracts/continuity.md](../contracts/continuity.md): continuity record
  and run-backed handoff contracts.
- [docs/specs/run-centered-migration-plan-v1.md](run-centered-migration-plan-v1.md):
  Run-centered target state, Run/Handoff relationship, and skill moments.
- [docs/specs/run-centered-v1-migration-ledger.md](run-centered-v1-migration-ledger.md):
  implemented migration state and residual risks.
- [docs/specs/circuit-history-run-start-recall-v1.md](circuit-history-run-start-recall-v1.md):
  hint-only run-start history recall.
- [docs/specs/skill-hook-vocabulary-v1.md](skill-hook-vocabulary-v1.md):
  moment vocabulary and policy rules.

Local observed Claude workflow example:

- `.claude/workflows/circuit-pr-review.js`: saved workflow script observed in
  this checkout. This file is local and untracked at the time of this note.
- `.circuit/reviews/pkp-run-centered-v1-readiness.md`: report produced by that
  workflow for the current PR.

## Short Take

Claude Code workflows are a host-native way to run many subagents from an
executable JavaScript orchestration script. They are strong when the work needs
parallel agent scale, background execution, reusable custom orchestration, or
several independent passes that review each other.

Circuit is a product layer for repeatable coding-agent practice across Claude
Code, Codex, and the local CLI. It is stronger when the work needs a stable
process library, source-owned generated host surfaces, run folders, trace and
report contracts, checkpoints, Handoff, hint-only history recall, and
host-portable behavior.

These are complementary. Circuit should not copy Claude Code by becoming a
Claude-only JavaScript workflow engine. Circuit should adapt the useful
operator and agent affordances: saved reusable process artifacts, visible
background progress, explicit launch approval for expensive runs, focused proof
selection, adversarial cross-checking, and project/personal reuse scopes.

## How Claude Code Workflows Work

From the official docs:

- Dynamic workflows are in research preview. They require Claude Code v2.1.154
  or later. The docs say they are available on paid plans, Anthropic API access,
  Amazon Bedrock, Google Cloud Vertex AI, and Microsoft Foundry. Pro users turn
  them on from `/config`.
- A workflow is a JavaScript script that orchestrates subagents. Claude can write
  the script from the user's task, then a runtime executes it in the background
  while the main session stays responsive.
- Claude recommends using a workflow when a task needs more agents than one
  conversation can coordinate, or when the orchestration should be readable and
  rerunnable.
- The plan lives in code. With plain subagents or skills, Claude decides turn by
  turn. With a workflow, the script owns loops, branching, and intermediate
  results.
- Intermediate results live in script variables instead of filling Claude's
  conversation context. The final answer returns to the session.
- `/deep-research` is the bundled workflow. It fans out searches, fetches and
  cross-checks sources, votes on claims, and returns a cited report.
- A user can trigger a generated workflow by using the word `workflow` in the
  prompt, or by setting `/effort ultracode`, which lets Claude plan workflows for
  substantive tasks.
- `/workflows` lists running and completed workflows. The progress view shows
  phases, agent counts, token totals, elapsed time, agent prompts, recent tool
  calls, and results.
- The progress view supports pause/resume, stop, restart selected agent, and
  save.
- Saved workflows become slash commands. Project workflows live in
  `.claude/workflows/`; personal workflows live in `~/.claude/workflows/`.
  Project workflows win when names collide.
- Launch approval shows the planned phases and lets the operator run, cancel,
  view the raw script, or save future consent for that workflow in that project.
  In the Desktop app, the approval card includes the workflow name, phase list,
  token-usage caution, and Once/Always/Deny actions.
- Workflow scripts have no direct filesystem or shell access. Agents do the
  reading, writing, and command execution.
- Workflows do not support mid-run user input. Only agent permission prompts can
  pause a run. The docs recommend separate workflows for sign-off between
  stages.
- Subagents spawned by a workflow run in `acceptEdits` mode and inherit the
  user's tool allowlist. File edits are auto-approved. Shell commands, web
  fetches, and MCP tools outside the allowlist can still prompt.
- A workflow run can resume after a pause in the same Claude Code session.
  Completed agent results are cached. If Claude Code exits while a workflow is
  running, the next session starts fresh.
- The runtime allows up to 16 concurrent agents, with fewer on machines with
  limited CPU cores, and 1,000 agents total per run.
- Workflows can use many tokens. Runs count against usage and rate limits. The
  docs recommend checking the model and asking Claude to use smaller models for
  stages that do not need the strongest one.
- Dynamic workflows can be disabled in `/config`, in settings JSON, with an env
  var, or through managed organization settings.

## What The Local Claude Workflow Example Adds

The saved `circuit-pr-review` workflow is more than a prompt. It is an
executable review program.

Observed script shape:

- It declares `meta` with a name, description, when-to-use text, and five
  phases: Scope, Review, Verify, Prove, Report.
- It parses arguments for current-branch review, PR review, base branch, and a
  `skipProve` option.
- It embeds Circuit-specific knowledge: authored sources, generated files that
  should not be hand-edited, regeneration rules, schema discipline, runtime hook
  rules, release ledgers, and prose rules.
- It defines structured schemas for scope, findings, verification verdicts,
  proof results, and final report output.
- It scopes the diff, classifies touched surfaces, and gates review dimensions
  based on those surfaces.
- It runs review dimensions through agents, then sends medium-or-higher findings
  to adversarial verifier agents that try to refute them.
- It runs focused proof commands mapped to the touched surfaces, not the full
  suite.
- It writes a final severity-ranked report with proof results, remaining gates,
  and explicit not-reviewed boundaries.

Observed report shape:

- The report header records the branch, base commit, workflow run id, and
  verdict.
- The report groups findings by severity and distinguishes verified findings
  from unverified lower-severity observations.
- The proof table lists focused commands, pass/skip status, and key output
  lines.
- The remaining gate ends with the canonical `npm run verify`.

The important insight: Claude's workflow feature can capture a successful local
process as code. It can then rerun that process with the same structure. Circuit
currently captures repeatable product flows, but it does not yet make it easy
for an operator to promote a successful one-off Run shape into a reusable
project or personal process artifact.

## How Circuit Works Today

Current Circuit evidence points to a different layer:

- Circuit helps agents follow a clear process, apply the right skills at the
  right time, and check work against evidence. The README frames this as a
  better working environment than ad-hoc chat.
- `/circuit:run` is the normal front door in Claude Code and Codex. The host may
  recommend a flow, and Circuit records the selected flow when the run starts.
  The CLI has a deterministic router fallback.
- The host plugin package model currently exposes `/circuit:<command>`. Circuit
  does not ship a root `/circuit` alias until hosts support that shape.
- Handoff remains visible as a continuity utility. Create is CLI-only and not a
  published host command.
- Circuit reads config from personal and project config files. Config can set
  models, effort, local skills, connector routing, and per-flow overrides.
- Generated host surfaces are source-owned and drift-checked. The repo keeps a
  generated-surface map and drift checks for stale commands, skill dirs, and
  plugin mirrors.
- The Run contract treats a Run as an execution aggregate: manifest snapshot,
  append-only trace, and derived projection. Guidance decisions bind recorded
  actions for flow selection, relay execution, checkpoints, proof policy,
  recovery, and safe apply.
- Continuity records support run-backed Handoff. A handoff can preserve the
  goal, next action, current snapshot, and run folder anchor across sessions.
- The Run-centered migration target makes Run the product entry, flows the
  process library, runtime the execution engine, run folders the durable artifact
  layer, and human output shorter while keeping agent-facing artifacts rich.
- Memory and history are intentionally hint-only. Run-start recall may provide
  relevant prior Circuit work, but it cannot route, prove completion, decide
  checkpoints, set policy, or write memory silently.
- Skill moments are the current schema and policy foundation for predictable
  skill staging. The implemented slice covers config, step metadata, pure policy
  resolution, and events. It does not yet prove host skill dispatch as a product
  claim. The design rejects flow-step skill slot matrices and fuzzy skill
  inference as the default product model.

## Comparison

| Area | Claude Code workflows | Circuit Run-centered flows |
| --- | --- | --- |
| Orchestration model | Imperative JavaScript script generated or saved inside Claude Code. The script owns loops, branching, fanout, and intermediate state. | Source-owned flow packages and a runtime graph. Run chooses a flow, stages context, consumes projections, and checks closure. |
| Repeatability | Strong for one-off custom orchestration. A successful workflow can be saved as a command in project or home scope. | Strong for governed product flows. Repeatability comes from authored flow packages, generated host surfaces, contracts, and run folders. |
| Resumability | Pause/resume works within the same Claude Code session. Completed agent results are cached. Exiting Claude Code starts fresh. | Run folders, checkpoints, trace projections, and Handoff provide durable artifacts and cross-session continuity. Circuit should not claim Claude-style live agent caching unless it implements it. |
| Agent scale | Built for dozens to hundreds of subagents. Hard limits are 16 concurrent agents and 1,000 total agents per run. | Supports sequence and parallel flow steps, but is not primarily a high-scale subagent runtime. It is a process and evidence layer over host/connector execution. |
| Human approval | Native launch approval shows phases, raw script preview, token caution, and Once/Always/Deny choices. Mid-run user input is not supported except permissions. | Circuit has checkpoints, operator summaries, safety disclosures, and host permissions. It does not yet have a native pre-run approval card for expensive or high-impact Runs. |
| Evidence and proof | A workflow can encode cross-checking, verifier agents, and focused proof commands. Evidence quality depends on the generated or saved script. | Evidence is part of the product contract: traces, reports, projections, proof policy, acceptance criteria, release ledgers, and validation tests. |
| Saved artifacts | Saved script commands live in `.claude/workflows/` or `~/.claude/workflows/`. Reports land where the script chooses. | Run folders, reports, traces, generated surfaces, release proof runs, continuity records, and specs are first-class artifacts. Custom process authoring is less immediate. |
| Cost and control | Token totals and elapsed time are visible in the workflow progress view. The docs warn that workflows can use meaningfully more tokens. | Circuit has model, effort, connector, and per-flow config. It has less native per-step token telemetry in the operator surface. |
| Host portability | Claude Code only, though across Claude Code CLI, Desktop, IDE extensions, non-interactive mode, and Agent SDK. | Designed for Claude Code, Codex, and local CLI, with connector routing for worker execution. |
| Handoff and continuity | Resumes within the current session. Saved scripts make reruns repeatable, but do not by themselves carry in-progress work across sessions. | Handoff is a visible continuity utility, and run-backed continuity is part of the Run-centered target. |
| Skills and moments | Workflows sit beside skills. The workflow script can decide which agents to spawn, but the docs do not define a deterministic skill-moment policy. | Skill moments are a Circuit schema and policy layer for predictable, explainable skill staging without per-flow slot matrices. Host skill dispatch should not be claimed until proven. |
| Memory and history | The docs describe script variables and saved scripts, not a general project memory or history recall system. | Circuit has a hint-only history recall plan and memory authority rules. History can inform a Run but cannot silently decide it. |

## Pros And Cons

Claude Code workflow strengths:

- Excellent high-scale fanout primitive.
- Strong native progress UI for background work.
- Script is inspectable before launch.
- Successful custom orchestration can become a reusable slash command.
- Project and personal save scopes are simple and useful.
- Built-in pause, resume, stop, restart, and save controls.
- Native token and elapsed-time visibility.
- Good fit for audit, research, migration, and cross-check tasks.

Claude Code workflow risks:

- Claude-only. It does not help Codex except through a host-specific adapter.
- Generated JavaScript scripts can accrete hidden product logic if treated as
  source of truth.
- No mid-run user input means it is awkward for decision-heavy work unless split
  into separate workflows.
- Same-session resume is weaker than durable cross-session continuity.
- Many-agent runs can consume a lot of tokens.
- File edits by workflow subagents are auto-approved under the docs' permission
  model, which may be too permissive for some Circuit use cases.
- Quality depends heavily on the saved script. A bad workflow can make mistakes
  repeatable.

Circuit strengths:

- Cross-host product layer, not just one host's runtime feature.
- Stable product vocabulary and a simpler default surface: Run.
- Durable run folders, reports, trace projections, checkpoints, and Handoff.
- Source-owned generated host surfaces with drift checks.
- Evidence and closure are core contracts, not only conventions inside a custom
  script.
- Hint-only memory rules keep history useful without making behavior opaque.
- Skill moments give Circuit a path to predictable skill prep that is not a
  user-managed slot matrix.

Circuit gaps exposed by workflows:

- Circuit does not yet have an easy "save this successful orchestration as a
  reusable project or personal command" path.
- Circuit's progress surface is less rich than Claude's workflow view.
- Circuit's high-scale fanout story is narrower.
- Circuit does not currently show an approval card with planned steps and token
  caution before expensive Runs.
- Circuit has less visible per-step token and elapsed-time accounting.
- Circuit's custom-flow authoring story is less immediate than saving a Claude
  workflow script after a good run.
- Circuit's Review flow can learn from the local workflow's adversarial
  verification and focused-proof mapping.

## What Circuit Should Adapt Soon

1. **Reusable Run captures.**

   Add a way to promote a successful Run into a draft reusable process artifact.
   It should not be arbitrary JavaScript as the default. A safer V1 would save a
   source-owned Circuit draft: goal pattern, selected flow, policy choices,
   proof mapping, skill moments, and output expectations. Project scope and
   personal scope should mirror Claude's `.claude/workflows/` and
   `~/.claude/workflows/` split.

2. **Pre-run approval for expensive or high-impact Runs.**

   Before deep, high-fanout, write-capable, or high-impact work, show a compact
   decision packet: selected flow, planned steps, write capability, likely proof
   commands, expected cost level, and options like run once, trust this project
   policy, or cancel. This aligns with Circuit checkpoints and avoids making the
   operator inspect rich proof by default.

3. **Richer background progress.**

   Add a Run progress view or generated local report that shows current step,
   child run count, elapsed time, token usage when available, recent tool calls
   or proof commands, and artifact links. Keep the final human message short.

4. **Focused proof mapping as metadata.**

   The local `circuit-pr-review` workflow's proof mapping is very useful. Circuit
   should let flows declare touched-surface-to-proof mappings so Review, Run,
   and release checks can choose focused proof commands before the full
   `npm run verify`.

5. **Adversarial verification inside Review.**

   The workflow's "try to refute each medium-or-higher finding" pattern should
   become a first-class Review mode or Review closure rule. It directly supports
   Circuit's evidence and confidence goals.

6. **Project and personal reuse scopes.**

   Circuit already has personal and project config layers. Reusable Run captures,
   skill-moment policies, proof mappings, and saved review profiles should use
   those layers rather than inventing new locations.

7. **Cost telemetry in Run records.**

   Where hosts or connectors expose token totals, elapsed time, model, and agent
   counts, record them in the Run artifact layer and surface a short summary.

## What Circuit Should Explore Later

1. **Claude workflow interop.**

   Circuit could optionally call a saved Claude Code workflow as a connector or
   host-specific process attempt when running inside Claude Code. This should be
   an adapter, not Circuit's core orchestration model.

2. **Dynamic fanout for heavy tasks.**

   Explore a declarative Circuit fanout layer for audits, migrations, and
   research. The useful part to copy is not JavaScript. It is bounded parallel
   workers, cached intermediate results, cross-checking, and progress controls.

3. **Agent result caching.**

   Claude's same-session cached agent results are useful. Circuit should explore
   durable child-result caching only if it can preserve evidence integrity and
   avoid stale results being treated as fresh proof.

4. **Process artifact authoring.**

   Future authoring could begin from run history: "this Run worked well, draft a
   reusable flow or profile." That is more natural than asking users to author a
   full flow from scratch.

5. **Workflow-to-flow importer.**

   If users save useful Claude workflows, Circuit could inspect them and suggest
   a portable Circuit flow/profile. This should be read-only and advisory at
   first.

## What Circuit Should Not Copy

1. **Do not make the Run envelope an arbitrary JavaScript workflow engine.**

   That would weaken the current source-owned flow model and invite the same
   scope creep the migration plan is trying to avoid.

2. **Do not make Claude Code the product center.**

   Circuit's advantage is that it can prepare work across Claude Code, Codex, and
   the CLI. Claude workflow interop should be optional.

3. **Do not adopt the term `workflow` for Circuit product prose.**

   Claude now owns that word in this context. Circuit should keep `flow` and
   `Run`.

4. **Do not remove human decision points just because workflows lack mid-run
   input.**

   Circuit's checkpoint and decision-packet direction remains important. Some
   work needs human choice between stages.

5. **Do not treat generated scripts as trusted proof.**

   A script can encode a strong process, but the proof is still in the files,
   tests, reports, and evidence it produces.

6. **Do not auto-approve write-heavy subagents by default.**

   Claude's workflow permission model may be acceptable for Claude Code users,
   but Circuit should keep write capability explicit and visible.

## Product Interpretation

Claude Code workflows make the lower layer more powerful. They reduce the need
for Circuit to invent its own high-scale subagent runtime. That is good news.

Circuit should move up a level:

- choose and prepare the right process;
- preserve cross-host portability;
- make evidence and completion contracts durable;
- capture successful practice into reusable, governed artifacts;
- stage skills and history predictably;
- hand off unfinished work between sessions.

The strongest future shape is not "Circuit versus Claude workflows." It is:

```text
Circuit Run decides what kind of work this is.
Circuit flow defines the expected practice and proof.
Host-native workers, including Claude workflows when useful, execute bounded
parts of that practice.
Circuit records what happened and decides whether the Run can honestly close.
```

## Recommended Next Slice

The next concrete design artifact should be **Reusable Run Capture V1**.

It should answer:

- What can be safely captured from a successful Run?
- What must remain evidence, not policy?
- Where do project and personal captures live?
- How does a capture differ from a full authored flow?
- How does a capture interact with skill moments, focused proof mapping, and
  Handoff?
- What is the review gate before a capture becomes reusable?

This slice gives Circuit the most useful part of Claude workflows without
making Circuit a Claude-only script runner.

## Adversarial Review

Potential overclaims checked:

- **"Claude workflows are resumable."** Narrowed to same-session pause/resume,
  because the official docs say exiting Claude Code starts fresh.
- **"Circuit supports high-scale agents."** Narrowed. Circuit can sequence and
  parallelize flow steps, but the repo evidence does not show a Claude-style
  1,000-agent orchestration runtime.
- **"Skill moments are current behavior."** Narrowed. The schema and policy
  slice exists, but host skill dispatch is not claimed.
- **"Claude workflows provide durable continuity."** Not claimed. Saved scripts
  provide repeatability; they do not preserve in-progress cross-session state.
- **"Circuit should save JavaScript workflows."** Rejected for the default path.
  The safer recommendation is a source-owned reusable Run capture.
- **"The local workflow script is repo-backed current behavior."** Marked as
  local and untracked. It informs product design, but it is not a committed
  Circuit capability.

Residual uncertainty:

- The official Claude Code workflow feature is in research preview. Behavior may
  change quickly.
- This note did not run a fresh Claude workflow. It used the official docs plus
  one local saved workflow/report example.
- Circuit's exact implementation of skill moments and Run-centered artifacts
  should be rechecked before turning this note into a concrete implementation
  plan.
