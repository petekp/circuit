import type {
  AcceptanceCriteria,
  AcceptanceCriteriaFailurePolicy,
  AcceptanceCriterion,
} from '../schemas/acceptance-criteria.js';
import { type ProofPlanCommandObservation, runProofPlanCommand } from '../shared/proof-plan.js';
import { captureWorkingTreeChangedPaths } from '../shared/working-tree-changes.js';

export interface AcceptanceCriterionTrace {
  readonly criterion_id: string;
  readonly criterion_kind: AcceptanceCriterion['kind'];
  readonly outcome: 'pass' | 'fail';
  readonly reason?: string;
  readonly exit_code?: number;
  readonly status?: 'passed' | 'failed';
  readonly stdout_summary?: string;
  readonly stderr_summary?: string;
}

export interface AcceptanceRetryFeedback {
  readonly step_id: string;
  readonly criterion_id: string;
  readonly criterion_kind: AcceptanceCriterion['kind'];
  readonly reason: string;
  readonly exit_code?: number;
  readonly status?: 'passed' | 'failed';
  readonly stdout_summary?: string;
  readonly stderr_summary?: string;
}

export function isAcceptanceRetryFeedback(value: unknown): value is AcceptanceRetryFeedback {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.step_id === 'string' &&
    record.step_id.length > 0 &&
    typeof record.criterion_id === 'string' &&
    record.criterion_id.length > 0 &&
    (record.criterion_kind === 'command' || record.criterion_kind === 'report_field') &&
    typeof record.reason === 'string' &&
    record.reason.length > 0
  );
}

export type AcceptanceCriteriaEvaluationResult =
  | {
      readonly kind: 'pass';
      readonly checks: readonly AcceptanceCriterionTrace[];
    }
  | {
      readonly kind: 'fail';
      readonly reason: string;
      readonly on_failure: AcceptanceCriteriaFailurePolicy;
      readonly checks: readonly AcceptanceCriterionTrace[];
      readonly feedback: AcceptanceRetryFeedback;
    };

function pathLabel(path: readonly string[]): string {
  return path.join('.');
}

function valueAtPath(root: unknown, path: readonly string[]): unknown {
  let cursor = root;
  for (const segment of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    if (!Object.hasOwn(cursor, segment)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function isNonEmpty(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === 'object') return Object.keys(value).length > 0;
  return value !== undefined && value !== null;
}

/**
 * Extract the path list a worker claimed at a report field. A lone string is
 * treated as a single claim; an array keeps only its string entries. Anything
 * else yields no claims — asserting presence is the job of the sibling
 * 'present'/'non_empty' checks, not this one.
 */
function claimedPaths(value: unknown): string[] {
  const raw = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    // Worker self-reports may carry OS separators or a leading ./; git status
    // emits repo-relative forward-slash paths, so align to that shape.
    let path = entry.trim().replace(/\\/g, '/');
    while (path.startsWith('./')) path = path.slice(2);
    if (path.length > 0) out.push(path);
  }
  return out;
}

type ReportFieldVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * The `changed_on_disk` predicate: every path the worker claimed must actually
 * differ in the working tree. Sound in the OVERCLAIM direction — a claimed path
 * that shows no change while the tree IS observable is a provable lie.
 *
 * The predicate asserts a property of an OBSERVABLE working tree, so it fires
 * only when it can actually look. When it cannot — no project root, or git
 * cannot read the tree (e.g. not a repository) — the claim is vacuously
 * consistent and the check passes. This is safe: a worker cannot induce
 * git-unavailability to hide an overclaim (it is environmental, and real runs
 * always operate on a git repo), and the rest of the touched-files machinery is
 * already inert off-git. Failing here would also produce nonsense retry
 * feedback ("retry because git would not run"), which the worker cannot act on.
 * Extra real changes the worker did NOT claim never fail the gate.
 */
function evaluateChangedOnDisk(args: {
  readonly criterionId: string;
  readonly label: string;
  readonly value: unknown;
  readonly projectRoot: string | undefined;
  readonly capture: (projectRoot: string) => ReadonlySet<string>;
}): ReportFieldVerdict {
  const claimed = claimedPaths(args.value);
  if (claimed.length === 0) return { ok: true };

  // No working tree to observe → inapplicable, not a failure.
  if (args.projectRoot === undefined) return { ok: true };

  let dirty: ReadonlySet<string>;
  try {
    dirty = args.capture(args.projectRoot);
  } catch {
    // Tree not observable (git error / not a repo) → inapplicable, not a failure.
    return { ok: true };
  }

  const overclaimed = claimed.filter((path) => !dirty.has(path));
  if (overclaimed.length === 0) return { ok: true };
  const noun = overclaimed.length === 1 ? 'a path with' : 'paths with';
  return {
    ok: false,
    reason: `acceptance criterion '${args.criterionId}' failed: report field '${args.label}' lists ${noun} no change in the working tree: ${overclaimed.join(', ')}`,
  };
}

function parseReportBody(
  stepId: string,
  resultBody: string,
):
  | { kind: 'ok'; value: unknown }
  | {
      kind: 'fail';
      reason: string;
    } {
  try {
    return { kind: 'ok', value: JSON.parse(resultBody) as unknown };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: 'fail',
      reason: `relay step '${stepId}': acceptance criteria could not parse relay result JSON (${message})`,
    };
  }
}

function failureResult(input: {
  readonly stepId: string;
  readonly criteria: AcceptanceCriteria;
  readonly checks: readonly AcceptanceCriterionTrace[];
  readonly failed: AcceptanceCriterionTrace & { readonly outcome: 'fail'; readonly reason: string };
}): AcceptanceCriteriaEvaluationResult {
  return {
    kind: 'fail',
    reason: input.failed.reason,
    on_failure: input.criteria.on_failure,
    checks: input.checks,
    feedback: {
      step_id: input.stepId,
      criterion_id: input.failed.criterion_id,
      criterion_kind: input.failed.criterion_kind,
      reason: input.failed.reason,
      ...(input.failed.exit_code === undefined ? {} : { exit_code: input.failed.exit_code }),
      ...(input.failed.status === undefined ? {} : { status: input.failed.status }),
      ...(input.failed.stdout_summary === undefined
        ? {}
        : { stdout_summary: input.failed.stdout_summary }),
      ...(input.failed.stderr_summary === undefined
        ? {}
        : { stderr_summary: input.failed.stderr_summary }),
    },
  };
}

function commandTrace(
  criterion: Extract<AcceptanceCriterion, { readonly kind: 'command' }>,
  observation: ProofPlanCommandObservation,
): AcceptanceCriterionTrace {
  const base = {
    criterion_id: criterion.id,
    criterion_kind: criterion.kind,
    exit_code: observation.exit_code,
    status: observation.status,
    stdout_summary: observation.stdout_summary,
    stderr_summary: observation.stderr_summary,
  } as const;
  if (observation.status === criterion.expected_status) {
    return { ...base, outcome: 'pass' };
  }
  return {
    ...base,
    outcome: 'fail',
    reason: `acceptance criterion '${criterion.id}' failed: command '${criterion.command.id}' exited ${observation.exit_code}`,
  };
}

export async function evaluateAcceptanceCriteria(input: {
  readonly stepId: string;
  readonly criteria: AcceptanceCriteria;
  readonly resultBody: string;
  readonly parsedBody?: unknown;
  readonly projectRoot?: string;
  // Working-tree capture used by the `changed_on_disk` predicate. Defaults to a
  // real `git status` at projectRoot; injectable so unit tests stay hermetic.
  readonly captureChangedPaths?: (projectRoot: string) => ReadonlySet<string>;
  // Command proof must use the host's injected runner when one is present.
  // Ordinary CLI calls leave this unset and retain the existing local runner.
  readonly runProofCommand?: (
    command: Extract<AcceptanceCriterion, { readonly kind: 'command' }>['command'],
    projectRoot: string,
  ) => ProofPlanCommandObservation | Promise<ProofPlanCommandObservation>;
}): Promise<AcceptanceCriteriaEvaluationResult> {
  const checks: AcceptanceCriterionTrace[] = [];
  let parsedBody = input.parsedBody;

  for (const criterion of input.criteria.checks) {
    if (criterion.kind === 'report_field') {
      if (parsedBody === undefined) {
        const parsed = parseReportBody(input.stepId, input.resultBody);
        if (parsed.kind === 'fail') {
          const failed = {
            criterion_id: criterion.id,
            criterion_kind: criterion.kind,
            outcome: 'fail' as const,
            reason: parsed.reason,
          };
          checks.push(failed);
          return failureResult({
            stepId: input.stepId,
            criteria: input.criteria,
            checks,
            failed,
          });
        }
        parsedBody = parsed.value;
      }

      const value = valueAtPath(parsedBody, criterion.path);

      if (criterion.predicate === 'changed_on_disk') {
        const verdict = evaluateChangedOnDisk({
          criterionId: criterion.id,
          label: pathLabel(criterion.path),
          value,
          projectRoot: input.projectRoot,
          capture: input.captureChangedPaths ?? captureWorkingTreeChangedPaths,
        });
        if (verdict.ok) {
          checks.push({
            criterion_id: criterion.id,
            criterion_kind: criterion.kind,
            outcome: 'pass',
          });
          continue;
        }
        const failed = {
          criterion_id: criterion.id,
          criterion_kind: criterion.kind,
          outcome: 'fail' as const,
          reason: verdict.reason,
        };
        checks.push(failed);
        return failureResult({
          stepId: input.stepId,
          criteria: input.criteria,
          checks,
          failed,
        });
      }

      const ok = criterion.predicate === 'present' ? value !== undefined : isNonEmpty(value);
      if (ok) {
        checks.push({
          criterion_id: criterion.id,
          criterion_kind: criterion.kind,
          outcome: 'pass',
        });
        continue;
      }
      const failed = {
        criterion_id: criterion.id,
        criterion_kind: criterion.kind,
        outcome: 'fail' as const,
        reason: `acceptance criterion '${criterion.id}' failed: report field '${pathLabel(criterion.path)}' did not satisfy '${criterion.predicate}'`,
      };
      checks.push(failed);
      return failureResult({
        stepId: input.stepId,
        criteria: input.criteria,
        checks,
        failed,
      });
    }

    if (input.projectRoot === undefined) {
      const failed = {
        criterion_id: criterion.id,
        criterion_kind: criterion.kind,
        outcome: 'fail' as const,
        reason: `acceptance criterion '${criterion.id}' failed: command criteria require projectRoot`,
      };
      checks.push(failed);
      return failureResult({
        stepId: input.stepId,
        criteria: input.criteria,
        checks,
        failed,
      });
    }

    try {
      const trace = commandTrace(
        criterion,
        await (input.runProofCommand ?? runProofPlanCommand)(criterion.command, input.projectRoot),
      );
      checks.push(trace);
      if (trace.outcome === 'fail') {
        const failed = {
          ...trace,
          outcome: 'fail' as const,
          reason:
            trace.reason ??
            `acceptance criterion '${criterion.id}' failed: command '${criterion.command.id}' did not satisfy '${criterion.expected_status}'`,
        };
        checks[checks.length - 1] = failed;
        return failureResult({
          stepId: input.stepId,
          criteria: input.criteria,
          checks,
          failed,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = {
        criterion_id: criterion.id,
        criterion_kind: criterion.kind,
        outcome: 'fail' as const,
        reason: `acceptance criterion '${criterion.id}' failed: ${message}`,
      };
      checks.push(failed);
      return failureResult({
        stepId: input.stepId,
        criteria: input.criteria,
        checks,
        failed,
      });
    }
  }

  return { kind: 'pass', checks };
}
