// Reuse-children lookup for restart cheapness (`--reuse-children-from`).
//
// When a fresh run is pointed at a prior crashed run's folder, a sub-run fanout
// branch can reuse that run's finished child instead of re-running the expensive
// child flow. The lookup addresses a prior child by its STRUCTURAL address —
// (step_id, branch_id) — which is stable across restarts because it comes from
// the flow and the branch expansion, not from the run id. It never resumes the
// dead run; it only reads its trace and its on-disk artifacts.
//
// The safety floor lives here. A child is reusable only when ALL hold:
//   1. it ran as a `sub-run` branch (an isolating worktree), not a `relay`
//      branch (which mutates the shared checkout — reusing only its verdict
//      would drop the tree changes the fresh checkout does not carry);
//   2. it ran the SAME flow this fresh branch targets — the prior result's
//      flow_id must equal the branch's flow_ref. The structural address
//      (step_id, branch_id) is stable across restarts but says nothing about
//      what was built there, so without this a re-pointed flow would silently
//      admit a child built from a different flow;
//   3. it closed `complete` with an admissible result that still parses;
//   4. its worktree is still a usable git worktree on disk (the dir exists and
//      carries a `.git` entry). A `sub-run` branch does its work in this
//      worktree, and the disjoint-merge join reads the branch's changed files
//      from it; if the reaper removed it (or it was left a bare directory) the
//      effect is gone, so refusing is the conservative choice across every join
//      policy — those that decide purely from the result_body are unaffected.
// Any miss returns undefined, and the caller runs the child fresh. Refusing is
// always safe; it is only slower.
//
// What this does NOT check: the child flow's VERSION or the base commit it ran
// against. `--reuse-children-from` is a crash-restart aid that assumes the same
// flow at the same goal; reusing across a flow version bump or a moved base is a
// known limitation, not a guarded invariant.

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { RunResult } from '../../schemas/result.js';
import type { TraceEntry } from '../domain/trace.js';
import { TraceStore } from '../trace/trace-store.js';

export interface ReusableSubRunBranch {
  /** The prior child's run id, recorded on the reused completion entry. */
  readonly childRunId: string;
  /** Absolute path to the prior branch's worktree (verified to exist). */
  readonly worktreePath: string;
  /** The prior child's terminal result, parsed and admissible-shaped. */
  readonly resultBody: RunResult;
}

export interface ReuseLookupInput {
  /** The dead run folder the fresh run was pointed at. */
  readonly priorRunFolder: string;
  readonly stepId: string;
  readonly branchId: string;
  /** The flow this fresh branch targets; the prior child must have run it too. */
  readonly expectedFlowRef: string;
}

function isCompletedSubRunBranch(
  entry: TraceEntry,
  stepId: string,
  branchId: string,
): entry is Extract<TraceEntry, { kind: 'fanout.branch_completed' }> {
  return (
    entry.kind === 'fanout.branch_completed' &&
    entry.step_id === stepId &&
    entry.branch_id === branchId &&
    entry.branch_kind === 'sub-run' &&
    entry.child_outcome === 'complete'
  );
}

/**
 * Find a reusable finished sub-run branch in a prior crashed run, or undefined
 * when none is admissible (caller then runs the child fresh). Never throws: a
 * corrupt or missing prior trace simply means "nothing to reuse".
 */
export async function lookupReusableSubRunBranch(
  input: ReuseLookupInput,
): Promise<ReusableSubRunBranch | undefined> {
  let entries: readonly TraceEntry[];
  try {
    entries = await new TraceStore(input.priorRunFolder).load();
  } catch {
    // A torn/corrupt prior trace is not reusable. Run fresh.
    return undefined;
  }

  // Latest admissible completion for this structural address. A re-attempted
  // branch may have several; the last one is the one that stuck.
  let completed: Extract<TraceEntry, { kind: 'fanout.branch_completed' }> | undefined;
  for (const entry of entries) {
    if (isCompletedSubRunBranch(entry, input.stepId, input.branchId)) {
      completed = entry;
    }
  }
  if (completed === undefined) return undefined;

  // The matching start carries the worktree path (where the branch effect lives).
  let worktreePath: string | undefined;
  for (const entry of entries) {
    if (
      entry.kind === 'fanout.branch_started' &&
      entry.step_id === input.stepId &&
      entry.branch_id === input.branchId &&
      entry.child_run_id === completed.child_run_id
    ) {
      worktreePath = entry.worktree_path;
    }
  }
  if (worktreePath === undefined) return undefined;

  // Safety gate: the branch effect lives in the worktree. Require a usable git
  // worktree (the dir exists AND carries a `.git` entry), not just a leftover
  // directory. A reaped worktree fails the dir check; a half-cleaned one fails
  // the `.git` check. Either way, refusing and re-running is the safe direction.
  if (!existsSync(join(worktreePath, '.git'))) return undefined;

  // The branch's copied result.json lives at result_path relative to the prior
  // run folder (the executor wrote it there with run-folder-scoped files).
  const resultAbs = isAbsolute(completed.result_path)
    ? completed.result_path
    : join(input.priorRunFolder, completed.result_path);
  let resultBody: RunResult;
  try {
    resultBody = RunResult.parse(JSON.parse(readFileSync(resultAbs, 'utf8')));
  } catch {
    return undefined;
  }
  if (resultBody.outcome !== 'complete') return undefined;
  // Identity gate: the structural address is stable across restarts but carries
  // no flow identity, so confirm the prior child ran the same flow this branch
  // now targets before admitting its result.
  if (resultBody.flow_id !== input.expectedFlowRef) return undefined;

  return { childRunId: completed.child_run_id, worktreePath, resultBody };
}
