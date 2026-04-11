# Proposal C

## Approach

Today the shipped plugin surface is implicit in two places: `scripts/sync-to-cache.sh` hardcodes which top-level trees count as installable and prunes cache targets to the allowlist `.claude-plugin`, `commands`, `hooks`, `schemas`, `scripts`, and `skills`, while `scripts/verify-install.sh` walks `skills/*` and requires a same-named command shim for every skill directory. There is no explicit shipped manifest today. (`scripts/sync-to-cache.sh:21-35`, `scripts/sync-to-cache.sh:46-91`, `scripts/verify-install.sh:190-229`)

I would add a shipped-surface manifest at `.claude-plugin/shipped-surface.yaml` and make it the package source of truth. The current catalog contract only has `CircuitEntry` and `UtilityEntry`, so it cannot represent adapters or explicit public/private export state, even though the architecture explicitly distinguishes workflow circuits from utilities and calls `workers` an adapter. (`scripts/runtime/engine/src/catalog/types.ts:6-27`, `ARCHITECTURE.md:41-43`, `ARCHITECTURE.md:497-503`, `ARCHITECTURE.md:870-883`)

Each manifest entry would describe one shipped semantic unit, its package roots, and its explicit public export:

```yaml
schema_version: "1"
units:
  - id: build
    role: workflow
    roots: [skills/build]
    owns:
      circuit_manifest: skills/build/circuit.yaml
      skill_doc: skills/build/SKILL.md
    public:
      slash_aliases: [build]
      command_shim: commands/build.md

  - id: review
    role: utility
    roots: [skills/review]
    owns:
      skill_doc: skills/review/SKILL.md
    public:
      slash_aliases: [review]
      command_shim: commands/review.md

  - id: workers
    role: adapter
    roots: [skills/workers]
    owns:
      skill_doc: skills/workers/SKILL.md
    public: null

  - id: session-start
    role: hook
    roots: [hooks]
    public: null

  - id: runtime-bin
    role: runtime-cli-bundle
    roots: [scripts/runtime/bin, schemas]
    public: null
```

`id` is runtime identity, `role` is the one semantic role, `roots` are the installed bytes, `owns` points at the authoritative authored files, and `public` is the only place slash-command export is declared. That keeps workflow topology in `circuit.yaml`, instructional prose and display text in `SKILL.md`, and package/export state in the shipped manifest instead of scattering it across directory conventions and manual command shims. (`ARCHITECTURE.md:24-39`, `ARCHITECTURE.md:706-760`, `scripts/runtime/engine/src/catalog/extract.ts:46-77`, `scripts/runtime/engine/src/catalog/extract.ts:80-85`, `commands/build.md:1-5`, `commands/workers.md:1-5`)

`sync-to-cache.sh` would stop hardcoding the shipped shape and instead consume the manifest through a small Node helper that expands `roots`, rsyncs only declared units, and prunes undeclared cache content. The current script already has the right operational shape for this change because it centralizes pruning in `prune_cache_target()` and syncs a fixed set of trees with `rsync --delete`; the manifest would replace those hardcoded lists. (`scripts/sync-to-cache.sh:21-35`, `scripts/sync-to-cache.sh:46-91`)

The installed verifier would also consume the same manifest, but in installed mode. Today `verify-install.sh` is explicitly written to run from either repo or cache and applies the same directory-based checks relative to `PLUGIN_ROOT`; I would split that into repo verification for authoring parity and installed verification for shipped bytes plus runtime behavior. (`scripts/verify-install.sh:2-4`, `scripts/verify-install.sh:23-30`, `scripts/verify-install.sh:190-229`, `scripts/runtime/engine/src/runtime-cli-integration.test.ts:79-102`, `scripts/runtime/engine/src/runtime-cli-integration.test.ts:219-271`)

The public surface would derive from manifest `public` entries rather than from `skills/` directory membership. Right now the generated surface only covers circuits because `catalog-compiler` filters `entry.kind === "circuit"` and patches `CIRCUITS.md` marker blocks, while the nine `commands/*.md` files are maintained separately by hand. I would keep the clean marker-block generation model and extend it so both docs and command shims are generated from the same structured export list. (`scripts/runtime/engine/src/cli/catalog-compiler.ts:35-74`, `scripts/runtime/engine/src/cli/catalog-compiler.ts:93-103`, `scripts/runtime/engine/src/catalog/generate.ts:14-34`, `scripts/runtime/engine/src/catalog/generate.ts:37-69`, structural observation: `commands/` contains 9 shims named `build`, `explore`, `handoff`, `migrate`, `repair`, `review`, `run`, `sweep`, and `workers`)

One correction to the tournament brief: in this checkout `extract.ts` does infer classification from `circuit.yaml` presence, but `skills/workers/` has no `circuit.yaml`, so `workers` currently extracts as `kind: "utility"`, not `kind: "circuit"`. The real drift is package-level: `workers` still has a public command shim and `verify-install.sh` requires one for every skill directory, so it is forced onto the public slash-command surface anyway. (`scripts/runtime/engine/src/catalog/extract.ts:49-88`, structural observation: `skills/workers/` contains `SKILL.md` plus `references/*` and no `circuit.yaml`, `commands/workers.md:1-5`, `scripts/verify-install.sh:215-225`)

## Rationale

Package correctness is the right foundation here because the current failure mode is install drift, not graph execution drift. The shipped surface is defined implicitly by rsync rules in `sync-to-cache.sh`, by a directory walk in `verify-install.sh`, and by separate hand-authored command shims in `commands/`; none of those is an explicit package contract. (`scripts/sync-to-cache.sh:21-35`, `scripts/sync-to-cache.sh:46-91`, `scripts/verify-install.sh:190-229`, structural observation: `commands/` contains 9 one-command shim files)

That implicit package contract already creates semantic leakage. The architecture says utilities such as `review`, `handoff`, and `workers` are not workflow circuits, and it specifically describes `workers` as an adapter that parent circuits call rather than a companion domain skill. The type layer still only knows `circuit` and `utility`, so there is nowhere to record “adapter but not public,” and install verification compensates by demanding a command shim for every skill directory. (`ARCHITECTURE.md:41-43`, `ARCHITECTURE.md:497-503`, `ARCHITECTURE.md:583-585`, `ARCHITECTURE.md:870-883`, `scripts/runtime/engine/src/catalog/types.ts:6-27`, `scripts/verify-install.sh:215-225`)

An explicit shipped manifest prevents four concrete install-drift problems that the current code makes plausible. First, it prevents accidental public exposure of any new skill-like directory, because public export would be declared in `public`, not inferred from `skills/*` plus verifier pressure. Second, it prevents stale cache installs from carrying undeclared trees, because sync would prune against manifest roots instead of a fixed top-level allowlist. Third, it prevents docs and command inventory from drifting apart, because generated public surfaces would read one export list instead of mixing `extract()` output with manual `commands/*.md`. Fourth, it gives the installed verifier a precise byte contract instead of “whatever is under these directories right now.” (`scripts/verify-install.sh:193-225`, `scripts/sync-to-cache.sh:21-35`, `scripts/sync-to-cache.sh:55-91`, `scripts/runtime/engine/src/cli/catalog-compiler.ts:39-74`, `commands/build.md:1-5`, `commands/workers.md:1-5`)

The evidence also says this foundation can be added without fighting the codebase. `generate.ts` already exposes a generic “targets plus renderer” interface and a strict marker-block patcher, so the project has a clean place to derive public docs from structured data. The split verifier is also a natural fit because `verify-install.sh` already treats repo and installed cache as the same surface rooted at `PLUGIN_ROOT`; the missing piece is separating source-authoring checks from installed-package checks. (`scripts/runtime/engine/src/catalog/generate.ts:14-34`, `scripts/runtime/engine/src/catalog/generate.ts:37-69`, `scripts/verify-install.sh:2-4`, `scripts/verify-install.sh:23-30`)

## Tradeoffs

This proposal weakens authoring ergonomics on purpose. Today a contributor can largely add a directory under `skills/`, add a matching `commands/<name>.md`, and rely on directory scanning plus verifier rules to discover it. A shipped manifest makes packaging explicit, which is safer but adds one more authored file that must be updated correctly. (`scripts/runtime/engine/src/catalog/extract.ts:39-91`, `scripts/verify-install.sh:193-225`, `commands/build.md:1-5`)

It does not fully solve command identity. The current catalog and validator strongly encourage `dir === id` and `expert_command === /circuit:<id>`, so identity, directory layout, and slash alias are still entangled in runtime-adjacent code. My proposal separates exported alias from runtime unit identity at the package boundary, but deeper command identity cleanup would still be needed inside the catalog and validator layer if the tournament wants a complete semantic rename story. (`scripts/runtime/engine/src/catalog/catalog-validator.test.ts:62-87`, `scripts/runtime/engine/src/catalog/extract.ts:66-77`)

It is also unapologetically packaging-centric. It fixes the shipped surface, cache sync, command export, and installed verification story first, but it does not by itself solve prose-vs-YAML workflow parity or the broader execution-model semantics documented in `ARCHITECTURE.md`. That is why I see this as the right first move, not the whole redesign. (`ARCHITECTURE.md:31-39`, `ARCHITECTURE.md:651-669`, `scripts/runtime/engine/src/release-integrity.test.ts:633-768`)

There is one breaking-semantics risk to call out honestly: if `/circuit:workers` is still intentionally used as a direct debug entrypoint, making adapter export explicit would likely remove it from the default public command surface. I think that is the right default because the architecture already treats `workers` as an adapter, but it is still a behavior change. (`ARCHITECTURE.md:497-503`, `commands/workers.md:1-5`)

## Implementation Sketch

1. Add `.claude-plugin/shipped-surface.yaml` as the package contract. It should own `role`, shipped `roots`, and explicit `public` export, while `circuit.yaml` continues to own workflow topology and `SKILL.md` continues to own instructional prose and descriptive frontmatter. (`ARCHITECTURE.md:24-39`, `ARCHITECTURE.md:706-760`, `scripts/runtime/engine/src/catalog/extract.ts:46-77`, `scripts/runtime/engine/src/catalog/extract.ts:80-85`)

2. Add a new loader/validator pair under `scripts/runtime/engine/src/shipped-surface/` rather than bloating the current catalog union. The current `CatalogEntry` union is too narrow for adapter/public/package data, and I would rather keep `catalog/` focused on workflow metadata while a new shipping layer owns install semantics. (`scripts/runtime/engine/src/catalog/types.ts:6-27`)

3. Add a small CLI such as `scripts/runtime/bin/shipped-surface.js` with two modes:

```bash
node scripts/runtime/bin/shipped-surface.js verify --mode repo
node scripts/runtime/bin/shipped-surface.js verify --mode installed --root "$PLUGIN_ROOT"
```

`--mode repo` would check manifest parity against the checkout: every declared root exists, every public alias points at a declared unit, every workflow unit has `circuit.yaml`, every non-workflow public entry has a `SKILL.md`, and no generated command shim is stale. `--mode installed` would check only shipped bytes and executability/runtime behavior from the manifest roots. This is the split verifier. (`scripts/verify-install.sh:2-4`, `scripts/verify-install.sh:23-30`, `scripts/verify-install.sh:193-229`)

4. Update `scripts/sync-to-cache.sh` to call the helper and sync manifest-declared roots instead of hardcoded trees. The existing `prune_cache_target()` logic and per-target `rsync --delete` calls can stay, but the source of truth would become `shipped-surface.yaml`. (`scripts/sync-to-cache.sh:21-35`, `scripts/sync-to-cache.sh:46-91`)

5. Update `scripts/verify-install.sh` so the “command shims” section no longer walks `skills/*` and requires `commands/${skill}.md` for every directory. Instead it should load manifest `public` entries and verify only those declared aliases have installed shims. That is the key change that stops `workers` from being public by installer fiat. (`scripts/verify-install.sh:208-229`, `commands/workers.md:1-5`)

6. Generate `commands/` from the manifest. The relationship should be one-way: if `public.slash_aliases` contains `build`, generate `commands/build.md`; if `public` is `null`, generate nothing. The file body can keep the current tiny shim form:

```markdown
---
description: "<description from SKILL frontmatter>"
---

Use the circuit:<alias> skill to handle this request.
```

That preserves the current command shape while moving ownership of public export out of directory scanning. (`commands/build.md:1-5`, `commands/review.md:1-5`, `commands/workers.md:1-5`)

7. Keep the existing marker-block strategy for generated docs and extend it to the public surface compiler. `generate.ts` is already strict about missing markers and only writes changed files, so I would reuse that pattern for public command tables and any exported command inventory pages. (`scripts/runtime/engine/src/catalog/generate.ts:14-34`, `scripts/runtime/engine/src/catalog/generate.ts:37-69`)

8. Tests to change:
   - `scripts/runtime/engine/src/catalog/extract.test.ts`: stop treating directory shape as the public surface contract; keep only workflow/utility extraction or move package checks into the new `shipped-surface` tests. (`scripts/runtime/engine/src/catalog/extract.test.ts:85-187`)
   - `scripts/runtime/engine/src/catalog/catalog-validator.test.ts`: replace directory-derived public-surface assumptions with manifest-driven generated-surface checks. The current test suite validates `dir === id`, circuit-only generation, and orphan `/circuit:<slug>` references from the extracted catalog. (`scripts/runtime/engine/src/catalog/catalog-validator.test.ts:54-115`, `scripts/runtime/engine/src/catalog/catalog-validator.test.ts:132-235`)
   - `scripts/runtime/engine/src/runtime-cli-integration.test.ts`: copy the installed package from manifest roots and add installed-mode verifier cases for “public alias missing shim” versus “private adapter has no shim and still passes.” (`scripts/runtime/engine/src/runtime-cli-integration.test.ts:79-102`, `scripts/runtime/engine/src/runtime-cli-integration.test.ts:219-271`)
   - `scripts/runtime/engine/src/sync-to-cache.test.ts`: build synthetic plugin roots from a manifest fixture and assert undeclared files are not shipped while declared ones are synced. (`scripts/runtime/engine/src/sync-to-cache.test.ts:60-100`, `scripts/runtime/engine/src/sync-to-cache.test.ts:152-280`)
   - `scripts/runtime/engine/src/release-integrity.test.ts`: remove the public-surface regex scraping and replace it with manifest-structured checks plus generated-file freshness. The current helpers `getH2Section`, `getH3Section`, and `getArtifactTemplate` are exactly the kind of prose parsing the new kernel should avoid for package/public verification. (`scripts/runtime/engine/src/release-integrity.test.ts:35-91`, `scripts/runtime/engine/src/release-integrity.test.ts:498-515`, `scripts/runtime/engine/src/release-integrity.test.ts:961-997`)

## Kernel Invariant Compliance

1. **Every shipped unit has one semantic role.** The manifest gives each unit a single declared `role` such as `workflow`, `utility`, `adapter`, `hook`, or `runtime-cli-bundle`, which is the missing dimension in the current `CircuitEntry | UtilityEntry` union. That aligns the package model with the architecture’s existing distinction between workflows, utilities, and the `workers` adapter. (`scripts/runtime/engine/src/catalog/types.ts:6-27`, `ARCHITECTURE.md:41-43`, `ARCHITECTURE.md:497-503`, `ARCHITECTURE.md:870-883`)

2. **Runtime unit identity != slash-command alias.** The manifest separates `id` from `public.slash_aliases`, so exported slash commands become explicit mappings instead of identity-by-directory. That is cleaner than today’s implicit coupling among directory name, `circuit.id`, `expert_command`, and `commands/<name>.md`. (`scripts/runtime/engine/src/catalog/extract.ts:66-77`, `scripts/runtime/engine/src/catalog/catalog-validator.test.ts:62-87`, `commands/build.md:1-5`)

3. **Every fact class has one owner.** Workflow topology remains owned by `circuit.yaml`; instructional prose and descriptions remain owned by `SKILL.md`; packaging, export, and shipped roots are owned by `shipped-surface.yaml`. The current extractor already demonstrates that topology and prose come from different authored files, so the proposal keeps that split and adds a third owner for package facts instead of mirroring them. (`scripts/runtime/engine/src/catalog/extract.ts:46-77`, `scripts/runtime/engine/src/catalog/extract.ts:80-85`, `ARCHITECTURE.md:24-39`)

4. **Mirror fields forbidden.** Command shims become generated outputs from the manifest export list plus `SKILL.md` description, not independently authored mirrors of package intent. That is an improvement over the current state, where public export is duplicated across `commands/*.md`, directory layout, and verifier rules. (`commands/build.md:1-5`, `commands/review.md:1-5`, `commands/workers.md:1-5`, `scripts/verify-install.sh:215-225`)

5. **Publicness never inferred from directory.** This is the core win. Today `verify-install.sh` infers publicness from “is there a directory under `skills/`?” and then demands a command shim. Under the proposal, only manifest `public` entries are exported; `skills/workers/` can exist without being public, and the same rule works for any future adapter/helper. (`scripts/verify-install.sh:193-225`, structural observation: `skills/workers/` exists without `circuit.yaml`)

6. **Repo/installed verification separate.** The new helper runs in two modes. Repo verification checks authored parity and generated outputs; installed verification checks shipped bytes and runtime behavior rooted at `PLUGIN_ROOT`. That replaces the current one-script-two-context model. (`scripts/verify-install.sh:2-4`, `scripts/verify-install.sh:23-30`, `scripts/runtime/engine/src/runtime-cli-integration.test.ts:79-102`)

7. **No test parses prose.** The proposal removes public/package verification from regexes over markdown prose and moves it to structured manifest checks and generated-file freshness. The current release-integrity suite parses headings, fenced templates, and command mentions out of prose-heavy files; those checks would be replaced by structured manifest assertions. (`scripts/runtime/engine/src/release-integrity.test.ts:35-91`, `scripts/runtime/engine/src/release-integrity.test.ts:109-128`, `scripts/runtime/engine/src/release-integrity.test.ts:961-997`)

8. **`workers` needs no bespoke exception.** `workers` becomes an ordinary manifest entry with `role: adapter` and `public: null`. No name-based escape hatch is required because the export rule is generic: only declared public entries get shims and slash aliases. That is better aligned with the architecture’s own description of `workers` as an adapter. (`ARCHITECTURE.md:497-503`, `ARCHITECTURE.md:583-585`, `commands/workers.md:1-5`, `scripts/verify-install.sh:215-225`)
