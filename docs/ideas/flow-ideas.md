# Flow ideas: stack-ranked backlog

Status: `current-strategy-context`. This is a prioritization document, not
shipped behavior. Nothing here builds before the v1 announcement; the launch
freeze in [`docs/release/v1-launch-plan.md`](../release/v1-launch-plan.md)
applies.

Created 2026-07-02. Seeded by an analysis of the "software factory" pattern
circulating on X (narrate a huge todo list by voice, have a strong model plan
it as a dependency DAG in Linear, then let a long-running cloud "middle
manager" agent dispatch subagents until everything ships). Most of that
pattern is Circuit's thesis done by hand with prompts; the genuinely new
pieces are recorded here alongside the flow ideas already parked in this
directory, so there is one ranked list.

## Landscape update (2026-07-06)

A six-angle market scan of the current developer-workflow landscape corroborated
this backlog's top tier and added four net-new candidates (rows 9-12 below). The
full research, market signals with citations, and the reasoning for every pass
and decline live in
[`popular-workflow-market-scan.md`](popular-workflow-market-scan.md). Headline:
build the backlog in order, because the market's three loudest 2026 patterns are
Merge Gate, Decompose plus Dispatch, and Promote. Merge Gate rides the hottest
current wave and is a candidate to lead the post-v1 sequence. Add Sweep, Migrate,
and Property-check as evidence-floor fast-follows; treat Onboard as one cheap
slice worth an early look. None of the additions need a new engine primitive.

## How to read the ranking

Ranked by the two criteria the backlog exists to serve:

- **Impact**: how much the flow advances Circuit's core bets: the
  encode-process wedge, the compounding loop, and evidence the operator can
  trust.
- **Virality**: how likely a public demo of the flow spreads. A flow scores
  high when it lands in a conversation the industry is already having.

Effort is listed as context but does not move the rank. The suggested build
order at the end does account for dependencies and effort.

## Stack rank

| # | Flow | One line | Impact | Virality | Effort | Existing material |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Decompose | Braindump in, dependency-DAG'd work-set out, each item executable without further context | High | Very high | Medium | New; adjacent: [`tracker-connector.md`](deprioritized-ledger.md) |
| 2 | Merge Gate | Triage a pile of agent-produced PRs with adversarial evidence checks and receipts | High | Very high | Medium | [`adversarial-verification-gates.md`](adversarial-verification-gates.md); Review flow; circuit-pr-review skill |
| 3 | Promote | Turn a good session or run into a reusable flow | Very high | High | Medium | Promote spike passed; [`portable-run-captures.md`](portable-run-captures.md); portable flow-file prototype (held) |
| 4 | Dispatch | Run a decomposed work-set locally: parallel worktrees, per-item flows, merge gate at the end | Very high | Very high | High | [`sandboxed-parallel-pursuits.md`](deprioritized-ledger.md); [`long-horizon-supervision.md`](long-horizon-supervision.md) |
| 5 | Steer | The agent's own self-governance flow; the operator decision becomes unnecessary instead of automated | Medium-high | Medium-high | Low (held branch proven) | `feat/steer-flow` (held, off-repo worktree) |
| 6 | Improve | Outer loop that studies past runs and proposes one bounded change | High (long-term) | Medium | Medium | [`improve-flow.md`](improve-flow.md) |
| 7 | Spec | Typed spec lifecycle (requirements, design, tasks, verification) before Build | Medium-high | Medium | Medium | [`spec-driven-flow-opportunities.md`](deprioritized-ledger.md) |
| 8 | Align | Establish and maintain the operator's intent foundation upstream of all task work | Medium | Low-medium | Medium | [`align-flow.md`](deprioritized-ledger.md) |
| 9 | Sweep | Fan one worker per file at an external linter, loop until the tool re-scans to zero | High | High | Medium | New (2026-07 scan); adjacent: fix-until-green |
| 10 | Migrate | Deterministic codemod first, then per-file agent fixes each verified by build-and-test | High | High | Medium | New (2026-07 scan); adjacent: build/fix, Decompose |
| 11 | Property-check | Author invariants, close only on a minimized counterexample that reproduces on a fresh run | High | High | Medium | New (2026-07 scan) |
| 12 | Onboard | An onboarding brief where every claim opens to a real file or symbol | Medium | Medium | Low | New (2026-07 scan); reuses explore groundedness reviewer |

Rows 1 to 8 rank by the backlog's core-bet criteria (encode-process wedge,
compounding loop, trustable evidence). Rows 9 to 12 are the net-new evidence-floor
additions from the 2026-07 scan; they sit below the top tier because that tier
advances the compounding loop directly, while these advance the evidence floor on
well-covered ground. All are recommend-grade fast-follows except Onboard.

## The candidates

### 1. Decompose

Input: a large unstructured braindump (dictation transcript, meeting notes, a
10k-word ramble). Output: a set of work items with an explicit dependency DAG,
optimized for parallel execution, where every item carries enough written
context that a weaker model could execute it without asking anything.

This is the hero step of the software-factory pattern, and it is a real,
encodable process with a crisp finish line. It is also adversarially
checkable in a way most planning prompts are not: every item names its
dependencies, no item requires context not written in the item, the DAG has
maximal width. Those are checks, not hopes. A tracker write (Linear, GitHub
issues) is an optional boundary delivery at the end; the typed work-set is
the artifact. See "Outward comms are boundary deliveries" below.

Fits the encode-process wedge as another input shape alongside `generate`,
the promote direction, and the portable flow file. Our own eval history says
multi-item dependency structure is the frontier lever, and this flow produces
exactly that artifact.

### 2. Merge Gate

Input: a pile of agent-produced PRs or change packets. Output: each claim
adversarially verified against evidence, a risk-ranked queue, and a receipt
per PR the operator can trust without re-deriving the work.

The software-factory post ends by admitting its downside: "you're now review
bottlenecked... as an industry we should come up with some innovation there."
That is Circuit's home turf. The bottleneck has visibly moved from generating
work to believing it, and evidence provenance is the differentiator no
prompt-stack has. The per-PR half already exists as the Review flow and the
repo-local review skill; the new part is fleet-scale triage with a ranked
queue and receipts.

### 3. Promote

Input: a session or run that went well. Output: a reusable flow that encodes
the process it followed. The spike (session transcript to a 7-step flow)
already passed.

Strategically this is the deepest item on the list: it is the compounding
loop, the thing Circuit is for. Ranked below the two above only because its
demo ("I turned my best session into a repeatable process") is strong rather
than spectacular, and because the wave the top two ride is live right now.

### 4. Dispatch

Input: a Decompose work-set. Output: the work, done locally. Parallel
worktrees, one flow per item, dependency-ordered waves, Merge Gate at the
end. The Circuit-native answer to the cloud middle manager: authored topology
instead of a long-lived prompt whose judgment degrades silently over 12
hours.

Highest ceiling on both criteria (a local software factory with receipts and
no cloud agent), but the heaviest engineering on the list and it composes the
top two candidates, so it cannot sensibly come first.

Its comms half (heartbeats in Slack, keeping the tracker current) needs no
new worker capability: outward writes are boundary deliveries, per the
settled stance below.

### 5. Steer

The inverted flow: instead of automating the operator's decision, the agent
runs a bounded self-governance loop that makes the decision unnecessary. A
held branch already proves both paths; the remaining work is graduation, not
construction. Novel framing gives it decent virality; impact is narrower than
the items above.

### 6. Improve

The outer loop: study prior runs, rank repeated signals, propose one bounded
change to a flow, check, or policy, and stop at a checkpoint before any
write. High compounding impact over time, but abstract to demo, which caps
virality. Full proposal in [`improve-flow.md`](improve-flow.md).

### 7. Spec

Pause implementation until requirements, design, task breakdown, and
verification expectations exist as typed reports, then export readable views.
Solid and proven as an operator habit, but the spec-driven-development space
is crowded, so differentiation carries the virality burden. Full proposal in
[`spec-driven-flow-opportunities.md`](deprioritized-ledger.md).

### 8. Align

Make the project's intent foundation (goals, principles, refusals) explicit,
durable, and consulted, so drift stops compounding across sessions. Real
long-run value, weakest demo. Full sketch in
[`align-flow.md`](deprioritized-ledger.md).

### 9. Sweep (from the 2026-07 market scan)

Fan out one scoped worker per file at an external linter or type-checker
(ESLint, tsc, Clippy, golangci-lint), re-run the tool as the evidence gate, and
loop until the finding count hits zero. The external tool is the oracle, so
"done" is a machine-checked exit 0 no worker can narrate past. Net-new relative
to fix-until-green, which loops a single target: the loop-body head is a dynamic
fanout, and the loop condition is a set count reaching zero. A build-ready spec
now exists at [`../flows/sweep-flow-spec.md`](../flows/sweep-flow-spec.md). An
adversarial review corrected two first-pass claims: it needs two small general
engine primitives (iteration-scoped fanout output paths, and an oracle-command
pin), not zero engine edits, and both also harden fix-until-green. It also needs
a per-wave re-partition and four anti-cheat additions (command pin, effective-
config re-derivation, set-identity invariant, retract the fanout overclaim-gate
claim) before the oracle is genuinely ungameable. Market signal (Sweeper,
BitsAI-Fix) and full fit in
[`popular-workflow-market-scan.md`](popular-workflow-market-scan.md).

### 10. Migrate (from the 2026-07 market scan)

Run the deterministic codemod first, then fan out per-file judgment fixes, each
gated on the file still building and its targeted tests passing, with an aggregate
sweep for remaining deprecated-API call sites. Serves all three positioning
pillars at once and encodes the exact "deterministic where you can, agent judgment
where you must, verify per file" pattern the market is converging on. Load-bearing
risk: real migrations rarely decompose into independently-buildable files, so the
per-unit gate needs a real migration probe before committing or it collapses into
fix-until-green with a codemod on front. Full fit in the scan doc.

### 11. Property-check (from the 2026-07 market scan)

An author block infers invariants from a library or spec; a runner executes them
under a property-based testing library; the run closes only on a minimized input
that reproduces a violation on a fresh subprocess. The falsifier is a
code-supplied contract, not a learned score, so it is not the declined
optimize-until pattern. The gate proves a property fails, not that the property is
correct, so a hallucinated over-strong invariant needs a flow-boundary checkpoint
before any outward bug report. Python and Hypothesis first. Full fit in the scan
doc.

### 12. Onboard (from the 2026-07 market scan)

Trace one real end-to-end path through an unfamiliar repo and emit a typed
onboarding brief where every claim resolves to a cited file or symbol the check
can open. Lowest-effort candidate; reuses Explore's proven evidence-groundedness
reviewer and can run the trace as a sub-run of Explore. The one open question is
whether it earns a separate flow or is really an Explore output variant; decide
with a held eval before building. The one `v1-reconsider` slice, and even it is
optional. Full fit in the scan doc.

## Parts of the factory pattern that are not new flows

Recorded so the analysis is not lost, and so nobody re-derives these:

- **Burden of proof** ("every agent works until self-review passes, the bug
  bot is green, and fixes are elegant") is the until-loop and Converge,
  already shipped. The pattern enforces it by prompt; Circuit enforces it in
  the engine, where annotations cannot lie.
- **Tiered intelligence** ("fan out to cheaper subagents on high effort, keep
  the strong model on the hardest issues") is the archetype and dial system
  plus per-relay connector pinning, already shipped via cross-tool-build.
- **The cloud middle manager** is deliberately rejected. Its own author calls
  the orchestrator's context window "holy," which is a confession that the
  orchestrator is the fragile part. Circuit's position: the schematic is the
  middle manager, and it does not compact, drift, or get tired.
- **Heartbeats and tracker sync** (Slack updates, keeping Linear current) are
  boundary deliveries, not a flow and not step equipment. See the settled
  stance below.

## Outward comms are boundary deliveries (settled 2026-07-02)

Decision: when a flow needs to post outward (Slack heartbeat, Linear items,
tracker sync), the write happens at a flow boundary in the host session, from
a typed artifact (a report, a checkpoint packet, the close digest). It does
not happen from inside a relay.

Why this is the simpler and safer shape:

- Workers are structurally MCP-closed today, on purpose. The Claude Code
  connector spawns every relay with `--strict-mcp-config` and an empty MCP
  server list, and fails closed if the session reports any MCP server mounted
  (`src/connectors/claude-code.ts`). The Codex connector forbids the argv
  tokens (`-c`, `--profile`, `--sandbox`) that could smuggle MCP-server
  overrides in (`src/connectors/codex.ts`). Workers run with permissions
  bypassed; an open MCP path would be an unattended remote-write surface.
- The host session driving the run already has MCP. Boundary delivery reuses
  it: the worker produces evidence, and the outward write is operator-visible
  and sourced from a typed artifact rather than composed inside an unattended
  subprocess.
- Two parked designs already describe this shape:
  [`tracker-connector.md`](deprioritized-ledger.md) (structured flow output
  written back to trackers at boundaries) and
  [`multi-channel-hitl-proposal.md`](multi-channel-hitl-proposal.md) (a
  delivery gateway around existing checkpoint semantics). Decompose and
  Dispatch need nothing beyond this.

The alternative (a per-step MCP mount as a new equipment sub-axis: declare
named servers, mount exactly those via `--mcp-config`, extend the init-trace
guard to assert the mounted set equals the declared set) stays on the shelf.
Revisit only if a flow genuinely needs a worker to read from an external
system mid-step, and even then mount it read-only; write-capable MCP tools
would additionally sit downstream of a checkpoint where the operator approved
the payload.

## Suggested build order

Rank is impact and virality only; this order adds dependencies and effort:

1. **Decompose** first: cheapest of the top tier, timeliest, and Dispatch
   needs its artifact.
2. **Merge Gate** second: independent of Decompose, and its per-PR half
   already exists.
3. **Promote** third: the strategic core; can proceed in parallel with the
   above if capacity allows.
4. **Dispatch** last of the top tier: it composes 1 and 2.

Steer graduates whenever its held branch gets a decision; Improve, Spec, and
Align wait for a pull from real operator need.

## Maintaining this document

Add new candidates with a one-line row and a short section. Re-rank when the
landscape moves; note the date and the reason in place of silent edits. When
a flow ships or is rejected, move it out of the stack rank into a closing
note that links the outcome.
