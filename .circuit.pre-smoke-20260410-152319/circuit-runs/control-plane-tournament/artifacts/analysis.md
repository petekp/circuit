# Analysis: Control-Plane Kernel Tournament

## Facts (confirmed, high confidence)

1. **[fact] Catalog type system knows only two kinds.** `types.ts:6-28` defines `CircuitEntry` (kind: "circuit") and `UtilityEntry` (kind: "utility"). There is no `adapter` kind, no `visibility` field, no `role` field beyond the kind discriminator. The type `CatalogEntry = CircuitEntry | UtilityEntry` is the entire IR.

2. **[fact] Classification is based solely on circuit.yaml presence.** `extract.ts:49-88` -- if `circuit.yaml` exists in a skill directory, the unit becomes `CircuitEntry`; otherwise `UtilityEntry`. Workers has `circuit.yaml`, so it's classified as `kind: "circuit"` despite ARCHITECTURE.md calling it an adapter.

3. **[fact] Dual command identity fields.** `CircuitEntry` has both `entryCommand: string | undefined` and `expertCommand: string` (`types.ts:12-13`). `extract.ts:67-73` populates `entryCommand` from `circuit.entry.command` and `expertCommand` from `circuit.entry.expert_command` (defaulting to `/circuit:${circuit.id}`).

4. **[fact] verify-install.sh forces skill==command parity.** Lines 215-229 iterate every skill directory and require a matching `commands/${skill}.md`. Missing shim = verification failure. This is why `workers.md` exists.

5. **[fact] 9 command shims exist.** `commands/`: build, explore, handoff, migrate, repair, review, run, sweep, workers. All have identical structure: YAML frontmatter with `description`, then `Use the circuit:<name> skill to handle this request.`

6. **[fact] Generator patches inline marker blocks.** `generate.ts` uses `<!-- BEGIN blockName -->` / `<!-- END blockName -->` patterns to patch generated content into target files. The generator itself is clean and narrow.

7. **[fact] verify-install.sh does not distinguish repo vs installed mode.** It uses `PLUGIN_ROOT` from script location and applies the same checks regardless of context. No mode parameter, no conditional logic for repo vs cache.

8. **[fact] sync-to-cache.sh defines shipped shape by shell pruning.** Files are rsynced with explicit excludes. The shipped inventory is implicitly defined by what the rsync doesn't exclude, not by an explicit manifest.

## Inferences (derived, medium confidence)

1. **[inference] The extractor's circuit/utility binary is the root of the role taxonomy gap.** Because there's no `adapter` kind, the system cannot distinguish workers from run/build/explore at the type level. Any policy that depends on role (like "adapters don't get public commands") cannot be enforced by the compiler.

2. **[inference] Command shim existence is the de facto definition of "public."** Since verify-install.sh requires a shim for every skill, and the shim triggers Claude Code's slash-command picker, the commands/ directory IS the public surface. But no explicit model says this.

3. **[inference] The generator already has the right architecture for projections.** The `GenerateTarget` pattern (file + block + render function) could generate command shims, shipped manifests, and verification data if given richer input than the current binary catalog.

## Unknowns (gaps that matter)

1. **[unknown] How do tests parse docs?** The test files (`release-integrity.test.ts`, `lifecycle-regressions.test.ts`) were not fully read. The analysis from the prompt claims they lock SKILL wording and profile tables, but I have not verified specific assertions.

2. **[unknown] Does sync-to-cache.sh ship everything in commands/?** The rsync include/exclude list needs verification to confirm whether commands/workers.md ships to the installed cache.

## Contradictions Between Sources

1. **ARCHITECTURE.md vs catalog types:** ARCHITECTURE says workflow/utility/adapter. Code says circuit/utility. No adapter concept in code.
2. **ARCHITECTURE.md vs verify-install.sh:** ARCHITECTURE says workers is an adapter with internal-only surface. verify-install.sh requires it to have a public command shim.
3. **Command shim existence vs intentional publicness:** All skills have shims because verification demands it, not because they're all intentionally public.

## Implications

1. Any kernel that adds `adapter` as a role must change both `types.ts` and `extract.ts`.
2. The verify-install.sh skill==command check is the single most impactful line to change -- removing it eliminates the forced-publicness problem.
3. The generator is well-structured for extension; a richer catalog can drive more projections without redesigning the generator.
4. `entryCommand` / `expertCommand` duality in `CircuitEntry` is the type-level mirror field. Any kernel must collapse this to one.

## Hard Invariants (must not violate)

- Workflow manifests (circuit.yaml) remain the source of truth for workflow runtime behavior
- The generator's marker-block pattern is clean and should be preserved
- SKILL.md frontmatter remains the source of skill name/description
- The extract -> generate pipeline architecture is sound; the IR is what needs enrichment

## Seams and Integration Points

1. **extract.ts -> types.ts**: This is where role taxonomy must be enriched
2. **types.ts -> generate.ts**: Generator already handles any `GenerateTarget`; richer catalog flows through cleanly
3. **verify-install.sh skill-loop (lines 215-229)**: This is the seam that forces publicness
4. **commands/ directory -> Claude Code plugin system**: The plugin host reads this directory for slash-command discovery
5. **sync-to-cache.sh -> installed cache**: The seam between repo and installed surface
