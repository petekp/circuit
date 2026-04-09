# Control Plane Ownership

Short maintenance map for the catalog and verifier control plane. Use this to
find the single owner for a fact before editing tests or generated surfaces.

## Runtime identity owner

Runtime identity comes from authored skill definitions, not narrative docs:
workflow identity comes from `skills/*/circuit.yaml`, while non-workflow
identity comes from `skills/*/SKILL.md` frontmatter `role: utility|adapter`.
`scripts/runtime/engine/src/catalog/extract.ts` normalizes those sources into
catalog entries.

- Workflow identity comes from `circuit.yaml`.
- Non-workflow identity comes from `role: utility|adapter` in frontmatter.
- No handwritten doc owns runtime identity.

## Public surface owner

`scripts/runtime/engine/src/catalog/public-surface.ts` owns slash-command
derivation, public command ids, invocation text, and command shim contents.

`scripts/runtime/engine/src/catalog/catalog-doc-projections.ts` owns how that
public surface is projected into generated `CIRCUITS.md` blocks.

## Shipped surface owner

`scripts/runtime/engine/src/catalog/surface-roots.ts` owns which roots count as
shipped and which paths are ignored.

`scripts/runtime/engine/src/catalog/surface-fs.ts` owns raw installed-surface
filesystem facts: recursive walking, hashing, executable-bit checks, and
top-level entry listing.

`scripts/runtime/engine/src/catalog/surface-inventory.ts` owns repo-time
inventory projection, generated projection inclusion, and plugin metadata
capture.

`scripts/runtime/engine/src/catalog/surface-manifest.ts` owns
`scripts/runtime/generated/surface-manifest.json`.

## Verification owner

`scripts/runtime/engine/src/catalog/verify-installed-surface.ts` owns manifest
and installed-filesystem agreement checks.

`scripts/runtime/engine/src/cli/verify-install.ts` owns the broader install
verification CLI orchestration (generated freshness, surface verification,
config, dispatch, and runtime checks).

`scripts/verify-install.sh` is a thin shell wrapper around that broad CLI.

## Generated artifacts

| Fact | Owner | Generated outputs | Tests that guard it |
|---|---|---|---|
| Workflow vs utility vs adapter classification | `extract.ts` | catalog JSON, public projections, manifest entries | `catalog-validator.test.ts` |
| Public slash command ids and shims | `public-surface.ts` | `.claude-plugin/public-commands.txt`, `commands/*.md` | `catalog-validator.test.ts`, `release-integrity.test.ts` |
| CIRCUITS generated reference blocks | `catalog-doc-projections.ts` | generated blocks in `CIRCUITS.md` | `catalog-validator.test.ts`, `generate.test.ts` |
| Shipped root allowlist and schema path pattern | `surface-roots.ts` | schema path regex, sync pruning inputs | `surface-roots.test.ts`, `catalog-validator.test.ts`, `sync-to-cache.test.ts` |
| Raw installed-surface filesystem facts | `surface-fs.ts` | file inventory inputs and installed top-level listings | `surface-fs.test.ts`, `verify-installed-surface.test.ts` |
| Repo-time installed file inventory projection | `surface-inventory.ts` | `surface-manifest.json` file inventory | `verify-installed-surface.test.ts`, `generate.test.ts` |
| Manifest entry projection and rendering | `surface-manifest.ts` | `scripts/runtime/generated/surface-manifest.json` | `catalog-validator.test.ts`, `generate.test.ts`, `verify-installed-surface.test.ts` |
| Generate target registration and stale shim pruning | `generate-targets.ts` | catalog compiler write set | `catalog-validator.test.ts`, `generate.test.ts` |
| Broad install verification CLI | `cli/verify-install.ts` | bundled `scripts/runtime/bin/verify-install.js` behavior | `runtime-cli-integration.test.ts` |

## Which files to edit for each kind of change

| If you are changing... | Edit here first | Then regenerate / verify |
|---|---|---|
| Workflow identity, purpose, entry usage, or modes | `skills/<slug>/circuit.yaml` | `node scripts/runtime/bin/catalog-compiler.js generate`, `catalog-validator.test.ts` |
| Utility or adapter visibility | `skills/<slug>/SKILL.md` frontmatter | regenerate catalog outputs, run `release-integrity.test.ts` |
| Public command shim text or invocation projection | `scripts/runtime/engine/src/catalog/public-surface.ts` | regenerate catalog outputs, run catalog tests |
| CIRCUITS generated tables or entry-mode snippets | `scripts/runtime/engine/src/catalog/catalog-doc-projections.ts` | regenerate catalog outputs, review `CIRCUITS.md` |
| What ships in the installed plugin surface | `scripts/runtime/engine/src/catalog/surface-roots.ts`, `surface-fs.ts`, and `surface-inventory.ts` | regenerate manifest, run `surface-fs.test.ts`, `verify-installed-surface.test.ts`, and `./scripts/verify-install.sh` |
| Surface manifest structure or rendering | `scripts/runtime/engine/src/catalog/surface-manifest.ts` and `schemas/surface-manifest.schema.json` | regenerate manifest, run schema + verifier tests |
| Which generated files the compiler manages | `scripts/runtime/engine/src/catalog/generate-targets.ts` | run `catalog-compiler.js generate --check`, `generate.test.ts` |
| Repo-level installed verification behavior | `scripts/runtime/engine/src/catalog/verify-installed-surface.ts`, `scripts/runtime/engine/src/cli/verify-install.ts`, and `scripts/verify-install.sh` | run verifier tests, CLI integration tests, and `./scripts/verify-install.sh` |
