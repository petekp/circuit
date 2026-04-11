# Proposal B: Durable Kernel

## Approach
Keep the current `extract -> generate` compiler spine and strengthen the model that flows through it. The extractor is already a small deterministic scanner over `SKILL.md` + `circuit.yaml`, and the generator is already a clean marker-block patcher; the weak point is the IR, not the pipeline (`scripts/runtime/engine/src/catalog/extract.ts:30-91`; `scripts/runtime/engine/src/catalog/generate.ts:14-69`).

Use a normalized `KernelIR` whose unit identity is semantic, not slash-command-shaped:

```ts
export type KernelRole = "router" | "workflow" | "adapter" | "lifecycle";
export type KernelVisibility = "public" | "internal";

export interface KernelIR {
  schemaVersion: 1;
  units: KernelUnit[];
}

export interface KernelUnit {
  id: string; // semantic identity
  role: KernelRole;
  visibility: KernelVisibility;
  source: "circuit.yaml" | "skill-frontmatter";
  skill: {
    dir: string;
    file: string;
    name: string;
    description: string;
  };
  surface: {
    aliases: Array<{
      slash: string;
      acceptsTask: boolean;
      origin: "manifest" | "frontmatter" | "legacy-normalized";
    }>;
    commandShimPath?: string;
  };
  runtime: WorkflowRuntime | SkillRuntime;
}

export interface WorkflowRuntime {
  kind: "workflow";
  manifestPath: string;
  version: string;
  purpose: string;
  signals: { include: string[]; exclude: string[] };
  entryModes: Array<{ name: string; startAt: string; description: string }>;
  steps: Array<{
    id: string;
    executor: "orchestrator" | "worker";
    kind: "checkpoint" | "synthesis" | "dispatch";
    protocol?: string;
    writes: string[];
    gateKind?: string;
    routes: string[];
  }>;
}

export interface SkillRuntime {
  kind: "skill";
}
```

Normalize workflow manifests into that IR directly:

| Source | Normalized role | Normalized aliases | Runtime payload |
|---|---|---|---|
| `skills/run/circuit.yaml` | `router` | `/circuit:run` | `version`, `purpose`, `signals`, `entryModes`, `steps` from manifest (`skills/run/circuit.yaml:2-38`) |
| `skills/build/circuit.yaml` | `workflow` | `/circuit:build` | same shape, with step graph and gates (`skills/build/circuit.yaml:2-145`) |
| `skills/explore/circuit.yaml` | `workflow` | `/circuit:explore` | includes `tournament` entry mode and multi-artifact decide step (`skills/explore/circuit.yaml:2-111`) |

Normalize non-workflows from `SKILL.md` frontmatter, because the extractor already parses that file for every skill before deciding how to classify the entry (`scripts/runtime/engine/src/catalog/extract.ts:42-47`). Today that frontmatter only contributes `name` and `description` (`scripts/runtime/engine/src/catalog/extract.ts:75-76`, `scripts/runtime/engine/src/catalog/extract.ts:84-85`), but the same mechanism can carry explicit role/publicness metadata for skill-only units:

```yaml
---
name: workers
description: >
  Autonomous batch orchestrator for dispatching workers.
role: adapter
visibility: public
aliases:
  - /circuit:workers
---
```

That gives `review`, `handoff`, and `workers` explicit metadata without inventing another registry file, and it matches the current reality that they are already skill-first surfaces with no `circuit.yaml` (`skills/review/SKILL.md:1-9`; `skills/handoff/SKILL.md:1-9`; `skills/workers/SKILL.md:1-7`; `ARCHITECTURE.md:41-43`).

Generate four projections from `KernelIR`:

1. `CIRCUITS.md` generated blocks for workflow quick reference, utility/adapter quick reference, and entry modes. Right now only the workflow table and entry-mode block are generated, while the utilities block is hand-maintained (`scripts/runtime/engine/src/cli/catalog-compiler.ts:39-74`; `CIRCUITS.md:11-29`; `CIRCUITS.md:37-77`).
2. `commands/*.md` shims for every `visibility: public` unit. Today those are nine separate manual files with identical structure (`commands/build.md:1-5`; `commands/explore.md:1-5`; `commands/handoff.md:1-5`; `commands/migrate.md:1-5`; `commands/repair.md:1-5`; `commands/review.md:1-5`; `commands/run.md:1-5`; `commands/sweep.md:1-5`; `commands/workers.md:1-5`).
3. `.claude-plugin/shipped-surface.json`, a generated install contract.
4. `kernel-ir.json` as a machine-readable debug/test artifact so integrity tests stop regex-parsing prose.

Use a shipped-surface manifest as the installation contract:

```ts
export interface ShippedSurfaceManifest {
  schemaVersion: 1;
  pluginName: string;
  requiredRoots: string[];   // .claude-plugin, commands, hooks, schemas, scripts, skills
  files: {
    required: string[];      // exact shipped files
    executable: string[];    // subset that must be +x
  };
  units: Array<{
    id: string;
    role: KernelRole;
    visibility: KernelVisibility;
    skillDir: string;
    skillFile: string;
    aliases: string[];
    commandShim?: string;
    shippedFiles: string[];
  }>;
}
```

That manifest becomes the sole install-surface contract. `sync-to-cache.sh` and install verification both consume it instead of re-encoding the shipped shape in shell conditionals (`scripts/sync-to-cache.sh:26-34`; `scripts/sync-to-cache.sh:55-89`).

## Rationale
This is the durable architecture because it preserves the healthy parts of the current system and moves only the unstable facts into structure.

The healthy part is the compiler pipeline itself. `extract.ts` is already a deterministic filesystem-to-object pass, and `generate.ts` is already a deterministic object-to-projection pass with fail-loud marker handling (`scripts/runtime/engine/src/catalog/extract.ts:30-91`; `scripts/runtime/engine/src/catalog/generate.ts:37-69`). `catalog-validator.test.ts` already treats that pair as the freshness boundary for generated docs (`scripts/runtime/engine/src/catalog/catalog-validator.test.ts:37-49`; `scripts/runtime/engine/src/catalog/catalog-validator.test.ts:90-115`). Replacing that pipeline would throw away working machinery to fix the wrong problem.

The unhealthy part is semantic collapse. The current catalog types only encode `"circuit"` and `"utility"` (`scripts/runtime/engine/src/catalog/types.ts:6-27`). That is already weaker than the architecture docs, which explicitly say `workers` is "not a circuit" and "an adapter" (`ARCHITECTURE.md:497-500`) while also calling `review`, `handoff`, and `workers` utility skills without `circuit.yaml` (`ARCHITECTURE.md:41-43`). I did not reproduce the prompt's claim that `workers` is currently extracted as a circuit; in this checkout it is extracted as a utility (`scripts/runtime/engine/src/catalog/extract.ts:79-87`; `scripts/runtime/engine/src/catalog/extract.test.ts:108-121`). The real bug is still semantic: adapter and lifecycle surfaces are being collapsed into a single utility bucket.

The current surface contract is also split across multiple owners. Slash-command identity is duplicated as `entryCommand` and `expertCommand` in the type and extractor (`scripts/runtime/engine/src/catalog/types.ts:12-13`; `scripts/runtime/engine/src/catalog/extract.ts:72-73`), then reinterpreted again in doc rendering (`scripts/runtime/engine/src/cli/catalog-compiler.ts:43-47`; `scripts/runtime/engine/src/catalog/catalog-validator.test.ts:18-24`). Publicness is inferred from the existence of a skill directory by `verify-install.sh`, which demands a command shim for every skill directory (`scripts/verify-install.sh:190-229`). Shipped shape is owned implicitly by `sync-to-cache.sh`, which prunes the cache down to six root directories and rsyncs those same directories manually (`scripts/sync-to-cache.sh:26-34`; `scripts/sync-to-cache.sh:55-89`). Simpler fixes like "add one more enum member" do not solve that ownership problem.

This design enables things the current shape cannot do cleanly:

- Internal skill-only helpers can exist without accidentally becoming public slash commands, because visibility becomes explicit rather than directory-derived (`scripts/verify-install.sh:215-223` is the current source of accidental publicness).
- Adapters, routers, workflows, and lifecycle utilities get different semantic roles without bespoke exceptions, which matters because the architecture already treats them differently (`ARCHITECTURE.md:41-43`; `ARCHITECTURE.md:497-500`; `ARCHITECTURE.md:591-619`).
- Install verification can validate exactly what ships instead of heuristically rediscovering the surface from the repo tree. The current cache shape is already being asserted in tests, but only indirectly through shell behavior (`scripts/runtime/engine/src/sync-to-cache.test.ts:183-191`).
- Tests can move off prose scraping. Right now `release-integrity.test.ts` and `lifecycle-regressions.test.ts` contain a large amount of markdown-section and line-pattern parsing over docs and SKILL prose (`scripts/runtime/engine/src/release-integrity.test.ts:35-91`; `scripts/runtime/engine/src/release-integrity.test.ts:109-138`; `scripts/runtime/engine/src/release-integrity.test.ts:633-767`; `scripts/runtime/engine/src/lifecycle-regressions.test.ts:45-78`; `scripts/runtime/engine/src/lifecycle-regressions.test.ts:307-348`). A stronger IR gives those tests a machine-readable target.

## Tradeoffs
- Overbuilding risk is real. Today the catalog layer is extremely small: one 32-line type file, a 92-line extractor, and a 69-line generator (`scripts/runtime/engine/src/catalog/types.ts:6-37`; `scripts/runtime/engine/src/catalog/extract.ts:30-91`; `scripts/runtime/engine/src/catalog/generate.ts:14-69`). Adding role/visibility/manifest projections can turn a tidy compiler into a mini release system if the scope is not controlled.
- Schema versioning becomes a first-class responsibility. Once `.claude-plugin/shipped-surface.json` exists and install verification depends on it, alias or file-layout changes become schema migrations rather than casual edits. That is the right kind of strictness, but it is still operational overhead.
- Migration will touch more than the catalog code. A lot of current integrity coverage is written against markdown prose and generated docs, not machine-owned data (`scripts/runtime/engine/src/release-integrity.test.ts:242-260`; `scripts/runtime/engine/src/release-integrity.test.ts:579-601`; `scripts/runtime/engine/src/release-integrity.test.ts:737-767`; `scripts/runtime/engine/src/lifecycle-regressions.test.ts:105-145`; `scripts/runtime/engine/src/lifecycle-regressions.test.ts:149-199`). Moving to IR-owned invariants means rewriting tests, not just changing `types.ts`.
- There will be a short migration window where the extractor has to normalize legacy workflow fields (`entry.command`, `entry.expert_command`) into `surface.aliases[]` before those manifest fields can be deleted (`skills/run/circuit.yaml:10-13`; `scripts/runtime/engine/src/catalog/extract.ts:72-73`). I would keep that bridge short-lived and remove it quickly.

## Implementation Sketch
Concrete file changes:

1. `scripts/runtime/engine/src/catalog/types.ts`
Replace `CircuitEntry | UtilityEntry` with `KernelIR` and `KernelUnit`; delete `entryCommand` and `expertCommand`; add `role`, `visibility`, and `surface.aliases[]`. The current file is exactly where extractor/generator share their contract today (`scripts/runtime/engine/src/catalog/types.ts:1-37`).

2. `scripts/runtime/engine/src/catalog/extract.ts`
Keep the scan shape, but normalize into `KernelUnit` instead of `{kind: "circuit" | "utility"}`. Workflows still come from `circuit.yaml`; skill-only units come from frontmatter. During migration, normalize old workflow command fields into aliases and dedupe identical aliases:

```ts
function normalizeLegacyAliases(circuit: any): KernelUnit["surface"]["aliases"] {
  const aliases = [
    ...(circuit.entry?.command
      ? [{ slash: circuit.entry.command, acceptsTask: true, origin: "legacy-normalized" as const }]
      : []),
    ...(circuit.entry?.expert_command
      ? [{ slash: circuit.entry.expert_command, acceptsTask: false, origin: "legacy-normalized" as const }]
      : []),
  ];

  return aliases.filter(
    (alias, index) =>
      aliases.findIndex((candidate) => candidate.slash === alias.slash) === index,
  );
}
```

This keeps the current extractor architecture intact while removing mirrored command identity from the shared IR (`scripts/runtime/engine/src/catalog/extract.ts:49-78`).

3. `scripts/runtime/engine/src/cli/catalog-compiler.ts`
Keep the existing `generate` and `catalog` behavior as one projection path, but add:

- `kernel` or `ir` to emit normalized `KernelIR`
- `surface` to emit `.claude-plugin/shipped-surface.json`
- `generate-shims` to materialize `commands/*.md`

The current CLI already owns projection rendering for `CIRCUITS.md`, so this is the natural place to add more projections (`scripts/runtime/engine/src/cli/catalog-compiler.ts:39-117`).

4. `scripts/runtime/engine/src/catalog/generate.ts`
Leave `patchBlock()` intact for markdown marker blocks. Add a second projection writer for whole-file outputs instead of trying to force command shims and JSON manifests through marker blocks. The reason to keep `patchBlock()` unchanged is that it is already correct, small, and fail-loud (`scripts/runtime/engine/src/catalog/generate.ts:37-69`).

5. `CIRCUITS.md`
Generate all surface inventory blocks, including utilities/adapters. Today workflows are generated but utilities are manual, which is why `workers` can ship a command shim without appearing in the utility quick-reference table (`CIRCUITS.md:11-29`; `commands/workers.md:1-5`; `skills/workers/SKILL.md:1-7`).

6. `.claude-plugin/shipped-surface.json`
Commit the generated manifest and make it the install contract. `sync-to-cache.sh` should read this manifest instead of hard-coding both the allowlist and the rsync roots (`scripts/sync-to-cache.sh:26-34`; `scripts/sync-to-cache.sh:55-89`).

7. `scripts/verify-repo.sh` and `scripts/verify-install.sh`
Split verification by target:

Repo verifier:
- build/validate `KernelIR`
- regenerate `CIRCUITS.md` and command shims in memory and fail on drift
- validate `.claude-plugin/shipped-surface.json`
- run repo-only checks such as generator freshness, orphan references, and contributor tooling

Install verifier:
- read `.claude-plugin/shipped-surface.json`
- assert `requiredRoots`, `files.required`, and `files.executable`
- run shipped runtime/relay round trips only

This split is necessary because the current install verifier mixes install checks with repo-shape and contributor-environment checks (`scripts/verify-install.sh:190-229`; `scripts/verify-install.sh:482-509`).

8. Tests
Update these tests first:

- `scripts/runtime/engine/src/catalog/extract.test.ts`: assert roles/visibility/aliases instead of `kind + entryCommand + expertCommand`
- `scripts/runtime/engine/src/catalog/generate.test.ts`: cover doc projections plus generated command shims and shipped-surface JSON
- `scripts/runtime/engine/src/catalog/catalog-validator.test.ts`: compare generated projections against committed outputs and validate alias/doc ownership against `KernelIR`, not markdown tables
- `scripts/runtime/engine/src/sync-to-cache.test.ts`: assert synced layout and shipped files from `.claude-plugin/shipped-surface.json`, not a hard-coded six-entry directory expectation
- `scripts/runtime/engine/src/release-integrity.test.ts` and `scripts/runtime/engine/src/lifecycle-regressions.test.ts`: replace prose parsing with IR/projection tests and eliminate regex-based doc ownership checks

What happens to `entryCommand` / `expertCommand`:

- Step 1: delete them from `types.ts`
- Step 2: normalize legacy manifest fields into `surface.aliases[]` inside `extract.ts`
- Step 3: migrate workflow manifests from `{ command, expert_command }` to a single alias array
- Step 4: delete the legacy normalization bridge

That removes the current mirror fields without breaking the compiler on day one (`scripts/runtime/engine/src/catalog/types.ts:12-13`; `scripts/runtime/engine/src/catalog/extract.ts:72-73`; `skills/run/circuit.yaml:10-13`).

## Kernel Invariant Compliance
1. Every shipped unit has one semantic role.
Today the model only knows `"circuit"` and `"utility"` (`scripts/runtime/engine/src/catalog/types.ts:6-27`), but the docs distinguish router/workflow/lifecycle/adapter roles (`ARCHITECTURE.md:41-43`; `ARCHITECTURE.md:497-500`; `ARCHITECTURE.md:591-619`). `KernelUnit.role` fixes that by making role explicit and singular.

2. Runtime unit identity != slash-command alias.
Today command identity is partly semantic (`id`) and partly alias-shaped (`entryCommand`, `expertCommand`) (`scripts/runtime/engine/src/catalog/types.ts:8-17`; `scripts/runtime/engine/src/catalog/extract.ts:72-73`). The proposal keeps `id` semantic and moves slash invocations into `surface.aliases[]`.

3. Every fact class has one owner.
Today surface facts are split across manifests, command files, shell scripts, docs, and tests (`scripts/runtime/engine/src/cli/catalog-compiler.ts:39-74`; `scripts/verify-install.sh:215-225`; `scripts/sync-to-cache.sh:26-34`; `CIRCUITS.md:23-29`). The proposal assigns workflow topology to `circuit.yaml`, skill-only role/publicness to SKILL frontmatter, and install layout to generated `shipped-surface.json`.

4. Mirror fields forbidden.
`entryCommand` and `expertCommand` are mirror fields for one fact class: slash aliases (`scripts/runtime/engine/src/catalog/types.ts:12-13`). `surface.aliases[]` replaces both with one owner.

5. Publicness never inferred from directory.
The current verifier walks every `skills/*` directory and demands a matching `commands/<skill>.md`, which means "has a skill directory" currently implies "must be public" (`scripts/verify-install.sh:193-225`). The proposal makes `visibility` explicit in normalized metadata and generates shims only for public units.

6. Repo/installed verification separate.
The current `verify-install.sh` validates installable assets, repo-shape assumptions, and contributor-only tools in one script (`scripts/verify-install.sh:130-229`; `scripts/verify-install.sh:482-509`). The split verifier removes that category leak.

7. No test parses prose.
The current release tests parse markdown sections, mode descriptions, and artifact examples with regex and string slicing (`scripts/runtime/engine/src/release-integrity.test.ts:35-91`; `scripts/runtime/engine/src/release-integrity.test.ts:109-138`; `scripts/runtime/engine/src/lifecycle-regressions.test.ts:307-348`). The proposal moves those invariants onto `KernelIR` and generated projections so tests assert data, not prose.

8. `workers` needs no bespoke exception.
Today `workers` is documented as an adapter (`ARCHITECTURE.md:497-500`), extracted as a utility (`scripts/runtime/engine/src/catalog/extract.ts:79-87`; `scripts/runtime/engine/src/catalog/extract.test.ts:108-121`), and forced public because every skill directory must have a command shim (`scripts/verify-install.sh:215-225`; `commands/workers.md:1-5`). In the proposed kernel it is just `role: "adapter", visibility: "public"` like any other unit, with no one-off branch.
