# Runtime Architecture

The runtime in `src/runtime/` is Circuit's engine foundation. The CLI loads a
compiled flow, validates the executable graph, writes a manifest snapshot, and
records the run trace as the graph advances through compose, relay,
verification, checkpoint, sub-run, and fanout steps.

Run folders are current only when they contain a valid manifest snapshot and a
runtime bootstrap trace entry whose manifest identity matches that snapshot.
Status projection, checkpoint resume, handoff continuity, and result writing
all read that same folder contract. Unrecognized folders are invalid run
folders.

Flow-specific behavior stays in flow packages and registries under
`src/flows/`. The runtime owns execution mechanics, trace storage, report-file
validation, connector resolution, checkpoint resume, sub-run orchestration, and
fanout joining. Adding or changing a flow should update the flow package and
generated surfaces, not add flow-specific branches to the engine.

Recursion through child runs is bounded. A run carries its recursion depth and
the chain of ancestor flow ids; both child-run edges — the `sub-run` executor
(`src/runtime/executors/sub-run.ts`) and a fanout sub-run branch
(`src/runtime/fanout/branch-execution.ts`) — refuse to start a child that would
exceed the depth cap (`RECURSION_DEPTH_CAP`, currently 8) or that repeats a flow
id already on the ancestor chain (the cycle guard). A flow that references itself
is rejected earlier still, at compile time. This bounds the otherwise-unbounded
recursion that first-class composition makes possible; it is the Step 1 safety
piece of the recompile / recursion frontier mapped in
[`../ideas/north-star-status.md`](../ideas/north-star-status.md).

Relay acceptance criteria follow that boundary. Flow packages author optional
`acceptance_criteria` on relay steps; the compiler and manifest projections
carry the field through unchanged; the relay executor evaluates the
deterministic criteria after the result verdict and report schema pass. A failed
criterion either aborts the step or returns through the existing retry route
with feedback, so retry bounds stay owned by the graph runner's normal attempt
logic.

## The until loop and Converge

Some flows need to repeat work until a goal is met, not just run once. The
engine supports this with the until loop, driven by the
`iterates_until_condition` engine flag (see
[`../contracts/compiled-flow.md`](../contracts/compiled-flow.md)). It is a while
loop for flows: the graph runner re-enters the loop body, the span from
`head_step` to `tail_step`, once per iteration until a stop condition or a
ceiling. Converge is the operator-facing capability built on this loop. The
internal fix-until-green flow is its canonical form; sweep and converge-proof
use the same loop.

Each iteration is disposed by a stop-judge. The tail step proposes a goal-met
boolean; the engine reads it from the report path the flag names and disposes it
against an evidence floor. The disposition is one of three: stop-clean (the goal
is met and the evidence backs it, so the loop closes), reenter (take the
re-enter route for another iteration), or needs-attention (the loop is out of
iterations or budget and exits through a non-`@complete` terminal). The engine
records each disposition as a `run.until-judgment` trace entry. This logic lives
in `src/runtime/run/until-corridor.ts`.

The honesty ledger keeps a loop from claiming success it did not earn. The loop
can declare `frozen_paths`: a read-only evidence surface such as the test files
or the verify command's own definition. The engine fingerprints those paths at
loop entry. If a body iteration changes one, the engine opens a latch on the
ledger, because an iteration that edited its own test cannot honestly claim the
goal is met. A run cannot close as a clean `complete` while any latch is open;
the finalize chokepoint downgrades it to `stopped` instead. The ledger lives in
`src/runtime/run/honesty-ledger.ts`. The cumulative spend caps
(`cumulative_usd_cap`, `cumulative_token_cap`) and the no-progress ceiling are
fail-closed for the same reason: at the limit the loop exits to needs-attention
rather than spending more or spinning in place.

The long-term runtime direction is a functional effect shell around the same
explicit graph walk. The graph runner should continue to make step advancement
plain: enter step, run executor, evaluate route, append trace, move to the next
step. Capabilities such as files, trace persistence, clocks, subprocesses,
connectors, progress, child runs, and worktrees should be supplied at the edge
and should return typed errors as values.

The CLI routes supported fresh invocations directly through this runtime.
Published custom flows carry a manifest entry that maps the custom slug to a
supported archetype, so the normal `circuit run <slug> --flow-root <root>`
command uses the same foundation as generated flows.
