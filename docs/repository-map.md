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

## Every Tracked Top-Level Path

The product is `src/`, `tests/`, `plugins/`, and `docs/`. Everything else on
this list exists for a reason a reader should be able to learn in one line,
which is what the rest of the table is for. If a directory is not here, it is
not tracked.

| Path | What it is | Read next |
|---|---|---|
| `README.md` | What Circuit is and how to install it | `docs/first-run.md` |
| `AGENTS.md`, `CLAUDE.md` | The only file that defines agent rules; `CLAUDE.md` just includes it | — |
| `CONTEXT.md` | Product posture and vocabulary, upstream of any pitch or landing copy | `docs/positioning.md` |
| `UBIQUITOUS_LANGUAGE.md` | Canonical product vocabulary for operator-facing prose | — |
| `src/` | The engine and the flow packages | `src/README.md` |
| `tests/` | Every test; mirrors the `src/` layering | `AGENTS.md` verification section |
| `plugins/` | The generated Claude Code and Codex host packages | `plugins/README.md` |
| `docs/` | Contracts, flow design, release records, ideas, audits | `docs/README.md` |
| `scripts/` | Build, emit, gate, and release automation | `docs/reference/script-inventory.md` |
| `generated/` | Compiled flow output the emitters write; never hand-edited | `docs/generated-surfaces.md` |
| `schemas/` | Emitted JSON Schema for the YAML files a user writes | `docs/yaml-validation.md` |
| `bin/` | The `circuit` entrypoint and its Node version guard | — |
| `evals/` | Measurement harnesses and their task fixtures | `evals/README.md` |
| `experiments/` | Investigations kept for their findings, not run by any gate | See below |
| `apps/` | The flow designer, a local-only dev UI with its own package | `apps/designer/` |
| `assets/` | Images used by the README and docs | — |

## Where The Layers Live

```text
.
+-- README.md
+-- docs/
|   +-- README.md              read-first map of the docs
|   +-- repository-map.md      this file
|   +-- first-run.md
|   +-- operator-guide.md
|   +-- configuration.md
|   +-- positioning.md         claims that are mechanically true today
|   +-- generated-surfaces.md  what is generated and from what
|   +-- doc-classes.json       per-doc class: living, generated, historical, evidence
|   +-- architecture/
|   +-- contracts/             engine contracts
|   +-- flows/                 flow design notes and the block catalog
|   +-- reference/
|   +-- release/               runbook, notes, proofs
|   +-- audits/ ideas/ learnings/ plans/ specs/ pivot/ evals/
+-- plugins/
|   +-- README.md               what each host package contains
|   +-- claude/README.md        the Claude Code plugin
|   +-- codex/README.md         the Codex plugin, and how its skills are generated
|   +-- shared/                 launcher code both host packages embed
+-- scripts/
|   +-- docs/ evals/ flows/ generated/ hosts/ html/ plugins/ release/ schemas/ shared/
+-- src/
    +-- README.md
    +-- app/ cli/ commands/ connectors/ flows/ history/ hosts/
    +-- memory/ policy/ release/ runtime/ schemas/ selection/
    +-- shared/ skill-hooks/
```

Layer maps live at `src/README.md`, `src/commands/README.md`,
`src/runtime/README.md`, `src/schemas/README.md`, `src/flows/README.md`,
and `src/shared/README.md`. The host packages carry their own at
`plugins/README.md`, `plugins/claude/README.md`, and
`plugins/codex/README.md`.

The operator path is short:

```text
README.md -> docs/README.md -> one task-specific doc
```

The contributor path is layered:

```text
docs/repository-map.md -> src/README.md -> src/<layer>/README.md -> code
```

## Two Directories That Need A Sentence Each

**`evals/` is code plus a lot of local data.** Around 450 files are tracked; the
working tree holds tens of thousands, because each harness checks out task
fixtures and writes run output beside them. `tasks`, `results`, `sessions`, and
`.circuit` are gitignored per harness and carved out of both `tsconfig.json` and
`biome.json`. Everything else in `evals/` is ordinary source and is typechecked
and linted like the rest of the repo.

**`experiments/` is not a staging area.** Nothing in it runs in a gate, and
nothing in it should be depended on by `src/`. It is kept because the findings
are worth more than the disk, and its `.ts` files are typechecked so a refactor
cannot leave them silently broken. The one piece of executable release
infrastructure that used to live here, the first-run container lab, now lives at
`scripts/release/first-run-lab/` where its status as a required gate is legible
from the path.

## Targeted Probes

Run these after navigation or file-tree changes:

```bash
npm run check-doc-paths
npm run check-flow-drift
npm run check-release-infra
npm run verify
```

Expected result: every path a living doc names exists, generated-surface drift
checks pass, release checks pass, and the full verification command passes.
