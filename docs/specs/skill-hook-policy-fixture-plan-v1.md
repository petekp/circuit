# Skill Hook Policy Fixture Plan V1

Status: fixture-spec and test-plan target, not current behavior.

Date: 2026-05-28

## Purpose

Define the smallest pure fixture suite that can make Skill Hooks
implementable without changing runtime behavior first.

This is the contract bridge between the vocabulary in
[skill-hook-vocabulary-v1.md](skill-hook-vocabulary-v1.md) and a later
source implementation. It pins the proposed policy config shape, flow-authored
hook field, Run record event shape, and availability behavior before those
surfaces land in code.

The first slice should answer one question:

> Can Circuit represent hook-triggered skill policy deterministically, with
> honest skill availability and activation provenance, without reintroducing
> flow-step skill binding matrices?

## Evidence Used

- Run-centered migration plan:
  [run-centered-migration-plan-v1.md](run-centered-migration-plan-v1.md)
- Skill hook vocabulary:
  [skill-hook-vocabulary-v1.md](skill-hook-vocabulary-v1.md)
- Config and config loading:
  [docs/configuration.md](../configuration.md),
  [docs/contracts/config.md](../contracts/config.md),
  [src/schemas/config.ts](../../src/schemas/config.ts)
- Skill, selection, and step contracts:
  [docs/contracts/skill.md](../contracts/skill.md),
  [docs/contracts/selection.md](../contracts/selection.md),
  [docs/contracts/step.md](../contracts/step.md),
  [src/schemas/skill.ts](../../src/schemas/skill.ts),
  [src/schemas/selection-policy.ts](../../src/schemas/selection-policy.ts),
  [src/schemas/step.ts](../../src/schemas/step.ts),
  [src/shared/selection-resolver.ts](../../src/shared/selection-resolver.ts),
  [src/shared/skill-loading.ts](../../src/shared/skill-loading.ts)

## Scope

Allowed in the first implementation slice:

- pure schemas;
- static fixtures;
- fixture tests;
- docs updates that describe the planned surface.

Out of scope for the first slice:

- runtime skill dispatch;
- connector changes;
- host command changes;
- generated package changes;
- actual decision packet rendering;
- automatic skill pack installation;
- default concrete skill mappings.

## Target Config Shape

Skill Hook policy should live inside the existing config layers:

- `~/.config/circuit/config.yaml` for user-global defaults;
- `./.circuit/config.yaml` for project overrides.

Do not create a separate skill-policy file for V1.

Proposed config shape:

```yaml
schema_version: 1

skill_hooks:
  policy:
    after:react-ui-change:
      mode: auto
      skills:
        - react-doctor

    before:high-impact-alignment:
      mode: ask
      skills:
        - grill-with-docs

    before:architecture-analysis:
      mode: mute

  detection:
    react_surfaces:
      - "app/**/*.tsx"
      - "components/**/*.tsx"
    api_surfaces:
      - "src/api/**"
    disabled_patterns:
      after:react-ui-change:
        - "generated/**"
```

This is a future config surface. The current strict config schema should keep
rejecting `hooks` until the implementation slice deliberately adds it.

Proposed typed shape:

```ts
type SkillHookName =
  | `${'before' | 'after'}:${string}`
  | `${string}/${'before' | 'after'}:${string}`;

type SkillHookPolicyMode = 'auto' | 'ask' | 'mute';

interface SkillHookPolicyRule {
  mode: SkillHookPolicyMode;
  skills?: SkillId[];
  strict?: boolean;
}

interface SkillHookDetectionConfig {
  react_surfaces?: string[];
  test_surfaces?: string[];
  schema_surfaces?: string[];
  api_surfaces?: string[];
  disabled_patterns?: Record<SkillHookName, string[]>;
}

interface SkillHookConfig {
  policy?: Record<SkillHookName, SkillHookPolicyRule>;
  detection?: SkillHookDetectionConfig;
}
```

Rules:

- Shipped hook names must match `^(before|after):[a-z][a-z0-9-]*$`.
- Custom hook names must match
  `^[a-z][a-z0-9-]*/(before|after):[a-z][a-z0-9-]*$`.
- `mode: auto` and `mode: ask` require a non-empty unique `skills` list.
- `mode: mute` must not carry `skills`.
- `strict` defaults to `false`.
- Future first-party default mappings must behave as `strict: false`.
- Policy keys may name shipped hooks or custom namespaced hooks.
- Custom hooks must include a namespace such as
  `my-project/after:storybook-change`.
- Shipped hook names must not include a namespace.
- Surplus keys are rejected at every declared object shape, matching the config
  contract's current strictness.

Layering:

- User-global and project policies use the same shape.
- Project policy overrides user-global policy by hook key.
- A project `mute` rule suppresses a user-global `auto` or `ask` rule for the
  same hook.
- Policy rule composition is whole-entry replacement. Do not merge individual
  `skills` arrays across layers in V1.

## Flow-Authored Hook Field

Flow-authored hooks should be declared by the flow author, not by the
operator.

Proposed step field:

```ts
interface StepBase {
  skill_hooks?: SkillHookName[];
}
```

Example:

```yaml
id: analyze-architecture
title: Analyze architecture
skill_hooks:
  - before:architecture-analysis
```

Rules:

- `skill_hooks` names hooks only.
- It must not carry concrete `SkillId`s.
- It must not carry policy mode.
- It must not carry host-specific invocation options.
- It must not replace `skill_slots` or `SelectionOverride.skills`; those remain
  lower-level compatibility and power-user mechanisms.
- Public built-in flows may declare shipped, non-namespaced hooks only.
- User-authored flows may declare namespaced custom hooks.

Rejected shape:

```yaml
skill_hooks:
  after:react-ui-change:
    skills:
      - react-doctor
```

That shape recreates a flow-step skill binding matrix and should fail fast.

## Run Record Shape

Each fired hook should produce a Run envelope event. The event records what
Circuit prepared, not what the worker definitely did.

Proposed shape:

```ts
type SkillHookCardinality = 'per-run' | 'per-stage' | 'per-step';

type SkillHookSkillState =
  | 'planned'
  | 'staged'
  | 'requested'
  | 'observed'
  | 'unplanned'
  | 'unavailable';

type SkillHookPolicyResolution =
  | {
      mode: 'none';
      source: 'none';
    }
  | {
      mode: SkillHookPolicyMode;
      source: 'project-policy' | 'user-global-policy' | 'default-mapping';
      strict: boolean;
      policy_ref?: string;
    };

interface SkillHookSkillRef {
  id: SkillId;
  state: SkillHookSkillState;
  source: 'project-policy' | 'user-global-policy' | 'default-mapping' | 'host-observed';
  reason?: string;
}

interface SkillHookEvent {
  schema: 'run.skill-hook@v0';
  event_id: string;
  hook: SkillHookName;
  detected_from: string[];
  cardinality: SkillHookCardinality;
  policy: SkillHookPolicyResolution;
  flow_id?: CompiledFlowId;
  stage_id?: StageId;
  step_id?: StepId;
  attempt_id?: string;
  decision_packet_id?: string;
  triggered_skills: SkillHookSkillRef[];
  unavailable_skills?: SkillHookSkillRef[];
}
```

State meanings:

| State | Meaning |
| --- | --- |
| `planned` | Policy matched a skill before the step ran. |
| `staged` | Circuit put the hook or skill request into step context. |
| `requested` | Circuit explicitly asked the host or connector to consider a skill. |
| `observed` | Host or relay evidence proves the skill actually ran. |
| `unplanned` | Host evidence suggests a skill ran without Circuit planning it. |
| `unavailable` | Policy mapped a concrete skill id that was not found in host-native skill roots. |

`observed` is the only state that may support a claim that a skill actually
ran. `planned`, `staged`, and `requested` are preparation states.

Unplanned skill activity is logged neutrally. Circuit may suggest a future
policy mapping or mute, but it must not rewrite policy automatically.

When no policy mapping exists for a fired hook, the event uses
`policy: { mode: 'none', source: 'none' }`, keeps `triggered_skills` empty, and
does not attempt availability checks.

## Availability Behavior

Circuit should resolve concrete policy skills against the existing host-native
roots before using them:

1. `~/.agents/skills/<skill-id>/SKILL.md`
2. `~/.claude/skills/<skill-id>/SKILL.md`

Rules:

- A fired hook is recorded even when no policy mapping exists.
- No policy mapping means no skill is prepared, requested, or checked for
  availability.
- Missing skills are recorded as `unavailable`.
- Missing skills do not fail the Run by default.
- Missing skills do not block the hook itself from being recorded.
- Missing skills produce no `staged`, `requested`, or `observed` claim.
- If a policy rule has `strict: true`, Circuit must not silently continue as
  if the skill was available. It should produce a decision packet or
  needs-attention outcome; the operator can still choose to continue without
  the skill.
- Future default mappings must never be `strict: true`.
- Circuit may suggest installing or mapping a missing skill, but it must not
  silently install or package it as part of the core Run path.

Optional first-party skill packs can be explored later. They should be
installable support material, not a hidden dependency of the shipped hook
vocabulary.

## Fixture Suite

### 1. Policy Shape Fixtures

Positive cases:

- `auto` with one skill.
- `ask` with one skill.
- `mute` with no skills.
- user-global policy with project override.
- project `mute` overriding user-global `auto`.
- namespaced custom hook under project policy.

Negative cases:

- `auto` with no skills.
- `ask` with no skills.
- `mute` with skills.
- duplicate skills in one rule.
- invalid skill id.
- invalid hook name.
- custom hook without namespace when it is not a shipped hook.
- shipped hook with a namespace.
- surplus keys under `hooks`, `policy`, a policy rule, or `detection`.

### 2. Layering Fixtures

Cases:

- User-global policy applies when project has no matching hook key.
- Project policy replaces the whole user-global entry for the same hook.
- Project `mute` suppresses user-global skill preparation.
- Two different hook keys do not affect each other.
- No policy mapping records the hook and prepares no skill.

### 3. Flow-Authored Hook Fixtures

Positive cases:

- Step declares one shipped hook.
- Step declares several shipped hooks.
- User-authored flow declares a namespaced custom hook.

Negative cases:

- Step declares a concrete skill id where a hook name is expected.
- Step declares a flow-step binding object such as `{skills: [...]}`.
- Built-in public flow declares a custom namespaced hook.
- Hook name depends on inference language such as `after:risky-code`.

### 4. Detection Fixtures

Cases:

- All fourteen shipped hooks have at least one positive fixture.
- Each positive fixture cites an observable source:
  file path, diff, goal contract field, evidence map state, selected process,
  step metadata, stage transition, or explicit operator input.
- Natural-language goal prose alone never fires a hook.
- Natural-language step output alone never fires a hook.
- `after:dependency-change` fires on lockfile or dependency-section changes,
  not script-only or metadata-only manifest edits.
- `after:api-surface-change` requires explicit `skill_hooks.detection.api_surfaces`
  config.

### 5. Cardinality Fixtures

Cases:

- `per-step` fires once for a step that touches many matching files.
- `per-stage` fires once per stage instance or process attempt.
- A follow-up attempt with a new Verify stage may fire `before:verification`
  again.
- `per-run` fires once across the whole Run.

### 6. Mode Fixtures

Cases:

- `auto` prepares or requests available skills without a decision packet.
- `ask` produces a decision packet before preparing or requesting skills.
- `mute` records the hook and prepares no skills.
- `ask` with a rejected decision produces no skill request.
- `ask` with an accepted decision records the decision packet id on the hook
  event.

### 7. Availability Fixtures

Cases:

- Available policy skill resolves from `~/.agents/skills`.
- Available policy skill resolves from `~/.claude/skills` when absent from
  `~/.agents/skills`.
- `~/.agents/skills` wins when both roots contain the same skill id.
- Missing policy skill records `unavailable` and continues when `strict` is
  omitted or `false`.
- Missing policy skill produces needs-attention or a decision packet when
  `strict: true`.
- Future default mapping with a missing skill records unavailable and continues.

### 8. Activation Provenance Fixtures

Cases:

- `planned` does not imply `staged`.
- `staged` does not imply `observed`.
- `requested` does not imply `observed`.
- `observed` requires host or relay proof.
- An unplanned host-proven skill is recorded as `unplanned`, not retroactively
  as `planned`.
- Unplanned activity may produce a suggestion, but never mutates policy
  automatically.

### 9. Regression Fixtures

Cases:

- Existing `skill_slots` fixtures still pass.
- Existing `SelectionOverride.skills` fixtures still pass.
- Existing config fixtures still reject surplus keys outside the new
  `hooks` surface.
- Current config fixtures reject `hooks` until the implementation slice adds
  the new schema field.
- `npm run check-flow-drift` remains clean because this slice has no generated
  host-surface changes.

## First Code Slice

The first implementation slice should add only pure schema and fixture tests:

- `SkillHookName`
- `SkillHookPolicyMode`
- `SkillHookPolicyRule`
- `SkillHookConfig`
- `Step.skill_hooks`
- `RunSkillHookEvent`

Expected focused tests:

- `tests/contracts/skill-hook-policy-schema.test.ts`
- `tests/contracts/skill-hook-vocabulary-fixtures.test.ts`
- existing config, selection, skill, and documentation-surface tests

No runtime dispatcher, connector behavior, or generated host output should land
in this first slice.

## Open Questions

- Should `strict: true` use a blocking needs-attention state or a resumable
  decision packet with "continue without skill" as a safe choice?
- Should future skill metadata mappings be materialized into policy at setup
  time, or resolved live at Run start?
- Should policy entries support labels or descriptions for operator-facing
  decision packets, or should those be derived from the skill metadata?
- Should default first-party skill packs exist, and if so, are they installed by
  a setup command rather than bundled into the core plugin?

## Decision

Proceed with a pure fixture slice before runtime wiring. Hook policy should
use existing config layers, flow-authored steps should publish hooks instead
of skill ids, Run records should separate preparation from observed activation,
and missing mapped skills should be availability-gated through host-native
skill roots.
