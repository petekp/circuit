# Decision: Control-Plane Kernel -- Narrow Catalog Extension

## Tournament Outcome

All three proposals (Command-Registry-First, Strong Normalized IR, Shipped-Surface-First) received FATALLY FLAWED verdicts from independent adversarial reviewers. The convergence is clear: the approaches were all too ambitious for the actual governance problems. The reviews consistently identified the same surviving insights and the same fatal over-reach.

## What Survived the Tournament

### Unanimous agreement across all reviews:

1. **Stop inferring publicness from directory presence.** `verify-install.sh:215-229` forces every `skills/` directory to have a command shim. This is the single highest-impact line to change. All three reviewers and all three proposals agree.

2. **The extract -> generate pipeline is healthy.** `extract.ts`, `generate.ts`, and `catalog-compiler.ts` are small, deterministic, and correct. Preserve them.

3. **The catalog type system should distinguish roles if roles matter.** `types.ts` only has `circuit` and `utility`. If the architecture distinguishes workflows, utilities, and adapters, the type system should encode that.

4. **CIRCUITS.md utilities section should be generated.** Currently hand-authored and incomplete (doesn't mention workers). This is a natural extension of the existing generation pattern.

5. **`types.ts` declares itself as "the single contract between extractor, generator, and validator."** Adding metadata systems outside this contract contradicts the declared architecture. All three reviewers flagged this.

### What all three proposals got wrong:

1. **Over-scoped the fix.** The actual bugs are narrow: forced publicness, missing role, incomplete generation. None requires a new registry, IR, or manifest.

2. **Treated workers' public status as purely accidental.** `commands/workers.md` exists, `skills/workers/SKILL.md` advertises `/circuit:workers`, and it's shipped. Whether workers should be public is a **product decision**, not a schema bug. The schema should make this decision explicit rather than forced.

3. **Assumed docs-as-contract is a bug.** The reviews showed that `release-integrity.test.ts` and `lifecycle-regressions.test.ts` intentionally verify that humans are being told the truth. SKILL.md is part of the execution contract (`ARCHITECTURE.md:24-39`). Eliminating prose testing is not a governance improvement -- it's a correctness regression.

4. **Ignored the real runtime kernel.** The actual runtime reads `circuit.manifest.yaml` directly (`derive-state.ts:27-35`, `resume.ts:107-124`). The catalog is a docs/surface generation tool, not the execution kernel. Proposals that treat the catalog as the kernel are building a second model next to the real one.

5. **Underestimated migration scope.** Every proposal claimed "minimal change" but would actually touch schemas, fixtures, 6 manifests, 8+ test files, docs, and verification scripts.

## Converged Design: Narrow Catalog Extension

The winning approach steals from all three proposals but stays within the existing type contract.

### Change 1: Add role to the catalog type system

Extend the existing `CatalogEntry` union in `types.ts`:

```typescript
export type CatalogRole = "workflow" | "utility" | "adapter" | "router";
export type CatalogVisibility = "public" | "internal";

export interface CircuitEntry {
  kind: "circuit";
  id: string;
  dir: string;
  version: string;
  purpose: string;
  expertCommand: string;  // entryCommand REMOVED
  entryModes: string[];
  skillName: string;
  skillDescription: string;
  role: CatalogRole;      // NEW
  visibility: CatalogVisibility;  // NEW
}

export interface UtilityEntry {
  kind: "utility";
  id: string;
  dir: string;
  skillName: string;
  skillDescription: string;
  role: CatalogRole;      // NEW
  visibility: CatalogVisibility;  // NEW
}
```

This stays within the "single contract" declaration. No new metadata systems.

**Where role comes from:** The extractor infers role from existing signals:
- Has `circuit.yaml` with `entry.signals`? -> `workflow` or `router` (router if id === "run")
- Has `circuit.yaml` without `entry.signals`? -> `workflow`
- No `circuit.yaml`? -> `utility` by default

Then a small override map (inline in extract.ts, not a separate file) for the one exception:
```typescript
const ROLE_OVERRIDES: Record<string, CatalogRole> = {
  workers: "adapter",
};
```

This is explicit about the exception rather than hiding it. If more adapters appear, this map grows -- and that growth pressure signals when to evolve the approach.

**Where visibility comes from:** Also inferred with an override:
- Workflows and router: `public`
- Utilities: `public` (review, handoff are public today)
- Adapters: `internal` by default

Override map for product decisions:
```typescript
const VISIBILITY_OVERRIDES: Record<string, CatalogVisibility> = {
  // workers: "public",  // uncomment if product decision is to keep it public
};
```

### Change 2: Remove entryCommand from CircuitEntry

`entryCommand` is the mirror field. Only `run` has it today (`skills/run/circuit.yaml:10`). The registry of "which command name routes to which workflow" is already in `skills/run/SKILL.md` (the intent-hint table). Remove `entryCommand` from `types.ts` and `extract.ts`. Keep `expertCommand` as the canonical slash-alias.

### Change 3: Stop requiring command shims for every skill directory

In `verify-install.sh`, change lines 215-229 from:

```bash
# OLD: require shim for every skill
while IFS= read -r -d '' skill_dir; do
  skill="$(basename "$skill_dir")"
  if [[ -f "$commands_dir/${skill}.md" ]]; then
    ...
  else
    fail "skill $skill/ has no matching command shim..."
```

To:

```bash
# NEW: require shim only for public entries (read from generated manifest)
# The catalog-compiler generates a shipped public commands list
while IFS= read -r command; do
  if [[ -f "$commands_dir/${command}.md" ]]; then
    ...
  else
    fail "public command $command has no shim..."
done < "$PLUGIN_ROOT/.claude-plugin/public-commands.txt"
```

Where `public-commands.txt` is a simple generated flat file (one command per line) produced by the catalog compiler from the extracted catalog's `visibility: public` entries. No YAML manifest, no JSON schema -- just a generated text file.

### Change 4: Generate command shims from catalog

Extend `catalog-compiler.ts` to generate `commands/*.md` for `visibility: public` entries. Delete `commands/workers.md` (or keep it if the product decision is to keep workers public).

### Change 5: Generate utilities section in CIRCUITS.md

Extend the existing generated block in `CIRCUITS.md` to include utilities, filtered by `visibility: public`. This fills the gap where the utilities table is hand-authored and incomplete.

### What this does NOT change

- **Workflow manifests** stay as-is (circuit.yaml owns topology)
- **SKILL.md** stays as-is (owns execution instructions and frontmatter descriptions)
- **sync-to-cache.sh** stays as-is (shipped shape defined by rsync)
- **verify-install.sh** structure stays (not split into repo/installed modes yet)
- **Prose tests** stay (except removing entryCommand-specific assertions)
- **docs/workflow-matrix.md** stays (profile tests check manifests, not just docs)
- **Runtime engine** untouched (derive-state, resume, append-event)

## Rationale

This is not any of the three tournament approaches. It's the minimum change that satisfies the actual bugs without violating the codebase's own architectural declarations.

Specifically:
- It stays within `types.ts`'s "single contract" boundary
- It uses the existing extract -> generate pipeline
- It doesn't add new metadata systems
- It makes the `workers` exception explicit rather than hiding it behind a registry
- It preserves prose testing as intentional contract verification
- Migration scope is genuinely small: ~4 files change, no new schemas

## Accepted Risks

1. **Role override map is an explicit exception table.** If more adapters appear, this table grows. That's acceptable for a plugin with 9 skills. If the table grows past 3-4 entries, reconsider whether role should come from a metadata source (SKILL.md frontmatter or a manifest field).

2. **Visibility is inferred, not declared.** The rule "adapters are internal, everything else is public" is simple but implicit. If the product evolves to have more visibility variations, this will need to become declared metadata.

3. **`commands/workers.md` deletion is a product decision.** The tournament established this clearly. This design makes the decision explicit but does not make it for you.

4. **verify-install.sh is not split into repo/installed modes.** The reviews showed this is a real improvement but not urgent. The current script works from both contexts. The generated `public-commands.txt` makes it easier to split later.

## Rejected Alternatives

| Alternative | Why Rejected |
|---|---|
| Command registry (Proposal A) | Adds a second manual checklist that can disagree with manifests and SKILL.md. Role outside the type system is a half-measure. |
| Strong normalized IR (Proposal B) | Over-engineered. WorkflowRuntime duplicates circuit.yaml. SKILL.md frontmatter is not the right place for visibility. Runtime already has its own kernel. |
| Shipped-surface manifest (Proposal C) | Doesn't solve command identity. Creates a second metadata system contradicting types.ts. Manifest sketch was already incomplete. |

## Reopen Conditions

Revisit this decision if any of these become true:
- More than 3 entries needed in the role override map
- A new skill needs visibility different from its role's default
- Install verification bugs require actual repo/installed mode split
- The runtime engine needs to consume catalog roles (currently it doesn't)

## Mitigations (Pre-mortem)

**Scenario: "6 months from now this failed."**

1. *The override map became a junk drawer.* Mitigation: If the map grows past 3 entries, promote role to a SKILL.md frontmatter field. The extractor already parses frontmatter, so this is a natural evolution.

2. *Generated command shims caused a regression.* Mitigation: Keep the generated shims identical to the current hand-authored format. Verify with a freshness test.

3. *Workers was needed as a public debug command.* Mitigation: The visibility override map makes this a one-line change.

4. *entryCommand removal broke something.* Mitigation: Only `run` uses it. The run/SKILL.md intent-hint table already documents the routing. Remove entryCommand from types and extract; verify tests still pass.

5. *The generated public-commands.txt drifted from reality.* Mitigation: verify-install.sh reads it at verification time. If it's stale, verification fails. This is self-correcting.

## Open Risks

1. SKILL.md trigger descriptions still advertise specific slash commands (e.g., "Use for /circuit:workers"). If workers becomes internal, those triggers still exist and Claude Code's skill matching may still surface it. The trigger text is a separate surface from command shims.

2. README.md and CIRCUITS.md hand-authored command tables may not auto-update. The generated blocks solve CIRCUITS.md, but README.md command sections are still hand-authored. This is acceptable because README changes are low-frequency.

## Implementation Slices

If this decision transfers to Build, the execution order would be:

1. **Slice 1:** Add `role` and `visibility` to `types.ts` and `extract.ts`. Update tests. (~1 session)
2. **Slice 2:** Remove `entryCommand` from `CircuitEntry`. Update `extract.ts`, `catalog-compiler.ts`, and tests. (~1 session)
3. **Slice 3:** Generate `public-commands.txt` and command shims from catalog. Update `verify-install.sh`. Delete `commands/workers.md`. (~1 session)
4. **Slice 4:** Generate utilities section in `CIRCUITS.md`. (~30 min)
