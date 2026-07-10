# Agent-friction remediation proposal

Status: proposal, awaiting go/no-go. Written 2026-07-10.

## What this is

While executing the pre-release punch list through Circuit itself
([pre-release-punch-list.md](pre-release-punch-list.md)), the operating agent
hit a repeatable set of frictions. Circuit's stated bar is that it should be
extremely easy for agents to use. This document turns each friction into a
grounded finding, proposes a fix with file targets and a test-first plan, and
lays out an execution order that runs the fixes through Circuit.

Everything here is remediation of observed behavior, not new capability. One
item (config-steerable verification) is a genuine new surface and is framed
as a decision fork rather than assumed.

## Evidence base

Four dogfood runs on 2026-07-10, all driven by the operator skill:

| Run | Flow | Outcome | Spend | What it proved |
| --- | --- | --- | --- | --- |
| `1f077ea2` (circuit) | Build | aborted, work was green | $10.74 | verify check dies at its budget; retry re-runs the implementer; abort reason hides the timeout |
| `794b33ba` (circuit) | Build | complete | $2.70 | the happy path is genuinely good |
| `e39b5c6e` (circuit) | Build | aborted, work was green | $2.97 | goal text cannot steer the verify command; same timeout, deterministic |
| `b1e6cdcc` (circuit-land) | Build | stopped, `needs_attention` | $3.76 | outcome degradation is honest but illegible: nothing names the cause |

Both aborted runs were salvaged at the operator boundary: diff reviewed by
hand, full `npm run verify` run outside the run, work committed green
(`4798e782`, `b2aa779d`). The salvage worked, but it should not be a skill
the operator has to invent.

## Findings

### F1. Build's verification budget is 5x tighter than Fix's, by accident

Every verification command gets a `timeout_ms` and runs under
`spawnSync(..., { timeout })` (`src/shared/proof-plan.ts:184`). The budgets
flows pass today:

| Caller | Budget |
| --- | --- |
| `src/flows/fix/writers/brief.ts:30` | 600_000 |
| `src/flows/build/writers/checkpoint-brief.ts:49` | 120_000 |
| `src/flows/pursue/writers/contract.ts:17` | 120_000 |
| `src/flows/cross-tool-build/writers/plan.ts` | none passed, resolver default 120_000 |
| `src/flows/fix-until-green/writers/plan.ts` | none passed, resolver default 120_000 |

The resolver default lives at `src/shared/verification-resolver.ts:164`
(`input.timeoutMs ?? 120_000`). In this repo, `npm run verify` takes several
minutes; both aborted runs show `duration_ms 120004` followed by SIGTERM.
The same work under Fix's own budget would have passed.

Git archaeology shows no deliberate decision behind the split: both values
arrived inside broad migration commits (`fed34ef6`, `2066b958`), not a
reasoned budget choice. This is an inconsistency, not a design.

### F2. A timed-out command is indistinguishable from a failed one

`runProofPlanCommand` (`src/shared/proof-plan.ts:171-209`) folds the
ETIMEDOUT error message and the SIGTERM signal into `stderr_summary` as
prose. The observation record has no first-class timeout marker: `status`
is just `'failed'`, `exit_code` is coerced to 1. Everything downstream
(the verification report, the `verification.command_evaluated` trace entry
at `src/schemas/trace-entry.ts:120`, the failure reason) inherits that
blindness.

### F3. The failure reason discards the evidence it already holds

`src/runtime/executors/verification.ts:341` reports every failure as:

> `verification step '<id>' failed one or more commands`

The observations sitting in scope at that line carry the command id, exit
code, duration, and output summaries. None of it reaches the reason. That
string becomes the step failure, the close reason, and the operator
summary's "Stop reason" line (`src/app/operator-summary/writer.ts:579`),
so the operator reads "failed one or more commands" when the truth was
"the full test suite ran out its budget at exactly 120s".

### F4. A deterministic timeout burns a worker retry

The failure routes through `recoveryRouteForFailure` with cause
`'failed_check'` (`src/runtime/executors/verification.ts:359-364`), the
same cause as a real red test. The Build schematic's recovery binding sends
that back through the implementer with feedback. For a timeout this is a
pure waste: the condition is deterministic, the implementer re-does finished
work, the verify step times out again, and the run aborts. Run `1f077ea2`
spent most of its $10.74 on exactly this loop.

There is no timeout-shaped member of `RecoveryFailureCause`
(`src/schemas/recovery-route-kind.ts`), so no schematic can route it
differently today.

### F5. Goal text cannot steer the verify command, and nothing says so

The command choice is engine code, not worker judgment:
`firstGeneralScript` prefers the `verify` script over `test` and `check`
(`src/shared/verification-resolver.ts:88-93`). Goal text only reaches
`inferBuildVerificationNeeds`, a regex that can add `build`/`lint` needs,
never change the general script or the budget. Two runs proved that
instructing the run to gate on `verify:fast` does nothing.

The design itself is right: workers must not choose their own oracle
(that is the honesty floor). But there is no operator-level steering
channel either, and no documentation of the resolution rule, so the
operator discovers the wall by paying for it.

### F6. Stopped and aborted summaries do not hand over the salvage

The aborted runs' summaries name neither the failing command nor the
timeout, do not say that the attempt's edits are still sitting uncommitted
in the working tree, and do not say that independent review never ran
(an aborted run skips its review step). The generic "Next:" line says to
inspect the run. Everything the operator actually did (review the diff,
re-run verification with a real budget, commit) had to be reconstructed
from the trace and reports by hand.

### F7. `needs_attention` never names its cause

Run `b1e6cdcc` closed stopped with verification passed, review accepted,
scope within bounds. The cause was one unassessed guardrail, and the close
gate correctly refused `complete`
(`src/flows/build/reports.ts:767-773`). That honesty is working as
designed. But:

- `run-close.ts:98` renders only `primary result ... reported outcome
  'needs_attention'` while holding the parsed result in hand.
- The summary shows that line verbatim, plus a generic Next.
- The result schema has no reason field, and it should not need one: the
  cause is deterministically derivable from `scope.unassessed_guardrails`,
  `scope.violated_guardrails`, `review_verdict`, and `touch_area`.

The kicker: the unassessed guardrail ("every `circuit--v` literal must
equal the release tag") is satisfied. One grep proves it. The run stopped
over a check nobody ran, and nothing told the operator which check.

### F8. Cross-repo invocation fails closed without naming the remedy

Running the Build flow against a second checkout (circuit-land) cost two
usage errors. The first message (no flow installed here) correctly teaches
`--flow-root`. The second one does not teach its own escape hatch:

> `unsupported runtime invocation: explicit --fixture/--flow-root inputs
> must point at generated flows, trusted generated mirrors, or published
> custom flows`

The blessing mechanism (`CIRCUIT_GENERATED_FLOW_MIRROR_ROOT`) is only
discoverable by reading `src/cli/runtime-routing-policy.ts:23`. The
fail-closed policy is right; the message withholding the fix is not.

### F9. Recall warnings repeat verbatim

Run startup printed the same `source_pruned` warning three times (one per
pruned document, emitted at `src/app/history/extract.ts:648-656`, passed
through `src/app/history/query.ts:325` and `run-start-recall.ts`). Noise
in an agent-facing channel; three identical lines carry one line of
information.

## Proposed fixes

Four clusters, ordered by leverage. Each fix names its failing test first,
per the house debugging rule.

### Cluster 1: verification honesty (F1, F2, F3, F4)

**1a. One shared verification budget, 600s.**
Add `DEFAULT_VERIFICATION_TIMEOUT_MS = 600_000` to
`src/shared/verification-resolver.ts` and make it the resolver default.
Delete the bespoke `120_000` in `build/writers/checkpoint-brief.ts` and
`pursue/writers/contract.ts`; let `fix/writers/brief.ts` use the constant
it already equals. Compiled bundles do not snapshot this value (verified:
no `120000` in `generated/flows/`), so this is engine-only.

- Failing test first: resolver unit test asserting the default budget, plus
  a Build checkpoint-brief test asserting the brief's verification commands
  carry 600_000. Both red today.
- Blast radius: the `120_000` literals in ~12 test files need triage; only
  the ones pinning verification budgets change. Wall-clock risk of a
  genuinely hung command rises from 2 to 10 minutes, bounded and honest.

**1b. First-class timeout marker on observations.**
In `runProofPlanCommand`, detect timeout (`result.error` with code
`ETIMEDOUT`, or a signal kill after the budget elapsed) and record
`timed_out: true` on the observation. Extend the shared observation schema
in `src/schemas/verification.ts` and the `verification.command_evaluated`
trace entry (`src/schemas/trace-entry.ts:120`). Default `false` so
existing fixtures parse.

- Failing test first: proof-plan unit test running a sleep with a tiny
  budget, asserting `timed_out === true` and `status === 'failed'`.

**1c. Failure reason derived from observations.**
Replace the constant string at
`src/runtime/executors/verification.ts:341` with a reason built from the
failing observations: command id plus either `exited <code>` or
`timed out after <duration> (budget <timeout_ms>)`. No new plumbing: the
reason already flows into the trace, the close reason, and the summary's
Stop-reason line.

- Failing test first: verification-executor test with one failing and one
  timing-out command, asserting the reason names both truthfully.

**1d. A deterministic timeout does not re-run the implementer.**
Cheap variant, recommended now: in the verification executor, when every
failing observation has `timed_out: true`, skip `recoveryRouteForFailure`
and fail the step directly with the 1c reason. Retrying a fixed budget is
provably futile; the honest stop saves the whole wasted loop.

Contract-clean variant, post-v1: add a `check_timed_out` member to
`RecoveryFailureCause`, admit it only to `checkpoint_authority`, `stop_unsafe`,
`escalate`, and `handoff` in `RECOVERY_KIND_CONTRACT_RULES`, and let
schematics route it to an operator question ("raise the budget or verify
yourself?"). That touches compiled flow packages and the recovery contract,
too much for the freeze.

- Failing test first: executor test where all failures are timeouts,
  asserting no recovery route is taken and the failure reason is the honest
  one.

**1e (decision fork). Operator-steerable verification.**
`verification.timeout_ms` and `verification.script` keys in the layered
config (`.circuit/config.yaml`). The honest-oracle rule survives because
config is operator-owned, not worker-owned. Cost: the checkpoint and plan
writer contexts (`CheckpointBuildContext` and friends) do not carry config
today, so this is real plumbing, and it is a genuine new surface during
the launch freeze. Recommendation: defer to post-v1. With 1a landed the
burning need is gone.

### Cluster 2: close legibility (F6, F7)

**2a. `needs_attention` names its causes.**
In `terminalOutcomeBoundToPrimaryResult` (`src/runtime/run/run-close.ts:65-100`),
derive cause phrases from the parsed result it already holds: each
unassessed guardrail (verbatim text), each violated guardrail,
`review_verdict: 'accept-with-fixes'`, out-of-bounds touch paths. Append
them to the reason string. The function fails open, so shape mismatches
degrade to today's generic reason. No result-schema change: the cause is
recomputed from evidence, matching the close-projector philosophy, and a
worker never gets to self-report it.

- Failing test first: run-close test with a result carrying one unassessed
  guardrail, asserting the reason names it.

**2b. Stopped and aborted summaries hand over the salvage.**
In the stopped-run path of `src/app/operator-summary/writer.ts`:

- When the run failed a verification step, render the failing or timed-out
  command line from the verification report (which 1c makes honest).
- When a write-capable worker ran and the run did not complete, state
  plainly: the attempt's edits remain uncommitted in the working tree.
- When the review step never completed, state: independent review did not
  run.
- Replace the generic Next with the real menu: review the diff, run
  verification at your own budget, resume or rerun, or discard.

- Failing test first: extend `tests/runner/operator-summary-writer.test.ts`
  with an aborted-on-verification fixture asserting all three lines.

### Cluster 3: cross-repo teachability (F8)

**3a. The fail-closed message teaches its remedies.**
Extend `RUNTIME_POLICY_REASONS.externalFixtureOrRoot`
(`src/cli/runtime-routing-policy.ts:23`) to name the three sanctioned
paths: run from the Circuit checkout, point `--flow-root` at a trusted
location, or bless a mirror by setting
`CIRCUIT_GENERATED_FLOW_MIRROR_ROOT`. Message-only; the policy itself does
not move.

- Failing test first: policy test asserting the message names the env var.

### Cluster 4: agent-channel noise (F9)

**4a. Deduplicate recall warnings at the render boundary.**
Group identical warning codes where run-start recall formats them: one
line, `source_pruned x3 (largest: <chars> from <path>)`. Emission stays
per-document (the index wants the detail); only the print collapses.

- Failing test first: formatter unit test with three same-code warnings
  asserting one rendered line.

## What is deliberately excluded

- **Running review on an aborted diff.** Aborted runs skip review; the
  salvage summary (2b) discloses that instead. Whether an abort should
  trigger a bounded review pass is a real product question, post-v1.
- **A reason field on the result schema.** Derivation at close (2a) is
  strictly better: no worker self-report, no schema churn.
- **Config-steerable verification now** (1e). Deferred by default, Pete
  can pull it forward.

## Decision forks for Pete

1. **Freeze classification.** I read clusters 1 through 4 as bug fixes and
   legibility repairs, inside the freeze rules. Confirm or trim.
2. **The budget number.** 600s aligns Build with Fix and covers this
   repo's full verify with headroom. Alternative: something bigger for
   slow repos, at the cost of slower honest failures. 1e is the eventual
   real answer.
3. **Timeout routing depth.** Cheap guard now (recommended) vs the
   `check_timed_out` recovery cause now. The enum change ripples through
   the recovery contract and compiled packages.
4. **1e now or post-v1.** Default: post-v1.

## Execution plan

All through Circuit, in this order:

| Run | Flow | Scope | Note |
| --- | --- | --- | --- |
| 1 | Fix | 1a budget alignment | The one-line fix that unblocks every later run's own verify step. Expect this run itself to trip the old budget; salvage at the boundary one last time. |
| 2 | Fix | 1b + 1c + 1d | One coherent seam: proof-plan, shared schemas, verification executor. Failing tests first. |
| 3 | Build | 2a + 2b | Close reason and summary rendering. |
| 4 | Build | 3a + 4a | Two small message/formatter changes, one run. |

Observed Build/Fix runs here cost $2.70 to $10.74; with run 1 landed
first, runs 2 through 4 should sit at the low end. Estimate $15 to $25
total. Full `npm run verify` at each boundary before commit, output to a
log file, never through a pipe.

After run 1 lands, the verify step inside runs takes up to several
minutes. That is the check doing its job; the readout stays honest.
