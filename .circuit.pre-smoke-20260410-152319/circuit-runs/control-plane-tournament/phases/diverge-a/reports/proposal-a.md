## Approach

Create one machine-owned command registry at `commands/registry.yaml`, and make it the only owner of slash-command identity and visibility. Today the shared catalog type still mixes runtime-unit facts with command facts: `CircuitEntry` carries both `entryCommand` and `expertCommand`, while the only discriminator in the shared contract is `kind: "circuit"` vs `kind: "utility"` (`scripts/runtime/engine/src/catalog/types.ts:6-27`). The runtime topology should keep coming from `circuit.yaml` and `SKILL.md`; the command surface should move into a separate registry.

Quoted evidence from the current type contract:

> `export interface CircuitEntry {`  
> `  kind: "circuit";`  
> `  ...`  
> `  entryCommand: string | undefined;`  
> `  expertCommand: string;`  
> `}`  
> `export interface UtilityEntry {`  
> `  kind: "utility";`  
> `  ...`  
> `}`  
> (`scripts/runtime/engine/src/catalog/types.ts:6-25`)

Proposed registry schema:

```yaml
schema_version: "1"

units:
  run:
    role: router
  build:
    role: workflow
  explore:
    role: workflow
  repair:
    role: workflow
  migrate:
    role: workflow
  sweep:
    role: workflow
  review:
    role: lifecycle
  handoff:
    role: lifecycle
  workers:
    role: adapter

commands:
  run:
    target: run
    alias: /circuit:run
    visibility: public
    task_arg: required
  build:
    target: build
    alias: /circuit:build
    visibility: public
    task_arg: forbidden
  explore:
    target: explore
    alias: /circuit:explore
    visibility: public
    task_arg: forbidden
  repair:
    target: repair
    alias: /circuit:repair
    visibility: public
    task_arg: forbidden
  migrate:
    target: migrate
    alias: /circuit:migrate
    visibility: public
    task_arg: forbidden
  sweep:
    target: sweep
    alias: /circuit:sweep
    visibility: public
    task_arg: forbidden
  review:
    target: review
    alias: /circuit:review
    visibility: public
    task_arg: forbidden
  handoff:
    target: handoff
    alias: /circuit:handoff
    visibility: public
    task_arg: forbidden
```

How it connects to the existing catalog/compiler:

1. `extract.ts` keeps owning filesystem/runtime facts. It already walks `skills/*`, reads `SKILL.md`, and branches only on `exists(circuitYamlPath)` (`scripts/runtime/engine/src/catalog/extract.ts:42-88`). That is the right place to keep `id`, `dir`, `version`, `purpose`, and `entryModes`, but it should stop copying slash-command aliases out of manifests.
2. A new registry loader can reuse the existing YAML dependency already imported by the catalog code (`import { parse as parseYaml } from "yaml";` in `scripts/runtime/engine/src/catalog/extract.ts:6-8`).
3. `catalog-compiler.ts` already centralizes rendered outputs behind `renderCircuitTable`, `renderEntryModes`, and `getTargets()` (`scripts/runtime/engine/src/cli/catalog-compiler.ts:39-74`). The minimal change is to load the registry, join on `id`, and render command-facing docs from the join.
4. `generate.ts` should stay exactly what it is: a small marker-block patcher with `GenerateTarget[]` and `patchBlock()` (`scripts/runtime/engine/src/catalog/generate.ts:14-35`, `scripts/runtime/engine/src/catalog/generate.ts:37-69`). I would add a tiny sibling emitter for generated `commands/*.md`; I would not replace the block patcher.

Visibility becomes explicit registry data, not a side effect of directory layout. Today `verify-install.sh` loops every `skills/*` directory and fails unless `commands/<skill>.md` exists:

> `while IFS= read -r -d '' skill_dir; do`  
> `  skill="$(basename "$skill_dir")"`  
> `  if [[ -f "$commands_dir/${skill}.md" ]]; then`  
> `    shim_count=$((shim_count + 1))`  
> `  else`  
> `    fail "skill $skill/ has no matching command shim at commands/${skill}.md"`  
> `    shim_missing=$((shim_missing + 1))`  
> `  fi`  
> `done < <(find "$PLUGIN_ROOT/skills" -mindepth 1 -maxdepth 1 -type d -print0 | sort -z)`  
> (`scripts/verify-install.sh:215-223`)

Under the registry model, only `commands.*.visibility == public` produce a shim, appear in the slash-picker surface, and count in installed verification.

## Rationale

This is the best targeted fix because the break keeps happening at one seam: command identity is currently smeared across manifests, extracted catalog types, generated docs, command shim files, and install verification.

The strongest evidence is that the repo already knows `workers` is an adapter-like utility, but the shipped command surface still treats it like a public command. `ARCHITECTURE.md` says:

> `Utilities are intentionally different. review, handoff, and workers ship`  
> `as utility skills without circuit.yaml; they are lifecycle or adapter helpers,`  
> `not workflows the runtime engine classifies as circuits.`  
> (`ARCHITECTURE.md:41-43`)

and later:

> `The workers skill is not a circuit. It is an adapter.`  
> (`ARCHITECTURE.md:499-501`)

I need to call out one prompt mismatch explicitly: I did **not** find evidence that `workers` is currently extracted as `kind: "circuit"`. The extractor branches on `exists(circuitYamlPath)` and emits `kind: "utility"` when the manifest is absent (`scripts/runtime/engine/src/catalog/extract.ts:49-88`), and the checked-in architecture layout lists `circuit.yaml` only under `run`, `explore`, `build`, `repair`, `migrate`, and `sweep`, while `workers/` is listed with `SKILL.md` plus `references/` only (`ARCHITECTURE.md:851-883`). The actual seam is not extractor misclassification; it is public-surface leakage.

That leakage is visible in three places:

1. `verify-install.sh` forces one command shim per skill directory (`scripts/verify-install.sh:208-229`).
2. `sync-to-cache.sh` ships the whole `commands/` directory to cache if it exists (`scripts/sync-to-cache.sh:64-70`), and its cache-prune logic keeps `commands` alongside `.claude-plugin`, `hooks`, `schemas`, `scripts`, and `skills` as part of the installed shape (`scripts/sync-to-cache.sh:26-34`).
3. There is a real `commands/workers.md`, even though public docs do not present `workers` as a user-facing utility. `CIRCUITS.md` documents only `Review` and `Handoff` under Utilities (`CIRCUITS.md:23-28`), while `commands/workers.md` still exists and is the same boilerplate form as the other shims:

> `---`  
> `description: "Autonomous batch orchestrator for dispatching workers."`  
> `---`  
> `Use the circuit:workers skill to handle this request.`  
> (`commands/workers.md:1-5`)

The command shims are almost pure duplication. I counted nine current shim files: `commands/build.md`, `commands/explore.md`, `commands/handoff.md`, `commands/migrate.md`, `commands/repair.md`, `commands/review.md`, `commands/run.md`, `commands/sweep.md`, and `commands/workers.md`. Their contents are all the same structural pattern: frontmatter `description` plus one imperative line. For example:

> `description: "Build features, scoped refactors, docs, tests, or mixed changes."`  
> `Use the circuit:build skill to handle this request.`  
> (`commands/build.md:2-5`)

and

> `description: "The primary Circuit router."`  
> `Use the circuit:run skill to handle this request.`  
> (`commands/run.md:2-5`)

That is exactly the kind of low-value, high-churn mirror a registry should own.

The existing compiler path is already a good host for this fix. `catalog-compiler.ts` is the central place that turns the extracted catalog into the generated `CIRCUITS.md` blocks (`scripts/runtime/engine/src/cli/catalog-compiler.ts:39-103`), and `generate.ts` is intentionally tiny and generic (`scripts/runtime/engine/src/catalog/generate.ts:14-35`, `scripts/runtime/engine/src/catalog/generate.ts:37-69`). This proposal reuses that seam instead of inventing a new pipeline.

Finally, the current tests prove the docs/prose coupling is real. `release-integrity.test.ts` parses generated docs and freeform prose to recover machine facts:

> `const circuitsModes = [...getH3Section(readFile("CIRCUITS.md"), heading, "## Entry Modes").matchAll(/^- ([a-z]+)$/gm)]`  
> (`scripts/runtime/engine/src/release-integrity.test.ts:593-598`)

> `expect(yaml.circuit.entry_modes.lite.description).toMatch(/no independent review/i);`  
> `expect(reviewSection).toMatch(/\*\*Skipped at Lite rigor\.\*\*/);`  
> (`scripts/runtime/engine/src/release-integrity.test.ts:640-644`)

> `const documented = [...new Set([...readme.matchAll(/\/circuit:(\w+)/g)].map((m) => m[1]))];`  
> `const commandPath = resolve(REPO_ROOT, \`commands/${command}.md\`);`  
> (`scripts/runtime/engine/src/release-integrity.test.ts:964-975`)

That is why my recommendation is registry first, verifier split second, and docs never treated as the owner of machine truth.

## Tradeoffs

This does **not** solve all `SKILL.md`/`circuit.yaml` drift. The repo has a broader prose-parity culture today, especially in `release-integrity.test.ts:633-767`, where entry-mode descriptions are matched against phase prose. My proposal intentionally narrows the blast radius to command identity and public surface. If the project still wants documentation-quality tests, those should become non-authoritative checks over explicit blocks or templates, not regexes over prose.

It adds one more source file and one join step. That is real complexity. The reason I still think it wins is that it removes a larger mesh of duplicated command facts: `entry.command`, `expert_command`, `entryCommand`, `expertCommand`, `commands/*.md`, README/CIRCUITS command inventory tests, and install-time “every skill must be public” logic.

It is a schema break. `schemas/circuit-manifest.schema.json` currently allows both `"command"` and `"expert_command"` in `$defs.entry.properties` (`schemas/circuit-manifest.schema.json:45-52`), and the six workflow manifests I read each carry `expert_command` (`skills/build/circuit.yaml:8-12`, `skills/explore/circuit.yaml:8-12`, `skills/migrate/circuit.yaml:9-13`, `skills/repair/circuit.yaml:9-13`, `skills/run/circuit.yaml:10-13`, `skills/sweep/circuit.yaml:9-13`). `run` is the one that also carries `command` today (`skills/run/circuit.yaml:10-13`). Removing those fields will touch six workflow manifests plus the schema and tests.

Generated shims become less hand-editable. I think that is fine because they are already boilerplate. If later a command shim really needs custom prose, the registry can grow a small `shim_body` override, but I would not add that on day one.

## Implementation Sketch

### New files

- `commands/registry.yaml`
  - Owns `units.<id>.role` and `commands.<id>.(target, alias, visibility, task_arg)`.
- `schemas/command-registry.schema.json`
  - Validates the registry independently of workflow manifests.
- `scripts/runtime/engine/src/catalog/load-command-registry.ts`
  - Reads and validates `commands/registry.yaml`.
- `scripts/runtime/engine/src/catalog/load-command-registry.test.ts`
  - Covers registry parsing and join invariants.

### Modified files

- `scripts/runtime/engine/src/catalog/types.ts`
  - Remove `entryCommand` and `expertCommand` from `CircuitEntry`.
  - Keep the extracted catalog about runtime units only; do **not** add `visibility` here, because publicness is a registry fact, not a filesystem fact.
- `scripts/runtime/engine/src/catalog/extract.ts`
  - Stop reading `circuit.entry?.command` and `circuit.entry?.expert_command`.
  - Keep the current `exists(circuitYamlPath)` branch, because it is the right discriminator for runtime topology (`scripts/runtime/engine/src/catalog/extract.ts:49-88`).
- `scripts/runtime/engine/src/cli/catalog-compiler.ts`
  - Load `commands/registry.yaml`.
  - Join registry + extracted catalog by `id`.
  - Render `CIRCUITS.md` from the join.
  - Emit generated `commands/<public-id>.md` files from the registry.
- `schemas/circuit-manifest.schema.json`
  - Remove `command` and `expert_command` from `$defs.entry.properties` (`schemas/circuit-manifest.schema.json:45-52` today).
- `skills/build/circuit.yaml`, `skills/explore/circuit.yaml`, `skills/migrate/circuit.yaml`, `skills/repair/circuit.yaml`, `skills/run/circuit.yaml`, `skills/sweep/circuit.yaml`
  - Delete `entry.command` / `entry.expert_command`.
  - Keep only routing signals and topology under `entry` / `entry_modes` / `steps`.
- `scripts/verify-install.sh`
  - Split into `--mode repo`, `--mode installed`, and `--mode auto`.

### Deleted files

- `commands/workers.md`
  - `workers` is a shipped unit with `role: adapter`, but no public command.

### Command registry schema details

The important part is what the registry does **not** store:

- It does not store `dir`; `extract.ts` already owns that (`scripts/runtime/engine/src/catalog/extract.ts:66-77`, `scripts/runtime/engine/src/catalog/extract.ts:80-86`).
- It does not store `purpose` or a second description string; circuits already have `purpose` in `circuit.yaml` (`skills/build/circuit.yaml:3-6` is representative), and utilities already have `skillDescription` from SKILL frontmatter (`scripts/runtime/engine/src/catalog/extract.ts:75-76`, `scripts/runtime/engine/src/catalog/extract.ts:84-85`).
- It does not store `entry_modes`; the manifest already owns those (`skills/explore/circuit.yaml:14-29`, `skills/sweep/circuit.yaml:15-27`, etc.).

That keeps the registry focused on the seam that keeps breaking: semantic role plus public command identity.

### `verify-install.sh` split into two modes

`repo` mode:

- Validate `commands/registry.yaml` against `schemas/command-registry.schema.json`.
- Validate every `units.<id>` and `commands.*.target` resolves to an extracted catalog entry.
- Validate generated `commands/*.md` files are fresh relative to the registry.
- Optionally validate generated marker blocks such as `CIRCUITS.md` are fresh, but only as leaf outputs from the generator, never as the source of truth.
- Do **not** parse README, `CIRCUITS.md`, `ARCHITECTURE.md`, or `SKILL.md` prose to recover command facts.

`installed` mode:

- Validate only shipped artifacts. The cache shape is already implicitly defined by `sync-to-cache.sh`:

> `case "$name" in`  
> `  .claude-plugin|commands|hooks|schemas|scripts|skills) ;;`  
> `  *) rm -rf "$path" ;;`  
> (`scripts/sync-to-cache.sh:28-33`)

and the actual sync copies those directories, including `commands/` if present (`scripts/sync-to-cache.sh:55-90`).

- Require command shims only for `visibility: public` entries in the registry.
- Ignore docs entirely, because the installed cache does not ship them. The test suite already codifies the six-entry cache layout:

> `expect((await readdir(target)).sort()).toEqual([`  
> `  ".claude-plugin",`  
> `  "commands",`  
> `  "hooks",`  
> `  "schemas",`  
> `  "scripts",`  
> `  "skills",`  
> `]);`  
> (`scripts/runtime/engine/src/sync-to-cache.test.ts:184-191`)

This directly fixes the current false coupling in `verify-install.sh:215-229`.

### Test assertions that change

- `scripts/runtime/engine/src/catalog/extract.test.ts`
  - Remove the expectations for `entryCommand` and `expertCommand` at `scripts/runtime/engine/src/catalog/extract.test.ts:100-101` and `scripts/runtime/engine/src/catalog/extract.test.ts:183-184`.
  - Replace them with assertions that extraction returns only runtime facts, and add a separate registry-loader test for alias/visibility.
- `scripts/runtime/engine/src/catalog/generate.test.ts`
  - Remove the sample `entryCommand` / `expertCommand` fields from fixture catalog entries at `scripts/runtime/engine/src/catalog/generate.test.ts:12-13` and `scripts/runtime/engine/src/catalog/generate.test.ts:24-25`.
  - Keep the marker-block tests; they are still the right unit test for `generate.ts`.
- `scripts/runtime/engine/src/catalog/catalog-validator.test.ts`
  - Replace the `expert_command matches /circuit:<id>` invariant at `scripts/runtime/engine/src/catalog/catalog-validator.test.ts:79-87` with registry invariants:
    - every registry command target exists in the extracted catalog
    - every `visibility: public` command has a generated shim
    - no generated public shim exists without a registry entry
- `scripts/runtime/engine/src/release-integrity.test.ts`
  - Delete or rewrite the prose-parsing command-surface tests at `scripts/runtime/engine/src/release-integrity.test.ts:579-600` and `scripts/runtime/engine/src/release-integrity.test.ts:960-996`.
  - Delete or demote the entry-mode/prose regex tests at `scripts/runtime/engine/src/release-integrity.test.ts:633-767` if invariant (7) is meant literally.

### What happens to `entryCommand` / `expertCommand`

They go away entirely.

Today they exist in three layers:

1. manifest schema (`schemas/circuit-manifest.schema.json:45-52`)
2. extracted catalog type (`scripts/runtime/engine/src/catalog/types.ts:6-17`)
3. renderer logic (`scripts/runtime/engine/src/cli/catalog-compiler.ts:43-47`)

That is the wrong direction of dependency. After this change:

- runtime unit identity stays `id`
- slash-command alias lives only in `commands/registry.yaml`
- “takes `<task>` inline” lives only in `commands/registry.yaml`

For `run`, the current dual identity collapses into one alias record. For every other workflow, nothing user-facing changes except that the alias comes from the registry instead of the manifest.

## Kernel Invariant Compliance

### (1) Every shipped unit has one semantic role

The registry gives every unit exactly one `role`: `workflow`, `router`, `lifecycle`, or `adapter`. That closes the gap left by the current shared catalog contract, which only distinguishes `kind: "circuit"` and `kind: "utility"` (`scripts/runtime/engine/src/catalog/types.ts:6-27`), even though `ARCHITECTURE.md` already relies on stronger semantic distinctions such as router (`ARCHITECTURE.md:541-560`), lifecycle utility (`ARCHITECTURE.md:613-619`), and adapter (`ARCHITECTURE.md:497-501`).

### (2) Runtime unit identity != slash-command alias

`id` stays the runtime/unit key from the extractor. The slash alias moves to `commands/registry.yaml`. That removes the current conflation where command identity is copied into the extracted catalog via `entryCommand` / `expertCommand` (`scripts/runtime/engine/src/catalog/extract.ts:72-74`) and then re-rendered as “Invoke” text (`scripts/runtime/engine/src/cli/catalog-compiler.ts:43-47`).

### (3) Every fact class has one owner

After the split:

- workflow topology, signals, entry modes, and purpose: `circuit.yaml`
- utility descriptive frontmatter: `SKILL.md`
- extracted filesystem catalog: `extract.ts`
- semantic role + slash-command visibility/alias/task-arg: `commands/registry.yaml`
- generated shims and generated doc blocks: compiler outputs only
- installed surface shape: `sync-to-cache.sh`
- repo/install verification policy: `verify-install.sh`

That is cleaner than the current state where command identity is spread across manifests, extracted types, shim files, and docs/tests.

### (4) Mirror fields forbidden

This proposal removes the mirrored command fields from both manifests and extracted catalog types. It also keeps descriptions derived instead of duplicated: workflow command descriptions can come from manifest `purpose` (`skills/build/circuit.yaml:3-6` is representative), and utility command descriptions can come from SKILL frontmatter via `skillDescription` (`scripts/runtime/engine/src/catalog/extract.ts:75-76`, `scripts/runtime/engine/src/catalog/extract.ts:84-85`). The registry only owns facts that cannot already be derived elsewhere.

### (5) Publicness never inferred from directory

Current publicness is inferred from `find "$PLUGIN_ROOT/skills"` in `verify-install.sh:215-223`. After the change, publicness is read only from registry command entries. A skill directory can exist without implying a public slash command. That is exactly the missing distinction that lets `workers` stay shipped but non-public.

### (6) Repo/installed verification separate

Current `verify-install.sh` claims to support both repo and installed paths (`scripts/verify-install.sh:2-4`), but it still mixes source-surface and installed-surface assumptions. Splitting repo vs installed mode aligns verification with the cache shape that `sync-to-cache.sh` actually ships (`scripts/sync-to-cache.sh:26-34`, `scripts/sync-to-cache.sh:55-90`) and avoids treating missing docs or non-public shims as install failures.

### (7) No test parses prose

This proposal explicitly stops using prose as machine truth. The current repo has multiple violations, including regex extraction from `CIRCUITS.md` (`scripts/runtime/engine/src/release-integrity.test.ts:593-598`), README command scraping (`scripts/runtime/engine/src/release-integrity.test.ts:964-975`), and SKILL prose parity regexes (`scripts/runtime/engine/src/release-integrity.test.ts:640-686`, `scripts/runtime/engine/src/release-integrity.test.ts:745-765`). Those tests should be deleted, rewritten against explicit registry/schema data, or downgraded to non-authoritative doc-lint.

### (8) workers needs no bespoke exception

`workers` becomes boring again: `units.workers.role = adapter`, no public command entry, no generated public shim, no docs presence requirement, and no install-time exception branch. That matches the architecture docs that already describe it as an adapter utility (`ARCHITECTURE.md:41-43`, `ARCHITECTURE.md:497-501`) and fixes the real seam without adding a `if skill == workers` rule anywhere.
