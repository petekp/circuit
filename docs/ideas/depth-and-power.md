# Depth and Power: The Two-Dial Model for What a Run Spends

Status: BUILT (2026-06-11). The phased plan below shipped: phase 0 vocab
rename (PR #56), phase 1 receipt (PR #57), phase 2 power dial with the
default-on flip (PR #59), phase 3 local worker lane (PR #60), plus an `auto`
dial position the proposal did not anticipate (PR #62: the researcher
recommends the run's tier, the engine clamps it to `power_auto`
floor/ceiling and resolves it once; depth stays manual). Current behavior
lives in `docs/configuration.md` (Power Dial, Auto power, Local Workers) and
`docs/contracts/selection.md` v0.5; this doc is the design rationale and is
NOT updated as the implementation evolves. Original status follows.

Proposal (2026-06-10). This doc supersedes a
same-day "spend profiles" draft after an operator design pass rejected
profiles-first framing in favor of the journey-led design below. Code seams
were verified against source on 2026-06-10; re-verify before building.
Operator decisions already made: default-on smart routing (not report-only
first), "low power mode" as the headline phrase, the Depth and Power
vocabulary including the rigor rename, and `low / medium / high` as the
shared value scale for both dials.

## The question

Model prices are diverging: flat-rate subsidies are ending, frontier models
are moving to usage-based pricing, and capable local models run on operator
hardware. Routing expensive models to judgment and cheap models to execution
is the obvious response, and Circuit's selection stack can already express it.
But it is power-user YAML that nothing surfaces. The question: what is the
stupid-simple product surface for this, and what does it take to build?

## The answer in one line

Make smart routing the **default**, make the **end-of-run receipt** the
discovery moment, expose exactly **two dials with one shared scale** (Depth
and Power, each `low / medium / high`), and let engine-evaluated checks plus
**automatic escalation** make cheap-by-default safe by construction.

## First principles

Three observations drive every choice below.

1. **Users do not want to choose models.** Model names are a burden that rots
   every six months. Any surface that asks for an opinion about models has
   failed. The product speaks in tiers ("small model", "big model"), never
   model ids; ids live one click deep in the run record.
2. **The barrier is fear, not ignorance.** Everyone knows cheap models exist;
   they do not trust them with real work. So the feature cannot ask for trust
   up front (a config choice is exactly that). Trust must be built by
   watching it work, with evidence, on your own runs.
3. **The pain is felt at the receipt, not at the config file.** Nobody opens
   YAML when they get rate-limited. Discovery has to live inside the
   experience users already have: the end of a run.

The consequence: **there is no discovery journey.** Circuit routes sensibly by
default and prints a receipt line saying what it did and what the checks
proved. The receipt is the discovery, the trust builder, and the marketing
screenshot. This is the Nest-leaf / optimized-battery-charging pattern: the
system does the smart thing, then shows a small token that it happened.

## The trust claim

This is a trust feature, not a cost feature. The claim that anchors product
copy:

> Circuit does not need the cheap model to be good. It needs the cheap model
> to be **checked**. The harness is what makes cheap models safe; the cost
> saving is the receipt.

Escalation is the visible proof. When a check fails on a cheap tier, the
engine re-runs that step one power tier up and the receipt says so. Shown
right, a failure is a trust moment: "escalated to full power when a check
failed" is the harness doing its job. The worst case of cheap-by-default is
no longer "the small model wrecked my code" (checks gate that); it is "we
paid for one retry."

## The vocabulary system

Circuit today has three near-synonyms for intensity (Rigor, Depth, Effort),
and `UBIQUITOUS_LANGUAGE.md` needs a usage-notes section to keep them apart.
That section also forbids saying "depth" when you mean rigor, which is
evidence that "depth" is the word people naturally reach for. This feature
collapses the cluster instead of adding a fourth member:

| | Word | Values | Who sees it |
| --- | --- | --- | --- |
| Process dial | **Depth** | `low / medium / high` | Everyone |
| Model dial | **Power** | `low / medium / high` | Everyone |
| Modes | tournament, autonomous | flags | Opt-in |
| Provider knob | Effort | 7 tiers | Internal only |

- **Depth** replaces operator-facing **Rigor**. Values move from
  `lite / standard / deep` to `low / medium / high`.
- **Power** is new: how much model per unit of work.
- Both dials share one scale because `low / medium / high` is the most
  overlearned triple in daily life (stoves, fans). The old triples were
  internally inconsistent ("lite" pairs with "heavy", "full" pairs with
  "empty"), which is why they were hard to remember. Plain enum values are a
  feature; flavor ("low power mode") lives in prose.
- Default is `medium` on both dials. Most users never type either.
- **Effort stays internal.** It maps to a real provider concept (reasoning
  effort) and is a component the power tier sets, alongside the model.
- Teachable physics bonus, honest as approximation: cost scales with
  depth times power (how much work, times spend per unit of work).
- Receipt grammar: `depth high · power low · all checks passed`.

## What the user sees (the whole surface)

1. **A receipt line** at the end of every run, both hosts:
   `⚡ execution ran on the small model · 1 escalation · all checks passed`
   plus `depth medium · power low`. Plain words, no model ids. Full
   per-step provenance stays in the run record.
2. **Two dials, three positions each.** Set conversationally ("run this at
   low power"), per run (`--power low`, next to `--depth`), or persistently
   (`defaults.power: low` in config).
3. **An escape hatch** they never have to find: the existing per-flow,
   per-stage, per-step selection config, documented as under-the-hood. The
   dial compiles into it; explicit layers still win.

What is never shown by default: the 7-layer selection stack, tier-to-model
mapping tables, escalation thresholds, model ids.

## How routing works (one level down)

Flows already divide work into stages with canonical names
(`frame, analyze, plan, act, verify, review, close`,
`src/schemas/stage.ts:5-12`). The dial does not pick models; it picks a
power tier per role:

- Think (frame, analyze, plan): big model at every power level. Judgment is
  where intelligence compounds and it is a small fraction of tokens.
- Do (act): the dial's main effect. Power low routes execution to the small
  tier.
- Judge (verify, review): mid tier at low power, big at full.

Each connector owns a translation table from tier words to its provider's
concrete models. That table is shipped config data reviewed at release time,
never engine constants, so model-name churn is a checklist item rather than a
release.

## Cross-host model

Three layers make cross-host nearly free:

- **Host** (Claude Code or Codex): owns the conversation and its model.
  Circuit never touches it, and receipts must stay truthful about that scope.
- **Engine** (same CLI under both hosts): owns the dials, the role-to-tier
  policy, escalation, and the receipt. Built once.
- **Workers (relays)**: spawned through connectors that pass model and effort
  flags to a real CLI (`claude-code` connector to Anthropic models, `codex`
  connector to OpenAI models with effort levels, future local connector to a
  model on the operator's machine).

The default keeps each host in its own model family (the account the user
already has). Cross-provider routing exists in the machinery but is opt-in,
never default, because it requires two subscriptions. A Claude Code setting
could never route Codex workers and vice versa; sitting above both hosts is
the argument that this belongs in Circuit.

## Verified implementation seams

Surveyed 2026-06-10. The genuinely new code is small.

1. **Tier table: the only missing piece.** Resolved model strings pass
   straight through to connectors today (`ConnectorRelayInput` in
   `src/shared/connector-relay.ts`); no tier indirection exists. Add a
   power-tier to provider-model mapping table in config schema
   (`src/schemas/config.ts`), consulted during selection resolution.
2. **Role mapping: tiny.** Declare once which canonical stages are
   think/do/judge. No flow edits; relay roles
   (`researcher | implementer | reviewer`, `src/schemas/step.ts:19`) and
   canonical stages already exist.
3. **Dial wiring: plumbing.** `--power` slots into `addExecutionOptions()`
   (`src/cli/run.ts:121-135`, beside the current rigor flag) and feeds the
   existing invocation layer of the selection stack
   (`src/selection/relay-selection.ts`). Precedence and provenance machinery
   untouched; explicit config still wins over the dial.
4. **Escalation: cheaper than expected.** Selection is already re-resolved
   fresh on every step entry including retries
   (`deriveResolvedSelection` call in `src/runtime/run/relay-guidance.ts`),
   and attempts are already counted (`StepEnteredTraceEntry.attempt`,
   `step.budgets.max_attempts` in `src/runtime/run/graph-runner.ts`). Thread
   the attempt number into the resolver and bump one tier when attempt > 1.
   Check-failure recovery routing already exists.
5. **Receipt: the data is already recorded.** Every relay execution persists
   `resolved_selection` plus provenance in the trace
   (`RelayStartedTraceEntry`, `src/schemas/trace-entry.ts:260-268`). Nothing
   renders it. Aggregate in the operator summary writer
   (`src/app/operator-summary/writer.ts`) and add a receipt field to the
   operator-summary schema.

Plus: selection contract update (`docs/contracts/selection.md`), tests, and
regenerated command surfaces for both hosts.

## Ship plan

- **Phase 0: vocabulary migration.** Rename Rigor to Depth and move values to
  `low / medium / high` (axis name and values; roughly 200 files mention
  rigor, mostly schematics and generated surfaces that regenerate). Update
  `UBIQUITOUS_LANGUAGE.md`, contracts, CLI flag, command sources. Deliberate
  breaking change to flags and config; alpha is the time. Its own commit,
  before any power work, so the feature is born into clean vocabulary.
  Known gotchas: wrap-sensitive contract test on the generated run SKILL,
  biome quote style in CLI help.
- **Phase 1: receipt with no behavior change.** Ship the receipt while
  routing stays exactly as today; it truthfully reports full power
  everywhere. Proves trace-reading and rendering end to end at zero risk,
  and the digest work composes with the output-model proposal.
- **Phase 2: the flip.** Tier table, role mapping, `--power` dial, escalation,
  default `medium`. Release note states the behavior change; the receipt
  makes it visible rather than silent.
- **Phase 3: the local lane.** A local connector (for example OpenCode
  against Ollama) in the existing `custom` connector and provider seats, as a
  worker, not a host. Gated on phase 2: escalation is the safety net for
  local-model flakiness. Same dial, new lane, both hosts at once.

## What Circuit can measure that others assert

Run evidence already records per-step selection and check outcomes. Over
time Circuit can report, per project: "act stages at power low passed checks
at X% vs Y% at medium." Others assert cheap execution works; Circuit can
grade it from its own traces and let operators tune on evidence. Feeds the
self-auditing-memory thesis and the dormant measurement loop.

## Honest constraints

- **Relays only.** Circuit controls worker models, not the host main loop.
  Receipts report what the run's work used, not the whole session.
- **Effort honoring is connector-owned** (documented in the selection
  contract); a tier's "low" means what the connector maps it to.
- **No dollar estimates in receipts.** Pricing is volatile and out of
  product. A relative signal (for example tokens at each tier) may earn a
  place after a careful design pass; precision theater may not.
- **Local agentic reliability is rough today.** Phase 3 stays behind phase 2.
- **Tier tables are release-reviewed data,** never hardcoded, so model
  generation churn does not require engine changes.

## Open questions

- How loud should the cost signal be in the receipt: savings-forward (leaf
  style, persuasive but pressure-y) vs trust-forward (checks passed, lane as
  footnote)?
- Should tournament accept a power spread (same stage across tiers, compare),
  turning measurement from passive to active?
- Escalation policy details: bump threshold (attempt > 1 vs configurable),
  per-stage cap, and never de-escalating within a run (working assumption:
  only escalate).
- Whether `medium` power's allocation (big think, mid do/judge) needs a
  per-flow exception list (for example Fix's reviewer staying big).

## Related

- `docs/ideas/output-model.md` (digest is the visibility surface)
- `docs/ideas/adversarial-verification-gates.md` (verify-then-escalate kin)
- `docs/ideas/opencode-as-host.md` (local-model worker notes; host vs worker)
- `docs/learnings/bounded-autonomy-research.md` (trust positioning)
- `docs/contracts/selection.md`, `docs/contracts/config.md` (the substrate)
- `docs/audits/2026-06-09-strategic-review.md` (receipts wedge)
