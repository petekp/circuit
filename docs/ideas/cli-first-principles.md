# Circuit CLI rebuild plan

Status: implementation plan, held for post-v1 execution (decided 2026-07-12).
This document describes target behavior, not current behavior. Phase 0 shipped
on 2026-07-11. The remaining work replaces the CLI control plane and the
execution seams that prevent safe cancellation and recovery. The architecture
decision stands on its own merits, but no phase past Phase 0 starts before the
v1 announcement. Pre-release CLI work is limited to hardening the current
surface: bug fixes and fit-and-finish that change no contracts.

## Decision

Circuit will keep its repository, flows, schemas, connectors, trace, reports,
evidence, generated host surfaces, and proof suite. It will replace the CLI and
run-ownership boundary, plus the parts of execution that cannot support
cancellation or crash recovery.

The target uses an on-demand user supervisor. The supervisor starts when a
client needs it and exits after its workers finish and the idle period passes.
Each root Invocation gets one worker. Nested child Runs stay inside that
worker's execution tree. The worker writes durable run evidence. The supervisor
owns private process-control requests, acceptance receipts, runtime pins, and
local RPC. Workers hold execution and apply locks.

Every Run starts in an isolated workspace and initially counts as write-capable
for scheduling. Circuit never starts a second
worker because a timestamp expired. It proves that the old worker has stopped,
then starts a new fenced Invocation. A crash during an effect with an unknown
result parks the Run for reconciliation. Circuit does not replay that effect.

This design gives direct terminal users, Claude, Codex, and scripts one
capability model. Each client renders that model for its own surface.

## Phase 0: complete

Commit `5523f8fd` fixed installed built-in flow lookup. The current loader keeps
checkout behavior and falls back to package-relative flows when the current
directory has no generated flows. The packed release gate proves flow loading
from an unrelated directory without spend. Commit `bc50880c` regenerated the
host bundles, corrected the checkpoint exit-code prose, and reconciled the
first CLI design note with current vocabulary.

Evidence:

- [Installed flow resolution](../../src/cli/compiled-flow-loading.ts)
- [Packed-install release gate](../../scripts/release/check-npm-package-install.ts)
- [Checkpoint exit behavior](../operator-guide.md)

Phase 0 stays closed. The later Asset Provider work replaces implicit asset
discovery as part of the new control plane. It does not reopen the package fix.

## Review of the prior proposals

The table records the disputed claims from Claude's review, the earlier plan,
and the adversarial review. “Corrected” means the proposal found a real need but
named the wrong boundary or guarantee. “Genuinely unresolved” means a named
spike must decide between bounded implementations; it is not permission to
leave the product contract vague.

| Claim | Decision | Evidence and correction |
| --- | --- | --- |
| A background worker is the foundation for detach | Corrected | Detach needs a worker, but a durable Run may span several Invocations and may park with no process. Use one worker per root Invocation under an on-demand supervisor. [Run and Invocation IDs](../../src/schemas/ids.ts), [checkpoint wait](../../src/runtime/executors/checkpoint.ts) |
| One worker should exist for every Run ID | Rejected | Child Runs have their own IDs but execute inside the parent's process. A worker owns one root execution tree. [Sub-run execution](../../src/runtime/executors/sub-run.ts), [fanout child execution](../../src/runtime/fanout/branch-execution.ts) |
| A lease should replace engine heartbeat events | Corrected | The secure lease reports worker ownership and health. Remote clients receive lease-derived liveness frames. Those frames are transient and never enter the Trace or replay feed. [Current process model](../architecture/run-process.md), [ProgressEvent schema](../../src/schemas/progress-event.ts) |
| The current engine can gain cancellation at the CLI boundary | Rejected | The runtime has no cancellation capability and verification still blocks the event loop with `spawnSync`. Cancellation requires a token through every executor and child process. [Runtime capabilities](../../src/runtime/run/capabilities.ts), [proof command execution](../../src/shared/proof-plan.ts) |
| A detached worker provides crash and reboot recovery | Rejected | Current interrupted Runs cannot resume, and effect settlement alone does not recover route, loop, retry, or FlowData state. New storage-v2 topologies need effect intent/receipt/reconciliation plus a complete `SafeReentryReceiptV1`; unsupported topologies remain restart-only. [Interrupted resume test](../../tests/runner/resume-interrupted.test.ts), [relay effect boundary](../../src/runtime/executors/relay.ts) |
| Read-only Runs may share a checkout | Corrected | Current “read-only” custom connectors are trusted processes, and verification commands can write. Initial concurrency requires isolation or enforced OS-level read-only execution. [Host capability contract](../contracts/host-capabilities.md) |
| Persist a second milestone feed beside the Trace | Rejected | Trace persistence succeeds before progress projection, and projector failures are swallowed. The public feed must be a rebuildable Trace projection. [Trace store](../../src/runtime/trace/trace-store.ts), [progress projection](../../src/runtime/projections/progress.ts) |
| `RunPlanV1` can freeze exact model and step behavior | Corrected | Power `auto`, retries, loops, and fanout resolve work during the Run. `RunPlanV1` freezes launch inputs, authority, limits, and allowed dynamic choices. [Power inference](../../src/runtime/run/graph-runner.ts) |
| Root separation should precede broad packaging work | Confirmed | Project, config, package, run, state, data, cache, and runtime-endpoint roots need one resolver each. Current config and Run paths still depend on ambient cwd. [Config loader](../../src/shared/config-loader.ts), [control-plane paths](../../src/shared/control-plane-paths.ts) |
| Runtime ownership can move with Homebrew and WinGet work | Rejected | Claude, Codex, npm, and a direct binary can carry different runtimes into the same run store. Shared version authority and protocol negotiation are foundational. Package-manager breadth is later work. [Plugin runtime resolver source](../../plugins/shared/launcher-core.ts) |
| Host plugins are self-contained today | Rejected | Both plugin shims require ambient Node 22.18 or newer. [Claude shim](../../plugins/claude/scripts/circuit.js), [Codex shim](../../plugins/codex/scripts/circuit.js) |
| Node single-executable support should define the package | Genuinely unresolved | Circuit uses `process.execPath` as a Node interpreter for a helper. A private Node distribution is the committed fallback; the packaging spike decides whether SEA can replace it without changing the runtime contract. [Git-state helper command](../../src/shared/git-state-command.ts), [Node SEA documentation](https://nodejs.org/api/single-executable-applications.html) |
| Config v1/v2 migration may be fighting a ghost | Rejected | Version 1 selection config and version 2 policy envelopes are separate document families on the same path. Version 3 is reserved for the next Config shape. [Config contract](../contracts/config.md), [schema versioning](../contracts/schema-versioning.md) |
| Structured stdin for goals closes a real security and reliability gap | Confirmed | Host agents need a request shape that avoids shell interpolation. Goal text and structured requests gain mutually exclusive stdin/file forms. [Current Run parser](../../src/cli/run.ts), [host adapter](../contracts/host-adapter.md) |
| Human output can become the default before hosts move | Rejected | Hosts parse final JSON from stdout and ProgressEvent JSONL from stderr. Host adapters must pass explicit formats before the default changes. [Host adapter contract](../contracts/host-adapter.md), [run stdout envelope](../../src/cli/run-stdout-envelope.ts) |
| Exit 3 and 130 can replace current behavior at once | Corrected | The new plane uses exit 3 for any human action required, including launch approval and a parked checkpoint. Exit 130 means the local attached client received SIGINT. A Run canceled by another client is a terminal non-complete outcome and exits 1 from `wait`. |
| Ratify every contract before the spikes | Rejected | Root, grammar, compatibility, and format decisions can land first. Lifecycle, event, recovery, and worker contracts follow the failure probes. |
| Build beside the old path, then delete everything at the end | Corrected | Circuit gets one user-visible cutover. Internally, each old command moves onto the new use cases as its replacement lands. CI tracks remaining consumers from the first slice. |
| Existing commands should be rebuilt under new names | Rejected | History, memory, handoff, reclaim, config, and the current flow authoring commands keep their behavior through adapters or explicit moves. |
| Announcement timing should choose the architecture | Rejected | Product scheduling is a separate decision. This plan has no release-freeze assumption. |

## Product rules

1. **The Run outlives a terminal.** Closing a viewer cannot destroy work or
   evidence.
2. **One capability model serves every client.** Terminal, host, and script
   presentations may differ. Their allowed actions and semantic data do not.
3. **The Trace stays the truth.** Public events, reports, replay, and status
   derive from durable run evidence.
4. **Circuit shows the launch contract before spend.** Unknown cost or time
   stays labeled unknown.
5. **Consequences drive confirmation.** `--no-input` removes prompts. It does
   not grant authority. `--yes` grants the approvals named in the plan.
6. **Every failure names a remedy.** Human and structured errors carry the same
   problem, retry posture, and next actions.
7. **Healthy defaults write no config.** Personal setup and project setup stay
   separate.
8. **Process control stays private.** A project file can describe a Run. It
   cannot authorize Circuit to signal a process.
9. **Recovery never guesses.** Circuit retries only when the effect contract
   proves that a retry is safe.
10. **Compatibility has an end date.** Adapters protect current hosts during
    migration. New work does not create a permanent second runtime path.

The product framing remains: repeatable process is the product; evidence is
the truth floor. Use the terms in [Ubiquitous Language](../../UBIQUITOUS_LANGUAGE.md).

## Target architecture

```text
terminal CLI ─────┐
Claude adapter ───┼── versioned local RPC ── on-demand user supervisor
Codex adapter ────┤                              │
CI / scripts ─────┘                              ├── persistent private control state
                                                   │   receipts, queues, leases, fences, pins
                                                   │
                                                   └── root Invocation worker
                                                        │
                                                        ├── nested child Runs
                                                        ├── cancellable effects
                                                        └── durable Run folders
```

The supervisor is a small local daemon with an idle exit. It owns no flow
logic and no worker-lifetime lock. It performs these jobs:

- Authenticate local clients over a Unix socket or Windows named pipe.
- Resolve and pin the runtime version for each Invocation.
- Win a single-user election and enter a recovery barrier before scheduling.
- Serialize ownership changes with a monotonic fencing epoch.
- Track worker health without treating timeout as proof of death.
- Allocate short scheduling reservations. The process doing protected work
  holds the execution or apply lock itself.
- Route cancellation and wait requests.
- Maintain a small cross-project run locator.

Durable detach also requires a per-user activation adapter. The supported
adapters are a launchd user agent on macOS, a systemd user socket/service on
Linux, and a per-user Windows service or task with equivalent restart proof.
They start the supervisor on demand and restart it only after abnormal exit.
The supervisor marks an authenticated normal idle exit so the adapter does not
restart it. A platform or installation that cannot provide restart-on-failure
activation offers foreground execution only; it cannot claim detach. Every
restart enters the recovery barrier before scheduling. The acceptance case
kills the supervisor with worker A active, Run B queued, and no client attached;
both Runs must still progress to their correct outcomes.

The activation target is a transport-neutral signed `circuit-control` launcher
at the never-moved bootstrap anchor, never a package-manager, host-plugin, or
relocatable data-root path. It verifies the fixed discovery slot and root-set
generation, then selects the content-addressed controller from user data.
Runtime references retain that controller, and incomplete install or relocation
transactions retain any old launcher, while a worker, queued Run, control
transaction, or drain receipt exists.

The worker owns one root execution tree for one Invocation. It runs the existing
flow engine and nested child Runs. It owns connector child processes, holds the
project execution and Run append locks for its active lifetime, and writes the
root and child Trace files.
The worker that performs an Apply also holds its physical mutation-domain
barrier exclusively. Those
locks therefore survive a supervisor crash. The worker uses the runtime version
stored in the accepted Run plan.

`StableSupervisorElectionV1` is independent of every relocatable root. A
platform-fixed `BootstrapDiscoverySlotV1` first locates its machine-scoped
bootstrap anchor. That anchor contains the `UserRootSetV1` locator, one
never-moved election lock, and the relocation journal. Full-durable activation
also uses one stable OS service identity: launchd/Mach service on macOS, the
systemd user unit/socket on Linux, and a user-SID named service/mutex on
Windows. A root relocation holds this same election authority before, during,
and after locator publication; it never hands off from an old lock path to a
new one.

The runtime directory contains only generation-named sockets/pipes and
replaceable boot-scoped handles. `RuntimeEndpointGenerationV1` records endpoint,
boot, election, and supervisor-process generations; unique socket/pipe name;
owner/ACL and challenge digests; publication time; and
`reserved|bound|published|retired|cleaned` state.

`EndpointPublicationTxnV1` runs while holding stable election: private CAS
reserves a monotonic generation and unique path; the supervisor binds it and
passes an authenticated self-probe; private CAS publishes it as current; then
the prior generation may become `retired` after its authenticated probe fails.
Unix cleanup unlinks only that retired generation and syncs the parent; Windows
records named-pipe disappearance. Worker or containment emptiness is not
required because endpoint files carry no process authority. Cleanup never
changes a lease, fence, pin, or containment record.

Clients and workers re-read the atomically published endpoint descriptor after
connection failure. The successor may publish before recovery completes so
surviving workers can re-register, but every scheduling/mutation RPC remains
behind `StartupRecoveryBarrierV1`. A restarted supervisor schedules nothing until it has
scanned every nonterminal control record and done one of three things: securely
re-registered the named worker, observed its exact process identity exit, or
when the OS boot identity changed, committed `BootEpochExitProofV1`; otherwise
it marks ownership unknown and blocks that Run and project. A lease timeout
alone never satisfies this barrier.

Client authority is connection-bound. Peer UID or SID authenticates the local
client, then the supervisor issues an in-memory capability for one allowed RPC.
Workers alone receive a sealed Invocation capability through an inherited
private handle. No bearer mutation or process-control capability enters argv,
ordinary environment variables, project files, Trace, or child stdin. Public
decision/token strings are non-bearer version selectors: they require the
authenticated caller identity named by their live private receipt and grant
nothing by themselves. A receipt may deliberately scope that identity to the
OS user, as force decisions do, or to a narrower stream connection/caller.
Effect launch closes every
control handle and removes persistent control-state and runtime-endpoint paths
from its environment.

Every durable-v2 effect also runs through a platform isolation adapter. Its
filesystem view contains one writable Run workspace, explicit digest-bound
read-only dependency and toolchain mounts, and brokered input/output channels.
It denies the base checkout, private state, runtime endpoint, project
evidence, and every peer Run root. An escaping symlink is rejected before
launch. Without those enforced boundaries, the connector is not eligible for
durable detach and must use the explicit trusted in-place foreground profile.
These rules protect against project code reacquiring ordinary Circuit authority
or bypassing Apply. They do not claim to defeat arbitrary malware, a debugger,
or other code already holding the full operator account. A custom connector
installed outside the enforced adapter is privileged user code, and setup
labels that boundary plainly.

The project stores truth. The private user store controls processes. Neither
store replaces the other.

## Lifecycle contracts

### Run, Invocation, and worker

The existing language defines a Run as one execution of a Flow. The rebuild
adds an explicit process epoch inside that Run.

| Object | Lifetime | Identity | Owner |
| --- | --- | --- | --- |
| Run plan | Reusable only while `available`; abandon or expiry closes new starts, while bytes/references remain until prune | `plan_id`, `plan_sha256`, and `plan_artifact_sha256` | Project plan store plus private plan receipt; each Run copies it |
| Run | From accepted start through a terminal outcome | `ProjectInstanceId` plus `RunId` | Durable Run folder |
| Invocation | One attempt to execute, control, or resume a root Run | `InvocationId` plus fencing epoch | Current append authority |
| Worker | While one root Invocation executes | worker UUID and process birth identity | Worker process |
| Child Run | While a sub-run or fanout branch executes | Child `RunId` | Same root worker |
| Viewer | While a client watches | Connection ID | Client process |

One Run may have several Invocations. Only one Invocation may own it at a time.
One worker may own several nested Run IDs because child Runs stay inside the
root execution tree.

`RunId` remains the short public display value and existing host field. Private
locator, idempotency, control, and mutation authority use the composite Run
identity. An exact display ID outside a selected project that matches more than
one instance returns a bounded project-choice action on a TTY and requires
`--project-root` in scripts; it never chooses the newest or first registry row.

Every runtime call receives one explicit `ExecutionContext`:

```text
project_root     stable checkout selected by root resolution
run_root         durable evidence folder for this Run
workspace_root   isolated execution checkout
root_run_id      root of the execution tree
parent_run_id    absent only for the root
invocation_id    current root Invocation
fencing_epoch    current writer epoch
```

Durable project identity never silently changes to the isolated workspace.
Child manifests record their root, parent, workspace, accepted plan digest, and
runtime digest. A parent cannot close while a descendant is nonterminal.

Start has separate durable acceptance and execution handshakes:

1. Resolve project, snapshot, config, capabilities, runtime, and one authorized
   unconsumed StartTicket. Authorization is either a consequence-free
   `NoApprovalRequiredReceiptV1` or an explicit `ApprovalDecisionV1`; hashes
   alone grant neither.
2. Allocate Run ID and store the exact canonical plan artifact bytes in an
   immutable private launch capsule. Sync a `preparing` receipt containing both
   plan hashes, StartTicket/start-authorization hashes, idempotency key, runtime
   reference, and capsule hash. The same private CAS consumes the ticket.
3. Install the project Run folder from that capsule.
4. Launch a short init worker through the gated-launch protocol below. It takes
   Run append only for its individual Trace phases, verifies capsule against
   project bytes, syncs `run.accepted`, and enqueues through `EnqueueTxnV1` with
   cause `initial`. It never takes the project execution lock or admits an
   effect.
5. Report the Run accepted only after the enqueue reaches `runnable`. Detached
   exit 0 means durable queue acceptance,
   even when another Run owns the project. Attached clients continue waiting.
6. The scheduler orders queued Runs per project by accepted time then Run ID.
   A queued item becomes launch-eligible only after the init Invocation's exact
   exit is mirrored and no predecessor is live or ownership-unknown. When
   project execution is available, the scheduler reserves the one project
   scheduling claim and launches the execution worker. That worker takes
   project execution then Run append, verifies the capsule,
   appends `invocation.started`, commits the initial `SafeReentryReceiptV1`,
   then appends `run.running`, opens control, and reports ready. No engine
   transition or effect is admitted before all three entries are synced.

An accepted `--in-place --foreground` plan uses steps 1–5 unchanged, but its
queue item is marked `foreground_only`. The background scheduler cannot claim
it. The attached controller takes the one project scheduling claim and enters
`ForegroundInvocationTxnV1`; if that controller disappears before the worker
gate opens, exact-exit recovery returns the Run to queued or interrupted and no
daemon starts it. A later explicit `resume --foreground` may claim it under the
state rules below.

`EnqueueTxnV1` is the only root queue-entry path. Initial start, checkpoint
answer, interrupted re-entry, reconciliation continuation, launch retry, and a
later root Apply all use it. A required pre-close Apply is already inside the
owning execution tree and never enters this queue:

| Phase | Durable boundary | Runnable? | Recovery |
| --- | --- | --- | --- |
| `reserved` | Private CAS allocates queue generation, cause, causal Trace hash, and authenticated `QueueAuthorityReceiptV1` | No | Reuse the exact private queue identity |
| `evidenced` | Fenced worker appends `queue.prepared` with the authority-receipt digest | No | Advance only when the exact private reservation still exists; missing authority is repair-required |
| `committed` | Private queue record commits against the `queue.prepared` hash | No | Recovery worker appends the exact visible state |
| `visible` | Fenced worker appends `run.queued` referencing the private commit | No | Mirror the Trace hash only into the existing private transaction; project evidence cannot recreate it |
| `runnable` | Private CAS stores the `run.queued` hash | Yes | Return the existing queue item |

The transaction alternates authorities without reversing the lock order:

| Phase | Actor and locks |
| --- | --- |
| `reserved` | Supervisor/recovery takes only the user-store transaction lock, commits the reservation, then releases it |
| `evidenced` | Fenced init/control/recovery worker takes Run append, verifies the exact reservation generation/digest and current control state, appends once, then releases Run append |
| `committed` | Supervisor/recovery takes only the user-store lock and CASes against the evidenced Trace hash |
| `visible` | Fenced worker reacquires Run append, verifies the private commit and every intervening control/Trace entry, appends once or records supersession, then releases it |
| `runnable` | Supervisor/recovery takes only the user-store lock and CASes against the visible Trace hash |

No process holds Run append while requesting a private phase. Other legal Trace
entries may interleave while the lock is released; each next phase names its
causal hash, queue generation, and highest control sequence and either advances
that exact transaction or follows cancellation/supersession. A runtime
lock-order assertion and failure injection cover every release/reacquisition.

`QueueAuthorityReceiptV1` is authenticated by a machine-private controller key
and binds Run/project identity, queue generation/cause, causal safe-reentry
authorization when required, and the transaction nonce. A checksum-framed
project entry proves evidence integrity, not scheduling authority. If the
private reservation or authenticated receipt is missing, recovery may preserve
and export the Trace but must return `PROJECT_REPAIR_REQUIRED`; it may never
mint a queue item from `queue.prepared` or `run.queued` alone. Private state may
repair a missing project projection, never the reverse.

The cause is one of `initial`, `checkpoint_answer`, `interrupted_reentry`,
`reconcile_continue`, `launch_retry`, or `linked_apply`; `linked_apply` means a
later root Apply only, and the two continuation causes require the exact
`SafeReentryReceiptV1` named by their reservation. Cancellation compares
the same queue generation. Before `visible` it supersedes the enqueue; after
`visible` it follows queued cancellation. All retries reuse the reservation
IDs. Exhausted init retries terminalize the accepted Run as `aborted` through
the ordering gate; they never leave it permanently `interrupted`.

Worker launch is role-neutral. `InvocationLaunchTxnV1` begins from exactly one
of these durable authorities:

| Role | Reservation authority |
| --- | --- |
| `init` | Accepted preparing receipt, installed Run folder, no live or ownership-unknown init Invocation, every prior init exit mirrored, and matching retry generation |
| `control` | Exact outstanding control transaction and no current Run owner |
| `recovery` | Single-use `RecoveryWorkReceiptV1` plus completed startup barrier and proved predecessor exit |
| `execution` | Earliest runnable queue item, proved enqueuing-Invocation exit, no live or unknown predecessor, and one project scheduling claim |

The reservation stores launch ID, Run ID, a new Invocation ID and fencing
epoch, role and cause, predecessor Invocation when present, causal private
generation and Trace hash, queue generation or control request IDs when
applicable, runtime and capability digests, requested platform adapter, and a
creation nonce. It is the duplicate-start fence, but it is not permission to
create a process. A complete `launch.intent` does not exist until the actual
empty launch slot has been created or reopened and synced. Before a child has
existed, recovery reuses the reservation. Once a child has existed, that
Invocation identity is spent: an early exit completes `InvocationExitTxnV1`,
and any retry receives a new launch ID, Invocation ID, and fence. Ordinary Flow
steps are not described as idempotent.

The execution scheduler reserves only through this transaction; queue
`runnable` by itself grants no launch. Init, control, and recovery authorities
use the same transaction without first entering the execution queue. This
closes the circular first-worker path while preserving one containment and
duplicate-start contract for every worker role. If an execution launch wins
before cancellation, the gated worker must import that cancellation before
`run.running` or an effect.

`InvocationLaunchTxnV1` has this private state machine:

| Phase | Durable boundary | Process may exist? | Recovery |
| --- | --- | --- | --- |
| `launch_reserved` | The role's authority CAS stores the reservation and removes that work item from eligibility | No | Reuse the reservation; another launcher cannot claim it |
| `slot_prepared` | Create or reopen the deterministic empty slot, then private-CAS a complete `launch.intent` containing its verified authority | No | Reopen by stable locator and nonce; prove empty before advancing |
| `child_placed` | Platform adapter atomically creates the bootstrap inside that exact slot; the guardian syncs child birth identity and membership before acknowledging | Yes, behind a closed gate | Authenticate that exact child or prove the slot empty; never spawn speculatively |
| `child_recorded` | Private CAS imports the guardian record and verifies the complete intent, child identity, containment membership, and closed gate | Yes, behind a closed gate | Reimport the guardian record or prove exit and close the failed attempt |
| `launch_authority_prepared` | Guardian durably records the role's exact `execution_armed|control_only|reconciliation_probe_only|settlement_only` disposition and any required deadline arm | Yes, behind a closed gate | Reconcile the same disposition/arm; never create a new deadline |
| `gate_released` | Guardian atomically activates the prepared disposition, arms its deadline when required, releases the exact child gate, and records one acknowledgement | Yes | Import the guardian's monotonic authority/arm/gate state; never infer it from timeout |
| `ready` | Authenticated worker commits its first role-legal boundary | Yes | Re-register it, or complete exact exit before a successor reservation |

Each private transition takes and releases only the user-store transaction
lock. Slot creation, process placement, guardian calls, and gate release happen
with no Run or user-store lock held, then a compare-and-swap commits the proved
result. A deterministic slot locator plus the creation nonce makes an OS-side
success recoverable when the following private CAS is interrupted. No child may
exist before `slot_prepared`; a slot that cannot prove that invariant is closed
and the launch fails. A supervisor restart completes this transaction through
the startup barrier before the reservation can be retried or returned to the
queue. `ready` means init has acquired append authority, control/recovery has
acquired the exact named transaction authority, or execution has acquired
project execution and Run append and synced the initial safe-reentry boundary
plus `run.running`.

`RecoveryWorkReceiptV1` closes the recovery role's authority. The private CAS
that discovers unfinished work creates one receipt binding Run/project,
predecessor Invocation and exit proof, exact transaction kind/ID
(`enqueue_finish|checkpoint_finish|reconciliation_settle|terminal_close|
reconciliation_probe|apply_settle|in_tree_apply_join|
launch_failure`), allowed Trace entry set, required launch
disposition, runtime/capability hashes, control/effect/workspace high-waters,
and `pending|claimed|consumed|superseded` state. A launch reservation must CAS
`pending -> claimed`; `ready` proves the worker imported that receipt. Closing
the named transaction consumes it. Wrong-task, different-Run, stale-high-water,
and duplicate recovery launches fail before slot preparation. A completed
startup barrier by itself never authorizes a process.

The receipt also fixes scheduling and locks before launch:

| Work/disposition | Project scheduling claim and execution lock | Run append | Mutation barrier |
| --- | --- | --- | --- |
| Init or Trace-only control/terminal recovery | No | Only for each named Trace phase | No |
| Workspace restoration or pure topology reducer | Yes | Yes | No |
| Reconciliation probe | Yes | Yes | No |
| Normal execution | Yes | Yes | Only as the plan declares |
| Apply settlement | Yes | Yes | Exclusive |
| Foreground in-place | Yes | Yes | Exclusive |

A claim-bearing recovery receipt atomically reserves the same per-project
scheduling claim as ordinary execution before `slot_prepared`; no worker exists
while it waits. Its worker acquires project execution, Run append, mutation
barrier when required, then the short control-ordering lock. Exact
`InvocationExitTxnV1` is the only release of scheduler eligibility. Busy
admission returns `PROJECT_BUSY` with the blocking Run/transaction and never
launches early. Thus a settlement, probe, or workspace reducer cannot overlap a
queued or active root worker merely because its role is `recovery`.

Every init, control, recovery, and execution worker uses gated launch. During
`InvocationLaunchTxnV1.slot_prepared`, before any child process exists, the supervisor
creates or reopens an empty
`LaunchSlotV1`: stable containment/guardian ID, creation nonce, owner and ACL
digest, runtime/capability verifier, and challenge method. It syncs that exact
authority in the complete `launch.intent`. Only then may the platform adapter
create the bootstrap atomically inside the recorded containment. Windows uses creation-
time Job assignment or a pre-recorded guardian; Linux uses atomic cgroup
placement or a guardian; macOS requires the guardian path until an equally
strong primitive is proved. A target that can expose even a suspended child
outside the recorded slot cannot launch durable workers.

A guardian is not an ordinary supervisor child. The platform activation
adapter creates it under a predeclared launchd job, systemd scope/service, or
Windows creation-time Job/service identity whose stable locator is synced before
it may spawn. If the platform cannot establish ownership of the guardian itself
without the same gap, the spike fails.

The bootstrap starts behind a closed inherited execution gate and cannot read
project data or execute engine code. It authenticates to the slot guardian,
which durably records PID, birth identity, and membership before acknowledging
spawn. The supervisor syncs that child identity while the gate remains closed.
Only the guardian may release it, atomically with activation of the required
`LaunchAuthorityV1` disposition and deadline arm. EOF before release makes the bootstrap exit, but recovery does
not rely on EOF: it reopens the already-recorded slot and either authenticates
the exact child or proves the slot empty. There is no spawn-before-authority
window.

Foreground execution is a separate closed launch profile, not an ownerless
in-process exception. `ForegroundInvocationTxnV1` makes the interactive CLI the
short-lived controller and launches one gated, client-coupled worker child. The
worker, not the controller, holds project execution, Run append, mutation-domain
when in-place, lease, and effect containment. Its private receipt binds the
client and worker birth identities, terminal/pipe identities, Run/Invocation,
runtime, `client_bound` disposition, guardian or parent-death primitive, and
the same launch/gate/exit phases as `InvocationLaunchTxnV1`. It has no persistent
activation owner and cannot detach.

EOF, `EPIPE`, or controller death closes admission and asks the client-bound
containment to stop. A surviving controller reports
`FOREGROUND_TRANSPORT_LOST`; if the output channel itself is gone, the normal
no-final-frame exception applies. The next CLI may change Run state only after
`InvocationExitTxnV1` proves the exact worker and effects empty. Settled work
becomes canceled or interrupted at its latest valid safe boundary; unknown
effects become reconciliation; unproved exit remains ownership-unknown and
blocks the project. `resume --foreground` may launch a new client-bound worker
only from `queued` or an `interrupted` Run with valid safe-reentry authority.
It returns the checkpoint/reconciliation action for parked states and rejects
terminal state. Foreground execution creates no `StreamOperationReceiptV1`,
has no reconnect, parallelism, automatic crash/reboot recovery, or survival
claim.

Retries use this matrix:

| Last proved boundary | Recovery |
| --- | --- |
| Before StartTicket/preparing-receipt CAS | Nothing accepted; retry the same ticket or explicitly abandon it |
| Ticket consumed and capsule/receipt synced, folder absent/temporary | Recreate the same folder and Run |
| `InvocationLaunchTxnV1.launch_reserved`, no slot intent | Recreate or reopen only the deterministic empty slot; allocate no new launch or Invocation ID |
| `InvocationLaunchTxnV1.slot_prepared`, no guardian child record | Reopen the exact slot and prove it empty before the one allowed atomic spawn |
| Guardian child record exists, private `child_recorded` absent | Authenticate and import that exact child record; never spawn another child |
| `child_recorded`, launch authority absent | Prepare the role/capability-bound launch disposition while the execution gate remains closed |
| Launch authority prepared, arm/gate state unknown | Reconcile the guardian's exact monotonic state; import the original deadline or terminate the slot |
| Child existed and exact exit is proved before `ready` | Complete `InvocationExitTxnV1`; retry with a new Invocation, launch, and fence |
| Any incomplete `EnqueueTxnV1` phase | Follow its row; allocate no new Run or queue generation |
| Enqueue `runnable`, response lost | Return the same queued Run and attachment commands |
| Execution launch recorded, no `run.running` | Re-register exact worker or prove exit, append launch failure, and retry same Run |
| `run.running` synced, ready reply lost | Return same active Run and attachment commands |

No row infers death from timeout. Reusing an idempotency key with a different
full plan artifact fails. Keys are scoped to project instance and protocol
major; StartTicket and key hashes are retained through prune, then tombstoned
for 30 days. A queued Run keeps
the supervisor non-idle and may be canceled without starting the engine.

### Durable append authority

The root Run lock grants exactly one fenced root worker permission to append
lifecycle or effect entries. A normal worker holds it for an active Invocation.
When no worker exists, the supervisor starts a short control Invocation whose
worker acquires the same lock, applies one Trace transition, and releases it.
It may later reacquire for another verified phase of the same transaction, but
never holds Run append across a private phase; it exits when the transaction no
longer needs Trace authority. Examples are
recording a proved launch failure, resolving an effect, or canceling a parked
Run. The supervisor
itself never writes Run evidence. Its crash therefore cannot release a lock
held by a surviving worker.

Private control requests are process-control intent, not Run truth. An active
worker consumes the next request and appends its acknowledgement. If no worker
exists, a short control worker acquires the Run lock and appends it. If a
worker dies, the next append authority reconciles every outstanding request
before admitting an effect. A torn final line is rejected by checksum and
truncated to the last committed boundary only while holding Run append and then
the control-ordering lock. Clients take only the control-ordering lock. No path
may acquire Run append while already holding it. Validation, truncation,
compaction, and status repair need the control lock, and a status change appends
a new checksum-framed record rather than rewriting an old frame.

Each checksum-framed control record has protocol, root Run ID, monotonic control
sequence, request ID, connection identity, operation, target Run/effect/checkpoint,
payload digest, accepted time, and `accepted|delivered|acknowledged|superseded`
status. Replayed request IDs return the stored status. `acknowledged` points to
the corresponding Trace sequence. Payloads are strict data, never executable
commands.

### Safe execution re-entry

Effect safety is necessary but not sufficient to resume engine execution. A
new storage-v2 Run may re-enter automatically only from a validated
`SafeReentryReceiptV1`. The receipt binds Run and source Invocation, boundary ID
and `initial|checkpoint|execution_checkpoint|resolution_reentry` kind, predecessor Trace sequence
and hash, plan and runtime digests, workspace digest, next step and incoming
route, attempt-state digest, topology-state content reference and hash, child-
tree, budget-ledger, control, and effect high-water marks, an empty open-effect
set, and the versioned re-entry adapter digest. It never claims the hash of the
Trace entry that will contain its own digest.

The topology artifact contains every engine value needed to make the next
transition without inference: slice and until indices and markers, retry and
attempt counts, recovery-corridor reason/failure/feedback, Power, skills,
context-delivery and equipment state, recursion ancestry, dynamic route and
Flow-shape choices, fanout reservations/outcomes/pending joins, child state,
accumulated FlowData, immutable step-output references, and this closed
integrity block:

```text
honesty_ledger_ref + sha256
oracle_command_pin_set_ref + sha256
frozen_eval_baseline_ref + sha256
integrity_adapter_version + sha256
```

`OracleCommandPinSetV1` records step ID, canonical commands, command-source
reference/hash, package-script path and body hash, and workspace generation at
pin time. `HonestyLedgerStateV1` records every open latch with step, iteration,
and reason; missing state never defaults to empty.

`TopologyReducerCoverageV1` binds Flow-topology hash, required and covered
channel IDs, channel schema versions, and reducer hash. RunPlan and every safe
receipt bind it. Automatic re-entry requires exact set equality, including
honesty, oracle-pin, and frozen-baseline channels. A release may mark
a topology non-resumable until its reducer covers every one of those channels;
it may not serialize only the convenient subset.

Every schedulable boundary also has mandatory private authority.
`SafeReentryAuthorizationV1` is prepared in authenticated user state before the
boundary append and binds the exact receipt/topology hashes, predecessor Trace
hash, Run/project/runtime/capability identities, high-water marks, and one
transaction nonce. It grants only one named re-entry boundary. The public Trace
entry carries its digest, never the authentication key.

A safe boundary commits in this order:

1. Settle every admitted effect and child boundary.
2. Materialize and sync the complete topology artifact and immutable outputs.
3. Verify workspace, budget, control, child, and effect high-water marks.
4. Prepare and sync the exact `SafeReentryAuthorizationV1` privately.
5. Append and sync one checksum-framed boundary carrying the receipt/artifact
   hash and the same predecessor hash. The boundary is
   `execution.reentry_boundary` for initial/execution checkpoints and
   `checkpoint.waiting` for a human checkpoint.
6. Commit `SafeReentryMirrorV1` against the resulting Trace hash.
7. Admit queueing, answering, or later engine work only after that private
   mirror commits.

The resulting frame hash is `safe_boundary_trace_sha256`.
`SafeReentryMirrorV1` commits that resulting hash only after append; neither the
receipt nor canonical boundary bytes are self-referential. Recovery may finish
a mirror only from the matching prepared private authorization plus the exact
Trace bytes. A boundary with no surviving private authorization is readable
evidence but never re-entry authority and returns `PROJECT_REPAIR_REQUIRED`.

The initial boundary precedes engine work. A human `checkpoint.waiting` carries
the exact safe-reentry receipt hash and is itself the boundary entry; it is
illegal inside an unsupported topology.
After a crash, recovery may use the latest receipt only when it validates and
every later Trace entry is classified as non-executing cleanup. A settled or
reconciled effect without that receipt does not recreate a route, loop index,
recovery payload, or normalized executor result. The Run remains
`interrupted`; `resume` returns `CONTINUATION_UNAVAILABLE` with exact cancel,
inspect, export, and new-Run remedies. Circuit never guesses a forward cursor.

This contract intentionally supersedes the earlier decision to avoid a general
forward-recovery cursor, but only for storage-v2 topologies whose complete
reducer and failure matrix have passed. Existing Runs and unsupported
topologies remain attach/checkpoint-only.

### Run state

The contract uses a transition table, not client-specific inference:

| From | Durable event and guard | Writer | To | Legal next action |
| --- | --- | --- | --- | --- |
| none | capsule and project plan match private receipt | init worker | `accepted` | queue or cancel |
| `accepted` | `EnqueueTxnV1` reaches `runnable` | init or recovery worker | `queued` | wait for project execution or cancel |
| `queued` | execution worker holds locks and syncs initial safe-reentry boundary plus `run.running` | execution worker | `running` | execute, park, reconcile, or cancel |
| `accepted`, `queued` | cancel request wins before execution reaches `run.running` | control worker or gated execution worker | `cancel_requested` | close canceled |
| `accepted` | init worker exit is proved before enqueue completes | recovery worker | `interrupted` | finish same enqueue or terminalize aborted after retry exhaustion |
| `queued` | execution launch fails before `run.running`, below retry bound | control worker through `EnqueueTxnV1` | `queued` | retry without effect |
| `queued` | bounded launch retries exhaust and terminalization wins the ordering gate | control worker | `terminalizing` for `aborted` | commit artifacts and terminal entry |
| `running` | cancellation closes effect admission | worker | `cancel_requested` | drain admitted effects |
| `cancel_requested` | containment is empty, every admitted effect is settled, and terminalization wins the ordering gate | current fenced worker | `terminalizing` for `canceled` | commit artifacts and terminal entry |
| `cancel_requested` | any admitted effect remains unknown | recovery worker | `reconciliation_required` with cancel pending | resolve; never spend |
| `running` | checkpoint reached and tree admission closes | worker | `checkpoint_pending` | drain permits or cancel |
| `checkpoint_pending` | topology candidate/private authorization, `checkpoint.drained`, exact `checkpoint.waiting`, and mandatory private mirror commit | worker or recovery worker | `waiting_checkpoint` | park, then answer or cancel |
| `checkpoint_pending` | cancel wins before parking | worker | `cancel_requested` | drain and close or reconcile |
| `checkpoint_pending` | worker exits with an open permit | recovery worker | `interrupted` | reconcile effects; re-enter only from a prior valid safe receipt |
| `checkpoint_pending` | worker exits after permits settle but before a complete topology candidate/private authorization | recovery worker | `interrupted` | return continuation unavailable or cancel; never infer waiting state |
| `checkpoint_pending` | worker exits after `checkpoint.drained` binds the complete topology candidate and private authorization | recovery worker | `waiting_checkpoint` | finish exact waiting boundary/mirror, then answer or cancel |
| `waiting_checkpoint` | one answer token wins and `EnqueueTxnV1` commits | control worker | `queued` | start the next Invocation |
| `waiting_checkpoint` | cancel wins the same compare-and-swap | control worker | `cancel_requested` | close canceled |
| `running`, `cancel_requested` | exact worker exit observed before a safe close | recovery worker | `interrupted` | prove re-entry, reconcile, or cancel |
| `interrupted` | latest `SafeReentryReceiptV1` validates, later entries are cleanup-only, all open effects are settled, and `EnqueueTxnV1` commits | recovery worker | `queued` | start the next Invocation at that exact boundary |
| `interrupted` | effects are settled but no valid safe-reentry receipt exists | recovery worker | `interrupted` | inspect/export, cancel, or start a new Run; never guess continuation |
| `interrupted` | any effect has unknown outcome | recovery worker | `reconciliation_required` | resolve or cancel |
| `interrupted` | cancel is pending and no effect is unknown | recovery worker | `cancel_requested` | settle canceled |
| `interrupted` | cancel is pending and an effect is unknown | recovery worker | `reconciliation_required` with cancel pending | resolve; never spend |
| `reconciliation_required` | one effect resolution wins its compare-and-swap | control worker | `reconciliation_required` | resolve the remaining effects |
| `reconciliation_required` | all effects are resolved, results are usable, cancel is absent, `ResolutionReentryTxnV1` commits its new safe receipt, and `EnqueueTxnV1` commits | control worker | `queued` | start the next Invocation at that exact boundary |
| `reconciliation_required` | effects are resolved but no resolution reducer/new safe receipt is available | control worker | `interrupted` | inspect/export, cancel, or start a new Run |
| `reconciliation_required` | cancel is pending, every effect is settled without abandon, and `ResolutionCancelSettlementTxnV1` commits | control worker | `cancel_requested` | close canceled |
| `reconciliation_required` | every effect is resolved, at least one is abandoned, `ResolutionTerminalSettlementTxnV1` commits the whole ledger, and terminalization wins the ordering gate | control worker | `terminalizing` for `aborted` | commit retained uncertainty and terminal entry |
| Apply `running` | post-commit path drift commits `ApplyDriftRecordV1` and durable mutation-domain block | Apply or settlement worker | `apply_recovery_required` | inspect and create a repair plan; no other mutation |
| `apply_recovery_required` | exact original roll-forward settlement receipt commits | settlement worker | `terminalizing` for `complete` | close with complete Apply outcome |
| `apply_recovery_required` | digest-confirmed modified settlement receipt commits | settlement worker | `terminalizing` for `aborted` | close with `operator_settled` Apply outcome |
| `running` | result, reports, required Apply outcome, and hashes are ready; terminalization wins the ordering gate | worker | `terminalizing` for chosen outcome | commit artifacts and terminal entry |
| `terminalizing` | frozen payload and artifacts pass the two-phase close | worker or recovery worker | terminal outcome | inspect, report, or create a linked Apply Run |

Terminal outcomes are `complete`, `aborted`, `handoff`, `stopped`, `escalated`,
and `canceled`. `checkpoint_pending`, `cancel_requested`, `interrupted`,
`reconciliation_required`, `apply_recovery_required`, and `terminalizing` are
not terminal. A process that
merely misses its lease stays `running` with `unresponsive` health until its
exact identity is proved dead or it reconnects.

For storage v2, `resume` is a recovery/attachment command, not permission to
reopen a terminal Run. It attaches to `queued` or `running`, enqueues an
`interrupted` Run only from a valid `SafeReentryReceiptV1` through
`EnqueueTxnV1`, returns the exact checkpoint, reconciliation, or continuation-
unavailable error and remedies for other states, and rejects every terminal
state.

Root process-control actions apply to the execution tree. Root cancellation
stops admission in every child and sibling. A child checkpoint is promoted to
the root: the worker stops new tree-wide effects, lets admitted effects reach a
recorded boundary, writes the child identity into the root checkpoint, and
parks the tree. Child reconciliation is also promoted. Children remain
individually inspectable, but cannot be resumed or canceled independently while
their root Invocation owns them.

Child discovery is write-ahead. Before creating a child folder or admitting a
child effect, the root append coordinator allocates its Run ID and syncs
`child.reserved` in the parent Trace with parent ID, flow digest, workspace
digest, and deterministic fanout slot. It then atomically installs the child
manifest, appends `child.started`, and only then opens child admission.
Recovery closes a reservation without a manifest as `not_started`, quarantines
a manifest without a committed reservation as corruption, and treats a
committed child without a terminal entry as nonterminal. A parent cannot close
or prune one child independently.

### Invocation state

| From | Event | To |
| --- | --- | --- |
| none | process created with capability and epoch | `starting` |
| `starting` | worker owns Run lock and acknowledges readiness | `active` |
| `starting` | process exits or handshake expires and exact exit is observed | `exited` |
| `active` | cancel, checkpoint park, or orderly close begins | `stopping` |
| `active` | lease returns after a quiet period | `active` |
| `active`, `stopping` | exact process exit observed | `exited` |

`healthy`, `quiet`, and `unresponsive` are observations on `active`, not
ownership states. A replacement starts only after `exited` is proved. Force
stop means signal the authenticated worker or its owned process tree and then
wait for observed termination; sending a signal is not proof.

`InvocationExitTxnV1` mirrors every worker exit into private authority, not only
terminal exits. It records stopping boundary/Trace hash, exact process and
containment-empty proof, lease tombstone, released worker-specific references,
and next scheduler eligibility. A checkpoint may commit `checkpoint.waiting`,
but no answer action or next worker is admitted until this transaction proves
the old Invocation exited. Interrupted recovery and terminal cleanup use the
same proof. The Run-level runtime/content pins remain according to their own
references. A timeout, released project lock, or closed viewer cannot complete
the exit transaction.

A reboot is the one case where the prior process cannot be observed exiting.
`BootEpochExitProofV1` is a platform adapter proof, not a timeout substitute. It
binds machine identity, authenticated old/new OS boot identities, platform
primitive/version, every prior-boot Invocation/guardian/containment identity,
open-effect and Apply-transaction high-waters, and the new supervisor election
generation. The adapter must prove the OS invariant that no user process,
kernel containment, or handle from the old boot can still execute locally.

While holding the startup barrier, recovery uses that proof to commit
`InvocationExitTxnV1(exit_reason: boot_epoch_ended)` for each old-boot
Invocation and to close its local containment record. It consumes the entire
unsettled active-time reservation conservatively. Every effect intent without a
receipt becomes `reconciliation_required`; a post-decision Apply uses only its
`settlement_only` recovery path; a Run with no open effect returns to
`interrupted` and may re-enter only through valid private safe-reentry
authority. Remote provider work is never declared stopped merely because the
local boot changed. A platform that cannot authenticate this boot-epoch
invariant cannot claim `full-durable`; ownership remains unknown rather than
weakening exact-exit rules.

### Lease and fencing

The secure control record carries:

- Run ID and Invocation ID
- fencing epoch
- worker UUID
- PID plus process creation identity
- operating-system boot identity
- runtime version and digest
- authenticated control token reference
- containment kind, stable containment ID, and creation nonce
- containment owner and access-control digest
- reopen locator or guardian identity and its challenge method
- membership high-water mark and membership digest
- cleanup state
- last lease renewal and last activity time

The worker renews its lease in the private store and can authenticate to a
replacement supervisor. A missed renewal produces `unresponsive`. The
supervisor probes the authenticated channel before it changes ownership.
PID-only liveness cannot grant ownership because PIDs can be reused. The
fencing epoch is an audit and admission check; direct Trace safety comes from
the exclusive Run lock and the rule that no replacement starts while the old
process may still exist.

Containment authority must survive supervisor death. On Windows the private
record names a secured named Job Object whose DACL admits only the operator and
whose identity can be reopened before `TerminateJobObject`. On Linux it names
the delegated cgroup path plus filesystem identity and delegation proof. A
macOS adapter must expose an equally stable kernel or guardian identifier; a
PID or process group alone is insufficient. A replacement supervisor either
reopens that exact handle or authenticates to the recorded guardian, verifies
membership against the high-water record, and proves the containment empty
before cleanup. If it cannot, ownership stays unknown and no replacement or
false cancellation success is allowed.

Protocol v2 defaults are versioned constants: two-second lease renewal,
unresponsive after ten seconds, five-second control acknowledgement, 15-second
graceful cancel, 30-second checkpoint drain, 30-second force-settlement limit,
15-second hard-budget grace, and 30-second supervisor idle exit after no worker,
client, or pending request remains. RunPlanV1 may tighten
cancel/checkpoint/budget limits within policy bounds; budget grace must be
positive and smaller than the active wall limit.
Sleep can trigger unresponsive health but never takeover.

The current resume lock protects one narrow race. The new ownership contract
replaces it for the new plane. No command signals a PID read from a project Run
folder.

### Lock hierarchy

All locks are no-follow OS locks addressed by canonical project or operation
identity in persistent private user state. Scheduling reservations are not locks.

| Lock | Holder | Protects |
| --- | --- | --- |
| Supervisor election | Supervisor | One control endpoint per user/machine/protocol |
| User-store transaction | Supervisor or repair tool | One private CAS/transaction phase; never co-held while acquiring a project lock |
| Project execution | Root worker or v1 wrapper | Initial one-executing-root-Run limit |
| Run append | Root, Apply, or short control worker | One writer for one root Run tree |
| Mutation-domain barrier | Planner shared; Apply worker exclusive | Stable snapshot versus physical base-checkout mutation |
| Control ordering | Client or fenced worker | Total order between control, effect admission, Apply commit, and terminalization |

An execution worker acquires project execution before Run append. A later root
Apply does the same; a required pre-close Apply is a child in the existing tree.
An Apply worker acquires its mutation-domain barrier exclusively after Run
append. A fenced worker takes control ordering last. A short control worker does
not wait for project execution or mutation. Cross-store transactions release
the user-store lock between private and project phases and use hashes and CAS;
they never reverse the order by holding it across a project-lock acquisition.
Lease renewal has its own append-only path and takes none of these locks. No
holder takes a lock to the left after one to its right. The worker doing
protected work holds it, so supervisor exit cannot release it. Waiting
checkpoints hold no project or mutation-domain lock.

### Checkpoint parking

A worker that reaches a checkpoint closes tree-wide effect admission and uses
four durable boundaries:

| Boundary | Required content | Owner-death recovery |
| --- | --- | --- |
| `checkpoint.pending` | Checkpoint ID, attempt, canonical request bytes or immutable ref, choices digest, and pre-drain sequence | Continue drain or reconcile open permits |
| `checkpoint.topology_prepared` | Complete topology artifact/ref/hash, candidate `SafeReentryReceiptV1`, prepared private `SafeReentryAuthorizationV1` digest, canonical workspace/high-waters, and question artifact | Continue validation; never append waiting from Trace alone |
| `checkpoint.drained` | Every permit receipt and child boundary plus the exact topology-candidate, private-authorization, workspace, and predecessor hashes | Append only the exact waiting entry authorized by that private record |
| `checkpoint.waiting` | Drained/predecessor hash, safe-reentry receipt/private-authorization hashes, and authenticated answer-token digest | Commit the mandatory private mirror; action emits after mirror and Invocation exit proof |

The request is not answerable before `checkpoint.waiting`, its private safe-
reentry mirror, or `InvocationExitTxnV1` proving the parking worker gone. A
recovery worker may finish pending to drained only when every permit/child
boundary and the complete topology candidate are proved from the matching
private authorization. If the worker dies before that candidate commits, the
Run becomes `interrupted`; settled permits alone cannot reconstruct loop,
retry, route, FlowData, or join state. Missing private authority, request bytes,
or a digest match is repair/corruption, not an inferred checkpoint. After
waiting and its mirror commit, the Invocation ends, its locks are released, the
worker exits, and the private exit transaction completes before an answer is
accepted.

The drain has the plan's bounded checkpoint-grace limit and emits its blocking
effect IDs. On expiry, `resolve_checkpoint_drain` offers another bounded wait
or graceful cancel; machine clients receive exit 3. When
`force_escalation_available` is true, the cancel choice explains that a proved
still-live target may produce a separate `confirm_force` action after grace.
It never emits a direct force argv or a decision ID. An effect whose outcome
becomes unknown moves the Run to `reconciliation_required`; it never produces
an answerable checkpoint. Only `waiting_checkpoint` plus proved prior Invocation
exit emits the `answer_checkpoint` action.

The machine remedies are
`circuit checkpoints drain <run-id> <checkpoint-id> --boundary <sha256>
--action wait|cancel` and,
only after a graceful-cancel response,
`--boundary <sha256> --action force --decision <force-decision-id>`.
The pending entry allocates the checkpoint ID, and the command compares that ID
and pending boundary version. Wait grants one policy-bounded extension; cancel
or force uses the ordinary settled cancellation contract.
`checkpoints drain --action cancel` is the sole checkpoint producer of a
`confirm_force` action; its `ForceEscalationReceiptV1` names the exact same
checkpoint/boundary drain-force leaf as consumer. No root or Apply force
decision can be reused here.

Answering a checkpoint presents an opaque authenticated `DecisionTokenV1` that
binds Run ID, checkpoint ID, attempt, boundary hash, choices digest, and expiry.
The token grants no authority by itself; ordinary client authentication and
policy still apply. An expired token may be refreshed read-only only while the
same waiting boundary still wins; a changed boundary returns stale. One answer wins, records the choice, and queues a new
Invocation through `EnqueueTxnV1`. A separate `resume` is unnecessary.
Canceling a parked Run uses a short control Invocation and never starts the
flow engine. Before the next effect, that worker rematerializes the workspace
manifest and must reproduce the parked digest. Drift is corruption requiring a
new plan or explicit discard, never an accepted continuation.

## Effects, cancellation, and recovery

The CLI rebuild cannot promise safe recovery while the engine treats effects
as ordinary function calls. The rebuild adds one effect boundary used by relay,
verification, Git, filesystem, apply, and external commands. Effect intent,
receipt, cancellation, and reconciliation are typed Trace entries. There is no
separate execution journal.

The active worker owns a single ordered admission controller for the whole root
tree. The private control journal and effect admission share one short ordering
lock. A client first appends and syncs a numbered control request. Before an
effect can start, the worker takes the lock, imports every newer control
sequence, and acknowledges cancellation before it can append an effect intent.
If no blocking request exists, it appends and flushes `effect.intent` with a
fenced permit ID, the highest observed control sequence, and a budget
reservation. It releases the lock only after that commit, then invokes the
effect. For an effect that can write the Run workspace, the intent also requires
the prepared workspace transaction below; Apply base mutation uses its separate
transaction. Completion appends and flushes `effect.receipt`,
then promotes its workspace generation before dependent work begins. A cancellation handled through the same gate appends and flushes
`run.cancel_requested`, closes admission, and then drains already admitted
permits. No `effect.intent` may follow that Trace sequence. An effect ordered
before cancellation may already have reached an external system; Circuit says
so instead of pretending the cancel request traveled backward in time.

`EffectWorkspaceTxnV1` makes rollback material, not just a digest. Before
intent, it creates a Run-owned copy-on-write layer over an immutable prior
workspace generation and syncs the preimage manifest/content closure. The
effect sees that layer as its only writable project tree; it never writes the
current Run-workspace generation directly. `effect.intent` binds transaction
ID, prior generation/digest, preimage-manifest hash, layer identity, and
isolation-adapter hash.

After the exact effect containment is empty, the transaction syncs a complete
postimage manifest and immutable outputs. `effect.receipt` binds the next
generation/digest and postimage hash; only then may a workspace-locator CAS
promote that generation. A retry returns the same promotion. Before receipt, or
after a proved `not-completed` resolution, durable discard deletes only the
layer and revalidates the prior generation byte-for-byte. Dependent engine work,
checkpoint waiting, terminalization, and budget release are illegal while an
effect workspace is unpromoted, undiscarded, or ownership-unknown.

A digest alone is never rollback material. `isolated_discardable` requires this
proved layer. A completed resolution must promote its recovered postimage
before topology reduction; `not-completed` must discard before a new effect ID
is admitted. Fanout branches CAS their own workspace generations and join only
through the declared parent policy. Active preimage/postimage manifests and
layers are content/reference pins and participate in prune. Apply's base-
checkout transaction remains separate.

Terminalization uses that same ordering lock. Before choosing success or any
other terminal target, the worker imports every committed control sequence. If
a cancellation was ordered first, terminalization yields to the cancel path.
Otherwise it appends and syncs `run.terminalizing` with the highest observed
control sequence and chosen target, closes both effect and Run-control
admission, and freezes that target. A later cancellation is durably marked
`superseded` with the already chosen terminal result. No `run.closing` entry is
legal without the preceding terminalization decision. This gives cancel and
close one total order rather than two racing paths.

Intent records stable effect ID, owning Run/step/attempt/Invocation, effective
capability and adapter-proof digests, derived recovery class, idempotency key
when supported, `result_requirement: none|reconstructable`, canonical operation
digest, budget reservation, and expected receipt schema. Receipt records
provider or process identity, exit/result status, measurable usage, immutable
output references, and settled effect-containment identity. Unused budget is
released only by a receipt or explicit
reconciliation. Filesystem-capable intents bind the prior logical workspace
digest; receipts bind the next digest. A mismatch before another effect stops
as workspace drift instead of absorbing outside edits.

`EffectPermitV2` derives the effective recovery class. A Flow may request one,
but project config and connector claims cannot strengthen it:

Logical effect identity and physical dispatch are separate.
`EffectDispatchAttemptV1` records effect/attempt IDs, attempt-specific budget
reservation, operation/key digest, provider/process identity, dispatch boundary,
and `reserved|dispatched|receipted|outcome_unknown` state. Every physical retry
gets a new attempt ID and reservation. Unknown usage consumes the prior
attempt's full reserved token/cost/quota bound unless authoritative provider
accounting proves a smaller value; a retry can never reuse or refund that
uncertain reservation.

| Class | Required proof | Crash response |
| --- | --- | --- |
| Pure read | No filesystem/external mutation **and** adapter proof of zero billing, token, quota, or rate-limit consumption | Retry as a new physical attempt after revalidation and a new reservation |
| Idempotent with a key | Stable key plus either an adapter-proved local zero-consumption lookup or an approved bounded `ReconciliationProbeTxnV1` returning immutable result or proved absence | Probe, then retry only on proved absence |
| Isolated and discardable | Enforced isolation, network `none`, workspace-only writes, and no external broker effect | Discard that isolated result and retry |
| Reconciliation required | Mandatory default when no earlier row is proved, including billable reads without authoritative keyed lookup | Park and ask the operator; never replay |

Billing, token, quota, and rate-limit consumption are external effects even
when the provider operation only reads data. Relay/model calls therefore cannot
use `pure_read`. They need authoritative keyed idempotency/query or
reconciliation. RunPlan and the plan header expose both logical recovery class
and physical-attempt accounting posture.

`ReconciliationProbeTxnV1` is the only network/provider query allowed while a
Run is parked. It never dispatches the original operation or enters the engine.
The accepted RunPlan must declare the exact query adapter, key schema, network
capability, worst-case token/cost/quota/rate-limit reservation, retry bound, and
approval ID. Without that prior approval, the action offers explicit probe or
abandon choices and spends nothing. A zero-consumption local lookup stays
`control_only`; an external lookup launches under
`reconciliation_probe_only` with its own fenced intent,
`EffectDispatchAttemptV1`, containment, reservation, receipt, and result/absence
schema. Crash before receipt consumes the full attempt bound and leaves the
probe unknown; a new probe needs a new reservation and cannot resolve the
primary effect by inference. Cancellation never auto-approves a probe; the
operator may abandon instead.

Public probe authorization is also closed. When the accepted RunPlan already
contains the exact probe and its approval was granted, private recovery creates
one single-use `ReconciliationProbePermitV1` bound to the plan approval,
Resolution Ledger generation, effect/key/query adapter, budget reservation, and
expiry. Otherwise `reconcile probe plan <run-id> <effect-id> --token
<resolution-token>` is read-only: it freezes those same inputs in an immutable
`ReconciliationProbePlanV1`, returns `confirm_reconciliation_probe`, exits 3,
and spends nothing. Only `reconcile probe apply --plan <id> --confirm <sha256>
--yes` consumes that plan and creates the permit. It launches one recovery
worker under `reconciliation_probe_only`; it creates no Run, engine re-entry,
or primary-effect permit. A validated immutable result or absence receipt may
settle only the named primary effect. Unknown probe outcome leaves both attempt
budget and primary-effect uncertainty visible. Response loss returns the same
probe transaction and receipt. `ReconciliationProbePlanReceiptV1` is owned by
the named Resolution Ledger, not the reusable Run/Apply plan store. It binds the
ledger/effect generations, artifact hash, source resolution token, 15-minute
expiry, and `available|consumed|expired|abandoned` state. `reconcile show`
returns it and the exact `reconcile probe abandon <plan-id>`/replan remedies;
apply, expiry, and abandon race one
CAS, and ledger settlement invalidates it. No orphan probe plan survives Run
prune or grants authority after a changed ledger generation.

Every admitted effect also gets a distinct containment identity beneath the
Invocation containment, or an adapter-proved exact membership subset. Every
descendant belongs to exactly one active effect. `effect.receipt` is illegal
until that effect's complete process tree is empty and its output is committed.
An unattributed or surviving descendant forces `reconciliation_required`.
`run.terminalizing` requires every permit received or resolved and every effect
containment empty.

Hard budgets have enforcement authority, not just labels. A plan may call a
wall or cost limit hard only when its adapter proof supplies the mechanism:

- Every physical dispatch attempt reserves its worst-case relay/token/cost/
  quota amount before dispatch; the logical effect ledger aggregates attempts.
  `max_cost_usd` is hard only when a pinned pricing schedule plus connector-
  enforced token/request caps bound the charge. Otherwise cost is `unknown` or
  an estimate and the hard limits are relay/token/attempt counts.
- `max_active_wall_time_ms` means cumulative admitted active execution time. It
  pauses only after exact Invocation exit at a worker-free checkpoint and may
  resume only from a proved retained remainder. Reconciliation admits no engine
  or primary-effect spend; a separately approved probe consumes only its frozen
  probe reservation.
- The plan also fixes `budget_grace_ms`, smaller than the wall limit. Plan
  approval explicitly grants `BudgetTerminationPermitV1`: authority to stop
  the exact future Invocation containment at the recorded deadline. It grants
  no general force-cancel authority.

`BudgetLedgerV1` records reserved/used relay, token, cost, quota, attempt, and
active-time amounts at each attempt reservation/dispatch/receipt, effect
settlement, Invocation reservation, and proved exit.
Before an execution-role gate can open, `ActiveTimeReservationV1` moves the
Run's entire retained active-time allowance into the exact Invocation. Every
launch also commits one capability-specific `LaunchAuthorityV1` disposition:

| Disposition | Allowed work | Deadline authority |
| --- | --- | --- |
| `execution_armed` | Run the engine and admit only plan-approved effects | `ActiveTimeReservationV1` plus hard-wall `BudgetArmV1` when configured |
| `control_only` | Init, control, evidence repair, reconciliation recording, named resolution workspace restoration/pure reduction, and terminal cleanup; no general engine, new effect, or base mutation | Administrative containment only; active-time budget does not apply |
| `reconciliation_probe_only` | Execute one named query-by-key adapter; no engine, original effect, workspace/base mutation, or unrelated network call | Attempt-specific probe reservation and bounded probe deadline |
| `settlement_only` | Finish one named already-committed Apply or cleanup transaction; no new connector/network effect or new commit decision | Separate plan-approved `SettlementPermitV1` and bounded settlement deadline |

A recovery that will resume engine work reserves a new `execution_armed`
Invocation. Post-commit Apply recovery uses `settlement_only`, so an exhausted
Run budget cannot strand a half-applied checkout but also cannot authorize new
spend. The active-time reservation records
reservation and Invocation IDs, ledger generation, reserved milliseconds,
boot identity, monotonic-clock kind and start sample, optional proved exit
sample, used/refunded amounts, and
`reserved|settled_same_boot|settled_conservative` state.

Only a same-boot exact exit measured by the authenticated guardian refunds the
proved unused remainder. A different boot identity, missing exit sample, or
unknown clock lineage refunds nothing; recovery conservatively consumes the
reservation before another Invocation may reserve time. A reboot can therefore
exhaust a hard-wall budget even when actual use was lower, but it can never
manufacture more execution time. Plan output states this conservative posture.

`BudgetArmV1` binds `execution|settlement` arm kind, Invocation and fence,
launch slot and nonce, guardian and activation identity, termination or
settlement-permit hash, budget-ledger generation,
reserved active time, grace, clock kind, arm sequence, and the monotonic warning
and hard deadlines. Its states are
`prepared|released_armed|fired|disarmed`. While the bootstrap gate is closed,
the guardian validates the exact containment and durably enters `prepared`.
One guardian operation then records its boot/clock samples when required,
activates the exact disposition, arms termination, and releases the gate
atomically. An execution or settlement bootstrap verifies that acknowledgement
before its protected work. A `control_only` bootstrap verifies its restricted
capability before its gate opens. Launch cannot strengthen or skip the immutable
disposition dynamically. Settlement time is reported separately from approved
active engine time and never changes cost/token/attempt ledgers.

If private state trails a `released_armed` guardian, recovery imports the same
acknowledgement and original deadline. A released gate without armed proof
forces termination of that exact slot and rejects the hard-budget profile.
The arm is disarmed only after `InvocationExitTxnV1` proves a worker-free
checkpoint or terminal cleanup.

If a settlement deadline fires, the guardian terminates only that settlement
containment. The frozen transaction remains `drift_blocked` or recovery-pending
and may retry under a new bounded settlement permit; it is never reported as
rolled back or complete merely because its worker stopped.

At `deadline - budget_grace_ms`, `BudgetExpiryTxnV1` orders a `budget_expired`
control request through the same control/effect gate, closes admission, and asks
the worker and effects to stop. At the hard deadline the guardian may terminate
only the authenticated containment named by the launch slot, even if the
viewer and supervisor are gone. It then proves the tree empty and follows the
ordinary receipt/reconciliation rules. An unknown containment cannot claim a
hard-budget profile. The final outcome is canceled with reason `budget` when
every effect settles, otherwise reconciliation or aborted uncertainty; it is
never mislabeled complete.

The hard deadline guarantees closure of local admission and termination of the
proved local tree. It cannot claim that a remote provider forgot a request
already accepted; that remains an unknown effect requiring reconciliation.

This preapproved deadline is distinct from an operator's ad hoc `--force`,
which still requires the second authenticated decision receipt. Failure injection kills client,
worker, guardian process and connection, and supervisor before and after budget
preparation, atomic arm-and-release, warning, deadline, termination, exit proof,
and reconciliation. Restart must recover the same deadline, never start a fresh
clock.

### Reconciliation

`reconciliation_required` owns a versioned `ResolutionLedgerV1`, names every
open primary effect, and blocks the engine and every new primary effect. It may
admit only the exact `ReconciliationProbeTxnV1` or settlement transaction
described above.
A cancel received in this state records a pending no-more-spend intent but does
not erase uncertainty or change state; it authorizes no probe. Each effect must
resolve first:

| Outcome | Required evidence | Consequence |
| --- | --- | --- |
| `completed` | Adapter-validated receipt; for `reconstructable`, an immutable result ref is mandatory | Never replay; continue only with every required result |
| `not-completed` | `AbsenceEvidenceV1`: an adapter-validated absence proof or explicit operator attestation that dispatch produced no completed effect | A new effect ID may be planned after budget, policy, and approval revalidation |
| `compensated` | Receipt for the original effect and its compensation | Retry only when the accepted plan declared compensated re-entry |
| `abandon` | Explicit acknowledgement of remaining uncertainty | Preserve unresolved evidence, settle the whole mixed ledger through `ResolutionTerminalSettlementTxnV1`, close `aborted`; never continue or claim canceled |

Resolution does not make an older safe receipt usable. When a complete,
non-abandon ledger will continue execution, `ResolutionReentryTxnV1` must
create a new one:

| Phase | Durable contract |
| --- | --- |
| `reserved` | Private CAS freezes the ledger, superseded safe-boundary hash, effect high-water, workspace generation, runtime, and pinned re-entry adapter |
| `workspace_recovered` | Promote the validated completed postimage, discard a proved not-completed layer back to its preimage, or apply the plan-declared compensated result; reproduce the exact required digest |
| `topology_reduced` | Signed pure `ReentryAdapterV1` consumes immutable normalized results and writes the next complete topology artifact |
| `boundary_appended` | `control_only` recovery worker revalidates control/effect/workspace high-waters and appends a `resolution_reentry` safe boundary |
| `mirrored` | Private CAS records the new boundary hash and marks the frozen ledger consumed |
| `consumed` | `EnqueueTxnV1(reconcile_continue)` names only this new receipt |

`ResolutionReentryPermitV1` authorizes the named workspace restoration and pure
reducer only. The adapter has no network, base-checkout, engine, or effect-
admission capability. Its receipt adds the superseded boundary, resolution-
ledger and normalized-result hashes, recovered-workspace manifest, transaction
ID, and resolved-effect high-water. A `completed` result advances without
redispatch; `not-completed` restores the pre-effect boundary and only then may
plan a new effect ID. A missing reducer returns `CONTINUATION_UNAVAILABLE`.

The matching `CompatibilityControllerV1` and reducer remain pinned through Run
prune. An older receipt remains invalid after executing Trace entries; only the
transaction above can establish a later valid boundary.

A pending cancel does not need an engine reducer, but it still needs the same
settlement proof. `ResolutionCancelSettlementTxnV1` freezes the complete ledger
and performs the identical `workspace_recovered` phase, then appends and
mirrors `resolution.settled_for_cancel` with the ledger, effect, and workspace
hashes before moving to `cancel_requested`. It cannot produce a safe-reentry
receipt or admit engine work. Thus an unavailable topology reducer may block
continuation without blocking a proved no-more-spend cancel, while neither path
can terminalize over an unpromoted or undiscarded effect layer.

`ResolutionTerminalSettlementTxnV1` handles any complete ledger containing an
abandon outcome. It freezes the whole ledger and settles every effect layer in
deterministic effect order: promote a validated `completed` postimage, discard
a proved `not-completed` layer, apply the plan-declared compensated workspace
result, and copy each abandoned partial layer into immutable quarantined
evidence before discarding it. It revalidates the resulting workspace
generation after every step, then appends and mirrors one
`resolution.settled_for_abort` receipt binding the complete ledger, ordered
layer dispositions, quarantine hashes, and final workspace hash. Recovery
resumes that exact ordered transaction. It grants no continuation or canceled
outcome. Unknown containment for any member blocks it; an operator's
acknowledgement is not process-exit proof.

The public commands are:

```text
circuit reconcile list [<run-id>]
circuit reconcile show <run-id> [<effect-id>]
circuit reconcile resolve <run-id> <effect-id> --token <resolution-token> --outcome <value> [--receipt-file <path>] [--result-ref-file <path>] [--note-file <path>] [--attest <statement-sha256>]
circuit reconcile continue <run-id> --token <continuation-token>
```

`ResolutionDecisionTokenV1` binds Run/effect IDs, intent and current ledger
hashes, resolution version, allowed outcomes, input-requirement digest, caller,
and expiry. `resolve` consumes that caller-supplied boundary, compares every
field, records the evidence, and starts no work. Exact replay returns the stored
resolution; a newer ledger returns `DECISION_STALE` plus its new token. Operator
attestation without a result is valid
for `not-completed` regardless of the original result requirement. A completed
resolution may omit a result reference only when `result_requirement` is
`none`; a reconstructable completed effect still needs its immutable result.
An invalid resolution changes nothing and returns exact receipt or abandon
remedies. A resolution may be amended by
compare-and-swap only before continuation or terminalization.

After a complete ledger and its settlement/re-entry receipt commit,
`ReconciliationContinueTokenV1` binds Run, ledger version/hash, receipt hash,
caller, and expiry. `continue` requires it; a copied command cannot enqueue a
newer ledger. Host choices carry the same opaque tokens and never reconstruct
them from displayed hashes.

Each reconciliation action publishes typed input requirements. `completed`
requires the adapter receipt and, when `result_requirement` is
`reconstructable`, an immutable result-reference file. `compensated` requires
the original and compensation receipt schema. Operator-attested
`not-completed` and `abandon` require the exact statement hash and a note. Input
paths resolve from client cwd, open no-follow, copy into immutable transaction
input, and become hash-bound before the resolution CAS. A renderer that cannot
collect the required files safely shows the complete public command and does
not pretend the choice can be completed inline. CLI `--attest` must equal the
statement hash in the current action frame; host RPC sends the same choice ID,
statement hash, and note input. A copied or stale statement changes nothing.

`continue` acts only on a complete ledger:

| Ledger | Cancel pending | Result |
| --- | --- | --- |
| Any effect unresolved | Either | Stay `reconciliation_required` |
| All resolved, none abandoned, every required result usable, resolution-reentry receipt committed | No | Enqueue through `EnqueueTxnV1` |
| All resolved, none abandoned, no reducer/new receipt available | No | Return `CONTINUATION_UNAVAILABLE`; never infer engine state |
| All resolved, none abandoned, cancel-settlement receipt committed | Yes | Advance to `cancel_requested` |
| All resolved, one or more abandoned, whole-ledger terminal-settlement receipt committed | Either | Terminalize `aborted` |

Otherwise exit 3 carries the remaining exact resolution commands. One abandon
can never close over a second unresolved effect.

A crash between intent and receipt produces an unknown effect. Circuit must not
infer success from changed files or infer failure from a missing receipt. Every
Trace append used as a dispatch boundary is checksum-framed and synced before
the operating-system call. Tests inject death before and after the sync and the
dispatch.

Cancellation reaches the graph runner, every executor, fanout branch, child
Run, connector, verification command, and Apply Run. Blocking subprocess calls
move to asynchronous process control.

Every subprocess starts through a platform containment adapter before its
effect dispatch. The adapter records process birth, effect containment, and
Invocation containment identity,
closes control handles in the child, and forbids detached launches. Windows
uses a no-breakaway per-Invocation Job Object; force uses
`TerminateJobObject`, while kill-on-last-handle-close handles cleanup. Linux
uses a per-Invocation cgroup or an equally strong proved adapter. macOS and
other Unix targets must provide a kernel-enforced adapter that passes the
setsid, double-fork, and daemonization probes. A connector that can escape is
unsupported for durable detach and must use the trusted in-place profile.
Windows Job Objects manage a process tree as one unit; see the
[Microsoft contract](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).

`--force` changes escalation authority; it does not weaken evidence. Cancel
follows this order:

1. Append and sync a numbered private control request.
2. Deliver it over the authenticated channel when the worker responds.
3. Without force, wait for the worker to import it, append
   `run.cancel_requested`, stop admission, ask admitted effects to stop, and
   wait the bounded grace period.
4. Only an explicit second
   `cancel <run-id> --force --decision <force-decision-id>` may escalate.
   The graceful response first returns `confirm_force` with a `ForceActionV1`
   ID and digest. `actions confirm-force <action-id> --confirm <digest> --yes`
   creates single-use `ForceDecisionV1`. It binds authenticated caller UID/SID,
   project instance, Run and request IDs, worker birth and containment identities, current
   control/fence generations, `not_before`, expiry, and
   `pending|consumed|expired` state. The public decision ID is a locator, not a
   bearer token: it is useless without same-user RPC authentication and the
   matching live private receipt. Any process authenticated as that same OS
   user may finish the decision; Circuit does not claim process-level secrecy
   between same-user clients. A different user, stale generation, expired
   receipt, or raw containment ID grants nothing. The supervisor consumes the
   receipt and uses its separate private containment handle to terminate the
   exact tree. A controlling TTY may confirm and consume through those same two
   RPCs without printing the decision ID as a secret.
5. Prove the worker and every contained descendant exited. Only then may a new
   fenced recovery worker take the locks, import the pending request, append
   the interruption/cancel entries, and reconcile all open permits.
6. Append `canceled` only when containment is empty and every admitted effect
   has a receipt or safe resolution. Otherwise remain `interrupted` or
   `reconciliation_required`.

`ForceEscalationReceiptV1` makes that workflow closed:

```text
graceful_pending -> action_available -> decision_available
-> force_started -> settled
```

It binds source command and exact force-consumer command, project/Run and
checkpoint when present, control request, worker/containment identities, fence
generation, action digest, decision ID, expiry, and final force transaction.
The legal source/consumer pairs are root `cancel` -> root force cancel,
`applies cancel` -> Apply force cancel, and `checkpoints drain --action cancel`
-> the same checkpoint's drain-force leaf. After graceful expiry, a proved live
and controllable containment commits `action_available`, returns
`confirm_force`, and exits 3. Reconciliation, unknown containment, or an
ineligible target returns a typed error and exits 1 with no force action.
Repeating the graceful command returns the same outstanding action;
`actions confirm-force` creates or returns the same decision and exits 0. Only
the receipt's named leaf may consume it. A stale or expired decision returns
`DECISION_STALE`, exits 1, and points back to the graceful source command; it
does not also emit an action frame. Replaying a consumed decision returns the
stored force transaction status.

Ordinary `cancel` waits through bounded graceful shutdown for a settled
terminal state. Forced cancel also waits through step 6. Exit 0 means the Run
is `canceled` or was already terminal. A known controllable worker still live at
grace expiry returns the action/exit 3 above. Reconciliation, unknown
containment, ineligible force, or a force transaction that remains unsettled at
its bound exits 1 with exact `reconcile`, `watch`, and `wait` remedies. Circuit
sends no PID-derived signal when identity cannot be proved. SIGINT exits the
local client 130 while the durable request remains.

`--force` without `--decision` is invalid, exits 2, and signals nothing; the
operator must run ordinary `cancel` first. A malformed decision ID exits 2. A
well-formed but stale or expired decision exits 1 with current graceful status
and the exact command to rerun the graceful source and obtain a new action when
escalation is still legal.
Authentication and policy checks still run after ID validation.

Once `run.terminalizing` wins the ordering gate, cancellation is too late to
change the frozen outcome. A later `cancel` reports that target and waits for
close. `cancel --force` may still stop an unresponsive containment, but the
recovery worker completes the frozen terminal transaction; it does not relabel
the Run as canceled.

Cancellation cannot guarantee that a remote provider ignored a request it
already accepted. Circuit reports that uncertainty and reconciles it before any
retry.

## Workspace isolation and concurrency

Every root Run starts in a managed isolated workspace and is scheduled as
write-capable. The initial rebuild makes no read-only-concurrency claim. The
default per-project execution limit is one. A later concurrency increase
requires a platform isolation adapter and a connector capability that proves
the process cannot reach another workspace or the base checkout.

Isolation is required even while concurrency is one. Every effect process sees
exactly this execution filesystem view:

- its isolated workspace is the only writable project tree;
- the base checkout, `.circuit` evidence, private user state, runtime endpoint
  root, and every peer Run or workspace are absent or access-denied;
- toolchains and dependencies appear only as explicit read-only mounts recorded
  in `DependencyViewV1`;
- prompts, structured results, and control signals travel through brokered
  handles or mailboxes rather than additional writable host paths; and
- a symlink whose resolved target leaves an allowed root fails workspace
  materialization or effect launch.

`DependencyViewV1` records each source file identity or content-addressed
artifact, digest, destination, read-only enforcement, provenance, and
`ContentPinV1`. Accepted dependency content lives in Run-owned storage or
authoritative content-addressed user data. Ignored local dependencies such as
`node_modules` must be rebuilt from a bound lockfile into pinned content or
mounted read-only with their exact digest. User cache may hold downloads and
derivations, but is never authoritative. Plans, queued and nonterminal Runs,
and parked checkpoints retain their pins; rematerialization reads only pinned
content. Execution-only pins release after `terminal_cleanup_complete`; plan or
Run replay pins release only after prune, and never while another reference
remains. Dependencies are never inherited as an unmeasured host path.
Verification commands use the same view as connectors. A platform-adapter pair that cannot prove every
allow and deny rule may run only as trusted in-place foreground execution; it
cannot detach, resume after viewer exit, or claim isolated results.

### Mutation domain and snapshot barrier

Project identity and physical mutation identity are separate:

| Project form | `MutationDomainV1` |
| --- | --- |
| Git project | Canonical Git worktree root plus its file identity |
| Nested project anchor in that worktree | Inherits the worktree domain |
| Non-Git project inside an enrolled ancestor | Inherits the ancestor domain |
| Disjoint non-Git project | Canonical root plus its file identity |

`MutationDomainRegistryV1` gives every domain ID a permanent alias to one
canonical barrier and generation. Every snapshot, Invocation launch, Apply,
in-place Run, checkpoint re-entry, and prune resolves that alias again before
acquiring the barrier. A plan records the accepted alias ID; it never treats a
previous lock path as current authority. Alias records remain pinned while any
plan, Run, linked Apply, or prune tombstone names them.

Every holder enters through `MutationDomainAcquireTxnV1`: resolve alias ID and
generation, acquire the resolved shared/exclusive barrier, then re-read the
alias and compare canonical barrier identity/generation before protected work.
A mismatch releases the stale barrier and retries. The admitted receipt binds
alias, generation, barrier identity, mode, and holder; snapshot seal, Apply
precheck, in-place launch, checkpoint re-entry, and prune each revalidate that
receipt at their commit boundary. Merely resolving before lock acquisition is
never sufficient.

Overlapping filesystem roots cannot receive independent domains. Enrolling a
new overlapping root uses `MutationDomainMergeTxnV1`: mark every old alias
`merge_fenced`, acquire all old barriers exclusively in canonical ID order,
wait for admitted holders to drain, publish and sync one new generation plus
permanent redirect tombstones, then release the old barriers. A resolver that
paused before publication may acquire an old barrier afterward, but its
mandatory generation recheck fails and redirects it before work. New
acquisition through either alias therefore reaches the same lock. If the
platform cannot prove permanent redirect resolution, merging is blocked while
any plan, queued/parked/nonterminal Run, or Apply references either domain.
Regardless of platform, merge is forbidden while any source domain has an
active `MutationDomainBlockV1` or an Apply in `apply_recovery_required`. The
enrollment/relocation action returns the exact Apply repair command. Circuit
settles that Apply first, then creates a fresh merge plan; it never transfers or
redirects a drift block across generations.
Planning takes a shared
`SnapshotBarrierV1`; Apply takes it exclusively. A snapshot copies accepted
bytes, then repeats the complete path, content, and ancestor-identity scan
immediately before sealing and plan acceptance. Internal Apply cannot overlap
that window. External drift restarts planning; a later change makes the stored
plan drift rather than changing its sealed bytes.

For Git projects, Circuit builds the snapshot with a temporary index and a
temporary alternate to the base object store. It records the base commit,
staged and unstaged patch hashes, approved untracked paths, and a synthetic tree
of accepted bytes and modes. Before plan acceptance, it copies every reachable
object into a sealed plan-owned pack, removes the alternate, disables promisor
lookup, and passes an offline integrity check. Acceptance copies the sealed
pack into the Run. Base GC, movement, or deletion can no longer change it.
Partial clones must materialize every object or planning stops with a fetch
remedy. The initial adapter rejects gitlinks and dirty submodules until a
recursive self-contained snapshot passes the same proof.

Ignored files are absent unless represented by `DependencyViewV1`. Unapproved
untracked content contributes path metadata only. `SnapshotManifestV1`
canonically lists every accepted path, type, mode, content hash or symlink
target, exclusion decision, synthetic tree, pack hash, and object inventory.
The materializer validates symlink targets without following them into denied
roots. A logical `workspace_sha256` excludes checkout administration files but
binds the dependency-view digest. The worker must rematerialize that digest
before its first effect and after every checkpoint park.

For `result_materialization: isolated_patch`, the worker produces a result patch
relative to that snapshot. Applying the result to the base checkout is a
separate effect. The applying worker takes the
mutation-domain barrier exclusively, checks for drift, previews conflicts, and applies
only after the Run's policy allows it. A conflict never triggers a silent
merge.

Non-Git projects use a content-addressed manifest that excludes `.circuit` and
configured ignore paths, preserves regular-file bytes, modes, directories, and
symlink targets without following them, and rejects sockets and devices.
Workspace creation uses clone/reflink when the platform proves it and a normal
copy otherwise. Until that adapter passes atomic-copy and disk-full tests,
`--in-place --foreground` is an explicit escape hatch. It disables detach,
reconnect, and concurrency and prints those limitations in the plan. A process
crash may leave direct workspace edits that need ordinary source-control
recovery; Circuit does not label that profile durable or automatically replay
it. It cannot satisfy a production detach or first-use gate.

RunPlan binds `result_materialization: isolated_patch|base_checkout`.
`--in-place` always selects `base_checkout`: the worker's direct edits are the
materialized result, not a patch awaiting Apply. Plan validation forbids
automatic Apply, `SettlementPermitV1`, and any later-Apply approval for that
mode. After such a Run reaches a terminal result, `apply <run-id>` creates no
plan or effect and returns `APPLY_NOT_APPLICABLE` with reason
`result_already_materialized`, its final checkout digest, and report/inspect
remedies. Before terminal result, `apply` returns the ordinary current-state
wait/show remedy and never invents a final digest. Run results and reports
always name the materialization mode.

Initial concurrency rules:

- The project execution lock admits one executing root Run per canonical
  project instance, regardless of claimed read-only behavior.
- Base-checkout Apply operations are serialized by the physical mutation-domain
  barrier held by the applying worker, including overlapping nested projects.
- In-place Runs hold the mutation-domain barrier exclusively for their whole
  foreground Invocation, are serialized across overlapping projects, and cannot
  detach.
- Waiting checkpoints keep their workspace but hold no execution or
  mutation-domain barrier.
- Parallel isolated Runs are a later optimization. It ships only for a
  platform-connector pair whose sandbox denies the base checkout, other Run
  roots, evidence and private roots, and the runtime endpoint. Parallelism
  changes scheduling only; it does not introduce a weaker isolation profile.

### Workspace ownership by topology

Project identity remains the accepted project throughout the tree. Workspace
identity follows the topology:

| Topology | Workspace rule |
| --- | --- |
| Root or sequential child | Share the root `WorkspaceInstanceV1` |
| Parallel writable branch | Clone a branch workspace from one parent digest |
| Parallel read-only branch | Mount an immutable view of that parent digest |
| `aggregate-only` or `aggregate-survivors` | Discard branch file changes |
| `pick-winner` | Promote only the winner patch through a recorded merge effect |
| `disjoint-merge` | Prove disjoint paths, merge through one effect, and record the next parent digest |

No branch is a Git worktree linked to the base repository. Git branch
workspaces materialize from the sealed Run-owned object pack. Every join records
the parent digest before and after merge. Phase 5 explicitly replaces the
current fanout worktree path and removes any child reassignment of
`project_root`; branch code receives its own `workspace_root` instead.

### Linked Apply Runs

An Apply never appends after a terminal Run. Every Apply is a linked internal
system Run with its own Run ID, `ApplyRunPlanV1` (a closed specialization of the
RunPlanV1 executable payload), Trace, approvals, source Run ID,
source result digest, accepted base digest, and terminal outcome. A plan that
requires automatic apply creates it as a child in the current root tree before
the source closes; the source cannot close until that child is terminal and its
terminal payload records the linked ID and outcome.

Apply has two admission forms and they never share a scheduler claim:

| Form | Admission and process owner | Lock behavior | Control |
| --- | --- | --- | --- |
| `required_child_apply` | The parent append coordinator runs `InTreeApplyTxnV1`; the existing root worker executes it | Keeps the already-held project execution and Run append locks, then takes the mutation-domain barrier in normal order; it does not reacquire project execution | Root cancellation only |
| `later_root_apply` | A new root Invocation enters through `EnqueueTxnV1` with cause `linked_apply` | Its own worker takes project execution, Run append, then mutation-domain barrier | Ordinary root Apply control |

`InTreeApplyTxnV1` syncs `child.reserved`, installs the child manifest and exact
Apply plan, appends `child.apply_planned`, `child.started`, and `apply.started` through the root append
coordinator, and only then admits the Apply effect. It has no queue record,
scheduler claim, separate worker, or separate worker lease. Recovery of the
root Invocation continues the exact child Apply transaction or promotes its
unknown effect to root reconciliation. The source cannot wait on a worker that
is blocked behind its own project lock.

`InTreeApplyCompletionTxnV1` joins the required child back to its source. Before
child mutation, it freezes the parent's intended terminal target, the mapping
below, cancellation high-water, source result and child-plan hashes, and every
required parent result field:

| Required child state/outcome | Parent consequence |
| --- | --- |
| Child `complete` | Continue to the parent's frozen terminal target. |
| Child `conflict`, `failed`, `operator_settled`, or another aborted result | Parent terminal target becomes `aborted` with linked child outcome/reason. |
| Child `canceled` after root cancellation won ordering | Parent target is `canceled`. A child-only cancel is impossible. |
| Child `reconciliation_required` or `apply_recovery_required` | Parent remains nonterminal in the promoted root state until the child settles. |

After child terminal commit, the join transaction appends `child.joined`,
rechecks cancellation ordering, records exactly one mapped parent target, and
enters ordinary parent terminalization. Recovery uses a single-use
`RecoveryWorkReceiptV1(transaction_kind: in_tree_apply_join)` and never re-enters
the engine. Failure before or after child terminal, join append, private mirror,
or parent terminal response returns to that same transaction. Parent terminal
results include linked Apply ID, child terminal hash, and child Apply outcome.
Required-child repair commands may name the child Apply ID, but their action
context also names the root; child cancellation remains forbidden.

The required child plan is not a reusable public plan. `child.apply_planned`
acts as `ChildPlanReceiptV1`: it binds the source result, current base,
pre/postimages, runtime, mutation domain, and the parent RunPlan approval that
allowed automatic Apply. If user policy or the parent plan did not grant that
bounded capability, the root parks at an exact patch checkpoint before
mutation. A later root Apply instead uses `ApplyPlanTxnV1` and
`ApplyPlanReceiptV1` before acceptance.

`circuit apply <run-id> [--idempotency-key <key>]` plans a later linked Apply and
never reopens the source. It is eligible only for a terminal complete source
with `result_materialization: isolated_patch` and a retained result patch; all
other source states fail with their typed wait, outcome, retention, or
`APPLY_NOT_APPLICABLE` remedy before plan creation. `circuit apply --plan <apply-plan-id> --confirm
<apply-plan-sha256> --yes [--attach|--detach]` accepts it as a new root Run.
Attach is the default and uses ordinary Run output/exits; detach means accepted,
not applied. `circuit applies
show|cancel <apply-run-id>` are explicit control paths;
ordinary `runs show`, `watch`, `wait`, and `report` also accept its Run ID. The
Apply worker verifies the retained patch and current base, holds project
mutation, and uses the same intent, receipt, cancel, and reconciliation rules.
A conflict leaves the base unchanged and preserves the patch. Apply start
identity binds source Run, result digest, accepted base digest, project instance,
runtime, and protocol. The same key and identity returns the existing Apply
Run; changed identity fails. When omitted, Circuit derives and returns a stable
key from that complete identity. It starts only through `EnqueueTxnV1` and must
win the source Run's reference fence before acceptance.

The first later-Apply call is planning only in every presentation. It creates
immutable `ApplyPlanV1` from the retained source result and a fresh base scan,
returns `confirm_apply`, exits 3, never prompts, and creates no Apply Run or
mutation effect. It rejects confirm/yes/attach/detach. The change digest
binds the source/result, full preimage and postimage, accepted base, mutation-
domain generation, runtime, approvals, idempotency identity, mutation-exclusion
profile, and adapter proof. Only the exact
`apply --plan <id> --confirm <apply-plan-sha256> --yes` follow-up may accept the
Apply Run; drift
returns a new plan and makes no change. A controlling human TTY may inspect and
confirm only the already named `apply --plan` form inline.

`ApplyPlanReceiptV1` binds Apply-plan and source Run IDs, source-result and
accepted-base hashes, mutation-domain ID/generation, executable/artifact
hashes, runtime/protocol, planning idempotency-key hash, creation/24-hour expiry,
source-reference ID, and
`preparing|available|accepted|expired|abandoned|pruned` state.
`ApplyPlanTxnV1` privately reserves the complete source/result/base/mutation
identity and source-reference acquisition, installs and directory-syncs the
immutable project artifact, commits the source reference, then marks the
receipt available. Before availability, owner-death recovery removes only the
exact orphan and releases the reservation. The same key and full identity
returns the same plan after response loss; changed identity fails.

`ApplyPlanAcceptanceTxnV1` consumes the confirmation decision and CASes
`available -> accepted`, transfers the source reference to the new Apply Run,
and only then acknowledges queue acceptance. Expiry, abandon, prune, and
acceptance share that CAS, so one wins. Expiry blocks acceptance but does not
silently release references; expired or abandoned plans become prune-eligible.
`plans list --kind <run|apply|all>`, `plans show`, `plans abandon`, and
`plans prune` manage both kinds. Apply-plan prune transactionally closes its
fence, removes the artifact, and releases source/runtime/content references only
after commit. An accepted plan's references live with its Apply Run instead.

`applies cancel` accepts only a later root Apply. Naming an in-tree required
child fails with `CHILD_CONTROL_REQUIRES_ROOT` and the exact `circuit cancel
<root-run-id>` remedy. Circuit does not promote a child-only request silently;
the operator must choose tree-wide cancellation explicitly.

Base mutation is its own recoverable transaction:

1. Acquire the mutation-domain barrier exclusively and revalidate the accepted
   base identity.
2. Record and sync every affected path's file identity, bytes, mode, or
   nonexistence, plus relevant Git index state. These are the rollback
   preimages.
3. Build every postimage in a same-filesystem staging tree and sync it. Detect
   all ordinary conflicts now; failure before the commit intent leaves the base
   byte-for-byte unchanged.
4. Append and sync `apply.prepared` with the complete preimage, postimage, and
   target digests. Immediately before commit, take the control-ordering lock and
   import every request. Cancellation may win here, discard staging, leave the
   base unchanged, and close the Apply Run `canceled`. Otherwise append and sync
   `apply.commit_intent`; this is `ApplyCommitDecisionV1` and freezes exact
   roll-forward as the only recovery target.
5. Install each path by the proved atomic replacement primitive. Each
   `ApplyPathTxnV1` advances `installed -> directories_synced -> journaled`:
   sync the target parent, staging/source parent, and relevant Git index parent
   before its journal may claim that rename/create/delete durable. After
   `apply.commit_intent`, ordinary cancellation cannot stop the transaction
   halfway.
6. Recovery takes the same exclusive barrier before any other mutation and
   finishes the exact postimage, rechecks the complete base and Git-index
   digest, syncs the project and Git metadata roots, and only then appends
   `apply.completed`. A later cancellation is superseded for the
   Apply Run; force may stop a process but cannot change the decision. If a
   required child Apply commits while parent cancellation is pending, the child
   closes complete and the parent may then close canceled.

Every `ApplyPathV1` is project-relative and opened through no-follow directory
handles. It binds every ancestor identity, leaf preimage or nonexistence,
postimage, mode, Git index state, final precheck identity/hash, and
`mutation_exclusion_profile: circuit_coordinated|os_exclusive` with its adapter-
proof digest. Before each install or recovery write, the current state must
equal the expected preimage or already installed postimage. Symlink/reparse
substitution or drift visible at that final check moves the transaction to
`drift_blocked` before replacement.

`circuit_coordinated` excludes Circuit v2 writers only. Editors, Git, other
users, and old binaries do not honor its barrier, so it does not claim to
preserve an external write that races between the final check and unconditional
atomic replacement. The plan header warns the operator not to edit the checkout
during Apply. `os_exclusive` may make the stronger “overwrites no racing write”
claim only when the platform proves an enforceable deny-write/delete handle
from before final validation through replacement and directory sync. Recovery
reacquires the declared profile; a path matching neither preimage nor postimage
enters transaction substate `drift_blocked`, and recovery never rolls back
after commit intent over newer external work. The Apply Run moves to
nonterminal `apply_recovery_required`. `MutationDomainBlockV1` uses this closed
admission matrix even when no repair worker holds an OS lock:

| While blocked | Admission |
| --- | --- |
| Show, watch, wait, report, export, and `repair inspect` | Read-only; allowed |
| Root cancel/force needed to prove the predecessor exited | Exact control transaction; allowed |
| `applies repair plan` for this Apply and block generation | Shared mutation barrier, alias/block revalidation, checkout scan, then release; allowed |
| Confirmed `applies repair apply` for that exact plan | `settlement_only` plus exclusive barrier; allowed |
| Ordinary Run/Apply plan or start, snapshot, in-place launch, unrelated mutation, project enrollment/relocation, domain merge, or prune | `APPLY_DRIFT_BLOCKED`, exit 1, with exact show and repair-plan remedies |

The repair-plan exception creates no general planning authority. A stale block
generation returns a fresh read-only planning remedy and changes nothing.
Staging, preimages, postimages, runtime/source references, and the block remain
pinned. Staging is on the same filesystem and inaccessible to effect processes.

`ApplyDriftRecordV1` binds Apply Run/transaction, mutation-domain alias and
generation, installed-path journal, every expected preimage/current/postimage
hash and file identity, exclusion profile, staging closure, and allowed repair
strategies. Attached Apply and `wait` return `resolve_apply_drift` and exit 3;
`watch` reports the state as a viewer. There is no terminal `drift_blocked`
result.

Repair is always two-step:

```text
circuit applies repair plan <apply-run-id> --strategy <continue-if-restored|preserve-current|overwrite-current>
circuit applies repair apply --plan <apply-repair-plan-id> --confirm <repair-plan-sha256> --yes
```

`ApplyDriftRepairPlanV1` freezes the complete current checkout, original
pre/postimages, already-installed paths, exact newer bytes that would be
preserved or overwritten, resulting full-checkout digest, and transaction
boundary. `continue-if-restored` changes nothing unless every conflicting path
has independently returned to an allowed original preimage or postimage.
`preserve-current` makes the named newer bytes part of an explicit complete
settlement image; `overwrite-current` previews and explicitly authorizes every
newer byte lost. Neither choice silently adopts a partial Apply.

`ApplyDriftRepairPlanReceiptV1` gives that artifact a closed, single-use
lifecycle: `preparing|available|accepted|expired|superseded|pruned`. It binds
the Apply/drift generations, strategy, complete repair artifact hash, current
checkout identity/hash, settlement image, mutation-domain block generation,
runtime and staging references, creation time, and a 15-minute acceptance
deadline. Planning privately reserves that exact identity before installing the
immutable project artifact; identical response-loss retry returns the same
receipt, while changed bytes or strategy creates no competing plan. A newer
drift generation CASes every older available plan to `superseded`. Confirmation
CASes only `available -> accepted`; expiry, supersession, acceptance, and prune
have one winner. All repair plans retain the block, staging, pre/postimages, and
runtime/source references until their receipt is terminal and the accepted
settlement commits or explicit prune completes. A plan can never outlive or
release the underlying `apply_recovery_required` authority.

`ApplyDriftSettlementTxnV1` runs under `settlement_only`, reacquires and
revalidates the current mutation-domain generation, CASes the durable block to
the repair plan, installs that exact complete settlement image, syncs every
path/Git/directory boundary, and commits a receipt before releasing the block
or pins. Original roll-forward closes the Apply `complete`; a modified operator
settlement closes it `aborted` with `apply_outcome: operator_settled` and the
repair receipt. Drift during repair creates a new blocked generation and a new
plan. Terminalization, prune, another mutation, and reference release remain
illegal until one settlement receipt commits.

Authoritative staged postimages remain until the final digest and parent-
directory durability checks commit. A platform without a proved directory-sync
or equivalent write-through replacement primitive cannot claim durable Apply.

No partially applied checkout is an allowed settled Circuit state. A pre-decision
failure or cancellation leaves the base unchanged; a post-decision failure
rolls forward or remains visibly nonterminal `apply_recovery_required`. Success records
`apply_outcome: complete`; pre-decision conflict/failure/cancel map to
`conflict|failed|canceled`; an operator-modified drift settlement maps to
`operator_settled` plus terminal Run outcome `aborted`. Failure injection
kills the Apply worker before and after every prepare, intent, rename, target or
source parent sync, journal, final digest, drift check, and receipt boundary.
Forced process termination may delay a cancel
response, but recovery still honors the frozen decision before the Run can
close.

## Root model

All clients construct one `ProjectContext` at their boundary. Application and
runtime code receive it as input. They do not consult ambient cwd.

### Project root precedence

1. Explicit `--project-root` or structured `project_root` from CLI or host
   input.
2. Nearest `.circuit/config.yaml` between cwd and the current Git worktree root.
3. Git worktree root.
4. Cwd for a non-Git directory.

`circuit init --here` creates an intentional nested project anchor. Circuit
uses the canonical real path for locks and identity and preserves the path the
operator typed for display. Host hooks continue to read workspace identity from
their stdin JSON, as required by the
[host adapter contract](../contracts/host-adapter.md).

### Storage roots

| Root | Contents | Authority |
| --- | --- | --- |
| Package assets | Built-in flows, schemas, static UI assets | Installed runtime manifest |
| Project | `.circuit/config.yaml`, Runs, history, memory, continuity | Project and operator |
| User config | Personal preferences, policy, trusted connector definitions | Operator |
| User state | Root set, cross-project index, install receipts, queues, control journal, leases, fencing, references, migrations | Supervisor and CLI |
| User data | Content-addressed runtime versions and adapter manifests | Signed release manifest |
| User cache | Downloaded archives and rebuildable metadata | Disposable |
| Runtime endpoint | Socket or pipe and replaceable boot-scoped handles | Current user only; never durable authority |

Unix and macOS use the
[XDG Base Directory specification](https://specifications.freedesktop.org/basedir/):

- config: `${XDG_CONFIG_HOME:-$HOME/.config}/circuit`
- state: `${XDG_STATE_HOME:-$HOME/.local/state}/circuit`
- data: `${XDG_DATA_HOME:-$HOME/.local/share}/circuit`
- cache: `${XDG_CACHE_HOME:-$HOME/.cache}/circuit`

The Unix runtime-endpoint resolver is exact:

1. Use `<XDG_RUNTIME_DIR>/circuit-<uid>` only when `XDG_RUNTIME_DIR` is absolute,
   local, owned by the current UID, not reached through a symlink, and mode
   `0700` or stricter.
2. On macOS, otherwise use `<confstr(_CS_DARWIN_USER_TEMP_DIR)>/circuit` when
   that directory passes the same owner, local-filesystem, and no-symlink
   checks.
3. Otherwise use
   `/tmp/circuit-<uid>-<first12-sha256-of-canonical-home>` only when `/tmp` is a
   root-owned, sticky, local directory and the per-user directory can be
   atomically created no-follow at mode `0700`.

Every component is reopened no-follow and checked for owner, mode, file
identity, and local filesystem. The endpoint stores only the operating-system
boot ID, supervisor generation, socket, and replaceable challenge handles. It
contains no queue, lease, fence, control request, runtime authority, or
reference high-water mark. Circuit retires a stale endpoint generation only
while holding `StableSupervisorElectionV1` and after its authenticated probe
fails. Surviving workers are expected and authenticate to the newly published
generation; emptiness is required only before deleting their containment
authority, never before replacing transport.
The final socket path must fit the platform `sockaddr_un` limit; otherwise the
resolver stops with an exact path remedy. There is no permissive fallback.

Windows uses these separate roots:

- config: `%APPDATA%\Circuit\Config`
- state: `%LOCALAPPDATA%\Circuit\State`
- data: `%LOCALAPPDATA%\Circuit\Data`
- cache: `%LOCALAPPDATA%\Circuit\Cache`
- runtime endpoint: an owner-SID named pipe plus
  `%LOCALAPPDATA%\Circuit\Runtime`

Every control directory and pipe restricts access to the owning user SID.

`BootstrapDiscoverySlotV1` prevents a newly installed transport from inventing
a second bootstrap root. It is a strict union with
`empty|install_reserved|root_set_committed|recovery_anchor|transition|tombstoned`
variants. Root-set variants record user/machine digests, root-set ID/generation,
canonical bootstrap path/file identity, registration transaction, stable
activation identity, and authenticated target digest. A `RecoveryAnchorV1`
variant instead records only its anchor generation, former root-set ID,
recovery-key-set digest, supported backup-envelope range, and retention receipt;
it contains no bootstrap path, runtime, activation, or mutation authority.
`transition` binds one exact install, relocation, purge, or recovery transaction.
A pointer grants no authority until its matching variant and target proofs
verify.

The proved adapters are a local-only non-synchronizing macOS Keychain record
plus fixed launchd identity; an owner-SID Windows registry key plus named mutex;
and a root-provisioned, owner-private Linux slot under
`/var/lib/circuit/users/<uid>/machines/<machine-hash>/`. A Linux installer that
cannot provision or verify that fixed local slot cannot advertise durable
multi-transport installation. It may offer the explicit limited contributor
profile, but cannot create a second authority under XDG or a custom path.

Before reserving an empty current-machine slot, install registration enumerates
owner-scoped fixed slots and probes the canonical or explicitly supplied
bootstrap target for an authenticated root set. A valid prior root set with a
different machine digest returns `MACHINE_IDENTITY_CHANGED` and the repair-
machine command instead of creating a new authority. Multiple candidates return
`ROOT_SET_CONFLICT`. An undiscoverable old custom path cannot be guessed; the
operator supplies it explicitly to machine recovery.

`UserRootSetV1` then prevents environment changes and shared homes from
creating two Circuit authorities. It is scoped to user plus stable machine
identity, not boot ID. The discovered bootstrap anchor contains the locator,
election lock, stable control launcher, and relocation journal and never moves
with config/state/data. It contains no secret. The root set records random
root-set ID, generation, machine-identity digest, canonical user identity,
exact config/state/data/cache roots and file identities, and any pending
registration, relocation, or machine-rebind transaction. When the platform can
create one, it also records the public key/provider digest for
`NonCloneableMachineKeyV1`; its private key is hardware/OS-bound and
non-exportable.

The adapter obtains machine identity from the OS installation identity
(`/etc/machine-id`, macOS platform UUID, or Windows MachineGuid), hashes it with
the protocol namespace, and never prints or transmits the raw value. Missing,
changed, or duplicate identity is a setup/repair blocker, not a guessed
continuation.

The default bootstrap target is the canonical account home only when it passes
the capability probes below. Otherwise the installer requires an explicit
machine-local persistent bootstrap path. `--bootstrap-root` chooses only that
target during first registration; it never moves or replaces the fixed
discovery slot. Signed launchers remain generic and discover the committed
slot rather than embedding a mutable user path. Ambient XDG variables cannot
override it later. Every frontend and activation adapter resolves the slot
before XDG or platform defaults. Defaults select roots only when no root set
exists. Two machines sharing a home use different slots, and two valid XDG
environments on one machine reach the same authority.

`RootCapabilityV1` is a mutation prerequisite, not a warning. The bootstrap
anchor and authority-bearing user state must be machine-local, persistent across
logout/reboot, user-private, no-follow, and prove cross-process locking, file
identity, atomic same-filesystem replacement, file and directory sync, and
crash recovery. User data must additionally support immutable executable
publication; the bootstrap target must support signed stable-launcher
publication; config must support `ConfigWriteTxnV1`. A failed bootstrap/state
probe permits only help, version, setup diagnosis, and proved evidence reads. It
does not fall back to a mutating foreground Run, because that would create
ambiguous process authority. Project Run evidence must also prove its required
lock, append, atomic-replace, and sync primitives before any Run. The
`foreground-only` profile is for missing process containment/workspace
isolation, never for an unsafe evidence store.

The Unix locator and its parent are mode `0600` and `0700`; the Windows key is
owner-SID only. A second valid locator/root-set ID for the same user and machine
is `ROOT_SET_CONFLICT`, never a last-writer-wins migration. Repair can adopt or
retire one only after proving every worker and containment empty.

Root changes use `UserRootRelocationTxnV1` through `setup plan` and `setup
apply`; changing environment variables never moves data. Relocation requires
all workers and containments empty, holds `StableSupervisorElectionV1`, blocks
new scheduling, control, config writes, install/update, backup, reference/GC,
and repair mutation, and first requires any legacy/canonical
config conflict to be resolved. Its manifest binds old/new root-set and
discovery generations, installation-receipt and runtime-reference high-waters,
every `ActivationBindingV1` and frontend bootstrap binding, and an old-control-
launcher retention pin. Each binding records adapter kind, stable service
identity, current/desired executable identity and digest, registration digest,
and reload verifier.

| Phase | Durable boundary | Recovery |
| --- | --- | --- |
| `prepared` | Fence mutators and inventory exact roots, references, launchers, and activation bindings | Abort to the old root set |
| `copied` | Copy and sync exact config bytes, state, and authoritative data; discard cache | Abort to the old root set |
| `target_verified` | Reprove `RootCapabilityV1`, hashes, permissions, and reference closure | Abort to the old root set |
| `locator_committed` | Discovery/root-set generation points to the new roots | Roll forward only |
| `bindings_committed` | Every stable service and frontend binding resolves the new generation; legacy data-root targets are retargeted | Retry exact bindings; retain old launcher |
| `cold_start_verified` | Stop the supervisor and start it only through OS activation, then prove new roots and controller | Retry; retain old roots and launcher |
| `source_tombstoned` | Old config/state/data become non-authoritative | Finish exact cleanup |
| `cleaned` | Remove eligible old roots and obsolete launcher only after parent-directory durability | Complete |

The normal stable bootstrap launcher path does not move; the binding inventory
still catches older registrations that point into user data. Matching manifests
live at the fixed slot, bootstrap anchor, and both old/new roots. The old roots
remain tombstoned until the new supervisor, runtime references, config hash,
project mirrors, every activation binding, and a logout/reboot cold start pass.
Failure injection covers every copy, sync, locator swap, binding update,
concurrent activation, cold start, and cleanup boundary.

The current endpoint address and generation live in persistent user state. On
logout or reboot the endpoint may disappear. The next client takes the same
stable election authority, creates a safe endpoint using the resolver above,
publishes its address, and recovers queues, leases, control requests, and pins
from user state before scheduling.

Project Run evidence remains under `<project>/.circuit/runs/`. The user index
stores only Run ID, canonical project root, state, and update time. It stores no
goal or evidence content. It is lazily repopulated as projects are revisited;
Circuit cannot globally rediscover every historical checkout after index loss.
Private records for active workers remain independently authoritative.

### Asset resolution

The installed runtime supplies built-in flow bytes through an `AssetProvider`.
Published custom flows resolve through `FlowRegistryV1`; `--flow-root` remains
only a dated legacy parser adapter. A target project cannot replace an installed
built-in by adding `generated/flows`. Source development uses a separate hidden
`source-checkout` Asset Provider selected by an explicit contributor command
and verified checkout root; it never uses the production `--flow-root` flag or
an ambient environment redirect.

The replacement is concrete. Hidden `CommandSpecV2` leaves `circuit dev
preview|plan|run` accept required `--source-checkout <path>` and otherwise use
the ordinary Preview/Run grammar and result contracts. They are available only
through an active `source` installation receipt whose trusted commit/tag,
checkout root file identity, build-manifest hash, catalog hash, and generated-
asset drift check reproduce `SourceCheckoutAssetProviderV1`. Installed direct,
manager, npm, and host frontends reject the leaves even if pointed at a valid
checkout. The provider hashes and copies exact built-in package bytes into the
plan; it cannot publish a custom Flow, change runtime authority, or use an
environment selector. Phase 1 migrates every test, release script, and
contributor launcher to these leaves before the `--flow-root` node can reach
zero consumers.

The adapter has a finite cutover. Release N inventories every launcher and
manifest that supplies `--flow-root`, warns on use, and returns the exact `flows
migrate plan/apply` remedy. In N+1, installed, package-manager, and host
production frontends reject it before planning or spend; unresolved legacy
assets block that project's storage-v2 cutover but never extend the flag's
writer life. Through N+3 and at least 180 days, the parser may recognize the
flag only to return its migration remedy. It cannot start a production Run.
Earliest N+4 removes the parser branch. Existing Runs remain readable because
their accepted Flow bytes are copied and pinned. Contributor source execution
uses only the verified checkout provider throughout this schedule.

Immutable custom package bytes live in user-data content-addressed storage;
registry generations and receipts live in user state. `FlowRefV2` accepts an
unqualified Flow ID or explicit `builtin:<id>|user:<id>|project:<id>` reference;
the qualified forms select only that scope and remain available as migration
remedies. Each entry binds Flow ID,
`user|project` scope and project instance when applicable,
`generated|imported_v1` origin, package-manifest hash, every compiled Flow/
descriptor/skill/command content reference and hash, promotion receipt, and
`active|retired` state. `ProjectionReservedNameSetV1` is versioned and permanently reserves
every built-in Flow ID, exported `CommandSpecV2` word/alias, host command and
skill name, and protocol namespace; a custom Flow may not use IDs such as
`run`, `setup`, or `handoff`. Two project
entries may share an ID only for different project instances; an applicable
user and project entry with the same ID is `FLOW_ID_CONFLICT`, never silent
shadowing. RunPlan binds registry generation, entry digest, and exact bytes.

An update runs `ReservedNameCompatibilityV1` against every active custom entry
before activating a new reserved-name-set generation. A newly added CLI, host,
or protocol name grandfathers an existing custom Flow for qualified canonical
`run user:<id>` or `run project:<id>` use but removes or withholds its direct
projection; new promotions of that ID are rejected. A newly added built-in with
the same ID makes unqualified `run <id>` return `FLOW_ID_CONFLICT` with exact
qualified choices; existing plans/Runs stay pinned and the custom Flow remains
usable by its qualified ref. The update may not retire, hide, or delete the
custom entry silently. Doctor warns for one release before a known collision,
and update compatibility records every grandfathered ID and projection change.

Collision migration is activation-critical, not a best-effort projection
rebuild. `ReservedNameCompatibilityPlanV1` binds old/new reserved-set
generations and hashes, signed release/runtime manifest, Flow-registry
high-water, every affected custom entry and qualified before/after resolution,
the complete host-projection inventory and expected postimages, and every
current frontend head. `ReservedNameCompatibilityTxnV1` runs inside
`FrontendUpdateTxnV1` and late-frontend promotion:

```text
registry_and_projection_writers_fenced
-> collision_inventory_rechecked
-> host_invocation_gates_acquired
-> projection_removals_installed_synced_and_verified
-> registry_and_reserved_set_prepared
-> registry_head_runtime_authority_committed
-> projection_receipts_finalized
-> host_invocation_gates_released
-> fences_released
```

The central private CAS advances the grandfathering registry receipt,
reserved-name generation, expected frontend head, and any runtime authority
together. Before that CAS, every affected projection postimage is already
installed and directory-synced while a proved host-invocation gate prevents
launch from the changing package. A host may use an atomic package-pointer swap
as the gate only when its adapter proves that every invocation crosses the
generation-checking launcher. `projection_receipts_finalized` records the
already-installed bytes; it does not expose them for the first time. Before the
central CAS, recovery restores and syncs the old projection bytes, then releases
the gate. At or after the CAS, recovery only rolls the exact new qualified entry
and projection receipts forward before releasing it. An unsafe or unverifiable
host file, cache, invocation path, or package swap keeps the new frontend
`quarantined_incompatible` and the old runtime authority active. A host must see
either the complete old projection or the new built-in plus qualified custom
Flow, never two meanings under one direct name. A cached command is acceptable
only when it provably re-enters the generation-checking launcher; otherwise it
prevents the central CAS rather than becoming later cleanup.

Host projection identity is
`(host, projection_kind, scope, project_instance_id?, flow_id)`. User-scoped
Flows may receive one global projection. Project-scoped Flows receive a direct
projection only when the host proves project-local namespace isolation. Claude
and Codex global plugin caches do not, so their custom Flows remain available
through the generic project-aware `run <flow>` host surface and receive no
colliding global file. Built-in projections remain static. Every projection is
rebuildable from the registry and is never Flow authority; setup owns repair
and reports unsupported direct-projection capability plainly.

Every deterministic or model-generated draft gets immutable
`FlowDraftReceiptV1`: draft and Flow IDs, producer and optional origin Run/
project, requested scope, canonical home, draft/validation hashes,
`FlowRegistryTargetV1`, before-state hash, and creation time. The target is a
closed value containing `user|project` scope, project instance when scoped,
expected registry generation, and the reserved destination Flow ID; it is not a
mutable filesystem path. Two drafts may share a Flow ID; promotion never looks
one up by name. `flows promote --draft <draft-id>` and `flows replace --draft
<draft-id>` are project-context `none` because the receipt selects origin,
scope, bytes, and destination.

`FlowPromotionTxnV1` prepares the receipt/target, publishes immutable content,
CASes the registry generation, commits host projections, and closes. A host-
projection failure leaves canonical `run` usable and setup reports the repair.
That best-effort rule applies only to ordinary custom promotion/rebuild; it
cannot weaken activation-critical reserved-name removal above.
Promotion rechecks draft, home, target, and before-state. An active entry makes
`flows promote` fail without change and returns the explicit `flows replace
--draft <draft-id>` remedy.

`FlowReplacementTxnV1` is a separate digest-confirmed operation. Its plan binds
the draft/receipt, exact active registry entry and generation, old/new package
hashes, reference inventory, and host-projection before state. Apply publishes
the new immutable bytes, CASes only that exact active entry to the new digest,
commits rebuildable projections, and records the old entry as superseded. New
plans resolve the new generation; existing plans and Runs keep their old
content references. Response loss returns the same replacement receipt, and
drift returns a fresh plan without changing resolution. No replacement targets
a built-in or resolves a draft by Flow name.

`flows retire` removes resolution immediately, writes a tombstone, and lets
reference GC remove content only after plans, Runs, drafts, and host projections
release it. A later fresh promotion may reuse a retired custom ID only when its
draft target binds the exact tombstone generation and hash.

Drafts have their own closed lifecycle. `FlowDraftReceiptV1.state` is
`available|promoted|abandoned|pruned`; promotion and abandon CAS only from
`available`, and the winning promotion records the registry receipt. `flows
drafts list [--state <available|promoted|abandoned|all>]`, `flows drafts show
<draft-id>`, `flows drafts abandon <draft-id>`, and two-step batch `flows
drafts prune` expose it. Prune refuses an available draft,
an incomplete promotion, or any retained content/host-projection reference,
then uses the same private/data reference transaction as plan prune. Nothing
expires or disappears merely because a draft is old.
The list selects the current project and returns applicable user drafts plus
drafts for that exact project instance; it never crosses into another project.
The ID-based show, abandon, prune, and promote forms resolve the immutable
receipt first and do not use cwd as authority.

`LegacyFlowCandidateV1` gives every discovered manifest entry an immutable
candidate ID bound to legacy home/path identity, original Flow ID, exact bytes,
validation result, collision set, and owning project/scope evidence. `flows
migrate plan` may take `--decisions-file <path-or->`, a strict
`FlowMigrationDecisionSetV1` containing exactly one decision per unresolved
candidate:

```ts
type FlowMigrationDecisionV1 =
  | { candidate_id: LegacyFlowCandidateId; disposition: 'import';
      scope: 'user' | 'project'; as_flow_id: FlowId }
  | { candidate_id: LegacyFlowCandidateId; disposition: 'retire' }
  | { candidate_id: LegacyFlowCandidateId;
      disposition: 'freeze_inspect_only' };
```

Missing decisions return `resolve_flow_migration_candidates`, a bounded
candidate inventory, and an exact JSON template. Import under a new ID uses the
schema-aware Flow compiler and full validation; it never text-replaces unknown
content. A candidate that cannot be safely normalized must retire, freeze, or
be recreated through `flows create|generate`. Retire writes a candidate
tombstone; freeze copies exact bytes into inspect-only content with no resolution
or host projection.

`LegacyFlowRegistryMigrationTxnV1` reads the current custom manifest and every
explicit legacy home no-follow, verifies listed absolute paths, copies exact
bytes into content storage, and only then commits entries. It never keeps a
mutable legacy path as authority. Ambiguous/colliding entries remain unresolved
and block production storage-v2 cutover until migrated, retired, or frozen
inspect-only; they never extend the adapter deadline. Plan/apply bind the exact
candidate and decision-set hashes; response loss returns one receipt. The public lifecycle is
`flows migrate plan/apply`, registry-backed list/show/validate, explicit draft
list/show/abandon/prune, draft-ID promotion and replacement, and
digest-confirmed retirement.
Registry, drafts, projections, and references participate in backup,
relocation, purge, update compatibility, and GC.

The worker snapshots exact flow bytes into the Run folder, preserving the
current manifest-hash contract. Resume therefore does not depend on the
original package path.

## Runtime ownership and distribution

Initial installation has a separate trust boundary from update. TUF protects a
trusted installation after its root is known; an archive cannot establish trust
by carrying its own root. `InstallBootstrapV1` therefore authenticates the first
executable through a trust source obtained outside that archive, then verifies
the embedded TUF-root digest before any downloaded Circuit code executes.

| Transport | Required first-executable trust |
| --- | --- |
| Direct macOS | Gatekeeper-valid notarized signature from the pinned Circuit Team ID; the signed bootstrap pins the TUF-root digest |
| Direct Windows | Authenticode chain to the pinned Circuit publisher identity; the signed bootstrap pins the TUF-root digest |
| Direct Linux | A verifier already installed by the OS/package manager plus a Circuit signing-key fingerprint obtained through a separately authenticated channel; no `curl | sh` path is supported |
| Homebrew / WinGet | Manager-authenticated official repository or manifest, publisher identity, and package digest, followed by the inner TUF-root check |
| npm | Registry integrity and verified release provenance bound to the official source identity, checked before the launcher is enabled, followed by the inner TUF-root check |
| Claude / Codex marketplace | Host-verified publisher and package identity, followed by the inner TUF-root check before runtime installation |
| Source | Verified signed release tag or commit from an already trusted maintainer key |

If a transport cannot supply that proof, it is an unverified contributor path,
not an advertised installer. The clean-install matrix swaps the archive and its
embedded root together, substitutes another valid code-signing identity,
replays old metadata, and changes the release manifest. Every case must fail
before execution. Each transport records the bootstrap identity and TUF-root
digest in its installation receipt so later doctor and update checks can explain
the trust chain.

Every transport registers through `InstallRegistrationTxnV1` before it may
create a root set or activate a frontend. The transaction binds installation
and transaction IDs, the fixed discovery-slot identity and generation, proposed
bootstrap target, root capability proof, release and controller digests,
frontend receipt, stable activation identity, installer process birth identity
and containment, transport, cleanup-controller digest, and every provisional
reference:

| Phase | Durable boundary | Recovery |
| --- | --- | --- |
| `slot_reserved` | Fixed slot CAS reserves the installation, transaction, proposed bootstrap target, and exact installer owner | Re-register the owner; if exact owner exit and absence of every later artifact are proved, CAS to `abandoned` |
| `abandoned` | Owner exit, empty candidate target, and no payload/reference commit are proved | A later installer may create a new reservation; the tombstone prevents replay |
| `root_prepared` | Exact `UserRootSetV1`, stable launcher, and capability proofs sync at the target | Cleanup controller finishes the exact root; never abandon |
| `payload_registered` | Runtime, controller, proposed frontend receipt/head, and references are staged | Finish the exact payload and continue to slot commit; individual uncommitted blobs may be recreated, but the transaction cannot abandon |
| `slot_committed` | Discovery-slot CAS authenticates the root-set ID and generation | Roll forward; never create another root set |
| `activation_committed` | Stable OS registration reaches the bootstrap launcher | Retry the exact registration |
| `complete` | One private CAS commits the immutable receipt, installation head, frontend-set generation, and installation receipt; the reservation closes | Return the existing installation |

No launcher embeds a selectable bootstrap path in signed executable bytes.
After `root_prepared`, recovery never abandons the transaction: the signed
cleanup controller rolls the exact registration forward even when the original
transport frontend is gone. Before that boundary, abandonment requires exact
owner/containment exit and proved absence, never timeout. The first installer
holds a kernel installation lock in the fixed slot from reservation through
`root_prepared`; acquiring that same nonce-bound lock after the recorded process
birth identity exits is the abandonment proof. No subprocess may be spawned in
the abandonable phase. Incomplete
registration retains its payload and launcher references. Concurrent
direct, npm, and host first-use tests kill either installer after every phase;
exactly one slot, root set, and supervisor election may result.
When the slot is already committed, a later transport verifies it and creates a
per-install reservation under that same anchor and generation; it cannot
propose another bootstrap target or replace the slot. The first-install table's
`slot_reserved` phase is therefore a slot CAS only for the winner and a
generation-bound join for every later transport.

Later does not mean automatically compatible. Before an installation receipt
may become active, `InstallRegistrationTxnV1` intersects its frontend RPC/plan/
feed/config/storage ranges with the current runtime authority, active root set,
enrolled project generations, and mandatory controllers. `FrontendReceiptV1`
state is `active|quarantined_incompatible|tombstoned`. An empty or unsafe
intersection commits only `quarantined_incompatible`; that launcher may run
version, status, setup/doctor, its own update/repair/uninstall, and evidence-only
reads, but every Run/config/control mutation fails before private/project state.
Quarantined receipts and restored old host caches are excluded from
`AuthorityCompatibilityClosureV1`, so they cannot poison the machine.

Immutable receipts are history, not authority. Every installation has one
`FrontendInstallationHeadV1`: installation ID, monotonic head generation,
current receipt ID/hash, `active|quarantined_incompatible|removing|tombstoned`
state, prior-head hash, and frontend-set generation. Install registration,
update, rollback, promotion, installation repair, and uninstall must CAS the
expected head; two operations cannot fork from the same prior receipt. A failed
head CAS leaves any staged payload non-authoritative and cleanup-owned.
`AuthorityCompatibilityClosureV1` reads only current heads. A historical receipt
whose recorded state was active never remains a closure member after its head
advances.

`InstallationPromotionTxnV1` is the only
`quarantined_incompatible -> active` path. After a verified frontend update it
recomputes the whole closure, self-tests the current endpoint/controller, and
CASes the exact head/receipt generation. A later downgrade or cache restoration
creates a new quarantined receipt; it never rolls an active receipt backward.

One release may use several install transports. All transports resolve into one
shared content-addressed runtime store:

```text
<UserDataRoot>/runtimes/<version>/<runtime-digest>/
```

Release security is a ratified contract before updater work. Circuit uses
TUF-compatible signed metadata, following the
[official specification](https://theupdateframework.github.io/specification/latest/):
an embedded 2-of-3 offline root threshold, role/key IDs and threshold rotation,
canonical signed bytes, monotonically increasing snapshot/channel versions,
expiry, archive and platform digests, and component-scoped revocation. A key
delivered beside a manifest is never a trust root. Bare update rejects expired
metadata, version rollback, and every revoked component. Explicit rollback may
select an older locally verified release, but never a revoked one.

Each `SignedReleaseManifestV1` names the runtime digest, flow-catalog digest,
supported platform, compatibility-controller digest, and protocol ranges for
plan, config, feed, control RPC, and Run storage. A client outside the mutation range may inspect compatible
Runs and cannot directly mutate them. It may control an existing pinned Run
only through that runtime's retained bootstrap adapter below; it cannot use the
exception to create a Run or mutate storage with its own protocol.

Each accepted Run records its runtime version and digest. Every nonterminal
Run, including interrupted and reconciliation-required Runs, pins that runtime
until it becomes terminal or is safely pruned. Updates install new versions
beside old ones. Garbage collection cannot remove a pinned runtime.

`RuntimeAuthorityV1` is one per-user, per-machine execution default, not one per
frontend:

```text
authority_generation
active_runtime_version
active_runtime_digest
manifest_digest
channel
previous_runtime
changed_by_installation_id
```

Installation ID selects transport ownership only. Every direct, npm, Claude,
and Codex frontend asks the elected supervisor for the same authority. A
host-bundled runtime is a candidate payload until verified, installed in the
shared store, and selected by the authority transaction. `RunPlanV1` binds the
runtime digest and authority generation. Update stages and self-tests, then
compare-and-swaps this single pointer; existing Runs keep their pins. `self
status` shows the global runtime separately from every frontend receipt.

Every runtime payload includes a signed `ControlBootstrapV1` adapter with a
small stable administrative protocol. Through the Run's pinned runtime it can
inspect, watch, wait, start a pinned worker, resume, cancel, answer a checkpoint,
reconcile, report, and export that Run. It cannot plan or start an unrelated
Run. The current supervisor delegates Run-specific control to this adapter when
the pinned runtime falls outside its normal new-Run mutation range. A live pin
therefore retains both the runtime and its bootstrap adapter.

No-spend control does not depend on executing revoked engine code. The shared
store also carries independently signed `CompatibilityControllerV1` bundles
keyed by Run-storage and control protocol. The current controller can inspect,
watch, wait, cancel, record reconciliation decisions, report, and export without
launching the pinned engine or its private Node. Revocation scopes `engine`,
`control-bootstrap`, `private-node`, or the whole payload. A revoked engine
cannot resume or admit an effect; a patched current controller may replace a
vulnerable bootstrap without changing the engine pin. Every release proves its
controller against every still-supported pinned storage version.

An update may become active only after the new supervisor proves both each
unrevoked pinned bootstrap needed for execution and the independent controller
needed for mandatory no-spend operations. Parked and reconciliation Runs count
even without a worker. Otherwise the payload stays staged.
Current-and-previous protocol support governs creation of new Runs, not control
of existing pins.

Host plugins become thin host adapters plus a signed release manifest. A host
may ship a runtime payload, locate a shared runtime, or download one after
explicit consent. In each case it installs the immutable payload into the
shared store before execution. Marketplace feasibility needs a spike before
Circuit promises a no-Node host install.

The product requirement is “no user-installed Node.” A private Node archive
with a small launcher is the baseline package. Node SEA may replace it only if
it passes the same behavior matrix. SEA remains an active-development feature,
and the current `process.execPath <script>` pattern must disappear under either
package shape. Hidden internal commands replace script re-entry:

```text
circuit internal git-state
circuit internal worker --invocation <id>
```

Package-manager breadth follows the runtime proof. The planned transports are
the standalone signed archive, host marketplaces, Homebrew, WinGet, and npm as
a compatibility and contributor route.

## RunPlanV1: a launch contract

`circuit preview` remains a zero-spend, non-persisted selection view. It can
show one Flow or the Power matrix without a goal.

`circuit plan <flow> --goal <text>` creates `RunPlanV1`. The plan is goal-specific
and stored under the project's ignored Circuit data. The accepted bytes are
copied into the Run folder before worker launch. It records `created_at` and
`expires_at`; protocol v1 uses a fixed 24-hour validity window. Execution does
not consume a plan. It may create several intentional Runs, each with its own
acceptance receipt and start idempotency key. Expiry blocks a new Run but never
changes an existing capsule.

The executable payload contains:

- project instance and root, `SnapshotManifestV1`, sealed snapshot artifact
  hashes, mutation-domain identity, dependency/content pins, and
  `workspace_sha256`
- flow bytes, manifest hash, package catalog hash, and requested axes
- originating public command and result schema for a management facade such as
  `flows.generate`
- goal, accepted input references, and evidence-content policy
- effective preferences and policy with origins and trust levels
- runtime version, digest, authority generation, and protocol ranges
- connector executable/interpreter/script/package closure hash, version,
  capabilities, project-grant digest, and secret-handle IDs
- sealed non-secret environment snapshot commitment and secret-material posture
- known steps, retry bounds, and allowed dynamic decisions
- topology-reducer coverage plus integrity-channel schemas and adapter hashes
- write, network, external-side-effect, isolation, and apply capabilities
- `result_materialization: isolated_patch|base_checkout`; the latter forbids
  every automatic or later Apply capability
- requested and derived effect recovery classes with adapter-proof digests
- every pre-authorized reconciliation probe's key/query schema, immutable
  result/absence schema, network capability, physical-attempt bound, approval
  ID, retry bound, and worst-case token/cost/quota/rate-limit reservation
- requested/effective relay, input/output/total-token, physical-attempt,
  provider-quota, provable-cost, and cumulative active-wall caps with every
  origin/reducer decision and threshold-generated approval; budget grace,
  guardian proof, `BudgetTerminationPermitV1`, and the bounded
  `SettlementPermitV1` needed only after an Apply commit decision
- `expires_at` as an enforceable start boundary
- approvals already granted and approvals still required

Power `auto`, runtime branches, retry choices, and loop outcomes stay marked as
dynamic within explicit bounds. Time and cost fields use `unknown` unless a
versioned estimator has measured evidence for the same class of work. Estimates
do not enter execution identity.

The plan has three identifiers:

- `plan_id` locates it.
- `plan_sha256` protects the canonical executable payload.
- `plan_artifact_sha256` protects the exact canonical complete artifact bytes,
  including display metadata.

Planning commits `PlanReceiptV1` before returning success. It is distinct from
the later Run acceptance receipt and contains no start idempotency key. It binds
the plan ID, both hashes, project instance and snapshot, expiry, runtime
authority generation and digest, config/connector/capability digests, approvals,
and every runtime/content reference retained by the plan. Its lifecycle state
is `preparing|available|closing|abandoned|expired|pruned`; `closing` records
`abandon|expiry|prune` cause and the ticket/acceptance high-water it fenced.

`PlanTxnV1` first syncs a private `preparing` record containing the exact plan
bytes and target identity, installs and directory-syncs the immutable project
artifact, then compare-and-swaps the private receipt to `available`. A crash
finishes those exact bytes or removes the uncommitted artifact and references;
it never authenticates bytes found only in the project. `plan`, `plans show`,
`run --plan`, and plan prune all verify the receipt. A forged project copy or a
plan whose private receipt was lost is inspectable as untrusted evidence but
cannot start; the remedy is to create a new plan.

`PlanAvailabilityTxnV1` gives Run plans a real abandon/expiry boundary. It
takes one user-store transaction phase and CASes `available -> closing` with
cause and the current StartTicket/acceptance generations, and thereby prevents
every new ticket, approval, or start reservation. Ticket issue, approval, and
acceptance include that Plan-availability generation in their own CAS; no new
project lock is introduced. The transaction then recovers each earlier
acceptance reservation to one result: an already-won acceptance keeps its Run
and copied capsule, while every still-pending `issued|authorized` ticket CASes to
`abandoned` or `expired` with its decision invalidated. After rechecking the
same high-waters it commits `expired` for expiry and `abandoned` for abandon or
prune, retaining the closing cause. A start and this fence therefore have one
winner; response loss resumes the same transaction.

`plans abandon <run-plan-id>` uses cause `abandon`. Repeating it returns the
same terminal receipt. Wall-clock expiry uses cause `expiry` before any read or
start may report the plan expired. Explicit prune of an available unexecuted
Run plan first runs the same fence with cause `prune`; it cannot jump around a
pending ticket. If the later filesystem move fails, the Plan remains safely
abandoned and a prune retry continues from that state. Abandon and expiry
retain plan/runtime/content references until prune, and an accepted Run
reference may keep the artifact after availability closes. Apply-plan IDs
dispatch to the separate Apply-plan CAS defined above;
the public command does not blur their internal state machines.

Every acceptance has a caller-known identity before it can mutate. Inspecting a
plan for launch creates private `StartTicketV1` with ticket ID, random
idempotency key, project and plan IDs, both plan hashes, caller UID/SID and
client kind, issued/expiry times, and
`issued|authorized|accepted|declined|abandoned|expired` state. `issued` is
pending; `authorized` has exactly one `StartAuthorizationV1`; the rest are
terminal. It creates no Run. An explicit caller key is stored instead of the
random key. `approve_plan` returns the ticket and key only when approval is
outstanding. A plan remains reusable because each intentional start gets a new
ticket. Protocol v1 tickets and start authorizations expire after 15 minutes;
while the plan remains valid, a no-spend refresh abandons the old ticket and
issues a new one with a new key.

`plans tickets list` exposes unresolved starts without goal text.
`plans tickets abandon` can close only `issued` or `authorized`; it appends a
tombstone and starts nothing. An explicit TTY decline CASes its still-`issued`
ticket to `declined` and creates no approval decision; an already `authorized`
ticket uses abandon or expiry instead. Any ticket read, start, or prune
lazily CASes an overdue pending ticket to `expired`. Start, decline, abandon,
and expiry race through the same versioned CAS, so exactly one wins. An
`accepted` ticket returns its Run and cannot be abandoned or expired.

`StartAuthorizationV1` is a closed union. When the plan has no outstanding
approval IDs, the supervisor may CAS the ticket to `authorized` with
`NoApprovalRequiredReceiptV1`, binding the plan/artifact/policy/capability
digests, an empty approval set, caller, and expiry. It is a proof that no
consequence boundary was crossed, not implied consent. Otherwise the
authenticated client calls `plans.approve` with the ticket, exact artifact hash,
and named approval IDs. The supervisor writes `ApprovalDecisionV1`, bound to
ticket, plan, caller, approvals, and expiry, and then authorizes the ticket.
Hashes alone grant nothing. CLI `--yes` and an equivalent host action are
presentations of this RPC; they do not place raw approval booleans in the start
request. Replaying either authorization path returns the same receipt; changed
policy, approvals, or caller fails without replacing it.

The authorization is single-use for allocating work, not single-response. Once
`runs.start` atomically changes the ticket to `accepted` with a Run ID, replaying
that exact ticket/authorization/key returns the same Run even after expiry. A
different caller, artifact, approval set, or key fails.

Machine, detached, and no-input starts with outstanding approvals must supply
the ticket and idempotency key from the action frame. A consequence-free fresh
start may mint its ticket, commit `NoApprovalRequiredReceiptV1`, show or embed
the complete plan header, and continue without exit 3 or `--yes`. A controlling
human TTY with outstanding approvals may have Circuit mint and persist the
ticket immediately before showing the confirmation prompt. If that client
disappears, a later `run --plan` detects the unresolved ticket and
offers the exact retry/attach command or a clearly separate new ticket; it never
silently starts another Run. A process death leaves the ticket retryable until
expiry; a deliberate “No” terminalizes it immediately.

Two intentional Runs may use the same plan. The same idempotency key with the
same executable and artifact hashes returns the existing Run. The same key with
different artifact bytes fails even when its executable identity is unchanged.
Plan expiry blocks only a new acceptance. A retry that proves an already
committed idempotency receipt still returns that Run after expiry.

The project copy is evidence, not authority. Run acceptance writes a separate
authenticated receipt in the private user store containing project identity,
`plan_sha256`,
`plan_artifact_sha256`, runtime digest and authority generation, config and connector digests, approvals,
capability set, committed `PlanReceiptV1` hash, consumed StartTicket and
`StartAuthorizationV1` hashes, and idempotency key. The private launch capsule and project copy
must reproduce the artifact hash byte-for-byte; the worker also revalidates the
executable hash before its first Trace append. A project cannot approve a
modified plan by recalculating its public hash.

`circuit run --plan <plan-id>` revalidates executable inputs before spend. A
changed flow, policy, connector binary, runtime, source snapshot, or capability
requires a new plan. Display metadata and health-probe timestamps do not.

Detached start exits 0 only after Circuit stores the exact plan capsule and
private receipt, pins the runtime, commits `run.accepted` and `run.queued`, and
syncs the durable queue record. It means accepted for later execution, not that
an execution worker is ready or that the Run will succeed. The response names
the queued or already-running state and exact `watch`, `wait`, and `cancel`
commands.

Plan management is explicit:

```text
circuit plans list [--kind <run|apply|all>] [--expired | --all]
circuit plans show <plan-id>
circuit plans abandon <plan-id>
circuit plans tickets list [--plan <plan-id>]
circuit plans tickets abandon <ticket-id>
circuit plans prune (--plan <plan-id>+ | --expired | --before <rfc3339> | --targets-file <path-or->)
circuit plans prune --batch <prune-batch-plan-id> --confirm <prune-batch-plan-sha256> --yes
```

Expiry does not silently delete bytes or release a runtime reference. Prune uses
`PlanAvailabilityTxnV1` first, then the durable deletion transaction. It
refuses any unresolved StartTicket/acceptance transaction after that fence,
available Apply plan not selected for the same prune, or Run reference, and
releases pins only after commit.
Terminal ticket tombstones retain duplicate-detection facts but no runtime or
content pin. A Run's copied capsule remains with the Run.

## Confirmation

Circuit always shows the plan header. It asks for confirmation when the Run
crosses one of these boundaries:

- first write-capable Run in the project
- external side effects beyond the configured connector call
- a configured budget or capability threshold
- new or changed untrusted project preference or policy
- applying an isolated result into a changed base checkout

Authority always follows plan inspection:

- A fresh `run <flow>` always renders the complete header in human output or
  embeds its typed summary and hashes in the one machine result. If no approval
  ID is outstanding, `NoApprovalRequiredReceiptV1` authorizes the ticket and the
  same invocation may start. It never asks for acknowledgement merely because a
  plan exists.
- A fresh machine-format, detached, or `--no-input` Run stops before acceptance
  only when at least one approval ID is outstanding. It returns `approve_plan`
  with immutable plan ID and both hashes and exits 3. Its typed remedies include
  `plans show <id> --format json` and the exact hash-bound start command with its
  StartTicket and idempotency key.
- For a plan-backed Run, `--yes` is legal only on the confirmed `run --plan` or
  originating `flows generate --plan` leaf with
  `--confirm <plan_artifact_sha256> --yes --start-ticket <id>
  --idempotency-key <key>`, and only when that plan has outstanding approvals.
  A consequence-free plan-backed start supplies the ticket/key without
  `--confirm` or `--yes`. `--yes` on such a plan exits 2 as an unnecessary
  authority request. Explicit approval is invalid on a fresh request because
  the caller could not have named the artifact it approved.
- Missing or stale required approval returns the same action-required shape. No
  init worker, queue record, runtime spend, or effect exists before the matching
  start authorization commits.

`--yes` grants only the approval IDs named by that exact plan. It cannot bypass
policy, grant an undeclared capability, or create persistent trust.

## Durable events and live health

The Trace remains the only durable event authority. `ProgressEventV2` is a
versioned successor in the existing ProgressEvent family. It does not create a
second `--events` vocabulary.

The machine protocol is one strict discriminated union:

```ts
type FrameV2 =
  | EventFrameV2
  | LivenessFrameV2
  | ResultFrameV2
  | ErrorFrameV2
  | ActionRequiredFrameV2;
```

Every frame has `schema_version: 2`, `protocol_version`, and
`kind: event|liveness|result|error|action_required`. Exactly one result, error,
or action-required frame terminates a command stream. Finite JSON emits exactly
that one terminal frame. A caught Unix `SIGHUP`, `SIGINT`, `SIGQUIT`, or
`SIGTERM` uses the typed `CLIENT_INTERRUPTED` ending before exit 129, 130, 131,
or 143. It includes the signal, Run effect
(`continues|foreground_may_interrupt|no_run`), committed Run ID and last cursor
when present, and exact reconnect or recovery remedies.

Signal behavior is command- and ownership-specific:

- `SIGINT` on a controlling human TTY offers graceful cancel, detach, or
  continue only for an attached `run` or `resume`. Detach is an ordinary
  `detached` result and exits 0. A second interrupt while that menu is open ends
  only the viewer. `watch` and `wait` never open this menu: their first SIGINT
  emits `CLIENT_INTERRUPTED`, sends no control request, restores the terminal,
  and exits 130 while the Run continues.
- `SIGHUP` and `SIGTERM` never prompt. `watch`, `wait`, and the viewer side of
  an isolated attached Run detach; the durable worker continues. An in-place
  foreground Invocation has a client-coupled worker, so its controller forwards
  the exact signal to that proved containment and reports
  `foreground_may_interrupt`. A finite command with no accepted Run reports
  `no_run`. If a finite mutation already entered a durable transaction, its
  transaction context and remedy say whether recovery will abort or roll
  forward; the signal exit never promises rollback.
- Once a caught signal chooses an ending, Circuit stops accepting further
  interactive input, masks every further catchable termination signal, restores
  the terminal, and gets at most one second to write one final frame. Masked
  signals remain pending only until the client exits; they neither truncate the
  frame nor change Run state.
- Windows implements the same `SIGINT` behavior and `SIGTERM` behavior only
  where its runtime exposes `SIGTERM`; `SIGHUP` and `SIGQUIT` are Unix-only.

EOF/Ctrl-D is input closure, not approval, decline, or a signal:

| Input context | Required behavior |
| --- | --- |
| Pre-mutation approval or confirmation prompt | Commit no decision and consume no ticket. Leave the action pending, emit the same action-required frame, and exit 3. |
| Required ID/project/target picker whose selection is needed to execute the requested command | Emit `CLIENT_INPUT_CLOSED` with the exact noninteractive argv, restore the terminal, and exit 1 with no mutation. |
| Attached isolated `run`, `resume`, or `watch` viewer | Submit no pending prompt choice, detach the viewer, leave the Run/action unchanged, emit `detached`, and exit 0. |
| Cancel, checkpoint, reconcile, or repair prompt inside a durable viewer | Same detach behavior; EOF never answers, cancels, reconciles, or repairs. |
| `wait` | Stdin closure has no effect because `wait` accepts no interactive choice; continue waiting. |
| In-place foreground | Follow `ForegroundInvocationTxnV1` transport loss: close admission, request bounded stop, emit `FOREGROUND_TRANSPORT_LOST` when output survives, and exit 1. |
| Goal/description/request stdin | EOF ends the payload; an empty required payload is invalid invocation and exits 2. |
| `configure` or another optional settings browser that performs no requested command until an explicit save | Restore the terminal, return `no_change`, and exit 0. |

EOF before versus after prompt render has the same authority result. If typed
input exists but its decision CAS has not committed, EOF discards it. Once a
decision CAS commits, response-loss recovery returns that decision's ordinary
result instead of treating later EOF as a new choice. PTY and closed-pipe
fixtures cover every row in full and line mode.

Raw completion output and the external editor process used by `config edit`
are not framed streams: completion exits on the platform signal, while the
editor owns its own signal behavior and Circuit reports its exit only if the
parent remains alive. Every other caught signal follows the table above.

SIGKILL, process or machine crash, and output-channel failure such as `EPIPE` or
a write that cannot complete inside the one-second deadline are explicit
exceptions because no process can promise a final frame in those cases. A
common `SIGHUP` case is an already-dead terminal pipe; if its
final write gets `EPIPE`, the no-final-frame exception applies while the durable
Run still continues. Reconnection starts from the last frame whose write
completed; a truncated frame is never treated as committed protocol data.

The event envelope is strict and flat so current projectors can migrate one
type at a time. The mapped union below is the complete protocol-2 public event
schema; prose and renderer examples cannot add fields. The current 18 type
strings keep their meaning. V2 replaces absolute artifact paths with hash-bound
evidence references and replaces `relay.started.filesystem_capability` with
requested filesystem access, effective filesystem access, effective network
access, and enforcement mode. Those are negotiated schema changes, not silent
changes to v1.

```ts
type ProgressDisplayV2 = {
  text: BoundedDisplayStringV2<240>;
  importance: 'major' | 'detail';
  tone: 'info' | 'success' | 'warning' | 'error' | 'checkpoint';
};

type ProgressPresentationV2 = {
  block_id: BoundedDisplayStringV2<120>; depth?: IntegerInRange<0, 8>;
} & (
  | { line_mode: 'suppress'; slot_id?: never; status_text?: never }
  | { line_mode: 'append'; slot_id?: never;
      status_text: BoundedDisplayStringV2<180> }
  | { line_mode: 'replace_slot'; slot_id: BoundedDisplayStringV2<120>;
      status_text: BoundedDisplayStringV2<180> }
);

type PublicEvidenceReferenceV2 = {
  artifact_id: ArtifactId; run_relative_path: RunRelativePath;
  media_type: BoundedDisplayStringV2<256>; byte_length: NonNegativeInteger;
  sha256: Sha256;
};

type ProgressTaskV2 = {
  id: BoundedDisplayStringV2<96>; title: BoundedDisplayStringV2<120>;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
};

type ProgressEventPayloadByTypeV2 = {
  'run.started': { run_folder: AbsolutePath };
  'route.selected': { selected_flow: FlowId; routed_by: 'explicit';
    router_reason: BoundedDisplayStringV2<4096>;
    entry_mode?: BoundedDisplayStringV2<128>;
    entry_mode_source?: 'explicit' | 'derived' };
  'step.started': { step_id: StepId; step_title: BoundedDisplayStringV2<240>;
    attempt: PositiveInteger };
  'step.completed': { step_id: StepId; step_title: BoundedDisplayStringV2<240>;
    attempt: PositiveInteger; route_taken: BoundedDisplayStringV2<256> };
  'step.aborted': { step_id: StepId; step_title: BoundedDisplayStringV2<240>;
    attempt: PositiveInteger; reason: BoundedDisplayStringV2<4096> };
  'evidence.collected': { step_id: StepId; report: PublicEvidenceReferenceV2;
    report_schema: BoundedDisplayStringV2<256>;
    warning_count: NonNegativeInteger };
  'evidence.warning': { step_id: StepId; report: PublicEvidenceReferenceV2;
    warning_kind: BoundedDisplayStringV2<128>;
    message: BoundedDisplayStringV2<4096>; path?: RunRelativePath };
  'relay.started': { step_id: StepId;
    step_title: BoundedDisplayStringV2<240>; attempt: PositiveInteger;
    role: RelayRoleV2; connector_name: ConnectorName;
    connector_kind: 'builtin' | 'custom'; effect_id: EffectId;
    requested_filesystem: FilesystemCapabilityV2;
    effective_filesystem: FilesystemCapabilityV2;
    effective_network: NetworkCapabilityV2;
    enforcement_mode: 'sandboxed' | 'trusted_foreground' };
  'relay.completed': { step_id: StepId;
    step_title: BoundedDisplayStringV2<240>; attempt: PositiveInteger;
    effect_id: EffectId; verdict: BoundedDisplayStringV2<512>;
    duration_ms: NonNegativeInteger };
  'fanout.started': { step_id: StepId;
    step_title: BoundedDisplayStringV2<240>; branch_count: PositiveInteger;
    branch_ids: NonEmptyBoundedCollectionV2<BranchId> };
  'fanout.branch_started': { step_id: StepId;
    step_title: BoundedDisplayStringV2<240>; branch_id: BranchId;
    workspace_sha256: Sha256 } & (
      | { branch_kind: 'relay'; child_run_id?: never }
      | { branch_kind: 'sub-run'; child_run_id: RunId }
    );
  'fanout.branch_completed': { step_id: StepId;
    step_title: BoundedDisplayStringV2<240>; branch_id: BranchId;
    child_outcome: RunOutcome; verdict: BoundedDisplayStringV2<512>;
    duration_ms: NonNegativeInteger } & (
      | { branch_kind: 'relay'; child_run_id?: never }
      | { branch_kind: 'sub-run'; child_run_id: RunId }
    );
  'fanout.joined': { step_id: StepId;
    step_title: BoundedDisplayStringV2<240>;
    aggregate: PublicEvidenceReferenceV2;
    branches_completed: NonNegativeInteger; branches_failed: NonNegativeInteger;
  } & (
    | { policy: 'pick-winner'; selected_branch_id: BranchId }
    | { policy: 'disjoint-merge' | 'aggregate-only' |
        'aggregate-survivors'; selected_branch_id?: never }
  );
  'checkpoint.waiting': { checkpoint_id: CheckpointId; step_id: StepId;
    request: PublicEvidenceReferenceV2;
    allowed_choices: NonEmptyBoundedCollectionV2<CheckpointChoiceId> };
  'task_list.updated': {
    tasks: NonEmptyBoundedCollectionV2<ProgressTaskV2> };
  'user_input.requested': { checkpoint_id: CheckpointId; step_id: StepId;
    question_artifact: PublicEvidenceReferenceV2; action_id: ActionId;
    answer_argv: BoundedArgvV2 };
  'run.completed': { outcome: Exclude<RunOutcome, 'aborted' | 'canceled'>;
    result: PublicEvidenceReferenceV2 };
  'run.aborted': { outcome: 'aborted'; result: PublicEvidenceReferenceV2;
    reason?: BoundedDisplayStringV2<4096> };
  'run.accepted': { plan_id: PlanId; plan_sha256: Sha256;
    plan_artifact_sha256: Sha256;
    start_authorization: 'no_approval_required' | 'approval_decision';
    result_materialization: 'isolated_patch' | 'base_checkout' };
  'run.queued': { queue_generation: NonNegativeInteger; accepted_at: Rfc3339 };
  'invocation.started': { invocation_id: InvocationId;
    fencing_epoch: PositiveInteger;
    cause: 'initial' | 'checkpoint_answer' | 'interrupted_reentry' |
      'reconcile_continue' | 'launch_retry' | 'linked_apply' };
  'checkpoint.pending': { checkpoint_id: CheckpointId; step_id: StepId;
    drain_deadline: Rfc3339; open_effect_count: NonNegativeInteger };
  'run.cancel_requested': { control_request_id: ControlRequestId;
    reason: 'operator' | 'budget' | 'uninstall';
    effect_high_water: NonNegativeInteger };
  'run.interrupted': { invocation_id: InvocationId;
    reason: BoundedDisplayStringV2<512>; safe_reentry_available: boolean };
  'run.reconciliation_required': { resolution_version: NonNegativeInteger;
    effect_ids: NonEmptyBoundedCollectionV2<EffectId> };
  'apply.started': { source_run_id: RunId; apply_plan_id: ApplyPlanId;
    source_result_sha256: Sha256; accepted_base_sha256: Sha256 };
  'apply.completed': { source_run_id: RunId; apply_plan_id: ApplyPlanId;
    apply_outcome: 'complete' | 'conflict' | 'failed' | 'canceled' |
      'operator_settled'; result: PublicEvidenceReferenceV2 };
  'run.canceled': { reason: 'operator' | 'budget' | 'uninstall';
    result: PublicEvidenceReferenceV2 };
};

type ProgressEventTypeV2 = keyof ProgressEventPayloadByTypeV2;
type EventFrameBaseV2 = {
  schema_version: 2; protocol_version: 'circuit/2'; kind: 'event';
  root_run_id: RunId; run_id: RunId; parent_run_id?: RunId;
  invocation_id?: InvocationId; flow_id: FlowId; recorded_at: Rfc3339;
  run_sequence: PositiveInteger; tree_sequence: PositiveInteger;
  projection_ordinal: NonNegativeInteger; event_id: Sha256;
  cursor: ProgressCursorV2; label: BoundedDisplayStringV2<240>;
  display: ProgressDisplayV2; presentation?: ProgressPresentationV2;
};
type EventFrameV2 = {
  [T in ProgressEventTypeV2]: EventFrameBaseV2 & { type: T } &
    ProgressEventPayloadByTypeV2[T]
}[ProgressEventTypeV2];
```

Runtime validators are strict for the envelope and every mapped member. They
reject unknown types, unknown or irrelevant fields, missing fields, invalid
conditional branches, `branch_count !== branch_ids.total_count`, and any string,
array, argv, evidence-reference, or encoded-frame bound violation. The encoder
recomputes event ID and cursor from the canonical payload and exact sequence/
ordinal, and the decoder rejects a mismatched ID, root, sequence relationship,
or cursor. Protocol 2
ships one positive golden fixture plus missing-field, extra-field, wrong-branch,
and oversize negative fixtures for every type before any host can negotiate it.
Collection-bearing event fixtures also include more than 200 branch IDs, tasks,
checkpoint choices, and effect IDs; each must externalize through its committed
overflow receipt and reconstruct the exact canonical collection.

Every public projection field is present in its Trace entry or in an immutable,
hash-bound artifact owned by the Run. Private receipts, queue records, leases,
and locators validate cross-store transactions but are never replay inputs.
Deleting private state from a copy of a terminal Run must not change one byte of
its projected feed.

| Type | Durable source |
| --- | --- |
| `run.accepted` | `run.accepted`, which embeds every public field and the validating private-receipt hash |
| `run.queued` | `run.queued`, which embeds every public field and the validating private queue-commit hash |
| `invocation.started` | fenced `invocation.started` |
| `checkpoint.pending` | checkpoint drain started; not answerable yet |
| `run.cancel_requested` | ordered cancellation acknowledgement |
| `run.interrupted` | exact worker exit before safe close |
| `run.reconciliation_required` | one or more unknown effects |
| `apply.started` / `apply.completed` | linked Apply Run milestones |
| `run.canceled` | settled canceled terminal entry |

Existing `checkpoint.waiting`, `user_input.requested`, `run.completed`, and
`run.aborted` remain the answerable and terminal milestones. Internal lease,
permit, transaction, and `run.terminalizing` entries are projected into these
public facts or omitted; raw Trace entries do not become an accidental API.

The retained event types have an explicit v2 source:

| Existing type | V2 durable source |
| --- | --- |
| `run.started` | First committed `run.running` only |
| `route.selected` | Accepted route decision |
| `step.started` | Step-entered Trace entry |
| `step.completed` | Step-completed Trace entry |
| `step.aborted` | Step-aborted Trace entry |
| `evidence.collected` | Committed evidence reference |
| `evidence.warning` | Committed evidence warning |
| `relay.started` | Admitted relay effect intent |
| `relay.completed` | Settled relay effect receipt |
| `fanout.started` | Fanout-opened entry |
| `fanout.branch_started` | Write-ahead child/branch start |
| `fanout.branch_completed` | Settled child/branch result |
| `fanout.joined` | Committed workspace join result |
| `checkpoint.waiting` | `checkpoint.waiting` boundary |
| `task_list.updated` | Committed task-list projection source |
| `user_input.requested` | Answerable checkpoint plus question artifact |
| `run.completed` | Non-aborted, non-canceled terminal entry |
| `run.aborted` | Aborted terminal entry |

Later Invocations emit `invocation.started`, never another `run.started`.

New lifecycle Runs use Trace schema version 2. Each root and child Trace entry
carries its own contiguous `sequence` plus a `tree_sequence` allocated by the
root worker's single append coordinator. The latter is monotonic across the
whole root execution tree. The worker serializes parent and child appends; after
a crash, the next Invocation scans the write-ahead registered tree and resumes
after the largest committed sequence. Terminal, interrupted, damaged, and
frozen Trace v1 files remain immutable. A supported legacy continuation may
append v1 entries only while its whole project remains Run-store generation 1,
through the compatibility wrapper described below.

Durable feed frames carry:

- protocol version
- root Run, owning Run, parent Run, and Invocation IDs
- event ID
- cursor `pe2:<root-run-id>:<tree-sequence>:<projection-ordinal>`
- semantic event payload

The separate terminal union frame reports the command result, error, or action;
it is not assigned a durable event cursor.

One Trace entry may produce several public events. Event ID is the SHA-256 of
the feed protocol, root Run ID, owning Run ID, tree sequence, projection
ordinal, and canonical payload hash. Delivery is at least once; clients
deduplicate by event ID.

Every live feed uses `DurableTailSessionV1` rather than trusting an in-memory
subscription:

```text
access pin acquired
-> opening receipt, origin permit, and client acknowledgement
-> durable high-water captured
-> replayed through that high-water
-> wakeup subscription registered
-> durable high-water rechecked
-> tailing
-> terminal prepared
-> terminal acknowledged or transport-loss delivery grace
```

`watch --after <cursor>` and `wait --after <cursor>` start that session after
the supplied cursor. Root watch/wait includes child events in `tree_sequence`
order. Every public cursor
remains a root-tree cursor; child-only watch is a filter over the same root feed
and accepts the same `--after` value. A child frame may include its local
`run_sequence` for diagnostics, but that value is never a reconnect cursor. The
projector must rebuild the same bytes from Trace and immutable, hash-bound
dependencies.

Subscription notifications are wakeups only. While tailing, the server rescans
the durable high-water after every notification, worker/lease change, terminal
mirror change, and at least once per second. It therefore cannot miss an event
committed between replay and subscription, or an event whose notification was
lost. The stream operation, not one socket, owns an `AccessPinV1` until its
terminal-frame acknowledgement or deadline-proved expiry commits, including
reconnect grace after proved connection death. Pin release requires terminal-frame acknowledgement or a
deadline-proved expiry; preparing or writing a terminal frame is not enough.
Per-connection buffers are capped at 256 frames and 2 MiB. A slow or
unprovable consumer is disconnected with its last successfully written cursor;
the server never queues an unbounded feed.

Before the first frame, the supervisor privately commits authenticated
`StreamOperationReceiptV1`: operation/source-command IDs, caller UID/SID and
client kind, exact project/Run/plan/transaction target, output presentation,
stable operation generation, monotonic connection generation, last
acknowledged cursor or the origin sentinel, access-pin ID, reconnect deadline,
and `opening|active|reconnect_grace|terminal_prepared|
terminal_delivery_grace|terminal_acknowledged|expired` state.
`terminal_prepared` retains the canonical terminal-frame bytes or immutable
content reference, frame ID/hash, source references, access pin, and delivery
deadline. It issues
`StreamResumeTokenV1` bound to the operation and current connection generations,
caller, permitted cursor range, and expiry. Entering reconnect grace does not
silently invalidate the last acknowledged token. A successful reattach consumes
that connection generation, increments it, and returns a fresh token/permit;
old tokens and permits cannot act on the new connection. The opaque token never grants start, approval,
mutation, or a different command. Reattach requires ordinary same-user RPC
authentication plus the token; a raw operation ID returns `DECISION_STALE`.

Opening is idempotent and safe before the first event. The caller generates the
operation ID. One opening RPC acquires the pin, commits `opening`, and atomically
returns the resume token plus an origin-bound `ReconnectExpiryPermitV1`. No feed
or terminal frame may be emitted until the client acknowledges that permit and
the receipt CASes to `active`. If the opening reply is lost, retrying the same
caller/operation/target returns the same opening identity; changed inputs fail.
If no authenticated opening reply ever arrives, the frontend may end only its
local attempt with fixed `STREAM_TRANSPORT_LOST(phase: opening)` and a read-only
status remedy. It cannot claim a cursor, Run outcome, or private cleanup.

Frame acknowledgement is explicit. After the client acknowledges its last
complete cursor, the supervisor commits that cursor and returns authenticated
`ReconnectExpiryPermitV1`. The permit binds operation and connection IDs,
operation and connection generations, last acknowledged cursor or origin,
absolute reconnect deadline,
caller, and the exact bounded client-local `STREAM_TRANSPORT_LOST` frame. That
frame has a deterministic terminal-frame ID. For a Run-bound operation it
contains required fresh `watch` and `wait --after <cursor>` remedies; before Run
acceptance it contains a required read-only plan/ticket-status remedy instead.
The client never advances its reconnect cursor
until it receives this permit, so a crash may duplicate an event but cannot
skip one. Token refresh is read-only and legal only while the same operation
generation is active.

Every outcome-bearing stream has a caller-known `stream_operation_id`; its
terminal frame has deterministic `terminal_frame_id = sha256(protocol,
source_command, operation_id, canonical_terminal_payload)`. Isolated attached
`run`, `resume`, `wait`, confirmed Apply, reconciliation probe, or Apply-drift
settlement, `flows generate`, and `watch` all reconnect
automatically for ten seconds after endpoint or transport failure. They resolve
the current authenticated endpoint, back off to at most one second, and reopen
the same operation after the last successfully written durable cursor. Event
delivery remains at least once and deduplicates by event ID; terminal delivery
deduplicates by terminal-frame ID. A terminal Trace entry committed before
transport loss is replayed into the same terminal frame, not a second outcome.

Terminal delivery is acknowledged separately from event cursors. Before the
first terminal-frame byte, the supervisor commits `terminal_prepared` with the
exact immutable terminal payload and keeps the access pin. A successful write
does not release it. The client acknowledges the terminal-frame ID; only the
matching operation/connection generation may CAS to `terminal_acknowledged`
and release the pin. Transport loss before that CAS enters
`terminal_delivery_grace`; authenticated reattach returns the same terminal
bytes and frame ID. Deadline-proved expiry is the only other pin-release path.
Prune treats `opening`, `terminal_prepared`, and `terminal_delivery_grace` as
active access exactly like ordinary reconnect grace.

If grace expires while the supervisor is unreachable, the local frontend emits
the exact error frame from its latest permit and exits 1. It does not claim that
private cleanup committed. A replacement supervisor later CASes that exact
operation/connection generation to `expired` and releases its access pin only when the
deadline passed and no newer authenticated reattach won. If the supervisor
never returns, the pin leaks safely and prune remains blocked. An old client
permit may end that client even when another client already reattached; it has
no authority over the newer receipt generation.

Before grace expiry, fixed `--reattach` argv resumes an active,
reconnect-grace, or terminal-delivery operation and the same outcome stream; it
never allocates a Run or repeats Apply or Flow-generation
acceptance. After expiry there is no advertised reattach. The immutable error
for a Run-bound operation already carries fresh `watch` and `wait --after`
commands that create a new read-only operation from the acknowledged cursor; a
pre-acceptance error carries only its read-only plan/ticket-status command.
In-place foreground streams
never create a `StreamOperationReceiptV1` and never auto-reattach; their
client-coupled ownership and immediate transport-loss behavior are defined
below. Thus reconnect applies to every isolated outcome stream, not to the
foreground escape hatch.

`watch --filter <text>` is a renderer-only option for `--format human` on a
controlling TTY, including screen-reader line mode. Plain, JSON, NDJSON, and a
human pipe reject it before feed attachment. Matching is a literal,
locale-independent case-folded substring over event type, Flow/step IDs, and
scrubbed display text. It never changes the durable subscription, replay
high-water, or result cursor, and it never hides an action-required, terminal,
corruption, or transport-loss ending. In full or compact TUI, clearing restores
cached rows without changing or re-emitting the feed. In append-only line mode,
a filter applies only to future ordinary milestones and prints its activation
position plus suppressed-count summaries; clearing affects only future display
and never reprints hidden rows. `FilterActivationPositionV2` is exactly
`{ kind: 'origin' } | { kind: 'cursor'; cursor: ProgressCursorV2 }`. Before the
first public event, the renderer prints `circuit watch <canonical-run-ref>
--project-root <canonical-project-root>` for explicit historical replay. After
an event, it prints the same fully qualified target plus `--after
<activation-cursor>`. `canonical-run-ref` is the storage-v2 Run ID or the
qualified `legacy:<record-id>` required by `RunRefV2`; the argv never relies on
an ambiguous display ID or ambient cwd. It never invents a public origin cursor.
Every printed argv is parser-tested and must reproduce the suppressed interval. Protocol 2
has no filtered machine feed.

Cursor validation is fixed:

| Cursor case | Result |
| --- | --- |
| Absent | Replay from root origin, then tail live |
| Valid emitted event for this root | Replay strictly after it |
| Malformed | Exit 2, `CURSOR_INVALID` |
| Different root | Exit 1, `CURSOR_RUN_MISMATCH` |
| Future sequence or projection ordinal | Exit 1, `CURSOR_AHEAD` |
| Unsupported protocol | Stable protocol-too-old or protocol-too-new error |
| Trace gap or corruption | Stop at the last proved boundary; never skip |
| Pruned root | Exit 1, `RUN_PRUNED`, with tombstone high-water metadata |

No failure silently restarts replay from origin.
Malformed or oversized cursor metadata never echoes the supplied token. It
reports only byte length, SHA-256, and an optional sanitized preview capped at
256 bytes; oversized input omits the preview.

After `run.terminalizing`, closure is two-phase. The worker first builds and
syncs temporary result/error and report artifacts, computes their hashes and
canonical final payload, then appends and syncs `run.closing` with source and
target paths, hashes, the terminal target, and the terminalization sequence. It
atomically installs the artifacts and finally appends `run.terminal`. Recovery
after `run.closing` validates or reinstalls the exact bytes and completes the
terminal append; it never recomputes timestamps or outcome. An artifact without
`run.closing` is an orphan, and `run.closing` without `run.terminalizing` is
corruption. A committed terminal entry is sufficient for byte-identical final
replay.

`TerminalMirrorV1` closes the project/private boundary without confusing a
terminal result with process cleanup. Its append-only phases are:

| Phase | Proof and allowed change |
| --- | --- |
| `terminal_trace_mirrored` | `run.terminal` is authoritative; mirror its hash and terminal state and update the locator, but retain the lease and every worker/runtime pin |
| `invocation_exit_proved` | `InvocationExitTxnV1` observes the exact worker exit and proves the Invocation plus every effect containment empty; sync the closed containment record |
| `terminal_cleanup_complete` | Close, but do not erase, the lease tombstone and release only worker/runtime/content references not needed by another plan, Run, replay artifact, or operator pin |

Startup may complete the first phase from terminal Trace alone. It may not
complete the second or third from a timeout, missing socket, or terminal event.
A worker may hang after committing terminal Trace; the Run is terminal and
replayable, while status reports `cleanup_pending`, locks and pins remain live,
and prune stays blocked. Because terminalization already proved every effect
containment empty and closed admission, the supervisor requests worker exit and,
after a fixed five-second cleanup grace, may terminate only the exact
authenticated Invocation containment. It still must observe exit before closing
the lease. Unknown containment is never signaled and leaves `cleanup_pending`
with `repair inspect` remedies. Startup retries this cleanup before scheduling
the next project Run. Private terminal state without the matching Trace hash is
corruption. Before prune, every terminal cleanup must be complete, exact
containment must be empty, and the Run append lock must be acquired and
revalidated.

Lease health uses a separate transient frame in the same transport:

```text
schema_version: 2
protocol_version: circuit/2
kind: liveness
root_run_id: ...
run_id: ...
invocation_id: ...
state: healthy | quiet | unresponsive | stopping
reachability: authenticated | unknown
observed_at: ...
last_activity_at: ...
```

Liveness frames have no durable cursor. Replay omits them. The viewer derives
the quiet meter from these frames. Relay quiet time remains a per-step policy,
not proof that a process died.

`--progress jsonl` selects the native v1 contract, not a lossy v2 projection:

| Storage and client | Mutation | Feed |
| --- | --- | --- |
| V1 through the release-N wrapper | Attached legacy start in N, or a proven continuation while the project remains generation 1 | Current ProgressEvent v1 stderr plus final JSON stdout |
| V2 with v2 client | Full durable lifecycle | ProgressEventV2 NDJSON or finite v2 envelope |
| V2 with v1 client | Metadata inspection only | No live stream; attach/mutation fails `PROTOCOL_TOO_OLD` |
| V1 with v2 client | Historical read; wrapper-observed live status while supported | Read-only adapter emits only facts present in v1 and marks unavailable lifecycle fields unknown |

Native v1 has no detach, reconnect, automatic crash re-entry, v2 cancellation
guarantee, v2 tree-sequence cursor, or linked Apply Run. Its wrapper adds
containment and the project lock but invents no Trace facts. A historical v1
feed uses stable per-file sequence ordering and makes no root-tree live-tail
claim. Official hosts use this profile only until they negotiate v2. Host
migration precedes production durable-v2; the legacy writer is temporary while
the historical reader remains.

Circuit does not stream raw relay output by default. V2 events use relative
evidence references when possible and keep sensitive absolute paths in debug
views.

## Output and errors

Output format applies by command class:

| Command class | Allowed formats |
| --- | --- |
| Outcome-bearing streams: `run`, `resume`, `wait`, confirmed `apply --plan`, `reconcile probe apply`, `applies repair apply`, `flows generate` | `human`, `plain`, `json`, `ndjson` |
| Viewer `watch` | `human`, `plain`, `ndjson`; use `runs show --format json` for one snapshot |
| Finite reads and mutations | `human`, `plain`, `json` |
| Bounded `plans artifact read` and `artifacts read` | `json` only |
| `completion <shell>` | Raw shell script only |
| `config edit` | No format; opens an editor |

The contracts are:

| Format | Contract |
| --- | --- |
| `human` | User-facing rendering. A TTY may use a TUI; a pipe receives append-only text. |
| `plain` | Append-only text with no ANSI, cursor movement, animation, paging, or prompt. |
| `json` | Exactly one versioned final result, error, or action-required object. Milestones are suppressed. |
| `ndjson` | Versioned feed frames followed by exactly one final result, error, or action-required frame. |

Three internal dated presentations preserve current behavior while native v2
lands. They are not accepted values of `--format`:

| Internal presentation | Meaning |
| --- | --- |
| `legacy_v1_final` | The characterized command's current final stdout/stderr bytes and exit behavior |
| `legacy_v1_dual` | The characterized ProgressEvent-v1 stderr stream plus its current final stdout envelope |
| `legacy_v1_action_bridge` | A bounded per-leaf v1 final error envelope with stable `ACTION_REQUIRED`, action/plan ID, artifact hash, and exact next argv; exit 3 |

`CommandSpecV2` records, per leaf and release, its default presentation and
whether current `--json` selects a v1 adapter. In N and N+1, omitting format on
a characterized current leaf selects its recorded legacy presentation;
`--progress jsonl` selects `legacy_v1_dual`. Existing `--json` on those leaves
keeps its characterized v1 JSON until that leaf's dated adapter removal.
`--format json` always selects native protocol-2 JSON, so it is the explicit
migration path. New commands use the four native formats immediately.

An action introduced where current behavior had no possible action cannot be
byte-identical. On a characterized no-flag or legacy-`--json` leaf, N+1 selects
`legacy_v1_action_bridge` for that outcome only. Each leaf maps it into the
already characterized top-level error envelope and stdout/stderr routing; it
never emits an unrecognized native-v2 frame into a v1 stream. With `--progress
jsonl`, already-emitted ProgressEvent-v1 lines remain on stderr and the bridge
is the one final stdout envelope. Golden fixtures fix the exact bytes for
fresh `run`, `resume`, and model-backed `generate` before N ships its warning.
Native `--format json|ndjson` receives the full typed action instead.

The byte-golden promise is deliberately narrow: it covers characterized
commands and outcomes whose semantics are unchanged by the new pre-spend action
boundary. Fresh non-TTY `run` and `generate` approval is an intentional N+1
behavior break. N warns and prints the exact inspect-and-confirm command; N+1
returns the typed action before spend. Release N+2 may change remaining current
no-flag leaves to `human` only after every supported host pins a presentation
and the leaf has warned for a full release. TTY detection never selects a
semantic presentation. Scripts must pin one.

Human and plain output may summarize machine fields, but cannot hide final
state, required action, authority boundary, enforced limit, or remedy. JSON and
NDJSON are the parsing contracts. TTY detection may change layout only in
`human`; it never changes the selected format. `NO_COLOR` and `--no-color`
remove color only and keep the selected human layout. `TERM=dumb`,
`--screen-reader`, or a controlling terminal below 80 columns or 24 rows uses
human line mode. A non-TTY/CI human pipe or explicit plain format uses plain
mode. These thresholds never change the semantic format.

Stream ownership is fixed:

| Situation | stdout | stderr |
| --- | --- | --- |
| Successful `human` or `plain` | Selected presentation | Warnings and diagnostics |
| Failed finite `human` or `plain` | Empty | Error and remedies |
| Failed streaming `human` or `plain` | Milestones already emitted, if any | Final error and remedies |
| Finite action-required `human` or `plain` | Complete plan/action header, choices, and fixed-argv remedies | Warnings and diagnostics only |
| Streaming action-required `human` or `plain` | Milestones already emitted, then the complete action/choices/remedies | Warnings and diagnostics only |
| Declined human prompt | Plan/action already shown, then a `declined; no changes made` result | Warnings and diagnostics only |
| `json` success or failure | Exactly one structured object | Warnings and scrubbed debug diagnostics only |
| `ndjson` success or failure | Feed plus exactly one final frame | Warnings and scrubbed debug diagnostics only |
| Prompt | Controlling terminal | Never mixed into machine stdout |
| `completion` | Shell script | Diagnostics |
| Legacy `--progress jsonl` | Existing final v1 JSON | Existing ProgressEvent v1 stream |

Action-required is expected control flow, not a stderr-only failure. Plain mode
never prompts but prints the same semantic header and remedies to stdout before
exit 3. A pipe therefore receives a complete stable text action. Already-
emitted streaming milestones remain on stdout; nothing is retracted or repeated.

A normal NDJSON watch ends with a command-level result frame. `detached` means
the viewer left while the Run continued; `observed_terminal` means it saw the
terminal event. The frame carries Run ID, operation ID, terminal-frame ID, last
cursor, and last state. Exhausted reconnect ends with
`STREAM_TRANSPORT_LOST`. It exits for the viewer operation, never the Run
outcome. Human and plain render the same ending. The same error on `run`,
`resume`, `wait`, Apply, or Flow generation describes that client stream; it
does not silently convert a durable Run outcome.

On native-v2 leaves, `--json` aliases `--format json`. On characterized legacy
leaves, current `--json` keeps the dated v1 projection while `--format json`
selects native v2; supplying both is therefore invalid until the v1 adapter is
removed. `--progress jsonl` is a complete standalone selector on every current
Run/resume leaf that accepts it; no `--json` companion is required. It may also
pair with legacy `--json` only on a leaf whose characterized grammar already
accepted that flag, without changing either stream, and conflicts with every
native `--format`. `history query --format memory-input` keeps its old projection
meaning through an adapter; the new spelling is
`--projection memory-input --format json`. Unknown or conflicting formats exit
2.

Finite collection reads are bounded and use keyset pagination. The shared
selection and result types are:

```ts
type PageSelectionV2 = {
  limit: IntegerInRange<1, 200>; // default 50
  after?: ListCursorV2;         // opaque UTF-8 token, at most 2,048 bytes
};

type ListPageV2<T> =
  | { items: BoundedArrayV2<T, 200>; has_more: true;
      next_cursor: ListCursorV2 }
  | { items: BoundedArrayV2<T, 200>; has_more: false;
      next_cursor?: never };
```

The opaque base64url cursor is authenticated by the private controller and
binds protocol and command IDs, project or global
scope identity, filter digest, the initial high-water mark, and the last stable
ordering tuple. It never contains an ambient path or authority token. Pages
stay on that frozen high-water, so concurrent additions appear only in a new
listing; concurrent deletion may shorten a page but never duplicates or skips
an item that still exists. Numeric offsets are forbidden. `--after` from a
different command, project, target, or filter exits 1 as
`LIST_CURSOR_QUERY_MISMATCH`; malformed, oversized, or unauthenticated input
exits 2 as `LIST_CURSOR_INVALID`.
`ListCursorKeyV1` lives in private state, survives supervisor restart and root
relocation, participates in authenticated backup, and is retained for the
protocol-2 support floor; routine update cannot invalidate an issued cursor.

Every native-v2 result in the `List` schema family returns `ListPageV2`.
`runs list`, `plans list`, `plans tickets list`, `flows list`, `flows drafts
list`, all-Flow `flows validate`, `checkpoints list`, `reconcile list`, `repair
backup list`, `runtimes pins list`, native-v2 `history query`/`history pull`,
and native-v2 `memory list` accept `--limit <1..200> --after <cursor>`. Existing
v1 adapters retain their characterized legacy limit/output behavior, but a v2
host never receives an unbounded adapter payload. Each `CommandSpecV2` entry
declares one stable ordering tuple and the same order in human/plain output.
There is no command-specific hidden pagination convention.

| List leaf | Stable keyset order |
| --- | --- |
| `runs list` | `created_at DESC, run_id DESC` |
| `plans list` | `created_at DESC, plan_id DESC` |
| `plans tickets list` | `issued_at DESC, ticket_id DESC` |
| `flows list` / all-Flow `flows validate` | `flow_id ASC, scope ASC, entry_sha256 ASC` |
| `flows drafts list` | `created_at DESC, draft_id DESC` |
| `checkpoints list` | `requested_at ASC, run_id ASC, checkpoint_id ASC` |
| `reconcile list` | `updated_at DESC, run_id DESC, effect_id ASC` |
| `repair backup list` | `created_at DESC, backup_id DESC` |
| `runtimes pins list` | `created_at DESC, pin_id DESC` |
| native-v2 `history query` / `history pull` | `score DESC, recorded_at DESC, result_id DESC` |
| native-v2 `memory list` | `recorded_at DESC, memory_id DESC` |

Large plan artifacts do not travel through the 4 MiB control frame. `plans
show` returns either an inline canonical artifact when it is at most 1 MiB, or
this typed reference:

```ts
type ManagedPlanIdV2 = PlanId | ApplyPlanId;

type PlanArtifactReferenceV2 = {
  plan_kind: 'run' | 'apply';
  plan_id: ManagedPlanIdV2;
  plan_artifact_sha256: Sha256;
  total_bytes: PositiveInteger;
  read_argv: [
    'circuit', 'plans', 'artifact', 'read', ManagedPlanIdV2,
    '--offset', '0', '--format', 'json'
  ];
};

type PlanArtifactChunkBaseV2 = {
  plan_kind: 'run' | 'apply';
  plan_id: ManagedPlanIdV2;
  plan_artifact_sha256: Sha256;
  total_bytes: PositiveInteger;
  offset: NonNegativeInteger;
  chunk_bytes: PositiveInteger;
  chunk_sha256: Sha256;
  content_base64: NonEmptyString;
};

type PlanArtifactChunkV2 = PlanArtifactChunkBaseV2 & (
  | { eof: true; next_offset?: never }
  | { eof: false; next_offset: PositiveInteger }
);
```

`plans artifact read <plan-id> [--offset <n>] [--max-bytes <1..786432>]` is a
finite JSON-only read. `--max-bytes` defaults to 262,144. The immutable plan ID
selects the artifact; each chunk is bounded, hash-checked, and range-checked,
and concatenated decoded chunks must hash to `plan_artifact_sha256`. Reads pin
the plan through `ReferenceAcquireTxnV1`, so prune either wins before the read
or waits for its access pin. Invalid ranges exit 2; a pruned or missing plan
exits 1 without substituting another artifact. Plan artifacts are nonempty;
`offset` must be less than `total_bytes`, and the last nonempty chunk sets
`eof: true` with no `next_offset`.

Every other variable collection uses the same bounded-reference rule:

```ts
type CollectionReferenceV2 = {
  artifact_id: ArtifactId;
  overflow_receipt_id: OverflowArtifactReceiptId;
  item_kind: NonEmptyString;
  total_count: NonNegativeInteger;
  content_sha256: Sha256;
  byte_length: PositiveInteger;
  retention_class: 'run_until_prune' | 'action_plus_30d' |
    'command_error_30d' | 'legacy_reconstruction';
  read_argv: ['circuit', 'artifacts', 'read', ArtifactId,
    '--offset', '0', '--format', 'json'];
};

type BoundedCollectionV2<T> =
  | { items: BoundedArrayV2<T, 200>; total_count: NonNegativeInteger;
      complete: true; overflow?: never }
  | { items: BoundedArrayV2<T, 200>; total_count: PositiveInteger;
      complete: false; overflow: CollectionReferenceV2 };

type BoundedActionCollectionV2<T> =
  | { items: BoundedArrayV2<T, 32>; total_count: NonNegativeInteger;
      complete: true; overflow?: never }
  | { items: BoundedArrayV2<T, 32>; total_count: PositiveInteger;
      complete: false; overflow: CollectionReferenceV2 };

type NonEmptyActionCollectionV2<T> =
  BoundedActionCollectionV2<T> & {
    items: NonEmptyBoundedArrayV2<T, 32>;
  };

type NonEmptyBoundedCollectionV2<T> =
  BoundedCollectionV2<T> & {
    items: NonEmptyBoundedArrayV2<T, 200>;
  };

type AtLeastTwoBoundedCollectionV2<T> =
  BoundedCollectionV2<T> & {
    items: AtLeastTwoBoundedArrayV2<T, 200>;
  };

type NonEmptyCommandRemedyCollectionV2 =
  BoundedActionCollectionV2<CommandRemedyV1> & {
    items: NonEmptyBoundedArrayV2<CommandRemedyV1, 32>;
  };

type ActionabilityV2 =
  | { choices: NonEmptyActionCollectionV2<ActionChoiceV2>;
      remedies: BoundedActionCollectionV2<RemedyV1> }
  | { choices: BoundedActionCollectionV2<ActionChoiceV2>;
      remedies: NonEmptyCommandRemedyCollectionV2 };
```

Runtime schemas enforce that complete counts equal `items.length`, overflow
counts are larger, inline items never exceed 200, and the reference hashes the
full canonical collection. `circuit artifacts read <artifact-id> [--offset
<n>] [--max-bytes <1..786432>] --format json` uses the same strict eof/non-eof
chunk union as plan reads, acquires an access pin, and enforces the artifact's
project/Run/action scope. It never accepts a mutable path.

Before a frame may name a collection reference, private
`OverflowArtifactReceiptV1` and its content reference must commit. The receipt
binds artifact/hash/size/count, source command and operation, owning Run/action/
error identity, access scope, retention class, and GC generation. Run terminal
overflow lives until Run prune; action overflow lives through action
terminalization or expiry plus 30 days; command-error overflow lives 30 days;
legacy reconstruction lives until the local frontend acknowledges the final
byte-golden envelope or its exact process death is proved, with a 24-hour crash
recovery floor. Reads and GC race through `ReferenceAcquireTxnV1` and
`ContentGcTxnV1`. A frame whose overflow receipt or bytes did not commit is
never emitted, and routine cleanup cannot make a still-supported frame
unreadable.

Protocol 2 also has byte bounds, not only item-count bounds:

| Encoded object | Canonical UTF-8 limit |
| --- | --- |
| Control RPC request or response | 4 MiB transport maximum |
| Result, error, or action-required frame | 1 MiB |
| Event or liveness frame | 256 KiB |
| One display string | 64 KiB; labels 1 KiB; action prompts 16 KiB |
| One argv | 256 entries, 64 KiB total, 16 KiB per entry |
| Inline ordinary collection | 200 items, reduced further when needed to fit the frame |
| Inline remedies or choices | 32 items, reduced further when needed to fit the frame |

The encoder externalizes a complete canonical collection before it would cross
either its item or byte bound. It then emits `CollectionReferenceV2`; it never
silently truncates. A terminal frame always retains command, outcome/state,
total counts, content hashes, and at least one bounded read or recovery remedy.
If externalization itself fails, Circuit emits a fixed-shape, sub-16-KiB
`INTERNAL_ERROR` containing only incident ID, committed Run/operation identity,
and `repair inspect` argv. It does not attempt to serialize the oversized body
again.

All protocol strings, argv, arrays, and JSON values use branded bounded schema
types at runtime. `BoundedArgvV2` enforces the argv row above. The transport
rejects an oversized inbound frame before dispatch, and the server validates
the encoded size of every outbound frame before the first byte is written. A
legacy-v1 adapter reconstructs a byte-golden legacy envelope in the local
frontend from hash-checked bounded chunks; the supervisor RPC and host bridge
never carry that unbounded envelope.

Machine remedies and choices are strict data, not prose that a client guesses
how to execute:

```ts
type RemedyBaseV1 = { id: NonEmptyString; label: DisplayLabelV2 };
type ManualCommandRemedyV1 = RemedyBaseV1 & {
  kind: 'command'; execution: 'manual';
  argv: BoundedArgvV2; cwd?: AbsolutePath; docs_url?: never;
};
type RetrySafeCommandRemedyV1 = RemedyBaseV1 & {
  kind: 'command'; execution: 'retry-safe';
  argv: BoundedArgvV2; cwd?: AbsolutePath; docs_url?: never;
};
type CommandRemedyV1 = ManualCommandRemedyV1 | RetrySafeCommandRemedyV1;
type ManualRemedyV1 =
  | ManualCommandRemedyV1
  | (RemedyBaseV1 & { kind: 'documentation'; execution: 'manual';
      docs_url: HttpsUrl; argv?: never; cwd?: never })
  | (RemedyBaseV1 & { kind: 'explanation'; execution: 'manual';
      argv?: never; cwd?: never; docs_url?: never });
type RemedyV1 = ManualRemedyV1 | RetrySafeCommandRemedyV1;
type RetryableRemedyCollectionV2 =
  BoundedActionCollectionV2<RemedyV1> & {
    items: NonEmptyBoundedArrayV2<RemedyV1, 32>;
    retry_safe_command_id: NonEmptyString;
  };
type NonRetryableRemedyCollectionV2 =
  BoundedActionCollectionV2<ManualRemedyV1> & {
    items: NonEmptyBoundedArrayV2<ManualRemedyV1, 32>;
  };

type ActionInputRequirementV2 =
  | { kind: 'file'; id: NonEmptyString; label: NonEmptyString;
      flag: NonEmptyString; required: boolean; max_bytes: PositiveInteger;
      media_type: NonEmptyString; schema_ref?: NonEmptyString }
  | { kind: 'text'; id: NonEmptyString; label: NonEmptyString;
      flag: NonEmptyString; required: boolean; max_bytes: PositiveInteger }
  | { kind: 'attestation'; id: NonEmptyString; label: NonEmptyString;
      flag: '--attest'; required: true;
      statement: NonEmptyString; statement_sha256: Sha256 };

type ActionChoiceBaseV2 = { id: NonEmptyString; label: DisplayLabelV2;
  description: DisplayStringV2 };
type InputSlotsForV2<I extends readonly ActionInputRequirementV2[]> = {
  readonly [K in keyof I]: {
    input_id: I[K]['id']; after_flag: I[K]['flag']
  }
};
type CommandActionChoiceV2<
  I extends BoundedRequirementTupleV2<32>
> = ActionChoiceBaseV2 & {
  input_requirements: I;
  followup: { kind: 'command'; argv: BoundedArgvV2;
    cwd?: AbsolutePath; slots: InputSlotsForV2<I> };
};
type StructuredActionChoiceV2 = ActionChoiceBaseV2 & {
  input_requirements: readonly [];
  followup: { kind: 'structured-value'; value: BoundedJsonValueV2 };
  cli_equivalent: { kind: 'command'; argv: BoundedArgvV2;
    cwd?: AbsolutePath };
};
type ActionChoiceV2 =
  | GeneratedCommandActionChoiceUnionV2<CommandSpecV2>
  | StructuredActionChoiceV2;

type EffectRecoveryClassV2 =
  | 'pure_read' | 'idempotent_with_key'
  | 'isolated_discardable' | 'reconciliation_required';
type ReconciliationOutcomeV2 =
  | 'completed' | 'not-completed' | 'compensated' | 'abandon';
type BlockingEffectV2 = {
  effect_id: EffectId;
  state: 'running' | 'stopping' | 'unresponsive' | 'unknown';
  recovery_class: EffectRecoveryClassV2;
  containment_id: ContainmentId;
  admitted_at: Rfc3339;
};

type BlockingProjectEntityV2 =
  | { kind: 'run'; run_id: RunId; state: RunStateV2 }
  | { kind: 'invocation'; run_id: RunId; invocation_id: InvocationId;
      state: InvocationStateV2 }
  | { kind: 'transaction'; transaction_id: TransactionId;
      transaction_kind: NonEmptyString; phase: NonEmptyString }
  | { kind: 'mutation_domain_block'; apply_run_id: RunId;
      mutation_domain_id: MutationDomainId };

type ErrorCodeV2 =
  | 'INVALID_INVOCATION' | 'INVALID_CONFIG' | 'VALIDATION_FAILED'
  | 'NOT_FOUND' | 'PROTOCOL_TOO_OLD' | 'PROTOCOL_TOO_NEW'
  | 'PLAN_EXPIRED' | 'PLAN_UNAVAILABLE' | 'PLAN_DRIFT' | 'PLAN_TAMPERED'
  | 'APPROVAL_STALE' | 'DECISION_STALE' | 'IDEMPOTENCY_CONFLICT'
  | 'CONFIG_CONFLICT' | 'CONFIG_RESTORE_INCOMPATIBLE'
  | 'PROJECT_BUSY' | 'PROJECT_REPAIR_REQUIRED' | 'PROJECT_CONTEXT_MISMATCH'
  | 'RUN_PRUNED' | 'CURSOR_INVALID' | 'CURSOR_RUN_MISMATCH'
  | 'CURSOR_AHEAD' | 'TRACE_CORRUPT' | 'CONTAINMENT_UNKNOWN'
  | 'LIST_CURSOR_INVALID' | 'LIST_CURSOR_QUERY_MISMATCH'
  | 'WORKER_UNRESPONSIVE' | 'CONTINUATION_UNAVAILABLE'
  | 'BUDGET_UNENFORCEABLE'
  | 'EFFECT_RECONCILIATION_REQUIRED'
  | 'APPLY_DRIFT_BLOCKED' | 'PRUNE_DRIFT_BLOCKED' | 'APPLY_NOT_APPLICABLE'
  | 'CONNECTOR_UNAVAILABLE'
  | 'ENVIRONMENT_UNAVAILABLE' | 'SECRET_UNAVAILABLE'
  | 'RUNTIME_UNAVAILABLE' | 'FLOW_UNAVAILABLE' | 'FLOW_ID_CONFLICT'
  | 'UNSUPPORTED_PLATFORM' | 'CAPABILITY_UNAVAILABLE'
  | 'CHILD_CONTROL_REQUIRES_ROOT' | 'ROOT_SET_CONFLICT'
  | 'MACHINE_IDENTITY_CHANGED' | 'BACKUP_TAIL_UNAVAILABLE'
  | 'STREAM_TRANSPORT_LOST'
  | 'FOREGROUND_TRANSPORT_LOST'
  | 'CLIENT_INPUT_CLOSED'
  | 'CLIENT_INTERRUPTED'
  | 'TRANSPORT_ACTION_FAILED'
  | 'INTERNAL_ERROR';

type StreamTransportLostMetadataV2 =
  | { phase: 'opening';
      source_command: GeneratedOutcomeStreamCommandIdV2<CommandSpecV2>;
      stream_operation_id: StreamOperationId;
      inspect_status_argv: BoundedArgvV2 }
  | { phase: 'run_bound';
      source_command: GeneratedRunBoundStreamCommandIdV2<CommandSpecV2>;
      run_id: RunId; stream_operation_id: StreamOperationId;
      last_cursor?: ProgressCursorV2;
      new_watch_argv: BoundedArgvV2;
      new_wait_argv: BoundedArgvV2 }
  | { phase: 'pre_acceptance';
      source_command: GeneratedPreAcceptanceStreamCommandIdV2<CommandSpecV2>;
      stream_operation_id: StreamOperationId;
      plan_id?: PlanId; start_ticket_id?: StartTicketId;
      inspect_status_argv: BoundedArgvV2 };

type ErrorMetadataByCode = {
  INVALID_INVOCATION: { issues: NonEmptyBoundedCollectionV2<ValidationIssueV2> };
  INVALID_CONFIG: { source: ConfigSourceRef;
    issues: NonEmptyBoundedCollectionV2<ValidationIssueV2> };
  VALIDATION_FAILED: { entity: EntityRefV2;
    issues: NonEmptyBoundedCollectionV2<ValidationIssueV2> };
  NOT_FOUND: { entity_kind: EntityKindV2; id: NonEmptyString };
  PROTOCOL_TOO_OLD: ProtocolRangeMetadataV2;
  PROTOCOL_TOO_NEW: ProtocolRangeMetadataV2;
  PLAN_EXPIRED: { plan_kind: 'run' | 'apply'; plan_id: ManagedPlanIdV2;
    expires_at: Rfc3339; now: Rfc3339 };
  PLAN_UNAVAILABLE: { plan_kind: 'run' | 'apply';
    plan_id: ManagedPlanIdV2;
    state: 'closing' | 'abandoned' | 'pruned';
    closing_cause?: 'abandon' | 'expiry' | 'prune' };
  PLAN_DRIFT: { plan_id: ManagedPlanIdV2; expected_plan_sha256: Sha256;
    actual_inputs_sha256: Sha256;
    changed_inputs: NonEmptyBoundedCollectionV2<PlanInputNameV2> };
  PLAN_TAMPERED: { plan_id: ManagedPlanIdV2; expected_artifact_sha256: Sha256;
    actual_artifact_sha256: Sha256 };
  APPROVAL_STALE: { approval_id: ApprovalId; expected_digest: Sha256;
    current_digest: Sha256 };
  DECISION_STALE: { decision_kind: NonEmptyString; decision_id: NonEmptyString;
    expected_boundary_sha256: Sha256; current_boundary_sha256: Sha256;
    current_action?: ActionRequiredCodeV2 };
  IDEMPOTENCY_CONFLICT: { idempotency_key_sha256: Sha256;
    existing_run_id: RunId; expected_plan_artifact_sha256: Sha256;
    supplied_plan_artifact_sha256: Sha256 };
  CONFIG_CONFLICT: { source: ConfigSourceRef;
    expected_bytes_sha256: Sha256 | 'absent';
    current_bytes_sha256: Sha256 | 'absent';
    expected_file_identity: FileIdentity | 'absent';
    current_file_identity: FileIdentity | 'absent' };
  CONFIG_RESTORE_INCOMPATIBLE: { migration_receipt_id: ConfigMigrationReceiptId;
    target_schema_family: NonEmptyString; target_schema_version: PositiveInteger;
    active_reader_range: ProtocolRangeV2;
    required_reader_range: ProtocolRangeV2;
    current_schema_projection_available: boolean };
  PROJECT_BUSY: { project_instance_id: ProjectInstanceId;
    blocking_entities: NonEmptyBoundedCollectionV2<BlockingProjectEntityV2>;
    operation?: NonEmptyString };
  PROJECT_REPAIR_REQUIRED: { project_instance_id: ProjectInstanceId;
    repair_state: NonEmptyString };
  PROJECT_CONTEXT_MISMATCH: { supplied_project_root: AbsolutePath;
    supplied_project_instance_id?: ProjectInstanceId;
    target_project_root: AbsolutePath;
    target_project_instance_id: ProjectInstanceId;
    target_kind: 'plan' | 'run' | 'apply' | 'checkpoint' |
      'apply_repair' | 'reconciliation' | 'trust' | 'config' | 'ticket' |
      'flow_generation' | 'prune_batch' | 'artifact' | 'stream_operation';
    target_id: NonEmptyString };
  RUN_PRUNED: { root_run_id: RunId; terminal_outcome: RunOutcome;
    terminal_sha256: Sha256; final_cursor: ProgressCursorV2;
    tree_sequence_high_water: NonNegativeInteger; pruned_at: Rfc3339 };
  CURSOR_INVALID: { supplied_cursor_sha256: Sha256;
    supplied_byte_length: NonNegativeInteger;
    bounded_preview?: BoundedDisplayStringV2<256> };
  CURSOR_RUN_MISMATCH: { supplied_root_run_id: RunId; expected_root_run_id: RunId };
  CURSOR_AHEAD: { supplied_cursor: ProgressCursorV2;
    final_cursor?: ProgressCursorV2 };
  LIST_CURSOR_INVALID: { supplied_cursor_sha256: Sha256;
    reason: 'malformed' | 'oversized' | 'unauthenticated' };
  LIST_CURSOR_QUERY_MISMATCH: { cursor_command: CommandId;
    requested_command: CommandId; cursor_scope_sha256: Sha256;
    requested_scope_sha256: Sha256; cursor_filter_sha256: Sha256;
    requested_filter_sha256: Sha256 };
  TRACE_CORRUPT: { root_run_id: RunId; last_proved_cursor?: ProgressCursorV2;
    corruption_kind: NonEmptyString };
  CONTAINMENT_UNKNOWN: ContainmentStatusMetadataV2;
  WORKER_UNRESPONSIVE: WorkerStatusMetadataV2;
  BUDGET_UNENFORCEABLE: { requested_limit: NonEmptyString;
    requested_value: NonEmptyString;
    missing_proofs: NonEmptyBoundedCollectionV2<NonEmptyString> };
  CONTINUATION_UNAVAILABLE: { run_id: RunId;
    last_safe_boundary_id?: NonEmptyString;
    last_safe_trace_sha256?: Sha256;
    reason: 'no_safe_reentry_receipt' | 'unsupported_topology' |
      'later_executing_trace' | 'reentry_adapter_unavailable' |
      'resolution_reducer_unavailable' };
  EFFECT_RECONCILIATION_REQUIRED: { run_id: RunId;
    effect_ids: NonEmptyBoundedCollectionV2<EffectId>;
    resolution_version: NonNegativeInteger };
  APPLY_DRIFT_BLOCKED: { apply_run_id: RunId;
    paths: NonEmptyBoundedCollectionV2<ProjectRelativePath>;
    transaction_sha256: Sha256 };
  PRUNE_DRIFT_BLOCKED: { prune_batch_plan_id: PruneBatchPlanId;
    drift_generation: NonNegativeInteger;
    paths: NonEmptyBoundedCollectionV2<AbsolutePath>;
    show_argv: BoundedArgvV2; repair_plan_argv: BoundedArgvV2 };
  APPLY_NOT_APPLICABLE: { run_id: RunId;
    reason: 'result_already_materialized';
    result_materialization: 'base_checkout';
    final_checkout_sha256: Sha256 };
  CONNECTOR_UNAVAILABLE: { connector: ConnectorName; reason: NonEmptyString };
  ENVIRONMENT_UNAVAILABLE: { connector: ConnectorName;
    names: NonEmptyBoundedCollectionV2<EnvName>;
    material_kind: 'inherit_env' | 'secret_environment';
    required_profile: 'sealed' | 'foreground_only' | 'credential_store' };
  SECRET_UNAVAILABLE: { handle_id: SecretHandleId; provider: NonEmptyString };
  RUNTIME_UNAVAILABLE: { runtime_digest: Sha256; required_operation: NonEmptyString };
  FLOW_UNAVAILABLE: { flow_id: FlowId;
    configured_sources: BoundedCollectionV2<ConfigSourceRef> };
  FLOW_ID_CONFLICT: { flow_id: FlowId;
    applicable_entries: AtLeastTwoBoundedCollectionV2<{
      scope: 'builtin' | 'user' | 'project';
      project_instance_id?: ProjectInstanceId; entry_sha256: Sha256 }> };
  UNSUPPORTED_PLATFORM: { target: PlatformTriple;
    supported_targets: BoundedCollectionV2<PlatformTriple> };
  CAPABILITY_UNAVAILABLE: { requested_profile: PlatformCapabilityProfile;
    missing_capabilities: NonEmptyBoundedCollectionV2<PlatformCapability> };
  CHILD_CONTROL_REQUIRES_ROOT: { child_run_id: RunId; root_run_id: RunId };
  ROOT_SET_CONFLICT: { active_root_set_id: RootSetId;
    competing_root_set_id?: RootSetId; locator: AbsolutePath;
    discovery_slot_generation: NonNegativeInteger;
    competing_slot_generation?: NonNegativeInteger };
  MACHINE_IDENTITY_CHANGED: { recorded_machine_identity_sha256: Sha256;
    current_machine_identity_sha256: Sha256;
    root_set_id: RootSetId; bootstrap_root: AbsolutePath };
  BACKUP_TAIL_UNAVAILABLE: { backup_id: BackupId;
    recovery_cut_sha256: Sha256; requested_mode: 'exact_tail';
    disaster_point_available: boolean };
  STREAM_TRANSPORT_LOST: StreamTransportLostMetadataV2;
  FOREGROUND_TRANSPORT_LOST: { run_id: RunId;
    invocation_id: InvocationId;
    run_effect: 'interrupted' | 'reconciliation_required' |
      'ownership_unknown'; inspect_argv: BoundedArgvV2 };
  CLIENT_INPUT_CLOSED: { command: CommandId;
    input_context: 'id_picker' | 'project_picker' | 'choice_picker';
    selected_project_root?: AbsolutePath;
    noninteractive_argv: BoundedArgvV2 };
  CLIENT_INTERRUPTED: { signal: 'SIGHUP' | 'SIGINT' | 'SIGQUIT' | 'SIGTERM';
    run_effect: 'continues' | 'foreground_may_interrupt' | 'no_run';
    run_id?: RunId; last_cursor?: ProgressCursorV2 };
  TRANSPORT_ACTION_FAILED: { installation_id: InstallationId;
    transaction_id: TransactionId; phase: NonEmptyString };
  INTERNAL_ERROR: { incident_id: NonEmptyString };
};

type ErrorContextV2 =
  | { scope: 'command'; command: CommandId; project_root?: AbsolutePath }
  | { scope: 'plan'; command: CommandId; project_root: AbsolutePath;
      plan_kind: 'run' | 'apply'; plan_id: ManagedPlanIdV2;
      plan_artifact_sha256: Sha256 }
  | { scope: 'run'; command: CommandId; project_root: AbsolutePath;
      root_run_id: RunId; run_id: RunId; run_folder: AbsolutePath;
      invocation_id?: InvocationId; last_cursor?: ProgressCursorV2 }
  | { scope: 'pruned_run'; command: CommandId; root_run_id: RunId;
      run_id: RunId; last_cursor: ProgressCursorV2 }
  | { scope: 'transaction'; command: CommandId; transaction_id: TransactionId;
      project_root?: AbsolutePath };

type ErrorFrameV2 = {
  [C in ErrorCodeV2]: {
    schema_version: 2; protocol_version: 'circuit/2'; kind: 'error';
    stream_operation_id: StreamOperationId;
    terminal_frame_id: Sha256;
    code: C; message: DisplayStringV2;
    context: ErrorContextV2;
    metadata: ErrorMetadataByCode[C];
    docs_url: HttpsUrl;
  } & (
    | { retryable: true; remedies: RetryableRemedyCollectionV2 }
    | { retryable: false; remedies: NonRetryableRemedyCollectionV2 }
  )
}[ErrorCodeV2];

type CommandOutcomeV2 =
  | 'complete' | 'terminal_non_complete' | 'accepted' | 'detached'
  | 'observed_terminal' | 'canceled' | 'declined' | 'no_change'
  | 'ready' | 'unready' | 'valid' | 'invalid' | 'empty'
  | 'created' | 'updated' | 'removed' | 'restored' | 'pruned'
  | 'reported' | 'exported';

type ResultFrameV2 = {
  [C in CommandId]: {
    schema_version: 2; protocol_version: 'circuit/2'; kind: 'result';
    stream_operation_id: StreamOperationId;
    terminal_frame_id: Sha256;
    command: C;
    outcome: CommandOutcomeByCommand[C];
    data: ResultDataByCommand[C];
  }
}[CommandId];
```

For a retryable error, `retry_safe_command_id` must name exactly one inline
`RetrySafeCommandRemedyV1`; supplemental manual command, documentation, and
explanation remedies remain legal. A nonretryable error accepts only
`ManualRemedyV1` and therefore cannot contradict itself with a retry-safe
command. Unknown or duplicate remedy IDs fail validation.

Malformed cursor input is never echoed. `CURSOR_INVALID` always reports its
hash and byte length; `bounded_preview` is allowed only when the complete input
is at most 256 display-safe bytes. Oversized input omits the preview entirely.

`CommandSpecV2` names one closed result schema for every leaf and generates
`CommandOutcomeByCommand` and `ResultDataByCommand`; there is no generic data
bag and no command can omit `data`. The schema families are:

| Result schema | Required data |
| --- | --- |
| Run execution | Run/root/Invocation IDs, durable state, terminal outcome only in terminal states, selected Flow, routing fields, Run folder, observed Trace count, last cursor, idempotency key, and every current terminal host field named in `host-adapter.md` |
| Apply execution | The same accepted/detached versus terminal Run phases plus immutable Apply-plan, source-Run/result, accepted-base, and terminal Apply-outcome fields |
| Apply drift repair | Planning returns immutable drift/settlement identities and action; confirmed settlement streams the same nonterminal Apply Run through repaired, newly blocked, or terminal `complete|operator_settled` result without inventing another Run |
| Reconciliation probe | Planning returns the immutable ledger-owned probe plan and confirmation action; confirmed execution streams one attempt/receipt with Run/effect/ledger identity, reservation usage, immutable result-or-absence evidence or unknown outcome, and the next reconcile action without changing the primary Run outcome by inference |
| Flow generation | Accepted/detached state without a draft, or terminal Run fields plus a produced/not-produced generation result; produced results carry draft ID/path/hash, Flow ID, validation/repair summary, and promotion remedy; command remains `flows.generate` |
| Run snapshot or viewer | Run tree identity, durable state, cleanup state, last cursor, active action, and viewer ending |
| Plan or change plan | Immutable ID, executable/full-artifact or change hashes, expiry, inline typed body or `PlanArtifactReferenceV2`, approvals, and inspect/start remedies |
| Setup or doctor | Every selected probe, required/informational status, elapsed time, authority boundary, and remedy |
| Config or trust | Scope, root source, value, every origin/trust decision, schema hash, or exact trust-plan/receipt body |
| List | Typed item schema, stable ordering key, items, and continuation marker when supported |
| Mutation receipt | Immutable receipt ID, confirmed digest, changed resource identities, before/after hashes, and rollback posture |
| Update/status/version | Installation/runtime identities, protocol ranges, bootstrap trust, availability, signed target, authority generation, and active/previous state |
| Report/export | Run ID, terminal outcome, report/evidence paths or content references, and hashes |
| Preserved v1 adapter | The byte-golden v1 payload nested under an explicitly named adapter schema until that leaf gets a native v2 map |

The native Run result is exhaustive rather than “current fields plus a bag.”
Its first protocol-2 schema is:

```ts
type RunArtifactReferenceV2<K extends 'report' | 'evidence'> = {
  kind: K;
  label: NonEmptyString;
  run_relative_path: RunRelativePath;
  media_type: NonEmptyString;
  byte_length: NonNegativeInteger;
  sha256: Sha256;
};

type ReportReferenceV2 = RunArtifactReferenceV2<'report'>;
type EvidenceReferenceV2 = RunArtifactReferenceV2<'evidence'>;

type TerminalRunStateV2 =
  | 'complete' | 'aborted' | 'handoff' | 'stopped' | 'escalated' | 'canceled';

type RunResultCommonV2 = {
  root_run_id: RunId;
  run_id: RunId;
  invocation_id?: InvocationId;
  flow_id: FlowId;
  result_materialization: 'isolated_patch' | 'base_checkout';
  resolved_axes?: {
    depth: 'low' | 'medium' | 'high';
    tournament: boolean;
    autonomous: boolean;
  };
  selected_flow?: FlowId;
  routed_by?: 'explicit';
  router_reason?: NonEmptyString;
  entry_mode?: NonEmptyString;
  entry_mode_source?: 'explicit' | 'derived';
  run_folder: AbsolutePath;
  runtime_reason?: NonEmptyString;
  trace_entries_observed: NonNegativeInteger;
  last_cursor?: ProgressCursorV2;
  idempotency_key: NonEmptyString;
};

type RunAcceptedOrDetachedResultDataV2 = RunResultCommonV2 & {
  result_phase: 'accepted_or_detached';
  state: RunStateV2; // observation; may advance before the response arrives
  outcome?: never;
  reason?: never;
};

type InlineCollectionProjectionV2<K extends string, T> =
  | ({ [P in K]: BoundedArrayV2<T, 200> } &
     { [P in `${K}_total`]: ExactArrayCountV2<K> } &
     { [P in `${K}_overflow`]?: never })
  | ({ [P in K]: BoundedArrayV2<T, 200> } &
     { [P in `${K}_total`]: GreaterThanInlineCountV2<K> } &
     { [P in `${K}_overflow`]: CollectionReferenceV2 });

type OptionalInlineCollectionProjectionV2<K extends string, T> =
  | ({ [P in K | `${K}_total` | `${K}_overflow`]?: never })
  | InlineCollectionProjectionV2<K, T>;

type HistoryWarningV2 = { code: NonEmptyString; message: DisplayStringV2 };
type HistoryRecallResultV2 = {
  status: NonEmptyString;
  memory_input_count: NonNegativeInteger;
  report_path: AbsolutePath;
  rebuilt: boolean;
  index_state?: NonEmptyString;
} & InlineCollectionProjectionV2<'warnings', HistoryWarningV2>;

type PostRunArtifactWarningV2 = {
  label: DisplayLabelV2; message: DisplayStringV2;
};

type RunTerminalResultDataV2 = RunResultCommonV2 &
  OptionalInlineCollectionProjectionV2<
    'post_run_artifact_warnings', PostRunArtifactWarningV2
  > &
  OptionalInlineCollectionProjectionV2<
    'run_decision_packet_paths', AbsolutePath
  > & {
  result_phase: 'terminal';
  state: TerminalRunStateV2;
  outcome: RunOutcome; // must equal state
  reason?: NonEmptyString;
  result_path?: AbsolutePath;
  history_recall?: HistoryRecallResultV2;
  operator_summary_path?: AbsolutePath;
  operator_summary_markdown_path?: AbsolutePath;
  operator_summary_status_text?: NonEmptyString;
  operator_summary_html_path?: AbsolutePath;
  run_envelope_path?: AbsolutePath;
  run_process_evidence_path?: AbsolutePath;
  run_surface_markdown_path?: AbsolutePath;
  run_surface_status_text?: NonEmptyString;
  autonomous_loop?: {
    outcome: 'complete' | 'needs_attention' | 'blocked' | 'failed' | 'handoff';
    attempts: NonNegativeInteger;
    stop_reason: NonEmptyString;
    path: AbsolutePath;
  };
  required_apply?: {
    apply_run_id: RunId; child_terminal_sha256: Sha256;
    apply_outcome: 'complete' | 'conflict' | 'failed' | 'canceled' |
      'operator_settled';
  };
  reports: BoundedCollectionV2<ReportReferenceV2>;
  evidence: BoundedCollectionV2<EvidenceReferenceV2>;
};

type RunResultDataV2 =
  | RunAcceptedOrDetachedResultDataV2
  | RunTerminalResultDataV2;

type FlowDraftResultV2 = {
  draft_id: FlowDraftId;
  flow_id: FlowId;
  canonical_home: AbsolutePath;
  draft_sha256: Sha256;
  validation_sha256: Sha256;
  validation_summary: NonEmptyString;
  repair_attempts: NonNegativeInteger;
  promote_argv: [
    'circuit', 'flows', 'promote', '--draft', FlowDraftId
  ];
};

type FlowGenerationResultDataV2 =
  | (RunAcceptedOrDetachedResultDataV2 & {
      generation: { state: 'pending' };
    })
  | (RunTerminalResultDataV2 & {
      generation: { state: 'produced'; draft: FlowDraftResultV2 };
    })
  | (RunTerminalResultDataV2 & {
      generation: { state: 'not_produced';
        validation_summary: NonEmptyString;
        repair_attempts: NonNegativeInteger };
    });

type ApplyResultCommonV2 = {
  apply_plan_id: ApplyPlanId;
  source_run_id: RunId;
  source_result_sha256: Sha256;
  accepted_base_sha256: Sha256;
};

type ApplyResultDataV2 =
  | (RunAcceptedOrDetachedResultDataV2 & ApplyResultCommonV2)
  | (RunTerminalResultDataV2 & ApplyResultCommonV2 & {
      apply_outcome:
        | 'complete' | 'conflict' | 'failed' | 'canceled' | 'operator_settled';
    });
```

Those names cover every field in the current host Run payload, including the
resolved axes, entry mode, history recall, all summary/surface/envelope paths,
decision packets, process evidence, and autonomous-loop result. Optionality is
fixed by the schema and golden fixtures; a projector cannot silently omit a
required empty array. The three preserved array-shaped host fields are capped
at 200 inline entries. Their `_total` value is always the full count; an
`_overflow` reference is required exactly when more entries exist. History
warnings always carry `warnings_total`; the two older optional arrays carry
their total and overflow siblings whenever the array is present. Reconstructing
the referenced canonical collection produces the exact characterized v1 array
order and bytes. Native v2 adds only the root/Invocation/state/cursor,
idempotency, and typed artifact-reference fields shown above. The v1 adapter
continues to emit its byte-golden top-level envelope; a v2 host unwraps only
`ResultFrameV2.data`. For Run-execution commands, outer outcomes
`accepted|detached` map only to the accepted/detached branch; attached terminal
completion maps only to the terminal branch, where `state === outcome`. The
accepted/detached branch's `state` is an observation and may already be
terminal after a fast worker, but `result_phase` and absent `outcome` keep exit
0 scoped to durable acceptance rather than Run success.
`watch` keeps its separate viewer-result schema. A detached start can therefore
report `queued` or a later observation without inventing a Run outcome. Flow generation likewise
cannot promise a draft before its authoring Run produces one.
For Apply, `complete` requires terminal Run state `complete`, `canceled`
requires `canceled`, and `conflict|failed` map only to declared
terminal non-complete states; `operator_settled` requires terminal `aborted`.
`apply_recovery_required` uses the accepted/detached branch with an action, not
a terminal Apply outcome. Golden schema refinements reject every other pair.
When the accepted plan requires an in-tree Apply, `required_apply` is mandatory
on the parent terminal result and its outcome/state pair must match the frozen
`InTreeApplyCompletionTxnV1` table; otherwise that field is forbidden.

`plans show --format json` returns the inline canonical
artifact or `PlanArtifactReferenceV2`; list results always use their smaller
typed summary and never inline plan artifacts.

The error-code and result-schema registries are closed for protocol 2. Adding a
code or changing a mapped payload requires a new negotiated protocol major and
golden fixtures. `argv` is never a shell string. A remedy is not executed until
the caller explicitly chooses it.

Error context uses the most advanced identity already committed. Once Run
acceptance exists, `scope: run` (or `pruned_run` after committed prune) is
mandatory even for a later secret,
connector, report, or internal failure; JSON callers always receive the Run
folder and IDs needed to inspect or attach. `IDEMPOTENCY_CONFLICT`,
`DECISION_STALE`, `CONFIG_CONFLICT`, `CONFIG_RESTORE_INCOMPATIBLE`,
`PROJECT_CONTEXT_MISMATCH`, `CONTINUATION_UNAVAILABLE`, and
`MACHINE_IDENTITY_CHANGED`, `ENVIRONMENT_UNAVAILABLE`, and
`SECRET_UNAVAILABLE`, `BUDGET_UNENFORCEABLE`, and `FLOW_ID_CONFLICT` are well-formed negative results and
exit 1.
`BACKUP_TAIL_UNAVAILABLE` exits 1 when the caller explicitly requires exact
tail or no disaster restore is possible. With no forced mode, Circuit returns
`confirm_repair_restore` for the disaster-point plan and exits 3 instead.
`LIST_CURSOR_QUERY_MISMATCH` exits 1 and `LIST_CURSOR_INVALID` exits 2.
`PLAN_UNAVAILABLE` exits 1 and never issues or consumes a ticket.
`CLIENT_INTERRUPTED` exits 129, 130, 131, or 143 according to its signal.
Malformed keys/tokens still exit 2.

Default and debug output never print raw relay output or secret values. Every
structured request is strict, rejects unknown fields, and is limited to 1 MiB
of UTF-8 in protocol v1. Control RPC frames are limited to 4 MiB; larger data
uses hash-bound file references. Goal input is exactly one of:

```text
--goal <text>
--goal-file <path-or->
--request-file <path-or->
```

`--goal-file -` and `--request-file -` consume stdin once. The request envelope
carries an explicit project root. Goal text is UTF-8, rejects NUL, and shares
the 1 MiB limit. Hosts never need to shell-escape it.

Model-backed Flow generation has the same input guarantee. Exactly one of
`--description <text>`, `--description-file <path-or->`, or
`--request-file <path-or->` is accepted. `--description-file -` consumes stdin
once. `FlowGenerationRequestV1` is strict structured data:

```ts
type FlowGenerationRequestV1 = {
  schema_version: 1;
  description: NonEmptyUtf8String;
  name?: FlowId;
  home?: AbsolutePath;
  scope?: 'user' | 'project';
  created_at?: Rfc3339;
  max_repair?: NonNegativeInteger;
  timeout_ms?: PositiveInteger;
  budget_limits?: BudgetPolicyV3;
};
```

It shares the UTF-8/NUL/1 MiB rules. A field duplicated by a CLI option is an
error. It cannot request publication, connector commands, approval, or secrets.
Description/request file paths resolve from client cwd; `home` becomes one
canonical absolute output identity in the plan.

`--request-file` on `plan` or a fresh `run` accepts `PlanRequestV1` only.
Starting an already inspected plan uses a separate internal/public-RPC shape:

```ts
type PlanRequestV1 = {
  schema_version: 1;
  project_root: AbsolutePath;
  goal: NonEmptyUtf8String;
  why?: NonEmptyUtf8String;
  power?: 'auto' | 'low' | 'medium' | 'high';
  process?: 'low' | 'medium' | 'high';
  tournament?: 2 | 3 | 4;
  autonomous?: boolean;
  include_untracked_content?: boolean;
  budget_limits?: BudgetPolicyV3;
};

type RunStartRequestV1 = {
  schema_version: 1;
  origin_command: 'run' | 'flows.generate';
  project_root: AbsolutePath;
  plan_id: PlanId;
  plan_sha256: Sha256;
  plan_artifact_sha256: Sha256;
  start_ticket_id: StartTicketId;
  idempotency_key: NonEmptyString;
  start_authorization:
    | { kind: 'no_approval_required';
        receipt_id: NoApprovalRequiredReceiptId;
        connection_token: OpaqueToken }
    | { kind: 'approval_decision'; decision_id: ApprovalDecisionId;
        connection_token: OpaqueToken };
};
```

It is strict, canonical JSON data only, and may not carry connector commands,
secrets, policy, raw approvals, attachment, output, or arbitrary invocation
options. The opaque connection-bound authorization reference proves either the
empty consequence set or the prior authenticated decision; a hash or copied
`approved: true` field cannot replace it.
`origin_command` must match the committed PlanReceipt and selects only the
result schema, never execution authority.
`PlanRequestV1` has no idempotency key because planning starts no Run.
The positional Flow remains mandatory. A field duplicated by a CLI
flag is an error even when values match; there is no hidden precedence.
`project_root` is absolute. The request-file and goal-file path arguments are
resolved from client cwd, while project input references are resolved from the
canonical project root and hash-bound in RunPlanV1.

### Action-required contract

Exit 3 means a valid operation needs a human decision. The action vocabulary is
closed: `approve_plan`, `answer_checkpoint`, `confirm_setup`,
`confirm_setup_rollback`, `confirm_init`, `confirm_apply`,
`confirm_flow_promotion`, `confirm_flow_replacement`, `confirm_flow_registry_migration`,
`confirm_flow_retirement`, `confirm_export`, `confirm_runtime_pin_remove`, `confirm_update`,
`confirm_config_migration`, `confirm_prune`,
`confirm_project_instructions_detach`, `confirm_uninstall`, `confirm_purge`,
`confirm_freeze_legacy`, `confirm_repair_restore`, `confirm_adopt_project`,
`confirm_machine_recovery`, `confirm_backup_export`,
`confirm_project_enrollment`, `confirm_project_trust`,
`confirm_config_restore`, `confirm_project_retirement`,
`confirm_project_relocation`,
`confirm_installation_repair`, `confirm_hook_resolution`,
`resolve_flow_migration_candidates`,
`confirm_recovery_anchor`,
`confirm_force`,
`confirm_reconciliation_probe`,
`resolve_prune_drift`, `confirm_prune_repair`,
`choose_active_run_disposition`,
`resolve_checkpoint_drain`, `run_transport_update`, `run_transport_uninstall`,
`reconcile_effect`, `continue_reconciliation`, `resolve_apply_drift`, and
`confirm_apply_drift_repair`.
Machine presentations use `ActionRequiredFrameV2`:

```ts
type ActionRequiredCodeV2 =
  | 'approve_plan' | 'answer_checkpoint' | 'confirm_setup'
  | 'confirm_setup_rollback' | 'confirm_init' | 'confirm_apply'
  | 'confirm_flow_promotion' | 'confirm_flow_replacement'
  | 'confirm_flow_registry_migration'
  | 'confirm_flow_retirement' | 'confirm_export' | 'confirm_runtime_pin_remove'
  | 'confirm_update' | 'confirm_config_migration' | 'confirm_prune'
  | 'confirm_project_instructions_detach' | 'confirm_uninstall' | 'confirm_purge'
  | 'confirm_freeze_legacy' | 'confirm_repair_restore'
  | 'confirm_adopt_project' | 'confirm_machine_recovery'
  | 'confirm_backup_export' | 'confirm_project_enrollment'
  | 'confirm_project_trust' | 'confirm_config_restore'
  | 'confirm_project_retirement' | 'confirm_installation_repair'
  | 'confirm_project_relocation' | 'confirm_hook_resolution'
  | 'resolve_flow_migration_candidates' | 'confirm_recovery_anchor'
  | 'confirm_force'
  | 'confirm_reconciliation_probe'
  | 'resolve_prune_drift' | 'confirm_prune_repair'
  | 'choose_active_run_disposition'
  | 'resolve_checkpoint_drain' | 'run_transport_update'
  | 'run_transport_uninstall' | 'reconcile_effect'
  | 'continue_reconciliation' | 'resolve_apply_drift'
  | 'confirm_apply_drift_repair';

type ActionContextV2 =
  | { scope: 'command'; project_root?: AbsolutePath }
  | { scope: 'plan'; project_root: AbsolutePath;
      plan_id: ManagedPlanIdV2; plan_artifact_sha256: Sha256 }
  | { scope: 'run'; project_root: AbsolutePath; root_run_id: RunId;
      run_id: RunId; run_folder: AbsolutePath; last_cursor?: ProgressCursorV2 }
  | { scope: 'transaction'; transaction_id: TransactionId;
      project_root?: AbsolutePath };

type AllowedActionByCommandV2 = GeneratedAllowedActionMap<CommandSpecV2>;

type CommandsForActionV2<A extends ActionRequiredCodeV2> = {
  [C in CommandId]: A extends AllowedActionByCommandV2[C] ? C : never
}[CommandId];

type ActionContextByCommandV2 = GeneratedActionContextMap<CommandSpecV2>;

type ActionFrameBase<A extends ActionRequiredCodeV2> = {
  [C in CommandsForActionV2<A>]: {
    schema_version: 2;
    protocol_version: 'circuit/2';
    kind: 'action_required';
    stream_operation_id: StreamOperationId;
    terminal_frame_id: Sha256;
    action_id: ActionId;
    source_command: C;
    context: ActionContextByCommandV2[C];
    action: A;
    prompt: BoundedDisplayStringV2<16384>;
  } & ActionabilityV2
}[CommandsForActionV2<A>];

type ConfirmationTargetByAction = {
  confirm_setup: { setup_plan_id: SetupPlanId; setup_plan_sha256: Sha256 };
  confirm_setup_rollback: { setup_receipt_id: SetupReceiptId;
    rollback_plan_sha256: Sha256 };
  confirm_init: { project_root: AbsolutePath;
    init_kind: 'project' | 'nested_anchor' | 'first_fix_example';
    before_state_sha256: Sha256 };
  confirm_apply: { source_run_id: RunId; apply_plan_id: ApplyPlanId;
    apply_plan_sha256: Sha256; apply_plan_artifact_sha256: Sha256;
    source_result_sha256: Sha256; accepted_base_sha256: Sha256 };
  confirm_reconciliation_probe: {
    reconciliation_probe_plan_id: ReconciliationProbePlanId;
    probe_plan_sha256: Sha256; run_id: RunId; effect_id: EffectId;
    resolution_version: NonNegativeInteger; query_adapter_sha256: Sha256;
    worst_case_reservation_sha256: Sha256 };
  confirm_prune_repair: { prune_repair_plan_id: PruneRepairPlanId;
    prune_batch_plan_id: PruneBatchPlanId;
    drift_generation: NonNegativeInteger;
    strategy: 'retry-after-restore' | 'abort-and-restore';
    prune_repair_plan_sha256: Sha256;
    restoration_image_sha256: Sha256 };
  confirm_apply_drift_repair: { apply_run_id: RunId;
    apply_repair_plan_id: ApplyRepairPlanId;
    repair_plan_sha256: Sha256; apply_transaction_sha256: Sha256;
    current_checkout_sha256: Sha256; settlement_image_sha256: Sha256 };
  confirm_flow_promotion: { draft_id: FlowDraftId; flow_id: FlowId;
    draft_receipt_sha256: Sha256; draft_sha256: Sha256;
    registry_target: FlowRegistryTargetV1; registry_target_sha256: Sha256;
    before_state_sha256: Sha256 | 'absent' };
  confirm_flow_replacement: { draft_id: FlowDraftId; flow_id: FlowId;
    draft_receipt_sha256: Sha256; draft_sha256: Sha256;
    registry_target: FlowRegistryTargetV1; registry_target_sha256: Sha256;
    active_entry_sha256: Sha256; replacement_plan_sha256: Sha256;
    reference_inventory_sha256: Sha256 };
  confirm_flow_registry_migration: { flow_migration_plan_id: FlowMigrationPlanId;
    legacy_inventory_sha256: Sha256; target_registry_generation: NonNegativeInteger };
  confirm_flow_retirement: { flow_id: FlowId; registry_entry_sha256: Sha256;
    reference_inventory_sha256: Sha256 };
  confirm_export: { run_id: RunId; export_manifest_sha256: Sha256;
    output_path: AbsolutePath; output_parent_identity: FileIdentity };
  confirm_runtime_pin_remove: { pin_id: RuntimePinId; runtime_digest: Sha256 };
  confirm_update: { installation_id: InstallationId;
    signed_release_manifest_sha256: Sha256; authority_generation: NonNegativeInteger };
  confirm_config_migration: { config_migration_plan_id: ConfigMigrationPlanId };
  confirm_prune: { prune_batch_plan_id: PruneBatchPlanId;
    target_kind: 'runs' | 'plans' | 'flow_drafts';
    ownership_scope: { kind: 'project'; project_instance_id: ProjectInstanceId }
      | { kind: 'user' }; item_count: PositiveInteger;
    selector_sha256: Sha256; closure_sha256: Sha256 };
  confirm_project_instructions_detach: { project_root: AbsolutePath;
    instruction_inventory_sha256: Sha256 };
  confirm_uninstall: { installation_id: InstallationId;
    uninstall_plan_id: UninstallPlanId;
    frontend_receipt_sha256: Sha256; active_run_disposition: NonEmptyString;
    run_disposition_receipt_sha256: Sha256;
    hook_inventory_sha256: Sha256; hook_disposition_sha256: Sha256 };
  confirm_purge: { scope: NonEmptyString; inventory_sha256: Sha256;
    recovery_key_set_sha256: Sha256 | 'none';
    recovery_key_disposition: 'not_applicable' | 'retain' | 'destroy' };
  confirm_freeze_legacy: { run_id: RunId; boundary_sha256: Sha256 };
  confirm_repair_restore: { backup_id: BackupId;
    restore_mode: 'exact_tail' | 'disaster_point';
    current_store_generation?: NonNegativeInteger;
    recovery_cut_sha256: Sha256; next_private_store_epoch: NonNegativeInteger;
    disposition_inventory_sha256: Sha256 };
  confirm_adopt_project: { project_root: AbsolutePath; inventory_sha256: Sha256 };
  confirm_machine_recovery: { machine_recovery_plan_id: MachineRecoveryPlanId;
    old_machine_identity_sha256: Sha256; new_machine_identity_sha256: Sha256;
    root_set_id: RootSetId; inventory_sha256: Sha256;
    mode: 'authority_rebind' | 'data_only_import' };
  confirm_backup_export: { backup_id: BackupId;
    backup_export_candidate_id: BackupExportCandidateId;
    snapshot_manifest_sha256: Sha256; output_path: AbsolutePath;
    output_parent_identity: FileIdentity; archive_sha256: Sha256 };
  confirm_project_enrollment: { project_root: AbsolutePath; inventory_sha256: Sha256 };
  confirm_project_trust:
    | { operation: 'apply'; project_trust_plan_id: ProjectTrustPlanId }
    | { operation: 'revoke'; trust_id: TrustId;
        project_instance_id: ProjectInstanceId };
  confirm_config_restore: { migration_receipt_id: ConfigMigrationReceiptId;
    current_config_sha256: Sha256; restore_mode: 'exact' | 'current_schema';
    target_schema_version: PositiveInteger;
    compatibility_closure_sha256: Sha256 };
  confirm_project_retirement: { project_instance_id: ProjectInstanceId;
    inventory_sha256: Sha256 };
  confirm_project_relocation: { project_relocation_plan_id: ProjectRelocationPlanId;
    project_instance_id: ProjectInstanceId; old_root: AbsolutePath;
    new_root: AbsolutePath; root_file_identity: FileIdentity;
    relocation_plan_sha256: Sha256 };
  confirm_installation_repair: {
    installation_repair_plan_id: InstallationRepairPlanId;
    installation_id: InstallationId;
    classification: 'present_verified_replacement' | 'absent_proved';
    before_receipt_sha256: Sha256; repair_plan_sha256: Sha256 };
  confirm_hook_resolution: { edge_id: ExecutableEdgeId;
    action: 'replace' | 'remove' | 'classify-non-circuit';
    source_span_sha256: Sha256; resolution_plan_sha256: Sha256 };
  confirm_recovery_anchor: { recovery_anchor_plan_id: RecoveryAnchorPlanId;
    anchor_generation: NonNegativeInteger;
    action: 'restore' | 'destroy-and-initialize';
    recovery_key_set_sha256: Sha256;
    target_root_set_sha256: Sha256 };
  confirm_force: { force_action_id: ForceActionId;
    run_id: RunId; cancel_request_id: ControlRequestId;
    worker_birth_identity_sha256: Sha256;
    containment_id: ContainmentId; control_generation: NonNegativeInteger;
    force_action_sha256: Sha256; not_before: Rfc3339; expires_at: Rfc3339 };
};

type ConfirmationActionCodeV2 = keyof ConfirmationTargetByAction;
type ConfirmationActionFrameV2 = {
  [A in ConfirmationActionCodeV2]: ActionFrameBase<A> & {
    change_digest: Sha256;
    target: ConfirmationTargetByAction[A];
  }
}[ConfirmationActionCodeV2];

type ActionRequiredFrameV2 =
  | (ActionFrameBase<'approve_plan'> & { project_root: AbsolutePath;
      plan_id: PlanId; plan_sha256: Sha256; plan_artifact_sha256: Sha256;
      start_ticket_id: StartTicketId; idempotency_key: NonEmptyString })
  | (ActionFrameBase<'answer_checkpoint'> & { run_id: RunId;
      checkpoint_id: CheckpointId; boundary_sha256: Sha256;
      decision_token: DecisionTokenV1 })
  | ConfirmationActionFrameV2
  | (ActionFrameBase<'choose_active_run_disposition'> & {
      project_instance_id: ProjectInstanceId;
      run_ids: NonEmptyBoundedCollectionV2<RunId>;
      inventory_sha256: Sha256 })
  | (ActionFrameBase<'resolve_checkpoint_drain'> & { run_id: RunId;
      checkpoint_id: CheckpointId; boundary_sha256: Sha256;
      blocking_effects: NonEmptyBoundedCollectionV2<BlockingEffectV2>;
      current_deadline?: Rfc3339; extension_allowed: boolean;
      force_escalation_available: boolean })
  | (ActionFrameBase<'run_transport_update'> & {
      installation_id: InstallationId; transaction_id: TransactionId;
      manager_argv: BoundedArgvV2;
      cleanup_argv: BoundedArgvV2 })
  | (ActionFrameBase<'run_transport_uninstall'> & {
      installation_id: InstallationId; transaction_id: TransactionId;
      manager_argv: BoundedArgvV2;
      cleanup_argv: BoundedArgvV2 })
  | (ActionFrameBase<'reconcile_effect'> & { run_id: RunId;
      effect_id: EffectId; intent_sha256: Sha256;
      resolution_version: NonNegativeInteger;
      resolution_decision_token: ResolutionDecisionTokenV1;
      recovery_class: EffectRecoveryClassV2;
      result_requirement: 'none' | 'reconstructable';
      expected_receipt_schema?: NonEmptyString;
      immutable_result_ref_required: boolean;
      allowed_outcomes: NonEmptyBoundedCollectionV2<ReconciliationOutcomeV2> })
  | (ActionFrameBase<'continue_reconciliation'> & { run_id: RunId;
      resolution_version: NonNegativeInteger; ledger_sha256: Sha256;
      safe_reentry_receipt_sha256: Sha256;
      continuation_token: ReconciliationContinueTokenV1 })
  | (ActionFrameBase<'resolve_apply_drift'> & { apply_run_id: RunId;
      apply_transaction_sha256: Sha256; drift_boundary_sha256: Sha256;
      paths: NonEmptyBoundedCollectionV2<ProjectRelativePath>;
      strategies: readonly ['continue-if-restored', 'preserve-current',
        'overwrite-current'] })
  | (ActionFrameBase<'resolve_prune_drift'> & {
      prune_batch_plan_id: PruneBatchPlanId;
      drift_generation: NonNegativeInteger;
      paths: NonEmptyBoundedCollectionV2<AbsolutePath>;
      strategies: readonly ['retry-after-restore', 'abort-and-restore'] })
  | (ActionFrameBase<'resolve_flow_migration_candidates'> & {
      candidates: NonEmptyBoundedCollectionV2<LegacyFlowCandidateSummaryV1>;
      inventory_sha256: Sha256;
      decisions_template: CollectionReferenceV2 });
```

The action discriminant selects the only legal fields. Missing required fields,
irrelevant fields from another variant, or an empty required choice set fail
schema validation. In particular, an `approve_plan` frame without both hashes,
its pre-mutation StartTicket, and the caller-known idempotency key is never
valid. Every choice declares all required input and its exact argv slot; a host
never parses `prompt` or `description` to discover a receipt, result reference,
attestation, or note. Drain frames identify every blocking effect. Reconcile
frames carry the receipt schema and result requirement that make each outcome
legal. Command slots and input IDs are a bijection; structured-value choices
have no external inputs and always carry their executable CLI equivalent.
Unknown, duplicated, missing, oversize, or wrong-schema input changes nothing.

`AllowedActionByCommandV2` is generated from the same `CommandSpecV2` entry as
the parser and result schema. It is a closed relation, not a free pair of
strings. For example, `reconcile.show` may return `reconcile_effect` or
`continue_reconciliation`, `reconcile.probe.plan` may return only
`confirm_reconciliation_probe`, `applies.repair.plan` may return
`confirm_apply_drift_repair`, a blocked batch prune may return
`resolve_prune_drift`, `repair.prune.plan` may return
`confirm_prune_repair`, and `self.uninstall.plan|prepare|apply` may return
only their declared disposition, force/reconciliation, manager, or confirmation
actions. `cancel`, `applies.cancel`, and `checkpoints.drain` on its cancel branch
may return `confirm_force`; only
`actions.confirm-force` may consume that action and return a
`ForceDecisionV1`, and only the exact force leaf may consume the decision. A
frame whose `source_command` and `action` do not match that generated
relation fails before encoding. The context is the most advanced committed
identity: command before a plan exists, plan after plan commit, Run after Run
acceptance, and transaction after a mutation transaction commits.

Every action has at least one inline executable choice or remedy. Choices and
remedies are independently capped at 32 and must fit the 1 MiB terminal-frame
limit; overflow remains inspectable through its collection reference, but the
caller never needs the overflow merely to make one safe forward choice. Command
choices have an exact one-to-one mapping between declared input requirements
and argv slots: each requirement ID and flag appears once, no undeclared slot
exists, and fixed argv cannot contain a placeholder. Structured-value choices
carry no requirement or slot but must carry their generated CLI-equivalent
argv. Documentation and explanation remedies are always manual and never
qualify as the action's executable path. Runtime validation rejects empty,
prose-only, documentation-only, or structured choices without a CLI equivalent,
duplicate IDs/flags, extra choices for another action, and any encoded bound
violation.

Every `confirm_*` mutation except the two-stage `confirm_force` path likewise consumes single-use
`ConfirmationDecisionV1` created by authenticated `actions.confirm`; it binds
the action variant, `change_digest`, typed target, caller, and expiry. CLI
`--yes` is its presentation. Repeating the exact confirm call returns the same
decision and mutation result; copying the digest without that decision grants
nothing. `confirm_force` creates the narrower `ForceDecisionV1` described in
Cancellation and still uses an authenticated action RPC. This gives direct CLI
and host RPCs the same approval boundary.

- Only `human` on a controlling TTY may prompt. Machine formats, `--no-input`,
  and `--detach` never prompt or mutate before exit 3.
- `--yes` grants only approval names already declared in the plan and requires
  the exact plan or change digest described above. If approval remains missing,
  no worker starts; Circuit returns the exact hash-bound remedy and exits 3.
- Every `confirm_*` action shows a digest-bound change plan first. `--yes`
  confirms only that digest; it cannot choose an active-Run disposition,
  authorize third-party login, or run arbitrary manager text.
- A machine follow-up supplies `--confirm <change-digest> --yes`, unless the
  command's confirmed grammar requires an immutable plan/receipt ID and its
  artifact digest. A mismatched or stale digest returns a fresh action-required
  object and makes no change. A human TTY may render and confirm the digest in
  one invocation without spelling `--yes`; machine and no-input calls must use
  the exact generated follow-up.
- `init` binds its digest to every created path and byte. Later Apply binds
  source result, current base, postimage, approvals, and mutation-domain
  generation. Update binds installation, signed target, bootstrap identity, and
  current runtime-authority generation. Repair restore binds immutable backup
  ID and manifest, current store generation/high-water, and reconciliation
  plan. Changing any input returns a new action instead of applying stale
  consent.
- Declining a finite pre-mutation prompt makes no change, returns outcome
  `declined`, and exits 1. Interrupting exits 130. Declined launch atomically
  terminalizes its StartTicket, keeps the plan, and creates no failed Run.
  Declining an active viewer's cancel menu selects
  Continue and returns to the viewer; it does not exit.
- A worker commits the checkpoint and parks before requesting an answer. An
  attached human TTY may answer inline through the same compare-and-swap as the
  public command.
- The canonical answer is
  `circuit checkpoints answer <run-id> <checkpoint-id> --choice <choice-id>
  --token <decision-token>`. One token-bound answer wins. A winning answer
  records the choice and enqueues through `EnqueueTxnV1`; no separate resume is
  needed.
- `resume` on an unanswered checkpoint exits 3 with the exact answer command.
  A stale structured boundary hash exits 1; a malformed hash exits 2.

## Exit semantics

| Command result | Exit |
| --- | --- |
| Attached `run`, `resume`, `wait`, confirmed Apply, or confirmed reconciliation probe observes its declared complete receipt | 0 |
| Attached command observes a terminal non-complete outcome | 1 |
| Invalid invocation, config, protocol, or approval value | 2 |
| Valid operation needs any declared human action | 3 |
| Local attached Unix client receives SIGHUP | 129 |
| Local attached client receives SIGINT | 130 |
| Local attached Unix client receives SIGQUIT | 131 |
| Local attached client receives SIGTERM where supported | 143 |
| Detached start reaches durable queue acceptance | 0 |
| Detached confirmed Apply reaches durable queue acceptance | 0 |
| Attached `run` or `resume` detaches its viewer with `q` after acceptance | 0 |
| `cancel` observes `canceled`, or finds the Run already terminal | 0 |
| A graceful force-capable source reaches its bound with a proved live controllable target | 3 with `confirm_force` |
| Graceful or forced control reaches reconciliation, unknown/ineligible containment, or an unsettled force bound | 1 with no force action |
| `actions confirm-force` commits or replays the exact decision | 0; no signal is sent yet |
| `watch` detaches with `q` | 0 |
| `watch` observes any terminal Run state | 0 |
| Any isolated outcome stream exhausts its ten-second authenticated reconnect grace | 1 with permit-bound `STREAM_TRANSPORT_LOST`; durable Run continues |
| A foreground client/pipe fails while its controller can still write an ending | 1 with `FOREGROUND_TRANSPORT_LOST`; Run state reflects exact exit/effect proof |
| EOF closes a pre-action picker | 1 with `CLIENT_INPUT_CLOSED`; no decision or mutation |
| EOF closes a pre-mutation action prompt | 3 with the unchanged action; no decision or mutation |
| EOF closes an isolated viewer prompt | 0 detached; Run and pending action continue |
| Batch prune detects post-first-move path drift | 3 with `resolve_prune_drift`; fences remain closed |
| Plain/NDJSON `watch` or `wait` reaches a parked human action | 3 after the exact action-required ending; Run remains parked |

`watch` is a viewer and never propagates the Run outcome. `wait` is the
automation primitive and does. A malformed Run ID exits 2; a well-formed but
unknown Run exits 1. The v1 adapter retains current exit behavior until its
N+3/180-day compatibility floor expires and the N+4 removal gates pass.
An exhausted reconnect is a client-operation failure, not a Run outcome. The
expired stream operation is never advertised as retryable. A Run-bound error
contains fresh bounded `watch` and `wait --after` commands for the same project,
Run, and last acknowledged cursor. Those commands create new read-only stream
operations and cannot create or accept work.

Finite commands use the same stable classes:

| Finite result | Exit |
| --- | --- |
| Successful read/mutation/no-op, empty list, or `update --check` | 0 |
| Well-formed negative result: required doctor/setup check unready, invalid target document/Flow, not found, or delegated manager failure | 1 |
| Invalid grammar, option conflict, malformed ID, or unsupported protocol | 2 |
| Valid action still required, including an external fixed manager command | 3 |
| Local SIGHUP on Unix | 129 |
| Local SIGINT | 130 |
| Local SIGQUIT on Unix | 131 |
| Local SIGTERM where supported | 143 |

`SIGHUP`/`SIGTERM` do not open the first-interrupt menu. For durable attached
Runs and viewers these exits describe only the client; the Run continues. For
an in-place foreground Invocation, the final error says that the forwarded
signal may also interrupt the Run. Raw completion and an external config editor
use the explicit non-frame exceptions above.

Doctor returns 1 only for its required chosen set; informational probe failure
does not fail it. Config/Flow validation returns 1 for invalid content and 2 for
an invalid invocation. A delegated update that Circuit cannot safely execute
returns `run_transport_update`, exact fixed argv, and exit 3 without mutation.

## Command surface and attachment

One typed `CommandSpecV2[]` registry is the authority for parsing, help,
completion, documentation, output class, target selection, action boundary,
exit behavior, hidden/contributor status, `default_presentation_by_release`,
legacy adapter, and removal date.
Generated `--help`, this grammar, and bash, zsh, fish, and PowerShell completion
must match it. CI rejects an ellipsis, collapsed leaf namespace, or option that
exists in only one surface.

The registry composes named option groups, then expands them into every parser,
help page, grammar fixture, completion, and host schema:

| Group | Exact public options |
| --- | --- |
| `GoalInput` | Exactly one of positional goal where the leaf allows it, `--goal <text>`, `--goal-file <path-or->`, or `--request-file <path-or->` |
| `FlowDescriptionInput` | Exactly one of `--description <text>`, `--description-file <path-or->`, or `--request-file <path-or->` |
| `BudgetSelection` | `--max-physical-attempts <n>`, `--max-relays <n>`, `--max-input-tokens <n>`, `--max-output-tokens <n>`, `--max-total-tokens <n>`, `--max-active-time-ms <n>`, exact-decimal `--max-cost-usd <usd>`, and repeatable typed `--provider-quota <provider:quota=units>`; every value may only tighten effective policy |
| `PlanSelection` | `--why <text>`, `--power <auto|low|medium|high>`, `--process <low|medium|high>`, `--tournament [2|3|4]`, `--autonomous`, `--include-untracked-content`, and `BudgetSelection`; bare `--tournament` means 3 |
| `PageSelection` | `--limit <1..200>` (default 50) and opaque `--after <cursor>`; only the bounded list leaves named above |
| `FreshRun` | `GoalInput`, `PlanSelection`, one of `--attach|--detach`, and optional `--in-place --foreground` |
| `ProjectAware` | `--project-root <path>` |
| `Presentation` | The command's allowed `--format`, `--json`, `--no-color`, `--screen-reader`, and `--debug` options |
| `Interaction` | `--no-input` on an action-bearing command; `--confirm <sha256> --yes` only on the named confirmed form |
| `LegacyRunAdapter` | Characterized `--run-folder`, `--fixture`, `--flow-root`, `--reuse-children-from`, and `--progress jsonl` on the exact compatibility leaves only |

Every `CommandSpecV2` form also declares
`project_context: select|assert|none`. `select` resolves the project from
`ProjectAware` or normal root precedence. `assert` first resolves the immutable
target ID, then treats `--project-root` only as an assertion. One public spelling
may have separate forms: for example ID-less `watch` selects, while exact-ID
`watch` asserts.

The closed `select` set is: bare `circuit`; normal `init`; `project show` and
`project enroll`; `project instructions detach`; project trust show/plan;
Preview, plan, fresh Run, and built-in aliases; ID-less watch/wait/resume/report;
runs list, ID-less show, reclaim, and `prune --before`; plans list,
date/expired prune planning, and ticket list without `--plan`; ID-less reconcile list and
checkpoint list; flows list/show/validate, flows drafts list, fresh generate,
project-scoped create, and project-scoped retire; effective/project
config reads and every `--project` config mutation; doctor without a plan; and
the preserved history, memory, and handoff forms that resolve project state.

The closed `assert` set is: project-trust revoke/apply; `actions confirm-force`;
`run --plan` and
`flows generate --plan`; every `--reattach` operation and exact-ID watch/wait/resume/cancel/report/apply
form; `apply --plan`, applies show/cancel, and both applies-repair forms; reconcile list with a Run ID,
show, probe plan/apply/abandon, resolve, and continue; runs show with an ID, export, freeze-legacy, and
explicit-ID/targets-file/batch prune; plans show, plan/artifact read, plan abandon, ticket list with `--plan`, ticket abandon, and
explicit-ID/targets-file/batch prune; Flow-draft explicit-ID/targets-file/batch prune; checkpoint list with a Run ID, drain, and answer; project config
migration apply/restore; all `repair prune` forms; and `doctor --plan`. All other forms are `none`.
Commands with a
required path serving another purpose, such as repair adoption or data purge,
keep that command-specific option instead of joining `ProjectAware`.

For an asserted target, Circuit canonicalizes the supplied root and compares
both its root identity and `ProjectInstanceV1` with the target receipt. A
well-formed mismatch performs no read with ambient authority, makes no mutation,
exits 1 as `PROJECT_CONTEXT_MISMATCH`, and returns supplied/target roots and
instances, target kind, target ID, and repair remedies. `--latest` searches only
inside the selected project. `--project-root` conflicts with `--global`, init
`--here`, and init example mode.

The registry encodes conflicts, not handwritten handlers: positional goal
versus another goal source, Run ID versus `--latest`, `--attach` versus
`--detach`, `--in-place` without `--foreground`, and `--yes` without an exact
confirmation digest all fail before lookup or mutation. Preview `--matrix`
requires a Flow and conflicts with every `--power` value, including `auto`;
Matrix displays all four Power settings. The invalid pair exits 2 before asset
or config lookup.

The new and changed leaf grammar is:

```text
circuit [<ProjectAware>]
circuit setup
circuit setup check [--host <host>] [--connector <name>]*
circuit setup plan [--host <host>] [--connector <name>]* [--bootstrap-root <path>] [--config-root <path>] [--state-root <path>] [--data-root <path>] [--cache-root <path>]
circuit setup apply --plan <setup-plan-id> [--confirm <setup-plan-sha256> --yes]
circuit setup rollback <setup-receipt-id> [--confirm <rollback-plan-sha256> --yes]
circuit configure
circuit init [--here | --example first-fix --path <empty-dir>] [<ProjectAware>] [--confirm <init-plan-sha256> --yes]
circuit project show [<ProjectAware>]
circuit project enroll [--legacy-root <path>]* [--legacy-decisions <path-or->] [<ProjectAware>] [--confirm <sha256> --yes]
circuit project relocate plan --instance <project-instance-id> --to <path>
circuit project relocate apply --plan <project-relocation-plan-id> --confirm <project-relocation-plan-sha256> --yes
circuit project instructions detach [<ProjectAware>] [--confirm <sha256> --yes]
circuit project trust show [<ProjectAware>]
circuit project trust plan [<ProjectAware>] [--connector <name>]*
circuit project trust apply --plan <project-trust-plan-id> [<ProjectAware>] [--confirm <project-trust-plan-sha256> --yes]
circuit project trust revoke <trust-id> [<ProjectAware>] [--confirm <sha256> --yes]

circuit preview [<flow>] [--power <auto|low|medium|high>] [<ProjectAware>]
circuit preview <flow> --matrix [<ProjectAware>]
circuit dev preview [<flow>] --source-checkout <path> [--power <auto|low|medium|high>] [<ProjectAware>]
circuit dev plan <flow> <goal-input> --source-checkout <path> [<PlanSelection>] [--in-place] [<ProjectAware>]
circuit dev run <flow> <goal-input> --source-checkout <path> [<PlanSelection>] [--attach | --detach] [--in-place --foreground] [<ProjectAware>]
circuit plan <flow> <goal-input> [<PlanSelection>] [--in-place] [<ProjectAware>]
circuit run <flow> <goal-input> [<PlanSelection>] [--attach | --detach] [--in-place --foreground] [<ProjectAware>]
circuit run --plan <plan-id> [--start-ticket <ticket-id> --idempotency-key <key>] [--confirm <plan-artifact-sha256> --yes] [--attach | --detach] [--foreground] [<ProjectAware>]
circuit run --reattach <stream-operation-id> --token <stream-resume-token> [--after <cursor>] [<ProjectAware>]
circuit watch [<run-id>] [--latest] [--after <cursor>] [--filter <text>] [<ProjectAware>]
circuit watch --reattach <stream-operation-id> --token <stream-resume-token> [--after <cursor>] [<ProjectAware>]
circuit wait [<run-id>] [--latest] [--after <cursor>] [<ProjectAware>]
circuit wait --reattach <stream-operation-id> --token <stream-resume-token> [--after <cursor>] [<ProjectAware>]
circuit resume [<run-id>] [--attach | --detach] [--foreground] [<ProjectAware>]
circuit resume --reattach <stream-operation-id> --token <stream-resume-token> [--after <cursor>] [<ProjectAware>]
circuit cancel <run-id> [<ProjectAware>]
circuit actions confirm-force <force-action-id> --confirm <force-action-sha256> --yes [<ProjectAware>]
circuit cancel <run-id> --force --decision <force-decision-id> [<ProjectAware>]
circuit report [<run-id>] [--latest] [<ProjectAware>]
circuit apply <run-id> [--idempotency-key <key>] [<ProjectAware>]
circuit apply --plan <apply-plan-id> [--confirm <apply-plan-sha256> --yes] [--attach | --detach] [<ProjectAware>]
circuit apply --reattach <stream-operation-id> --token <stream-resume-token> [--after <cursor>] [<ProjectAware>]
circuit applies show <apply-run-id> [<ProjectAware>]
circuit applies cancel <apply-run-id> [<ProjectAware>]
circuit applies cancel <apply-run-id> --force --decision <force-decision-id> [<ProjectAware>]
circuit applies repair plan <apply-run-id> --strategy <continue-if-restored|preserve-current|overwrite-current> [<ProjectAware>]
circuit applies repair apply --plan <apply-repair-plan-id> --confirm <repair-plan-sha256> --yes [<ProjectAware>]
circuit applies repair apply --reattach <stream-operation-id> --token <stream-resume-token> [--after <cursor>] [<ProjectAware>]
circuit reconcile list [<run-id>] [<PageSelection>] [<ProjectAware>]
circuit reconcile show <run-id> [<effect-id>] [<ProjectAware>]
circuit reconcile probe plan <run-id> <effect-id> --token <resolution-token> [<ProjectAware>]
circuit reconcile probe apply --plan <reconciliation-probe-plan-id> --confirm <probe-plan-sha256> --yes [<ProjectAware>]
circuit reconcile probe apply --reattach <stream-operation-id> --token <stream-resume-token> [--after <cursor>] [<ProjectAware>]
circuit reconcile probe abandon <reconciliation-probe-plan-id> [<ProjectAware>]
circuit reconcile resolve <run-id> <effect-id> --token <resolution-token> --outcome <completed|not-completed|compensated|abandon> [--receipt-file <path>] [--result-ref-file <path>] [--note-file <path>] [--attest <statement-sha256>] [<ProjectAware>]
circuit reconcile continue <run-id> --token <continuation-token> [<ProjectAware>]

circuit runs list [<PageSelection>] [<ProjectAware>]
circuit runs show [<run-id>] [--latest] [<ProjectAware>]
circuit runs export <run-id> --output <new-path> [--include <reports|evidence|all>] [<ProjectAware>] [--confirm <sha256> --yes]
circuit runs freeze-legacy <run-id> [<ProjectAware>] [--confirm <sha256> --yes]
circuit runs reclaim [<ProjectAware>]
circuit runs prune (--run <run-id>+ | --before <rfc3339> [--keep-last <n>] | --targets-file <path-or->) [<ProjectAware>]
circuit runs prune --batch <prune-batch-plan-id> --confirm <prune-batch-plan-sha256> --yes [<ProjectAware>]
circuit plans list [--kind <run|apply|all>] [--expired | --all] [<PageSelection>] [<ProjectAware>]
circuit plans show <plan-id> [<ProjectAware>]
circuit plans artifact read <plan-id> [--offset <n>] [--max-bytes <1..786432>] [<ProjectAware>] --format json
circuit artifacts read <artifact-id> [--offset <n>] [--max-bytes <1..786432>] [<ProjectAware>] --format json
circuit plans abandon <plan-id> [<ProjectAware>]
circuit plans tickets list [--plan <plan-id>] [<PageSelection>] [<ProjectAware>]
circuit plans tickets abandon <ticket-id> [<ProjectAware>]
circuit plans prune (--plan <plan-id>+ | --expired | --before <rfc3339> | --targets-file <path-or->) [<ProjectAware>]
circuit plans prune --batch <prune-batch-plan-id> --confirm <prune-batch-plan-sha256> --yes [<ProjectAware>]
circuit flows list [<PageSelection>] [<ProjectAware>]
circuit flows show <flow> [<ProjectAware>]
circuit flows create --description <text> [--name <slug>] [--home <path>] [--scope <user|project>] [--created-at <rfc3339>] [--decompose] [<ProjectAware>]
circuit flows generate <FlowDescriptionInput> [--name <slug>] [--home <path>] [--scope <user|project>] [--created-at <rfc3339>] [--max-repair <n>] [--timeout-ms <ms>] [<BudgetSelection>] [--attach | --detach] [<ProjectAware>]
circuit flows generate --plan <plan-id> [--start-ticket <ticket-id> --idempotency-key <key>] [--confirm <plan-artifact-sha256> --yes] [--attach | --detach] [<ProjectAware>]
circuit flows generate --reattach <stream-operation-id> --token <stream-resume-token> [--after <cursor>] [<ProjectAware>]
circuit flows promote --draft <draft-id> [--confirm <promotion-plan-sha256> --yes]
circuit flows replace --draft <draft-id> [--confirm <replacement-plan-sha256> --yes]
circuit flows retire <flow> [--scope <user|project>] [<ProjectAware>] [--confirm <sha256> --yes]
circuit flows drafts list [--state <available|promoted|abandoned|all>] [<PageSelection>] [<ProjectAware>]
circuit flows drafts show <draft-id>
circuit flows drafts abandon <draft-id>
circuit flows drafts prune (--draft <draft-id>+ | --targets-file <path-or->)
circuit flows drafts prune --batch <prune-batch-plan-id> --confirm <prune-batch-plan-sha256> --yes
circuit flows migrate plan [--legacy-home <path>]* [--decisions-file <path-or->]
circuit flows migrate apply --plan <flow-migration-plan-id> [--confirm <sha256> --yes]
circuit flows validate <flow> [<ProjectAware>]
circuit flows validate [<PageSelection>] [<ProjectAware>]
circuit checkpoints list [<run-id>] [<PageSelection>] [<ProjectAware>]
circuit checkpoints drain <run-id> <checkpoint-id> --boundary <sha256> --action <wait|cancel> [<ProjectAware>]
circuit checkpoints drain <run-id> <checkpoint-id> --boundary <sha256> --action force --decision <force-decision-id> [<ProjectAware>]
circuit checkpoints answer <run-id> <checkpoint-id> --choice <choice-id> --token <decision-token> [<ProjectAware>]
circuit config show [--project | --global] [--root-source <canonical|legacy>] [<ProjectAware>]
circuit config get <key> [--project | --global] [<ProjectAware>]
circuit config explain <key> [<ProjectAware>]
circuit config set <key> (<yaml-json-value> | --string <text> | --value-file <path-or->) (--project | --global) [<ProjectAware>]
circuit config unset <key> (--project | --global) [<ProjectAware>]
circuit config edit (--project | --global) [--root-source <canonical|legacy>] [<ProjectAware>]
circuit config validate [--project | --global] [--root-source <canonical|legacy>] [<ProjectAware>]
circuit config path [--project | --global] [--root-source <canonical|legacy>] [<ProjectAware>]
circuit config migrate plan (--project | --global) [--with-project-trust] [--root-source <canonical|legacy>] [<ProjectAware>]
circuit config migrate apply --plan <config-migration-plan-id> [<ProjectAware>] [--confirm <config-migration-plan-sha256> --yes]
circuit config restore --receipt <migration-receipt-id> [--mode <exact|current-schema>] [<ProjectAware>] [--confirm <sha256> --yes]
circuit repair inspect [--project-root <path>]
circuit repair backup create
circuit repair backup list [<PageSelection>]
circuit repair backup export <backup-id> --output <new-path> [--confirm <sha256> --yes]
circuit repair backup import <path>
circuit repair restore --backup <backup-id> [--mode <exact-tail|disaster-point>] [--confirm <restore-plan-sha256> --yes]
circuit repair machine plan --from-bootstrap-root <path> [--backup <backup-id>]
circuit repair machine apply --plan <machine-recovery-plan-id> [--confirm <sha256> --yes]
circuit repair adopt-project --project-root <path> [--confirm <sha256> --yes]
circuit repair retire-project <project-instance-id> [--confirm <sha256> --yes]
circuit repair installation plan --installation <id>
circuit repair installation apply --plan <installation-repair-plan-id> --confirm <sha256> --yes
circuit repair recovery-anchor show
circuit repair recovery-anchor plan --action <restore|retain|destroy-and-initialize> [--backup <path>]
circuit repair recovery-anchor apply --plan <recovery-anchor-plan-id> --confirm <sha256> --yes
circuit repair prune show <prune-batch-plan-id> [<ProjectAware>]
circuit repair prune plan <prune-batch-plan-id> --strategy <retry-after-restore|abort-and-restore> [<ProjectAware>]
circuit repair prune apply --plan <prune-repair-plan-id> --confirm <prune-repair-plan-sha256> --yes [<ProjectAware>]

circuit doctor [--flow <flow> | --plan <plan-id>] [<ProjectAware>]
circuit completion <bash|zsh|fish|powershell>
circuit self status
circuit self cleanup [--receipt <id>]
circuit runtimes pins list [<PageSelection>]
circuit runtimes pins create --version <version> [--reason <text>]
circuit runtimes pins remove <pin-id> [--confirm <sha256> --yes]
circuit update [--check | --version <version> | --rollback [<version>]] [--installation <id>] [--confirm <sha256> --yes]
circuit self update [--check | --version <version> | --rollback [<version>]] [--installation <id>] [--confirm <sha256> --yes]
circuit self uninstall [--installation <id>]
circuit self uninstall plan [--installation <id>]
circuit self uninstall prepare --plan <uninstall-plan-id> --active-runs <leave-running|graceful-cancel|abort>
circuit self uninstall apply --plan <uninstall-plan-id> --confirm <uninstall-plan-sha256> --yes
circuit self purge --all-installations [--include-user-config [--recovery-keys <retain|destroy>]] [--confirm <sha256> --yes]
circuit data purge --project-root <path> (--runs | --all) [--confirm <sha256> --yes]
circuit handoff hooks install --host codex [--installation <id>] [--hooks-file <path>] [--launcher <path>]
circuit handoff hooks uninstall --host codex [--installation <id>] [--hooks-file <path>]
circuit handoff hooks doctor --host codex [--installation <id>] [--hooks-file <path>]
circuit handoff hooks resolve --candidate <edge-id> --action <replace|remove|classify-non-circuit> [--confirm <sha256> --yes]
circuit version
```

In this generated notation, a bracketed option followed by `*` is repeatable
zero or more times, and a value followed by `+` is repeatable one or more times.
Every `<flow>` accepts `FlowRefV2`; help shows the unqualified form first and
qualified `builtin:`, `user:`, and `project:` forms only for ambiguity or
migration.
Every `<run-id>` accepts `RunRefV2`: an ordinary storage-v2 Run ID, a unique
legacy display ID in the asserted project, or qualified `legacy:<record-id>`.
Help and actions print the qualified form whenever a legacy display ID is not
unique; state-changing commands never accept an ambiguous display ID.

The registry also imports each characterized `history`, `memory`, and `handoff`
leaf unchanged from the Phase 1 compatibility inventory. Their exact current
option sets are recorded in the migration table below; the generated registry
contains one entry per leaf and no catch-all namespace. Top-level `create`,
`generate`, `reclaim`, `checkpoints`, and `uninstall --dir` are dated adapters
to the exact leaves above.

The preserved leaves are `history rebuild`, `history query`, `history pull`,
`history status`, `history memory-merge`, `history memory-effect`, `memory note`,
`memory list`, `memory forget`, `handoff save`, `handoff resume`, `handoff done`,
`handoff brief`, `handoff hook`, `handoff harvest`, `handoff hooks install`,
`handoff hooks uninstall`, and `handoff hooks doctor`. Phase 1 snapshots each
current parser spec before it is imported; an unknown subcommand is never
forwarded.

`flows generate` is not a synchronous utility exception. It invokes a model, so
it creates an ordinary `RunPlanV1` for the signed internal flow-authoring Flow,
with `FlowDescriptionInput` as goal and `--max-repair`/`--timeout-ms` as enforced
bounds. Its StartTicket follows the same consequence rules as `run`: a machine,
detached, or no-input first call returns `approve_plan` only while approval IDs
remain; a consequence-free authoring plan receives
`NoApprovalRequiredReceiptV1` and may continue. An approval-bearing follow-up is
the hash-confirmed `flows generate --plan` form. Both leaves call the same Run-start use case,
but retain originating command ID `flows.generate` and
`FlowGenerationResultV2` in every presentation. A controlling TTY may inspect,
confirm, and attach in one call. The generated draft is a Run-owned
artifact registered in the user-data draft store only through a recorded effect;
publication remains the separate digest-confirmed `flows promote --draft
<draft-id>`. The legacy
top-level `generate` adapter may project its final v1 payload after the Run, but
cannot call a connector or write a draft outside this lifecycle. Release N warns
about the new plan boundary; N+1 enforces it before any model spend.

Options are declared per command; the root parser never accepts and blindly
forwards a supposed global flag.

| Command | Target selection | Attachment and workspace |
| --- | --- | --- |
| `plan <flow>` | No Run | Accepts `--in-place`, frozen into the plan; no attach/foreground |
| `run <flow>` | Creates a plan; the same call may start when `StartAuthorizationV1` has no outstanding action | `--attach` or `--detach`; detached is two-call only when approvals remain; `--in-place` requires `--foreground` |
| `run --plan` | Exact plan | `--attach` or `--detach`; rejects workspace drift; foreground only if accepted plan is in-place |
| `apply <run-id>` | Exact source Run; creates no Apply Run | Read-only Apply planning; no attachment flag |
| `apply --plan` | Exact Apply plan; creates a later root Apply Run | Attach by default or explicit `--detach`; never in-place/foreground |
| `flows generate` / `flows generate --plan` | Fresh authoring plan or exact plan | Attach by default after authorization or explicit `--detach`; confirmation occurs only when approvals remain; same Run lifecycle and one result schema |
| `resume` | Exact Run ID or human-TTY picker | `--attach` or `--detach` for isolated Runs; in-place requires foreground |
| `watch`, `wait`, `report`, `runs show` | Exact ID, read-only `--latest`, or human picker | No workspace/foreground flags |
| `cancel`, `applies cancel/repair`, `checkpoints drain/answer`, `reconcile probe/resolve/continue`, `runs export`, `runs freeze-legacy` | Exact IDs and required non-bearer decision ID, decision token, or plan where declared | No picker or latest |
| `runs prune`, `plans prune`, `flows drafts prune` | First call resolves one immutable batch; confirmed call names its exact batch ID | No implicit latest; at most 200 argv IDs, otherwise targets file or dated selector |
| `plans show`, `plans artifact read`, `artifacts read` | Exact plan or immutable artifact receipt | No implicit latest; artifact reads are bounded and JSON-only |
| `repair restore`, `repair adopt-project`, `repair retire-project` | Exact immutable backup ID, project, or instance plus digest | No inferred target; a path must be imported first |

| Cross-cutting option | Applicability and default |
| --- | --- |
| `--project-root` | Every project-aware command; otherwise rejected |
| `--format` / `--json` | Only the output classes above; default follows N/N+1/N+2 table |
| `--no-color` | Human/plain-capable commands; disables ANSI only |
| `--screen-reader` | Human-capable commands; forces append-only renderer and no single-key UI |
| `--debug` | All commands except raw completion; scrubbed diagnostics on stderr |
| `--yes` / `--no-input` | Only commands with a declared action; may combine because one grants named approval and the other suppresses prompts |
| `--confirm <sha256>` | Approval-bearing `run --plan`/`flows generate --plan` and every `--yes` mutation after action-required; must match the immutable plan artifact or current change digest; consequence-free starts reject it |
| `--start-ticket` / `--idempotency-key` | `run --plan` and `flows generate --plan` consume the exact pre-mutation ticket/key pair with either authorization variant; later Apply accepts an explicit key or derives one from its full identity before its plan commits |
| Goal/description inputs | `plan`, fresh `run`, aliases, and fresh `flows generate`; exactly one source from that leaf's input group |

Read-only `--latest` means newest eligible Run in the resolved project by
durable `created_at`, with Run ID as tie-breaker. It never crosses project
instances. Outside a human TTY, omitting an optional Run ID without allowed
`--latest` exits 2 before lookup. Mutation always names exact IDs.
`--project-root` is accepted only
by project-aware commands; format flags only by the format table; `--yes` and
`--no-input` only by commands with a declared action boundary. Unknown options
exit 2 at the rejecting command.

`runs export` makes the recovery promise concrete. Its first call acquires a
source access pin and previews a canonical manifest of selected Trace, reports,
and evidence, sensitivity warning, output path/parent identity, and archive
hash. It never includes private leases, tokens, approvals, secrets, or config.
Confirmed export stages and syncs the archive, rechecks source and parent, and
atomically installs only to a nonexistent no-follow target; it never overwrites.
Source prune cannot close its fence until the pin/transaction commits or exact
owner death aborts it.

Attach is the default after plan authorization. Attachment describes the client,
not worker ownership. A fresh `--detach` returns an approval action only when
the plan has outstanding approval IDs. A consequence-free detached start mints
its ticket and `NoApprovalRequiredReceiptV1`, shows or embeds the full plan
header, and proceeds directly to durable queue acceptance. Either that call or
the later confirmed `run --plan --detach` returns only after plan/receipt
storage, identity allocation, `run.accepted`/`run.queued`, and the synced queue
record; exit 0 means accepted, not running or successful. Separate byte-golden
fixtures freeze both fresh-detach authorization variants. `--foreground` is not
an attachment synonym: it is valid only with `--in-place`, conflicts with
detach, disables reconnect/concurrency, and warns that terminal loss may
interrupt work.
If acceptance committed but its response is lost, an idempotent retry returns
that queued or running Run only by presenting the already-issued StartTicket and
key; it never allocates a hidden second Run. Machine and detached confirmed
starts missing either value fail before acceptance.

Confirmed later Apply uses the same viewer and result rules. Attach is the
default; attached output follows the Apply Run through terminal state and its
exit reflects the Apply outcome. `--detach` returns only after durable queue
acceptance with outcome `accepted`, Run ID, Apply plan/source IDs, and exact
watch/wait/cancel commands. JSON is one final typed Apply result; NDJSON is its
milestone feed plus that result. Planning `apply <source-run-id>` is finite and
never reports queue acceptance.

The current host launcher injects `--template-flow-root` into top-level
`create`, although the creator no longer uses it. Phase 1 removes that injection
from the shared launcher and generated mirrors. Until cached launchers expire,
only the top-level `create` adapter accepts and ignores it; `flows create` and
all execution commands reject it. It disappears with that adapter.

Built-in aliases are pure argument rewrites to a fresh `run`:

```text
circuit fix <goal-input> [<alias-execution-options>]
circuit build <goal-input> [<alias-execution-options>]
circuit review [<goal-input>] [<alias-execution-options>]
circuit explore <goal-input> [<alias-execution-options>]
circuit prototype <goal-input> [<alias-execution-options>]
```

`<alias-execution-options>` expands `PlanSelection`, fresh-Run
attach/workspace, `ProjectAware`, `Presentation`, and applicable `Interaction`
options, but not a second `GoalInput`. It includes
`--project-root`, format/accessibility/debug flags, and `--no-input`.
`--tournament` accepts an optional 2, 3, or 4 and defaults to 3 when bare.
Aliases reject `--plan`, `--confirm`, `--yes`, and contributor-only
`LegacyRunAdapter` options; plan execution always uses canonical `run --plan`.

A positional alias goal conflicts with explicit goal input. `fix`, `build`,
`explore`, and `prototype` reject a missing goal before planning. Only `review`
supplies `current diff` when none is provided. Generated and custom Flows stay under
`run <flow>`. `pursue` is internal in the source catalog and intentionally has
no alias; the current host-adapter sentence listing it as public is source drift
to correct in Phase 1.

### Current-command and flag migration

Every current parsed surface has a disposition:

| Current surface | V2 disposition |
| --- | --- |
| Bare TTY Ink shell | First expose it as `configure`; keep bare TTY routed there until the slim home passes parity, then switch with one migration notice |
| `run <flow>` | Keep canonical and move behind new use cases |
| Run `--goal`, `--why`, `--power`, `--process`, `--tournament`, `--autonomous`, `--include-untracked-content` | Keep publicly and record the resolved effect in RunPlanV1 |
| Run `--run-folder` | Keep as a path adapter where currently accepted; new starts derive folders from Run ID |
| Run `--fixture`, `--reuse-children-from` | Keep as trusted contributor/test or exact recovery controls on characterized leaves; hide from ordinary help |
| Run `--flow-root` | N inventories and warns; N+1 production rejects before planning and points to `flows migrate`; parser remedy only through N+3/180 days; earliest removal N+4. Source development uses the separate verified checkout provider. |
| Run `--dry-run` | Keep parsing and rejecting until a real no-effect contract exists; never reinterpret as Preview or plan |
| Run `--progress jsonl` | Keep the complete v1 host mode defined above |
| `resume --run-folder --checkpoint-choice` | Preserve as one old-folder adapter; new grammar uses Run ID and `checkpoints answer` |
| Other resume execution flags | Preserve current validation, including flags forbidden on resume |
| `handoff save|resume|done|brief|hook|harvest` and `handoff hooks install|uninstall|doctor` | Preserve behavior; move roots and output behind shared contracts; hook leaves add optional `--installation <id>` for explicit owner selection and use `HostHookWriteTxnV1` |
| Handoff `--host`, `--goal`, `--next`, `--state-markdown`, `--debt-markdown`, `--run-folder`, `--control-plane`, `--project-root`, `--hooks-file`, `--launcher`, `--record-id`, `--created-at`, `--transcript-path`, `--session-id`, `--session-source`, `--source`, `--clear-ambient`, `--progress`, `--json` | Preserve; label hook-only flags as host-internal |
| `history rebuild --json --runs-base --index-dir` | Preserve |
| `history query <query...> --json --format --limit --per-run-limit --runs-base --index-dir --flow --kind --rebuild-if-stale` | Preserve in the v1 adapter; migrate projection use of `--format` as described above; native v2 maps `--limit` plus new `--after` to `PageSelectionV2` |
| `history pull <query...> --json --flow --decision-point --run-folder --limit --per-run-limit --runs-base --index-dir --rebuild-if-stale` | Preserve in the v1 adapter; resolve folder through Run identity when possible; native v2 maps `--limit` plus new `--after` to `PageSelectionV2` |
| `history status --json --runs-base --index-dir` | Preserve |
| `history memory-merge --json --runs-base --index-dir --write` | Preserve |
| `history memory-effect --json --runs-base --index-dir --write --min-arm-size --margin` | Preserve |
| `memory note <text...> --flow --applies-to --json --runs-base --memory-dir --run-folder` | Preserve |
| `memory list --flow --json --runs-base --memory-dir`; `memory forget <id> --json --runs-base --memory-dir` | Preserve the v1 adapter; native-v2 list adds `PageSelectionV2`, while forget remains finite |
| `create --name --description --home --created-at --publish --yes --decompose --progress` | Move draft creation to `flows create`; keep the top-level adapter byte-compatible, but native publication uses the returned immutable draft ID with digest-confirmed `flows promote --draft <draft-id>` |
| Host-injected `create --template-flow-root` | Cached top-level adapter accepts and ignores; remove launcher injection; never forward to `flows create` |
| `generate --description --name --home --created-at --publish --yes --max-repair --timeout-ms --progress` | Release N warns; N+1 routes model spend and draft writes through the planned internal authoring Run, keeps a final v1 projection adapter, and moves publication to the returned immutable draft ID with digest-confirmed `flows promote --draft <draft-id>`; the new pre-spend action boundary is an intentional safety break, not silent compatibility |
| `runs show --json --run-folder` | Preserve adapter; new grammar accepts Run ID |
| `reclaim --json --project-root` | Move to `runs reclaim`; keep top-level adapter |
| `checkpoints --json --project-root --runs-base` | Move to `checkpoints list`; keep no-subcommand adapter |
| `preview [flow] --power --matrix --json` | Preserve no-flag, single-Power, Matrix, and JSON behavior; deliberately reject the formerly ignored `--matrix --power` pair and Matrix without a Flow |
| `doctor --json` | Preserve; add mutually exclusive `--flow` and `--plan` |
| `config show --json`; `config set <key> <value>` and `config unset <key>` with `--project|--global` | Preserve; new names may alias scopes but cannot change these meanings |
| `version --json` | Preserve; add protocol, runtime digest, transport, and installation ID |
| `uninstall --dir --json` | Preserve exactly as the project-instructions-detach adapter; never reuse this spelling for application removal |
| `-h`, `--help` | Keep at every level, exit 0, include examples and the shared options accepted by that command |

No adapter silently drops a flag. It preserves behavior, translates visibly,
or rejects with the exact replacement command.

## Human terminal experience

After the parity cutover, bare `circuit` is a fast home screen. It prints the
project root, connector readiness, active or parked Runs, and a few next
actions. The current Ink configuration shell remains reachable as
`circuit configure`; bare TTY input keeps opening it until the new home has
equivalent navigation and a tested migration message. The home never becomes a
full-screen application.

`watch` owns the full-screen TUI. Its layout is a fixed header plus a scrollable
milestone list and detail drawer. At 100 columns by 24 rows or larger it uses
the full layout. From 80 through 99 columns with at least 24 rows it uses a
compact one-list TUI. Below 80 columns or 24 rows it uses append-only human line
mode. `--screen-reader` and `TERM=dumb` also force line mode; explicit
`--format plain` and a noninteractive human pipe use plain mode. `NO_COLOR`
changes none of these choices.

A resize below the active threshold switches to line mode without losing the
current prompt token, selected item, feed cursor, or typed input. While a prompt
is active, layout is latched in line mode until that prompt closes; a later
prompt chooses from the then-current size. With no prompt active, layout may
switch full/compact/line in either direction only after a complete decoded frame
and render commit. Returning to TUI redraws from the bounded local cache and
does not re-emit feed data; returning to line mode appends one transition
summary. The exact 79/80/99/100-column and 23/24-row boundaries are golden PTY
fixtures both idle and during every prompt.

The footer shows actions that work in the current state:

```text
[q] detach  [/] filter  [Enter] details  [?] help
```

It adds only currently legal controls: `[c] cancel` for a live controllable
tree, `[a] answer` at a waiting checkpoint, `[d] drain options` while a
checkpoint drains, and `[r] reconcile` when exact effect decisions are needed.
`a`, `d`, and `r` open numbered, text-labeled choices with the same tokens and
CAS as their public commands. No action is discoverable only by a hidden key.

Arrow keys and `j`/`k` navigate. `Esc` closes a drawer. Color reinforces text
and symbols but never carries status alone.

| Input | Attached `run`/`resume` | `watch` | `wait` | In-place foreground |
| --- | --- | --- | --- | --- |
| `q` | Detach viewer; Run continues; exit 0 | Detach viewer; exit 0 | Disabled; wait must report outcome | Disabled |
| `c` | Confirm graceful cancellation | Confirm graceful cancellation for the watched root | Disabled; use `cancel` separately | Confirm graceful cancellation |
| First Ctrl-C | Open cancel, detach, or continue | Restore terminal; exit 130 | Exit local wait 130; Run continues | Open cancel confirmation |
| Second Ctrl-C | While the menu is open, restore terminal and exit viewer 130; Run continues | Not applicable after the first-interrupt exit | Not applicable after the first-interrupt exit | Exit 130; Run may become interrupted |
| SIGHUP on Unix | Restore and detach; exit 129; Run continues | Same | Exit local wait 129; Run continues | Forward SIGHUP; Run may become interrupted |
| Ctrl-Z on Unix | Restore, suspend, redraw; worker continues | Same | Same | Trapped as unsupported; cancel or let the foreground Run finish |
| Ctrl-\ on Unix | Restore terminal; exit viewer 131; Run continues | Same | Same | Forward SIGQUIT; Run may become interrupted |
| SIGTERM | Restore and detach; exit 143; Run continues | Same | Exit local wait 143; Run continues | Forward SIGTERM; Run may become interrupted |

Windows help omits Unix-only controls. `NO_COLOR` keeps controls without color.
In JSON or NDJSON there is no signal menu: the first caught signal emits the
one `CLIENT_INTERRUPTED` ending, includes last cursor and whether the durable
Run continues, restores local resources, and exits 129/130/131/143 as
applicable. Human/plain print the same facts. `SIGHUP` and `SIGTERM` take the
non-prompting detach/forward path defined above. The second caught TTY interrupt
uses that same one-second bounded ending; only uncatchable termination and
output-channel failure may truncate it. Further catchable signals stay masked
during that ending.
Human rendering has four input modes:

| Mode | Selection | Input contract |
| --- | --- | --- |
| `tui` | Controlling TTY at least 100x24; compact one-list TUI at 80-99x24+ | Single-key controls above |
| `line` | `--screen-reader`, `TERM=dumb`, below 80 columns, or below 24 rows | Append-only numbered choices and typed words |
| `plain` | Explicit plain format or noninteractive human pipe | Never prompts; action-required exits 3 |
| `machine` | JSON or NDJSON | Never prompts; typed frames only |

Attached `run`, `resume`, and `watch` share one state-by-state viewer action
model:

| Run state | TUI | Line mode | Public command |
| --- | --- | --- | --- |
| `queued`, `running` | `c` then confirmation | `cancel`, then `confirm cancel` | `circuit cancel <root-run-id>` |
| `checkpoint_pending` | `d` for wait/cancel/force remedies | `drain <wait|cancel>`; force prints the confirm action, then the non-bearer decision-ID command | `circuit checkpoints drain ...` |
| `waiting_checkpoint` | `a`, then number or choice ID; `c` also available | `answer <number|choice-id>`; `cancel` also available | `circuit checkpoints answer ...` |
| `reconciliation_required` | `r` opens each unresolved effect, evidence requirements, and safe choices; file-backed choices print the complete command | `reconcile <effect-number>` shows the same requirements and command | `circuit reconcile ...` |
| `apply_recovery_required` | `r` shows the drift inventory and three repair strategies; no one-key overwrite | `repair apply` prints the exact two-step plan command | `circuit applies repair plan ...` |
| terminal | No mutating key | No mutating word | Read/report or plan later Apply |

`watch` remains a viewer for exit semantics, but an authenticated viewer may
send these explicit controls. Its exit never changes to the Run outcome.

Line mode accepts `detach`, `cancel`, `continue`, `details <number>`, `filter
<text>`, `answer <number|choice-id>`, `drain <wait|cancel>`, `reconcile
<effect-number>`, and `help`, and prints the public-command
equivalent beside each. A checkpoint prints numbered choices plus the complete
token-bound `checkpoints answer` command. `answer` uses the exact hidden
`DecisionTokenV1` and boundary already displayed by the viewer and enters the
same compare-and-swap as the public command. A stale answer prints the current
action and makes no change. `cancel` opens a line prompt that accepts only
`confirm cancel` or `continue`; force remains an explicit public command. Every
TUI action has a line-mode equivalent, and every action that changes Run state
has a public-command equivalent. `wait` remains outcome-only in every mode.
Choosing Continue in an active cancel menu returns to the viewer with no exit.
Inline selection is available only when the action has no uncollected file or
reference input. TUI and line mode both show the typed requirement and exact
public command otherwise; neither silently offers less evidence than machine or
host clients.

PTY acceptance covers `--screen-reader`, `TERM=dumb`, 79/80/99/100 columns,
23/24 rows,
competing checkpoint answers, resize during a prompt, EOF, every supported
SIGHUP/SIGINT/SIGQUIT/SIGTERM path, and terminal restoration. The line
transcript must contain enough text to operate without
color, cursor position, or timing.

The viewer shows durable milestones and transient health. It does not show raw
tool calls or relay tokens. A quiet worker shows last activity, the current
step's policy limit, and whether the supervisor can reach it.

## Setup, configuration, and secrets

### Setup and init

`circuit setup` handles personal machine readiness through `check`, `plan`,
`apply --plan`, and `rollback <receipt>`. With no subcommand it always means
`setup check`; TTY changes rendering only. Old `--check` and
`--apply --yes` spellings remain adapters through Phase 8. Host and repeatable
connector selectors narrow the probes, which use three seconds each and ten
seconds overall by default. Independent probes run concurrently under the
overall deadline.

`SetupPlanV1` lists every Circuit-owned operation, target path or registration,
before and after digests, required authority, backup, and reversibility. It
contains no secret. A proposed `UserRootRelocationTxnV1` appears as an explicit
operation; setup never relocates roots merely because the current XDG variables
differ. Connector install and login remain external remedies.

Root flags on `setup plan` are explicit desired targets. Omitted roots stay
unchanged. `--bootstrap-root` is legal only before the fixed discovery slot
commits its first root set and is consumed by `InstallRegistrationTxnV1`;
the bootstrap anchor is intentionally non-relocatable afterward. Moving it
requires uninstall/purge with no authority left, then a fresh verified install.
Config/state/data/cache changes use the relocation transaction and its complete
byte inventory.
`apply` rechecks the plan and before-state digests, journals and syncs each
operation, and rolls completed reversible operations back in reverse order on
failure. Any irreversible residue is named plainly. Success writes an immutable
receipt. `rollback` previews the exact inverse, refuses to overwrite later user
changes, and writes its own receipt. `--yes` confirms only the displayed plan
or rollback digest and is valid only beside the matching `--confirm` value.

Direct setup checks the fixed discovery slot and registration receipt, active
runtime, per-user activation adapter, PATH, completion, and connectors selected
by the chosen Flows. Host setup checks the same slot, adapter, runtime pin,
activation path, and host-manager
registration. Every failure gives the exact PATH, login,
host-manager, or config remedy. Circuit never installs or logs into a third-
party connector without a separate confirmation. Healthy setup writes nothing
to config or persistent setup state, stores no plan, and never creates project
config.

`circuit init` handles project intent. It prints the resolved project root and
creates `InitPlanV1` with every target byte, path, file identity, and change
digest before confirmation. A machine call gets `confirm_init`; a controlling
human TTY may confirm the displayed plan inline. The confirmed call rechecks an
empty example directory and every before-state digest. `--here` creates a nested
project anchor. `--example first-fix --path <empty-dir>` materializes the
checked-in real first-run project described in the acceptance gate; it does not
simulate a Run.

Bare `circuit init` resolves the normal project root and previews exactly one
file, `.circuit/config.yaml`, with these canonical bytes:

```yaml
schema_version: 3
```

The byte sequence is UTF-8 `schema_version: 3\n`; POSIX mode is `0644` subject
to a stricter existing umask, and Windows inherits the project directory ACL.
If `.circuit/` is absent, its directory creation and mode/ACL are also in the
confirmed plan; no other path is created.

That empty v3 document changes no effective default; explicit `init` is the
operator's intentional saved project anchor, while setup and ordinary healthy
use remain zero-write. It does not edit `.gitignore`, create trust or Run
folders, configure connectors, or enroll legacy Run storage. An existing valid
empty v3 file returns `no_change` without confirmation. A v1/v2 file returns
the exact migration-plan remedy. Invalid or nonempty existing config is never
replaced: valid v3 returns the existing-project result, and invalid content
exits 1 with validate/edit remedies.

Normal resolution chooses the nearest configured project or Git root;
`--here` deliberately uses canonical cwd instead. Example mode uses only its
new empty `--path`. `--project-root` conflicts with `--here` and example mode,
and `--here` conflicts with example mode, before any filesystem mutation.

The init result always carries typed `project_root`, `next_cwd`, created-path
hashes, and fixed-argv next actions that include `--project-root <created-root>`.
`next_cwd` is a human convenience, not ambient authority; hosts and the
acceptance harness use the explicit root on Preview, plan, and Run.

The packaged `first-fix` example is an offline, hash-versioned tiny repository
with one failing test and the fixed goal text: “Fix `slugify()` so repeated
whitespace becomes one hyphen and make the included tests pass.” Its manifest
records the measured release-specific spend band, hard `max_cost_usd`, and hard
`max_active_wall_time_ms`; the latter cannot exceed five minutes. The gate does not
ship until clean-machine measurements populate those fields and the release
connector proves worst-case cost reservation plus the armed deadline guardian.
If no connector can bound USD cost, the example cannot advertise or ship that
field merely from an estimate. The path runs the
real Fix Flow and real chosen connector, then shows the ordinary spend receipt.

Personal setup and `configure` cannot grant project authority. Persistent
project preference trust and custom-connector grants use explicit `project
trust show|plan|apply|revoke`. The trust plan shows the project instance, every
path/value digest, connector command, effective filesystem/network access,
environment allow-list, and secret-handle identity. A healthy trust check writes
nothing. Preference trust is a private receipt; a custom-connector project grant
remains a user-config entry. A trust plan that changes both uses the same
two-store transaction and blocks use between phases.

`doctor --flow <flow>` grades the set that Flow would select.
`doctor --plan <plan-id>` grades the exact hash-bound chosen set. With neither,
it labels the public default set as required and other probes as informational.

`config edit` resolves `$VISUAL`, then `$EDITOR`, then `notepad.exe` on Windows
or `vi` on macOS and Linux. It edits a temporary copy, validates it, and only
then replaces the real file. A failed editor leaves the original untouched and
prints an exact override. Interactive connector and Power pickers live in
`setup` or `configure`, not in the editor command.

Every ordinary config mutation uses `ConfigWriteTxnV1`. It opens the source
no-follow and captures file identity plus `source_bytes_sha256` (or proved
absence), edits the YAML concrete-syntax tree so comments, ordering, quoting,
and unrelated formatting survive, strictly validates the complete ConfigV3,
and writes a same-directory private temporary file with the intended mode. It
syncs that file, takes the source-specific Circuit config lock, reopens the
source, and compares its original identity and byte hash before atomic
replacement and parent-directory sync. A source changed before that final
check returns `CONFIG_CONFLICT` with show/diff/retry remedies and overwrites
nothing. The transaction retains a byte-exact recoverable backup and receipt;
startup finishes an exact committed replace or removes the temp. `config edit`
uses the same lock and check after the editor exits, so concurrent Circuit
`set`, `unset`, and `edit` operations cannot silently lose one another.

That lock is advisory to code outside Circuit. On platforms without a proved
conditional-replace or deny-write adapter, Circuit does not claim to preserve
an editor write that races after the final check. Human output warns when the
source is also open for direct editing; recovery accepts only the expected
preimage or committed postimage and otherwise returns `CONFIG_CONFLICT`. A
stronger profile is advertised only when the platform adapter enforces it.

Its `prepared -> replaced -> committed` journal lives in a Circuit-owned
no-follow transaction directory beside the target so temp, backup, replacement,
and directory sync share one filesystem. The config lock remains held from the
final recheck through replacement and directory sync. Ordinary config writes
take no private user-store lock. A write that also changes private trust uses the named
two-store transaction: prepare config bytes, release its file lock, prepare
private authority, commit the config hash, then commit the matching private
receipt with deterministic recovery.

`config set` value parsing is explicit. The positional form consumes one
complete YAML 1.2 JSON-compatible value: `high` is a string, `true` a boolean,
`3` a number, and arrays/objects use flow YAML or JSON syntax. Custom tags,
aliases, timestamps, non-JSON numbers, trailing documents, and implicit null are
rejected. `--string <text>` forces a string; `--value-file <path-or->` reads one
structured value without shell escaping. The three forms are mutually
exclusive. Help shows examples for scalar, array, object, and a string that
looks like a boolean.

### Config v3

`src/schemas/config-v3.ts` owns new strict container types. It may reuse leaf
validators such as IDs, model, effort, Power, and Flow IDs. It must not reuse
Config v1 or Policy v2 containers because their defaults erase the difference
between no opinion and an explicit value.

```ts
type ConnectorReferenceV3 =
  | { kind: 'builtin'; name: EnabledConnector }
  | { kind: 'named'; name: ConnectorName };

type SelectionOpinionV3 = {
  model?: ProviderScopedModel;
  effort?: Effort;
  depth?: 'low' | 'medium' | 'high' | 'tournament' | 'autonomous';
  skills?:
    | { mode: 'inherit' }
    | { mode: 'replace' | 'append' | 'remove'; skills: SkillId[] };
  invocation_options?: JsonObject;
};

type SkillHookConfigV3 = {
  policy?: Partial<Record<SkillHookName, {
    mode?: 'auto' | 'mute'; skills?: SkillId[]; strict?: boolean }>>;
  detection?: { disabled_patterns?: Partial<
    Record<SkillHookName, NonEmptyString[]>> };
};

type FlowVariantModelsV3 = [FlowVariantV3, FlowVariantV3,
  ...FlowVariantV3[]]; // schema caps length at four
type FlowVariantV3 = { id: VariantId; label: NonEmptyString;
  connector?: ConnectorReferenceV3; selection: SelectionOpinionV3 & {
    model: ProviderScopedModel; effort: Effort } };

type PreferencesV3 = {
  project_id?: ProjectId;
  host?: { kind: 'generic-shell' | 'claude-code' | 'codex' };
  relay?: {
    default?: 'auto' | ConnectorReferenceV3;
    roles?: Partial<Record<RelayRole, ConnectorReferenceV3>>;
    flows?: Partial<Record<FlowId, ConnectorReferenceV3>>;
  };
  selection?: {
    default?: SelectionOpinionV3;
    flows?: Partial<Record<FlowId, SelectionOpinionV3>>;
  };
  power?: {
    setting?: 'auto' | 'low' | 'medium' | 'high';
    auto_bounds?: { floor?: Power; ceiling?: Power };
    tiers?: Partial<Record<ConnectorName,
      Partial<Record<Power, { model?: ProviderScopedModel; effort?: Effort }>>>>;
  };
  skills?: {
    bindings?: Partial<Record<SkillSlotId, SkillId>>;
    flow_bindings?: Partial<Record<FlowId,
      Partial<Record<SkillSlotId, SkillId>>>>;
    hooks?: SkillHookConfigV3;
  };
  prototype?: {
    variant_models?: Partial<Record<FlowId, FlowVariantModelsV3>>;
  };
};

type ProviderQuotaCapV3 = { provider: Provider;
  quota: BoundedDisplayStringV2<128>; max_units: PositiveInteger };
type BudgetPolicyV3 = {
  max_physical_attempts?: PositiveInteger;
  max_relay_calls?: PositiveInteger;
  max_input_tokens?: PositiveInteger;
  max_output_tokens?: PositiveInteger;
  max_total_tokens?: PositiveInteger;
  max_active_wall_time_ms?: PositiveInteger;
  max_cost_usd?: ExactDecimalUsdV1;
  provider_quotas?: NonEmptyBoundedArrayV2<ProviderQuotaCapV3, 32>;
};
type BudgetApprovalThresholdsV3 = {
  relay_calls?: PositiveInteger; total_tokens?: PositiveInteger;
  active_wall_time_ms?: PositiveInteger; cost_usd?: ExactDecimalUsdV1;
};

type PolicyV3 = {
  rules?: {
    connectors?: { allow?: ConnectorName[]; deny?: ConnectorName[];
      deny_for_write?: ConnectorName[] };
    models?: { deny_providers?: Provider[];
      require_provider_for_connector?: Partial<Record<ConnectorName, Provider>> };
    writes?: { auto_apply?: boolean; require_checkpoint_globs?: string[] };
    skills?: { deny?: SkillId[] };
    proof?: { minimum_profile?: 'standard' | 'strict';
      require_independent_review_for?: string[] };
  };
  limits?: { max_attempts_per_step?: PositiveInteger;
    max_effort?: Effort; max_tournament_n?: PositiveInteger;
    budget?: BudgetPolicyV3;
    approval_thresholds?: BudgetApprovalThresholdsV3 };
};

type SecretHandleV3 =
  | { kind: 'environment'; variable: EnvName }
  | { kind: 'credential-store';
      provider: 'macos-keychain' | 'windows-credential-manager' | 'secret-service';
      service: NonEmptyString; account: NonEmptyString };

type ConnectorEntrypointV3 =
  | { kind: 'native'; executable: AbsolutePath; fixed_args?: NonEmptyString[] }
  | { kind: 'script'; interpreter: AbsolutePath; script: AbsolutePath;
      fixed_args?: NonEmptyString[] }
  | { kind: 'managed'; manager: 'homebrew' | 'winget' | 'npm';
      package_id: NonEmptyString; version: NonEmptyString;
      package_sha256: Sha256; executable: AbsolutePath;
      fixed_args?: NonEmptyString[] };

type ConnectorDefinitionV3 = {
  entrypoint: ConnectorEntrypointV3;
  working_directory: 'workspace';
  prompt_transport: 'prompt-file';
  output: { kind: 'output-file' };
  capabilities: {
    requested_filesystem: 'workspace-read' | 'workspace-write';
    requested_network: 'none' | 'unrestricted';
    structured_output: 'json';
    tool_scope: 'none';
  };
  inherit_env?: EnvName[];
  secret_env?: Partial<Record<EnvName, SecretHandleId>>;
};

type ProjectConnectorGrantV3 = { project_instance_id: ProjectInstanceId;
  connector: ConnectorName; connector_sha256: Sha256;
  secret_binding_sha256: Sha256;
  executable_closure_sha256: Sha256 };

type ConfigV3 = { schema_version: 3; preferences?: PreferencesV3;
  policy?: PolicyV3; connectors?: {
    definitions?: Partial<Record<ConnectorName, ConnectorDefinitionV3>>;
    secret_handles?: Partial<Record<SecretHandleId, SecretHandleV3>>;
    project_grants?: Partial<Record<GrantId, ProjectConnectorGrantV3>>;
  } };
```

Every object is strict. Records reject prototype keys; IDs use canonical slug
validators; set-like lists reject duplicates. A Power tier needs model or
effort, bounds cannot invert, variant arrays contain two to four unique IDs and
each supplies model and effort, and invocation options recursively reject
authority-shaped keys. An explicit hook rule defaults mode to auto and strict
to false; auto needs nonempty unique skills, while mute forbids skills. Hook
names and disabled patterns use the current validators. Connector entrypoints
use absolute paths and fixed argv, never shell text or ambient PATH lookup.

Budget caps and approval thresholds are different reducers. Every hard cap
reduces by the minimum applicable shipped/user/project/invocation value;
project and invocation sources may tighten but never raise a user cap.
Provider-quota keys reduce independently after platform-aware normalization.
Approval thresholds also reduce by minimum, but crossing one creates a named
approval ID rather than changing the enforcement cap. `RunPlanV1` records every
requested and effective cap, source/trust ledger, threshold-generated approval,
pricing/capability proof, and worst-case reservation. A `max_cost_usd` request
without pinned pricing and connector-enforced request/token bounds fails
planning as `BUDGET_UNENFORCEABLE`; it never silently becomes an estimate.
Pricing, connector-capability, or quota-schema drift invalidates the plan before
acceptance. `config explain policy.limits...` shows these reducers like every
other value.

`CircuitReservedEnvironmentSetV1` versions every fixed worker, broker, control,
and runtime environment name. Connector validation requires unique
`inherit_env`, keys disjoint from `secret_env`, and both sets disjoint from the
reserved set. Environment-name identity is ASCII case-insensitive on Windows
and case-sensitive on POSIX; names are normalized under that rule before
connector, secret-binding, and grant digests are calculated. A legacy collision
has migration disposition `manual`; migration never chooses a winner. Worker
environment assembly has no precedence rule because conflicting inputs are
invalid. Validation runs before trust planning and repeats at plan, accepted
start, and spawn before any secret capture or release.
Environment names match `^[A-Za-z_][A-Za-z0-9_]*$`. Named connectors, secret
handles, skills, and grant targets must close in their permitted source. Flow
map keys need a syntactically valid stable Flow ID but need not be installed at
parse or migration time. An unresolved Flow entry stays inactive and becomes
eligible automatically when that exact Flow appears. Selecting it while absent
fails `FLOW_UNAVAILABLE` with the configured sources and install/generate
remedies; it does not invalidate unrelated config. YAML duplicate keys, custom tags, non-JSON scalars, and
unbounded aliases are rejected. Null is rejected; absence is the only no-op.

A custom definition declares what filesystem access it requests; it does not
certify what Circuit can enforce. The resolved connector capability records the
request, the isolation-adapter digest, the effective
`workspace-read|workspace-write` grant, effective `none|unrestricted` network,
and `enforcement: enforced|trusted-in-place`. Only the platform adapter can
produce `enforced`. A plan hashes that resolved capability. Unrestricted
network is an external-side-effect boundary. Built-ins may use a signed broker
or adapter with a narrower provider-only network route and larger typed tool
protocol. Custom connectors remain `tool_scope: none` until Circuit has an
adapter protocol that can enforce a tool allow-list. This means Circuit grants
no separate tool broker; it does not pretend to understand a custom binary's
internal actions. A read-only or network-limited label is never inferred from
connector claims.

Parsing a user or project v3 file injects no opinions. Minimal
`{schema_version: 3}` is empty. Shipped config supplies relay `auto`; effective
Power remains `medium`, matching current zero-config behavior. `auto` applies
only when explicitly selected. Migrating absent v1 `defaults.power` leaves the
v3 setting absent; migrated auto bounds remain inert until auto wins.

### Layer algebra

Source order is shipped, user, project, then invocation. Authority validation
runs before reduction. Rejected opinions stay visible in the explanation
ledger but cannot affect the result. Schematic selection retains shipped,
user, project, Flow, stage, step, invocation order; relay category order remains
explicit invocation, role, Flow, default, auto.

| Exact path family | Reducer |
| --- | --- |
| `project_id`, `host`, `relay.default`, `power.setting`, each auto bound | Rightmost present accepted value |
| Relay maps, skill bindings, Flow bindings | Rightmost present accepted value per final key |
| Selection model, effort, depth | Rightmost present accepted value per field |
| Selection skills | Apply explicit inherit, replace, append, or remove in order |
| Selection invocation options | Authority-key rejection, then right-biased merge per JSON key |
| Power connector/tier model or effort | Rightmost present accepted value per final field |
| Prototype variants per Flow | Replace complete array |
| Skill Hook per hook name | Replace complete rule |
| Connector allow-list | Intersection; absence means universe |
| Denials and checkpoint/review requirements | Set union |
| Provider requirement per connector | All values agree or planning fails |
| `auto_apply` | Any false wins; true only from shipped or user authority |
| Numeric upper limits | Minimum |
| Maximum effort | Lowest cap |
| Minimum proof profile | Strict wins over standard |
| Connector definitions, handles, grants | Shipped built-ins plus user only; duplicate names must be byte-equivalent |

Every new key must add its reducer and source-authority row before it can ship.
A conflict fails before RunPlanV1. `config explain <key>` shows every opinion,
origin, trust decision, reducer, and result; some restrictive results have no
single winner.

Set arrays sort by canonical ID and maps by key. Canonical JSON is UTF-8 with
normalized numbers and no insignificant whitespace. Circuit records:

- `source_bytes_sha256` for compare-and-swap, backup, and concurrent-edit
  detection;
- `source_semantic_sha256` for one parsed layer, so comments do not cause plan
  drift;
- `config_resolution_sha256` over schema version, project instance, ordered
  source scopes and semantic digests, accepted and rejected paths, and the
  reduced value.

RunPlanV1 binds the resolution hash. Connector and secret-binding hashes are
separate; the latter contains handle IDs and provider metadata, never values or
availability.
`ConnectorExecutableClosureV1` resolves the entrypoint without ambient PATH and
records every native executable, interpreter, script, managed-package, and
symlink-chain component by canonical no-follow path, file identity, content or
publisher-signature digest, package/version identity, mode, and resolution
order. `connector_sha256` covers that closure digest, fixed argv,
prompt/output contracts, capabilities, working-directory policy, and sorted
inherited environment names. `secret_binding_sha256` covers sorted
environment target, handle ID, handle kind/provider/service/account metadata.
Changing either invalidates every grant that names it.

### Source authority and secrets

Authority is decided per path before layer reduction:

| Exact path family | Shipped and user | Project | Invocation |
| --- | --- | --- | --- |
| `preferences.project_id` | Rejected | Accepted as display provenance only | Rejected |
| `preferences.host` | Shipped/user accepted | Accepted as display and host hint only | Rejected |
| `preferences.relay.*`, `selection.*`, `power.*`, `skills.*`, `prototype.*` | Accepted | Accepted only by a matching persistent trust receipt or a named Run-scoped approval | Accepted only when explicitly supplied by the caller and named in that Run's approval |
| `policy.*` | Accepted | Accepted only where the reduced result is equally or more restrictive | Accepted only where equally or more restrictive |
| Connector definitions, handles, and grants | Shipped built-ins or user | Rejected | Rejected |

Every accepted project or invocation preference remains bounded by the reduced
user policy. A goal string, project file, host transcript, or connector output
never carries invocation authority. An untrusted project preference remains in
the explanation ledger but cannot silently win.

Persistent trust is a private `ProjectPreferenceTrustV1` receipt containing the
project instance ID, project `source_semantic_sha256`, and the exact allowed
path/value digests. Any changed source digest, path, or value invalidates it.
`project trust plan/apply` may create this receipt only after showing each
resulting value and capability. Run-scoped trust is stored only in the private
accepted-Run receipt; it binds the project config digest, resolved path/value
digests, `plan_artifact_sha256`, and the named approval IDs. `run --plan ...
--yes` may grant those exact Run-scoped approvals but cannot create persistent
trust; only explicit `project trust apply --plan ... --confirm ... --yes` can. `config
explain` shows the receipt or Run approval responsible for every accepted
project or invocation value.

`preferences.project_id` is a display/provenance label and grants no trust.
Connector definitions, handles, and grants are legal only in user scope apart
from shipped built-ins.
Private user state holds `ProjectInstanceV1`: a random 256-bit instance ID,
canonical absolute root, creation time, and root file identity. POSIX identity
is device plus inode; Windows identity is volume serial plus file ID. Lookup
requires both canonical root bytes and file identity. Copying, recreating,
cross-filesystem moving, or replacing a checkout creates a new instance, and
grants never transfer automatically. A same-identity rename/move may preserve
the instance only through explicit project relocation below. RunPlanV1,
acceptance receipt, config digest, grant, generation marker, and lease all name
that same instance.

`project relocate plan --instance <project-instance-id> --to <path>` handles an
already moved same-identity root. `ProjectRelocationPlanV1` proves the new
canonical no-follow path has the exact recorded root file identity, the old path
is absent or the same object, no Invocation/effect/containment is live or
ownership-unknown, and one relocation fence blocks scheduling, planning,
config/trust writes, Apply, prune, and overlapping-domain merge. Queued,
parked, interrupted, and terminal Runs remain referenced but start no worker.
The plan inventories marker/private-mirror bytes, Run/plan locators,
mutation-domain alias, project-scoped Flow entries and projections, config/trust
receipts, and every path-sensitive connector grant. It also freezes old/new
ancestry inventories, every overlapping project/root identity, affected alias
IDs/generations/barriers, active holders and Apply blocks, a domain-closure
hash, and `domain_disposition: unchanged|merge_required|
conservative_existing_merge`.

An overlap-changing move cannot rewrite one alias by itself. `merge_required`
composes the relocation with `MutationDomainMergeTxnV1`: fence every affected
alias, acquire barriers in canonical order, drain holders, reject any active
`MutationDomainBlockV1`, and publish one merged generation plus permanent
redirects. Moving out of a previously merged domain remains conservatively in
that domain in v1; this plan does not invent an unsafe split transaction.

Confirmed `ProjectRelocationTxnV1` commits
`relocation_and_domains_fenced -> domain_prepared -> private_prepared ->
marker_rebound -> domain_published -> locators_rebound -> projections_rebuilt
-> private_committed -> fence_released`. The private commit atomically binds the
new canonical root and final domain mapping; clients remain fenced between
domain publication and that commit. It preserves the project instance ID,
uses relative evidence paths without rewriting Trace, updates the canonical
root/marker/private mirror and mutation alias atomically across stores, and
rebuilds project projections. Path-insensitive trust remains; every grant or
config input whose executable, secret, policy, or path closure changed is
revoked and returned as a separate trust-plan action. Recovery completes or
aborts to the exact old root/domain binding only before `domain_published`.
`domain_published` is irreversible: at or after it, permanent merge redirects
stay published and recovery rolls marker, locators, projections, and private
root binding forward to the new root before releasing any fence. Response loss returns
the same receipt. A different file identity cannot use relocation and must use
copy/adoption rules; a copied nonterminal Run never becomes resumable merely
because its bytes match.

A named custom connector may run only when the winning choice came from user
config or user config contains a grant bound to project instance, connector
digest, secret-binding digest, and `ConnectorExecutableClosureV1` digest.
`project trust plan/apply` creates one only after showing the project, every
resolved executable/interpreter/script/package identity and hash, fixed argv,
effective filesystem and network access, environment allow-list, and handle
identities. Run `--yes` cannot create persistent trust.

The closure is re-proved at planning, accepted start, and every spawn. A byte,
identity, symlink, interpreter, package, or resolution change invalidates the
grant and requires a new trust plan. To close the final check-to-exec race, the
effect executes an immutable Run-owned copy or an already-open platform handle
whose identity matches the closure; it never reopens the mutable source path
after secrets are released. Project-local tools are legal only under this exact
regrant-on-change behavior.

Shipped connectors use signed `BuiltInConnectorManifestV1` entries in the
runtime manifest. Each binds its executable/interpreter closure policy, fixed
environment, capabilities, and publisher digest. A built-in cannot fall back
to PATH or inherit undeclared environment merely because it ships with Circuit.

Custom definitions extend the current descriptor with a closed inherited-
environment list and fixed `ENV_NAME: secret-handle-id` bindings. A secret
handle is a strict reference to environment, macOS Keychain, Windows Credential
Manager, or freedesktop Secret Service. Config never stores the value. Project
and invocation config cannot create a handle, change a binding, or select a
custom connector without an exact user-owned grant.

Detached execution never reads the supervisor's ambient environment.
`EnvironmentSnapshotV1` captures every declared non-secret `inherit_env` value
during `PlanTxnV1`: name, present/absent state, byte length and keyed value
commitment, one encrypted private-content reference, and a snapshot digest.
Plan and connector identity bind that digest, while public artifacts expose no
value or reusable unsalted hash. Every Invocation receives the exact captured
bytes through a sealed inherited handle. A changed shell environment after
planning is irrelevant; missing required material fails planning with
`ENVIRONMENT_UNAVAILABLE`.

An environment-backed secret is captured once during accepted start through
`RunSecretMaterialTxnV1`, before StartTicket consumption. `SecretMaterialOfferV1`
travels over the authenticated connection-bound side channel; the private
receipt stores only handle/value commitments and an OS-key-encrypted content
reference bound to Run and ticket. Every later Invocation receives those same
bytes. A changed offer changes the acceptance identity and requires abandoning
the ticket. Credential-store handles remain late-bound by provider/service/
account so rotation under the same identity is allowed.

The transaction stages encrypted bytes under the ticket, commits a prepared
record binding plan, ticket, caller, handle set, value commitments, and start
idempotency identity, then joins the acceptance CAS. If acceptance wins, its
references transfer to the new Run before queue acknowledgement. If the client
or supervisor dies first, the same ticket plus commitments resumes the prepared
record; different commitments conflict. Decline, abandon, or ticket expiry
closes the record and releases its encrypted content only after no acceptance
can still win. A Run can therefore neither consume ambient replacement values
nor exist without the exact secret-material receipt.

Platforms or hosts that cannot seal and broker environment secret material may
use only a declared foreground-only plan or a credential-store handle; durable
detach fails before ticket consumption with the exact setup remedy. Raw
environment/secret bytes never enter argv, project plans, Trace, feed, export,
debug, or ordinary RPC fields. Private sealed references remain through Run
cleanup/prune and participate in backup, scrubbing, and reference GC.

The worker passes only fixed Circuit variables, named inherited variables, and
resolved bindings. It no longer gives custom connectors the whole environment.
RunPlanV1 hashes connector, grant, binding, provider, handle identity, and the
non-secret environment snapshot commitment. It does not expose secret values.
The worker uses accepted sealed environment material and rechecks credential-
store availability immediately before spawn. Missing credential material is an
actionable start error, not plan drift. Scrubbing covers stdout, stderr, Trace, feed, reports, plans, debug,
and crash logs. See the current unsafe inheritance boundary in
[custom connector execution](../../src/connectors/custom.ts).

### Config migration

Migration transforms each source layer separately; it never flattens effective
config first.

`LegacyConfigProjectionV1` parses the raw YAML syntax tree before schema
defaults are injected and records, for every field, source presence, raw value,
legacy semantic role, and `moved|omitted_legacy_noop|inactive|manual|rejected`
disposition. V1 `relay.default: auto` is a no-op/inherit opinion in every non-
shipped layer, whether written explicitly or injected by the old parser. It
therefore migrates as absence, not as an explicit rightmost ConfigV3 `auto`.
If no lower opinion exists, the shipped default still resolves to auto. Phase 1
characterizes every other defaulted/sentinel V1 field the same way; no parser-
injected value may silently become a stored V3 opinion.

The raw projection and migration plan use one closed mapping:

| `LegacyConfigProjectionV1` disposition | Plan disposition |
| --- | --- |
| `moved` | `moved`, or `moved_inactive` when the referenced Flow is absent |
| `omitted_legacy_noop` | `omitted_legacy_noop`; no V3 key is written |
| `inactive` | `moved_inactive` only after the target value validates |
| `manual` | `manual`; apply is blocked |
| `rejected` | `rejected`; apply is blocked |
| no source node and no legacy-injected opinion | `unchanged` |

`conflict` is produced only by target/root composition, not by a raw field.
Golden equivalence covers absent `relay.default`, explicit non-shipped `auto`,
old-parser-injected `auto`, and each case with a lower user/shipped opinion. The
first three must not create a V3 opinion; effective fallback must remain exactly
the characterized legacy value.

| Config v1 path | Config v3 path |
| --- | --- |
| `project_id`, `host` | `preferences.project_id`, `preferences.host` |
| `relay.default`, `roles`, `flows` | matching `preferences.relay` keys |
| `skills.bindings`, `skill_hooks` | `preferences.skills.bindings`, `hooks` |
| `flows.<id>.selection` | `preferences.selection.flows.<id>` |
| `flows.<id>.skill_bindings` | `preferences.skills.flow_bindings.<id>` |
| `flows.<id>.variant_models` | `preferences.prototype.variant_models.<id>` |
| `power_tiers`, `power_auto`, `defaults.power` | `preferences.power.tiers`, `auto_bounds`, `setting` |
| `defaults.selection` | `preferences.selection.default` |

V1 `relay.connectors` is manual because it lacks environment and secret
contracts. A user definition moves through explicit personal configuration and
its digest-bound apply; a project
definition must move to user scope or be removed. Authority-shaped invocation
options are also manual and never silently dropped. An absent
`defaults.power` stays absent and therefore resolves to shipped `medium`; the
migration never turns it into `auto`.

V1 relay strings normalize explicitly: a non-shipped `auto` is omitted as the
legacy no-op above, a built-in name becomes `{kind: builtin, name}`, and a
custom name becomes `{kind: named, name}` only after its manual user definition closes. V2 role/default references drop
their `prefer_connector` wrapper, and Flow-hint arrays become maps keyed by
Flow ID. Duplicate entries must be semantically identical or migration fails.

| Policy v2 path | Config v3 path |
| --- | --- |
| `policy.rules.*` except connector registry | matching `policy.rules.*` |
| `policy.limits.max_wall_clock_ms` | `policy.limits.budget.max_active_wall_time_ms`; clock pauses only at proved worker-free boundaries |
| `policy.limits.max_active_wall_time_ms` | `policy.limits.budget.max_active_wall_time_ms` |
| `policy.limits.max_attempts_per_step`, `max_effort`, `max_tournament_n` | matching direct keys under `policy.limits` |
| Any legacy relay-call, token, cost, or provider-quota cap with the exact V3 unit and meaning | matching key under `policy.limits.budget` |
| Any legacy spend cap whose unit, provider scope, reset window, or attempt meaning is absent or differs | `manual`; no V3 budget opinion is written |
| Any legacy confirmation threshold with the exact V3 unit and meaning | matching key under `policy.limits.approval_thresholds` |
| Any legacy confirmation threshold without an exact V3 meaning | `manual`; it never becomes a hard cap or an approval threshold by guesswork |
| `policy.preferences.relay.*` | normalized maps under `preferences.relay` |
| `policy.preferences.selection.flow_hints` | `preferences.selection.flows` |
| `policy.preferences.skills.*` | normalized maps under `preferences.skills` |
| `policy.preferences.prototype.variant_model_hints` | `preferences.prototype.variant_models` |
| `policy.defaults.connector`, `selection` | `preferences.relay.default`, `preferences.selection.default` |
| `policy.defaults.proof_profile` | `policy.rules.proof.minimum_profile` |

Duplicate v2 list entries that become one map key must agree. Persisted
`policy.preferences.invocation.selection_request`, connector registries, and a
project `auto_apply: true` require manual resolution. A project registry is
never promoted into executable user authority. Connector environment entries
are normalized with the target platform rule before migration. A duplicate,
an `inherit_env`/`secret_env` overlap, or a collision with
`CircuitReservedEnvironmentSetV1` is `manual`; the plan names every source
entry and writes none of the conflicting entries. Moving a migration plan
between POSIX and Windows reruns this check and invalidates the old plan if the
case-sensitivity result changes.

`UserRootResolutionV1` runs before config composition. It classifies each
legacy/canonical pair as `canonical`, `legacy_only`, `equal_duplicate`,
`conflict`, or `absent`. Relative XDG variables are invalid and ignored. When
only today's `$HOME/.config/circuit/config.yaml` exists, Circuit keeps reading
it and offers a digest-bound move to the canonical XDG path. Byte-equivalent
duplicates may be deduplicated with a receipt. Different populated paths block
composition and return the exact two `config show` commands plus
`config migrate plan --global --root-source canonical|legacy`. A manual merge
must first replace one source through validated `config edit`; Circuit never
guesses. The same rule covers experimental Windows files moving to `%APPDATA%`.
Config, state, and data roots must be
absolute, user-owned, no-follow, and private before use.

In a conflict, those commands are distinct and executable:
`config show --global --root-source canonical` and `config show --global
--root-source legacy`. `config path`, `config validate`, and `config edit`
accept the same selector. It is legal only with `--global`, only for a
resolver-approved canonical/legacy pair, and never accepts an arbitrary path.
`set`, `unset`, `get`, `explain`, and normal composition remain blocked until
the conflict is resolved. Every open rechecks no-follow file identity.

Migration uses immutable `ConfigMigrationPlanV1`, never a one-shot writer. The
plan contains exact v3 bytes, every key disposition, before-byte and target
semantic hashes, root relocation if needed, backup digest, and an optional
`ProjectPreferenceTrustPlanV1`. `--with-project-trust` is an explicit operator
request and may create only exact `ProjectPreferenceTrustV1` receipts. It can
never create or change a custom-connector grant; those require a separate
`project trust plan/apply` after migration. `--yes` alone never creates trust.
Restrictive project policy may migrate without it, while project preferences
remain inactive unless the preference-trust plan is included.

Migration lifecycle:

1. Release N reads v1, v2, and v3 and refuses to mutate v3 from an old protocol.
2. Release N+1 writes v3 for new files and enables `config migrate plan/apply`.
3. Planning reports each key as `moved`, `moved_inactive`,
   `omitted_legacy_noop`, `unchanged`, `manual`, `rejected`, or `conflict` using
   the table above. A valid entry for an absent Flow is `moved_inactive`; manual,
   rejected, and conflict items prevent writes.
4. Apply writes a private `prepared` transaction with the exact new config,
   byte-exact backup, and optional preference-trust receipt. It then securely replaces and
   syncs the project/user file, validates the v3 bytes, and commits the matching
   private preference-trust receipt and mirror. While the two-store transaction is between
   phases, config use is blocked. Recovery completes those exact bytes or
   restores the exact before-state; new config is never trusted by an old digest
   or silently active without its requested trust.
5. `ConfigMigrationReceiptV1` retains before/after bytes and semantic hashes,
   backup ID, relocation, every preference-trust receipt created by the
   migration, before-schema family/version and reader range, migration-
   controller digest, and its exact-restore support deadline/status.
6. `ConfigRestorePlanV1` binds that receipt, scope/path/root source, current
   bytes and file identity, target bytes and schema, `exact|current_schema`
   mode, runtime-authority generation, `AuthorityCompatibilityClosureV1`
   digest, trust receipts to revoke, and change digest. `exact` is legal only
   while the active runtime and every supported mutating frontend can read the
   old schema. `current_schema` runs the recorded old semantics through the
   retained migration controller into current ConfigV3 and is labeled as a
   semantic projection, never byte-exact. If neither mode is possible, Circuit
   returns `CONFIG_RESTORE_INCOMPATIBLE` with archive/export and manual-recovery
   remedies and changes nothing.
7. Confirmed restore uses `ConfigWriteTxnV1`, rechecks the closure, and revokes
   only preference-trust receipts created by that migration. A supported exact
   receipt retains its reader/controller reference. After its support floor it
   becomes archive-only unless the signed current-schema projection exists.
   Because migration cannot create connector grants, restore cannot leave one
   behind.
8. The compatibility report lists known clients below the v3 reader floor but
   says plainly that offline copies cannot be inventoried. Circuit does not
   claim a general byte-exact v3-to-v1/v2 conversion after the receipt's reader
   floor.

## Update and uninstall

Every frontend writes an append-only receipt with installation ID, prior receipt
ID, closed transport, package ID, canonical launcher path, frontend and runtime
versions and digests, channel, protocol ranges, and install time. Transport is
one of `direct`, `homebrew`, `winget`, `npm-global`, `npm-local`,
`claude-marketplace`, `codex-marketplace`, or `source`. A receipt never stores a
shell command, executable URL, or arbitrary manager arguments.

Bare `update` selects the newest compatible release on the current channel,
builds an immutable update plan, and confirms it on a controlling human TTY.
Machine, no-input, and delegated calls return `confirm_update` and the exact
digest-bound follow-up before mutation.
`--check`, `--version`, and `--rollback [version]` are mutually exclusive.
Check is read-only and exits 0 whether or not an update exists, with an explicit
`update_available` field; it rejects `--confirm` and `--yes`. Version selects one signed release; bare rollback
selects the prior verified receipt. An exact rollback must fit the release-
revocation policy and the whole compatibility closure below.

Every transport, including direct, updates through `FrontendUpdateTxnV1`. Its
immutable plan binds installation and prior-receipt generations, old/new
frontend and runtime/controller identities, signed release metadata, stable
launcher and activation before/after bindings, compatibility result, rollback
pin, optional fixed manager transaction, expected installation-head and
frontend-set generations, required `ReservedNameCompatibilityPlanV1` when the
set changes, and intended runtime-authority generation. Its phases are:

```text
prepared -> payload_staged -> transport_applied -> launcher_bound
-> self_tested -> receipt_head_and_authority_committed -> cleaned
```

Direct update installs a signed side-by-side payload at `payload_staged` and
performs its own no-follow atomic launcher binding. Manager/host transports use
`ExternalTransportTransactionV1` only as the `transport_applied` subtransaction;
the outer transaction still owns receipt, activation, compatibility, and
rollback. `launcher_bound` leaves a pending binding that permits only the
transaction's self-test/cleanup until the private commit. `self_tested` proves
the launcher, OS activation, endpoint, controller, rollback payload, and every
activation-critical reserved-name projection postimage. One
private CAS appends the active or quarantined immutable receipt, advances the
expected `FrontendInstallationHeadV1` and frontend-set generation, and, when the
plan changes it, advances `RuntimeAuthorityV1`; the same CAS commits the
reserved-name registry/set transaction when present. Historical receipts remain
readable but never stay authoritative. A stale head or concurrent operation
makes that CAS lose and leaves the staged payload cleanup-owned. A frontend-only rollback leaves
runtime authority unchanged only if its range still contains that authority.
Recovery before launcher binding may restore the old payload; after it, the
signed cleanup controller may restore the exact old binding and record an
aborted receipt only while
`receipt_head_and_authority_committed` has not won. That private CAS is the
irreversible boundary. At or after it, recovery must roll the launcher,
activation, reserved-name registry and projection receipts, immutable frontend
receipt, installation head, and runtime authority forward together to the
committed generation before cleanup. No phase can leave a new runtime
authoritative with an old or unrecorded launcher. A pre-commit failed update
keeps the old authority and a usable old or cleanup binding; a post-commit
failure is an incomplete successful update that recovery finishes.

The executing frontend cannot choose global compatibility alone.
`AuthorityCompatibilityClosureV1` intersects every current `active`
`FrontendInstallationHeadV1` receipt's RPC/plan/feed range (never historical or
quarantined receipts), every enrolled project's Run-store/config
generation that may create a new Run, every retained Run/control protocol, and
the required compatibility-controller set. It also retains every config reader
or migration controller promised by a still-supported exact restore receipt;
removing the last reader first transitions those receipts to a proved signed
current-schema projection or blocks the update. Update or rollback may activate a
runtime only when that whole closure passes. Release N can never become the
authority after any project commits generation 2, even if the invoking launcher
could execute it. A frontend payload may roll back independently while the
global authority stays newer, but setup labels that split and proves their RPC
range.

The runtime store retains a last-known-good recovery payload for the current
Run-storage/config protocol major in addition to “previous release.” If no
verified previous payload satisfies the closure, rollback returns
`rollback_available: false`, keeps the current authority, and names the nearest
compatible signed version. It never makes other frontends or enrolled projects
unusable to satisfy one launcher.
Package-manager and host installs
use only a fixed transport-owned argv template without a shell, or print the
exact manager action when safe delegation is unavailable.

The executing launcher selects its own installation ID. `self status` and
`doctor` list PATH shadows and every other receipt. If no receipt matches, two
receipts claim the launcher, or a caller names no installation in an ambiguous
mutation, Circuit changes nothing. `self update` is a permanent alias, not a
second implementation. Updates and rollbacks change the default for
new Runs only; every later Invocation of an existing Run keeps its runtime pin.

Activation also negotiates with the current supervisor. A compatible N/N-1
supervisor keeps serving existing workers and the new client uses its advertised
range. An incompatible payload may be staged but does not become the mutation
default until the old supervisor is idle or all workers drain, a recovery
handoff succeeds, and the new supervisor proves every live pinned
execution bootstrap and every mandatory `CompatibilityControllerV1` path.
Parked and reconciliation Runs count even without a worker. Update never starts
a second supervisor generation or strands a pin to evade that rule.

The current `uninstall --dir --json` removes project instruction blocks. It
remains an exact adapter to `project instructions detach` through the N+3/180-day window
below and is then removed. Circuit never reuses that spelling for application
removal. `circuit self uninstall` is permanently unambiguous.

`project instructions detach` has one narrow meaning. Its immutable
`ProjectInstructionDetachPlanV1` binds the project root, file identities and
before hashes or absence for `AGENTS.md` and `CLAUDE.md`, every managed marker
block and malformed-marker result, and exact postimages for each well-formed
file. `ProjectInstructionDetachTxnV1` prepares same-directory postimages and
backups, journals each independent replacement, then commits a receipt listing
changed, unchanged, and malformed files. Recovery finishes only the replacements
already selected by the plan. A malformed file does not roll back a clean
sibling change; the compatibility adapter preserves that current partial-result
behavior and byte-golden JSON.

This command never changes `.circuit`, project enrollment, generation markers,
private mirrors, trust, Runs, or references. Circuit exposes no ordinary
“de-enroll this reachable project” shortcut. Project data purge, evidence
adoption, and proved-unreachable retirement keep their separate transactions.

Codex continuity hooks are installed into a user-owned host file and therefore
need ownership separate from both project instructions and plugin files.
`HostHookRegistrationV1` records registration ID, host (`codex` in the first
version), canonical hooks path and file identity, exact managed-entry hash,
stable-control launcher path/identity/digest and root-set generation, owning
installation IDs, prior receipt, and
`active|migration_required|unresolved_legacy|classified_non_circuit|removed`
state. It never claims the whole host file.

`HostHookWriteTxnV1` is the only writer used by `handoff hooks install`,
`handoff hooks uninstall`, setup host integration, update migration, and final
purge. Its phases are `prepared -> staged -> source_rechecked -> replaced ->
synced -> receipt_committed`. It uses a lossless JSON syntax tree and replaces
only the exact managed-entry span; insertion or removal changes only the
necessary array delimiter and preserves every unrelated token, whitespace
byte, and newline style. If that span cannot be proved, it does not fall back
to whole-file reserialization. It stages a same-directory postimage, rechecks
the exact file identity and before hash, atomically replaces it, syncs file and
parent, and then commits the registration receipt. Malformed input, duplicate
ambiguous Circuit entries, or concurrent modification changes nothing and
returns a repair view; it never rewrites the file from a stale parsed object.

The inventory records every entry with a Circuit marker, executable edge, or
`handoff hook` shape, even when it cannot safely adopt it. The migration
recognizes only characterized legacy Circuit hook entries. It
replaces the current Node/cache-specific command with the signed stable
`circuit-control` launcher, proves the launcher binding, commits the new
receipt, and only then releases the old launcher pin. An unrecognized
Circuit-like command becomes `unresolved_legacy`, blocks cutover/update/purge,
and is not adopted automatically. `handoff hooks resolve --candidate <edge-id>
--action <replace|remove|classify-non-circuit>` is the only resolution path. Its
first call is read-only and returns `confirm_hook_resolution` with the exact
lossless span and resolution-plan hashes; only the matching `--confirm <sha256>
--yes` retry mutates. Response loss returns the same receipt. It never treats a
retained Circuit launcher as gone. Update and root
relocation include every active hook receipt in their compatibility and
activation-binding closure, and private backup includes the receipts and
managed-entry hashes but not an unrequested copy of the user's whole host file.

Installing through another frontend adds its installation ID to the same
registration instead of duplicating the hook. Uninstalling one frontend
releases only that owner reference. The last owner runs the same transaction to
remove only the exact managed entry; a changed entry becomes
`migration_required` and blocks a false uninstall success. `self purge` cannot
remove the stable launcher, root set, or cleanup stub until every hook receipt
is removed or explicitly resolved and tombstoned. The preserved public grammar
remains `handoff hooks install|uninstall|doctor --host codex [--installation
<id>]`; the new receipt changes ownership and recovery, not the user's intent.
The no-ID compatibility form is valid only when the invoking launcher maps to
one installation receipt; an ambiguous native mutation returns the exact
`--installation` choices and changes nothing. `handoff hooks resolve` is the
only added leaf; it is intentionally absent from the legacy no-subcommand
adapter and always requires the exact candidate digest.

Removal ownership follows the receipt:

| Transport | Removal action |
| --- | --- |
| Direct | Signed cleanup stub removes only that installation's launcher/bootstrap and releases its installation reference |
| Homebrew / WinGet | Fixed manager argv for the recorded formula or package ID |
| npm global / local | Recorded npm executable and fixed argv; local uses recorded root, never cwd |
| Claude / Codex marketplace | Matching host manager removes the exact plugin installation |
| Source | Remove receipt-owned links/bootstrap and release its installation reference; never touch source checkout |

No transport uninstall deletes a shared runtime directory, controller, or
transport-neutral control shim merely because it originally supplied those
bytes. Content-addressed payload ownership belongs only to the reference
registry and GC; another frontend, Run, rollback, or recovery reference keeps
the bytes. Circuit never directly deletes manager-owned files or builds a shell string.
Every delegated update or removal first commits
`ExternalTransportTransactionV1`: transaction and installation IDs, operation,
fixed manager argv, expected before/after file identity, completion verifier,
and retained cleanup-stub digest. Its phases are `prepared`,
`manager_observed`, `receipt_committed`, and `cleaned`. If Circuit cannot safely
invoke the manager, action-required output gives two separate commands: the
fixed manager argv and the absolute
`circuit-control self cleanup --receipt <pending-id>` command. The retained stub
verifies manager state before committing update receipt or uninstall tombstone,
even after the frontend disappears. Exit 0 needs that committed receipt.
Circuit-owned shared purge is always a later, separate command.

Package managers may be changed without asking Circuit first. A missing or
changed manager-owned launcher therefore enters installation repair, not an
eternal compatibility block:

```text
circuit repair installation plan --installation <id>
circuit repair installation apply --plan <installation-repair-plan-id> --confirm <sha256> --yes
```

`InstallationRepairPlanV1` queries only the receipt-recorded manager with fixed
argv and classifies `present_exact|present_verified_replacement|absent_proved|
ambiguous`. It binds manager database result, launcher/activation/hook/owner
inventory, publisher/TUF/release proof, before receipt chain, and reference
effects. `InstallationRepairTxnV1` may append a verified replacement receipt or
tombstone a proved-absent installation and release only its references. It
never changes `RuntimeAuthorityV1`; activating a replacement remains a normal
update. Ambiguous manager state changes nothing. This covers out-of-band
Homebrew/WinGet/npm/marketplace update or removal and a deleted npm-local
project root; setup and doctor surface the exact repair plan.
`present_exact` returns `no_change`; `ambiguous` returns a negative result and
no confirm action. The two mutating classifications return
`confirm_installation_repair`; only `repair installation apply` with that exact
plan/digest can append or tombstone a receipt. Identical apply replay returns
the stored transaction result.

Application removal always preserves shared user/project config, Runs,
evidence, and runtime references. It removes only receipt-owned frontend files
through the transport owner.

Application removal is staged; it has no bare force bypass:

```text
circuit self uninstall plan [--installation <id>]
circuit self uninstall prepare --plan <uninstall-plan-id> --active-runs <leave-running|graceful-cancel|abort>
circuit self uninstall apply --plan <uninstall-plan-id> --confirm <uninstall-plan-sha256> --yes
```

Bare `self uninstall` is a permanent alias for `self uninstall plan`.
`UninstallPlanV1` freezes frontend/hook/manager ownership plus active Run,
effect, checkpoint, reconciliation, shim, and reference inventories. With
active Runs it returns `choose_active_run_disposition`. `abort` closes only the
uninstall plan. `leave-running` prepares the signed transport-neutral
`circuit-control` shim, supervisor, state, and pins. The shim can only list/show,
watch, wait, cancel, report, answer checkpoints, reconcile, resume named
retained Runs, and `self cleanup`; it cannot plan or start new work.

`UninstallAdmissionTxnV1` closes the prepare/apply race. Its first CAS binds the
frontend-set generation and every current installation head, whether the target
is the last runnable frontend, the Run-acceptance high-water, uninstall plan,
and a provisional `UninstallRunDispositionTxnV1` ID. It does not claim a final
Run inventory or disposition receipt yet.
Removing the last runnable frontend closes new-Run acceptance before active
Runs are enumerated; `runs.start` checks that same fence in its acceptance CAS.
A post-fence start loses without allocating a Run. The prepare transaction then
atomically snapshots every already-accepted nonterminal Run at that high-water
into a `disposition_prepared` record. Only that exact set may be settled or
retained. For `leave-running`, the signed shim capability is created from that
prepared set and cannot control or start anything outside it. After settlement,
the final disposition receipt is linked back to the still-held admission fence
by CAS; only then can `confirm_uninstall` exist. Abort before frontend removal
closes the provisional disposition, removes any uncommitted shim, and reopens
admission. Successful final removal keeps it closed until a compatible frontend
installs. Uninstall, update, promotion, and installation repair all serialize
through the frontend-set generation, so two “last frontend” uninstalls cannot
both conclude that the other remains.

`graceful-cancel` creates `UninstallRunDispositionTxnV1`, submits the ordinary
tokenless graceful cancel for each Run in deterministic order, and waits for
settlement. An unresponsive Run returns its normal Run-specific `confirm_force`
action; after `actions confirm-force` returns the decision, its exact
`circuit cancel <run-id> --force --decision <id>` follow-up is the only consumer;
uninstall never fabricates or bypasses that decision. Unknown effects return reconciliation
actions. The operator reruns `prepare` after those separate actions settle.

Only `UninstallRunDispositionReceiptV1`, binding every terminal/canceled or
retained Run and the exact shim, makes the plan confirmable. `confirm_uninstall`
binds that receipt hash as well as frontend/hook inventories. `apply` then runs
the external-manager and cleanup transactions. The order is: choose a
disposition; win the admission/frontend-set fence with its provisional
transaction; snapshot the exact Run set after that fence; settle or retain that
set; commit and link its receipt to the fence; return and confirm the uninstall
action; invoke the manager
or direct cleanup; CAS the installation head to `tombstoned`; then release the
fence only if another compatible frontend is current. Exit 0 requires the committed
uninstall receipt or a valid draining shim; every disposition, force,
reconciliation, confirmation, or manager step returns exit 3 with its exact
continuation. After retained Runs close, cleanup removes the shim and
unreferenced state; failed automatic cleanup must leave the shim usable.

Shared deletion is separate and runs from the signed cleanup stub retained by
the final uninstall. `self purge --all-installations` requires every
installation receipt and drain shim to be tombstoned, every Run in the private
authority registry either terminal or covered by a committed
`retired_unreachable` tombstone, every lease known, every effect reconciled, and
the registry and reference journal valid. An unreachable registered project or
missing private record stops at `repair inspect`; absence from the best-effort
project locator is never treated as proof. A permanently unreachable registered
instance must first use the digest-confirmed `repair retire-project` contract
below. It previews shared state/data/cache;
user config is included only by its explicit flag. Historical project folders
that Circuit was never told about cannot be discovered, so the preview states
that limit and project paths are never deleted from a global locator. `data
purge --project-root ... --runs` deletes
only that project's eligible Run evidence through the prune transaction;
`--all` additionally previews project config, plans, history, memory,
continuity, locator entries, project trust receipts/grants, and releasable
content/runtime references through a two-store transaction.
Both commands require a digest confirmation, resolve paths by file identity,
refuse symlink escapes, and never bypass prune safety.

`CredentialInventoryV1` closes the last ownership boundary. Circuit-owned
credentials include backup authentication/wrapping keys, environment-material
sealing keys, cursor/token MAC keys, and `NonCloneableMachineKeyV1` metadata.
User-owned credentials merely referenced by `SecretHandleV3` are never deleted.
Every backup export records its required `RecoveryKeySetV1` and portability
limits.

The inventory classifies every Circuit-owned key as
`backup_recovery_required|operational_authority|unused_unknown`. `retain`
preserves only the exact backup recovery set, including a machine-bound unwrap
key when required; it destroys or cryptographically revokes operational
cursor/token/sealing authority and refuses any unknown key. `destroy` selects
every Circuit-owned class. The purge plan binds one explicit disposition per
key ID and cannot infer ownership from a credential-store label.

When Circuit-owned recovery keys exist, full purge with user config must name
one disposition:

```text
circuit self purge --all-installations --include-user-config --recovery-keys <retain|destroy> --confirm <sha256> --yes
```

`retain` leaves only a non-executable fixed-slot `RecoveryAnchorV1` and OS
credential-store retention record containing root-set/key IDs and supported
backup-envelope versions. It grants no runtime or mutation authority; a later
verified installer offers restore before creating a conflicting root set.
`destroy` previews every known export/key dependency and warns that unknown
external exports may also become permanently unreadable. The cleanup stub
deletes selected Circuit-owned keys last, verifies their absence, then removes
the discovery slot and itself. A failed deletion leaves the stub/plan
recoverable and does not claim purge success. Reinstall-after-retain restore and
destroy-then-restore refusal are required tests.

A newly verified installer that finds `recovery_anchor` does not reserve an
install slot. Its signed bootstrap exposes only:

```text
circuit repair recovery-anchor show
circuit repair recovery-anchor plan --action <restore|retain|destroy-and-initialize> [--backup <path>]
circuit repair recovery-anchor apply --plan <recovery-anchor-plan-id> --confirm <sha256> --yes
```

`retain` is a read-only no-change result and the installer exits without
installing. `restore` requires an imported, authenticated compatible backup and
proves its `RecoveryKeySetV1`, machine portability, root capabilities, and
protocol/controller closure. `destroy-and-initialize` binds every retained key,
known/unknown-export warning, and the proposed fresh root set. Both mutating
choices use `RecoveryAnchorTxnV1`: slot CAS to `transition`, stage/verify the
restored or fresh root set and stable launcher, delete old keys only when the
chosen action requires it, commit the new `root_set_committed` variant and
activation, then clean the repair bootstrap. Recovery holds the fixed election
and either restores the anchor before key deletion or rolls the exact new root
set forward afterward. Repeating apply returns one receipt; a raw installer
cannot bypass, overwrite, or silently destroy an anchor.

Operator pins and the same-protocol recovery payload appear explicitly in the
shared-purge plan; no hidden reference is discarded. When user config is
preserved, the fixed discovery slot, machine bootstrap locator, root set, and
stable launcher are also preserved so a later install can find them. With
`--include-user-config`, the cleanup stub removes config, runtime root-set
authority, activation registration, and stable launcher last while holding
`StableSupervisorElectionV1`. The `destroy` disposition then removes the fixed
slot; `retain` atomically replaces it with the non-executable Recovery Anchor.
Only after the selected credential/slot state and parent-directory durability
are proved does the cleanup stub remove itself.

### Runtime references and garbage collection

The private, crash-recoverable reference registry keeps a runtime live while it
is named by `RuntimeAuthorityV1` active/previous state or a retained transport
rollback receipt, the last-known-good payload for the active storage/config
protocol major, an
unpruned plan, any nonterminal Run, a supported mutable legacy Run, a
`ContentPinV1`, active/unknown lease, incomplete terminal mirror, Apply in
`apply_recovery_required`, active or migration-required host-hook registration, incomplete install
registration/root relocation/machine rebind/backup export or other cross-store
transaction, operator pin, or frozen release proof.
Acceptance creates the reference before acknowledgement. Worker/runtime
references release only after `terminal_cleanup_complete`; plan/Run references
release only after their corresponding prune commit.

GC computes a mark set under the user-store lock, but deletion is its own
recoverable `ContentGcTxnV1`. The transaction CASes the complete reference
high-water and target identities to `gc_prepared`, which makes every later
reference acquisition fail or force a fresh mark. It then renames each
immutable content/runtime directory to same-filesystem generation-named trash
and syncs source/trash parents, commits registry tombstones pointing at those
trash identities, and only then purges bytes and syncs again. Before the first
move recovery may reopen the exact target; after it, recovery rolls forward.
A live registry entry pointing to missing/partial bytes is corruption, never a
successful sweep. Missing/corrupt registry, unfinished transaction, unknown
lease, or incomplete migration stops with a repair command. The transaction is
shared by runtime, Flow, plan, workspace, projection, and backup content GC and
never infers safety from the project locator. `runs reclaim` deletes only
derived cache, abandoned isolated workspaces, and rebuildable projections,
never Trace, reports, or evidence.

Operator pins are explicit receipts, not immortal anonymous roots. `runtimes
pins create --version` resolves one already verified runtime digest and writes a
pin ID, creator installation, reason, and creation time. `pins list` explains
every pin and every other reference keeping that runtime live. `pins remove`
previews the exact pin and resulting reachability, requires a digest
confirmation, and appends a tombstone; it never deletes a runtime still held by
another reference. Pin receipts and tombstones participate in backup, repair,
and root relocation.

Compatibility-controller GC is separate from engine-runtime GC. Every
nonterminal Run-storage/control protocol and every supported historical reader
keeps at least one current unrevoked controller, even when its original engine
bootstrap is revoked or removed. A supported `ConfigMigrationReceiptV1` likewise
keeps its exact reader or signed current-schema projection controller through
the receipt's declared support state.

### Private-state repair and project adoption

`repair inspect` is always read-only. It inventories valid backups, project
markers, Run evidence, leases, process identities, containment records, runtime
references, and conflicts, then prints exact next commands.

A changed OS installation identity returns `MACHINE_IDENTITY_CHANGED`; it
never guesses a new authority. `repair machine plan --from-bootstrap-root
<path>` opens the old anchor no-follow and creates `MachineRecoveryPlanV1` with
old/new machine and user identity digests, root-set and discovery-slot
generations, every root/file identity, last boot, complete lease/effect/
containment inventory, authenticated root-set or backup proof, activation and
installation bindings, project-mirror/reference high-waters, a fresh challenge
to the recorded `NonCloneableMachineKeyV1`, and
`authority_rebind|data_only_import` mode.

Authority rebind is legal only when the non-exportable hardware/OS key signs a
fresh challenge binding both machine digests, root-set generation, plan digest,
and target slot; the old fixed slot and authenticated root set are reachable;
every worker/effect/containment is proved empty; and all authority roots pass
the local-filesystem probes. An exportable, snapshot-restorable, or virtualized
key provider does not qualify for rebind. A
platform whose key did not survive reinstall, or any shared, copied,
unauthenticated, or ownership-unknown root, permits only data-only import and
project adoption. Possession of copied root bytes, backup bytes, or credential-
store files is never enough. `MachineRebindTxnV1` fences the old election and reserves
the new fixed slot; writes a pending new identity into the root set; commits the
new slot and incremented root generation; updates stable activation and
frontend registrations; tombstones the reachable old slot; then verifies
mirrors/references and commits. Before the new-slot commit it may abort; after
that point recovery only rolls forward. Every phase binds the same confirmed
inventory digest.

Setup prints the exact machine-plan command for a preserved-root reinstall and
labels data-only fallback before confirmation. VM clone and machine-ID
replacement tests clone the complete powered-off disk and credential-store
bytes: at most the copy that can answer the non-clonable challenge may rebind,
while every copy may inspect/import data-only.

`repair backup create` uses `BackupSnapshotTxnV1`; holding one store lock while
other journals append is not a snapshot. Every private writer, including lease
renewal, control, queues, references, receipts, and locator updates, participates
in one monotonic store generation even when it uses an independent append lane.
The transaction briefly closes new effect/control admission, writes
`snapshot_intent`, and waits for each live writer to acknowledge that generation
at a safe boundary. An unresponsive or unknown writer makes backup return busy;
timeout never declares it absent.

With those acknowledgements, the supervisor rotates every checksum-framed lane
at exact high-water sequences, syncs an immutable cross-lane root manifest, and
opens the next generation before copying bytes. Active effects may then
continue. Content blobs are immutable and must be synced before a prefix can
reference them. The copier revalidates every prefix hash, project mirror,
reference closure, and root-set generation before writing
`PrivateStoreSnapshotV1` manifest last. It records store generation, every lane
high-water, `UserRootSetV1` ID/generation, project mirror hashes,
runtime-reference high-water, tombstones, and all content hashes. A crash before
manifest commit leaves only an incomplete candidate. Authority-bearing backups
are authenticated by a backup key held outside the snapshot in the OS
credential store. A hash-only imported backup is data-only and cannot restore
authority.

`repair backup export <backup-id> --output <new-path>` first acquires the
snapshot closure pin and durably creates one immutable
`PrivateBackupExportCandidateV1` inside private storage. The candidate records
candidate and backup IDs, canonical plaintext/object-closure digest, encryption
algorithm and version, credential-wrapping key ID/version, unique nonce, exact
ciphertext digest and size, immutable byte reference, creation/expiry, and pin
generation. Before encryption, a short snapshot-generation fence rotates and
authenticates every private lane segment from the snapshot high-water through
candidate creation; the candidate includes that exact `recovery_cut` and its
hash. Candidate creation is idempotent; a crash either finishes those
exact bytes or leaves no confirmable candidate.

Only then does `PrivateBackupExportPlanV1` bind that candidate ID/digest, backup
and root-set IDs, store generation, snapshot/authentication digest, output path
and parent identity, expected absent target, sensitivity warning, and change
digest. The exported `PrivateStoreBackupEnvelopeV1` is authenticated and
encrypted; raw private authority and its credential-store wrapping key are
never exported. Confirmation therefore approves ciphertext that already has a
stable identity.

Confirmed `BackupExportTxnV1` copies those exact immutable candidate bytes to a
same-directory staging file, syncs them, rechecks target absence and parent
identity, atomically installs and directory-syncs the file, then commits an
export receipt before releasing the candidate and snapshot pins. It never
reencrypts during retry. Recovery removes incomplete external staging or
returns the same committed receipt. Decline or expiry terminalizes the export
plan and releases its candidate/pins only after no confirmation or export
transaction can still reference them. It never overwrites an existing path.
Root relocation, purge, and backup deletion fence candidates and incomplete
exports.

`repair backup import <path>` opens the source no-follow, copies it into private
immutable backup storage, verifies the envelope before decryption and then every
manifest/content hash, assigns a
`BackupId`, and records whether its external authentication is valid. Restore
never reads a mutable path. A data-only import remains inspect/export-only.

`repair restore --backup <backup-id>` requires every worker, effect, and
containment empty before it can enter `RepairBarrierV1`. Active Runs must drain
to worker-free checkpoints, settle cancellation, or produce an action-required
list; an unknown containment blocks restore. Circuit never re-registers a live
worker across a private-store swap.

The barrier fences scheduling, effect admission, control requests, queue and
lease mutation, reference acquisition, update, GC, purge, and a second
supervisor. Restore has two explicit modes:

| Mode | Authority |
| --- | --- |
| `exact_tail` | Current authenticated private tail exists and replays from the export recovery cut through the current high-water |
| `disaster_point` | Live state/data is unavailable; archive plus retained credential key restores only the export recovery cut under a new private-store epoch |

`DisasterRestorePlanV1` binds mode, backup generation and recovery-cut hash,
optional live-tail hash, next private-store epoch, complete reachable/
unreachable project inventory, per-project/Run disposition, conservative
reference union, and change digest. Dispositions are
`restore_authority|reconciliation_required|historical_read_only|inspect_only|
blocked_unreachable`.

In `disaster_point`, the never-moved bootstrap anchor commits a higher
`private_store_epoch` before restored authority can publish. That invalidates
every restored capability, approval/decision token, pending ticket, lease,
control channel, and endpoint generation. Pending tickets become expired;
idempotency tombstones remain. Reachable project evidence is compared with the
backup mirror: later terminal evidence is historical read-only, while advanced
or nonterminal evidence becomes reconciliation-required or inspect-only and is
never scheduled silently. Unreachable instances retain conservative references
and remain mutation-blocked without preventing recovery of unrelated projects.

The transaction advances `prepared -> store_staged -> epoch_committed ->
projects_reconciled -> pointer_swapped -> activation_verified -> complete`.
Before epoch commit it may abort; afterward it only rolls forward. Exact-tail
mode preserves the prior behavior and merges newer references by conservative
union. Both modes require a matching root-set ID for authority, stage before
pointer swap, and verify activation. Failure before the irreversible boundary
leaves current state authoritative. Requesting exact-tail without the tail
returns `BACKUP_TAIL_UNAVAILABLE` and the digest-bound disaster-point preview.

If no valid backup exists, `repair adopt-project` is the narrow last resort. It
requires the project execution lock, exclusive mutation-domain barrier, and
every Run append lock to be acquirable; no live or ownership-unknown process or containment may exist; and
all retained project evidence must parse without symlink escape. The preview
digest binds that inventory. Adoption creates a new `ProjectInstanceV1` and a
generation-2 marker through the normal two-store transaction, with
`adopted_from` metadata and a new private mirror. Terminal Runs remain readable.
Every nonterminal old Run becomes permanently inspect/export-only and cannot be
resumed, answered, canceled, or used to infer prior authority. Adoption never
reconstructs a secret grant, approval, runtime pin, lease, or effect resolution
from project files. If any such authority is still needed, the command stops.

`repair retire-project <project-instance-id>` handles an enrolled root that is
permanently unreachable. `ProjectRetirementPlanV1` shows the last root identity,
retained Runs and export metadata, unresolved authority, runtime/content
references, and permanent loss of resume/cancel. Apply requires proof that no
recorded containment can still exist, then writes a permanent
`retired_unreachable` tombstone and releases references. It fabricates no
terminal Trace entry. If the root later returns, its Runs are inspect/export-only
until explicit adoption. The tombstone retains the proved-empty containment
record, last known Run inventory, and committed reference-release digest after
shared purge. Such a Run satisfies purge eligibility without being mislabeled
terminal. Unknown containment or an incomplete reference release blocks both
retirement and purge.

## Existing Run storage migration

### Legacy control-plane discovery

Current v1 Runs may live under the caller's nested cwd or an arbitrary
`--run-folder`; Git-root discovery cannot inventory them by itself.
`LegacyControlPlaneDiscoveryV1` records one `LegacyRootRegistrationV1` per
root: owning project instance, canonical path/file identity, discovery source
(`project_scan|explicit_legacy_root|run_folder|runs_base|history_or_continuity`),
discovery-boundary kind/evidence, Run inventory hash/IDs, and
`mutable_v1|historical_v1|inspect_only` disposition. Its closure binds the
project scan root/identity, ordered registrations, unresolved candidates, and
one closure hash.

Enrollment traverses the selected project/worktree no-follow and same-device
for eligible nested `.circuit` Run stores, then incorporates history,
continuity, current `runs-base`, and explicitly supplied external roots.
`LegacyDiscoveryBoundaryV1` stops the parent scan at a valid nested
`.circuit/config.yaml` anchor, nested Git repository/worktree, submodule Gitfile,
or generation marker owned by another `ProjectInstanceV1`. Ordinary
`.circuit/runs` beneath the selected project's own anchor remain eligible.
Every candidate resolves its owning `ProjectContext`; the private registry CAS
owns each physical legacy root exactly once. Legacy Run lookup is keyed by
stable `LegacyRunRecordId` and
`LegacyRunIdentityV2 { project_instance_id, legacy_root_registration_id,
display_run_id }`; the human-facing Run ID is not globally unique across
projects or legacy roots. Lists return record ID, display ID, and owning root.
Inside a selected project, a display ID is accepted only when unique. An
ambiguity returns bounded exact `legacy:<record-id>` choices; scripts must use
that qualified identity and mutations never guess. Outside a project, the same
action also requires `--project-root`.

Copied roots need a separate rule. Byte-identical terminal evidence may be
registered under both composite identities as `historical_v1`. A copied
nonterminal Run can never inherit mutation authority: it is
`cloned_inspect_only`, cannot resume, answer, cancel, or mint a queue receipt,
and does not block that copy from reaching generation 2. An already registered
mutable origin remains the only mutable owner of its physical root. If two
previously unseen roots contain the same nonterminal origin/evidence digest and
neither origin is provable, enrollment blocks until a hash-bound
`LegacyRunDispositionDecisionV1` names at most one `mutable_v1` record and marks
every other copy `cloned_inspect_only`; choosing none freezes all copies.
`LegacyRunCollisionSetV1` also covers duplicate display IDs in two roots of the
same project. Byte-identical terminal records may coalesce only through an
explicit alias receipt; different terminal evidence remains separately
qualified history. At most one nonterminal record in any collision set is
mutable, and exact resume/freeze/prune targets its record ID. The
decision is supplied to `project enroll --legacy-decisions <file>` and is
single-use. A foreign boundary is listed with the exact child
`project enroll --project-root ...` remedy and can never be adopted by the
parent.

Scan limits, unreadable/invalid boundary metadata, overlapping non-Git anchors,
or ownership that cannot be proved make the closure incomplete; automatic
enrollment stops instead of claiming absence. Explicit external roots must
prove they are not already owned by another configured project. External roots
are never guessed.
`project enroll --legacy-root <path>` is repeatable, and an unregistered v1
`resume --run-folder` must register that root while the project remains
generation 1. `project show` lists registered and unresolved roots. Generation
2 permits no new registration.

`LegacyProjectEnrollmentV1` commits `discovered -> private_prepared ->
roots_registered -> marker_installed -> committed`. It pins every registered
Run/runtime without rewriting v1 evidence, and both project marker and private
mirror bind `legacy_root_set_sha256`. Cutover checks that exact closure and
high-water. No marker commits while any cross-project or same-project collision
set lacks its disposition/alias receipt. The plan does not claim discovery of an arbitrary offline external
folder; unsupported external continuations must be explicitly registered and
guarded or frozen before generation 2.

New Runs add `run.storage.json` with storage version 2, root Invocation ID,
project instance ID, accepted executable-plan hash, full-artifact hash, runtime
digest, creation time, and writer epoch.
Existing Trace, report, evidence, and manifest locations remain. A folder
without that marker is Run storage v1 and is never rewritten in place.

### Project Run-store generation and v1 wrapper

Release N first enrolls today's markerless projects through
`LegacyProjectEnrollmentV1`. No private enrollment record plus no project marker
is `legacy_unenrolled`. A prior private enrollment record plus a missing marker
is corruption, not a new project. Enrollment requires a complete
`LegacyControlPlaneDiscoveryV1` closure and every known live owner, allocates
`ProjectInstanceV1`, syncs private `prepared`,
installs and directory-syncs generation 1, then commits its private mirror and
permanent enrollment ledger. It proceeds only when no unwrapped legacy owner is
live or ownership-unknown. Recovery finishes or restores those exact bytes at
every phase. Safe first enrollment may run automatically before Release N's
first mutation; `project enroll` is the explicit preview, retry, and diagnostic
path. Loss of both private authority and the marker enters the repair/adoption
path, never silent enrollment.

Before v2 ships, Release N adds `.circuit/run-store.json` through that
transaction and checks it before
every start, resume, answer, cancel, prune, or append. Generation 1 permits the
Release N v1 writer and marks the project `legacy_draining`. Release N+1 never
starts a new v1 Run. A project stays generation 1 while any existing v1 Run is
still allowed to continue. It cannot create a v2 Run during that time. The
operator must either finish each supported legacy continuation or explicitly
freeze it read-only. Only then may N+1 atomically write generation 2. A private
mirror must match. Missing, corrupt, rolled-back, or mismatched markers block
all mutation; authority is never rebuilt from Run folders. Release N recognizes
generation 2 and rejects mutation as protocol-too-new.

The two-store flip is a recoverable transaction: sync private `prepared` with
old/new marker hashes, atomically replace and sync the project marker, then
commit the private mirror. Startup either completes the exact prepared bytes or
restores generation 1 before any mutation. An unrecognized mismatch stays
blocked; it is never guessed through.

```json
{
  "schema_version": 1,
  "project_instance_id": "<private-id>",
  "generation": 2,
  "state": "v2_enabled",
  "minimum_mutator_protocol": 2,
  "legacy_inventory_sha256": "<classified-v1-inventory>",
  "legacy_root_set_sha256": "<registered-control-plane-closure>"
}
```

Every supported v1 continuation after N runs inside a supervisor wrapper that
holds the same project execution lock and platform containment for the whole
pinned v1 process. The pinned v1 runtime remains the only Trace writer; the
wrapper puts no v2 entries into v1 evidence. It allows the complete remaining
legacy graph, including child creation, because native v1 cannot enforce a new
child ban or writer epoch. Support is granted only when the manifest, Trace
boundary, complete reachable continuation, and signed runtime digest match an
end-to-end byte-golden corpus. The wrapper adds process ownership, but does not
claim v2 effect reconciliation, reconnect, or cancellation semantics.

`runs freeze-legacy <run-id>` without confirmation is a read-only preview that
returns `confirm_freeze_legacy`, the digest, and the exact follow-up. `--confirm`
and `--yes` are required together for mutation. That command is the only way to
abandon a nonterminal v1 continuation for cutover. It writes a private,
hash-bound `inspect_only` disposition and changes no v1 Trace bytes. The preview
says that resume, answer, and cancel will never be available again. The digest
binds project instance, Run inventory, current boundary, runtime, descendants,
and retained evidence. It refuses while any legacy process or containment is
live or ownership-unknown. Once every nonterminal legacy root is terminal or has
that disposition, the generation flip records the full classified inventory
digest. Generation 2 permits no v1 append and cannot unfreeze a Run.

Pre-N same-user binaries can ignore the marker. Generation 2 therefore verifies
the classified v1 inventory before every v2 effect admission. A changed or new
v1 file blocks the project as unsupported out-of-band mutation. The plan does
not describe filesystem access by arbitrary old binaries as prevented.

`ExecutableEdgeInventoryV1` also gates the generation-2 flip. It records every
known installation receipt, canonical/shadowed PATH executable, global/local
npm root, host marketplace cache/generated launcher, activation entry, cleanup
stub, generated projection, host hook, and executable-selecting environment
edge. Each record binds source receipt/path/selector, the actual activation-
environment digest, resolved target identity/digest, guard-capability digest,
owners, and `guarded|unresolved|tombstoned` state.

Release-N official mutating frontends remove or reject executable redirection
through `CIRCUIT_CLI`, `CIRCUIT_DEV`, `CIRCUIT_HANDOFF_HOOK_LAUNCHER`, and every
equivalent selector found by Phase 1. Source development uses the explicit
checkout provider instead. A known edge must resolve under its real activation
environment to a guarded build or be disabled with a durable tombstone proving
that launcher/cache/hook path no longer executes. An unresolved Circuit-like
hook is an executable edge even without a managed hook receipt. `doctor` shows
the exact update, hook-resolution, or removal command.

The cutover barrier blocks new Circuit mutations, rescans this inventory and the
v1 Run files immediately before the marker CAS, and aborts if either high-water
changed. A stale npm install, PATH shadow, or cached host plugin therefore
blocks v2 activation rather than racing it. Circuit cannot inventory an
arbitrary offline copy of an old binary, so generation 2 still checks for new
v1 writes before every effect and reports that limit honestly.

| V1 Run state at discovery | New-client behavior |
| --- | --- |
| Terminal | Read, list, report, and replay through the v1 reader; never append |
| Checkpoint waiting | If the exact boundary and reachable continuation are proven, remain generation 1 and answer through the pinned wrapper; otherwise require explicit freeze |
| Proven live legacy process | Watch and let it drain; the new supervisor neither adopts nor signals it |
| Open with no proven owner | No mutation; require explicit freeze after inspection |
| Damaged | Return a structured corruption error; never repair by guessing |
| Frozen release proof | Read-only forever |

Cutover scans indexed projects, registers terminal Runs as historical, pins the
compatibility runtime for supported continuations, and blocks project cutover
while a live or mutable v1 Run remains. Other projects are classified when
revisited. The registration lives in private user state and changes no evidence
bytes.

A resumed v1 Run stays v1. Its pinned runtime writes only v1 Trace and closes
through the v1 outcome model; a read-only adapter projects only facts present in
that evidence. Circuit
never mixes v2 lifecycle entries into a v1 Trace. If the runtime is missing,
the remedy names its exact reinstall or the explicit freeze command. Release N
learns to recognize storage v2 and refuse mutation before N+1 creates it.

### Pruning

The first `runs prune`, `plans prune`, or `flows drafts prune` call is always a
read-only batch-plan operation. It accepts one selector family and creates
`PruneBatchPlanV1`; only the later `--batch <id> --confirm <sha256> --yes` form
may move bytes. Explicit argv accepts at most 200 IDs. Larger explicit sets use
`--targets-file <path-or->`, a strict UTF-8 newline-delimited ID file whose
bytes/hash are copied into the plan; time selectors resolve once against a
recorded high-water. Malformed selectors or target files exit 2.

One batch has one target kind, one project instance (or one user-global draft
scope), and one compatible filesystem domain. `PruneBatchPlanV1` binds the ordered selected IDs, expanded
reference/evidence closure, eligibility result for every item, selector and
closure hashes, source high-waters/fence generations, item count, output
summary or `CollectionReferenceV2`, plan expiry, and resulting deletion
posture. A cross-project or cross-filesystem request exits 1 before plan commit
and returns bounded split-batch remedies. An ineligible member produces a plan
that cannot be confirmed; it names every blocker and moves nothing.

`PruneBatchPlanReceiptV1` is
`preparing|available|accepted|expired|superseded|committed|pruned`. Confirmation
CASes only an unchanged available plan. `BatchPruneTxnV1` then closes and
revalidates the complete fence set before the first move. If any reference,
access pin, eligibility fact, project identity, or high-water changed, it moves
nothing and returns a fresh-plan remedy. Before each later move it revalidates
every remaining source identity and every trash-target absence. Ordinary
recovery rolls forward in canonical target-ID order, but post-first-move path
drift enters the explicit recovery state below instead of touching unexpected
bytes or claiming a successful partial batch. Response loss returns the same batch
receipt. Per-item receipts are a bounded collection with an immutable overflow
reference. Expiry or explicit plan prune releases only a plan whose transaction
never reached its first move.

A whole root tree is eligible only when every Run
and linked Apply is terminal, every `TerminalMirrorV1` has reached
`terminal_cleanup_complete`, every lease and containment is proved closed,
every root Run append lock can be acquired and revalidated, every effect is
resolved, no compatibility runtime needs it, and it is not a release proof.
`--force` never bypasses these rules.

Selection expands to the full evidence-reference closure across source and
linked Apply roots; a partial request is previewed as the expanded set or
refused. No surviving Trace may point at deleted evidence.

Every command that turns a Run or plan into a new durable link uses
`ReferenceAcquireTxnV1`. This includes StartTicket/Run acceptance, later Apply
planning, evidence links, durable exports, and new runtime/content pins:

| Phase | Boundary and recovery |
| --- | --- |
| `reserved` | Private CAS verifies `ReferenceFenceV1=open`, captures its generation, allocates reservation/owner operation IDs, and binds source/target identities and expected content digest. Prune cannot close this generation while a reservation exists. |
| `materialized` | With no user-store lock held, the operation syncs its target artifact/receipt and records the exact target hash in its own transaction. Missing or mismatched target is abortable, never a link. |
| `committed` | Private CAS rechecks the same open fence generation, target transaction/hash, and reservation, installs the reference, then clears the reservation. |
| `aborted` | Recovery proves the owner process/transaction ended and no valid target committed, removes any orphan through its owning transaction, and CASes the exact reservation closed. Timeout alone never aborts it. |

If target materialization won but reference commit did not, recovery either
commits the exact link while the captured generation is still open or removes
the unreferenced target before allowing prune. A fence CAS requires zero
unresolved reservations for every closure member. Thus a client death cannot
make prune ignore an in-flight link or block it forever.

Finite short reads use `AccessPinV1`, acquired by CAS before the server opens
the source. Their pin is owned by the authenticated server connection or a
contained report/export worker plus its OS handle, not by an unverifiable
client timeout. Clean close releases it. After supervisor/worker death,
recovery proves that exact process and handle owner exited before release.

Durable tails are different. Their pin is owned only by the authenticated
`StreamOperationReceiptV1`, not by a connection, supervisor process, or
notification subscription. Connection or supervisor death CASes or recovers
an active receipt to `reconnect_grace` or a prepared terminal to
`terminal_delivery_grace` and retains the pin. A successor reopens that
same receipt before replay. Only `terminal_acknowledged` or a deadline-proved
`expired` CAS for the same untouched operation/connection generation may
release it; a client-local
transport error cannot. Missing receipt authority or source corruption keeps the fence
closed for repair rather than guessing owner death. `watch` and every attached
outcome stream use this rule. Prune waits for both finite and stream pins to
drain and admits none after its fence closes.

At `private_prepared`, prune uses only the user-store transaction lock to
atomically change every member of the recomputed closure from `open` to
`prune_prepared`, binding the reference high-water and fence generation, then
releases that lock. The CAS requires no unresolved acquisition reservation or
access pin. It next acquires every root Run append lock in canonical
Run-ID order and rechecks the complete closure and eligibility. If a reference
wins first, prune recomputes or aborts before a move. If the fence wins, every
new reference fails `PROJECT_BUSY` with wait and retry remedies. Abort releases
the Run locks before a private CAS returns members to `open` at that exact
generation; commit changes them to `pruned`. This fence remains through the
private/project commit, without taking a user-store lock while a Run lock is
held.

Within `BatchPruneTxnV1`, `PruneTxnV1` treats one source tree plus every later
linked Apply as an ordered multi-root closure:

| Phase | Required action | Recovery |
| --- | --- | --- |
| `private_prepared` | Reference fence is closed with zero reservations/pins; private manifest lists every root, trash item, reference, high-water, fence generation, and expected identity | Install exact project receipt or abort and reopen the exact fence generation |
| `prepared` | Matching project receipt is synced outside every source root | May begin moves |
| `moving` | Before each rename, revalidate all remaining source identities and trash-target absence; rename one root to its same-filesystem trash item and sync a per-root journal | Finish the next move, or enter `prune_recovery_required` on post-first-move drift |
| `prune_recovery_required` | While canonical Run locks are held, commit and sync the unexpected replacement/deletion/symlink/identity drift plus every moved/remaining identity; retain all fences, moved roots, journals, pins, and expected identities; then release the Run locks before returning the action | Run only the exact repair workflow below; a recovery worker reacquires every canonical Run lock and revalidates the receipt and all identities; no tombstone or purge |
| `moved` | Every item is in trash and all parent directories are synced | Commit private tombstones, locator, and references |
| `private_committed` | Private state no longer points to source paths | Commit the project receipt |
| `committed` | Both stores are committed | Delete private capsules/control records and trash |
| `purged` | Trash parents are synced | Done |

Before the first move, recovery may abort. After the first move, it normally
rolls forward, but it never moves, deletes, or overwrites a path whose identity
drifted. That case stops in `prune_recovery_required`; it does not roll back
silently or report success. In the ordinary path, Run append locks are held from
the post-fence recheck through `moved`, then released before the private commit
takes the user-store lock. In the drift path, the worker commits the drift
receipt under those locks, releases them, and only then returns exit 3. The
repair worker reacquires the complete canonical lock set and revalidates the
unchanged fence generation, drift receipt, moved trash identities, remaining
source identities, and unused trash targets before touching a path. The closed
reference fence prevents a new link in that gap. Cross-filesystem closure is rejected before preparation. Paths are
opened no-follow and rechecked by file identity. The tombstone retains Run IDs,
terminal outcomes and hashes, final cursor/high-water, protocol, prune time, and
idempotency-key hashes and expiry. It retains no goal or evidence content and
lets cursor lookup return stable `RUN_PRUNED`. Child-only prune is forbidden.

Prune drift repair is explicit:

```text
circuit repair prune show <prune-batch-plan-id>
circuit repair prune plan <prune-batch-plan-id> --strategy <retry-after-restore|abort-and-restore>
circuit repair prune apply --plan <prune-repair-plan-id> --confirm <prune-repair-plan-sha256> --yes
```

`retry-after-restore` advances only after every already moved root remains at
its recorded trash identity, every remaining source again has its expected
identity, and only the trash targets for those remaining sources are absent.
It then resumes the next remaining move; it never expects an already occupied
recorded trash target to disappear. `abort-and-restore` advances
only when each original destination for an already moved root is absent; it
restores exact moved roots, syncs every parent, then reopens the fences. An
occupied or changed destination produces a manual relocation remedy and touches
nothing. `PruneDriftRepairPlanV1` binds batch/drift generations, every moved and
remaining identity, strategy, expected restoration image, 15-minute expiry,
and `available|accepted|expired|superseded` state. Its apply transaction is
crash-safe and single-use. The original prune stream returns
`resolve_prune_drift` and exit 3; unrelated commands see
`PRUNE_DRIFT_BLOCKED`. A prune already in recovery defeats new Apply, mutation,
or reference acquisition until repair settles.

Plan prune uses the same private/project phase discipline for every artifact in
the confirmed batch. It accepts an expired selector or explicit unexecuted plans, and
first closes Run-plan availability through `PlanAvailabilityTxnV1` or the
Apply-plan CAS. It refuses any unresolved start/acceptance transaction or Run
reference after that closure. The plan receipt must be committed; the same
fence makes a start, abandon/expiry, and prune race choose exactly one winner
before the first move.

### Compatibility schedule

N is the guard release; N+1 is the first production storage-v2 writer.

| Contract | Minimum support |
| --- | --- |
| V1 command aliases, `--json`, `--progress jsonl`, and `uninstall --dir` | Through N+3 and at least 180 days after N+1; earliest removal N+4 |
| Production `--flow-root` execution | N warning only; rejected for new production work in N+1; parser emits migration remedy through N+3/180 days; earliest parser removal N+4 |
| V1 final envelope and progress writer | Same N+3/180-day window |
| Proven generation-1 legacy continuation through its pin | Through N+4 and at least 365 days after N+1; then the operator must freeze it and use inspect/export |
| Config v1/v2 writes | N only |
| Config v1/v2 read and explicit migration | Through N+4 and at least 365 days after N+1 |
| Terminal v1 Run, Trace, report, evidence, and release-proof readers | No scheduled removal; byte-golden CI remains |
| Creating new storage-v2 Runs | Current and immediately previous mutator protocol |
| Controlling an existing pinned Run | Its unrevoked execution bootstrap plus the current independently signed `CompatibilityControllerV1`; revocation still preserves cancel, inspect, reconcile, report, and export without executing revoked code |
| Runtime rollback payloads | Active, previous when globally compatible, last-known-good for the current storage/config protocol major, plus every live reference |

Removal requires inventory, a dated warning in doctor/version/affected command
for 90 days, and a tested remedy. Calendar time never overrides a live runtime
reference. A security revocation may stop execution sooner but preserves
inspection, settled cancel, no-spend reconciliation, reporting, and export
through the independent controller.

## Supported platforms

The initial artifact ABI floors to prove are:

| Target | Minimum environment before support claim |
| --- | --- |
| macOS arm64 | macOS 13 or newer |
| macOS x64 | macOS 13 or newer |
| Linux x64 glibc | glibc 2.28 or newer; kernel 5.15 or newer |
| Linux arm64 glibc | glibc 2.28 or newer; kernel 5.15 or newer |
| Windows x64 | Windows 10 22H2 or Windows 11, after the dedicated port |
| Windows arm64 | Later |
| Linux musl | Later |

Windows is a product port. Current CI excludes it because command shims and
spawn behavior are unsupported, and current connector termination uses POSIX
process groups. See [the CI matrix](../../.github/workflows/verify.yml) and
[connector subprocess control](../../src/connectors/subprocess.ts).

An ABI floor is not a lifecycle support claim. `PlatformCapabilityProfileV1`
has two public values:

| Profile | Required proof | Allowed behavior |
| --- | --- | --- |
| `full-durable` | Fixed bootstrap discovery for advertised transports, restart-on-failure user activation, one persistent supervisor authority, reopenable process-tree containment, complete execution-filesystem isolation, durable atomic replace/sync, and supported credential storage | Detach, reconnect, proved-topology crash recovery, durable checkpoints, isolated Runs, and bounded force cancel |
| `foreground-only` | Safe foreground spawn and the explicitly trusted in-place limitations | No detach, reconnect, automatic crash re-entry, parallelism, or durable-isolation claim |

On Linux, kernel and glibc versions alone are insufficient. `full-durable`
additionally requires a working systemd user service/socket, delegated cgroup
containment that passes daemonization escape probes, and the filesystem-view
adapter that proves every denied root and read-only mount. Missing any item
selects `foreground-only`; `--detach` and plans requiring durable isolation fail
`CAPABILITY_UNAVAILABLE` before Run acceptance. macOS and Windows make the same
decision from their activation, containment, and sandbox probes. Setup and
doctor show the detected profile and the exact missing capability.

`RootCapabilityV1` failure for the bootstrap or authority state is stricter
than this profile choice: no mutating Run starts at all until setup selects a
safe machine-local persistent root. `foreground-only` is available only when
authority and evidence roots are safe but workspace isolation or process
containment is insufficient for detach.

Each artifact records its actual OS and ABI floor; the support table moves only
after clean-machine proof. A checked `SupportTupleV1` catalog is the only source
of a support claim:

```ts
type SupportTupleV1 = {
  tuple_id: SupportTupleId;
  platform: PlatformTriple;
  capability_profile: 'full-durable' | 'foreground-only';
  transport: 'direct' | 'homebrew' | 'winget' | 'npm-global' |
    'npm-local' | 'claude-marketplace' | 'codex-marketplace';
  host: 'generic-shell' | 'claude-code' | 'codex';
  connector: 'claude-code' | 'codex' | 'cursor-agent';
  shell: 'bash' | 'zsh' | 'fish' | 'powershell' | 'host-managed';
  minimum_environment_sha256: Sha256;
  status: 'required' | 'foreground_only' | 'deferred' | 'unsupported';
};

type ReleaseSupportAttestationV1 = {
  signed_release_manifest_sha256: Sha256;
  tuple_id: SupportTupleId; semantic_row_sha256: Sha256;
  artifact_sha256: Sha256; host_version_range?: SemverRange;
  connector_version_range: SemverRange;
  gate_manifest_sha256: Sha256; attestation_signature: SignatureV1;
};
```

The catalog lists only applicable tuples. It never generates Homebrew-on-
Windows, WinGet-on-macOS, generic-shell/host-managed, or other meaningless
cross-products. `required` tuples block production; `foreground_only` tuples
must pass in-place operation and explicit detach/reconnect/isolation rejection;
`deferred` and `unsupported` tuples are not advertised and their installers
refuse unsupported artifacts. Adding or widening a non-floor tuple requires its
release-scoped attestation, signed artifact, exact tested version ranges, and
passing gate manifest in the same change.
`status: foreground_only` requires `capability_profile: foreground-only`, and
`status: required` requires `full-durable`; the schema rejects every other
pairing.

`MinimumProductionTupleSetV1` freezes exact tuple IDs and **semantic** row
hashes: platform, profile, transport, host, connector, shell, and minimum
environment/capability contract. Artifact and gate hashes never enter that
immutable floor. The table below is the semantic floor, expanded into one exact
row per parenthesized connector:

| Platform | Profile | Transport | Host | Connector | Shell |
| --- | --- | --- | --- | --- | --- |
| macOS arm64 | full-durable | direct | generic-shell | `claude-code`, `codex` | zsh |
| macOS arm64 | full-durable | homebrew | generic-shell | `claude-code`, `codex` | zsh |
| macOS arm64 | full-durable | claude-marketplace | claude-code | `claude-code` | host-managed |
| macOS arm64 | full-durable | codex-marketplace | codex | `codex` | host-managed |
| Linux x64 glibc | full-durable | direct | generic-shell | `claude-code`, `codex` | bash |
| Linux x64 glibc | full-durable | claude-marketplace | claude-code | `claude-code` | host-managed |
| Linux x64 glibc | full-durable | codex-marketplace | codex | `codex` | host-managed |
| Windows x64 | full-durable | direct | generic-shell | `claude-code`, `codex` | powershell |
| Windows x64 | full-durable | winget | generic-shell | `claude-code`, `codex` | powershell |
| Windows x64 | full-durable | claude-marketplace | claude-code | `claude-code` | host-managed |
| Windows x64 | full-durable | codex-marketplace | codex | `codex` | host-managed |

macOS x64, Linux arm64, npm compatibility, fish, and bash-on-macOS are explicit
`deferred` rows until their own gate manifests pass; Windows arm64 and Linux
musl begin `unsupported`. This does not weaken the target: Phase 7 cannot claim
the rebuild production-ready until every required row above passes. Deferred
rows may graduate independently without changing lifecycle semantics.

A floor row cannot be demoted, deleted, narrowed, or changed to foreground-only
by implementation status, a failed spike, or a catalog edit. CI compares the
checked floor-set hash and rejects such a change. If evidence shows a floor row
is impossible, work stops at that gate; changing the floor requires an explicit
revision of this product plan, its advertised claims and acceptance matrix, and
a new adversarial review. Non-floor rows alone may move among deferred,
foreground-only, and unsupported during implementation.

Every signed release has a complete `ReleaseSupportAttestationV1` mapping from
each floor tuple to that release's artifact, tested host/connector ranges, and
passing gate manifest. An N attestation cannot satisfy N+1. TUF/release
verification refuses staging or rollback when the selected release lacks one
current, unrevoked floor attestation. Key rotation signs a new attestation set;
artifact revocation invalidates only the affected release evidence, not the
semantic floor. A rebuilt artifact may replace it only after the same tuple gate
passes and new signed release metadata binds the replacement. Runtime authority
cannot activate between partial attestations.

Each current-release full-durable gate manifest covers only its declared transport, host, connector,
and shell: install, setup, Preview, one real isolated
Run, detach, reconnect, lost wakeup, process-tree cancel, checkpoint resume,
reboot recovery, update, rollback, staged uninstall, locking, atomic replace,
and terminal compatibility. Foreground-only manifests cover the same applicable
reads plus explicit rejection of every durable-only operation. Bash, zsh, fish,
and PowerShell completion generation is tested independently from support-row
claims. Signed artifacts, checksums, and provenance are part of every manifest.

`PlatformParitySetV1` is a separate gate. For each floor platform it names one
passing generic-shell direct tuple, its Claude-marketplace tuple, and its Codex-
marketplace tuple plus one shared semantic fixture corpus. That suite compares
plan, event, action, result, and exit meaning across the three frontends on a
multi-transport image. A marketplace tuple never pretends to execute another
frontend's journey, and a package-manager tuple tests only that manager.
`ReleasePlatformParityAttestationV1` binds that semantic parity-set ID to the
selected release's three artifacts, tested frontend/host ranges, shared-corpus
hash, result hash, and signature. Current complete floor and parity attestations
are both activation prerequisites.

The automated first-use benchmark uses a named clean image per required row and
runs only that row's declared frontend:
4 vCPU, 8 GiB RAM, empty Circuit and package-manager caches, no Node unless the
transport is npm, the named host/connector already installed and authenticated,
and a 100 Mbps link with at most 50 ms RTT to artifact storage. It measures from
the first Circuit install command through terminal spend receipt, excludes
third-party login and human decision time, and records both separately. The
fresh-user usability gate uses the same image but includes real human inspection
and confirmation. It recruits at least ten Circuit-new participants per
frontend: direct CLI, Claude, and Codex. Across that 30-person minimum, each
floor platform has at least three participants. Third-party login is
pre-provisioned, but participants receive no repository/cache knowledge or
assistance. Every participant must complete install, setup check, example init,
Preview Matrix, plan inspection, authorization, one real Fix, and spend receipt.
Any product-caused help or inability to finish is a failed session. The gate is
100% unassisted completion and p80 end-to-end time at or below five minutes for
each frontend. It also records median, p80, p95, mistakes, help usage, approval
comprehension, and detach comprehension. A failed frontend requires a product
repair and a fresh cohort for that frontend before production routing. Local
observation records only the study rubric; this adds no hidden telemetry.

## Delivery sequence

The phases below create one execution path early. They do not leave a complete
v1 and v2 orchestrator running beside each other until the last phase.

### Phase 1: characterize and separate roots

- Inventory every command, flag, output field, stream, exit, config shape, Run
  file, and host contract.
- Record each current leaf's N/N+1 default as `legacy_v1_final` or
  `legacy_v1_dual`, plus byte-golden omitted-format, `--json`, `--format json`,
  and `--progress jsonl` fixtures. For every leaf that can encounter a new
  pre-spend action, also freeze the exact per-leaf
  `legacy_v1_action_bridge` stdout, stderr, and exit bytes.
- Build `CommandSpecV2` from that inventory and add `check-command-spec` for
  parser, help, generated grammar, and four-shell completion parity.
- Add byte-golden v1 fixtures and N/N-1 readers.
- Characterize every v1 `ProgressEvent` type's required, optional, forbidden,
  and bounded fields, and inventory every current action choice/remedy plus its
  plain-CLI completion path.
- Introduce `ProjectContext` and the root resolvers.
- Introduce the Asset Provider and explicit source-development provider.
- Parse the raw config YAML syntax tree before defaults and characterize every
  V1/V2 injected default or sentinel, including absent, explicit, and injected
  `relay.default: auto` at every layer.
- Inventory existing attempt/time budget sources, any connector environment-
  name collisions (including Windows case variants and Circuit-reserved names),
  and same-project duplicate legacy Run IDs across all registered roots.
- Inventory every custom-Flow manifest/home, `--flow-root` parser/launcher/
  environment edge, host namespace capability and reserved projection name,
  Codex hook entry, and independently installed hook owner before designing
  their migration registries. Assign every legacy Flow entry an immutable
  candidate ID, record every collision, and freeze the first versioned reserved-
  name set before migration planning.
- Build `ExecutableEdgeInventoryV1` from actual activation environments,
  including PATH/npm/cache/cleanup/projection edges, executable-selecting
  environment variables, and every Circuit-like managed or unrecognized hook.
- Check in the exact semantic `SupportTupleV1` catalog, non-demotable
  `MinimumProductionTupleSetV1`, `PlatformParitySetV1`, release-support/parity
  attestation schemas, and gate-manifest schema.
  A floor spike must pass or block the plan. Only a non-floor spike may end as a
  named foreground-only/deferred/unsupported row; none remains an implicit
  promise.
- Check in the fresh-user study script, participant definition, success and
  assistance rubric, timing boundaries, local observation form, sample/platform
  minimums, and per-frontend 100%-completion/p80-five-minute thresholds.
- Correct the stale public `pursue` host sentence and reconcile the three
  superseded neighboring idea documents named below.
- Add the checked legacy dependency graph, including generated host entrypoints.

Gate: current direct, Claude, and Codex behavior passes through the
characterization harness without semantic drift.

### Phase 2: prove the dangerous seams

Run focused spikes before lifecycle contracts become ratified:

- parent, terminal, host, and supervisor exit while a worker runs
- terminal Trace committed while the exact worker and descendants keep running
- worker ownership across PID reuse, sleep, reboot, and supervisor restart
- supervisor death after every call from role-neutral launch reservation through
  durable slot creation, atomic child placement, budget arm, identity sync,
  gate release, readiness, and exact exit for init/control/recovery/execution
- cancellation during relay, verification, fanout, child Run, and apply
- supervisor death followed by force-cancel of an unresponsive contained worker
- client death before/after StartTicket approval and every Run-acceptance phase
- hard-budget guardian arm/warning/termination with client, worker, guardian,
  and supervisor death, cross-boot conservative time settlement, and an effect
  that ignores graceful stop
- crash before and after every effect intent and receipt
- crash around every engine await and safe-reentry append for linear, retry,
  loop, fanout, child, checkpoint, recovery-corridor, and Apply topology state
- crash before and after every Apply prepare, commit decision, path install,
  drift block, and receipt boundary, including an external writer in the final
  check-to-replace window for each exclusion profile
- checkpoint parking and two-answer races
- root-tree Trace ordering plus live tail at every attach boundary
- torn, partial, corrupt, disk-full, and failed-fsync Trace and artifact writes
- client, worker, and effect credential isolation, denial of private, base,
  evidence, and peer roots, setsid/double-fork escape, Job breakaway, and
  replayed RPC requests
- Git dirty snapshots, non-Git copy-on-write, digest-bound ignored dependencies,
  apply conflicts, and symlink/absolute-path escape attempts
- private Node packaging, SEA packaging, and active-runtime update
- update with active, parked, and reconciliation Runs pinned to old runtimes
- global rollback across incompatible installed frontends and mixed project
  generations
- first-install archive/root substitution for every transport and durable-root
  relocation or runtime-endpoint loss across logout/reboot, shared-home machines,
  unsafe filesystems, concurrent transports, activation rebinding, and fixed-
  discovery-slot registration
- config v1/v2 to v3 projection over a real golden corpus
- exact config restore before and after its reader floor, plus signed current-
  schema projection
- private-state backup export/import/restore, changed-machine rebind versus
  data-only recovery, and evidence-only project adoption
- cross-lane online backup generation rotation and concurrent comment-preserving
  config CAS writes
- required child Apply versus later root Apply admission, mutation-domain merge
  across a parked Run, directory durability after Apply rename, and every phase
  of reference acquisition racing prune
- StartTicket decline/expiry/start/prune races, Run-plan
  abandon/expiry/ticket/acceptance/prune races, project instruction-detach
  partial results, ProjectAware select/assert mismatches, typed action inputs,
  caught-signal endings, and filtered-view cursor invariance
- crash at every endpoint-publication generation and self-probe boundary while
  old workers survive; reconnecting clients must discover one live endpoint
- crash at every `EffectWorkspaceTxnV1` preimage/layer/promotion/discard phase
  and every `ResolutionReentryTxnV1` or `ResolutionCancelSettlementTxnV1`
  ledger/workspace/reducer/boundary/enqueue phase, plus mixed-ledger promotion,
  discard, and abandon quarantine in `ResolutionTerminalSettlementTxnV1`
- Apply-plan create/retry/expiry/abandon/accept/prune races and source-reference
  transfer after response loss
- recursive no-follow legacy Run-store discovery from nested cwd, explicitly
  enrolled external legacy roots, and incomplete-scan admission blocking
- sealed environment and secret material capture followed by client death,
  shell environment drift, reboot, connector restart, and credential rotation
- exact-tail and disaster-point backup restore with later private-state tails,
  unreachable projects, epoch invalidation, and death at every pointer swap
- custom Flow draft/promotion/replacement/retirement/GC and legacy-registry
  migration, including collisions, mutable legacy paths, and host-projection
  failure
- Codex hook install/migration/update/uninstall with malformed files,
  concurrent edits, multiple installation owners, and old-launcher retention
- list high-water/keyset pagination under concurrent insert/delete, oversized
  plans through chunk reads, every SIGHUP/SIGINT/SIGQUIT/SIGTERM ending, and
  repeated catchable signals during the masked final-frame deadline
- private loss or forged project Trace after every
  `QueueAuthorityReceiptV1`/`SafeReentryAuthorizationV1` prepare, evidence
  append, private mirror, and runnable phase; project evidence must never mint
  queue or re-entry authority
- checkpoint death before and after `pending`, `topology_prepared`, `drained`,
  `waiting`, private mirror, and Invocation exit; settled permits without a
  complete topology candidate must become interrupted, never answerable
- all `BootEpochExitProofV1` branches: safe boundary to interrupted re-entry,
  open effect to reconciliation, committed Apply to settlement-only, and
  unverifiable boot identity to ownership-unknown plus tuple rejection
- stale `MutationDomainAcquireTxnV1` resolver versus alias publication and
  every `MutationDomainMergeTxnV1` fence/barrier/redirect sync; no waiter may
  mutate through an old generation
- all Apply-drift strategies, repair-plan response loss/expiry/supersession,
  checkout drift after confirmation, and death at every
  `ApplyDriftSettlementTxnV1` phase; no terminal result or lock/reference
  release may precede a settlement receipt
- lost wakeup, commit-between-replay-and-subscribe, slow consumer, supervisor
  restart, token replay/wrong caller, prune during reconnect grace, and terminal
  Trace before final delivery for every `DurableTailSessionV1` stream class
- crash and competing reference acquisition at every `ContentGcTxnV1` prepare,
  move, directory sync, registry tombstone, and purge boundary
- crash at every `EffectDispatchAttemptV1` reservation/dispatch/receipt/unknown
  state; unknown usage consumes its full bound, each retry reserves separately,
  and a billable/token/quota-consuming read cannot claim `pure_read`
- raw config migration fixtures for absent/explicit/injected legacy sentinels;
  connector executable, interpreter, script, managed-package, and symlink swaps
  before plan/start/spawn, including the final check-to-exec window
- legacy discovery across nested config anchors, Git repositories/worktrees,
  submodules, foreign generation markers, unreadable boundaries, and overlapping
  non-Git projects; a parent may never enroll, freeze, prune, or purge a child
- two projects publishing different bytes under one Flow ID, every reserved
  CLI/host/protocol ID, hosts with and without project-local namespaces, and
  failed/rebuilt projections without a conflicting global Claude/Codex file
- out-of-band Homebrew/WinGet/npm/marketplace replacement/removal, deleted npm-
  local roots, environment redirects to pre-N binaries, and unrecognized hook
  resolution across every `InstallationRepairPlanV1` classification; a
  `present_exact` plan must type-check only as `no_change`, never as confirmation
- recovery-key purge crash cases for retain/destroy, reinstall then restore,
  destroy then restore refusal, key-deletion failure, and proof that user-owned
  connector credentials are untouched
- strict action/source-command context, stale reconciliation decision and
  continuation tokens, impossible page/chunk/remedy/choice shapes, and frame
  externalization at every item/string/argv/1-MiB/4-MiB boundary; compile-time
  negative fixtures cross every action/command pair, including transport update
  versus uninstall
- `PruneBatchPlanV1` mixed eligibility, cross-project/filesystem targets,
  selector/targets-file drift, response loss, and death after each moved item;
  before-first-move drift aborts, while later replacement/deletion/symlink/
  identity drift enters `prune_recovery_required` and proves both repair
  strategies without touching unexpected bytes; crash around drift-receipt
  commit, lock release, repair-lock reacquisition, moved-trash validation, and
  remaining-source/trash validation preserves the exact fence and predicates
- staged uninstall disposition, per-Run force decision, reconciliation, manager,
  response-loss, and cleanup-shim boundaries with no generic force bypass
- consequence-free and approval-bearing starts for fresh Run, detached Run,
  no-input Run, `run --plan`, and `flows generate`; forged, stale, or swapped
  `NoApprovalRequiredReceiptV1` and `ApprovalDecisionV1` must fail before
  acceptance, while unnecessary `--yes` is rejected
- byte-golden `legacy_v1_action_bridge` output on every characterized no-flag,
  legacy-`--json`, and `--progress jsonl` leaf that can reach a new N+1 action
- `ReconnectExpiryPermitV1` issuance only after cursor acknowledgement, client
  expiry while the supervisor remains absent, old-permit versus newer-reattach
  races, successor expiry CAS and pin release, permanent supervisor absence and
  safe pin leakage, and proof that no post-expiry reattach remedy is emitted
- every `ForegroundInvocationTxnV1` boundary with controller death, worker
  death, `EPIPE`, output loss with no possible final frame, open-effect
  uncertainty, exact exit, ownership-unknown, and legal versus rejected
  `resume --foreground`
- missing, forged, wrong-Run, wrong-transaction, stale-high-water, duplicate,
  superseded, crash-before-claim, and crash-before-consume
  `RecoveryWorkReceiptV1` cases
- pre-authorized and newly confirmed `ReconciliationProbeTxnV1` paths, including
  invalid query/key schemas, insufficient approval, duplicate permit, every
  reservation/dispatch/receipt boundary, response loss, unknown query outcome,
  budget exhaustion, cancellation, and proof that no engine or primary effect
  runs under `reconciliation_probe_only`
- `result_materialization` parser/plan/result cases proving `base_checkout`
  rejects automatic Apply, settlement permits, and later Apply without creating
  a plan, child Run, queue item, or effect, while `isolated_patch` retains the
  ordinary Apply path
- enrollment and project relocation racing an active
  `MutationDomainBlockV1`; no merge generation or redirect may publish until
  the Apply is settled and a fresh merge plan is created
- root cancel, Apply cancel, and checkpoint drain through `confirm_force`,
  `ForceDecisionV1` creation, response
  loss, copied decision ID under another OS user, same-user completion, wrong
  Run, stale generation, expiry, duplicate consume, and process-list/shell-
  history inspection proving no bearer containment capability appears in argv;
  the first checkpoint-drain action exposes only wait or cancel and contains no
  direct force argv before a `ForceDecisionV1` exists
- screen-reader line-filter transcripts for origin/cursor activation,
  suppression counts, clear-without-replay, and explicit historical replay, plus idle and
  active-prompt resize transitions in both directions
- `ProjectRelocationTxnV1` on a same-identity rename/move, copy and replacement
  rejection, path-sensitive grant invalidation, projection rebuild, response
  loss, and death at every fence/marker/locator/projection/private-commit phase;
  pre-`domain_published` failure may restore old bindings, while every failure
  at or after that boundary preserves redirects and rolls forward
- every `LegacyFlowCandidateV1` disposition, explicit rename, missing/duplicate
  decision, built-in collision, response loss, and cutover blocking; update a
  reserved CLI, built-in, host, and protocol name over an existing active custom
  Flow and prove warning, qualified continued use, unqualified conflict, direct-
  projection removal, and receipt history
- late N frontend install, downgrade, or restored host cache after N+2;
  quarantine must not enter authority closure, and only one compatible
  `InstallationPromotionTxnV1` may activate it
- death and response loss at every direct and manager-backed
  `FrontendUpdateTxnV1` phase for update and rollback, proving launcher,
  activation, frontend receipt, runtime authority, rollback pin, and manager
  subtransaction converge together; failure before
  `receipt_head_and_authority_committed` may restore the old binding, while
  failure at or after that CAS only rolls every committed component forward
- Recovery Anchor `retain` as a no-change install refusal, restore, and
  destroy-and-initialize, with death before and after slot transition, key
  deletion, new-root commit, activation, and cleanup
- two copied legacy projects containing the same terminal and nonterminal Run
  IDs, ambiguous exact-ID lookup outside a project, explicit mutable-origin
  choice, inspect-only clones, and generation-2 admission
- compile-time and runtime negative fixtures for every nonempty, at-least-two,
  inline/total/overflow, bounded cursor/preview, bounded argv, action/command,
  and Run-result refinement introduced by protocol 2
- one positive and missing/extra/wrong-branch/oversize/wrong-sequence/wrong-
  cursor/wrong-event-ID fixture for every `ProgressEventTypeV2`; replay through
  all frontends must be byte-identical and no unmapped type may compile
- action/remedy fixtures rejecting prose-only, documentation-only,
  structured-without-CLI-equivalent, retry-safe non-command, a retryable error
  without a named inline retry-safe command, a nonretryable error containing
  one, and missing or duplicated input-slot actions; every exit-3 frame must
  complete through plain CLI and structured RPC
- EOF before/after every prompt render, partial input, selection, decision CAS,
  durable viewer action, stdin payload, and foreground boundary; plus first and
  repeated Ctrl-C per command and filter activation at origin before any event
- stream opening response/permit loss and death before/after origin permit ACK,
  terminal prepare/write/ack/CAS, terminal-delivery reattach, expiry, and prune;
  no pin releases before terminal acknowledgement or proved expiry
- root cancel, Apply cancel, and checkpoint drain through every
  `ForceEscalationReceiptV1` state, wrong source/consumer, stale boundary,
  expiry, response loss, duplicate decision/force, and unknown containment
- every required-child Apply outcome crossed with parent cancellation ordering
  and death between child terminal and parent close; exactly one mapped parent
  outcome and no engine re-entry
- Apply drift admission matrix: its own repair plan succeeds under the block,
  every unrelated plan/start/snapshot/merge/relocation/prune fails without an
  artifact, and repair-plan/settlement races revalidate the block generation
- claim-bearing recovery roles raced against queued and active execution at
  claim reservation, lock acquisition, gate release, and exit; never two
  claim-bearing root workers in one project
- concurrent frontend updates from one prior receipt, update versus promotion,
  rollback versus update, stale heads, and response loss; only one
  `FrontendInstallationHeadV1` wins and historical receipts never join closure
- new Run versus uninstall prepare/apply, two simultaneous final-frontends,
  update/repair/promotion versus uninstall, and crash at every
  `UninstallAdmissionTxnV1` boundary, including fence before inventory,
  prepared exact Run set, final disposition link, and abort reopening
- budget values from shipped/user/project/invocation sources, tighter-only
  reducers, threshold approvals, unknown or changed pricing/capability, quota
  normalization, reservation exhaustion, and header/enforcement equality
- project relocation into an enrolled ancestor or nested Git root, move out of
  an existing merge, active-holder/stale-alias races, and every composed
  relocation/domain-publication crash boundary
- same-project duplicate legacy display IDs across a normal store and copied
  external root, identical-terminal aliasing, different terminal evidence,
  mutable-origin races, qualified mutations, and generation-2 blocking
- N-to-N+1 support-attestation rollover, rebuilt artifacts, key rotation,
  revocation/replacement, incomplete floor/parity mappings, and rollback to an
  older still-attested release
- death around every reserved-name registry/projection/frontend-head/runtime-
  authority boundary, host-invocation gate, installed projection postimage,
  and gate release; activation shows either complete old or complete new
  resolution, cached commands must re-enter the generation-checking launcher,
  and unverifiable host state quarantines before the central CAS
- connector environment exact duplicates, Windows case variants, reserved
  Circuit names, legacy manual migration, and post-grant changes; all fail
  before secret capture and executed environment equals the normalized grant
- PTY fixtures at 79/80/99/100 columns and 23/24 rows, including resize during
  every action prompt with token, cursor, selection, and typed input preserved

The spikes use Circuit's recorded friction cases: relay inactivity kills,
complete diffs left after process death, interrupted resume, and reused-child
recovery. A spike ends with a pass, a rejected approach, or a named blocker.

### Phase 3: ratify two contract rings

Ring A can land from current behavior and Phase 1 evidence:

- project and storage roots
- command and compatibility map
- output, error, exit, bounded-frame, reconnect, legacy-presentation, and
  `AllowedActionByCommandV2` tables, including the per-leaf
  `legacy_v1_action_bridge`, executable-action/remedy refinements, EOF, filter,
  and command-specific signal semantics
- config v3 plus trust and migration, including `LegacyConfigProjectionV1` and
  `ConnectorExecutableClosureV1`, `BudgetPolicyV3`, budget/threshold reducers,
  and `CircuitReservedEnvironmentSetV1`
- fixed bootstrap discovery and install registration, user root-set authority,
  first-install bootstrap trust, runtime authority, global rollback and config-
  reader closure, release trust, and protocol negotiation
- transactional config writes and cross-lane private backup snapshots
- root relocation activation bindings, machine rebind, and authenticated backup
  export, plus `ProjectRelocationPlanV1`/`ProjectRelocationTxnV1`
- custom Flow registry/draft ownership, host-hook ownership, bounded list and
  plan-artifact reads, and the exhaustive native Run result schema
- `ProjectionReservedNameSetV1`, host projection identity, explicit
  `--flow-root` sunset, `ExecutableEdgeInventoryV1`, installation repair,
  staged uninstall, recovery-key disposition, batch-prune plans, content GC,
  `LegacyFlowCandidateV1`/`FlowMigrationDecisionV1`,
  `SourceCheckoutAssetProviderV1`, `RecoveryAnchorTxnV1`, frontend quarantine
  and promotion, `FrontendInstallationHeadV1`, same-project
  `LegacyRunCollisionSetV1`, and the checked semantic `SupportTupleV1`,
  `MinimumProductionTupleSetV1`, `PlatformParitySetV1`, and release-attestation
  catalogs

Ring B follows the Phase 2 probes:

- Run and Invocation state machines
- supervisor RPC, lease, fencing, and cancellation
- `QueueAuthorityReceiptV1`, `SafeReentryAuthorizationV1`, private mirrors, and
  the complete checkpoint topology/Invocation-exit boundary
- role-neutral `InvocationLaunchTxnV1`, `RecoveryWorkReceiptV1`,
  `ForegroundInvocationTxnV1`, claim/lock matrix, and exact exit mirroring
- RunPlanV1 and idempotent start
- Run-plan availability, abandon/expiry, and ticket/acceptance fencing
- StartTicket/`StartAuthorizationV1` with both authorization variants, and the
  hard-budget guardian
- active-time reservation, atomic budget arm/gate release,
  `BootEpochExitProofV1`, and cross-boot conservative settlement
- effect intent, `EffectDispatchAttemptV1`, receipt, reconciliation tokens,
  `ReconciliationProbePlanV1`/`ReconciliationProbeTxnV1`, and complete safe-
  reentry receipts
- per-effect workspace transactions and resolution-ledger safe-reentry
- Apply-plan lifecycle, `InTreeApplyCompletionTxnV1`, drift-block admission,
  and source-reference transfer
- complete `ProgressEventPayloadByTypeV2`, `StreamOperationReceiptV1`,
  origin/terminal acknowledgement, `ReconnectExpiryPermitV1`,
  durable tail/reconnect cursor, bounded backpressure, and transient liveness
- workspace snapshot, `MutationDomainAcquireTxnV1`/merge, durable Apply and
  drift-repair lifecycle, reference acquisition/prune fencing, and conflict
  handling, including `prune_recovery_required` and its repair plan
- `FrontendUpdateTxnV1`, `InstallationPromotionTxnV1`,
  `ReservedNameCompatibilityTxnV1`, `UninstallAdmissionTxnV1`,
  `ForceEscalationReceiptV1`, and `ForceDecisionV1` lifecycle and recovery

### Phase 4: build a no-effect control-plane slice

Build `plan -> accept -> start -> detach -> watch -> wait -> cancel` for a
purpose-built worker fixture that cannot dispatch a connector, command,
filesystem write, or external request. Prove supervisor election, restart
barrier, PlanReceipt, StartTicket with both `StartAuthorizationV1` variants,
launch-slot ownership,
worker-held locks, root-tree sequence, handshake, output, and host protocol
negotiation. Emit every no-effect lifecycle member through the strict
`EventFrameV2` map and complete every action through plain CLI, direct RPC,
Claude, and Codex. Freeze attach/detach x consequence-free/approval-bearing x
TTY/plain/JSON/NDJSON, EOF, origin filter, and command-specific Ctrl-C
transcripts. Kill notifications, endpoint, supervisor, and clients during every
stream to prove durable high-water rechecks, authenticated reattach, bounded
slow-consumer failure, terminal-frame deduplication, and access-pin retention
through opening, reconnect, and terminal-delivery grace. Exercise origin permit
acknowledgement, terminal prepare/write/ack, acknowledgement-bound
`ReconnectExpiryPermitV1`, permanent supervisor absence, newer-reattach and
prune races, fresh post-expiry watch/wait remedies, and no post-expiry reattach.
Add intentionally unresponsive root/Apply/checkpoint fixtures for every
`ForceEscalationReceiptV1` transition, claim-bearing recovery fixtures, and
Trace-only nonclaiming controls. Run the same
fixture through `ForegroundInvocationTxnV1` and prove every controller/worker/
pipe-death result. Byte-golden the N+1 action through each legacy presentation.
Cancellation is allowed only before the
fixture's synthetic terminal event.

Do not route production `run` through this slice. Claude and Codex participate
against the fixture so host migration begins without exposing unsafe work.

### Phase 5: build the first safe real-Run slice

- Introduce the ordered effect admission boundary and Trace intent/receipt
  entries.
- Add worst-case budget reservation, `BudgetExpiryTxnV1`, and the prearmed
  containment guardian before any execution gate release. Resolve
  `BudgetPolicyV3`, tightening invocation flags, and approval thresholds into
  the exact header/reservations; reject unenforceable USD caps before PlanReceipt.
- Thread cancellation through the runner, every executor, fanout and child
  Run, connector, verification, Git, and apply.
- Replace blocking subprocess calls and prove each platform containment
  adapter, including escape probes and Job Object termination.
- Add isolated root workspaces and worker-held serialized base apply.
- Replace linked fanout worktrees with sealed-pack branch workspaces and prove
  every join policy advances the parent digest correctly.
- Add `EnqueueTxnV1`, `InTreeApplyTxnV1`,
  `InTreeApplyCompletionTxnV1`, `SnapshotBarrierV1`, permanent
  mutation-domain aliases plus acquire/merge transactions, per-effect
  containment, phased `TerminalMirrorV1`,
  `ReferenceAcquireTxnV1`, access-pin ownership, reference fencing, and
  batch/multi-root prune failure injection.
- Make `result_materialization` mandatory in plans and results. Admission must
  reject automatic/later Apply and settlement authority for `base_checkout`,
  and `apply <run-id>` must return `APPLY_NOT_APPLICABLE` before creating any
  plan or effect.
- Add checkpoint parking, complete topology preparation, fenced answer, and
  short control workers. Queue and checkpoint paths require private
  `QueueAuthorityReceiptV1`/`SafeReentryAuthorizationV1` plus their mirrors.
- Add `SafeReentryReceiptV1`, complete topology artifacts, and versioned
  reducers for every topology admitted to automatic re-entry. Effect safety
  alone never resumes a Run; park unknown effects and return continuation-
  unavailable when no exact receipt exists.
- Require a single-use `RecoveryWorkReceiptV1` before every recovery-role
  launch; the startup barrier alone is never enough. Generate and enforce the
  claim/lock matrix for probe, workspace reducer, settlement, execution,
  Trace-only control, and foreground work.
- Add `EffectWorkspaceTxnV1`, `ResolutionReentryTxnV1`,
  `ResolutionCancelSettlementTxnV1`, and `ResolutionTerminalSettlementTxnV1`;
  no resolved effect can re-enter the engine until its isolated layer is
  promoted or discarded and the pinned reducer commits a new safe-reentry
  receipt, while cancel and mixed-outcome abort settle every layer without that
  engine authority.
- Add `EffectDispatchAttemptV1` and charge every physical retry separately;
  reject billable reads from the `pure_read` recovery class.
- Add `ReconciliationProbePlanV1`, `ReconciliationProbePermitV1`, and
  `ReconciliationProbeTxnV1` with their public plan/apply action and the
  `reconciliation_probe_only` launch profile. Probe attempts receive their own
  containment and worst-case reservation and cannot enter the engine.
- Add `ApplyPlanTxnV1` and `ApplyPlanAcceptanceTxnV1`, including expiry,
  abandon, prune, idempotent planning, and source-reference transfer.
- Add `ApplyDriftRepairPlanReceiptV1`, `MutationDomainBlockV1`, and
  `ApplyDriftSettlementTxnV1`; a post-commit drift remains nonterminal and
  blocks every unrelated plan/mutation while still admitting its exact shared-
  barrier repair plan and exclusive settlement.
- Reject mutation-domain merge, enrollment, and relocation while any source
  domain has that block; settlement must finish before a fresh merge plan.
- Add `ForceEscalationReceiptV1`, `ForceActionV1`, and `ForceDecisionV1` for
  root, Apply, and checkpoint sources; force accepts only the non-bearer
  decision ID over same-user RPC and never a containment capability in argv.
- Add `BootEpochExitProofV1`, `DurableTailSessionV1`,
  `StreamOperationReceiptV1`, `BatchPruneTxnV1`,
  `PruneDriftRepairPlanV1`, and `ContentGcTxnV1` before a
  platform can pass the real-Run durability gate.
- Run one isolated Review end to end, including cancel during each effect.

Then expand the developer-only gate before production:

- Run a no-spend lifecycle fixture for every public Flow: Fix, Build, Review,
  Explore, and Prototype.
- Cover each distinct execution topology: linear steps, fanout relay, child
  sub-run, checkpoint park/answer, loop/retry, and linked Apply.
- Run one real contained effect for every unique topology and connector
  capability profile.
- Emit every real-Run event through its mapped strict V2 member, and cross every
  required-child Apply outcome/cancel order plus both prune-drift repair paths.
- Prove the same plan, event meaning, action-required response, and outcome
  through the direct CLI, Claude, and Codex adapters.

This slice stays developer-only. Passing it is necessary but does not authorize
any production frontend to create storage-v2 Runs.

The old execution writer loses a consumer after each slice. CI fails when a
new consumer imports it.

### Phase 6: finish runtime and configuration ownership

- Ship the Release N project-generation guard in every current frontend while
  it remains a v1 writer.
- Build `ExecutableEdgeInventoryV1`; guard, repair, explicitly classify, or
  tombstone every PATH/npm/host-cache/marketplace/activation launcher,
  executable-selecting environment redirect, generated projection, cleanup
  stub, and Circuit-like host hook. An unresolved edge blocks cutover.
- Enroll markerless projects through `LegacyProjectEnrollmentV1` before the
  guard can treat marker loss as corruption.
- Ship the shared runtime store, singleton runtime authority, compatibility
  controllers, transport-specific `InstallBootstrapV1`, and TUF-compatible
  release metadata. No transport is advertised until its first-executable trust
  test passes.
- Route direct, package-manager, npm, and marketplace update/rollback through
  `FrontendUpdateTxnV1` with one CASed `FrontendInstallationHeadV1` per
  installation and one serialized frontend-set generation. Admit incompatible late or restored frontends only as
  `quarantined_incompatible`; activate them solely through
  `InstallationPromotionTxnV1` after the full closure passes.
- Ship `BootstrapDiscoverySlotV1` and `InstallRegistrationTxnV1` before a second
  transport can install; generic launchers never embed a selected root.
- Prove the private Node package, then compare SEA with the same tests.
- Add setup, init, update, uninstall, and project instruction detach.
- Ship the explicit Recovery Anchor show/plan/apply state machine before a
  retained-key reinstall is supported. `retain` refuses installation without
  change; restore and destroy-and-initialize use `RecoveryAnchorTxnV1`.
- Ship `repair installation plan/apply` before update or uninstall may claim
  an out-of-band package-manager state is repaired. Every manager classification
  and ambiguous refusal is part of its gate; repair never changes runtime
  authority.
- Ship staged uninstall plan/prepare/apply, transport-neutral draining shim,
  `UninstallAdmissionTxnV1`, ordinary per-Run force/reconciliation actions,
  `CredentialInventoryV1`, and
  explicit retain/destroy recovery-key purge. No one-step force path remains.
- Add `FlowRegistryV1`, immutable draft-ID promotion and replacement, legacy
  custom-Flow migration, and `HostHookRegistrationV1`/`HostHookWriteTxnV1`
  before any transport update or uninstall claims ownership completeness.
- Migrate or classify every legacy custom Flow and projection, reject production
  `--flow-root` at N+1, and keep source checkout execution on its separate
  verified provider. Every candidate receives import-with-explicit-scope/name,
  retire, or freeze-inspect-only disposition. Unresolved migration cannot
  extend the adapter deadline. Update compatibility versions reserved names and
  grandfathers a colliding active Flow only under its qualified canonical ref;
  `ReservedNameCompatibilityTxnV1` joins registry/projection changes to the
  frontend-head/runtime-authority activation CAS.
- Add authenticated private-store backup export/import/restore, machine rebind,
  unreachable-project retirement, legacy root migration, external-manager
  completion, and compatibility-closed config migration/restore.
- Add same-identity `ProjectRelocationTxnV1` and copied-project classification.
  Compose overlap-changing moves with `MutationDomainMergeTxnV1` and keep moves
  out of an existing merge conservatively serialized. Legacy Run lookup uses
  root-qualified record IDs; terminal copies remain historical,
  and nonterminal copies are inspect-only unless one explicit origin decision
  proves the sole mutable owner. Same-project collision sets must also close.
- Prove machine-scoped bootstrap/state capabilities, root-independent election,
  whole-root relocation plus activation cold start, online backup generation rotation, and
  `ConfigWriteTxnV1` before setup may mutate them.
- Ship v3 readers to every supported client.
- Ship raw-syntax-tree config projection, sentinel-equivalence fixtures, and
  `BudgetPolicyV3`/approval-threshold reducers,
  `CircuitReservedEnvironmentSetV1`, and executable-closure grants before
  enabling v3 writes. A connector grant is
  re-proved at plan, start, and spawn against immutable executed bytes.
- Migrate every official host to explicit v2 negotiation without yet enabling
  storage-v2 mutation.
- Register v1 Runs, prove complete supported continuation classes, pin wrapper
  runtimes, and drain or explicitly freeze legacy writers per project.
- Ship `ContentGcTxnV1` for runtime, Flow, plan, workspace, projection, and
  backup content; unfinished sweeps are visible to `repair inspect`.
- Port and prove every semantic floor `SupportTupleV1` and
  `PlatformParitySetV1`; generate a complete signed current-release support and
  parity attestation mapping plus reproducible clean study images. A missing
  current-release proof blocks Phase 7. Only non-floor rows may be reclassified
  without revising this plan.

Homebrew, WinGet, npm, and marketplace polish can proceed as separate transport
work after one artifact passes.

### Phase 7: open the production gate and finish the human surface

Before evaluating the production gate, finish the plan header and hash-bound
confirmation path, generated `CommandSpecV2` help/completion, the slim home and
`watch` TUI, line-mode accessibility, typed remedies and frame unions, and the
exact exit/action test suite. None of these may trail production routing.
Run the checked fresh-user study on the reproducible Phase 6 images. A failed
frontend returns to product repair and a fresh affected cohort; study results
cannot be waived into the gate.

The first production storage-v2 writer waits for all nine named gates:

1. The project's generation-2 marker bytes and matching private transaction are
   prepared, while the committed marker remains generation 1.
2. Every active v1 owner has drained.
3. Every nonterminal parked v1 Run is terminal or explicitly frozen; no mutable
   legacy continuation remains.
4. Every live runtime pin, unrevoked execution bootstrap, and independent
   compatibility-controller path passes recovery; every installation has one
   current non-forked frontend head and every selected release has complete,
   current, unrevoked floor/parity attestations.
5. `ExecutableEdgeInventoryV1` has no unguarded or unresolved executable edge,
   every enrolled legacy root is in the committed discovery closure, every
   same-project legacy Run collision set is closed,
   Circuit-like hook is managed or explicitly classified non-Circuit, and every
   active Codex hook resolves through a current stable-control receipt.
6. Config v3 readers, Budget Policy/environment-name validation, and generation
   guards are active in every supported frontend.
7. Direct CLI, Claude, and Codex all enforce protocol negotiation, the same
   generation guard, explicit format, StartTicket plus both
   `StartAuthorizationV1` variants, two-call machine confirmation only when
   approvals remain, typed frame union, bounded list/artifact reads,
   mapped strict events, executable action/remedy unions, 1-MiB terminal frames,
   opening/terminal-acknowledged stream reattach, exhaustive Run results,
   generated source-command/action relations, legacy presentation defaults,
   EOF/filter semantics, and every exit/action-required/signal rule.
8. The all-Flow, all-topology, connector, cancel, effect, isolation, and Apply
   matrix passes on every floor `SupportTupleV1` through that row's declared
   frontend only. Separately, every `PlatformParitySetV1` multi-transport image
   proves the shared semantic corpus through direct CLI, Claude, and Codex.
   Both gates include exact 79/80/99/100 by 23/24 TUI/line action parity,
   structured Flow-generation input, staged uninstall/purge recovery, and the
   measured first-use Fix plus the 100%-unassisted and per-frontend p80
   five-minute human-study thresholds below.
9. One cutover barrier rechecks gates 2–8, the executable-edge inventory, and the
   semantic-floor hashes, current-release attestation mapping, and v1 file
   high-water, then commits the exact generation-2 marker and private
   mirror before releasing any v2 writer.

Only after those gates:

- Route direct `run`, Claude, and Codex through that single production path.
- Enable explicit Config v3 migration after the N/N-1 gate passes.
- Publish the already-gated command namespaces, aliases, completions, home, and
  viewer together.

An optional tour follows the real lifecycle. Circuit does not simulate a Run to
hide missing setup.

### Phase 8: cut over and delete

- Flip current commands to default human output in N+2 at the earliest, after
  the explicit-format host gate and one release of warnings.
- Keep v1 command and output adapters through N+3 and 180 days after N+1.
- Reject production `--flow-root` in N+1, retain only its no-execution migration
  error through N+3/180 days, and delete that parser/launcher/environment node
  at N+4 once the registry/source-provider tests pass.
- Delete old orchestration writers as their dependency-graph reachability
  reaches zero.
- Keep terminal v1 Run, Trace, report, evidence, and release-proof readers
  indefinitely; keep config migration through its N+4/365-day floor.
- Remove writer/presentation adapters only after their exact schedule and
  warning gates pass.

The final tree has one control plane and one execution path. Historical readers
remain because deleting them would make durable evidence unreadable.

## Acceptance matrix

| Area | Required evidence |
| --- | --- |
| Phase 0 package fix | Packed install loads a built-in from an unrelated directory; package and host bundles pass release checks |
| Roots | Subdirectory, monorepo, nested repo, worktree, overlapping non-Git roots, symlink, case-variant Windows path, host-provided root, legacy/XDG conflict, and non-Git cases resolve one ProjectContext and canonical mutation barrier; every `CommandSpecV2` select/assert form and exact-ID root mismatch behaves as declared; different valid XDG environments, transports, and shared-home machines converge through one fixed discovery slot; unsafe NFS/bootstrap/state roots fail before mutation; logout/reboot endpoint loss, changed machine identity, concurrent activation, and failure at every copy/locator/binding/cold-start/cleanup relocation or rebind phase retain one machine-scoped authority; `ProjectRelocationTxnV1` preserves a same-file-identity move through every crash/response-loss phase, rebuilds locators/projections, revokes changed path-sensitive grants, and rejects copies or replacements; moves into overlapping ancestry compose with domain merge so both aliases reach one barrier, while moves out stay conservatively merged |
| Assets | Target-project files cannot shadow installed built-ins; production resolves only installed/registry bytes while source development uses `SourceCheckoutAssetProviderV1`; N+1 `--flow-root` cannot start work; custom drafts promote/replace only by immutable draft ID; replacement preserves old references; every `LegacyFlowCandidateV1` receives exactly one import-with-scope/name, retire, or freeze decision; missing/duplicate decisions block cutover and response loss is idempotent; reserved/scope collisions fail; `ReservedNameCompatibilityTxnV1` makes a newly reserved CLI/built-in/host/protocol name atomically remove direct projection, preserve the qualified custom Flow, and join registry/head/runtime activation; death at every boundary shows complete old or complete new resolution and unverifiable host state quarantines the update; `ContentGcTxnV1` death/reference races never break a retained plan, Run, projection, overflow artifact, or backup |
| Install trust | Every transport authenticates the first executable outside its archive, pins the TUF-root digest, and enters `InstallRegistrationTxnV1`; swapped archive-plus-root, wrong signer, replaced manifest, replay, execution-before-verification, concurrent first transports with different roots, and death at every registration phase produce exactly one slot/root set and one CASed current `FrontendInstallationHeadV1` per installation or fail |
| Plan integrity | Canonical executable and full-artifact bytes are deterministic; `PlanTxnV1` crash recovery, missing/forged private receipts, and project-copy tampering fail; every start has a pre-mutation StartTicket/key and exactly one `StartAuthorizationV1`: consequence-free starts use a valid `NoApprovalRequiredReceiptV1` without exit 3 or `--yes`, while only plans with outstanding approvals use `ApprovalDecisionV1`; forged, swapped, stale, unnecessary, or wrong-caller authorization fails; client death at every acceptance boundary returns the same Run; ticket decline/abandon/expiry/start/prune CAS races leave one terminal ticket state; `PlanAvailabilityTxnV1` races Run-plan abandon/expiry/prune against ticket issue, authorization, and acceptance with one winner and no released live reference; executable drift changes `plan_sha256`; artifact-byte changes change `plan_artifact_sha256`; Run and Apply plans pass 24-hour expiry, list/show/abandon/prune, idempotent reuse, source-reference transfer, and no-effect-before-hash-confirmation; oversized artifacts reconstruct from bounded chunks to the same hash |
| Enqueue idempotency | Every private/Trace phase and lock release/reacquisition of `EnqueueTxnV1`, plus capsule/folder/init/launch/response loss, returns the same queue/Run identity without lock-order reversal; loss or forgery of `QueueAuthorityReceiptV1`, `SafeReentryAuthorizationV1`, or either private mirror proves that Trace-only `queue.prepared`, `run.queued`, or safe-boundary bytes can never mint queue/re-entry authority; every recovery launch requires the exact pending `RecoveryWorkReceiptV1`, and missing, forged, stale, wrong-Run, wrong-transaction, duplicate, superseded, or crash-interrupted receipts launch no worker; different artifact bytes fail; a required child Apply never enters the root queue, while a later Apply retry returns one root Apply Run |
| Detach | Viewer, shell, host, and supervisor exit do not stop an isolated worker; consequence-free fresh detach reaches durable queue acceptance and exit 0 in one call, while approval-bearing detach exits 3 before Run allocation; kill after every call from every role's reservation through slot creation, atomic child placement, budget arm/gate release, ready, and exact exit proves one child or empty containment; restart activation progresses active and queued Runs with no client; terminal Trace may precede exact worker exit, but lease/pins remain through `terminal_cleanup_complete`; foreground Runs explicitly reject detach and make no survival claim |
| Ownership | Start/resume races produce one worker; every normal, parked, interrupted, and terminal Invocation uses exact exit mirroring; all four `BootEpochExitProofV1` branches are exact and an unverifiable platform remains ownership-unknown; `ForegroundInvocationTxnV1` proves controller death, worker death, `EPIPE`, no-output final-frame exception, open-effect reconciliation, exact exit, ownership-unknown, and legal/rejected foreground resume; generated claim/lock rules serialize execution, workspace reduction, probes, Apply settlement, and foreground work while allowing only named Trace-only control outside the claim; project, Run, and mutation-domain locks survive supervisor exit; stale resolver/alias-generation and merge interleavings cannot admit through an old barrier; no domain merge/enrollment/relocation publishes while an Apply block exists; snapshot and Apply exclude; a replacement reopens exact containment; stale socket, PID reuse, sleep, and timeout do not grant takeover; endpoint publication survives every crash boundary |
| RPC security | Different-user access, forged or stale `NoApprovalRequiredReceiptV1`/`ApprovalDecisionV1`, raw hashes/approval booleans, raw stream-operation IDs without same-caller `StreamResumeTokenV1`, copied force-decision IDs without same-user authentication and matching private receipt, reused/stale resolution/continuation/stream/force decisions, unsupported source-command/action pairs, prose-only or documentation-only actions, structured choices without CLI equivalents, retry-safe non-command remedies, wrong-Run capability, replay, project tampering, inherited handles, private-root access from effects, oversize frames, and unknown required fields fail closed |
| Checkpoint | Death/private-authority loss around pending/topology-prepared/drained/waiting/private-mirror/Invocation-exit is deterministic; settled permits without a complete topology candidate become interrupted and never answerable; parked workspace digest revalidates; two token-bound answers race and one wins; parked cancel uses a control worker; checkpoint drain cancel is a closed force-action producer whose decision is unusable by root or Apply force leaves |
| Cancellation | Every timing either proves all effect containment empty and settles canceled, reaches reconciliation, or stops as `CONTAINMENT_UNKNOWN`; each root, Apply, or checkpoint graceful source advances one `ForceEscalationReceiptV1`, returns exit 3 only for a proved live controllable force action, and names one legal consumer; stale decisions return only an error/rerun remedy; wrong source/user/Run/generation, expiry, duplicate consume, response loss, and process-list/shell-history probes prove the argv ID is non-bearer and no containment capability leaks; no false success |
| Budgets | Shipped/user/project/invocation `BudgetPolicyV3` values reduce tighter-only into exactly the header and enforcement ledger; approval thresholds generate approvals without weakening caps; unenforceable USD limits, pricing/capability drift, and environment/quota schema drift fail before acceptance; worst-case token/cost/quota reservations block over-admission; every physical `EffectDispatchAttemptV1`, including a reconciliation probe, has its own reservation and unknown usage consumes the full bound unless authoritative accounting proves less; a billable/token/quota/rate-limit read is rejected from `pure_read`; no project or engine code runs before atomic guardian arm/gate release; `reconciliation_probe_only` admits only the named query and cannot run the engine or primary effect; same-boot exit refunds only proved unused time and cross-boot/unknown exit refunds none; exact containment terminates by the hard active-time deadline; primary uncertainty never creates unapproved spend |
| Effect recovery | Capability proofs derive each recovery class; death around every physical attempt state gives retries distinct IDs/reservations and never replays unknown billable work; a local keyed lookup must prove zero consumption, while a network/provider lookup requires a pre-authorized or separately confirmed `ReconciliationProbePlanV1` and single-use permit; every probe reservation/dispatch/receipt crash, response loss, cancellation, unknown outcome, and duplicate attempt preserves primary uncertainty and its own budget; boot recovery maps open effects to reconciliation; cache loss and background descendants cannot fake settlement; every isolated/discardable effect promotes or durably discards its layer before dependent work; stale `ResolutionDecisionTokenV1`/`ReconciliationContinueTokenV1` cannot alter the ledger; continuation commits a topology-complete receipt with the pinned reducer, cancel and mixed-abandon settlement close every layer, unavailable reducers return `CONTINUATION_UNAVAILABLE`, and reconstructable not-completed absence may use a new effect ID only under the declared rule |
| Apply | Required in-tree Apply cannot deadlock on its parent's project lock and child control returns the root-cancel remedy; `InTreeApplyCompletionTxnV1` maps every child outcome plus cancellation order to exactly one parent result and crash-recovers the child-terminal-to-parent-close join; `result_materialization: base_checkout` rejects automatic Apply, settlement authority, and later `apply <run-id>` with `APPLY_NOT_APPLICABLE` before any plan, child Run, queue item, or effect, while `isolated_patch` retains the normal path; the first eligible `apply <run-id>` is planning-only and only exact `apply --plan` creates a Run; plan races choose one state; commit decision orders against cancel; power loss yields the full postimage or nonterminal `apply_recovery_required`, never terminal `drift_blocked`; the block admits its exact shared-barrier repair plan and exclusive settlement but rejects every unrelated plan/start/snapshot/mutation/merge/relocation/prune; all three repair strategies, response loss/expiry/supersession, stale checkout, and settlement crashes preserve staging/references until one receipt commits; settlement waits for the project scheduling claim and normal lock order; modified settlement closes aborted with `operator_settled`; final-check claims match the proved exclusion profile; no-follow/nested-project rules hold; source Trace never reopens |
| Prune | `ReferenceAcquireTxnV1` and operation-owned access pins race start/Apply/export/report/tail against every fence and move phase; opening, reconnect, terminal-prepared, and terminal-delivery grace retain the pin, terminal acknowledgement or deadline-proved expiry alone releases it, and permanent supervisor loss leaks it safely; `PruneBatchPlanV1` rejects mixed project/filesystem/eligibility before any move; pre-first-move drift aborts without movement, while later replacement/deletion/symlink/identity drift enters `prune_recovery_required`, touches no unexpected bytes, retains every fence/pin/journal, and completes only through crash-safe retry-after-restore or abort-and-restore; response loss is idempotent; bounded results reconstruct exactly; tombstones preserve cursor/idempotency facts without evidence content |
| Isolation | Sealed Git/non-Git snapshots reproduce offline; content pins survive cache deletion while queued/parked; all fanout join policies use Run-owned workspaces; each effect writes only its immutable-base copy-on-write layer until the workspace-locator CAS commits; sandbox denies control/base/evidence/peer roots and escaping symlinks; the trusted foreground profile uses `base_checkout`, rejects detach/reconnect/parallelism/Apply, and reports direct materialization without pretending to be isolated |
| Events | Every retained and added type has one strict `ProgressEventPayloadByTypeV2` member, durable-source mapping, bounds, renderer case, positive fixture, and missing/extra/wrong-branch/oversize negative fixtures; unknown types do not compile and all frontends replay byte-identically; every isolated stream survives opening reply loss, origin-permit ACK, commit-between-replay-and-subscribe, lost wakeups, supervisor restart, slow consumer, terminal prepare/write/ack loss, and prune through durable high-water rescans, immutable terminal bytes, and deterministic IDs; authenticated reattach includes terminal-delivery grace but never post-expiry; permit-bound expiry changes no Run outcome and supplies only fresh read-only remedies; foreground follows no-reconnect; line filtering models origin versus cursor, never invents an origin cursor, and explicit replay argv parse/reproduce suppressed events; `watch` first Ctrl-C sends no control request; EOF follows every prompt-class rule; deleting private state from a terminal Run copy leaves public replay bytes unchanged |
| Corruption | Partial line, failed sync, disk full, result-before-terminal death, terminal-before-cache death, symlink swap, corrupt cache, and death at each `ContentGcTxnV1` prepare/move/sync/tombstone/purge boundary recover or stop at the last proved boundary; a live registry entry with missing bytes and a frame with a missing overflow receipt are corruption, never a successful cleanup |
| Output | Every result/error/action mapping preserves semantics and most-advanced context; every exit-3 action has an inline executable CLI choice/remedy, structured choices carry the same CLI equivalent, only command remedies may be retry-safe, a retryable error names at least one inline retry-safe command while permitting supplemental manual remedies, and a nonretryable error contains none; terminal, error, action, and mapped event frames obey all byte/item/string/argv bounds; oversized invalid cursors are hash/length only; strict inline/total/overflow unions reconstruct exactly; prose-only, documentation-only, structured-without-CLI-equivalent, impossible source-command/result and other invalid variants fail; EOF, first/repeated Ctrl-C, origin filtering, PTY/pipe/CI/NO_COLOR/TERM=dumb/screen-reader, idle resize, and prompt-latched resize match fixed transcripts; accepted/detached never fabricate outcome and Flow generation never claims a draft early |
| Presentation compatibility | For every characterized leaf and N/N+1/N+2/N+3 fixture, omitted format, legacy `--json`, native `--format json`, and standalone `--progress jsonl` select exactly the recorded `legacy_v1_final`, `legacy_v1_dual`, `legacy_v1_action_bridge`, or native-v2 presentation; action-bridge stdout/stderr/exit bytes are fixed per leaf, including the final bridge after v1 progress; hosts pin one explicitly; the N+1 pre-spend behavior break warns in N and spends nothing before action; no TTY/pipe/CI difference changes semantic format |
| Exits and actions | Every exit row and generated `AllowedActionByCommandV2` pair passes in human/JSON/NDJSON/plain; reconcile and probe use current tokens/plans; graceful force sources return exit 3 only with a proved action, `actions confirm-force` returns a result, exact consumers settle or exit 1, and stale decisions return an error rather than a second terminal action; Apply and prune-drift repair, staged uninstall, batch prune, transport repair, and recovery-key actions use exact two-step digests; EOF exits 3 unchanged at pre-mutation prompts, 1 at pre-action pickers, 0 detached in durable viewers, and 1 foreground; 129/130/131/143, opening/reconnect/terminal-delivery exhaustion, cursor mismatch, foreground no-final-frame exception, attached/detached Apply, impossible variants, idempotency conflicts, and every printed follow-up match declared exits |
| Help | `CommandSpecV2` parser, closed ProjectAware select/assert forms, reusable option-group expansion, every `-h`/`--help`, per-alias required/default goal, Preview Matrix/Power conflict, examples, typo suggestions, conflicts/defaults, generated grammar, and all four completions match exactly |
| Goal input | Goals and Flow descriptions with quotes, newlines, backticks, Unicode, shell metacharacters, oversize requests, duplicate stdin claims, and unknown fields behave exactly as specified; `flows generate` keeps one command/result schema across TTY/JSON/NDJSON |
| Config | V3 fixtures cover every field/reducer/authority/digest; `BudgetPolicyV3` hard caps and approval thresholds reduce separately, project/invocation only tighten, exact-decimal USD refuses unproved pricing, and plan header/source ledger equals enforcement; raw-CST fixtures prove absent, explicit-auto, parser-injected-auto, and lower-layer fallback dispositions without creating a new V3 opinion; connector environment duplicate/case/reserved collisions get manual migration and no winner; `ConfigWriteTxnV1` preserves comments and rejects conflict/crash/symlink/ambiguous values; migration creates no connector grant; exact restore respects its reader closure; zero-config medium Power, comments, and backups pass |
| Secrets | Canary values never reach output/artifacts; `inherit_env`, `secret_env`, and `CircuitReservedEnvironmentSetV1` are platform-normalized and disjoint before trust, plan, start, spawn, or secret capture; executed environment exactly matches the normalized grant; every executable/interpreter/script/managed-package/symlink identity swap invalidates `ConnectorExecutableClosureV1` and its project grant; the immutable copy/open-handle race proves executed bytes match after secret release; detached Runs use sealed nonsecret/environment-secret material across drift/reboot while credential-store handles remain late-bound; unsupported brokering fails before ticket consumption |
| Setup and removal | Bare setup writes nothing when healthy and reaches Preview in under two minutes; init/project trust stay explicit; hook writes preserve unrelated bytes and every Circuit-like unrecognized hook blocks until `handoff hooks resolve`; installation repair proves exact/replacement/absent/ambiguous outcomes without changing runtime authority; `UninstallAdmissionTxnV1` fences the frontend-set and Run-acceptance high-water before disposition, rejects/contains every post-fence start, serializes update/repair/promotion, and makes two simultaneous final-frontends choose one winner; staged uninstall has no generic force bypass and survives every disposition/manager/shim/head boundary; Recovery Anchor retain/restore/destroy paths survive all slot/key/root/activation phases; user connector credentials remain untouched |
| Private-state repair | Cross-lane snapshot rotation and authenticated backup survive loss; exact-tail restore is all-or-nothing; disaster restore raises the private-store epoch and revokes restored authority; every `ContentGcTxnV1` crash/reference race recovers before `repair inspect` clears it; recovery-key retain/destroy and changed-machine rebind/data-only behavior are exact; active worker/effect/unknown containment blocks unsafe repair; corrupt/path-swapped input changes nothing |
| Runtime update | TUF expiry/rollback/revocation, whole compatibility closure, recovery payload, singleton authority, pins, active/parked/reconciliation Runs, manager repair, and simultaneous transports pass; every direct/delegated `FrontendUpdateTxnV1` phase converges launcher, activation, immutable receipt, one generation-CASed installation head, runtime authority, rollback pin, reserved-name transaction, and manager subtransaction; concurrent update/promotion/rollback cannot fork a head and historical active receipts never join closure; late old frontends quarantine without poisoning closure; N-to-N+1/rebuilt/key-rotated/revoked artifacts require complete current-release floor/parity attestations for activation or rollback; content GC never exposes a live registry entry with missing bytes |
| V1 Runs | Markerless enrollment survives every crash; discovery boundaries stop parent claims; physical roots register once; `LegacyRunIdentityV2` includes project and root registration plus stable record ID, so same-project duplicate display IDs require qualified `legacy:<record-id>` targets; identical terminal evidence aliases only by explicit receipt, different history remains qualified, and at most one nonterminal collision member is mutable; copied projects use the same inspect-only rules; no unresolved collision set reaches generation 2; generation 1 permits only proven continuations and generation 2 forbids v1 append; every executable edge blocks cutover until guarded/classified/repaired/tombstoned; pre-N writes block v2 admission |
| Hosts and Flows | Fix, Build, Review, Explore, and Prototype cover every topology; the `PlatformParitySetV1` corpus proves direct CLI, Claude, and Codex preserve outcome/event/action/exit meaning; two projects may publish different bytes under one allowed Flow ID without a global Claude/Codex projection collision; an existing Flow that collides with a newly reserved built-in/CLI/host/protocol name remains usable only by its qualified ref, loses direct projection, makes unqualified lookup an exact conflict, and records the migration warning; hosts lacking local namespaces use only generic project-aware run; candidate import/rename/retire/freeze and promotion/replacement remain immutable-ID based, old references stay pinned, and projections rebuild without becoming authority |
| Platforms | The checked `MinimumProductionTupleSetV1` hashes only immutable semantic floor rows and cannot be demoted/self-waived; every signed release maps each floor tuple and parity set to its own artifact, tested ranges, signature, and passing gate manifest; older evidence cannot satisfy a new release, revocation invalidates the release proof without changing the semantic floor, and rebuilt artifacts re-pass it; only applicable rows exist; full-durable rows prove every lifecycle capability, foreground-only rows prove in-place and reject durable claims, and deferred/unsupported rows are not advertised/installable |
| First use | Every declared tuple frontend completes the clean-image automated journey under stated hardware/network/login assumptions, while parity images separately compare direct/Claude/Codex; the human gate recruits at least ten Circuit-new participants per frontend with at least three per floor platform across the 30-person minimum, allows no assistance or repo/cache knowledge, treats any product-caused help/noncompletion as failure, requires 100% unassisted completion and per-frontend p80 at or below five minutes, records median/p80/p95/mistakes/help/approval/detach comprehension, and reruns a fresh affected cohort after repair; all next-action argv parse and line mode answers by the same token CAS; no hidden telemetry is added |
| Cutover | No production v2 before the nine Phase 7 gates, every semantic floor/parity set, and complete current-release support/parity attestations; CI rejects semantic floor downgrade but permits a newly attested release artifact; `ExecutableEdgeInventoryV1` has no unresolved edge; every legacy Flow candidate and cross-/same-project legacy Run collision disposition is closed; production `--flow-root` rejects at N+1 and its node deletes at N+4 after source-provider proof; CI reaches zero old-writer consumers; compatibility floors and indefinite evidence readers are tested |

The repository gates remain `npm run verify`, release infrastructure checks,
flow drift checks, host parity tests, and packed-install checks. The rebuild adds
failure-injection, protocol, platform, accessibility, and usability gates; it
does not replace the current proof corpus.

## CI deletion ratchet

The first new-plane change adds a checked dependency graph. Each legacy node has
a stable ID, source path, kind (`writer`, `dispatcher`, `process-owner`,
`reader`, or `compatibility-adapter`), replacement, allowed direct consumers,
allowed entrypoints, target phase, and removal condition.

The checker resolves static and dynamic imports, CLI dispatcher edges,
helper-process commands, generated-host source entrypoints, actual activation-
environment selectors, host-hook command spans, cleanup stubs, and known
string-based re-entry. CI rejects an unlisted or unresolved Circuit-like
executable edge, a new direct or
transitive path into a writer/dispatcher/process-owner, a rising consumer set,
a new-plane bypass around the named adapter, or a path rename that loses its
stable ID. A zero-reachability writer must be deleted once replacement fixtures
pass. Waivers need an owner, reason, and expiry phase.

The graph covers current dispatch and orchestration, resume/PID ownership, v1
progress writers, cwd discovery below client boundaries, plugin-private runtime
execution, config v1/v2 writers, and every `--flow-root` parser, launcher,
manifest, environment selector, and host projection edge. The Flow-root node
has a zero-new-production-Run condition at N+1 and a deletion condition at N+4;
renaming it or moving it behind an adapter cannot reset that clock.
Re-exporting through a facade cannot game
transitive reachability. Historical readers are a separate node class and may
remain after every old writer and process owner is gone.

Separate checked manifests prevent two non-code regressions. The source-
checkout provider manifest lists every contributor-only caller and CI rejects
any installed or host production path into it. The production-platform manifest
pins the `MinimumProductionTupleSetV1` **semantic** row hashes and each semantic
`PlatformParitySetV1`; CI rejects deletion, demotion, or narrowing without an
explicit product-plan revision and a new adversarial review. It separately
requires one complete signed current-release support/parity attestation mapping,
so a newly attested artifact can replace an older one without weakening the
floor. The same gate requires every legacy Flow/Run collision disposition,
frontend head, and quarantined receipt to be closed or intentionally retained
before a migration generation or support claim advances.

`check-protocol-map` rejects a ProgressEvent type without its strict payload
member, durable-source mapping, renderer case, and positive/negative golden
fixtures. The command/action checker rejects an exit-3 action without an inline
plain-CLI path, a structured choice without its generated CLI equivalent, or a
retryable error without a retry-safe command remedy.

## Neighboring idea documents

This plan owns the shared event feed, local process supervisor, watch command,
output modes, and Run lifecycle contracts.

- [Run milestone stream](run-milestone-stream.md) keeps its problem evidence
  and milestone examples, but its durable `status.ndjson` proposal is
  superseded by the Trace-derived ProgressEventV2 feed.
- [Output model](output-model.md) remains useful for final-digest content and
  host display research. Its transport, routing-checkpoint, and direct progress
  mechanics do not override this plan.
- [Long-horizon supervision](long-horizon-supervision.md) remains a future
  model-in-the-loop idea. Its trajectory supervisor is not this deterministic
  local process supervisor, and its model heartbeat is not worker liveness.
- [Durability Tier-2 cursor](durability-tier2-cursor-spec.md) remains the
  historical record for the current engine's restart-cheapness decision. This
  plan supersedes that no-cursor roadmap only for new storage-v2 topologies that
  prove the complete safe-reentry contract above.

Their banners and catalog rows must carry these scopes. When they disagree on
CLI or lifecycle behavior, this plan wins.

## Remaining proof decisions

Four implementation choices remain open until their spikes produce evidence:

1. Private Node archive or Node SEA for the primary standalone artifact.
2. Host marketplace delivery: bundled native bootstrap, signed download on
   first use, or a host-managed shared runtime dependency.
3. The macOS and Linux kernel containment and filesystem-view adapters that
   satisfy the fixed no-breakaway, denied-root, read-only-mount, membership, and
   forced-stop contract.
   If a target cannot pass the escape probes, durable detach stays unsupported
   there rather than weakening the contract.
4. The platform-fixed discovery-slot adapters, especially Linux provisioning
   without a pre-existing system package. A target that cannot prove one may
   support a single explicit contributor transport, but not advertised durable
   multi-transport installation.

Worker lock custody, supervisor recovery, control ordering, Trace v2 tree
sequence, v1 compatibility, config storage and algebra, Git and non-Git
snapshots, uninstall naming, and the serialized initial concurrency posture are
decided above. These implementation choices cannot change the root, runtime
manifest, protocol, Run plan, or worker contracts. The plan rejects hidden
telemetry, a cloud control plane, automatic replay of unknown effects, raw relay
streaming by default, and a permanent always-running supervisor.
