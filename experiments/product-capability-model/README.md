# Product capability model spike

This is a disposable model of Circuit's product surface. It is here to answer
one question before we build permanent machinery:

> Can one small catalog help us see what Circuit is for, what exists, where the
> gaps and overlaps are, and which product changes need a deliberate decision?

The current answer is in
[`capability-map.generated.md`](./capability-map.generated.md). The authored
source is [`catalog.json`](./catalog.json).

An adversarially verified review ran on 2026-07-18:
[`review-2026-07-18.md`](./review-2026-07-18.md) (findings data in
[`review-findings-2026-07-18.json`](./review-findings-2026-07-18.json)).
The catalog now carries that review's confirmed corrections, twelve
capability rows the first pass missed, and four added boundaries. The
review's machinery recommendations (derivable exposure, proof-strength
definitions, a visibility marker on surfaces) are not built yet.

## Hard fence

This is not the product authority yet.

- It does not change the runtime, flows, host plugins, release inventory, or
  public claims.
- It is not wired into `npm run verify`.
- It does not replace `docs/positioning.md` or
  `generated/release/current-capabilities.json`.
- During the review, edit this catalog when testing a product change against the
  model. Do not make the rest of the repo depend on it.

The release inventory uses the word _capability_ for parity records such as
commands, modes, routes, connectors, and generated host files. Those records are
useful proof. They are not the product-purpose hierarchy tested here.

## What this version tests

The model separates five things that are easy to blur together:

1. **Vision anchors** — the outcomes Circuit is trying to create.
2. **Capabilities** — what someone can accomplish with Circuit.
3. **Delivery and exposure** — whether it works, and where it can be reached.
4. **Proof and surfaces** — the code, commands, flows, blocks, tests, and docs
   that make the capability real.
5. **Review signals** — gaps, overlaps, young areas, and deliberate boundaries.

Commands, flows, and blocks are mapped underneath capabilities. They do not
define the hierarchy. The disposable audit currently accounts for all 15
top-level commands, 13 cataloged flows, and 29 cataloged blocks.

## Run it

From the repository root:

```bash
# Validate the catalog and check that the human view is current.
node experiments/product-capability-model/render.ts --check

# Validate the catalog and rebuild the human view.
node experiments/product-capability-model/render.ts --write
```

The audit checks:

- unique and valid IDs;
- valid area, vision, relationship, and review-question links;
- evidence paths that still exist;
- proposed capabilities that are clearly marked as unshipped;
- every current command, flow, and block mapped at least once; and
- mappings that point to surfaces that no longer exist.

The flow and block roster comes from canonical generated outputs that are
already covered by the flow drift check. If this becomes permanent, its contract
test should import `flowPackages`, `FLOW_BLOCK_DEFINITIONS`, and
`CLI_COMMAND_NAMES` directly.

## What the first pass already exposes

- Run is meant to reduce routing work, but the CLI still expects an explicit
  flow choice.
- Flow encoding is central to the vision, while the custom-flow lifecycle is
  still a collection of creation tools rather than one complete experience.
- Goal and Pursue overlap around long-running outcome ownership.
- Queue, batch, and several advanced coordination mechanics are real but remain
  internal, with no settled public product intent.
- Recorded history is stronger than active-run watching and control.
- Memory and recall exist, but the compounding loop from run evidence back into
  a better flow is still proposed.
- Host-facing work patterns and CLI-only operating utilities currently sit in
  the same product story even though users encounter them very differently.

These are hypotheses for review, not decisions smuggled in as facts.

## Questions that should decide whether we keep it

The spike is useful only if a review can answer these more clearly than the
current code and docs can:

1. Can we tell why each capability belongs in Circuit?
2. Can we distinguish a real product gap from an intentional boundary?
3. Can we spot two surfaces that solve the same job in competing ways?
4. Can an agent find the relevant source and proof without touring the repo?
5. Would a normal product PR have one obvious catalog edit?
6. Is the 43-capability grain stable enough to discuss, or already a hairball?

## Promotion path if the spike works

Do not promote it by moving these files unchanged. Use what the review teaches
us and build the smaller permanent contract:

- `docs/product-capabilities/catalog.json` as the authored source; <!-- path-ok -->
  (proposed future home, does not exist yet)
- a generated human map and purpose-specific agent views;
- a contract test that reads the live command, flow, and block catalogs;
- a short rule in `AGENTS.md` that product changes update the catalog;
- an explicit product-impact declaration for changes that add, remove, expose,
  or materially reshape a capability; and
- Git history as the change record.

The gate should catch cataloged surface drift. It cannot infer product meaning
from every source edit. Requiring a capability edit for every internal bug fix
would create noise and train people to make meaningless updates.

## Throw-away criteria

Delete this spike if the review finds that capabilities cannot be named without
copying commands and flow IDs, that the categories change with every discussion,
or that the catalog does not improve a real product decision. Keeping a tidy map
is not the goal; making better decisions is.
