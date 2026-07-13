# Failure-legibility hardening (2026-07-13)

Overnight pre-launch initiative. Origin: a Codex-reported Build run
(`37a27314`, 2026-07-11) was killed after 180 seconds of worker silence with
no clear explanation, and the operator ruling that followed: no mysterious
failures ship in v1. Every terminal outcome must name what happened, whose
fault it is (setup, agent, task, or Circuit), and what to do next. Every
operator-hittable limit must be visible in docs or failure messages, never
only in source comments. That rule is now launch blocker #8 in
[`docs/release/v1-launch-plan.md`](../release/v1-launch-plan.md).

Method: root-cause the reported failure, then mine the local run corpus and
the source tree for every failure class and shipped bound, then fix in
clusters, test-first. Full `npm run verify` is green with everything below
in place, including regenerated plugin runtime bundles and the packed-install
gate.

## The reported failure

The 180-second inactivity bound killed workers that were legitimately quiet
(long test suites, long thinking turns). The default idle bound is now 600
seconds, a flow can raise or lower it with `budgets.inactivity_ms`, and the
60-minute wall-clock backstop is unchanged. The timeout message names the
bound that fired and the override. Pinned by
`tests/runner/relay-inactivity-budget.test.ts`.

## Fix clusters

**Help and discovery.** Real help text for every subcommand
(`src/cli/help.ts`), no more Commander `(outputHelp)` token leaks, and
misuse answers name the correct vocabulary.

**Usage errors.** Wrong invocations exit 2 with a usage-class message
instead of masquerading as engine failures.

**Honesty surfaces.** `circuit preview` marks steps a process dial skips
instead of advertising work that will not run. `circuit config show`
provenance reports `default` unless a layer actually sets the key. Doctor
remedies are paste-workable commands that the CLI accepts. JSON surfaces
carry `schema_version` stamps. Unknown config keys name the valid key set.
Empty states point at the next command instead of dead-ending.

**Shipped bounds made visible.** Custom connectors get the same 60-minute
wall-clock cap as the built-ins (was 2 minutes) and forward
`budgets.inactivity_ms`. Operator-summary caps render `+N more in
operator-summary.json.` instead of silently dropping content, and machine
warnings can never be evicted by ordinary caveats. A crashed auto-power
inference records `run.power-inference-error` instead of silently falling
back to medium. A passed relay whose report could not be materialized
records `step.report_skipped`. All operator-hittable bounds are listed in
one place: the "Limits You Can Hit" section of
[`docs/operator-guide.md`](../operator-guide.md).

**Failure messages lead with plain English.** Connector launch failures
open with the fact ("The codex CLI is not installed or not on your PATH"),
not a raw spawn error. The last error-typed stream event surfaces first in
relay errors instead of drowning under an init-handshake dump. Verification
aborts name the failing command, its exit code, and the last output lines.

**Ambiguous run states say so.** A run folder whose trace just stops used to
project `open`, indistinguishable from a live run. The open projection now
carries a `status_notice` stating plainly that no outcome was recorded and
the run is either still in progress or was interrupted.

**Swallowed failures now leave records.** A crashed context-delivery seam
records `run.context-delivery-error` instead of vanishing into a fail-safe
catch. Dropped evidence links surface as summary warnings. An automatic
connector pick is named in the summary details with the config command that
makes the choice explicit.

**Jargon translation at the operator surface.** The recovery-binding abort
reasons are contract-pinned trace strings ("the WorkContract does not
declare a matching recovery binding"). The trace keeps them verbatim; the
operator summary now leads with what happened in plain words, whose problem
it is (the flow definition), and what to do next. A new catalog-wide gate
(`tests/contracts/recovery-route-binding-gate.test.ts`) proves every
bundled flow's recovery routes have matching bindings, so the abort class
that hit three June runs cannot silently reopen.

**Root-caused path bug.** Passing a `.circuit`-descendant directory as a
project root used to nest a second control plane inside the first
(observed in two repos). `normalizeProjectRoot` in
`src/shared/control-plane-paths.ts` now re-anchors every such root to the
real project root, at the single choke point all path helpers share.

## Verification

`npm run verify` (canonical, what CI enforces) passes end to end on the
combined tree: type check, lint, build, full test suite, eval and idea
gates, doc-path gate, YAML schema gate, flow-drift gate against regenerated
bundles, and release-infra checks including the packed-install proof.

Deferred, with reasons recorded in code comments or the launch plan: the
context-delivery second-request record (post-v1 rebuild owns it), the
orphaned-worker third-kill option (no safe move exists from the parent
process), and the container first-run lab (runs at release time against the
published package).
