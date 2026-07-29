import type { FanoutStep } from '../schemas/step.js';
import {
  type RunClosedOutcome,
  RunClosedOutcome as RunClosedOutcomeEnum,
} from '../schemas/trace-entry.js';

// A fanout child closes with the same outcome set as any run; alias the
// canonical run-closed outcome rather than re-enumerating it.
export type FanoutJoinChildOutcome = RunClosedOutcome;

// Pure-function inputs for the join policy decision. Every field listed here
// is either a literal from the flow, a per-branch summary derived from
// already-completed child runs, or precomputed disjoint-merge file evidence.
export interface FanoutJoinOutcome {
  readonly branch_id: string;
  readonly child_outcome: FanoutJoinChildOutcome;
  readonly verdict: string;
  readonly admitted: boolean;
  // Present iff `child_outcome === 'complete'` and the child's result parsed to
  // an object. aggregate-only treats `undefined` as "non-parseable".
  readonly result_body?: unknown;
  readonly failure_reason?: string;
}

export interface FanoutJoinInput {
  readonly policy: FanoutStep['check']['join']['policy'];
  readonly stepId: string;
  readonly admitOrder: readonly string[];
  readonly outcomes: readonly FanoutJoinOutcome[];
  // disjoint-merge only: changed files per branch_id. Either `branchFiles` is
  // provided or `branchFilesError` is set when discovery failed.
  readonly branchFiles?: ReadonlyMap<string, readonly string[]>;
  readonly branchFilesError?: string;
}

export interface FanoutJoinResult {
  readonly joinedSuccessfully: boolean;
  readonly winnerBranchId?: string;
  readonly failureReason?: string;
}

export function evaluateFanoutJoinPolicy(input: FanoutJoinInput): FanoutJoinResult {
  const { policy, stepId, admitOrder, outcomes } = input;

  if (policy === 'pick-winner') {
    for (const admittedVerdict of admitOrder) {
      const found = outcomes.find(
        (outcome) => outcome.child_outcome === 'complete' && outcome.verdict === admittedVerdict,
      );
      if (found !== undefined) {
        return { joinedSuccessfully: true, winnerBranchId: found.branch_id };
      }
    }
    return {
      joinedSuccessfully: false,
      failureReason: `fanout step '${stepId}' pick-winner: no branch closed 'complete' with an admitted verdict (admit order [${admitOrder.join(', ')}])`,
    };
  }

  if (policy === 'disjoint-merge') {
    if (!outcomes.every((outcome) => outcome.admitted)) {
      return {
        joinedSuccessfully: false,
        failureReason: `fanout step '${stepId}' disjoint-merge: not all branches closed 'complete' with an admitted verdict`,
      };
    }
    if (input.branchFilesError !== undefined) {
      return {
        joinedSuccessfully: false,
        failureReason: `fanout step '${stepId}' disjoint-merge: file-disjoint validation failed (${input.branchFilesError})`,
      };
    }
    const branchFiles = input.branchFiles;
    if (branchFiles === undefined) {
      throw new Error(
        'evaluateFanoutJoinPolicy: disjoint-merge requires branchFiles or branchFilesError',
      );
    }
    const seenFile = new Map<string, string>();
    for (const outcome of outcomes) {
      const files = branchFiles.get(outcome.branch_id) ?? [];
      for (const file of files) {
        const prior = seenFile.get(file);
        if (prior !== undefined && prior !== outcome.branch_id) {
          return {
            joinedSuccessfully: false,
            failureReason: `fanout step '${stepId}' disjoint-merge: file '${file}' modified by branches '${prior}' and '${outcome.branch_id}'`,
          };
        }
        seenFile.set(file, outcome.branch_id);
      }
    }
    return { joinedSuccessfully: true };
  }

  const parseableSurvivors = outcomes.filter(
    (outcome) => outcome.child_outcome === 'complete' && outcome.result_body !== undefined,
  );

  if (policy === 'aggregate-survivors') {
    if (parseableSurvivors.length >= 2) return { joinedSuccessfully: true };
    const failedOutcome = outcomes.find((outcome) => outcome.failure_reason !== undefined);
    const detail =
      failedOutcome?.failure_reason === undefined ? '' : ` (${failedOutcome.failure_reason})`;
    return {
      joinedSuccessfully: false,
      failureReason: `tournament collapsed: fanout step '${stepId}' had ${parseableSurvivors.length} parseable survivor(s), need at least 2${detail}`,
    };
  }

  // At least one branch answered. The parent's close step is responsible for
  // saying which branches did not — a join that passed here is not a claim that
  // everything was covered, only that there is something to report on.
  if (policy === 'aggregate-any') {
    if (parseableSurvivors.length >= 1) return { joinedSuccessfully: true };
    const failedOutcome = outcomes.find((outcome) => outcome.failure_reason !== undefined);
    return {
      joinedSuccessfully: false,
      failureReason:
        failedOutcome?.failure_reason === undefined
          ? `fanout step '${stepId}' aggregate-any: no branch produced a parseable result body`
          : `fanout step '${stepId}' aggregate-any: no branch produced a parseable result body (${failedOutcome.failure_reason})`,
    };
  }

  if (policy === 'aggregate-only') {
    const allClosed = outcomes.every((outcome) =>
      (RunClosedOutcomeEnum.options as readonly string[]).includes(outcome.child_outcome),
    );
    const allParseable = parseableSurvivors.length === outcomes.length;
    if (!allClosed) {
      return {
        joinedSuccessfully: false,
        failureReason: `fanout step '${stepId}' aggregate-only: at least one branch did not close cleanly`,
      };
    }
    if (!allParseable) {
      const failedOutcome = outcomes.find((outcome) => outcome.failure_reason !== undefined);
      return {
        joinedSuccessfully: false,
        failureReason:
          failedOutcome?.failure_reason === undefined
            ? `fanout step '${stepId}' aggregate-only: at least one branch did not produce a parseable result body`
            : `fanout step '${stepId}' aggregate-only: ${failedOutcome.failure_reason}`,
      };
    }
    return { joinedSuccessfully: true };
  }

  return assertNever(policy);
}

// Compile-time exhaustiveness guard: if a join policy is added to the schema
// without a branch above, `policy` is no longer `never` here and tsc fails.
function assertNever(value: never): never {
  throw new Error(`evaluateFanoutJoinPolicy: unhandled join policy ${JSON.stringify(value)}`);
}
