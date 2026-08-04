# Product capability model spike

This is a disposable, source-backed inventory of Circuit's product surface.
It exists to answer four questions:

1. What can someone accomplish with Circuit today?
2. Which controls, guarantees, and internal mechanisms support those outcomes?
3. Which current product surfaces deliver or prove each item?
4. What is missing, overlapping, dormant, or still only proposed?

The readable result is
[`capability-map.generated.md`](./capability-map.generated.md). The complete
surface census is
[`surface-inventory.generated.json`](./surface-inventory.generated.json). The
authored product judgment lives in [`catalog.json`](./catalog.json).

## Hard fence

This model is not product authority yet.

- It does not change the runtime, flows, plugins, release inventory, or public
  claims.
- It is not part of `npm run verify`.
- It does not replace `docs/positioning.md`, Circuit's product vocabulary, or
  `generated/release/current-capabilities.json`.
- Nothing outside this experiment may depend on it.

The words capability, control, guarantee, mechanism, and surface are analytical
categories in this spike. They do not replace Circuit's canonical terms such as
flow, block, route, check, trace, report, and evidence.

## How completeness works

The model deliberately uses two layers.

The top layer is a human product map. A capability is a stable user outcome,
not a command or implementation detail. Controls, guarantees, and mechanisms
sit beside the capability list so they are visible without inflating it.

The bottom layer is a machine census. It inventories the current checkout's:

- CLI front doors, commands, subcommands, and run flags;
- public and internal flows, plus every block in the block catalog;
- supported hosts, installed host commands, skills, flows, and hooks;
- Codex MCP lifecycle tools;
- built-in and custom connectors;
- configuration groups and Skill Hook anchors;
- public claims, release records, and important run outputs.

Every surface must be bound to a catalog node or explicitly excluded. Active
delivery surfaces derive reach automatically. Proof-only, example, internal,
and dormant surfaces cannot make a feature look public by accident.

Evidence is attached to specific claims. Each reference says what it proves,
and stronger labels have stronger requirements: a tested claim needs a behavior
test, while a release-observed claim needs a known release proof.

This catches drift. It does not prove that the chosen capability names and
boundaries are good product judgment. That still requires review.

## Run it

From the repository root:

```bash
# Exercise the v0.2 contract with focused synthetic failures.
node experiments/product-capability-model/check-v02.ts

# Validate the catalog and check both generated views for drift.
node experiments/product-capability-model/render.ts --check

# Validate the catalog and rebuild both generated views.
node experiments/product-capability-model/render.ts --write
```

The audit checks:

- unique, valid IDs and links;
- a disposition for every current surface;
- no active delivery through dormant or proposed items;
- an active delivery path for every shipped or partial capability;
- evidence paths, public claim IDs, and release proof IDs;
- typed evidence strength;
- explicit handling for gaps, overlaps, young areas, and boundaries; and
- generated files that match the current checkout.

Some rosters do not yet have one canonical exported registry. Those surfaces
are marked `declared` in the generated census and produce warnings when they
are used to derive reach. That makes the weakness visible instead of hiding it.

## Review before promotion

Before making this permanent, use it against representative changes: add a
public flow, add a host-only surface, strengthen a runtime guarantee, add a
proposal, and fix an internal bug that should require no catalog change. Then
run a second omission review against the real install-to-report journey.

Delete the spike if the categories keep changing, if capabilities merely copy
command names, or if the map does not improve real product decisions. A tidy
inventory is not the goal.
