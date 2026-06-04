# Recovery And Restore Roadmap Addendum

Status: source-backed addendum, current as of 2026-06-04.

Purpose: capture recovery, restore, baseline, StepKind, and Fix test-fixture architecture opportunities before folding them into the canonical architecture improvement roadmap. This document does not implement the changes. It records what the current code says, where the seams are awkward, and how to improve them without disturbing active Skill Hooks work.

Current-state caution: this checkout does not currently contain a live `restore` StepKind or a `revert_applied_change` recovery kind. Those ideas came from adjacent restore/revert work and are treated here as roadmap candidates, not current facts.

## Recommended Roadmap Slot

Add a new mini-cluster named **Recovery And Restore Contract Ownership** around the existing run-transition and schema-family work. This cluster should not jump ahead of the active Skill Hooks work. Fold it in after the earlier roadmap items are landed or refreshed, especially the Skill Hooks contract hardening.

Best slot:

1. Inside roadmap item 9, land run transition characterization tests first.
2. Centralize recovery route policy before extracting the transition classifier.
3. Add a recovery-kind reachability ratchet before adding any new recovery kind.
4. Move generic restorable baseline/change-set vocabulary into shared contracts before reintroducing a restore executor or result report.
5. Add a StepKind alignment ratchet after recovery policy is stable. Add a metadata table only if the ratchet proves the duplication still hurts.
6. Extract Fix runtime fixtures only when the next restore/recovery test needs them.

This sequence keeps routing pure, keeps side effects in executors, and avoids leaving shared contracts with no user.

## Opportunity 1: Centralize Recovery Route Policy

Roadmap fit: yes. This is the best first cleanup.

Slot: inside roadmap item 9, **Make Run Transitions Explicit**, after characterization tests and before the transition classifier.

### Evidence

- `src/schemas/recovery-route-kind.ts:5-15` declares the recovery kind enum.
- `src/schemas/recovery-route-kind.ts:37-50` declares required-ref kinds separately.
- `src/schemas/recovery-route-kind.ts:92-188` validates some kind-specific rules in `superRefine`.
- `src/shared/work-contract-projection.ts:162-172` maps route ids to recovery kinds.
- `src/shared/work-contract-projection.ts:174-204` maps recovery kinds to allowed failure causes.
- `src/shared/work-contract-projection.ts:217-238` maps recovery kinds to required refs.
- `src/shared/work-contract-projection.ts:240-263` maps recovery kinds to operator authority and attempt budgets.
- `src/shared/work-contract-projection.ts:496-515` assembles each projected recovery binding from those separate helpers.
- `src/shared/work-contract-projection.ts:206-214` treats `retry` as target-sensitive: same-step retry is `retry_same_step_with_feedback`, while broad retry is `narrow_scope`.
- `tests/contracts/work-contract-projection.test.ts:328-335` protects that broad retry is not projected as same-step retry.

### Problem

One recovery kind's policy is split across schema validation, projection route labels, allowed causes, required refs, authority, and budgets. Adding or changing a recovery kind means updating several nearby-but-independent structures. This makes drift easy.

The concrete smell is `safe_apply_reject`: it is a valid `RecoveryRouteKind` and has causes/refs in projection policy, but no route id currently maps to it in `RECOVERY_BY_ROUTE`. That may be intentional future scaffolding, but the code has no ratchet saying whether the kind is deliberately unreachable or accidentally dead.

### Implementation Advice

Split the cleanup into two layers so schemas stay the inward contract layer:

1. Keep `RecoveryRouteKind`, required-ref schemas, and conditional binding validation in `src/schemas/recovery-route-kind.ts`.
2. Add schema-local contract rules for cause/ref requirements, such as `RECOVERY_KIND_CONTRACT_RULES`, and use them from `superRefine`.
3. Add a pure projection policy module outside `src/schemas`, such as `src/policy/recovery-route-policy.ts`, keyed by `RecoveryRouteKind`.

The projection table should derive a target-aware route resolver, authority, and budgets. It should reuse schema-owned contract rules for causes/refs instead of duplicating them:

```ts
import { RECOVERY_KIND_CONTRACT_RULES, type RecoveryRouteKind } from '../schemas/recovery-route-kind.js';

export const RECOVERY_ROUTE_PROJECTION_POLICY_EXCERPT = {
  retry_same_step_with_feedback: {
    selectors: [{ routeId: 'retry', target: 'same_step' }],
    contract: RECOVERY_KIND_CONTRACT_RULES.retry_same_step_with_feedback,
    operatorAuthority: 'not_required',
    attemptBudget: { consumesStepAttempt: true, retryTarget: 'same_step' },
  },
  narrow_scope: {
    selectors: [{ routeId: 'revise' }, { routeId: 'retry', target: 'different_step' }],
    contract: RECOVERY_KIND_CONTRACT_RULES.narrow_scope,
    operatorAuthority: 'not_required',
    attemptBudget: { consumesStepAttempt: false, retryTarget: 'declared_step' },
  },
  safe_apply_reject: {
    selectors: [],
    contract: RECOVERY_KIND_CONTRACT_RULES.safe_apply_reject,
    operatorAuthority: 'not_required',
    attemptBudget: { consumesStepAttempt: false, retryTarget: 'declared_step' },
  },
} satisfies Partial<Record<RecoveryRouteKind, RecoveryRouteProjectionPolicy>>;
```

The real table should be exhaustive over `RecoveryRouteKind`; the excerpt above only shows the target-sensitive cases.

Then derive:

- target-aware route resolution;
- allowed cause lists;
- required refs;
- operator authority;
- attempt budget defaults.

Keep special-case validation only for rules that are genuinely conditional on a concrete binding, such as same-step retry requiring `route_target === step_id`.

Do not derive `RecoveryRouteKind` enum options from projection policy. The enum is a schema contract. The reachability ratchet in Opportunity 2 ties the schema kind set to built-in projection coverage.

Do not collapse `retry` into a route-id-only lookup. The current semantics intentionally distinguish same-step retry from broad retry.

Do not change budget semantics while centralizing the table. Same-step retry consumes a step attempt; broad retry/narrow-scope recovery does not.

### Verification

Run:

```bash
npm run test -- tests/contracts/recovery-route-kind.test.ts tests/contracts/work-contract-projection.test.ts tests/runtime/runtime-baseline.test.ts
npm run check
```

### Watch-outs

Do not make recovery policy perform IO. The policy table should describe route meaning only. Any future restore/revert action must still happen through a StepKind executor reached by normal routing.

## Opportunity 2: Add A Recovery-Kind Reachability Ratchet

Roadmap fit: yes, as a guardrail paired with Opportunity 1.

Slot: immediately after centralizing recovery route policy.

### Evidence

- `src/schemas/recovery-route-kind.ts:5-15` includes `safe_apply_reject`.
- `src/shared/work-contract-projection.ts:189-194` has allowed causes for `safe_apply_reject`.
- `src/shared/work-contract-projection.ts:229-230` has required refs for `safe_apply_reject`.
- `src/shared/work-contract-projection.ts:162-172` has no route id that maps to `safe_apply_reject`.
- `tests/contracts/work-contract-projection.test.ts:248-264` proves projected recovery bindings are well-shaped when they exist.
- `tests/contracts/work-contract-projection.test.ts:291-294` only proves safe-apply failure causes exist, not that `safe_apply_reject` is reachable from a real route.

### Problem

The system has typed pieces of SafeApply recovery policy, but no test states whether each recovery kind must be projected by at least one built-in flow. This allows two bad states:

- a kind is intended to be live but no route projects to it;
- a kind is intentionally dormant, but no allow-list records that intent.

### Implementation Advice

Add a contract test that projects every built-in flow, collects `work_contract.recovery[].kind`, and compares it to an explicit allow-list:

```ts
const INTENTIONALLY_UNREACHABLE_RECOVERY_KINDS = new Set([
  'safe_apply_reject',
]);
```

The test should fail when:

- a kind becomes newly unreachable without joining the allow-list;
- a kind remains allow-listed after a built-in flow starts projecting it.

When `revert_applied_change` is added later, require it to become reachable in the same branch that adds the kind, unless the branch deliberately marks it dormant and explains why.

### Verification

Run:

```bash
npm run test -- tests/contracts/work-contract-projection.test.ts tests/contracts/recovery-route-kind.test.ts
npm run check
```

### Watch-outs

Do not block custom flows from using custom route labels. This ratchet should check built-in recovery policy coverage, not forbid external schematics from declaring routes that compile into normal graph edges.

## Opportunity 3: Make Baseline And Runtime-Touched-File Contracts Shared

Roadmap fit: yes.

Slot: after recovery policy, before restore execution or schema family barrels.

### Evidence

- `src/shared/runtime-touched-files.ts:1-17` already defines generic runtime git state snapshot entry and hidden-index flag types.
- `src/shared/runtime-touched-files.ts:29-40` defines a generic runtime touched-files projection shape.
- `src/shared/runtime-touched-files.ts:121-181` projects baseline/post git snapshots into observed touched files, declared-path comparison, hidden flags, and baseline-dirty mutation.
- `src/flows/fix/reports.ts:421-485` defines Fix-owned baseline snapshot schemas.
- `src/flows/fix/reports.ts:487-607` defines the Fix-owned change-set verdict.
- `src/flows/fix/writers/baseline-snapshot.ts:97-119` writes `fix.baseline-snapshot@v1`.
- `src/flows/fix/writers/change-set.ts:51-105` writes `fix.change-set@v1` by reading Fix reports and projecting the runtime diff.

### Problem

The pure projection concept is already shared, but the durable report contracts are still Fix-owned. That is fine while Fix is the only user. It becomes awkward as soon as Build, Pursue, restore, or safe-apply wants the same "before state plus post-worker touched files" contract.

The current shape says "Fix" in the schema names even where the concept is not Fix-specific:

- pre-worker git state;
- post-worker touched files;
- baseline dirty mutation;
- hidden index flags;
- worker-declared paths versus runtime-observed paths.

### Implementation Advice

Do this as an additive ownership change, not a broad rename.

1. Create shared Zod schemas for the generic contracts, for example:

   - `RuntimeGitStateSnapshotReport`;
   - `RuntimeTouchedFilesReport`;
   - `RuntimeHiddenIndexFlag`;
   - `RuntimeTouchedFile`.

2. Back them with the existing shared projection in `src/shared/runtime-touched-files.ts`.
3. Keep Fix as the first producer/user. Fix can continue emitting `fix.baseline-snapshot@v1` and `fix.change-set@v1` initially.
4. Add adapters that parse Fix reports into the shared shapes.
5. Only after a second consumer appears, introduce generic report schema ids such as `runtime.baseline-snapshot@v1` or `runtime.touched-files@v1`.

This gives ownership clarity without forcing a public report rename before the repo needs it.

### Verification

Run:

```bash
npm run test -- tests/runner/fix-change-set-writer.test.ts tests/runner/fix-runtime-wiring.test.ts tests/contracts/fix-report-schemas.test.ts
npm run check
```

If shared schemas are added under `src/schemas`, also run:

```bash
npm run test -- tests/contracts/schemas-barrel.test.ts
```

### Watch-outs

Do not move Fix result shaping out of the Fix package. The generic contract should stop at "what changed in the working tree." Fix still decides what those facts mean for a fix outcome.

## Opportunity 4: Keep Restore Result Outside Fix Ownership

Roadmap fit: yes, but contingent. The current checkout does not contain `restore.result@v1`.

Slot: same cluster as Opportunity 3, and before a restore executor is reintroduced.

### Evidence

- `src/flows/fix/reports.ts:5-17` maps every Fix artifact id to a Fix schema id.
- `src/flows/fix/reports.ts:19-31` maps every Fix artifact id to a Fix report path.
- `src/flows/fix/reports.ts:749-761` limits Fix result evidence pointers to Fix report ids.
- `src/flows/fix/reports.ts:774-789` makes `FixResult.evidence_links` an array of `FixResultReportPointer`, with min/max bounds tied to Fix report ids.
- `src/flows/types.ts:152-169` documents narrow engine flags for engine-visible behavior and says flags should describe behavior, not flow names.
- `docs/flows/authoring-model.md:350-352` says `CompiledFlowPackage.engineFlags` are for opt-in engine behavior the engine branches on.

### Problem

If restore is a generic runtime capability, its result report should not be modeled as a Fix result. Fix may be the first flow that routes through restore, but a restore result answers generic questions:

- what was restored;
- what could not be restored;
- whether restore failed closed;
- what baseline or touched-file contract it used.

Those are runtime/restore facts, not Fix outcome facts.

### Implementation Advice

When restore returns to this checkout:

1. Put restore schemas in a neutral module such as `src/schemas/restore.ts` or `src/runtime/restore/contracts.ts`.
2. Export them through the root schema barrel if they are public contracts.
3. If the Fix close writer needs to cite restore evidence, add an explicit generic evidence pointer shape or a `restore_result` field to `FixResult`. Do not add `restore.result` to `FixResultReportId` just to pass the current `evidence_links` enum.
4. Keep engine opt-in flow-neutral. A flag like `restoresAppliedChangesFromBaselineSnapshot` is acceptable because it names behavior, not Fix.
5. Route through a real `restore` StepKind executor. Do not make recovery binding execution perform restore directly.

### Verification

Run:

```bash
npm run test -- tests/contracts/schemas-barrel.test.ts tests/runner/fix-runtime-wiring.test.ts tests/runtime/runtime-baseline.test.ts
npm run check
```

If runtime files change, also run:

```bash
npm run build-plugin-runtime
npm run check-flow-drift
```

### Watch-outs

Do not strand `restore.result@v1` as an unused generic schema. Add it with the first restore executor slice or keep it out until the executor is ready.

## Opportunity 5: Add A StepKind Alignment Ratchet, Then Metadata If Needed

Roadmap fit: yes, but start with a ratchet. Add metadata only after the ratchet proves the duplication still creates real drag.

Slot: after recovery policy and before schema family barrels. It can be its own sub-step under the existing schema-family roadmap item.

### Evidence

- `src/runtime/domain/step.ts:5-5` defines the runtime `StepKind` union.
- `src/schemas/step.ts:66-87` defines compose and verification step variants.
- `src/schemas/step.ts:159-190` defines checkpoint and relay step variants.
- `src/schemas/step.ts:220-240` defines sub-run step variants.
- `src/schemas/step.ts:471-514` defines fanout and the final step union.
- `src/runtime/manifest/executable-flow.ts:46-99` repeats the executable step union.
- `src/runtime/manifest/from-compiled-flow.ts:104-150` converts each kind with a hand-written branch.
- `src/runtime/executors/index.ts:13-51` defines the executor registry and binds each kind to an executor.
- `src/shared/work-contract-projection.ts:53-155` repeats allowed field keys per step kind for projection classification.
- `src/flows/compile-schematic-to-flow.ts:62-81` has kind/report support logic for verification and checkpoint writers.

### Problem

Adding a new step execution capability requires touching a long list of parallel structures. Some of that is necessary. The awkward part is that the boring facts are hand-maintained in several places:

- kind name;
- executor type;
- required report/check shape;
- allowed projection keys;
- conversion branch;
- registry binding.

The repo has enough repetition to justify a stronger alignment check now. A small metadata source may be useful later, but it should not become another registry before it proves it removes more hand-maintained structure than it adds.

### Implementation Advice

Start with a contract test, not a table. It should compare:

- runtime `StepKind`;
- schema step kinds;
- executable-flow conversion branches;
- executor registry keys;
- work-contract projection keys.

Only after that ratchet exists, consider a tiny metadata table for the boring facts that still duplicate badly:

```ts
const STEP_KIND_METADATA = {
  compose: {
    executorType: 'orchestrator',
    writesReport: true,
    projectionKeys: ['id', 'title', 'protocol', 'reads', 'routes', 'selection', 'skill_slots', 'route_from_report', 'budgets', 'executor', 'kind', 'writes', 'check'],
  },
  relay: {
    executorType: 'worker',
    writesReport: 'optional',
    projectionKeys: ['id', 'title', 'protocol', 'reads', 'routes', 'selection', 'skill_slots', 'route_from_report', 'budgets', 'executor', 'kind', 'role', 'connector', 'acceptance_criteria', 'writes', 'check'],
  },
} as const;
```

If the table is added, use it first to derive `STEP_KEYS` in work-contract projection and to check executor registry completeness. Keep conversion and schema shape explicit until a second slice proves they can be derived cleanly.

Do not try to generate the Zod step union from this table in the first slice. Zod variants carry meaningful shape and comments; replacing them all at once would create churn.

### Verification

Run:

```bash
npm run test -- tests/contracts/step-schema.test.ts tests/contracts/work-contract-projection.test.ts tests/runtime/runtime-package-index.test.ts
npm run check
```

### Watch-outs

The table should make adding a kind harder to forget, not harder to understand. If it starts hiding shape-specific behavior behind callbacks, stop.

## Opportunity 6: Extract Fix Runtime Test Fixtures Later

Roadmap fit: low. Treat as test cleanup, not a main architecture item yet.

Slot: after the next restore/recovery test needs the same setup twice.

### Evidence

- `tests/helpers/runtime-flow.ts:165-204` already provides `runSimpleCompiledFlow`.
- `tests/helpers/runtime-flow.ts:340-359` has canned Fix baseline snapshot and change-set report bodies.
- `tests/helpers/runtime-flow.ts:822-870` has generic parity executors for compose, relay, verification, and checkpoint.
- `tests/runner/fix-runtime-wiring.test.ts:57-178` defines a Fix-specific verification override.
- `tests/runner/fix-runtime-wiring.test.ts:180-232` defines a compose override for Fix frame.
- `tests/runner/fix-runtime-wiring.test.ts:235-290` defines Fix relayer stubs.
- `tests/runner/fix-runtime-wiring.test.ts:293-301` manages temp run folders.
- `tests/runner/fix-change-set-writer.test.ts:47-121` builds another temp run-folder/report fixture for Fix change-set writer tests.

### Problem

Fix runtime tests now encode useful patterns:

- controlled temp run folders;
- relayer stubs that return typed reports;
- verification overrides that write runtime-owned reports;
- frame overrides that keep runtime tests fast.

Those patterns are valuable, but extracting them too early would add indirection. The right trigger is the next restore/recovery test that copies this setup.

### Implementation Advice

Wait until one more test needs the same pattern, then extract narrowly:

- `tests/helpers/fix-runtime.ts` for Fix-specific report writers and relayers;
- `tests/helpers/runtime-git-state.ts` for baseline/change-set report fixtures if the shared contracts land;
- keep generic helpers in `tests/helpers/runtime-flow.ts`.

The first extraction should not alter test scenarios. It should only move helper bodies and keep assertions in the test files.

### Verification

Run:

```bash
npm run test -- tests/runner/fix-runtime-wiring.test.ts tests/runner/fix-change-set-writer.test.ts
npm run check
```

### Watch-outs

Do not turn test helpers into a second runtime API. Helpers should make scenarios shorter, not hide the trace, report paths, or executor behavior that the tests are proving.

## Overlooked Adjacent Opportunity: SafeApply And Recovery Should Share Touched-File Vocabulary

Roadmap fit: yes, after Opportunity 3.

### Evidence

- `src/schemas/change-packet.ts:2-6` names `pre_safe_apply_trusted_write` as a work-root kind.
- `src/schemas/change-packet.ts:18-33` names SafeApply reason codes, including `touched_files_mismatch`, `protected_file_touched`, and `generated_surface_drift`.
- `src/schemas/guidance-decision.ts:13-20` names `safe_apply` as a guidance decision subject.
- `src/schemas/guidance-decision.ts:104-121` requires SafeApply selected decisions to carry action, change-packet ref, base ref, and final verification when applying.
- `src/schemas/guidance-decision.ts:414-467` validates SafeApply selected payloads, input refs, and evidence refs.
- `src/schemas/trace-entry.ts:121-123` requires SafeApply result refs to use kind `safe_apply`.
- `src/schemas/trace-entry.ts:180-193` defines the `safe_apply.result` trace shape.
- `src/schemas/trace-entry.ts:605-655` validates SafeApply result scope and ref alignment.
- `src/shared/runtime-touched-files.ts:21-40` already describes runtime touched files with generated-surface and protected-path flags.
- `docs/ideas/ratchet-data-requirements.md:743-745` notes that Build, Fix, and safe-apply paths should emit a shared touched-file summary.

### Problem

SafeApply, recovery, and Fix change-set all care about "what changed" and "was it safe." Today those concepts are present but spread across SafeApply refs/trace, Fix reports, and shared touched-file projection.

### Implementation Advice

After shared runtime touched-file schemas exist:

1. Let SafeApply result and recovery bindings reference the shared touched-file summary.
2. Keep SafeApply authority in guidance/trace contracts, not in memory or flow prose.
3. Add tests that `protected_file_touched` and `generated_surface_drift` recovery causes cite the same touched-file evidence shape.

### Verification

Run:

```bash
npm run test -- tests/contracts/guidance-decision-schema.test.ts tests/contracts/runtrace-schema.test.ts tests/contracts/recovery-route-kind.test.ts
npm run check
```

### Watch-outs

Do not make shared touched-file reports automatically authorize applying changes. They are evidence. SafeApply remains a separate authority decision.

## Harmonized Sequence

1. **Run transition characterization.** Keep the existing roadmap's Rank 9 prep. Pin current route, recovery, checkpoint, and hook order.
2. **Central recovery policy table.** Derive route-kind policy from one place.
3. **Recovery-kind reachability ratchet.** Make dormant kinds explicit and prevent new dead kinds.
4. **Shared baseline/touched-file schemas.** Lift the generic vocabulary while keeping Fix as the first user.
5. **Restore result ownership.** When restore execution returns, keep `restore.result@v1` outside Fix ownership.
6. **StepKind alignment ratchet.** Prove runtime kinds, schema kinds, conversion branches, executor keys, and projection keys stay aligned.
7. **SafeApply touched-file alignment.** Let SafeApply/recovery cite the same touched-file evidence.
8. **Fix test helper extraction.** Extract only when another test copies the same Fix runtime setup.

## Tensions And Resolutions

### Shared Contracts Versus Premature Public Renames

Fix-owned report ids are current public contracts. Do not rename them just to make the code feel cleaner. Add shared schemas/adapters first, then introduce generic report ids only with a real second user.

### Policy Table Versus Flow-Specific Routes

Centralizing recovery policy should not make all route labels global business logic. The table should define built-in recovery meaning. Flows still declare graph routes; projection interprets only the route labels the policy table owns.

### StepKind Ratchet Versus Metadata Gravity

A ratchet is useful immediately because the same kind set is repeated. A metadata table is only useful if it removes duplication after the ratchet names the repeated facts. A generated StepKind framework would be too much.

### Restore Capability Versus Recovery Purity

Recovery bindings describe why a route is allowed. They should not restore files. Restore must stay an executor action reached through normal graph routing.

## Fold-In Recommendation

When folding into `docs/architecture/architecture-improvement-roadmap.md`, treat this as an adjacent extension of **Make Run Transitions Explicit**, not as an unrelated later cleanup. Do this only after the earlier roadmap items, including Skill Hooks contract hardening, have landed or been refreshed. Put recovery policy and reachability before the transition classifier extraction; put shared restore/baseline ownership after that transition seam is named and before **Add Schema Family Barrels**:

**Recovery And Restore Contract Ownership**

Include these sub-items:

1. Centralize recovery route policy.
2. Add recovery-kind reachability ratchet.
3. Share baseline/touched-file contracts while keeping Fix as first user.
4. Keep restore result ownership generic when restore execution lands.
5. Align SafeApply/recovery touched-file evidence after the shared touched-file contract exists.
6. Add StepKind alignment ratchet, then metadata only if the ratchet proves the duplication is still painful.

Leave Fix runtime fixture extraction as a footnote or prefactoring checklist item, not a top-level roadmap item.
