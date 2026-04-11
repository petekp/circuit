# Result: Control-Plane Kernel Tournament

## Findings

### The runtime is healthy; the governance layer has 4 narrow bugs

The tournament confirmed the original diagnosis: the workflow DAG engine (steps, gates, artifacts, reroutes, derive-state, resume) is sound. The problems are concentrated in surface governance.

### The 4 actual bugs

1. **verify-install.sh:215-229 forces publicness from directory presence.** Every `skills/` directory must have a `commands/<skill>.md`. This is why `workers` has a public command shim despite being documented as an adapter.

2. **types.ts collapses adapter into utility.** The catalog type system only knows `circuit` and `utility`. The architecture distinguishes workflow/utility/adapter, but the code that should enforce this doesn't encode it.

3. **entryCommand is a mirror field.** `CircuitEntry` has both `entryCommand` and `expertCommand`. Only `run` uses `entryCommand`. It's a second representation of command identity.

4. **CIRCUITS.md utilities section is hand-authored and incomplete.** The workflows table is generated but the utilities table isn't. Workers has a shipped command but doesn't appear in the public docs.

### Key correction from evidence

`workers` is extracted as `kind: "utility"` (no `circuit.yaml`), NOT `kind: "circuit"` as the original analysis claimed. The forced-publicness comes from verification, not from extractor misclassification.

### Product decision surfaced

Whether `/circuit:workers` should remain a public command is a **product decision**, not a schema bug. The tournament established this clearly: `commands/workers.md` exists, `skills/workers/SKILL.md` advertises it, and it's shipped. The architecture calls it an adapter, but that doesn't automatically mean internal-only.

## Decision

**Narrow Catalog Extension**: Extend the existing `types.ts` contract with `role` and `visibility` fields. Remove `entryCommand`. Generate command shims and utilities docs from the enriched catalog. Fix verify-install.sh to read the generated public-commands list instead of walking directories.

This is none of the three tournament approaches. It's the minimum viable change that fixes the actual bugs without adding new metadata systems, contradicting the "single contract" declaration in types.ts, or disrupting the runtime engine.

See `decision.md` for full rationale, rejected alternatives, pre-mortem mitigations, and implementation slices.

## Next Steps

Transfer to Build with 4 implementation slices:
1. Add `role` + `visibility` to types.ts/extract.ts
2. Remove `entryCommand` mirror field
3. Generate public-commands.txt + command shims; fix verify-install.sh
4. Generate utilities section in CIRCUITS.md

## PR Summary

Redesign Circuit's control-plane governance layer based on tournament evaluation of 3 competing approaches. All three (command-registry, normalized IR, shipped-surface manifest) were rejected by adversarial review as over-scoped. Converged on a narrow catalog extension that adds role/visibility to the existing type contract, removes the entryCommand mirror field, generates command shims from the catalog, and fixes verify-install.sh to stop inferring publicness from directory presence.
