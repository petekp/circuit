# Repository Map

Top-down path through the repo. Use it to choose the next layer, then switch to
the layer-owned docs.

## Disclosure Principle

Keep the first screen small:

1. Root files answer "what is Circuit and how do I start?"
2. `docs/` answers "where is the truth for this kind of change?"
3. `plugins/` answers "what does each host receive?"
4. `src/` answers "which source layer owns this behavior?"
5. Runtime, schemas, and flow packages explain their own boundaries locally.

Historical plans, release proof runs, ideas, and learnings stay discoverable but
do not compete with current entry docs.

## Evidence Used

These probes established the pre-change tree and the references that had to be
kept current:

```bash
find . -maxdepth 2 -type f | sed 's#^./##' | sort
find docs -maxdepth 3 -type f | sort
find plugins/claude plugins/codex -maxdepth 3 -type f | sort
find src/runtime src/schemas src/flows -maxdepth 2 -type f | sort
rg -n "docs/literate-guide\\.md|docs/script-inventory\\.md|generated-surfaces\\.md|docs/README\\.md" README.md AGENTS.md docs src tests scripts plugins generated package.json
```

## Before Map

The pre-change tree placed read-first docs, host-package maps, and source-layer
ownership at the same level, so readers had to infer ownership from filenames.
The full pre-change tree and pain-point notes live in this file's git history;
this doc tracks only the current map, not a stale one.

## After Map

The current shape keeps stable public paths where release checks already depend
on them, then adds maps at the boundaries where readers had to infer ownership:

```text
.
+-- README.md
+-- docs/
|   +-- README.md
|   +-- repository-map.md
|   +-- first-run.md
|   +-- operator-guide.md
|   +-- configuration.md
|   +-- generated-surfaces.md
|   +-- architecture/
|   |   +-- codebase-walkthrough.md
|   |   +-- runtime.md
|   +-- reference/
|   |   +-- script-inventory.md
|   +-- contracts/
|   +-- flows/
|   +-- release/
+-- plugins/
|   +-- README.md
|   +-- claude/
|   |   +-- README.md
|   +-- codex/
|       +-- README.md
+-- src/
    +-- README.md
    +-- app/
    +-- history/
    +-- policy/
    +-- release/
    +-- runtime/README.md
    +-- schemas/README.md
    +-- selection/
    +-- skill-hooks/
    +-- flows/README.md
    +-- shared/README.md
    +-- types/README.md
```

The operator path is still short:

```text
README.md -> docs/README.md -> one task-specific doc
```

The contributor path is now layered:

```text
docs/repository-map.md -> src/README.md -> src/<layer>/README.md -> code
```

Layer maps live at `src/README.md`, `src/runtime/README.md`,
`src/schemas/README.md`, `src/flows/README.md`, `src/shared/README.md`, and
`src/types/README.md`.

## Migration Rationale

The reorganization moved `docs/script-inventory.md` to
`docs/reference/script-inventory.md` (behind the docs map), added
parent maps for host packages (`plugins/README.md`, `plugins/codex/README.md`),
and added `src/README.md` plus per-layer READMEs (`src/runtime/README.md`,
`src/schemas/README.md`, `src/flows/README.md`, `src/shared/README.md`,
`src/types/README.md`) so layer ownership is learnable locally. Stable public
paths and code layout were kept in place because release checks depend on them
and a code move would churn imports without evidence of an ownership bug. All
changes were docs-only; the full per-change rationale table is recoverable from
this file's git history.

## Targeted Probes

Run these after navigation or file-tree changes:

```bash
rg -n "\\]\\((?:docs/)?(?:literate-guide|script-inventory)\\.md|readRepoFile\\('docs/(?:literate-guide|script-inventory)\\.md'\\)" README.md AGENTS.md docs src tests scripts plugins generated package.json -g '!docs/internal/archive/**' -g '!docs/release/proofs/runs/**' -g '!docs/reference/**'
npm run check-flow-drift
npm run check-release-infra
npm run verify
```

Expected result: no active links or test reads for the moved docs,
generated-surface drift checks pass, release checks pass, and the full
verification command passes.
