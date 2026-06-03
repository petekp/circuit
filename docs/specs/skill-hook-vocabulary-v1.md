# Skill Hook Vocabulary V1

Status: design spec for the initial hook vocabulary, not current behavior.

Date: 2026-05-28

## Purpose

Define the first shipped hook vocabulary that the Run envelope publishes and
that project policy maps to host-native skills. This spec is the immediate
follow-on artifact for
[run-centered-migration-plan-v1.md](run-centered-migration-plan-v1.md)
Phase 3.5. The goal is to make automatic skill preparation deterministic and
explainable without reintroducing flow-step skill binding matrices or fuzzy
description matching across every installed skill.

A hook is a recognizable condition where extra judgment is useful. Skills
become "automatic at the right time" by being mapped from hooks through
policy, not by being bound to a flow or a step.

## Evidence Used

- Product framing and language:
  [../../CONTEXT.md](../../CONTEXT.md),
  [../../UBIQUITOUS_LANGUAGE.md](../../UBIQUITOUS_LANGUAGE.md)
- Skill hooks product model and constraints:
  [run-centered-migration-plan-v1.md](run-centered-migration-plan-v1.md)
- Existing skill, selection, and step contracts:
  [../contracts/step.md](../contracts/step.md),
  [../contracts/compiled-flow.md](../contracts/compiled-flow.md),
  [../../src/schemas/skill.ts](../../src/schemas/skill.ts),
  [../../src/shared/selection-resolver.ts](../../src/shared/selection-resolver.ts)
- Continuity and handoff:
  [../contracts/continuity.md](../contracts/continuity.md),
  [../../src/commands/handoff.md](../../src/commands/handoff.md)

## Vocabulary Principles

1. **Hooks name kinds of work, not flows or steps.** A hook that only
   applies to one flow has chosen the wrong axis.
2. **Detection must derive from observable state.** File paths, diffs, declared
   goal contract fields, evidence maps, selected process, step metadata, or
   explicit operator input. No natural-language judgment about risk,
   importance, or intent.
3. **Matching is explainable.** Every fired hook can be traced to a concrete
   detection cause. Every triggered skill can be traced to a concrete policy
   mapping or skill metadata declaration.
4. **Shipped vocabulary stays small.** Authors and operators can mint custom
   hooks under their own namespace. The shipped set covers common work
   shapes only.
5. **Hooks are publish-only.** Run publishes hooks. Policy and metadata
   resolve them to skills. The publisher does not know which skills will fire,
   and the skill side does not know which flow emitted the hook.

## Policy Modes

Each project policy entry resolves a hook to one of three modes:

| Mode | Behavior |
| --- | --- |
| `auto` | Prepare or request the mapped skill without operator interaction. |
| `ask` | Surface a Run decision packet that asks the operator before preparing or requesting the skill. Reserved for hooks where judgment is genuinely required, or where the operator opted into manual confirmation. |
| `mute` | Do nothing. The hook fires and is recorded; no skill is prepared or requested. Used to opt out of a default policy without removing the hook. |

Defaults below name the recommended starting mode when a project or future
skill-metadata policy maps that hook to a skill. V1 does not ship concrete
default skill mappings. If no policy mapping exists, the hook is recorded but
no skill is prepared or requested.

## Core Hook Vocabulary

Each hook in this table is part of the shipped vocabulary. Custom hooks
live in author or operator namespaces (see "Authoring Custom Hooks").

| Hook | Meaning | Detected From | Cardinality | Default Mode |
| --- | --- | --- | --- | --- |
| `before:high-impact-alignment` | About to undertake work the operator marked high-impact, where alignment with the operator pays off before changes land. | Goal contract field `impact: high`, or explicit `--high-impact` operator flag at Run start. | per-run | `ask` |
| `before:architecture-analysis` | About to perform deep structural analysis of the codebase. | Selected flow is Explore with `kind: architecture`, or any step whose metadata declares `kind: architecture-analysis`. | per-step | `auto` |
| `before:plan-implementation` | About to decide an implementation approach for the current goal. | Stage transition into Plan, or step metadata `kind: plan`. | per-stage | `auto` |
| `before:implementation` | About to start writing code for an approved plan. | Stage transition from Plan to Act, or first Act-stage step start. | per-stage | `auto` |
| `before:verification` | About to verify the work against acceptance criteria. | Stage transition into Verify, or step metadata `kind: verify`. | per-stage | `auto` |
| `after:react-ui-change` | A step finished after touching React UI files. | Step diff includes paths matching `*.tsx`, `*.jsx`, or future `skill_hooks.detection.react_surfaces` patterns in project config. | per-step | `auto` |
| `after:test-change` | A step finished after touching test files. | Step diff includes paths matching `*.test.*`, `*.spec.*`, `__tests__/`, `tests/`, or future `skill_hooks.detection.test_surfaces` patterns in project config. | per-step | `auto` |
| `after:schema-change` | A step finished after touching type, schema, or migration files. | Step diff includes paths matching `*.prisma`, `*.sql`, `migrations/`, `schemas/`, or future `skill_hooks.detection.schema_surfaces` patterns in project config. | per-step | `auto` |
| `after:api-surface-change` | A step finished after touching declared public API. | Step diff includes future `skill_hooks.detection.api_surfaces` patterns in project config. No common-pattern fallback; explicit declaration only. | per-step | `auto` |
| `after:dependency-change` | A step finished after adding, removing, or upgrading a dependency. | Step diff shows lockfile changes, package manifest dependency-section changes, or language-specific dependency declarations. Script, metadata, or formatting-only manifest edits do not count. | per-step | `auto` |
| `after:verification-failed` | A required verification check returned failure. | Evidence map shows a required check with `outcome: failed` recorded during this Run. | per-step | `auto` |
| `after:evidence-gap` | Required evidence is missing after the verify stage. | Run envelope evidence map shows unsatisfied required claims after Verify-stage steps have run. | per-stage | `auto` |
| `before:close-run` | About to finalize the Run as complete, blocked, or handed off. | Run envelope decision to close, or stage transition into Close. | per-run | `auto` |
| `before:handoff` | About to save Run state for cross-session continuity. | Explicit handoff command, or Run envelope decision to handoff. | per-run | `auto` |

Fourteen hooks. The plan calls for "probably 10-15," and this set leaves
deliberate room for additions when concrete needs prove them.

## Cardinality Notes

`per-step` cardinality fires at most once per step, even when many files in
that step's diff match the detection rule. The detector does not iterate per
file. If a single Act step touches twenty React files, `after:react-ui-change`
fires once at step close.

`per-stage` cardinality fires at most once per stage instance or process
attempt. If Run performs a follow-up attempt with a new Verify stage,
`before:verification` may fire again for that attempt.

`per-run` cardinality fires at most once across the whole Run. The Run record
stores fired hooks with timestamps for visibility.

## Naming Conventions

- Use `before:` or `after:` as a temporal prefix.
- Use kebab-case for the body.
- Keep the body a short noun phrase that names the kind of work or condition.
- Prefer plain, durable terms. The vocabulary should still read clearly a year
  from now.

## Authoring Custom Hooks

Custom hooks use a namespace prefix:

```text
<namespace>/<temporal>:<body>
```

Examples:

```text
acme-team/before:design-review
my-project/after:storybook-change
```

Authors and operators may add hooks under their own namespace at any time.
Custom hooks follow the same detection-from-observable-state rule as the
shipped vocabulary. Run does not auto-invent namespaces; the namespace lives
in the source that defines the hook (flow author or project config).

The shipped vocabulary has no namespace prefix and is reserved. Custom hooks
must use a namespace.

## What Is NOT A Hook

Anti-patterns rejected by this vocabulary:

- **Skill-named hooks.** A hook is not "the hook to run react-doctor."
  The skill subscribes to a hook; the hook does not name the skill.
- **Flow-named hooks.** A hook is not "during Fix." Use stage transitions
  or step metadata instead.
- **Inference-named hooks.** A hook is not "when the code looks risky."
  Risk must arrive as an explicit signal, not a model judgment.
- **Per-file hooks.** A hook is not "after editing this specific file."
  Use step-level detection over diff sets.
- **Setup-time hooks.** A hook is not "when the user installs the
  plugin." Hooks fire inside Run.

## Detection Authority And Trust Layer

| Detection Source | Trust | Use |
| --- | --- | --- |
| Goal contract fields | High | Read directly. |
| Selected process / step metadata | High | Read directly. |
| File paths and diffs | High | Use literal matchers and declared project config patterns. |
| Evidence map state | High | Read directly from Run envelope. |
| Explicit operator input | High | Read directly. |
| Future project config declarations (`skill_hooks.detection.*`) | High | Read directly from `~/.config/circuit/config.yaml` and `./.circuit/config.yaml` once the config schema owns those fields. |
| Natural-language inference over the goal text | Not allowed | Use `before:high-impact-alignment` with the explicit operator signal instead. |
| Natural-language inference over a step's prose output | Not allowed | Use evidence-map state or step metadata instead. |

If a desired hook cannot be detected from the high-trust sources, the
correct response is not to relax the rule. The correct response is to add an
explicit signal that the operator or flow author provides.

## Run Record Fields

Each fired hook produces a Run record entry with:

- `hook`: canonical name (shipped or namespaced).
- `detected_from`: a short identifier of the detection source (e.g.,
  `diff:*.tsx`, `contract.impact=high`, `stage-transition:Plan->Act`).
- `cardinality`: `per-run`, `per-stage`, or `per-step`.
- `step_id` and `stage_id`: where the hook fired.
- `policy_mode`: the resolved mode from project policy (`auto`, `ask`,
  `mute`).
- `triggered_skills`: list of skill requests with provenance state
  (`planned`, `staged`, `requested`, `observed`, `unplanned`).
- `unavailable_skills`: optional list of policy-mapped skill ids that were
  not found in host-native skill roots, if project policy or a future default
  mapping attempted to map to a concrete skill that is not installed.

This is the data structure that makes the Skill Hooks section of the
migration plan testable and auditable.

## Validation Fixtures

Fixtures that should exist before this vocabulary is wired into Run:

- **Vocabulary completeness fixture.** Every hook in the shipped table has a
  detection rule, a cardinality, a default mode, and at least one positive
  detection case.
- **Pete's named examples fixture.** A sample project policy maps
  `before:high-impact-alignment` to alignment-class skills,
  `before:architecture-analysis` to architecture-analysis-class skills, and
  `after:react-ui-change` to React review skills. Each match is explainable
  through that policy entry. Without the sample policy, the hooks are
  recorded but no skill is prepared or requested.
- **Cross-flow fixture.** The same hook, emitted from two different flows,
  triggers the same policy mapping. Proves hooks are not flow-bound.
- **Namespace fixture.** A custom-namespaced hook is recognized and
  recorded; a shipped-name hook from a custom namespace is rejected.
- **Detection-source fixture.** Each hook fires only when its declared
  detection source is present in observable Run state. Negative cases reject
  firing on natural-language inference.
- **Cardinality fixture.** A `per-step` hook with twenty matching files in
  one step fires once. A `per-run` hook fires at most once across an entire
  Run.
- **Activation provenance fixture.** A `staged` or `requested` skill is not
  recorded as `observed` without host or relay proof.
- **`ask`-mode fixture.** A hook with `ask` policy produces a Run decision
  packet rather than preparing or requesting the skill automatically.
- **Availability fixture.** A policy-mapped concrete skill id is checked
  against host-native skill roots before use. Missing skills are recorded as
  unavailable and do not fail the Run unless the operator explicitly made the
  policy strict.

## Open Questions

- **Configurable detection patterns.** The schema, test, and React detectors
  use literal default patterns and an optional project-config declaration.
  Should the declaration be merged with the defaults or replace them? V1
  proposes merge with the project config able to disable any default by
  listing it under a future `skill_hooks.detection.disabled_patterns` key.
- **Default mappings and packaging.** V1 ships the vocabulary, not concrete
  default skill mappings. If future Circuit releases ship default mappings,
  they must be availability-gated against host-native skill roots. Circuit may
  offer optional first-party skill packs or setup-time install suggestions, but
  the core vocabulary must not assume those skills are installed.
- **`auto` versus `ask` defaults for code-touch hooks.** The proposed
  defaults make every `after:*-change` hook `auto`. If this proves noisy in
  early use, a future iteration may demote the noisiest detectors to `ask` or
  introduce a per-policy budget. V1 keeps it simple and trusts policy
  authors to mute what they do not want.
- **Skill metadata declarations.** The plan defers skill metadata that
  advertises hook subscriptions. When metadata lands, it should not bypass
  the policy layer; metadata adds a default mapping that policy can override.
- **Decision packet shape for `ask` mode.** The Run decision packet defined
  in Phase 7 of the migration plan should subsume the `ask`-mode prompt, but
  this needs a small fixture pass to confirm one shape covers both checkpoint
  decisions and hook-ask decisions.
- **Vocabulary growth process.** Adding a shipped hook is a vocabulary
  commitment. The bar should be: a real use case across at least two flows
  with explicit observable detection. The bar to mint a custom-namespaced
  hook is much lower and stays inside the author's namespace.

## Decision

Adopt this vocabulary as the V1 shipped set behind the Phase 3.5 work. The
fixtures above are the proof bar. Project policy lives in the existing config
layers. Custom hooks live in author and operator namespaces. Detection
stays in the high-trust source list. The vocabulary stays small until concrete
use proves the next addition.
