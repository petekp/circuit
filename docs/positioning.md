# Circuit positioning: the load-bearing claims

This is the short list of things that are mechanically true about Circuit
today, and that make it worth more than the tools people already use. It
exists to keep our messaging anchored to what the code actually does, so we
do not drift into speculation.

The rule is simple: if a claim is not on this page, do not put it on the
landing page, in docs, or in a pitch. When the product changes, this page
changes first, and every claim here names where it is real in the code.

For product posture and philosophy, see [CONTEXT.md](../CONTEXT.md). For
vocabulary, see [UBIQUITOUS_LANGUAGE.md](../UBIQUITOUS_LANGUAGE.md). This page
is narrower than both on purpose: it is only the claims we can stand behind.

## The one-sentence version

You already encode how you want the agent to work, in a CLAUDE.md file and a
pile of skill files. Those tell the agent what you want. Circuit makes the
steps actually run in order and checks each one produced real evidence before
the work can move on.

## The two struggles this speaks to

Both are daily, both are felt by everyone who delegates real work to a coding
agent, and neither is solved by a rules file or a skill.

1. **It said done. It was not done.** The agent reports success, or skips a
   step you told it to run, and you find out when you run the code. A
   CLAUDE.md can say "always verify before closing." Nothing in it can stop
   the agent from closing anyway.

2. **Context rot.** The longer a session runs, the more the agent forgets
   your standards, mixes concerns, and drifts. Piling more into CLAUDE.md
   makes this worse, because every instruction competes for the same
   crowded context.

## The two things Circuit does that CLAUDE.md and a pile of skills cannot

These are the only two structural advantages. Everything else Circuit shows
you (named stages, the trace, the run folder) is scaffolding around them. Lead
with these.

### 1. The check is mechanical, not textual

A CLAUDE.md instruction is a request the model may honor or quietly ignore.
A Circuit check is run by the engine, not the model. A step's output is
parsed against a typed schema and a set of deterministic acceptance criteria
before the run is allowed to advance. If the output is malformed or missing
required evidence, the step fails and retries or stops. The run cannot reach
its end without the evidence its final report requires.

Concretely, in the Fix flow: the run will not move from diagnose to act until
the diagnosis report is well formed and accepted, and it cannot close as
"fixed" without the verification and regression-rerun outputs actually
present. The agent claiming it verified is not enough; the output has to
exist and pass.

Where this is real in the code:

- Each step's report is parsed against its typed schema and the step fails on
  a mismatch: `src/runtime/executors/relay.ts`
  (`defaultValidateAcceptedProductionRelay`).
- Deterministic acceptance criteria require fields to be present, or run
  proof commands and check their exit status:
  `src/runtime/acceptance-criteria.ts` (`evaluateAcceptanceCriteria`).
- The close stage is wired to require its upstream reports, and the close
  builder parses each required input and throws if it is missing or malformed:
  `src/flows/registries/close-writers/registry.ts` (`resolveCloseReadPaths`)
  and `src/flows/fix/writers/close.ts`.
- For Build, a git check blocks the run if files outside the agreed touch
  area changed (see "Build Limits" in
  [UBIQUITOUS_LANGUAGE.md](../UBIQUITOUS_LANGUAGE.md)).

Honest nuance, so we do not overclaim. The schema check guarantees the report
is well formed and complete, not that its content is correct. The engine
checks that a verification command ran and passed, not that a hypothesis is
sound. The honesty comes from two things together: required evidence the
engine enforces, and an independent reviewer step that treats upstream
reports as claims to verify. It does not come from the engine reading minds.

### 2. Each step is isolated: its own role, its own tools, its own clean context

In ad-hoc chat, one long context carries everything: the investigation, the
edits, the review, all in the same window, all able to step on each other.
Circuit runs each step as a separate handoff (a relay) with a defined role
(researcher, implementer, reviewer). Each step gets a fresh context that
contains only its declared inputs, the specific upstream reports it reads,
not the full running transcript of every prior step. This is the direct
answer to context rot: later steps are not polluted by the chatter of earlier
ones, and an independent reviewer judges the work without having sat inside
the implementer's reasoning.

Steps can also be scoped to specific tools. The hard version of this, a real
tool wall on a capable connector, is reserved for the implementer step, so an
implementer can be mechanically confined to an editor toolset. The researcher
and reviewer are kept read-only by their role and by the fact that each
receives only typed reports, never a writable working context, so the
reviewer audits the change without having produced it.

Where this is real in the code:

- Each relay step gets a freshly composed prompt built only from its declared
  reads, the goal, and the current slice. The full prior-step transcript is
  never appended: `src/runtime/run/relay-support.ts` (`composeRelayPrompt`).
- Roles are first class and shape the step's instructions; the reviewer is
  told to treat upstream reports as claims to verify:
  `src/schemas/step.ts` (`RelayRole`), `src/runtime/run/relay-support.ts`
  (`ROLE_GLOSS`).
- Per-step tool scope is declared and passed to the connector at relay time:
  `src/schemas/equipment-scope.ts`, `src/shared/equipment-enforcement.ts`
  (`resolveEquipmentEnforcement`), `src/runtime/executors/relay.ts`.

Honest nuance. The context isolation is unconditional: it is how every relay
is composed, so the context-rot defense always holds. The hard tool wall is
narrower than it sounds. An enforced tool scope is only legal on the
implementer step, and it only becomes a real wall on a connector that can
restrict tools (Claude Code can); on a connector that cannot, it downgrades
to guidance and the trace records that honestly, rather than pretending the
tools were locked. The researcher and reviewer are kept off the keyboard by
role and by getting only typed reports, not by a hard tool wall.

## The honest boundary: where Circuit is not worth it

Saying this plainly is what keeps the claims credible and helps the right
people self-select.

- **Authoring cost.** Hand-authoring a flow today (writing a schematic,
  registering it, compiling, rebuilding host bundles) takes real time. A
  CLAUDE.md takes minutes. For a process you run a few times a week and have
  not yet watched the agent botch, the mechanical gate may not pay back the
  authoring effort. Lowering this cost is the most important thing we can
  build, not a thing we can claim.
- **First-time or fast-changing processes.** If you are encoding a process
  for the first time, or it changes every week, a rules file is the right
  starting point. Circuit earns its keep on processes you repeat and where
  skipping a step has a real cost.
- **Capability, not compliance.** If the failure you fear is that the model
  is not smart enough, Circuit does not fix that. It fixes compliance and
  context hygiene. It does not raise raw capability.

## What we do not claim yet

These are real directions, but they are not built, so they do not go in any
pitch until they ship. This matches CONTEXT.md, which keeps the
effectiveness ratchet out of the core promise on purpose.

- **Flows do not get sharper run over run.** There is no compounding or
  self-improvement loop in the engine. Do not say or imply Circuit "learns"
  or "gets better over time."
- **Circuit does not store and replay your past sessions.** It does draw on
  within-project recall hints from prior runs and project facts. These are on
  by default, can be disabled, and are hint-only, so they make a single run
  better informed but never carry authority. They do not make the flow itself
  smarter, and they index prior Circuit runs and project facts, not your chat
  sessions.
- **"Turn your prompts and skills into a flow" is only half-built.** You can
  generate a flow from a plain description, and create one from a template,
  but both are local CLI commands today, not host slash commands, and there
  is no shipped path that ingests an existing session and emits a flow.
  Until that on-ramp ships, do not promise that encoding your existing way of
  working is easy.

## How to use this page

The landing page and all messaging lead with the two struggles and the two
structural advantages, framed as the honest contrast with a CLAUDE.md plus a
pile of skill files. Show the mechanical check actually firing rather than
describing it. Keep the boundary visible. When you are tempted to claim more,
check this page first; if the claim is not here, either it is not true yet or
it needs to be added here with its mechanism before it can be said anywhere
else.
