# Pre-launch audit remediation

Date: 2026-07-09

Ahead of the public v1 launch, Circuit went through a full-system audit for
correctness, security, concurrency, release integrity, and documentation
honesty. This record lists what the audit found and how each item was resolved.

## Outcome

Every finding is resolved in code with a focused test, or deferred with a
stated reason. The full `npm run verify` gate is green: type-check, lint, build,
the complete test suite, and all release gates including golden-proof freshness.

## Critical

**C1. Arbitrary command execution through a project config.**
A connector that runs a chosen command could be declared in a project's own
`.circuit/config.yaml` and was honored during a run. A cloned or downloaded
repository could therefore run a command on the operator's machine. Fix:
command-bearing connectors are now honored only from operator-controlled
sources (the built-in defaults, the user's global config, or an explicit
invocation flag). A project can no longer introduce one, and the refusal is
explained in plain language. Built-in connectors stay available from any source.

**C1b. The same execution path through the policy schema.**
The policy connector registry had the same gap by a second route. Fix: the
identical origin boundary now guards the policy path, covering both the
project-config bridge and a direct policy config.

## High

**H1. A Fix could close as complete while its own result said partial.**
The Fix flow could finish a run as complete, with a success exit code, even
when its own result reported a partial fix. The printed summary carried the
caveat, but the exit code and the machine-readable outcome did not. Fix: a Fix
whose primary result is partial now closes the run as stopped, with a failing
exit code. The run outcome can no longer claim more than the result behind it.

**H2. Connector and worktree work ignored the project directory.**
The claude-code connector and the git worktree add and remove steps did not
consistently use the project root as their working directory. Fix: the project
root is threaded through every git mutation site.

**H3. A demotion only half-applied.**
The Pursue flow's demotion path did not fully land. Fix: the demotion now
applies completely.

**H5. A repeated resume could brick the run trace.**
Two resume attempts on the same run could race and corrupt the trace. Fix: a
resume-entry owner lock admits a single resumer and turns the second into a
clean, explained refusal.

## Medium

- **M1.** The exit code now honors a re-derived needs-attention outcome.
- **M3.** The `.circuit/` control-plane directory is gitignored so it is never
  committed by accident.
- **M4.** The shipped runtime bundles keep their dependency license notices.
- **M5.** Two result schemas gained cross-field checks so a status and its
  evidence cannot disagree.
- **M7.** When Codex returns a type Circuit has not reviewed, the error now
  names the tested CLI range and points the operator at the fix, instead of
  failing with a bare unknown-type message.
- **M8.** A dead module that was documented as live was removed.
- **M9.** The release gates were hardened: content-level parity checks, real
  execution of the backing check scripts, a captured-proof freshness guard, and
  a safer publish path with tag-collision pre-flight and rollback.
- **M10.** Several docs were reconciled with the shipped behavior.
- **M11.** The continuity hook now validates the pinned Node path it was
  installed with, so a Node relocation surfaces as a clear doctor finding.
- **M12.** Two tests that asserted nothing meaningful were made real.
- **M13.** A healer that repairs a run record after a crash mid-close is now
  wired into the read path.
- **M14.** Bundled with H2: the git worktree steps honor the project root.

## Low

Gate hardening (fail-closed flow visibility, detection of a missing audit
target, a Node 23.0 to 23.5 floor where type-stripping is not yet available,
and a corrected self-execution guard) plus removal of an internal codename and
a few personal references from shipped surfaces.

## Deferred

A small number of items are tracked for follow-up rather than fixed here: the
launch-plan document is being refreshed in a separate change, a fresh release
tag is cut as part of the normal release step, and a few repository-hygiene and
product-scope questions are tracked separately. None of these block the
correctness or security posture above.

## Verification

- Each fix ships with a focused test written against the behavior it changes.
- The runtime bundles were regenerated and the golden run proofs recaptured;
  the Fix proof now records the honest stopped close.
- `npm run verify` passes end to end.
