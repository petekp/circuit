import { z } from 'zod';
import { EquipmentDiscovery } from '../../schemas/equipment-discovery.js';
import { PowerRecommendation } from '../../schemas/power.js';
import { RuntimeGitStateEntry, RuntimeHiddenIndexFlag } from '../../schemas/runtime-evidence.js';
import { VerificationCommand } from '../../schemas/verification.js';
import { resultReportPointer } from '../report-schema-kit.js';

const FIX_RESULT_SCHEMA_BY_ARTIFACT_ID = {
  'fix.brief': 'fix.brief@v1',
  'fix.context': 'fix.context@v1',
  'fix.diagnosis': 'fix.diagnosis@v1',
  'fix.no-repro-decision': 'fix.no-repro-decision@v1',
  'fix.regression-proof': 'fix.regression-proof@v1',
  'fix.baseline-snapshot': 'fix.baseline-snapshot@v1',
  'fix.change': 'fix.change@v1',
  'fix.verification': 'fix.verification@v1',
  'fix.regression-rerun': 'fix.regression-rerun@v1',
  'fix.change-set': 'fix.change-set@v1',
  'fix.review': 'fix.review@v1',
} as const;

const FIX_RESULT_PATH_BY_ARTIFACT_ID = {
  'fix.brief': 'reports/fix/brief.json',
  'fix.context': 'reports/fix/context.json',
  'fix.diagnosis': 'reports/fix/diagnosis.json',
  'fix.no-repro-decision': 'reports/fix/no-repro-decision.json',
  'fix.regression-proof': 'reports/fix/regression-proof.json',
  'fix.baseline-snapshot': 'reports/fix/baseline-snapshot.json',
  'fix.change': 'reports/fix/change.json',
  'fix.verification': 'reports/fix/verification.json',
  'fix.regression-rerun': 'reports/fix/regression-rerun.json',
  'fix.change-set': 'reports/fix/change-set.json',
  'fix.review': 'reports/fix/review.json',
} as const;

const REQUIRED_FIX_RESULT_ARTIFACT_IDS = [
  'fix.brief',
  'fix.context',
  'fix.diagnosis',
  'fix.regression-proof',
  'fix.baseline-snapshot',
  'fix.change',
  'fix.verification',
  'fix.regression-rerun',
  'fix.change-set',
] as const;

const NonEmptyStringArray = z.array(z.string().min(1)).min(1);

// Lenient form for relay-emitted evidence-style fields. Workers occasionally
// answer with a single string ("git diff README.md shows: ...") on retry
// attempts where the recovery context confuses the schema field name with a
// freeform-prose request. Accept either a single non-empty string or a
// non-empty array of non-empty strings; normalize to array. Expressed as a
// `z.union` (not `z.preprocess`) so the JSON Schema piped to the CLI via
// `responseJsonSchemaFromZod` correctly renders both shapes as `anyOf` and
// the leniency holds at both the Zod boundary and the CLI boundary. Evidence
// is documentation/audit only — no downstream consumer dereferences elements,
// so the array normalization is purely for type consistency.
const LenientNonEmptyStringArray = z.union([
  z
    .string()
    .min(1)
    .transform((value) => [value] as string[]),
  z.array(z.string().min(1)).min(1),
]);

export const FixVerificationCommand = VerificationCommand;
export type FixVerificationCommand = z.infer<typeof FixVerificationCommand>;

export const FixRegressionContract = z
  .object({
    expected_behavior: z.string().min(1),
    actual_behavior: z.string().min(1),
    repro: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('command'),
          command: FixVerificationCommand,
        })
        .strict(),
      z
        .object({
          kind: z.literal('procedure'),
          procedure: z.string().min(1),
        })
        .strict(),
      z
        .object({
          kind: z.literal('not-reproducible'),
          deferred_reason: z.string().min(1),
        })
        .strict(),
    ]),
    regression_test: z.discriminatedUnion('status', [
      z
        .object({
          status: z.literal('failing-before-fix'),
          command: FixVerificationCommand,
        })
        .strict(),
      z
        .object({
          status: z.literal('deferred'),
          deferred_reason: z.string().min(1),
        })
        .strict(),
    ]),
  })
  .strict()
  .superRefine((contract, ctx) => {
    if (
      contract.repro.kind !== 'not-reproducible' &&
      contract.regression_test.status !== 'failing-before-fix'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['regression_test', 'status'],
        message: "regression_test.status must be 'failing-before-fix' when repro evidence exists",
      });
    }
  });
export type FixRegressionContract = z.infer<typeof FixRegressionContract>;

export const FixBrief = z
  .object({
    problem_statement: z.string().min(1),
    expected_behavior: z.string().min(1),
    observed_behavior: z.string().min(1),
    scope: z.string().min(1),
    regression_contract: FixRegressionContract,
    success_criteria: NonEmptyStringArray,
    verification_command_candidates: z.array(FixVerificationCommand).min(1),
  })
  .strict();
export type FixBrief = z.infer<typeof FixBrief>;

export const FixContextSource = z
  .object({
    kind: z.enum(['file', 'command', 'log', 'operator-note', 'reference']),
    ref: z
      .string()
      .min(1)
      .describe('project-relative path, command id, log line, note id, or external reference'),
    summary: z.string().min(1).describe('one-line summary of what this source contributed'),
  })
  .strict();
export type FixContextSource = z.infer<typeof FixContextSource>;

export const FixContext = z
  .object({
    verdict: z.literal('accept'),
    sources: z.array(FixContextSource).min(1),
    observations: z.array(z.string().min(1).describe('observation grounded in the sources')).min(1),
    open_questions: z.array(
      z.string().min(1).describe('question still unresolved after gathering context'),
    ),
  })
  .strict();
export type FixContext = z.infer<typeof FixContext>;

export const FixReproductionStatus = z.enum([
  'reproduced',
  'not-reproduced',
  'intermittent',
  'not-attempted',
]);
export type FixReproductionStatus = z.infer<typeof FixReproductionStatus>;

export const FixDiagnosis = z
  .object({
    verdict: z.literal('accept'),
    reproduction_status: FixReproductionStatus,
    cause_summary: z.string().min(1).describe('one-line root-cause statement'),
    confidence: z.enum(['low', 'medium', 'high']),
    evidence: LenientNonEmptyStringArray,
    residual_uncertainty: z.array(
      z.string().min(1).describe('remaining unknown that could still affect the fix'),
    ),
    recommended_power: PowerRecommendation.optional().describe(
      'ONLY when the relay context states the power dial is auto: the tier the downstream work needs, judged from the code you read. Omit this key entirely otherwise',
    ),
    equipment_discovery: EquipmentDiscovery.optional().describe(
      'ONLY when the code you read confirms a technology the downstream steps should be equipped for (e.g. React): the engine re-equips the remaining work steps for it. Set confirmed:true ONLY on unambiguous evidence; omit this key entirely when nothing is confirmed',
    ),
  })
  .strict()
  .transform((diagnosis) => {
    if (
      diagnosis.reproduction_status === 'reproduced' ||
      diagnosis.residual_uncertainty.length > 0
    ) {
      return diagnosis;
    }
    return {
      ...diagnosis,
      residual_uncertainty: [
        'Diagnosis did not cleanly reproduce the bug before the runtime baseline proof.',
      ],
    };
  });
export type FixDiagnosis = z.infer<typeof FixDiagnosis>;

export const FixNoReproDecisionKind = z.enum([
  'add-diagnostics',
  'continue-with-small-fix',
  'stop-as-not-reproduced',
  'handoff',
  'escalate',
]);
export type FixNoReproDecisionKind = z.infer<typeof FixNoReproDecisionKind>;

export const FixNoReproRoute = z.enum(['continue', 'revise', 'stop', 'handoff', 'escalate']);
export type FixNoReproRoute = z.infer<typeof FixNoReproRoute>;

const NO_REPRO_DECISION_ROUTE = {
  'add-diagnostics': 'revise',
  'continue-with-small-fix': 'continue',
  'stop-as-not-reproduced': 'stop',
  handoff: 'handoff',
  escalate: 'escalate',
} as const satisfies Record<FixNoReproDecisionKind, FixNoReproRoute>;

export const FixNoReproDecision = z
  .object({
    decision: FixNoReproDecisionKind,
    selected_route: FixNoReproRoute,
    answered_by: z.enum(['operator', 'mode-default', 'host-default']),
    rationale: z.string().min(1),
  })
  .strict()
  .superRefine((decision, ctx) => {
    const expected = NO_REPRO_DECISION_ROUTE[decision.decision];
    if (decision.selected_route !== expected) {
      ctx.addIssue({
        code: 'custom',
        path: ['selected_route'],
        message: `selected_route must be '${expected}' for decision '${decision.decision}'`,
      });
    }
  });
export type FixNoReproDecision = z.infer<typeof FixNoReproDecision>;

export const FixChange = z
  .object({
    verdict: z.literal('accept'),
    summary: z.string().min(1).describe('what changed and why'),
    diagnosis_ref: z
      .string()
      .min(1)
      .describe('reference to the diagnosis report or section that motivates this change'),
    changed_files: z
      .array(z.string().min(1).describe('project-relative path that was edited'))
      .min(1),
    evidence: LenientNonEmptyStringArray,
  })
  .strict();
export type FixChange = z.infer<typeof FixChange>;

export const FixVerificationCommandResult = z
  .object({
    command_id: z.string().min(1),
    cwd: z.string().min(1),
    argv: z.array(z.string().min(1)).min(1),
    timeout_ms: z.number().int().positive(),
    max_output_bytes: z.number().int().positive(),
    env: z.record(z.string(), z.string()),
    exit_code: z.number().int().nonnegative(),
    status: z.enum(['passed', 'failed']),
    duration_ms: z.number().int().nonnegative(),
    stdout_summary: z.string(),
    stderr_summary: z.string(),
    // Whether this command was killed for hitting its verification budget
    // rather than exiting on its own. Defaults false so every report written
    // before this field existed still parses.
    timed_out: z.boolean().default(false),
  })
  .strict()
  .superRefine((result, ctx) => {
    const commandParse = FixVerificationCommand.safeParse({
      id: result.command_id,
      cwd: result.cwd,
      argv: result.argv,
      timeout_ms: result.timeout_ms,
      max_output_bytes: result.max_output_bytes,
      env: result.env,
    });
    if (!commandParse.success) {
      ctx.addIssue({
        code: 'custom',
        path: ['argv'],
        message: `verification command result must include a safe command spec: ${commandParse.error.issues
          .map((issue) => issue.message)
          .join('; ')}`,
      });
    }

    const expected = result.exit_code === 0 ? 'passed' : 'failed';
    if (result.status !== expected) {
      ctx.addIssue({
        code: 'custom',
        path: ['status'],
        message: `status must be '${expected}' when exit_code is ${result.exit_code}`,
      });
    }
  });
export type FixVerificationCommandResult = z.infer<typeof FixVerificationCommandResult>;

export const FixVerification = z
  .object({
    overall_status: z.enum(['passed', 'failed']),
    commands: z.array(FixVerificationCommandResult).min(1),
  })
  .strict()
  .superRefine((verification, ctx) => {
    const expected = verification.commands.some((command) => command.status === 'failed')
      ? 'failed'
      : 'passed';
    if (verification.overall_status !== expected) {
      ctx.addIssue({
        code: 'custom',
        path: ['overall_status'],
        message: `overall_status must be '${expected}' for command results`,
      });
    }
  });
export type FixVerification = z.infer<typeof FixVerification>;

// Runtime-owned regression proof. The brief's regression contract states the
// model's *intent* — what test should reproduce the bug. The runtime records
// what it observed when it executed that test before the fix was applied:
//   - 'proved'     — runtime ran the regression command and observed it fail
//                    (matching the brief's failing-before-fix expectation, so
//                    the test does reproduce the bug).
//   - 'deferred'   — brief did not specify a runnable regression test; no
//                    proof was collected. fix-close cannot mark outcome
//                    'fixed' on a deferred proof.
//   - 'not-proved' — runtime ran the regression command but it passed,
//                    contradicting the brief. The bug is not actually being
//                    reproduced by the named test, so any later "fix" is
//                    unfounded. Treated as a verification failure.
//
// `overall_status` exists so the verification executor can route on the
// outcome: 'passed' when status is 'proved' or 'deferred' (continue), 'failed'
// when status is 'not-proved' (recovery).
export const FixRegressionProofObservation = z
  .object({
    command_id: z.string().min(1),
    cwd: z.string().min(1),
    argv: z.array(z.string().min(1)).min(1),
    timeout_ms: z.number().int().positive(),
    max_output_bytes: z.number().int().positive(),
    env: z.record(z.string(), z.string()),
    exit_code: z.number().int().nonnegative(),
    command_status: z.enum(['passed', 'failed']),
    duration_ms: z.number().int().nonnegative(),
    stdout_summary: z.string(),
    stderr_summary: z.string(),
  })
  .strict()
  .superRefine((observation, ctx) => {
    const expected = observation.exit_code === 0 ? 'passed' : 'failed';
    if (observation.command_status !== expected) {
      ctx.addIssue({
        code: 'custom',
        path: ['command_status'],
        message: `command_status must be '${expected}' when exit_code is ${observation.exit_code}`,
      });
    }
  });
export type FixRegressionProofObservation = z.infer<typeof FixRegressionProofObservation>;

export const FixRegressionProofStatus = z.enum(['proved', 'deferred', 'not-proved']);
export type FixRegressionProofStatus = z.infer<typeof FixRegressionProofStatus>;

export const FixRegressionProof = z
  .object({
    status: FixRegressionProofStatus,
    overall_status: z.enum(['passed', 'failed']),
    reason: z.string().min(1).optional(),
    baseline: FixRegressionProofObservation.optional(),
  })
  .strict()
  .superRefine((proof, ctx) => {
    const expectedOverall = proof.status === 'not-proved' ? 'failed' : 'passed';
    if (proof.overall_status !== expectedOverall) {
      ctx.addIssue({
        code: 'custom',
        path: ['overall_status'],
        message: `overall_status must be '${expectedOverall}' when status is '${proof.status}'`,
      });
    }
    if (proof.status === 'deferred') {
      if (proof.baseline !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['baseline'],
          message: "baseline must be omitted when status is 'deferred'",
        });
      }
      if (proof.reason === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['reason'],
          message: "reason is required when status is 'deferred'",
        });
      }
    } else {
      if (proof.baseline === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['baseline'],
          message: `baseline is required when status is '${proof.status}'`,
        });
      }
      if (proof.status === 'proved' && proof.baseline?.command_status !== 'failed') {
        ctx.addIssue({
          code: 'custom',
          path: ['status'],
          message: "status 'proved' requires baseline command_status 'failed'",
        });
      }
      if (proof.status === 'not-proved' && proof.baseline?.command_status !== 'passed') {
        ctx.addIssue({
          code: 'custom',
          path: ['status'],
          message: "status 'not-proved' requires baseline command_status 'passed'",
        });
      }
    }
  });
export type FixRegressionProof = z.infer<typeof FixRegressionProof>;

// Per-path entry in a baseline-snapshot working tree.
//
// Captures both the status code (XY from `git status --porcelain=v1 -z`) and
// a content fingerprint so the change-set writer can detect when fix-act
// mutates a path that was already dirty at baseline. Without the fingerprint,
// a path that flips from "dirty (operator's edit)" to "dirty (operator's edit
// + fix-act's further edit)" looks identical in path-set terms and the fix
// can hide undeclared changes inside pre-existing dirt.
export const FixBaselineSnapshotEntry = RuntimeGitStateEntry;
export type FixBaselineSnapshotEntry = z.infer<typeof FixBaselineSnapshotEntry>;

// Paths flagged with `git update-index --assume-unchanged` or
// `--skip-worktree` are invisible to `git status`, so an adversary can hide
// tracked edits behind these flags. The change-set writer fails closed when
// hidden_index_flags is non-empty; the field is a list rather than a count
// so the failure message can name the offending paths.
export const FixHiddenIndexFlag = RuntimeHiddenIndexFlag;
export type FixHiddenIndexFlag = z.infer<typeof FixHiddenIndexFlag>;

// Runtime-owned pre-fix-act snapshot of git state. Captured before the
// implementer touches the working tree, the snapshot becomes the baseline for
// the post-verify change-set step. The change-set step compares entries it
// observes after the fix against this snapshot's entries:
//   - paths in the post snapshot but not in baseline = newly-dirty paths
//     (introduced by fix-act)
//   - paths in baseline whose post fingerprint differs = pre-existing dirt
//     that fix-act further mutated
// Both categories together form the set of paths fix-act actually touched,
// which the change-set then compares against `fix.change@v1` `changed_files`.
//
// overall_status is always 'passed' — the snapshot exists to record state,
// not to block routing. Failures abort via the runner's normal error path.
export const FixBaselineSnapshot = z
  .object({
    overall_status: z.literal('passed'),
    head_sha: z.string().min(1),
    // Per-path porcelain entries with content fingerprints. Empty array means
    // the working tree was clean.
    entries: z.array(FixBaselineSnapshotEntry),
    // Paths flagged with assume-unchanged or skip-worktree at baseline. The
    // change-set step refuses status='pass' when this list is non-empty
    // because such paths can be edited without `git status` noticing.
    hidden_index_flags: z.array(FixHiddenIndexFlag),
  })
  .strict();
export type FixBaselineSnapshot = z.infer<typeof FixBaselineSnapshot>;

// Runtime-owned change-set verdict. After fix-verify the runtime captures the
// post-fix git state and computes the actual file list touched by the fix:
//
//   observed = (paths newly-dirty post-fix)
//            ∪ (paths dirty at baseline whose fingerprint changed)
//
// It compares observed against the implementer's `fix.change@v1`
// `changed_files` declaration:
//   - 'pass'   — observed equals declared exactly, AND HEAD hasn't moved,
//                AND no hidden_index_flags are present. The implementer told
//                the truth about what they touched, the agent didn't commit
//                mid-run, and no path is hidden from git status.
//   - 'fail'   — at least one of:
//                  * an undeclared extra (touched but not declared)
//                  * a missing declared (declared but never modified)
//                  * HEAD moved between baseline and post-fix
//                  * a path is flagged assume-unchanged or skip-worktree
//                fix-close cannot mark outcome 'fixed' on a failed change-set.
//
// overall_status mirrors status for verification routing: 'passed' when status
// is 'pass', 'failed' when status is 'fail'.
export const FixChangeSet = z
  .object({
    status: z.enum(['pass', 'fail']),
    overall_status: z.enum(['passed', 'failed']),
    reason: z.string().min(1).optional(),
    baseline_head_sha: z.string().min(1),
    head_sha: z.string().min(1),
    declared: z.array(z.string().min(1)),
    observed: z.array(z.string().min(1)),
    undeclared_extras: z.array(z.string().min(1)),
    missing_declared: z.array(z.string().min(1)),
    // Subset of `observed` that came from baseline-dirty mutation rather than
    // newly-dirty paths. Carried for transparency: a path here means it was
    // already dirty at fix-act start and fix-act further mutated it. The
    // verdict logic doesn't branch on this — these paths must still appear in
    // declared (if any are missing, they show up as undeclared_extras and the
    // status flips to 'fail').
    baseline_dirty_mutated: z.array(z.string().min(1)),
    // Paths flagged assume-unchanged or skip-worktree, surfaced from the
    // post-fix snapshot. status 'pass' requires this to be empty.
    hidden_index_flags: z.array(FixHiddenIndexFlag),
  })
  .strict()
  .superRefine((changeSet, ctx) => {
    const expectedOverall = changeSet.status === 'pass' ? 'passed' : 'failed';
    if (changeSet.overall_status !== expectedOverall) {
      ctx.addIssue({
        code: 'custom',
        path: ['overall_status'],
        message: `overall_status must be '${expectedOverall}' when status is '${changeSet.status}'`,
      });
    }
    const observedSet = new Set(changeSet.observed);
    const declaredSet = new Set(changeSet.declared);
    const expectedExtras = changeSet.observed.filter((path) => !declaredSet.has(path));
    if (
      expectedExtras.length !== changeSet.undeclared_extras.length ||
      expectedExtras.some((p, i) => p !== changeSet.undeclared_extras[i])
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['undeclared_extras'],
        message: 'undeclared_extras must equal observed minus declared (in observed order)',
      });
    }
    const expectedMissing = changeSet.declared.filter((path) => !observedSet.has(path));
    if (
      expectedMissing.length !== changeSet.missing_declared.length ||
      expectedMissing.some((p, i) => p !== changeSet.missing_declared[i])
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['missing_declared'],
        message: 'missing_declared must equal declared minus observed (in declared order)',
      });
    }
    // baseline_dirty_mutated must be a subset of observed (every mutated
    // baseline path is, by definition, a path fix-act touched).
    for (const [index, path] of changeSet.baseline_dirty_mutated.entries()) {
      if (!observedSet.has(path)) {
        ctx.addIssue({
          code: 'custom',
          path: ['baseline_dirty_mutated', index],
          message: `baseline_dirty_mutated path '${path}' must also appear in observed`,
        });
      }
    }
    const headDiverged = changeSet.head_sha !== changeSet.baseline_head_sha;
    const hiddenFlagged = changeSet.hidden_index_flags.length > 0;
    const setsClean =
      changeSet.undeclared_extras.length === 0 && changeSet.missing_declared.length === 0;
    const isClean = setsClean && !headDiverged && !hiddenFlagged;
    if (changeSet.status === 'pass' && !isClean) {
      const violations: string[] = [];
      if (!setsClean) violations.push('non-empty undeclared_extras or missing_declared');
      if (headDiverged) violations.push('baseline_head_sha differs from head_sha');
      if (hiddenFlagged) violations.push('non-empty hidden_index_flags');
      ctx.addIssue({
        code: 'custom',
        path: ['status'],
        message: `status 'pass' requires no failure conditions, but: ${violations.join('; ')}`,
      });
    }
    if (changeSet.status === 'fail' && isClean) {
      ctx.addIssue({
        code: 'custom',
        path: ['status'],
        message:
          "status 'fail' requires at least one of: undeclared_extras, missing_declared, HEAD divergence, or hidden_index_flags",
      });
    }
    if (changeSet.status === 'fail' && changeSet.reason === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: "reason is required when status is 'fail'",
      });
    }
  });
export type FixChangeSet = z.infer<typeof FixChangeSet>;

// Runtime-owned post-fix rerun of the brief's regression command. The
// regression-baseline step ran the same command BEFORE fix-act and recorded
// 'proved' (failed as expected) or 'deferred' (no command in the brief).
// This step reruns the same command AFTER fix-verify and checks the result:
//   - 'cleared'      — baseline was 'proved' AND the rerun passed. The fix
//                      actually fixed the regression. Required for outcome
//                      'fixed'.
//   - 'still-failing' — baseline was 'proved' AND the rerun also failed.
//                      The fix did not fix the regression, even though the
//                      brief's verification candidates may have passed.
//                      fix-close cannot mark outcome 'fixed'.
//   - 'deferred'     — brief deferred the regression test, so there is
//                      nothing to rerun. (Mirrors the baseline 'deferred'
//                      status; outcome 'fixed' is still gated by
//                      regression_status='proved' separately.)
//
// overall_status routes the verification executor: 'passed' when status is
// 'cleared' or 'deferred' (continue), 'failed' when status is 'still-failing'
// (recover via the step's retry route, which routes back to fix-act).
export const FixRegressionRerunStatus = z.enum(['cleared', 'still-failing', 'deferred']);
export type FixRegressionRerunStatus = z.infer<typeof FixRegressionRerunStatus>;

export const FixRegressionRerun = z
  .object({
    status: FixRegressionRerunStatus,
    overall_status: z.enum(['passed', 'failed']),
    reason: z.string().min(1).optional(),
    rerun: FixRegressionProofObservation.optional(),
  })
  .strict()
  .superRefine((proof, ctx) => {
    const expectedOverall = proof.status === 'still-failing' ? 'failed' : 'passed';
    if (proof.overall_status !== expectedOverall) {
      ctx.addIssue({
        code: 'custom',
        path: ['overall_status'],
        message: `overall_status must be '${expectedOverall}' when status is '${proof.status}'`,
      });
    }
    if (proof.status === 'deferred') {
      if (proof.rerun !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['rerun'],
          message: "rerun must be omitted when status is 'deferred'",
        });
      }
      if (proof.reason === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['reason'],
          message: "reason is required when status is 'deferred'",
        });
      }
    } else {
      if (proof.rerun === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['rerun'],
          message: `rerun is required when status is '${proof.status}'`,
        });
      }
      if (proof.status === 'cleared' && proof.rerun?.command_status !== 'passed') {
        ctx.addIssue({
          code: 'custom',
          path: ['status'],
          message: "status 'cleared' requires rerun command_status 'passed'",
        });
      }
      if (proof.status === 'still-failing' && proof.rerun?.command_status !== 'failed') {
        ctx.addIssue({
          code: 'custom',
          path: ['status'],
          message: "status 'still-failing' requires rerun command_status 'failed'",
        });
      }
      if (proof.status === 'still-failing' && proof.reason === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['reason'],
          message: "reason is required when status is 'still-failing'",
        });
      }
    }
  });
export type FixRegressionRerun = z.infer<typeof FixRegressionRerun>;

export const FixReviewVerdict = z.enum(['accept', 'accept-with-fixes', 'reject']);
export type FixReviewVerdict = z.infer<typeof FixReviewVerdict>;

export const FixReviewFinding = z
  .object({
    severity: z.enum(['critical', 'high', 'medium', 'low']),
    text: z.string().min(1).describe('finding text'),
    file_refs: z.array(z.string().min(1).describe('file:line reference')),
  })
  .strict();
export type FixReviewFinding = z.infer<typeof FixReviewFinding>;

// Expressed as a discriminated union so the verdict-conditional minimum
// on `findings` becomes a structural JSON-Schema constraint rather than a
// superRefine (which JSON Schema conversion cannot express). With this shape,
// the CLI's `--json-schema` / `--output-schema` boundary rejects
// {verdict: 'reject'|'accept-with-fixes', findings: []} at the same boundary
// where Zod would reject it.
export const FixReview = z.discriminatedUnion('verdict', [
  z
    .object({
      verdict: z.literal('accept'),
      summary: z.string().min(1).describe('review summary'),
      findings: z.array(FixReviewFinding),
    })
    .strict(),
  z
    .object({
      verdict: z.literal('accept-with-fixes'),
      summary: z.string().min(1).describe('review summary'),
      findings: z.array(FixReviewFinding).min(1),
    })
    .strict(),
  z
    .object({
      verdict: z.literal('reject'),
      summary: z.string().min(1).describe('review summary'),
      findings: z.array(FixReviewFinding).min(1),
    })
    .strict(),
]);
export type FixReview = z.infer<typeof FixReview>;

export const FixResultOutcome = z.enum([
  'fixed',
  'not-reproduced',
  'partial',
  'stopped',
  'handoff',
  'failed',
]);
export type FixResultOutcome = z.infer<typeof FixResultOutcome>;

export const FixResultReportId = z.enum([
  'fix.brief',
  'fix.context',
  'fix.diagnosis',
  'fix.no-repro-decision',
  'fix.regression-proof',
  'fix.baseline-snapshot',
  'fix.change',
  'fix.verification',
  'fix.regression-rerun',
  'fix.change-set',
  'fix.review',
]);
export type FixResultReportId = z.infer<typeof FixResultReportId>;

export const FixResultReportPointer = resultReportPointer(
  FixResultReportId,
  FIX_RESULT_SCHEMA_BY_ARTIFACT_ID,
  FIX_RESULT_PATH_BY_ARTIFACT_ID,
);
export type FixResultReportPointer = z.infer<typeof FixResultReportPointer>;

export const FixReviewStatus = z.enum(['completed', 'skipped']);
export type FixReviewStatus = z.infer<typeof FixReviewStatus>;

export const FixResult = z
  .object({
    summary: z.string().min(1),
    outcome: FixResultOutcome,
    verification_status: z.enum(['passed', 'failed', 'not-run']),
    regression_status: z.enum(['proved', 'deferred', 'not-applicable']),
    regression_rerun_status: FixRegressionRerunStatus,
    change_set_status: z.enum(['pass', 'fail']),
    review_status: FixReviewStatus,
    review_verdict: FixReviewVerdict.optional(),
    review_skip_reason: z.string().min(1).optional(),
    residual_risks: z.array(z.string().min(1)),
    evidence_links: z
      .array(FixResultReportPointer)
      .min(REQUIRED_FIX_RESULT_ARTIFACT_IDS.length)
      .max(FixResultReportId.options.length),
  })
  .strict()
  .superRefine((result, ctx) => {
    const seen = new Set<FixResultReportId>();
    for (const [index, pointer] of result.evidence_links.entries()) {
      if (seen.has(pointer.report_id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['evidence_links', index, 'report_id'],
          message: `duplicate report_id '${pointer.report_id}'`,
        });
      }
      seen.add(pointer.report_id);
    }

    for (const reportId of REQUIRED_FIX_RESULT_ARTIFACT_IDS) {
      if (!seen.has(reportId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['evidence_links'],
          message: `missing report_id '${reportId}'`,
        });
      }
    }

    if (result.outcome === 'fixed' && result.verification_status !== 'passed') {
      ctx.addIssue({
        code: 'custom',
        path: ['verification_status'],
        message: "verification_status must be 'passed' when outcome is 'fixed'",
      });
    }

    if (result.outcome === 'fixed' && result.regression_status !== 'proved') {
      ctx.addIssue({
        code: 'custom',
        path: ['regression_status'],
        message: "regression_status must be 'proved' when outcome is 'fixed'",
      });
    }

    if (result.outcome === 'fixed' && result.regression_rerun_status !== 'cleared') {
      ctx.addIssue({
        code: 'custom',
        path: ['regression_rerun_status'],
        message: "regression_rerun_status must be 'cleared' when outcome is 'fixed'",
      });
    }

    if (result.regression_status === 'deferred' && result.regression_rerun_status !== 'deferred') {
      ctx.addIssue({
        code: 'custom',
        path: ['regression_rerun_status'],
        message: "regression_rerun_status must be 'deferred' when regression_status is 'deferred'",
      });
    }

    if (result.regression_status === 'proved' && result.regression_rerun_status === 'deferred') {
      ctx.addIssue({
        code: 'custom',
        path: ['regression_rerun_status'],
        message: "regression_rerun_status cannot be 'deferred' when regression_status is 'proved'",
      });
    }

    if (result.outcome === 'fixed' && result.change_set_status !== 'pass') {
      ctx.addIssue({
        code: 'custom',
        path: ['change_set_status'],
        message: "change_set_status must be 'pass' when outcome is 'fixed'",
      });
    }

    if (result.outcome === 'fixed' && result.review_verdict === 'reject') {
      ctx.addIssue({
        code: 'custom',
        path: ['review_verdict'],
        message: "review_verdict cannot be 'reject' when outcome is 'fixed'",
      });
    }

    if (
      result.outcome === 'fixed' &&
      result.review_status === 'completed' &&
      result.review_verdict !== 'accept'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['review_verdict'],
        message: "review_verdict must be 'accept' when outcome is 'fixed' and review completed",
      });
    }

    if (result.review_status === 'completed') {
      if (result.review_verdict === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['review_verdict'],
          message: "review_verdict is required when review_status is 'completed'",
        });
      }
      if (!seen.has('fix.review')) {
        ctx.addIssue({
          code: 'custom',
          path: ['evidence_links'],
          message: "review_status 'completed' must include the fix.review evidence link",
        });
      }
    }

    if (result.review_status === 'skipped') {
      if (result.review_skip_reason === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['review_skip_reason'],
          message: "review_skip_reason is required when review_status is 'skipped'",
        });
      }
      if (result.review_verdict !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['review_verdict'],
          message: "review_verdict must be omitted when review_status is 'skipped'",
        });
      }
    }

    if (result.outcome === 'not-reproduced' && !seen.has('fix.no-repro-decision')) {
      ctx.addIssue({
        code: 'custom',
        path: ['evidence_links'],
        message: "outcome 'not-reproduced' must include the fix.no-repro-decision evidence link",
      });
    }
  });
export type FixResult = z.infer<typeof FixResult>;
