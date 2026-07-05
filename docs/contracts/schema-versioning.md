---
contract: schema-versioning
status: ratified-v0.1
version: 0.1
schema_source: src/schemas/
last_updated: 2026-06-10
depends_on: []
---

# Schema Versioning Policy

Several Circuit schemas pin a `schema_version` literal. This doc states
what that pin means, when it must change, and what readers do on a
mismatch. It applies to every schema family that declares a
`schema_version` field.

## What `schema_version` means

`schema_version` names the shape contract of a persisted artifact. The
strict schema pins it as a literal. A reader that parses the artifact
may rely on everything that version promises: which fields exist, their
types, and what they mean.

Each schema family owns its own `schema_version`. The compiled-flow
version says nothing about the continuity version, and so on.

## When to bump

Bump the literal when a change alters what the strict schema accepts or
what readers can rely on. That includes:

- Adding a required field.
- Removing a field. Strict schemas reject unknown keys, so artifacts
  written before the removal stop parsing.
- Retyping a field.
- Changing the meaning of an existing field, even if the shape is
  unchanged.

Adding an optional field is a judgment call. If old readers stay
correct and old artifacts still parse, the version may stay. When in
doubt, bump. Breaking changes are fine here; silent or confusing breaks
are not.

## When not to bump

- Comment, formatting, or key-order changes.
- Doc-only changes.
- Internal refactors that keep the accepted shape and field meanings
  identical.

## What a reader does on mismatch

Reject the artifact. The error must surface the `schema_version` path
so the operator sees a version mismatch, not a puzzle about some
unrelated key. There is no migration layer: regenerate the artifact
from source (for generated surfaces) or recreate it (for
operator-authored flows).

**One documented exception: the shared config path.** The operator
config files (`~/.config/circuit/config.yaml` and
`.circuit/config.yaml`) carry two document families, discriminated by
`schema_version`: `1` is the selection config, `2` is the policy
envelope. The runtime loader routes on the number before choosing a
schema, so a `schema_version: 2` file is not a rejected config — it is
a policy envelope. Because the number discriminates families there, a
claimed number is never reused; the config contract
([config.md](config.md) CONFIG-I6) carries the registry, and the next
breaking `Config` shape takes `3`.

Frozen evidence is the one exception. Release proof runs under
`docs/release/proofs/` are historical records and are never edited to
match a new version. A test that parses a frozen record shims the
legacy fields at the parse site and says why in a comment. See the
custom-flow proof handling in
`tests/release/release-infrastructure.test.ts`.

## Current string-literal pins

| Family | Pin | Source |
| --- | --- | --- |
| CompiledFlow | `'3'` | `src/schemas/compiled-flow.ts` |
| FlowSchematic | `'2'` | `src/schemas/flow-schematic.ts` |
| FlowBlockCatalog | `'1'` | `src/schemas/flow-blocks.ts` |

Other families (config, continuity, history, run result, reports) pin
numeric literals in their own schema modules and follow the same rules.

## Why this exists

The dead `entry` block was removed from CompiledFlow and FlowSchematic
without a version bump. Pre-removal artifacts then failed parse with
`Unrecognized key: "entry"`, which says nothing about why. A version
bump turns that into a clear mismatch on `schema_version`. This policy
makes the bump a rule instead of a judgment made under refactor
pressure.
