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
  // Text lifted off this branch's source item, which the engine writes into the
  // branch folder and adds to the branch's reads. Carried as the resolved text
  // rather than as a field name so the item itself does not have to travel.
  readonly item_evidence?: string;
  // False when this branch reads only its own evidence, not the step's.
  readonly inherit_step_reads?: boolean;
  readonly provenance_field?: string;
  // Asks allowed before this branch fails. Absent means one.
  readonly max_attempts?: number;
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
