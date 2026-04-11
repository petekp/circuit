# Brief: Control-Plane Kernel Tournament

## Objective
Select the best kernel architecture for reimplementing Circuit's control-plane -- the layer that governs public vs internal surface, command identity, shipped-surface proof, role taxonomy, doc ownership, and verification modes. The runtime workflow engine (DAG, gates, artifacts, reroutes) is healthy and out of scope.

## Scope
- Command identity model (entry.command / expert_command / shim filenames / doc tables)
- Public vs internal surface governance (what is public, who decides, how it's enforced)
- Role taxonomy in the catalog type system (workflow / utility / adapter)
- Shipped-surface manifest and installed verification
- Doc ownership boundaries (machine-owned vs human-owned facts)
- Repo-mode vs installed-mode verification contracts
- Test ownership (what tests should and should not parse)

## Output Types
decision -- which kernel approach to adopt, with converged implementation sketch

## Success Criteria
1. Winning approach handles `workers` as a normal adapter instance, not a special exception
2. Command identity has exactly one owner -- no mirror fields
3. Publicness is never inferred from directory presence or file shipping
4. Repo verification and installed verification are explicitly separate contracts
5. No test parses narrative prose to derive machine obligations
6. The approach is implementable as a targeted control-plane redesign (not a full rewrite)

## Constraints
- Codex must be used for all code reading and writing
- Runtime workflow engine (steps, gates, artifacts, executor kinds, reroutes) must not be disrupted
- Current catalog/compiler loop is small and healthy -- build on it, don't replace it unnecessarily
- Migration cost must be justified by governance improvement

## Verification Commands
```bash
cd /Users/petepetrash/Code/circuit
npx vitest run --reporter=verbose 2>&1 | tail -40
./scripts/verify-install.sh
```

## Out of Scope
- Workflow DAG model changes
- Relay/dispatch infrastructure changes
- Resume/handoff runtime behavior
- Gate semantics or artifact model changes
- UI/UX of slash commands (only the identity model behind them)

## Tournament Stances
- Worker A (Approach A): Command-registry-first + split-mode verifier + docs-never-machine-owned. Stance: minimize complexity, attack the seam that keeps breaking.
- Worker B (Approach B): Strong normalized IR + shipped-surface manifest + split-mode verifier. Stance: maximize robustness, build the durable kernel.
- Worker C (Approach C): Shipped-surface-first + split-mode verifier. Stance: optimize for package correctness, solve install drift first.

## Kernel Invariants (all approaches must satisfy)
### Runtime
- Every shipped unit has exactly one semantic role: workflow, utility, or adapter
- Runtime unit identity != slash-command alias
- Adapter boundaries are typed; parent workflows depend on declared contract files only
- Runtime behavior must not depend on advisory prose

### Authoring
- Every fact class has one owner (not "mostly one": one)
- Generated vs handwritten ownership is explicit per field or file
- Mirror fields for the same fact are forbidden
- Hidden exceptions are design failures

### Shipped-Surface
- Shipped surface, public surface, and documented surface are separate inventories
- Shipping a file does not make it public
- Public exposure is an explicit projection, not a directory-presence implication
- Installed verification works from installed artifacts alone

### Public-Doc
- A doc fact is either machine-owned or human-owned, never both
- Public inventories come from the same source that defines public exposure

### Verification
- Repo verification and installed verification are different modes
- Installed mode may not consult git state or repo-only files
- Tests may check generated blocks for freshness but must not parse advisory prose into release semantics
