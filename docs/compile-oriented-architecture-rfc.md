# Compile-Oriented Architecture RFC for Circuit

Status: Proposed for implementation  
Audience: skeptical technical reviewers  
Decision bar: exacting approval for a constrained pilot, not broad rollout

## 1. Decision Summary

Circuit should proceed with a narrow compile-oriented pilot, but only on a final
normative contract that is explicit about ownership, visibility, generation, and
installed-surface proof.

This RFC defines the implementation end state for the pilot. Any implementation
that relies on unstated exceptions, hidden inventory logic, or new ownerless
metadata is out of spec.

The pilot must do all of the following:

- extend the existing catalog compiler path rather than introduce a second
  compiler, shell generator, or manifest-only inventory script
- normalize current owners into a typed `CircuitIR`
- generate only these surfaces:
  - the existing `CIRCUITS.md` Quick Reference block
  - the existing `CIRCUITS.md` Entry Modes block
  - public `commands/*.md` shims
  - `scripts/runtime/generated/surface-manifest.json`
- keep `README.md`, `ARCHITECTURE.md`, `docs/workflow-matrix.md`, and all
  `SKILL.md` bodies handwritten
- treat `workers` as an internal adapter in v1:
  - shipped as a skill
  - not shipped as a public slash-command shim
  - not included in public command inventories
  - not included in generated public docs
- make public slash identity derived from the entry slug, with workflow
  invocation suffixes owned by `entry.usage`
- give `run` an explicit `entry.usage: "<task>"` contract in v1
- forbid `entry.command` and `expert_command` in shipped workflow manifests;
  slash identity must be derived from the slug
- define `surface-manifest.json` as a typed shipped-surface inventory plus
  generation metadata, not proof that an install is valid by itself
- require `scripts/verify-install.sh` to prove the exact installed plugin
  surface, including rejecting unexpected extra top-level cache contents

The governing rule is one owner per fact, one validator per field, and one
compiler path for generated surfaces. This RFC rejects any implementation that
adds a new mirror or generated output without also specifying its owner,
validator, and freshness enforcement.

The current contributor-facing ownership map for that contract lives in
`docs/control-plane-ownership.md`.

Anti-goals:

- No full workflow authoring DSL.
- No generated `README.md`, `ARCHITECTURE.md`, or `docs/workflow-matrix.md`.
- No generated full-file `SKILL.md`.
- No install-time regeneration.
- No compiler logic that scrapes handwritten docs for machine-owned facts.
- No hardcoded adapter allowlists.
- No hidden special-case for `run`.
- No manifest-only verification.

## 2. Current-State Evidence From This Repo

### Existing compiler path

Circuit already has one compiler loop that is narrow and healthy:

- `scripts/runtime/engine/src/catalog/extract.ts` reads `skills/*/circuit.yaml`
  plus `SKILL.md` frontmatter
- `scripts/runtime/engine/src/cli/catalog-compiler.ts` renders the generated
  `CIRCUITS.md` marker blocks
- `scripts/runtime/engine/src/catalog/catalog-validator.test.ts` fails when the
  checked-in generated blocks are stale

That path is the only approved compiler path for this pilot.

### Current machine-enforced semantics are narrower than the docs

The current repo does not yet encode the distinctions this pilot needs:

- `scripts/runtime/engine/src/catalog/types.ts` only distinguishes
  `kind: "circuit"` vs `kind: "utility"`
- `scripts/runtime/engine/src/catalog/extract.ts` treats every non-workflow
  skill as `utility`
- there is no shipped `scripts/runtime/generated/surface-manifest.json`
- `scripts/verify-install.sh` hardcodes expected CLI, hook, skill, and shim
  inventories in shell

### Current repo surface has mismatches the pilot must close

The repo currently ships a surface that is partly public and partly accidental:

- `sync-to-cache.sh` prunes cache installs to `.claude-plugin`, `commands`,
  `hooks`, `schemas`, `scripts`, and `skills`
- `commands/workers.md` currently ships even though `README.md` and
  `CIRCUITS.md` omit `workers` from public command inventories
- `ARCHITECTURE.md` describes `workers` as an adapter rather than a public
  utility
- `release-integrity.test.ts` and `lifecycle-regressions.test.ts` still enforce
  some parity checks against advisory doc restatements such as the
  `workflow-matrix` Profile Availability table

The pilot must replace those accidental or distributed contracts with explicit
ownership.

## 3. Goals and Non-Goals

### Goals

- Reduce structural drift across manifests, generated reference blocks, public
  command shims, verifier inventories, and parity checks.
- Make public vs internal command visibility role-derived and machine-enforced.
- Let reviewers understand an owner edit plus generated diff without learning a
  second compiler or hidden exception map.
- Keep generated diffs low-risk and reviewable by limiting generation to
  mechanical surfaces.
- Make installed-surface verification stronger than the current hardcoded shell
  inventory checks.
- Ensure every field in `CircuitIR` and `surface-manifest.json` has one named
  owner and one validator.

### Non-goals

- Eliminate all duplication.
- Replace behavior tests with schema checks.
- Generate explanatory prose.
- Reclassify manual-normative docs as advisory just to make parity tests easier
  to delete.
- Expand compile ownership beyond the surfaces explicitly named in this RFC.

## 4. Final Ownership and Visibility Contract

### Core rules

1. No fact may be both described as advisory-only and consumed by the compiler,
   verifier, scorecard, or scenario gates.
2. A field is not implementation-ready until this RFC names:
   - its canonical owner
   - its validator
   - the surface that consumes it
3. Public visibility is role-derived in v1:
   - workflows are public
   - utilities are public
   - adapters are internal-only
4. The existing catalog compiler is the only compiler path. The pilot may extend
   its extractor, target registry, and validators, but may not create a second
   generator.

### Fact ownership matrix

| Fact class | Canonical owner | Allowed secondary consumers | Validator rule |
|---|---|---|---|
| Public entry slug | skill directory basename under `skills/<slug>/` | `CircuitIR`, public command projection, generated surfaces, verifier inventory | Extraction fails unless the basename is unique and equals `frontmatter.name`; workflows also require `circuit.id == <slug>`. |
| Workflow role | presence of `skills/<slug>/circuit.yaml` | `CircuitIR`, compiler, runtime, verifier inventory | If `circuit.yaml` exists, role is `workflow`. No frontmatter field may override it. |
| Non-workflow role | `role: utility|adapter` in `SKILL.md` frontmatter | `CircuitIR`, compiler, verifier inventory | If `circuit.yaml` is absent, frontmatter `role` is required and must be exactly `utility` or `adapter`. |
| Public visibility | `CircuitIR.role` | compiler targets, surface manifest, public docs/tests | `publicCommand` is required for workflows and utilities and forbidden for adapters. |
| Workflow mechanics: steps, entry modes, gates, routes, artifacts | `skills/<slug>/circuit.yaml` | runtime, `CircuitIR.workflow`, validators | Parsed only from `circuit.yaml`; handwritten docs may describe these facts but may not be parsed for them. |
| Public slash identity | derived `/circuit:<slug>` | generated shims, generated docs, surface manifest | Generators and validators must derive it; any mirror field must either match exactly or be absent. |
| Workflow invocation suffix | `circuit.entry.usage` | generated public docs, surface manifest | Allowed only on workflows. In v1, only `run` uses it, and it must equal `"<task>"`. |
| Public display description | first sentence of frontmatter `description` | `CircuitIR`, generated shims, surface manifest | Description is required. First-sentence extraction uses the normalization rule in Section 5. |
| Workflow purpose | `circuit.purpose` in `circuit.yaml` | `CircuitIR.workflow`, generated Quick Reference block | Required for workflows. Utilities and adapters do not have a `purpose` field in v1. |
| `entry.expert_command` | forbidden | migration validator only | Any occurrence is a failure; slash identity is always derived `/circuit:<slug>`. |
| `entry.command` | forbidden | migration validator only | Any occurrence is a failure; workflow manifests may only own optional `entry.usage`. |
| Generated marker blocks and public command shims | catalog compiler outputs | docs readers, command picker, freshness validators | Manual edits are invalid. Freshness must be enforced by `generate --check`. |
| Installed-surface inventory | `surface-manifest.json` | `verify-install.sh` | The verifier must validate the actual installed filesystem, not the manifest alone. |
| Handwritten narrative and public guidance | `SKILL.md` body, `README.md`, `ARCHITECTURE.md`, manual-normative parts of `CIRCUITS.md` and `docs/workflow-matrix.md` | readers, retained doc-contract tests, reviewers | Compiler, verifier, scorecard, and scenario gates must ignore these for machine-owned facts. |

## 5. Final Normalized Contracts

### Normalization rules

- All manifest paths are plugin-root-relative and use forward slashes.
- No generated path may be absolute, start with `./`, contain `..`, or encode a
  cache-version-specific location.
- Frontmatter description normalization:
  - YAML-folded text is normalized to single spaces
  - the first sentence is the shortest non-empty prefix ending in `.`, `!`, or
    `?`
  - if no sentence terminator exists, the whole normalized description is used

### Final `CircuitIR`

```ts
type CircuitRole = "workflow" | "utility" | "adapter";

interface SourceRef {
  path: string;
  key?: string;
  note?: string;
}

interface PublicCommandIR {
  slash: `/circuit:${string}`;
  usage?: "<task>";
  shimPath: `commands/${string}.md`;
  displayDescription: string;
  provenance: SourceRef[];
}

interface EntryModeIR {
  id: string;
  startAt: string;
  description?: string;
  provenance: SourceRef[];
}

interface WorkflowContractIR {
  manifestPath: `skills/${string}/circuit.yaml`;
  purpose: string;
  entryModes: EntryModeIR[];
  steps: unknown[];
  provenance: SourceRef[];
}

interface CircuitEntryIR {
  slug: string;
  dir: `skills/${string}`;
  skillMdPath: `skills/${string}/SKILL.md`;
  role: CircuitRole;
  frontmatterName: string;
  shortDescription: string;
  publicCommand?: PublicCommandIR;
  workflow?: WorkflowContractIR;
  provenance: SourceRef[];
}

interface CircuitIR {
  schemaVersion: "1";
  entries: CircuitEntryIR[];
}
```

### `CircuitIR` field ownership and validators

| Field or invariant | Owner | Validator |
|---|---|---|
| `CircuitIR.schemaVersion` | compiler constant | Must equal `"1"`. |
| `CircuitIR.entries` | compiler extraction over `skills/*` | Stable sort by slug, no duplicate slugs. |
| `entry.slug` | skill directory basename | Must match `frontmatterName`; workflows must also match `circuit.id`. |
| `entry.dir` | compiler projection from slug | Must equal `skills/<slug>`. |
| `entry.skillMdPath` | compiler projection from slug | File must exist at `skills/<slug>/SKILL.md`. |
| `entry.role` | `circuit.yaml` presence or frontmatter `role` | Workflows inferred from manifest presence; non-workflows require `utility|adapter`. |
| `entry.frontmatterName` | `SKILL.md` frontmatter `name` | Must equal `<slug>` for all shipped entries. |
| `entry.shortDescription` | first sentence of frontmatter `description` | Must be non-empty after normalization; never inferred from `circuit.purpose`. |
| `entry.publicCommand` | role-derived public visibility | Required for workflows/utilities; forbidden for adapters. |
| `entry.publicCommand.slash` | derived from slug | Must equal `/circuit:<slug>`. |
| `entry.publicCommand.usage` | `circuit.entry.usage` | Allowed only on workflows. In v1, `run` must equal `"<task>"`; all other shipped entries omit it. |
| `entry.publicCommand.shimPath` | compiler projection from slug | Must equal `commands/<slug>.md` and exist for public entries. |
| `entry.publicCommand.displayDescription` | `entry.shortDescription` | Must match `entry.shortDescription` exactly. |
| `entry.workflow` | workflow role | Required iff `entry.role === "workflow"`; forbidden otherwise. |
| `entry.workflow.manifestPath` | compiler projection from slug | Must equal `skills/<slug>/circuit.yaml` and exist. |
| `entry.workflow.purpose` | `circuit.purpose` | Must be non-empty for workflows. |
| `entry.workflow.entryModes` | `circuit.entry_modes` | Must preserve mode ids and `start_at`; no doc inference or fallback guessing. |
| `entry.workflow.steps` | `circuit.steps` | Must be parsed structurally and fail on malformed manifest data. |
| `entry.provenance` | compiler | Must be non-empty and point back to actual source files/keys. |

### Final `surface-manifest.json`

```ts
interface GeneratedBlockSpec {
  file: "CIRCUITS.md";
  block: "CIRCUIT_TABLE" | "ENTRY_MODES";
}

interface PublicCommandSurface {
  slash: `/circuit:${string}`;
  usage?: "<task>";
  shim: `commands/${string}.md`;
  displayDescription: string;
}

interface SurfaceManifestEntry {
  slug: string;
  role: CircuitRole;
  skillDir: `skills/${string}`;
  skillMd: `skills/${string}/SKILL.md`;
  manifest?: `skills/${string}/circuit.yaml`;
  shippedFiles: string[];
  publicCommand?: PublicCommandSurface;
}

interface SurfaceManifest {
  schemaVersion: "1";
  pluginFiles: string[];
  executables: string[];
  generatedBlocks: GeneratedBlockSpec[];
  entries: SurfaceManifestEntry[];
}
```

### `surface-manifest.json` field ownership and validators

| Field or invariant | Owner | Validator |
|---|---|---|
| `schemaVersion` | compiler constant | Must equal `"1"`. |
| `pluginFiles` | compiler target registry for shipped plugin-wide files | Must be unique, plugin-root-relative, and exist in shipped installs. |
| `executables` | compiler registry of shipped executable files | Every path must also be declared in `pluginFiles` or `entries[*].shippedFiles`; verifier checks `-x`. |
| `generatedBlocks` | compiler target registry | Used only by `generate --check`; installed verifier must ignore these for path-existence proof. |
| `entries` | compiler projection from `CircuitIR.entries` | Stable sort by slug, no duplicate slugs. |
| `entry.slug` | `CircuitIR.slug` | Must match exactly. |
| `entry.role` | `CircuitIR.role` | Must match exactly. |
| `entry.skillDir` | `CircuitIR.dir` | Must equal `skills/<slug>`. |
| `entry.skillMd` | `CircuitIR.skillMdPath` | Must equal `skills/<slug>/SKILL.md`. |
| `entry.manifest` | `CircuitIR.workflow.manifestPath` | Required for workflows; forbidden for non-workflows. |
| `entry.shippedFiles` | compiler projection from the shipped entry surface | Must be unique, plugin-root-relative, and exhaustive for the entry's shipped files other than `publicCommand.shim`; it must include `skillMd` and `manifest` when present. |
| `entry.publicCommand` | `CircuitIR.publicCommand` | Required for workflows/utilities; forbidden for adapters. |
| `entry.publicCommand.slash` | `CircuitIR.publicCommand.slash` | Must match exactly. |
| `entry.publicCommand.usage` | `CircuitIR.publicCommand.usage` | Must match exactly. |
| `entry.publicCommand.shim` | `CircuitIR.publicCommand.shimPath` | Must exist for public entries and be absent for adapters. |
| `entry.publicCommand.displayDescription` | `CircuitIR.publicCommand.displayDescription` | Must match exactly. |

### Public command shim template

For every public entry, the compiler must generate this exact shim shape:

```md
---
description: "<displayDescription>"
---

Use the circuit:<slug> skill to handle this request.
```

The public invocation shown in generated docs and in `surface-manifest.json` is
`slash` plus optional `usage`. The shim body does not duplicate `usage`.

## 6. Exact Manual vs Generated Boundary

### `CIRCUITS.md`

| Region | Status | Owner | Enforcement |
|---|---|---|---|
| `<!-- BEGIN CIRCUIT_TABLE -->` block | generated | compiler from `CircuitIR` public workflows only | `generate --check` freshness; manual edits invalid |
| `<!-- BEGIN ENTRY_MODES -->` block | generated | compiler from workflow `entryModes` | `generate --check` freshness; manual edits invalid |
| `## Utilities` section | manual-normative | doc author | retained handwritten-contract tests and review |
| `## Workflows` prose | manual-normative | doc author | retained handwritten-contract tests and review |
| `## Shared Phase Spine` | manual-normative | doc author | retained handwritten-contract tests and review |
| `## Canonical Artifacts` | manual-normative | doc author | retained handwritten-contract tests and review |
| `## Rigor Profiles` | manual-normative | doc author | retained handwritten-contract tests and review |

Rules:

- adapters must never appear in generated `CIRCUITS.md` surfaces
- the compiler must not read manual-normative `CIRCUITS.md` sections
- doc reviewers may still enforce manual public guidance in those sections

### `docs/workflow-matrix.md`

| Region | Status | Owner | Enforcement |
|---|---|---|---|
| `### Profile Availability` table only | advisory-only | doc author | may restate manifest facts; compiler, verifier, scorecard, and scenario gates ignore it |
| `## 3. Canonical Artifacts` and artifact notes | manual-normative | doc author | retained handwritten-contract tests and review |
| `## 5. The Two Lifecycle Utilities` | manual-normative | doc author | retained handwritten-contract tests and review |
| `## 6. Command Surface` | manual-normative | doc author | retained handwritten-contract tests and review |
| `### Trivial path` | manual-normative | doc author | retained handwritten-contract tests and review |
| `## 7. Router Behavior` | manual-normative | doc author | retained handwritten-contract tests and review |
| `### Bootstrap Contract` | manual-normative | doc author | retained handwritten-contract tests and review |
| `## 8. Workflow Transfer` | manual-normative | doc author | retained handwritten-contract tests and review |
| `## 9. Circuit Breakers` | manual-normative | doc author | retained handwritten-contract tests and review |
| `## 10. Adjacent-Output Checklist` | manual-normative | doc author | retained handwritten-contract tests and review |
| review-phase attribution notes | manual-normative | doc author | retained handwritten-contract tests and review |

Rules:

- advisory-only means the table may restate machine-owned facts but cannot be
  used by the compiler, verifier, scorecard, or scenario gates
- manual-normative means the compiler and verifier ignore it, but tests and
  review may still enforce it

### Other handwritten docs

These remain fully handwritten in v1:

- `README.md`
- `ARCHITECTURE.md`
- all `SKILL.md` bodies

The compiler, verifier, scorecard, and scenario gates must not parse those
documents for machine-owned facts.

## 7. Compiler, Generation, and Repository Migration Rules

### Single compiler path

The pilot must extend the existing catalog compiler path:

- extractor: `scripts/runtime/engine/src/catalog/extract.ts`
- types: `scripts/runtime/engine/src/catalog/types.ts`
- target registry and CLI: `scripts/runtime/engine/src/cli/catalog-compiler.ts`
- freshness enforcement: `generate --check`

Forbidden:

- a second generator CLI
- a shell script that independently computes public command or shipped-surface
  inventories
- verifier-side regeneration
- compiler logic that reads handwritten docs for machine facts

### Required compiler targets

`generate` and `generate --check` must cover all generated outputs:

1. `CIRCUITS.md` `CIRCUIT_TABLE`
2. `CIRCUITS.md` `ENTRY_MODES`
3. public `commands/*.md` shims
4. `scripts/runtime/generated/surface-manifest.json`

Freshness failure of any generated target is a build/test failure.

### Required repository migrations in the pilot

The implementation defined by this RFC must land these repo migrations:

1. add `role: utility` to `skills/review/SKILL.md` and `skills/handoff/SKILL.md`
2. add `role: adapter` to `skills/workers/SKILL.md`
3. add `entry.usage: "<task>"` to `skills/run/circuit.yaml`
4. remove `entry.command` and `expert_command` from shipped workflow manifests
5. stop generating and stop shipping `commands/workers.md`
6. generate and check in `scripts/runtime/generated/surface-manifest.json`

The pilot is not complete until those migrations are reflected in generated
surfaces and validators.

## 8. Shipping and Verification Semantics

### Shipped installed surface

For installed plugin cache paths, the current shipped top-level plugin surface is:

- `.claude-plugin/`
- `commands/`
- `hooks/`
- `schemas/`
- `scripts/`
- `skills/`

The pilot must preserve an exact installed-surface proof for that shipped plugin
shape while moving expected inventory into `surface-manifest.json`.

### `surface-manifest.json` shipping rules

`scripts/runtime/generated/surface-manifest.json` is:

- a checked-in generated artifact
- copied into installed cache surfaces because `scripts/` ships
- the typed source of expected shipped inventory for `verify-install.sh`
- also the registry of generated-block freshness targets for `generate --check`

It is not:

- proof that an install is valid by itself
- permission to regenerate at install time
- permission for the verifier to consult the repo checkout

### Verifier contract

`scripts/verify-install.sh` must prove the installed surface under `$PLUGIN_ROOT`
using the shipped manifest only.

It must:

1. load `scripts/runtime/generated/surface-manifest.json` from `$PLUGIN_ROOT`
2. fail if the manifest is missing, malformed, or schema-invalid
3. derive the expected shipped paths from:
   - `pluginFiles`
   - `executables`
   - `entries[*].shippedFiles`
   - `entries[*].publicCommand.shim`
4. ignore `generatedBlocks` for installed path-existence checks
5. stat every expected path under `$PLUGIN_ROOT`
6. verify file vs directory type where relevant
7. verify executability for every path in `executables`
8. reject any adapter entry that declares a `publicCommand`
9. reject unexpected extra top-level children under `$PLUGIN_ROOT`
10. never regenerate anything
11. never read from the repo checkout when validating an installed cache surface

This is an exact installed-surface proof, not a manifest-only check.

### Explicit reject conditions

Reject any implementation that:

- keeps `commands/workers.md`
- exposes an adapter in generated public docs or public command inventories
- reads advisory docs to derive machine facts
- validates `surface-manifest.json` without statting the installed filesystem
- allows unexpected extra top-level cache contents to pass verification
- retains shipped dependence on `entry.command` or `expert_command`
- introduces a compiler path other than the existing catalog compiler

## 9. Test Policy, Retain/Delete Matrix, and Scenario Gates

### Test buckets

The pilot uses four buckets:

- **Behavior tests:** always retained
- **Runtime/integration tests:** retained unless replaced by stronger runtime
  proof
- **Handwritten-contract tests:** retained for manual-normative surfaces
- **Generated/mechanical freshness tests:** required for all generated targets

### Exact retain/delete matrix

| Current check or block | Action | Replacement or reason |
|---|---|---|
| `CIRCUITS entry mode parity` in `release-integrity.test.ts` | delete | replaced by generated `ENTRY_MODES` freshness under `generate --check` |
| `entry modes match workflow-matrix profile availability` in `release-integrity.test.ts` | delete | advisory-only profile table is no longer a gate |
| `workflow-matrix profile availability table matches manifests` in `lifecycle-regressions.test.ts` | delete | advisory-only profile table is no longer a gate |
| hardcoded command-shim inventory logic in `scripts/verify-install.sh` | replace | manifest-driven exact installed-surface verification |
| README public command inventory protections | retain | `README.md` remains handwritten and public |
| handwritten `CIRCUITS.md` utility and workflow prose protections | retain | those sections remain manual-normative |
| bootstrap-contract protections | retain | `docs/workflow-matrix.md` bootstrap contract remains manual-normative |
| workflow-transfer protections | retain | transfer behavior remains manual-normative |
| review-phase attribution protections | retain | review-phase prose promises remain manual-normative |
| artifact-note protections for manual prose | retain | manual artifact notes remain manual-normative |

### Required new or rewritten tests

The pilot must add or rewrite tests to prove:

- workflow vs utility vs adapter classification
- `workers` is classified as `adapter`
- adapters have no generated public shim
- adapters are absent from public command inventories and generated public docs
- `run` invocation rendering comes from `entry.usage`
- stale generated `commands/*.md` fails `generate --check`
- stale `surface-manifest.json` fails `generate --check`
- installed-surface verification fails on missing expected files
- installed-surface verification fails on polluted top-level cache contents
- installed-surface verification fails when an executable loses its executable bit

### Manual promise protection matrix

| Manual promise | Protection |
|---|---|
| README public command inventory | retained tests |
| `CIRCUITS.md` Utilities section and workflow prose | retained tests |
| command-surface guidance in `docs/workflow-matrix.md` | retained tests |
| bootstrap contract | retained tests |
| workflow transfer contract | retained tests |
| circuit-breaker and adjacent-output guidance | retained tests |
| review-phase attribution notes | retained tests |
| explanatory prose in `README.md`, `ARCHITECTURE.md`, and `SKILL.md` bodies | reviewer obligation only; compiler and verifier ignore it |

### Objective scenario gates

These scenarios are approval gates, not examples:

| Scenario | Canonical source edit | Regenerated surfaces | Forbidden manual edits | Required retained review/test coverage |
|---|---|---|---|---|
| Add a workflow | `skills/<slug>/circuit.yaml`, matching frontmatter `name`, description, body, optional `entry.usage` | `CIRCUITS.md` generated blocks, `commands/<slug>.md`, `surface-manifest.json` | no direct edit to generated blocks, generated shim, or shipped inventory projection | runtime behavior tests plus manual doc review where prose is intentionally updated |
| Add a public utility | `skills/<slug>/SKILL.md` with `role: utility`, matching `name`, description, body | `commands/<slug>.md`, `surface-manifest.json` | no direct edit to generated shim or manifest | retained README/CIRCUITS utility-doc protections |
| Add an internal adapter | `skills/<slug>/SKILL.md` with `role: adapter`, matching `name`, description, body | `surface-manifest.json` only | no generated shim, no public-doc inventory edit to pretend it is generated | retained adapter-visibility tests and architecture-doc review |
| Rename a slug | skill directory rename plus matching frontmatter/manifest id updates | all affected generated surfaces | no direct shim edit, no command-string hand edits inside generated outputs | retained public-doc and runtime tests |
| Change `run` usage suffix | `skills/run/circuit.yaml` `entry.usage` | generated public docs and `surface-manifest.json` | no hidden special-case in compiler or docs | run-usage rendering tests |
| Update shipped inventory | source-tree change plus regeneration | `surface-manifest.json` and any affected generated shim | no hand-maintained shell inventory lists for the same fact class | exact installed-surface verification tests |
| Verify a polluted cache install | add unexpected top-level content under a fixture cache root | none | no manifest edits to excuse the pollution | verifier must fail loudly |

## 10. Pass/Fail Scorecard

The pilot passes only if all of the following are true:

- every field in `CircuitIR` and `surface-manifest.json` has one named owner and
  one named validator
- role ownership is explicit and machine-enforced through workflow inference plus
  frontmatter `role: utility|adapter`
- adapters have no generated shim and no public command inventory presence
- `workers` is internal-only in generated public surfaces
- public slash identity is derived from slug
- `run` invocation rendering is owned by `entry.usage`
- shipped workflows contain neither `entry.command` nor `expert_command`
- `generate --check` covers every generated target named in this RFC
- the verifier proves the exact installed plugin surface, including rejecting
  extra top-level cache contents
- no advisory doc is read by the compiler, verifier, scorecard, or scenario
  gates
- no handwritten public doc is forced to equal `circuit.purpose` just to satisfy
  a brittle invariant
- no hidden special-case, allowlist, or second compiler path remains

The pilot fails or stops if any of the following is true:

- an adapter is exposed publicly through generation
- `workers` still ships a public shim
- `entry.command` or `expert_command` remains part of shipped command ownership
- the verifier becomes manifest-only
- polluted cache installs still pass verification
- `generate --check` does not cover every generated target
- the implementation expands generation beyond the surfaces named in this RFC
- manual-normative docs lose their retained test or reviewer protection without
  an explicit replacement

## 11. Final Recommendation

Approve the pilot only on this tightened contract:

- one compiler path
- one owner and one validator per field
- explicit `workflow|utility|adapter` roles
- internal-only adapters
- public command generation limited to workflows and utilities
- `run` usage owned by `entry.usage`
- no shipped reliance on `entry.command`
- exact installed-surface proof via a typed `surface-manifest.json`
- exact manual/generated boundaries
- exact test deletions, retentions, and scenario gates

Compile only what is mechanical, repeated, and machine-consumed. Keep narrative,
judgment-heavy, and public guidance handwritten. The pilot is worth doing only
if it reduces manual mechanical edits while making ownership and installed-surface
proof strictly stronger than they are today.
