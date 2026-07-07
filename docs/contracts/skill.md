---
contract: skill
status: ratified-v0.1
version: 0.2
schema_source: src/schemas/skill.ts
last_updated: 2026-05-08
depends_on: [ids, selection-policy, config, run]
report_ids:
  - skill.descriptor
  - skill.user-entry
  - skill.slot
invariant_ids: [SKILL-I1, SKILL-I2, SKILL-I3, SKILL-I4, SKILL-I5, SKILL-I6, SKILL-I7, SKILL-I8, SKILL-I9]
property_ids: [skill.prop.descriptor_round_trips_through_json, skill.prop.id_closure_under_selection, skill.prop.id_is_unique_within_catalog, skill.prop.trigger_is_advisory_not_grammar]
---

# Skill Contract

A **Skill** in Circuit is a discoverable capability with a local
`SKILL.md` instruction file. Circuit deals with two related but separate
projections:

1. **`SkillDescriptor`** — the compiled plugin catalog entry. This is the
   build-time projection a catalog compiler can enumerate.
2. **`UserSkillEntry`** — the relay-time projection of a user's local
   `SKILL.md` file discovered under a host-native skill root.

A **Skill slot** is an optional flow-authored placeholder such as
`review-assistant`. Users bind slots to their own concrete local skills in
config. Slot ids are not `SkillId`s and do not appear in
`ResolvedSelection.skills`.

The descriptor is NOT the Claude Code `SKILL.md` YAML frontmatter. CC's
frontmatter (`name`, `description`, `trigger`) is an external-protocol
INPUT to the catalog compiler; this contract governs the compiler's
internal OUTPUT shape. The field sets differ: Circuit's descriptor
uses `id`/`title`/`description`/`trigger` plus `capabilities` and
`domain`. The compiler's mapping from CC frontmatter to this descriptor
is a catalog-compiler concern, not a schema concern; when that compiler
lands it will cite this contract as its output target.

`skill.descriptor` is therefore greenfield: the descriptor shape is invented
by Circuit. `skill.user-entry` is the minimal local-skill projection used
by the runtime loader. It accepts optional `SKILL.md` frontmatter fields
(`name`, `description`, `trigger`) but derives `id` from the directory name,
not from frontmatter.

## Ubiquitous language

See [UBIQUITOUS_LANGUAGE.md#skill-and-plugin-language](../../UBIQUITOUS_LANGUAGE.md#skill-and-plugin-language)
for canonical definitions of **Skill**, **Plugin**, and **Catalog compiler**.
This contract adds no new vocabulary — it only ratifies the existing entries.

The distinction to keep straight: a **skill** is the capability (what
the plugin does when invoked); the **descriptor** is the catalog entry
that names it, triggers it, and classifies it. The descriptor is
authored once per skill at build time and read by the selection
resolver at relay time.

## Invariants

The runtime MUST reject any `SkillDescriptor` that violates these. All
invariants are enforced via `src/schemas/skill.ts` and tested in
`tests/contracts/skill-schema.test.ts` and
`tests/runner/user-skill-loading.test.ts`.

- **SKILL-I1 — `id` is a `SkillId` (branded slug).** Format is the
  shared slug pattern `/^[a-z][a-z0-9-]*$/`. Uppercase, underscores,
  path separators, and leading digits are rejected at parse time.

  **Brand scope caveat.** `SkillId` is TypeScript-nominal only: it
  shares the runtime regex with `CompiledFlowId`, `StageId`, and `StepId`.
  After parse, TypeScript callers cannot accidentally substitute
  one for another at call sites. BUT the regex itself does NOT
  distinguish them — a string that parses as `SkillId` also parses as
  `CompiledFlowId`. JSON, YAML, and explicit casts erase the brand. If
  nominal runtime separation is ever required (e.g., a union-type
  surface accepting any of the four), use distinct regex prefixes or
  a discriminated-id object. v0.1 accepts the structural overlap.

- **SKILL-I2 — `title`, `description`, and `trigger` are non-empty
  strings.** A descriptor with any of these blank is rejected.
  Rationale:
  - `title` — operator-facing display name.
  - `description` — selection-resolver input; "when should I use
    this?" prose that goes into the catalog compiler's trigger index.
  - `trigger` — free-form prose describing when to apply the skill.
  Semantics are advisory (LLM-consumed), not a regex or grammar.

  **`trigger` scope caveat.** In v0.1, `trigger` is opaque prose. **No
  deterministic runtime resolver may parse its syntax.** The selection
  resolver MAY surface it to a model at trigger-match time, but any
  deterministic branching on `trigger` tokens is out of contract. The
  day a resolver starts tokenizing or pattern-matching `trigger` is the
  day this invariant must be renegotiated. v0.2 reopen condition
  added for that case.

- **SKILL-I3 — `domain` is a closed enum with default
  `domain-general`.** Allowed values: `coding`, `design`, `research`,
  `ops`, `domain-general`. The default is applied on omission (zod
  `.default(...)` behavior). Adding a new domain is a breaking change
  (clients that switch on the enum must be updated).

- **SKILL-I4 — `capabilities` is OPTIONAL; when present, non-empty.**
  The field carries an explicit, operator-facing list of named
  capabilities (e.g. `['red-green-refactor', 'property-based']`).
  Constraints:
  - Optional — omission means capabilities are **not declared** for
    this descriptor. It does NOT mean the skill has no capabilities.
  - When present, the array MUST be non-empty (`.min(1)`).
  - Each element MUST be a non-empty string (`z.string().min(1)`).
  An empty array `[]` is an ambiguity bug (`[]` would look identical
  to "not declared" to consumers iterating the field); rejected at
  parse time.

  **Semantic asymmetry note.** `SelectionOverride.skills` (see
  [docs/contracts/selection.md](selection.md) SEL-I3) uses `[]` meaningfully (an
  `override` mode with empty list is a "clear to none" operation).
  `SkillDescriptor.capabilities` does not, because the descriptor is a
  static catalog entry — there is no "clear to none" semantic.

- **SKILL-I5 — `.strict()` rejects surplus keys.** No free-form
  extension fields at parse time. A future slice MAY introduce typed
  extension slots (e.g. `tags`, `mcp_integrations`); v0.1 keeps the
  surface closed. Surplus-key attacks (e.g. smuggling an `connector` or
  `model` field through a descriptor to bypass `SelectionOverride`)
  are rejected here at the catalog boundary.

- **SKILL-I6 — Raw-input own-property guard (prototype-chain defense).**
  `.strict()` rejects surplus own keys but does NOT defend against
  prototype-chain smuggle: Zod reads inherited properties during parse,
  so `Object.create({id: 'evil', title: '...'})` would satisfy required
  fields through the prototype chain. The schema wraps
  `SkillDescriptor` with a `z.custom` pre-parse guard that runs
  `Object.hasOwn` on load-bearing fields (`id`, `title`, `description`,
  `trigger`). Inherited values fail before Zod's own property access.
  Mirrors continuity.ts CONT-I12 and run.ts RUN MED #3. Added post-
  Codex v0.1 review (MED #6).

- **SKILL-I7 — `UserSkillEntry` is a sibling schema, not a
  `SkillDescriptor` extension.** Local user-authored skills are
  projected as `{id, name?, description?, trigger?, root, path, sha256,
  bytes}`. The runtime derives `id` from the containing directory name
  and validates it as `SkillId`; it does not trust frontmatter to name
  the skill. `root` and `path` record where the chosen file came from.
  `sha256` and `bytes` are evidence fields for traceability. Surplus
  keys are rejected on the projected entry.

- **SKILL-I8 — User skill discovery is deterministic and host-native.**
  The registry scans only immediate child directories under
  `~/.agents/skills` and `~/.claude/skills`, in that order. Missing roots
  are ignored. When both roots contain the same `SkillId`,
  `~/.agents/skills` wins. Generated Circuit plugin skills under
  `plugins/` are not user skill roots and must not be scanned by this
  registry.

- **SKILL-I9 — `SkillSlot` is optional built-in-flow indirection.**
  A skill slot carries `{id, description}` where `id` is a kebab-case
  `SkillSlotId`. Slot ids are config binding keys, not `SkillId`s.
  Public built-in flows may expose optional slots, but they must not
  require slots or name operator-local concrete skill ids. Unbound slots
  are ignored at relay time.

## Pre-conditions

- The catalog compiler produces a JSON blob per skill that conforms to
  `SkillDescriptor.safeParse`.
- The catalog compiler closes `SkillId` references across the catalog:
  every `SkillId` named by generated plugin metadata MUST resolve to an
  existing `skill.descriptor` row in the compiled catalog. Schema-level
  enforcement is infeasible (cross-report closure); this is catalog-
  compiler work.
- The user skill registry resolves relay-time local skills from
  `~/.agents/skills/<skill-id>/SKILL.md` and
  `~/.claude/skills/<skill-id>/SKILL.md`. Concrete
  `ResolvedSelection.skills[]` ids and slot-bound skills are explicit
  operator choices and must resolve before connector invocation.
- `SKILL.md` frontmatter is optional. When present, only `name`,
  `description`, and `trigger` are read by the local projection; extra
  frontmatter fields are ignored by the loader.

## Post-conditions

After a `SkillDescriptor` is accepted:

- `id` has the same **structural** `SkillId` shape as
  `SelectionOverride.skills[]`; the two agree on id FORMAT.
  **Existence closure** — that a `SkillId` in a selection override
  resolves to an actual descriptor in the compiled catalog — is NOT
  proven by `SkillDescriptor.safeParse` or `SelectionOverride.safeParse`.
  That is catalog-compiler work and is reserved as Stage 2 property
  `skill.prop.id_closure_under_selection`.
- `domain` is always present (default-applied if omitted).
- `capabilities` is either absent or a non-empty list of non-empty
  strings; consumers can iterate without a zero-length-guard.
- No undocumented keys are accepted; consumers that want new fields
  must land a v0.2 schema change first.

After a `UserSkillEntry` is accepted:

- `id` is a concrete `SkillId` derived from the local skill directory.
- `root` and `path` are non-empty strings naming the selected root and
  `SKILL.md` path.
- `sha256` is a 64-character lowercase hex digest of the full file text.
- `bytes` is a non-negative integer byte count.
- `name`, `description`, and `trigger` are optional non-empty strings.

After a `SkillSlot` is accepted:

- `id` is a kebab-case `SkillSlotId`.
- `description` is non-empty operator-facing prose.
- The slot remains optional until config binds it to a concrete
  `SkillId`; no accepted slot by itself causes a skill to load.

## Property ids (reserved for Stage 2 testing)

- `skill.prop.id_closure_under_selection` — for every catalog-compiled
  skill set and every `SelectionOverride.skills[]` that references
  those skills, the referenced id resolves to an existing descriptor.
  Catalog-level property.
- `skill.prop.id_is_unique_within_catalog` — no two descriptors in the
  compiled catalog share an `id`. Catalog-level property.
- `skill.prop.descriptor_round_trips_through_json` — for every
  accepted descriptor,
  `SkillDescriptor.safeParse(JSON.parse(JSON.stringify(desc))).success ===
  true`. Documents that the schema is JSON-safe at the descriptor
  boundary.
- `skill.prop.trigger_is_advisory_not_grammar` — property placeholder
  asserting that no runtime relay depends on `trigger` string
  shape. Exists to anchor a future debate (if a later slice tries to
  promote `trigger` to a structured grammar, this property must be
  invalid explicitly).

## Cross-contract dependencies

- **ids**: `SkillId` — descriptor identity.
- **selection-policy**: `SkillOverride.skills` (see
  [docs/contracts/selection.md](selection.md) SEL-I3) references `SkillId` values
  that must resolve in the user skill registry when selected for relay.
  The contract-level guarantee is that `SkillOverride`,
  `SkillDescriptor`, and `UserSkillEntry` agree on the concrete id shape
  (all use `SkillId`).
- **config**: `skills.bindings` and `flows.<flow>.skill_bindings`
  map `SkillSlotId` keys to concrete `SkillId` values.
- **run**: `skills.loaded` trace entries record the `UserSkillEntry`
  evidence fields actually loaded for a relay attempt, without storing
  the skill body.

## Failure modes addressed

- **carry-forward:untyped-skill-bypass** — **Partially closed in v0.1
  (catalog boundary) + selection.md SEL-I3 (selection boundary).** The
  untyped skill channels (`CompiledFlow.default_skills`,
  `FlowOverride.skills`) were removed in selection.md v0.1
  (Codex HIGH #5). SkillDescriptor v0.1 ratifies the catalog-boundary
  side: no surplus keys, typed id, closed-enum domain, non-empty
  capabilities when present.

- **carry-forward:silent-extension-slots** — **Closed in v0.1 via
  SKILL-I5.** `.strict()` at the descriptor boundary prevents ad-hoc
  fields from accreting. Adding a field is a v0.2+ schema change with
  explicit evolution note.

- **carry-forward:ambiguous-empty-capabilities** — **Closed in v0.1 via
  SKILL-I4.** `capabilities: []` is rejected; consumers see either
  `undefined` (none declared) or a non-empty list.

- **carry-forward:prototype-chain-smuggle** — **Closed in v0.1 via
  SKILL-I6.** Raw-input own-property guard on `SkillDescriptor` mirrors
  continuity CONT-I12 and run RUN MED #3. Required catalog fields MUST
  be own on the raw input; inherited values rejected pre-parse.
  Codex v0.1 MED #6.

- **carry-forward:external-protocol-greenfield-confusion** — **Closed
  in v0.1 by reframing.** `skill.descriptor` governs the compiled
  catalog entry (greenfield). v0.2's `UserSkillEntry` reads the small
  local-loader subset of `SKILL.md` frontmatter (`name`, `description`,
  `trigger`) but does not ratify the full host protocol. A richer
  compiler-facing frontmatter contract remains a future concern.
  Codex v0.1 HIGH #1.

- **carry-forward:portable-built-ins-vs-local-skills** — **Closed in
  v0.2 by slot indirection.** Built-in public flows do not name
  operator-local `SkillId`s. They may expose optional `SkillSlot`s,
  and the operator binds those slots to their own local skills in
  config. This keeps public flows portable while still allowing
  project- or user-specific skill loading.

## Codex adversarial review (v0.1)

A narrow cross-model challenger pass (Codex CLI) produced 1
HIGH + 5 MED + 2 LOW objections. All 8 are folded into v0.1; no items
deferred.

## Evolution

- **v0.1** — initial contract with SKILL-I1..I6 (SKILL-I6
  added post-Codex for prototype-chain defense). Four Stage 2 property
  ids reserved. Closes the selection / connector / skill relay-time
  triplet on the authoring side. All 8 Codex objections folded in
  (HIGH #1 external-protocol reframe, MED #2 post-condition narrow,
  MED #3 trigger scope caveat, MED #4 capabilities prose tightened,
  MED #5 brand scope caveat, MED #6 SKILL-I6 added, LOW #7 comment
  fix, LOW #8 reopen conditions expanded).
- **v0.2 (user skill loading slice)** — adds `UserSkillEntry`,
  `SkillSlot`, and deterministic local registry semantics over
  `~/.agents/skills` and `~/.claude/skills`. `SkillDescriptor` stays the
  plugin-distributed catalog projection. Local `SKILL.md` instructions
  are loaded at relay time only when explicitly selected by
  `selection.skills` or through an operator-bound optional slot.
- **v0.3** — candidate scope items if evidence supports:
  - **Typed extension slots.** If plugin authors need structured
    extension fields (e.g. `mcp_integrations`, `tags`, `dependencies`),
    introduce a typed closed set rather than opening `.strict()` to
    arbitrary keys. Reopen condition: a second skill needs the same
    field shape.
  - **Structured trigger.** `trigger` is opaque prose in v0.1
    (SKILL-I2 scope caveat). Reopen conditions: (a) any runtime
    resolver code branches on `trigger` syntax; (b) selection accuracy
    data motivates structured grammar; (c) build-time NLP cost becomes
    a bottleneck. Until one of these lands, `trigger` stays free-form.
  - **Catalog-level closure property.** Promote
    `skill.prop.id_closure_under_selection` from Stage 2 property id
    to a schema-level `CatalogSnapshot` aggregate that binds
    `SkillDescriptor[]` to the reachable `SelectionOverride.skills`
    references. Reopen condition: selection resolver ships and
    operators hit unresolved-skill-id bugs in practice.
  - **Full upstream SKILL.md mapping contract.** Introduce a separate
    report id for the complete host frontmatter protocol if a catalog
    compiler needs more than the local-loader subset. Reopen condition:
    catalog compiler lands, OR host frontmatter changes in a way that
    breaks the current mapping.
  - **`capabilities` as resolver/filter input.** If any selection
    resolver treats `capabilities` as deterministic policy (filter,
    routing, eligibility), reopen to promote it from operator-facing
    documentation to typed policy vocabulary. Reopen condition: first
    resolver proposes `capabilities`-based relay.
- **v1.0 (Stage 2)** — ratified invariants + property tests under
  `tests/properties/visible/skill/` + catalog-level property harness. <!-- path-ok -->
