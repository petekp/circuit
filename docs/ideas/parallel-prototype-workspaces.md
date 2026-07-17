# Parallel Prototype variants with isolated branch workspaces

Status: `current-proposal`. Created 2026-07-16. This work starts after the v1
announcement. Nothing here changes current behavior.

## Decision

Add a generic isolated-workspace policy for write-capable relay branches.
Prototype will be its first user.

Prototype will keep its existing bounded concurrency of two. Circuit will:

1. capture one starting snapshot of the project;
2. give each variant its own branch workspace;
3. run up to two variants at once;
4. prevent each parallel worker from reaching the parent or a peer workspace;
5. audit every changed path inside the branch workspace;
6. validate each surviving variant inside its workspace;
7. promote the declared variant output into the parent run folder; and
8. continue through the existing comparison and checkpoint.

If Circuit cannot enforce that workspace boundary, it will keep the current
sequential behavior and record the reason in the trace.

This is an engine capability. It is not a new flow and it should not become a
Prototype-only exception in the fanout executor.

## Current behavior

Prototype already asks Circuit to run two variant branches at once:

- `src/flows/prototype/assembly-spec.ts` declares bounded concurrency with a
  maximum of two;
- each branch receives its own
  `<prototype_root>/variants/<variant_id>` output directory;
- the join uses `aggregate-survivors`, so one failed branch does not discard
  good siblings; and
- the aggregate and checkpoint preserve authored variant order even when
  branches finish in another order.

The runtime reduces the effective concurrency to one. Write-capable relay
branches receive the same project root, so two workers could edit the same
checkout. `src/runtime/executors/fanout.ts` serializes them until Circuit can
give each branch its own write root.

The branch prompts already say "write only under `variant_root`." The report
schemas and verification step reject reported paths outside that root. Those
checks catch bad output after a worker finishes. They do not stop a worker from
touching another path while it runs.

The existing join and checkpoint are ready for parallel completion. Workspace
isolation is the missing part.

## Motivating measurement

A field run on 2026-07-15 built three variants in sequence:

| Branch | Duration |
| --- | ---: |
| Variant 1 | 6m 14s |
| Variant 2 | 15m 08s |
| Variant 3 | 7m 02s |

The run took about 28m 24s for variant construction. With the authored limit of
two, the same branch durations would take about 15m 08s. That saves about
13m 16s, or 47 percent.

This is one field observation, not a benchmark. It shows that serialization
dominates the wait when one variant is much slower than the others.

## Product outcome

The operator starts one Prototype tournament and waits for a bounded parallel
schedule instead of the sum of every branch duration.

Every parallel variant starts from the same project snapshot. Its runner denies
access to the parent project and peer workspaces, so one variant cannot inspect
or build on another variant's files. The comparison becomes faster and fairer.

The sequential fallback keeps today's trusted same-workspace posture. Circuit
must state that fallback and must not imply that it isolated those branches.

The review experience stays the same:

```text
one project snapshot
  ├── enforced variant workspace A ──┐
  ├── enforced variant workspace B ──┼── verify and promote accepted artifacts
  └── enforced variant workspace C ──┘
                                             │
                                             ▼
                                  compare → checkpoint → close
```

Live "two of three building" progress would improve the wait further, but it is
not required for the first slice.

## Required guarantees

The implementation must preserve these rules:

1. **Same starting point.** Every branch receives the same captured project
   state.
2. **Enforced write roots for parallel work.** The runner denies access to the
   parent project, peer workspaces, run evidence, and private Circuit state.
3. **No parent edits during construction.** Parallel branches cannot reach the
   parent project. Circuit promotes accepted artifacts after branch work
   finishes.
4. **Stable review paths.** The checkpoint reads artifacts from the parent run
   folder, never from temporary workspace paths.
5. **Complete mutation audit.** Circuit compares the starting snapshot with the
   finished branch workspace and rejects any changed path outside the exact
   `variant_root`.
6. **Contained output.** Circuit rejects path traversal, symlink escapes, and
   collected files outside the declared `variant_root`.
7. **Deterministic presentation.** The aggregate and checkpoint use configured
   variant order, not completion order.
8. **Survivor behavior.** One failed branch does not stop good siblings.
   Prototype still needs enough verified survivors to continue.
9. **Crash-safe collection.** Circuit stages and validates each artifact, then
   uses a platform-proven atomic promotion. A crash cannot leave a partial
   variant at the stable review path.
10. **Honest trace.** The trace records configured and effective concurrency,
    workspace posture, branch timing, changed paths, artifact collection,
    cleanup, and any fallback to sequential execution.

Parallel execution changes elapsed time. It does not reduce the number of
models called or their token cost. It increases peak provider usage, so the
bound stays at two until real runs justify another default.

## Proposed runtime shape

### An explicit branch workspace policy

A write-capable relay branch needs an opt-in workspace declaration. The exact
field names remain provisional:

```json
{
  "execution": {
    "kind": "relay",
    "role": "implementer",
    "workspace": {
      "kind": "isolated",
      "output_root": "$item.variant_root"
    }
  }
}
```

The runtime honors the configured fanout concurrency once every write-capable
branch receives an enforced branch workspace. Otherwise it keeps effective
concurrency at one.

The policy belongs in the generic fanout contract. Other flows can use it later
without adding flow-specific engine flags.

### A branch workspace provider

The fanout executor should depend on a small workspace interface instead of
calling Git worktree commands inside the executor:

```ts
interface BranchWorkspaceProvider {
  prepare(input: BranchWorkspaceInput): Promise<BranchWorkspace>;
  inspectChanges(workspace: BranchWorkspace): Promise<BranchMutationManifest>;
  stageArtifact(input: BranchArtifactCollection): Promise<StagedArtifact>;
  destroy(workspace: BranchWorkspace): Promise<void>;
}
```

`prepare` creates a branch project root from the shared snapshot and reports
the enforcement posture. `inspectChanges` returns every path added, changed, or
deleted relative to that snapshot. `stageArtifact` copies the declared output
root into an attempt-specific staging directory in the parent run folder.
`destroy` removes temporary files after collection.

The runtime rejects a branch when its mutation manifest contains a path outside
the exact `variant_root`. It validates the staged artifact and promotes it to
the stable review path through a platform-proven atomic operation. The trace
records a collection intent before staging and a receipt after promotion.

The provider can grow without changing the flow:

| Project state | Workspace direction | Required proof |
| --- | --- | --- |
| Clean Git project | Self-contained snapshot from one frozen commit inside an enforcing runner | Same base and denied parent or peer access |
| Dirty Git project | Enforced snapshot with accepted staged, unstaged, and untracked files | Branch content matches the captured state |
| Non-Git project | Enforced filesystem snapshot, using copy-on-write when available | Copy is complete, bounded, symlink-safe, and contained |
| Unsupported or unsafe case | Sequential fallback | Trace names the reason |

The field case that prompted this proposal used a non-Git project. A Git-only
solution would miss it.

### Branch-specific relay context

Each branch must receive its workspace as the relay working directory. The
runtime should create a branch-specific context rather than mutating the shared
parent context.

The relay still returns `prototype.variant-artifact@v1`. Project-relative
artifact paths keep the same shape inside the temporary workspace and after
Circuit copies them into the parent project.

### Artifact collection before cleanup

Circuit must collect the variant before deleting its workspace:

1. parse and validate the branch report;
2. compare the finished workspace with its starting snapshot;
3. reject any changed path outside `variant_root`;
4. resolve `variant_root` inside the branch workspace;
5. reject symlinks and resolved paths that leave that root;
6. append a collection-intent trace entry;
7. copy the root into an attempt-specific staging directory;
8. validate the staged tree and its digest;
9. commit the stable variant path through a platform-proven atomic promotion
   and append a collection receipt;
10. verify the promoted files from the parent project; and
11. remove the branch workspace.

A branch whose report passes but whose artifact cannot be collected counts as
failed. The aggregate must not admit it.

An interrupted collection leaves an attempt-specific staging directory, not a
partial stable variant. Recovery removes or resumes that staging attempt by its
recorded identity. A retry replaces the stable destination through a new atomic
promotion.

## Isolation posture

A separate directory reduces ordinary collisions. It does not enforce a write
boundary. Parallel execution needs a connector or outer runner that denies
access to the parent project, peer workspaces, evidence, and private Circuit
state.

Circuit should state the posture in the trace:

- `enforced-workspace`: the connector or outer runner prevents writes outside
  the branch workspace; or
- `trusted-local-workspace`: separate project root plus mutation auditing, kept
  at effective concurrency one; or
- `sequential-shared-workspace`: current safe fallback.

Effective concurrency above one requires `enforced-workspace`.
`trusted-local-workspace` can support development spikes or sequential work,
but Circuit must not describe it as parallel isolation.

The stronger workspace rules in
[`cli-first-principles.md`](cli-first-principles.md) remain the long-term
direction. If that substrate lands first, this proposal should use it. If this
proposal lands first, its provider boundary should be replaceable by that
substrate.

## Failure and cleanup behavior

- **Workspace setup fails:** fall back to sequential execution before starting
  write-capable branches. Record the provider error and effective concurrency.
- **One branch fails:** continue the others, matching Prototype's current
  `continue-others` policy.
- **Artifact collection fails:** reject that branch, keep the stable destination
  unchanged, and preserve its report and trace evidence.
- **Collection is interrupted:** remove or resume the attempt-specific staging
  directory from the recorded intent. Never merge it with a later attempt.
- **Cleanup fails:** keep the primary outcome, record the leaked workspace, and
  let the existing reaper or a workspace-provider reaper reclaim it.
- **The run is canceled:** stop active connector processes before deleting their
  workspaces. Current fanout cancellation does not yet terminate workers that
  already started, so the build must close that gap or state the limitation.

## Why Prototype should be first

Prototype has the easiest useful join:

- branches produce disposable artifacts;
- every artifact has its own declared destination;
- Circuit keeps all verified survivors for human comparison; and
- no branch patch needs to merge into production code.

The older sandboxed parallel Pursue idea, now summarized in
[`deprioritized-ledger.md`](deprioritized-ledger.md), requires change packets,
overlap detection, conflict handling, and final application into the parent
checkout. Prototype proves the branch workspace and collection substrate
without taking on safe code merge.

## Rejected shortcuts

### Let Prototype bypass serialization

Distinct `variant_root` values reduce expected overlap. They do not restrict a
write-capable connector to those paths. Post-run verification can discover
damage only after it happens.

This is useful as a no-spend test harness. It is not the product contract.

### Convert each variant into a child flow

Sub-run branches already receive Git worktrees, but this route adds an internal
single-variant flow and changes how branch results reach the aggregate. It also
does not cover non-Git projects.

The workspace capability belongs on relay fanout.

### Start with remote sandboxes

Containers, VMs, and remote runners can provide enforced isolation. Remote
runners also add startup cost, credential policy, network policy, and artifact
download.

The provider interface should allow remote backends without requiring them.
The first provider can use a local OS sandbox or container if it proves the
same deny rules.

## Post-v1 build slices

### Slice 1: no-spend concurrency proof

Use fake write-capable connectors that sleep and create distinct artifacts.

Prove:

- two branches overlap in time;
- the aggregate remains in configured order;
- one failure does not stop a survivor; and
- configured and effective concurrency appear in the trace.

### Slice 2: workspace and snapshot providers

Add the generic branch workspace interface and branch-specific relay context.

Cover:

- one clean Git fixture;
- one dirty Git fixture with approved untracked files;
- one non-Git fixture;
- parent, peer, evidence, symlink, and path-escape attempts; and
- an honest sequential fallback.

The provider must decide how to handle large ignored dependency trees such as
`node_modules`. Copying them may be too expensive, while writable symlinks back
to the parent would break isolation. Settle that with a measured spike.

### Slice 3: Prototype artifact collection

Opt Prototype into the workspace policy. Copy each verified `variant_root` into
the stable parent run folder before cleanup.

Delete every branch workspace before rendering the checkpoint. Every iframe and
entry-point link must still load.

### Slice 4: cancellation and crash cleanup

Thread cancellation through fanout, relay, connector, and subprocess control.
Extend workspace ownership records so a killed run leaves reclaimable
workspaces without losing collected artifacts.

### Slice 5: real connector proof

Run two small HTML variants through different supported connectors.

The proof must show:

- overlapping relay times;
- effective concurrency of two;
- usable checkpoint previews after workspace cleanup;
- provider evidence for both branches;
- denied writes to the parent project, a peer workspace, and run evidence;
- a complete mutation manifest containing no path outside `variant_root`;
- no lasting project edits outside the parent run folder; and
- the same result shape and checkpoint choices as the sequential path.

## Acceptance gate

Before calling the idea built:

1. focused fanout concurrency and failure tests pass;
2. Git, dirty Git, and non-Git workspace fixtures pass;
3. Prototype runtime and checkpoint tests pass with temporary workspaces deleted;
4. generated flow and host surfaces are refreshed;
5. `npm run check-flow-drift` passes;
6. `npm run verify` passes; and
7. one real two-connector run records effective concurrency of two.

## Scope and timing

This proposal is parked until after the v1 announcement. The current launch
freeze remains unchanged.

After v1, this is a strong lever on an existing differentiator. It shortens the
time between starting a model-comparison Prototype and reaching the human
review without adding a new flow or changing the checkpoint contract.
