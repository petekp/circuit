import type { FanoutStep } from '../../schemas/step.js';
import type { RunClosedOutcome } from '../domain/run.js';
export { NO_VERDICT_SENTINEL } from '../run/relay-support.js';

// Single-sourced from the flow schema: the join-policy names are exactly the
// discriminant of FanoutStep.check.join, so a policy added to the schema flows
// here automatically rather than being re-spelled.
export type FanoutJoinPolicy = FanoutStep['check']['join']['policy'];

export interface ResolvedSubRunBranch {
  readonly kind: 'sub-run';
  readonly branch_id: string;
  readonly flowRef: string;
  readonly entryMode: string;
  readonly version?: string;
  readonly goal: string;
  readonly depth: string;
  readonly selection?: unknown;
}

export interface ResolvedRelayBranch {
  readonly kind: 'relay';
  readonly branch_id: string;
  readonly role: string;
  readonly goal: string;
  readonly report_schema: string;
  // Branch-local evidence, appended to the fanout step's own reads. Already
  // `$item`-substituted by the time it lands here.
  readonly reads?: readonly string[];
  readonly provenance_field?: string;
  readonly connector?: string;
  readonly selection?: unknown;
}

export type ResolvedBranch = ResolvedSubRunBranch | ResolvedRelayBranch;

export interface BranchOutcome {
  readonly branch_id: string;
  readonly child_run_id: string;
  readonly worktree_path: string;
  readonly child_outcome: RunClosedOutcome;
  readonly verdict: string;
  readonly result_path: string;
  readonly result_body?: unknown;
  readonly duration_ms: number;
  readonly admitted: boolean;
  readonly failure_reason?: string;
}
