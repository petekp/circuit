# Skill Hooks Contract

Status: current shipped contract.

Skill Hooks route deterministic runtime signals to optional local skills. They
are not a new checkpoint or approval system. The shipped policy modes are:

- `auto`: record the hook event and inject resolved skills into the next
  implementer relay.
- `mute`: record the hook event but inject nothing.

If a policy rule omits `mode`, it resolves to `auto`.

There is no shipped `ask` mode. Future interactive Skill Hooks must be modeled
as checkpoint or run-transition work before they ship.

## Hook Names

The shipped hook vocabulary includes:

- `after:verification-failed`
- `after:evidence-gap`
- `before:edit-files`
- `after:edit-files`
- extension-suffix forms such as `before:edit-files:.ts` and
  `after:edit-files:.tsx`

Each vocabulary entry may carry its own `default_mode`. Policy rules may
override the mode per hook.

## Dispatch Order

Runtime dispatch happens after a step records `step.completed`. Hook events are
then appended as `run.skill-hook` trace entries. `auto` actuation affects later
relay loading, not the step that already completed.

Dispatch is best-effort. A dispatch failure records `run.skill-hook-error` when
possible, but it must not abort the run.

## Injection

`auto` injection uses one run-scoped channel. The channel is persistent and
non-draining. It is scoped to implementer relays only:

- implementer relays can receive injected skills;
- researcher and reviewer relays do not receive injected edit-oriented skills;
- `skills.loaded` records the skills actually loaded for a relay step.

Strict `auto` rules with unavailable skills record a pending decision packet and
inject nothing, including skills that did resolve. Non-strict rules record
unavailable skills and still inject the resolved skills.

## Characterization

The current contract is pinned by:

- `tests/contracts/skill-hook-policy-schema.test.ts` for policy modes,
  omitted-mode defaults, and hook-name vocabulary.
- `tests/runner/skill-hook-dispatch.test.ts` for report-only dispatch,
  verification/evidence-gap signals, and edit-file suffix matching.
- `tests/runner/skill-hook-actuation.test.ts` for `auto` injection, `mute`
  observe-only behavior, implementer role gating, checkpoint resume re-seeding,
  and trace order.
- `src/runtime/run/graph-runner.ts` for the post-`step.completed` dispatch
  order and best-effort failure handling.
- `src/skill-hooks/injection.ts` for the run-scoped non-draining injection
  channel.
