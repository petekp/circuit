#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type * as CliCircuitModule from '../../src/cli/circuit.js';
import type * as CheckpointExecutorModule from '../../src/runtime/executors/checkpoint.js';
import type * as ComposeModule from '../../src/runtime/executors/compose.js';
import {
  type CapturedProof,
  type CapturedProofFile,
  capturedProofFreshnessFailures,
} from './captured-proof-freshness.ts';
import { compareProofRecency } from './proof-recency.ts';

type CliMain = (typeof CliCircuitModule)['main'];
type CliMainOptions = Parameters<CliMain>[1];
type Relayer = NonNullable<NonNullable<CliMainOptions>['relayer']>;
type RelayInput = Parameters<Relayer['relay']>[0];
type RelayOutcome = Awaited<ReturnType<Relayer['relay']>>;
type RuntimeExecutorsOption = NonNullable<NonNullable<CliMainOptions>['runtimeExecutors']>;
type StepExecutor = NonNullable<RuntimeExecutorsOption[keyof RuntimeExecutorsOption]>;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '../..');
const proofRunsRootRel = 'docs/release/proofs/runs';
const scrubbedProjectRoot = '<repo>';
const homeDir = process.env.HOME;

// Scenario fixture projects live at a deterministic path derived from the
// slug, so relayer stubs constructed at module load can write real file
// changes into the fixture the run is verified against.
function scenarioProjectPath(slug: string): string {
  return resolve(projectRoot, `${proofRunsRootRel}/.capture-${slug}/project`);
}

const composeRuntime = (await import(
  resolve(projectRoot, 'dist/runtime/executors/compose.js')
)) as typeof ComposeModule;
const { executeCompose } = composeRuntime;

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function deterministicNow(startMs: number): () => Date {
  let n = 0;
  return () => new Date(startMs + n++ * 1000);
}

type StreamName = 'stdout' | 'stderr';

function captureStream(streamName: StreamName): { text: () => string; restore: () => void } {
  const stream = process[streamName];
  const originalWrite = stream.write.bind(stream);
  let captured = '';
  stream.write = ((
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((err?: Error | null) => void),
    callback?: (err?: Error | null) => void,
  ): boolean => {
    captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    if (typeof encoding === 'function') encoding();
    if (typeof callback === 'function') callback();
    return true;
  }) as typeof stream.write;
  return {
    text: () => captured,
    restore: () => {
      stream.write = originalWrite;
    },
  };
}

async function runCli(
  argv: readonly string[],
  options: CliMainOptions,
): Promise<{ stdout: string; stderr: string }> {
  const stdout = captureStream('stdout');
  const stderr = captureStream('stderr');
  try {
    const cliModule = (await import(
      resolve(projectRoot, 'dist/cli/circuit.js')
    )) as typeof CliCircuitModule;
    const code = await cliModule.main(argv, options);
    // Exit 1 mirrors a run that closed aborted while still writing its full
    // result envelope to stdout (the 'abort' scenario captures exactly that
    // close). The harness reasons about run outcomes from the envelope — the
    // freshness check compares each fresh outcome against the committed
    // proof's — so only envelope-less failures (usage errors, crashes) are
    // harness errors.
    if (code !== 0 && code !== 1) throw new Error(`circuit CLI exited ${code}`);
    return { stdout: stdout.text(), stderr: stderr.text() };
  } finally {
    stdout.restore();
    stderr.restore();
  }
}

type PathAlias = { fromRel: string; toRel: string };

function scrubText(text: string, pathAliases: PathAlias[] = []): string {
  let scrubbed = text
    .replaceAll(projectRoot, scrubbedProjectRoot)
    .replaceAll(homeDir === undefined || homeDir.length === 0 ? '\0' : homeDir, '<home>')
    .replace(/\/private\/var\/folders\/[^\s"')]+/g, '<tmp>')
    .replace(/\/var\/folders\/[^\s"')]+/g, '<tmp>')
    .replace(/\/tmp\/[^\s"')]+/g, '<tmp>');
  for (const alias of pathAliases) {
    scrubbed = scrubbed.replaceAll(
      `${scrubbedProjectRoot}/${alias.fromRel}`,
      `${scrubbedProjectRoot}/${alias.toRel}`,
    );
    scrubbed = scrubbed.replaceAll(alias.fromRel, alias.toRel);
  }
  return scrubbed;
}

function writeScrubbed(relPath: string, content: string, pathAliases: PathAlias[] = []): void {
  const abs = resolve(projectRoot, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, scrubText(content, pathAliases));
}

function filesUnder(absDir: string): string[] {
  return readdirSync(absDir).flatMap((entry) => {
    const abs = join(absDir, entry);
    const stat = statSync(abs);
    if (stat.isDirectory()) return filesUnder(abs);
    return [abs];
  });
}

function scrubProofTree(proofDir: string, pathAliases: PathAlias[] = []): void {
  for (const abs of filesUnder(proofDir)) {
    const rel = relative(projectRoot, abs);
    if (!/\.(html|json|jsonl|md|ndjson|txt|yaml|yml)$/.test(rel)) continue;
    writeFileSync(abs, scrubText(readFileSync(abs, 'utf8'), pathAliases));
  }
}

function buildRelayer(fixtureRoot: string): Relayer {
  return {
    connectorName: 'claude-code',
    relay: async (input: RelayInput): Promise<RelayOutcome> => {
      if (input.prompt.includes('Step: analyze-step')) {
        return {
          request_payload: input.prompt,
          receipt_id: 'proof-build-analyze',
          result_body: JSON.stringify({
            verdict: 'accept',
            sources: [
              {
                kind: 'file',
                ref: 'src/example.ts',
                summary: 'Module the synthetic change targets.',
              },
            ],
            observations: ['The synthetic target module is small and self-contained.'],
            open_questions: [],
            anticipated_file_extensions: ['.ts'],
          }),
          duration_ms: 9,
          cli_version: 'proof-stub',
        };
      }
      if (input.prompt.includes('Step: act-step')) {
        // The changed-files-on-disk acceptance criterion verifies this claim
        // against the fixture's git working tree, so the stub must make the
        // claim true before reporting it.
        writeFileSync(join(fixtureRoot, 'src', 'example.ts'), 'export const answer = 43;\n');
        return {
          request_payload: input.prompt,
          receipt_id: 'proof-build-act',
          result_body: JSON.stringify({
            verdict: 'accept',
            summary: 'Implemented the requested synthetic change.',
            changed_files: ['src/example.ts'],
            evidence: ['Deterministic Build implementation proof.'],
          }),
          duration_ms: 10,
          cli_version: 'proof-stub',
        };
      }
      if (input.prompt.includes('Step: review-step')) {
        return {
          request_payload: input.prompt,
          receipt_id: 'proof-build-review',
          result_body: JSON.stringify({
            verdict: 'accept',
            summary: 'No blocking issue found in the synthetic Build proof.',
            findings: [],
            alignment: {
              scope_adherence: 'within_scope',
              non_goals: [],
              invariants: [],
            },
          }),
          duration_ms: 11,
          cli_version: 'proof-stub',
        };
      }
      throw new Error(`unexpected Build proof relay prompt:\n${input.prompt.slice(0, 500)}`);
    },
  };
}

function buildAbortRelayer(fixtureRoot: string): Relayer {
  return {
    connectorName: 'claude-code',
    relay: async (input: RelayInput): Promise<RelayOutcome> => {
      if (input.prompt.includes('Step: act-step')) {
        throw new Error('proof connector failure while implementing the synthetic Build change');
      }
      return buildRelayer(fixtureRoot).relay(input);
    },
  };
}

const buildProofCheckpointExecutor: StepExecutor = async (step, context) => {
  if (step.kind !== 'checkpoint' || step.id !== 'frame-step') {
    const checkpointRuntime = (await import(
      resolve(projectRoot, 'dist/runtime/executors/checkpoint.js')
    )) as { executeCheckpoint: StepExecutor };
    return await checkpointRuntime.executeCheckpoint(step, context);
  }
  const report = step.writes?.report;
  const request = step.writes?.request;
  const response = step.writes?.response;
  if (report?.schema !== 'build.brief@v1' || request === undefined || response === undefined) {
    throw new Error(
      "Build proof checkpoint executor expected frame-step to write 'build.brief@v1'",
    );
  }

  const attempt = context.activeStepAttempt ?? 1;
  const brief = {
    objective: context.goal,
    scope: 'Make the smallest safe change that satisfies the requested goal.',
    success_criteria: [
      'The requested behavior is implemented',
      'Verification passes',
      'Review completes without a blocking issue',
    ],
    verification_command_candidates: [
      {
        id: 'npm-check',
        cwd: '.',
        argv: ['npm', 'run', 'check'],
        timeout_ms: 120_000,
        max_output_bytes: 200_000,
        env: {},
      },
    ],
    checkpoint: {
      request_path: request.path,
      response_path: response.path,
      allowed_choices: step.choices,
    },
  };

  await context.files.writeJson(report, brief);
  const reportHash = sha256Hex(await context.files.readText(report));
  await context.trace.append({
    run_id: context.runId,
    kind: 'step.report_written',
    step_id: step.id,
    attempt,
    report_path: report.path,
    report_schema: report.schema,
  });

  const stepPolicy = step.policy as {
    readonly prompt: string;
    readonly safe_default_choice?: string;
    readonly safe_autonomous_choice?: string;
    readonly choices: readonly { readonly id: string; readonly label?: string }[];
  };
  const effectiveDepth =
    context.depth ??
    (context.axes?.autonomous === true
      ? 'autonomous'
      : context.axes?.tournament === true
        ? 'tournament'
        : (context.axes?.depth ?? 'medium'));
  const waitsForOperator = effectiveDepth === 'high' || effectiveDepth === 'tournament';
  const autoSelection =
    effectiveDepth === 'autonomous'
      ? stepPolicy.safe_autonomous_choice
      : stepPolicy.safe_default_choice;
  // Project the checkpoint authority boundary the same way the real executor
  // does. The proof hand-rolls the frame-step checkpoint, but the
  // checkpoint.requested trace entry and the request execution_context both
  // require boundary_ref/boundary_hash, and resume re-projects the boundary
  // from the saved flow and rejects a mismatch. Reusing the runtime projector
  // keeps the proof byte-faithful to a real run instead of drifting.
  const checkpointExecutor = (await import(
    resolve(projectRoot, 'dist/runtime/executors/checkpoint.js')
  )) as typeof CheckpointExecutorModule;
  const boundary = await checkpointExecutor.projectRuntimeCheckpointBoundaryForStep(
    step as Parameters<typeof checkpointExecutor.projectRuntimeCheckpointBoundaryForStep>[0],
    context as Parameters<typeof checkpointExecutor.projectRuntimeCheckpointBoundaryForStep>[1],
  );
  const requestBody = {
    schema_version: 1,
    step_id: step.id,
    prompt: stepPolicy.prompt,
    allowed_choices: stepPolicy.choices.map((choice) => choice.id),
    ...(stepPolicy.safe_default_choice === undefined
      ? {}
      : { safe_default_choice: stepPolicy.safe_default_choice }),
    ...(stepPolicy.safe_autonomous_choice === undefined
      ? {}
      : { safe_autonomous_choice: stepPolicy.safe_autonomous_choice }),
    execution_context: {
      // Mirror the real checkpointRequestBody field set and order so the proof
      // request is byte-faithful to a live run: a real run always carries axes
      // and work_contract_ref, and resume cross-validates work_contract_ref
      // when present.
      ...(context.axes === undefined ? {} : { axes: context.axes }),
      ...(context.projectRoot === undefined ? {} : { project_root: context.projectRoot }),
      ...(context.workContractRef === undefined
        ? {}
        : { work_contract_ref: context.workContractRef }),
      checkpoint_boundary_ref: boundary.request_trace.boundary_ref,
      checkpoint_boundary_hash: boundary.request_trace.boundary_hash,
      selection_config_layers: context.selectionConfigLayers ?? [],
      policy_layers: context.policyLayers ?? [],
      checkpoint_report_sha256: reportHash,
    },
  };
  await context.files.writeJson(request, requestBody);
  const requestHash = sha256Hex(await context.files.readText(request));
  await context.trace.append({
    run_id: context.runId,
    kind: 'checkpoint.requested',
    step_id: step.id,
    attempt,
    request_path: request.path,
    request_report_hash: requestHash,
    boundary_ref: boundary.request_trace.boundary_ref,
    boundary_hash: boundary.request_trace.boundary_hash,
    options: step.choices,
    // checkpoint.requested only carries auto_resolved when it is false (the
    // request is waiting for an operator); the auto-resolve path omits it and
    // records the resolution on checkpoint.resolved instead.
    ...(waitsForOperator ? { auto_resolved: false } : {}),
  });

  if (waitsForOperator) {
    return {
      kind: 'waiting_checkpoint',
      checkpoint: {
        stepId: step.id,
        attempt,
        requestPath: context.files.resolve(request),
        allowedChoices: step.choices,
      },
    };
  }
  if (autoSelection === undefined) {
    throw new Error(`Build proof checkpoint executor cannot resolve ${effectiveDepth} depth`);
  }
  const routeId = Object.hasOwn(step.routes, autoSelection) ? autoSelection : 'pass';
  await context.files.writeJson(response, {
    schema_version: 1,
    step_id: step.id,
    selection: autoSelection,
    route_id: routeId,
    resolution_source: 'declared-default',
  });
  await context.trace.append({
    run_id: context.runId,
    kind: 'checkpoint.resolved',
    step_id: step.id,
    attempt,
    selection: autoSelection,
    route_id: routeId,
    auto_resolved: true,
    resolution_source: 'declared-default',
    response_path: response.path,
  });
  await context.trace.append({
    run_id: context.runId,
    kind: 'check.evaluated',
    step_id: step.id,
    attempt,
    check_kind: 'checkpoint_selection',
    outcome: 'pass',
  });
  return {
    route: routeId,
    details: { selection: autoSelection },
  };
};

function buildProofExecutors(): RuntimeExecutorsOption {
  return { checkpoint: buildProofCheckpointExecutor };
}

function reviewRelayer(): Relayer {
  return {
    connectorName: 'claude-code',
    relay: async (input: RelayInput): Promise<RelayOutcome> => ({
      request_payload: input.prompt,
      receipt_id: 'proof-review',
      result_body: JSON.stringify({
        verdict: 'NO_ISSUES_FOUND',
        findings: [],
        assessment:
          'Reviewer inspected the relayed staged-diff and untracked-file evidence and found nothing actionable in scope.',
        verification: [
          'Inspected the relayed review-intake report.',
          'Cross-checked the staged diff against the untracked-file metadata.',
        ],
        confidence_limitations: [
          'Untracked file contents were omitted from the relay (metadata-only policy).',
          'Untracked file evidence was capped at 20 files.',
        ],
      }),
      duration_ms: 10,
      cli_version: 'proof-stub',
    }),
  };
}

function fixRelayer(fixtureRoot: string): Relayer {
  return {
    connectorName: 'claude-code',
    relay: async (input: RelayInput): Promise<RelayOutcome> => {
      if (input.prompt.includes('Step: fix-gather-context')) {
        return {
          request_payload: input.prompt,
          receipt_id: 'proof-fix-context',
          result_body: JSON.stringify({
            verdict: 'accept',
            sources: [
              { kind: 'file', ref: 'src/login.ts:1', summary: 'Synthetic login test fixture.' },
            ],
            observations: ['The missing token path needs a guard.'],
            open_questions: [],
          }),
          duration_ms: 10,
          cli_version: 'proof-stub',
        };
      }
      if (input.prompt.includes('Step: fix-diagnose')) {
        return {
          request_payload: input.prompt,
          receipt_id: 'proof-fix-diagnose',
          result_body: JSON.stringify({
            verdict: 'accept',
            reproduction_status: 'reproduced',
            cause_summary: 'The missing token path skipped the fallback guard.',
            confidence: 'high',
            evidence: ['Synthetic regression evidence.'],
            residual_uncertainty: [],
          }),
          duration_ms: 11,
          cli_version: 'proof-stub',
        };
      }
      if (input.prompt.includes('Step: fix-act')) {
        // Same contract as the Build act stub: the changed-files-on-disk
        // acceptance criterion checks the fixture's working tree, so write
        // the claimed guard before claiming it.
        writeFileSync(
          join(fixtureRoot, 'src', 'login.ts'),
          [
            'export function login(token?: string): string {',
            "  if (token === undefined) return 'guest';",
            '  return token;',
            '}',
            '',
          ].join('\n'),
        );
        return {
          request_payload: input.prompt,
          receipt_id: 'proof-fix-act',
          result_body: JSON.stringify({
            verdict: 'accept',
            summary: 'Added the fallback guard for the synthetic missing token path.',
            diagnosis_ref: 'fix.diagnosis@v1',
            changed_files: ['src/login.ts'],
            evidence: ['Synthetic regression proof remained green.'],
          }),
          duration_ms: 12,
          cli_version: 'proof-stub',
        };
      }
      throw new Error(`unexpected Fix proof relay prompt:\n${input.prompt.slice(0, 500)}`);
    },
  };
}

function pursueRelayer(fixtureRoot: string): Relayer {
  return {
    connectorName: 'claude-code',
    relay: async (input: RelayInput): Promise<RelayOutcome> => {
      if (input.prompt.includes('Step: batch-step')) {
        // Pursue's batch step carries no changed-files acceptance criterion
        // today, but the stub still writes the claimed changes into the
        // fixture so every claim in the batch report is true and the live
        // verify step runs against a genuinely mutated tree. The pursuit ids
        // must match the contract writer's projection of the two-part goal
        // (semicolon split -> pursuit-1, pursuit-2). Keep the batch report
        // limited to what the batch itself did: the fixture check runs once,
        // later, at the live verify step.
        writeFileSync(join(fixtureRoot, 'src', 'example.ts'), 'export const answer = 43;\n');
        writeFileSync(join(fixtureRoot, 'notes.md'), 'The fallback answer guard returns 43.\n');
        return {
          request_payload: input.prompt,
          receipt_id: 'proof-pursue-batch',
          result_body: JSON.stringify({
            verdict: 'accept',
            summary: 'Executed both pursuits serially and wrote both claimed changes.',
            serialized_execution: true,
            completed: [
              {
                pursuit_id: 'pursuit-1',
                status: 'completed',
                summary: 'Added the fallback answer guard in src/example.ts.',
                evidence: ['src/example.ts changed in the fixture working tree.'],
              },
              {
                pursuit_id: 'pursuit-2',
                status: 'completed',
                summary: 'Documented the guard in notes.md.',
                evidence: ['notes.md added in the fixture working tree.'],
              },
            ],
            skipped: [],
            blocked: [],
            failed: [],
            actual_touch_set: {
              paths: ['src/example.ts', 'notes.md'],
              symbols: ['answer'],
              commands: ['npm run check'],
              generated_outputs: [],
            },
            proof_evidence: [
              'src/example.ts and notes.md carry the claimed changes in the fixture working tree.',
            ],
          }),
          duration_ms: 12,
          cli_version: 'proof-stub',
        };
      }
      if (input.prompt.includes('Step: review-step')) {
        return {
          request_payload: input.prompt,
          receipt_id: 'proof-pursue-review',
          result_body: JSON.stringify({
            verdict: 'clean',
            summary: 'Both pursuits landed without cross-pursuit interference.',
            reviewed_pursuits: [
              {
                pursuit_id: 'pursuit-1',
                assessment:
                  'src/example.ts carries the fallback answer guard the pursuit contracted, and the batch evidence matches the fixture working tree.',
              },
              {
                pursuit_id: 'pursuit-2',
                assessment:
                  'notes.md documents the guard as contracted; no cross-pursuit interference with pursuit-1.',
              },
            ],
            findings: [],
          }),
          duration_ms: 11,
          cli_version: 'proof-stub',
        };
      }
      throw new Error(`unexpected Pursue proof relay prompt:\n${input.prompt.slice(0, 500)}`);
    },
  };
}

const fixProofComposeExecutor: StepExecutor = async (step, context) => {
  if (step.kind !== 'compose' || step.id !== 'fix-frame') {
    return await executeCompose(step as Parameters<typeof executeCompose>[0], context);
  }
  const report = step.writes?.report;
  if (report?.schema === undefined) {
    throw new Error("Fix proof compose executor expected 'fix-frame' to write a report");
  }
  const goal = context.goal;
  const brief = {
    problem_statement: goal,
    expected_behavior: `After fix: ${goal}`,
    observed_behavior: `Before fix: ${goal}`,
    scope: 'Synthetic Fix proof fixture.',
    regression_contract: {
      expected_behavior: `After fix: ${goal}`,
      actual_behavior: `Before fix: ${goal}`,
      repro: {
        kind: 'not-reproducible',
        deferred_reason: 'Synthetic proof fixture; no live bug reproduction is required.',
      },
      regression_test: {
        status: 'deferred',
        deferred_reason: 'Synthetic proof fixture uses a deterministic verification command.',
      },
    },
    success_criteria: ['Deterministic Fix proof verification exits 0.'],
    verification_command_candidates: [
      {
        id: 'proof-fix-verify',
        cwd: '.',
        argv: ['node', '-e', 'process.exit(0)'],
        timeout_ms: 30_000,
        max_output_bytes: 200_000,
        env: {},
      },
    ],
  };
  await context.files.writeJson(report, brief);
  await context.trace.append({
    run_id: context.runId,
    kind: 'step.report_written',
    step_id: step.id,
    attempt: context.activeStepAttempt ?? 1,
    report_path: report.path,
    report_schema: report.schema,
  });
  return { route: 'pass', details: { writer: step.writer, proof: 'release-fix-brief' } };
};

// Stub the runtime-owned verification steps that shell out to git
// (fix-baseline-snapshot and fix-change-set). The synthetic Fix proof never
// actually modifies files, so the live executors would observe an empty file
// list and the change-set writer would refuse the run with "missing declared:
// src/login.ts". This stub writes passing reports for both steps so the
// proof closes with outcome 'partial' (still routed by the deferred
// regression test) — exactly as it did before Slice 2 added these checks.
const fixProofVerificationExecutor: StepExecutor = async (step, context) => {
  if (step.kind !== 'verification') {
    throw new Error(
      `fix proof verification executor: expected verification step, got ${step.kind}`,
    );
  }
  const report = step.writes?.report;
  if (report?.schema === undefined) {
    throw new Error(`fix proof verification executor: step '${step.id}' missing writes.report`);
  }
  const attempt = context.activeStepAttempt ?? 1;
  const reportSchema = report.schema;
  if (reportSchema === undefined) {
    throw new Error(`fix proof verification executor: step '${step.id}' report missing schema`);
  }
  const writePassing = async (body: unknown): Promise<void> => {
    await context.files.writeJson(report, body);
    await context.trace.append({
      run_id: context.runId,
      kind: 'step.report_written',
      step_id: step.id,
      attempt,
      report_path: report.path,
      report_schema: reportSchema,
    });
  };
  if (step.id === 'fix-baseline-snapshot') {
    await writePassing({
      overall_status: 'passed',
      head_sha: '0000000000000000000000000000000000000000',
      entries: [],
      hidden_index_flags: [],
    });
    return { route: 'pass', details: { writer: 'fix-proof', proof: 'baseline-snapshot' } };
  }
  if (step.id === 'fix-change-set') {
    await writePassing({
      status: 'pass',
      overall_status: 'passed',
      baseline_head_sha: '0000000000000000000000000000000000000000',
      head_sha: '0000000000000000000000000000000000000000',
      declared: ['src/login.ts'],
      observed: ['src/login.ts'],
      undeclared_extras: [],
      missing_declared: [],
      baseline_dirty_mutated: [],
      hidden_index_flags: [],
    });
    return { route: 'pass', details: { writer: 'fix-proof', proof: 'change-set' } };
  }
  // Other verification steps (fix-regression-baseline, fix-verify,
  // fix-regression-rerun) keep the live executor — they already work against
  // the deterministic node command candidates baked into the synthetic brief
  // (the regression test is deferred, so both regression-baseline and
  // regression-rerun emit 'deferred' without spawning anything).
  const verificationRuntime = (await import(
    resolve(projectRoot, 'dist/runtime/executors/verification.js')
  )) as { executeVerification: StepExecutor };
  return await verificationRuntime.executeVerification(step, context);
};

function fixProofExecutors(): RuntimeExecutorsOption {
  return {
    compose: fixProofComposeExecutor,
    verification: fixProofVerificationExecutor,
  };
}

const PASSING_RUBRIC_MODEL_JUDGMENTS = {
  evidence_rigor: 'pass',
  actionability: 'pass',
  coverage_adequacy: 'pass',
  scope_discipline: 'pass',
  honest_calibration: 'pass',
  project_specificity: 'pass',
  insight_density: 'pass',
  branch_distinctness: 'pass',
} as const;

function exploreDecisionRelayer(): Relayer {
  return {
    connectorName: 'claude-code',
    relay: async (input: RelayInput): Promise<RelayOutcome> => {
      if (input.prompt.includes('Step: proposal-fanout-step-option-1')) {
        return {
          request_payload: input.prompt,
          receipt_id: 'proof-proposal-option-1',
          result_body: JSON.stringify({
            verdict: 'accept',
            option_id: 'option-1',
            option_label: 'React',
            case_summary: 'Choose React for the broad ecosystem and hiring pool.',
            assumptions: ['The operator values ecosystem maturity.'],
            evidence_refs: ['reports/decision-options.json'],
            risks: ['The larger ecosystem may add dependency sprawl.'],
            next_action: 'Run a Build plan for a React prototype.',
            rubric_model_judgments: PASSING_RUBRIC_MODEL_JUDGMENTS,
          }),
          duration_ms: 10,
          cli_version: 'proof-stub',
        };
      }
      if (input.prompt.includes('Step: proposal-fanout-step-option-2')) {
        return {
          request_payload: input.prompt,
          receipt_id: 'proof-proposal-option-2',
          result_body: JSON.stringify({
            verdict: 'accept',
            option_id: 'option-2',
            option_label: 'Vue',
            case_summary: 'Choose Vue for a smaller surface and faster product iteration.',
            assumptions: ['The operator values implementation speed.'],
            evidence_refs: ['reports/decision-options.json'],
            risks: ['Team familiarity may be thinner.'],
            next_action: 'Run a Build plan for a Vue prototype.',
            rubric_model_judgments: PASSING_RUBRIC_MODEL_JUDGMENTS,
          }),
          duration_ms: 11,
          cli_version: 'proof-stub',
        };
      }
      if (input.prompt.includes('Step: proposal-fanout-step-option-3')) {
        return {
          request_payload: input.prompt,
          receipt_id: 'proof-proposal-option-3',
          result_body: JSON.stringify({
            verdict: 'accept',
            option_id: 'option-3',
            option_label: 'Hybrid path',
            case_summary: 'Prototype the shared requirements before locking the framework.',
            assumptions: ['A brief comparison prototype is affordable.'],
            evidence_refs: ['reports/decision-options.json'],
            risks: ['The decision takes longer.'],
            next_action: 'Run a short Explore follow-up with prototype criteria.',
            rubric_model_judgments: PASSING_RUBRIC_MODEL_JUDGMENTS,
          }),
          duration_ms: 12,
          cli_version: 'proof-stub',
        };
      }
      if (input.prompt.includes('Step: proposal-fanout-step-option-4')) {
        return {
          request_payload: input.prompt,
          receipt_id: 'proof-proposal-option-4',
          result_body: JSON.stringify({
            verdict: 'accept',
            option_id: 'option-4',
            option_label: 'Defer pending evidence',
            case_summary: 'Gather missing team and product constraints before choosing.',
            assumptions: ['The decision is reversible enough to pause briefly.'],
            evidence_refs: ['reports/decision-options.json'],
            risks: ['The project loses momentum.'],
            next_action: 'Collect the missing constraints and rerun the decision.',
            rubric_model_judgments: PASSING_RUBRIC_MODEL_JUDGMENTS,
          }),
          duration_ms: 13,
          cli_version: 'proof-stub',
        };
      }
      if (input.prompt.includes('Step: stress-proposals-step')) {
        return {
          request_payload: input.prompt,
          receipt_id: 'proof-tournament-review',
          result_body: JSON.stringify({
            verdict: 'recommend',
            recommended_option_id: 'option-1',
            comparison: 'React is safer on ecosystem depth, while Vue is faster to shape.',
            objections: ['Vue depends more on team-specific familiarity.'],
            missing_evidence: ['No implementation spike was gathered.'],
            tradeoff_question: 'Choose React ecosystem depth or Vue iteration speed.',
            confidence: 'medium',
          }),
          duration_ms: 14,
          cli_version: 'proof-stub',
        };
      }
      throw new Error(`unexpected Explore proof relay prompt:\n${input.prompt.slice(0, 500)}`);
    },
  };
}

function exploreAutonomousDecisionRelayer(): Relayer {
  const base = exploreDecisionRelayer();
  return {
    connectorName: base.connectorName,
    relay: async (input: RelayInput): Promise<RelayOutcome> => {
      const result = await base.relay(input);
      const resultBody = JSON.parse(result.result_body) as Record<string, unknown>;
      if (resultBody.option_id !== 'option-1') return result;
      return {
        ...result,
        receipt_id: 'proof-autonomous-proposal-option-1',
        result_body: JSON.stringify({
          ...resultBody,
          evidence_refs: [],
        }),
      };
    },
  };
}

// Standard (non-tournament) Explore path: analyze routes to synthesize (not the
// decision tournament), synthesize's compose is reviewed once, and an accepting
// review routes straight to close. Two relay steps: synthesize (implementer,
// explore.compose@v1) and review (reviewer, explore.review-verdict@v1). An
// 'accept' review with no objections or missed angles means the default result
// needs no fold-ins.
function exploreStandardRelayer(): Relayer {
  return {
    connectorName: 'claude-code',
    relay: async (input: RelayInput): Promise<RelayOutcome> => {
      if (input.prompt.includes('Step: synthesize-step')) {
        return {
          request_payload: input.prompt,
          receipt_id: 'proof-explore-synthesize',
          result_body: JSON.stringify({
            verdict: 'accept',
            subject: 'Frontend framework for the new analytics dashboard',
            recommendation:
              'Adopt React for the analytics dashboard; its ecosystem depth and the team’s existing familiarity outweigh Vue’s smaller surface for this work.',
            success_condition_alignment:
              'A framework the team can staff and extend maps directly to the brief’s success condition of shipping and maintaining the dashboard.',
            supporting_aspects: [
              {
                aspect: 'Ecosystem and hiring',
                contribution:
                  'React has the deeper component ecosystem and the larger hiring pool, which lowers staffing and integration risk.',
                evidence_refs: ['reports/analysis.json'],
              },
              {
                aspect: 'Team familiarity',
                contribution:
                  'The team already ships React elsewhere, so onboarding cost for this dashboard is close to zero.',
                evidence_refs: ['reports/analysis.json'],
              },
            ],
          }),
          duration_ms: 10,
          cli_version: 'proof-stub',
        };
      }
      if (input.prompt.includes('Step: review-step')) {
        return {
          request_payload: input.prompt,
          receipt_id: 'proof-explore-review',
          result_body: JSON.stringify({
            verdict: 'accept',
            overall_assessment:
              'The recommendation follows from the analysis and states its tradeoffs honestly; no blocking objections.',
            objections: [],
            missed_angles: [],
          }),
          duration_ms: 11,
          cli_version: 'proof-stub',
        };
      }
      throw new Error(
        `unexpected standard Explore proof relay prompt:\n${input.prompt.slice(0, 500)}`,
      );
    },
  };
}

function readPromptJson(prompt: string, relPath: string): Record<string, unknown> {
  const marker = `<read path="${relPath}">`;
  const start = prompt.indexOf(marker);
  if (start < 0) throw new Error(`prompt did not include ${relPath}`);
  const jsonStart = start + marker.length;
  const jsonEnd = prompt.indexOf('</read>', jsonStart);
  if (jsonEnd < 0) throw new Error(`prompt read fence for ${relPath} is unterminated`);
  return JSON.parse(prompt.slice(jsonStart, jsonEnd).trim()) as Record<string, unknown>;
}

function writeProofProjectFile(relPath: string, body: string): void {
  const abs = resolve(projectRoot, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}

function prototypeRelayer(): Relayer {
  return {
    connectorName: 'claude-code',
    relay: async (input: RelayInput): Promise<RelayOutcome> => {
      if (!input.prompt.includes('Step: act-step')) {
        throw new Error(`unexpected Prototype proof relay prompt:\n${input.prompt.slice(0, 500)}`);
      }
      const plan = readPromptJson(input.prompt, 'reports/prototype/plan.json');
      const prototypeRoot = String(plan.prototype_root);
      const entryPoints = Array.isArray(plan.entry_points)
        ? plan.entry_points.map((value) => String(value))
        : [`${prototypeRoot}/index.html`];
      const createdFiles = Array.isArray(plan.files_to_create)
        ? plan.files_to_create.map((value) => String(value))
        : [`${prototypeRoot}/index.html`, `${prototypeRoot}/README.md`];
      writeProofProjectFile(
        createdFiles[0] ?? `${prototypeRoot}/index.html`,
        [
          '<!doctype html>',
          '<html lang="en">',
          '<head><meta charset="utf-8"><title>Circuit Prototype</title></head>',
          '<body><main><h1>Custom Circuit Flow Builder</h1><p>Inspect core flows and compose a new flow from existing blocks.</p></main></body>',
          '</html>',
        ].join('\n'),
      );
      writeProofProjectFile(
        createdFiles[1] ?? `${prototypeRoot}/README.md`,
        [
          '# Custom Circuit Flow Builder Prototype',
          '',
          'Disposable local prototype evidence for creating custom Circuit flows from existing blocks and inspecting pre-packaged flows.',
        ].join('\n'),
      );
      return {
        request_payload: input.prompt,
        receipt_id: 'proof-prototype-act',
        result_body: JSON.stringify({
          verdict: 'accept',
          summary:
            'Created a local prototype artifact for building custom Circuit flows from existing blocks and inspecting pre-packaged flows.',
          prototype_root: prototypeRoot,
          created_files: createdFiles,
          entry_points: entryPoints,
          preview_instructions: `Open ${entryPoints[0] ?? `${prototypeRoot}/index.html`} locally.`,
          known_limitations: [
            'Prototype is not wired to live Circuit flow-saving behavior.',
            'Core-flow inspection uses static fixture content.',
          ],
          evidence: ['Prototype files were created under prototype_root.'],
          claim_limits: ['not production', 'not deployed'],
        }),
        duration_ms: 10,
        cli_version: 'proof-stub',
      };
    },
  };
}

type Scenario = {
  slug: string;
  argv: readonly string[];
  relayer: Relayer;
  runId: string;
  startMs: number;
  resumeChoice?: string;
  prepareProject?: (projectRoot: string) => void;
  runtimeExecutors?: RuntimeExecutorsOption;
};

function runProofGit(cwd: string, args: readonly string[], env?: Record<string, string>): void {
  const result = spawnSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
  });
  if (result.status !== 0) {
    throw new Error(
      `proof git ${args.join(' ')} failed: ${result.stderr || result.stdout || 'no output'}`,
    );
  }
}

// Commit with pinned identity and dates so fixture commit SHAs are
// deterministic across captures.
function commitProofFixture(root: string, message: string): void {
  runProofGit(root, ['add', '.']);
  runProofGit(
    root,
    [
      '-c',
      'user.name=Circuit Proof',
      '-c',
      'user.email=circuit-proof@example.test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      message,
    ],
    {
      GIT_AUTHOR_DATE: '2026-04-29T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-04-29T00:00:00Z',
    },
  );
}

function prepareReviewProofProject(root: string): void {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"name":"review-proof-fixture","private":true}\n');
  writeFileSync(join(root, 'src', 'example.ts'), 'export const answer = 42;\n');
  runProofGit(root, ['init']);
  commitProofFixture(root, 'initial review proof fixture');
  writeFileSync(join(root, 'src', 'example.ts'), 'export const answer = 43;\n');
  writeFileSync(join(root, 'notes.md'), 'Untracked review note.\n');
  runProofGit(root, ['add', 'src/example.ts']);
}

// Build proofs run against a real git fixture so the engine's
// changed-files-on-disk acceptance criterion (and the touch-area writer)
// observe a genuine working-tree change instead of an unverifiable claim.
// The npm check script keeps the brief's npm-check verification candidate
// runnable and deterministic inside the fixture.
function prepareBuildProofProject(root: string, options?: { includePlanSpec?: boolean }): void {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify(
      {
        name: 'build-proof-fixture',
        version: '0.0.0',
        private: true,
        scripts: { check: 'node -e "process.exit(0)"' },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(root, 'src', 'example.ts'), 'export const answer = 42;\n');
  if (options?.includePlanSpec === true) {
    mkdirSync(join(root, 'docs', 'specs'), { recursive: true });
    writeFileSync(
      join(root, 'docs', 'specs', 'headless-engine-host-api-v1.md'),
      [
        '# Headless engine host API v1',
        '',
        'Synthetic plan fixture for the plan-execution proof.',
        'Make the smallest safe change to src/example.ts.',
        '',
      ].join('\n'),
    );
  }
  runProofGit(root, ['init']);
  commitProofFixture(root, 'initial build proof fixture');
}

// Pursue proofs use the same shape as the build fixture: a git repo whose
// only general verification script is `check`, so the pursuit contract
// writer resolves a deterministic `npm run check` candidate in-fixture.
function preparePursueProofProject(root: string): void {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify(
      {
        name: 'pursue-proof-fixture',
        version: '0.0.0',
        private: true,
        scripts: { check: 'node -e "process.exit(0)"' },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(root, 'src', 'example.ts'), 'export const answer = 42;\n');
  runProofGit(root, ['init']);
  commitProofFixture(root, 'initial pursue proof fixture');
}

function prepareFixProofProject(root: string): void {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"name":"fix-proof-fixture","private":true}\n');
  writeFileSync(
    join(root, 'src', 'login.ts'),
    ['export function login(token?: string): string {', '  return token as string;', '}', ''].join(
      '\n',
    ),
  );
  runProofGit(root, ['init']);
  commitProofFixture(root, 'initial fix proof fixture');
}

async function captureCliScenario(scenario: Scenario): Promise<void> {
  const proofDirRel = `${proofRunsRootRel}/${scenario.slug}`;
  const proofDir = resolve(projectRoot, proofDirRel);
  const stagingProofDirRel = `${proofRunsRootRel}/.capture-${scenario.slug}`;
  const stagingProofDir = resolve(projectRoot, stagingProofDirRel);
  const runFolderRel = `${stagingProofDirRel}/run`;
  const runFolder = resolve(projectRoot, runFolderRel);
  const scenarioProjectRoot =
    scenario.prepareProject === undefined ? projectRoot : scenarioProjectPath(scenario.slug);
  const pathAliases = [{ fromRel: stagingProofDirRel, toRel: proofDirRel }];
  rmSync(stagingProofDir, { recursive: true, force: true });
  mkdirSync(stagingProofDir, { recursive: true });
  if (scenario.prepareProject !== undefined) {
    mkdirSync(scenarioProjectRoot, { recursive: true });
    scenario.prepareProject(scenarioProjectRoot);
  }

  try {
    const now = deterministicNow(scenario.startMs);
    const run = await runCli([...scenario.argv, '--run-folder', runFolder, '--progress', 'jsonl'], {
      relayer: scenario.relayer,
      ...(scenario.runtimeExecutors === undefined
        ? {}
        : { runtimeExecutors: scenario.runtimeExecutors }),
      runId: scenario.runId,
      now,
      configCwd: scenarioProjectRoot,
    });

    let finalStdout = run.stdout;
    let progress = run.stderr;
    if (scenario.resumeChoice !== undefined) {
      writeScrubbed(`${stagingProofDirRel}/checkpoint-result.json`, run.stdout, pathAliases);
      const resume = await runCli(
        [
          'resume',
          '--run-folder',
          runFolder,
          '--checkpoint-choice',
          scenario.resumeChoice,
          '--progress',
          'jsonl',
        ],
        {
          relayer: scenario.relayer,
          now,
          configCwd: scenarioProjectRoot,
        },
      );
      finalStdout = resume.stdout;
      progress += resume.stderr;
    }

    writeScrubbed(`${stagingProofDirRel}/progress.jsonl`, progress, pathAliases);
    writeScrubbed(`${stagingProofDirRel}/result.json`, finalStdout, pathAliases);
    writeScrubbed(
      `${stagingProofDirRel}/operator-summary.md`,
      readFileSync(join(runFolder, 'reports', 'operator-summary.md'), 'utf8'),
      pathAliases,
    );
    if (scenario.prepareProject !== undefined) {
      rmSync(scenarioProjectRoot, { recursive: true, force: true });
    }
    scrubProofTree(stagingProofDir, pathAliases);
    rmSync(proofDir, { recursive: true, force: true });
    renameSync(stagingProofDir, proofDir);
    console.log(`captured ${proofDirRel}`);
  } catch (err) {
    if (process.argv.includes('--keep-staging')) {
      console.error(`scenario ${scenario.slug} failed; staging kept at ${stagingProofDirRel}`);
    } else {
      rmSync(stagingProofDir, { recursive: true, force: true });
    }
    throw err;
  }
}

// A stale relay stub is the F12 regression class: the pursue review stub's
// body drifted from the flow's tightened `pursuit.review@v1` schema, so
// parseReport (src/flows/registries/report-schemas.ts) fail-closed and the
// runtime aborted the captured run. The abort reason is byte-identical to the
// parse error, so a scenario whose reason carries one of these signatures has
// a stub that no longer satisfies its flow's current report schema.
const SCHEMA_FAILURE_SIGNATURES = [
  'did not validate against schema',
  'did not parse as JSON against schema',
  'is not registered in the report-schema registry',
] as const;

function reasonIsSchemaFailure(reason: unknown): reason is string {
  return (
    typeof reason === 'string' && SCHEMA_FAILURE_SIGNATURES.some((sig) => reason.includes(sig))
  );
}

// Read the committed proof's semantic recency signals for a scenario: the
// top-level result.json outcome and the set of top-level report file names the
// committed run wrote. The top-level result.json envelope carries a wider
// outcome vocabulary than the RunResult enum (it includes checkpoint_waiting and
// ok), so this reads `.outcome` as a plain string rather than parsing it against
// the narrower schema. Missing pieces come back as undefined / empty so the
// comparison can name them instead of throwing.
function readCommittedProofRecency(slug: string): {
  outcome: string | undefined;
  reportNames: string[];
} {
  const proofDir = resolve(projectRoot, `${proofRunsRootRel}/${slug}`);
  const resultPath = join(proofDir, 'result.json');
  let outcome: string | undefined;
  if (existsSync(resultPath)) {
    const parsed = JSON.parse(readFileSync(resultPath, 'utf8')) as { outcome?: unknown };
    outcome = typeof parsed.outcome === 'string' ? parsed.outcome : undefined;
  }
  const reportsDir = join(proofDir, 'run', 'reports');
  const reportNames = existsSync(reportsDir) ? readdirSync(reportsDir) : [];
  return { outcome, reportNames };
}

// Run a scenario through the real runtime WITHOUT persisting any golden proof.
// Two checks, one pass: (1) the run must not abort on a report-schema mismatch
// (the stub-freshness class — a relay stub that no longer satisfies its flow's
// current report schema); (2) a clean run must still match the committed proof's
// terminal outcome and top-level report-name set (the recency/drift class —
// behavior moved but the committed proof was never refreshed). Uses the same
// fixture path the scenario's relayer was bound to (so the changed-files-on-disk
// acceptance criterion sees the stub's writes) but a throwaway run folder, and
// never touches the committed proof tree. Returns one message per problem found
// (an empty array means the scenario is fresh and in sync).
async function validateScenarioStubFreshness(scenario: Scenario): Promise<string[]> {
  const scenarioProjectRoot =
    scenario.prepareProject === undefined ? projectRoot : scenarioProjectPath(scenario.slug);
  const tmpRunRoot = mkdtempSync(join(tmpdir(), `circuit-stub-${scenario.slug}-`));
  const runFolder = join(tmpRunRoot, 'run');
  try {
    if (scenario.prepareProject !== undefined) {
      mkdirSync(scenarioProjectRoot, { recursive: true });
      scenario.prepareProject(scenarioProjectRoot);
    }
    const now = deterministicNow(scenario.startMs);
    const run = await runCli([...scenario.argv, '--run-folder', runFolder, '--progress', 'jsonl'], {
      relayer: scenario.relayer,
      ...(scenario.runtimeExecutors === undefined
        ? {}
        : { runtimeExecutors: scenario.runtimeExecutors }),
      runId: scenario.runId,
      now,
      configCwd: scenarioProjectRoot,
    });
    let finalStdout = run.stdout;
    if (scenario.resumeChoice !== undefined) {
      const resume = await runCli(
        [
          'resume',
          '--run-folder',
          runFolder,
          '--checkpoint-choice',
          scenario.resumeChoice,
          '--progress',
          'jsonl',
        ],
        { relayer: scenario.relayer, now, configCwd: scenarioProjectRoot },
      );
      finalStdout = resume.stdout;
    }
    let result: { outcome?: unknown; reason?: unknown };
    try {
      result = JSON.parse(finalStdout) as { outcome?: unknown; reason?: unknown };
    } catch (err) {
      return [
        `scenario '${scenario.slug}' produced unparseable CLI output: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ];
    }
    if (reasonIsSchemaFailure(result.reason)) {
      return [
        `scenario '${scenario.slug}' aborted on a report-schema failure — a relay stub no longer satisfies its flow's current report schema:\n    ${result.reason}`,
      ];
    }
    // The run is clean. Compare its semantic recency signals against the
    // committed proof so a silently drifted outcome or report set fails here
    // rather than surviving until the next recapture. Read the fresh report set
    // from the throwaway run folder before `finally` deletes it.
    const freshReportsDir = join(runFolder, 'reports');
    const freshReportNames = existsSync(freshReportsDir) ? readdirSync(freshReportsDir) : [];
    const committed = readCommittedProofRecency(scenario.slug);
    return compareProofRecency({
      slug: scenario.slug,
      freshOutcome: typeof result.outcome === 'string' ? result.outcome : undefined,
      committedOutcome: committed.outcome,
      freshReportNames,
      committedReportNames: committed.reportNames,
    });
  } finally {
    rmSync(tmpRunRoot, { recursive: true, force: true });
    if (scenario.prepareProject !== undefined) {
      rmSync(scenarioProjectRoot, { recursive: true, force: true });
    }
  }
}

// Walk a captured proof directory and read every file so the freshness guard
// can scan for a drifted runtime_version. Returns an empty file list when the
// capture directory is absent (which the guard reports as a missing capture).
function collectCapturedProof(slug: string): CapturedProof {
  const dirRel = `${proofRunsRootRel}/${slug}`;
  const dirAbs = resolve(projectRoot, dirRel);
  const files: CapturedProofFile[] = [];
  const walk = (absDir: string, rel: string): void => {
    for (const entry of readdirSync(absDir)) {
      const abs = join(absDir, entry);
      const childRel = `${rel}/${entry}`;
      if (statSync(abs).isDirectory()) walk(abs, childRel);
      else files.push({ rel: childRel, content: readFileSync(abs, 'utf8') });
    }
  };
  if (existsSync(dirAbs)) walk(dirAbs, dirRel);
  return { slug, dirRel, files };
}

function currentReleaseVersion(): string {
  const raw = readFileSync(resolve(projectRoot, 'plugins/version.json'), 'utf8');
  return (JSON.parse(raw) as { version?: string }).version ?? '';
}

async function validateStubFreshness(): Promise<void> {
  const failures: string[] = [];
  for (const scenario of scenarios) {
    const scenarioFailures = await validateScenarioStubFreshness(scenario);
    if (scenarioFailures.length === 0) {
      console.log(`stub-fresh ${scenario.slug}`);
    } else {
      for (const failure of scenarioFailures) {
        console.error(`error: ${failure}`);
      }
      failures.push(...scenarioFailures);
    }
  }

  // The captured proofs (doctor, handoff, customization) are produced outside
  // the scenario loop above, so before this guard they were never re-checked
  // for staleness: a capture could pin an older Circuit version at a newer HEAD
  // yet still back a verified_current public claim. Bring them under the same
  // guard — a drifted runtime_version or a missing capture now fails. The
  // doctor capture is presently stale (see the TODO at captureDoctor); this
  // guard makes that fail loudly until it is recaptured at the tag cut.
  const capturedFailures = capturedProofFreshnessFailures({
    currentVersion: currentReleaseVersion(),
    captures: ['doctor', 'handoff', 'customization'].map(collectCapturedProof),
  });
  for (const failure of capturedFailures) {
    console.error(`error: ${failure}`);
  }
  failures.push(...capturedFailures);

  if (failures.length > 0) {
    console.error(
      `\n${failures.length} proof scenario check(s) failed: a relay stub no longer satisfies its flow's report schema, or a committed proof drifted from current behavior (terminal outcome or report set). Fix the relay stub body in scripts/release/capture-golden-run-proofs.ts and/or re-run \`npm run capture-proofs:golden-runs\` to refresh the golden proofs, then review the diff per docs/release/proofs/README.md.`,
    );
    process.exit(1);
  }
  console.log(
    `✓ all ${scenarios.length} proof scenarios are stub-fresh and match their committed proofs`,
  );
}

// TODO(release): recapture doctor proof at tag cut — currently stale
function captureDoctor(): void {
  const proofDirRel = `${proofRunsRootRel}/doctor`;
  const proofDir = resolve(projectRoot, proofDirRel);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const result = spawnSync(process.execPath, ['plugins/codex/scripts/circuit.js', 'doctor'], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 180_000,
  });
  writeScrubbed(
    `${proofDirRel}/output.txt`,
    [
      '$ node plugins/codex/scripts/circuit.js doctor',
      `exit: ${result.status ?? 1}`,
      '',
      'stdout:',
      result.stdout,
      '',
      'stderr:',
      result.stderr,
    ].join('\n'),
  );
  scrubProofTree(proofDir);
  console.log(`captured ${proofDirRel}`);
}

async function captureHandoff(): Promise<void> {
  const proofDirRel = `${proofRunsRootRel}/handoff`;
  const proofDir = resolve(projectRoot, proofDirRel);
  const stagingProofDirRel = `${proofRunsRootRel}/.capture-handoff`;
  const stagingProofDir = resolve(projectRoot, stagingProofDirRel);
  const runFolder = resolve(projectRoot, `${stagingProofDirRel}/run`);
  const controlPlane = resolve(projectRoot, `${stagingProofDirRel}/control-plane`);
  const pathAliases = [{ fromRel: stagingProofDirRel, toRel: proofDirRel }];
  rmSync(stagingProofDir, { recursive: true, force: true });
  mkdirSync(stagingProofDir, { recursive: true });

  try {
    const now = deterministicNow(Date.UTC(2026, 3, 29, 22, 30, 0));
    const run = await runCli(
      [
        'run',
        'build',
        '--goal',
        'deep change that asks for handoff continuity',
        '--process',
        'high',
        '--run-folder',
        runFolder,
        '--progress',
        'jsonl',
      ],
      {
        runId: '44444444-4444-4444-4444-444444444411',
        runtimeExecutors: buildProofExecutors(),
        now,
        configCwd: projectRoot,
      },
    );
    const save = await runCli(
      [
        'handoff',
        'save',
        '--goal',
        'Resume the waiting Build proof run.',
        '--next',
        'DO: resolve the Build checkpoint and continue.',
        '--state-markdown',
        '- checkpoint is waiting on the framed Build proof',
        '--debt-markdown',
        '- BLOCKED: checkpoint needs an operator choice',
        '--run-folder',
        runFolder,
        '--control-plane',
        controlPlane,
        '--record-id',
        'continuity-44444444-4444-4444-8444-444444444411',
        '--created-at',
        '2026-04-29T22:31:00.000Z',
        '--progress',
        'jsonl',
      ],
      { now, configCwd: projectRoot },
    );
    const resume = await runCli(
      ['handoff', 'resume', '--control-plane', controlPlane, '--progress', 'jsonl'],
      { now, configCwd: projectRoot },
    );
    const saveResult = JSON.parse(save.stdout);
    const resumeResult = JSON.parse(resume.stdout);

    writeScrubbed(
      `${stagingProofDirRel}/progress.jsonl`,
      run.stderr + save.stderr + resume.stderr,
      pathAliases,
    );
    writeScrubbed(`${stagingProofDirRel}/checkpoint-result.json`, run.stdout, pathAliases);
    writeScrubbed(`${stagingProofDirRel}/result.json`, resume.stdout, pathAliases);
    writeScrubbed(
      `${stagingProofDirRel}/operator-summary.md`,
      readFileSync(resumeResult.operator_summary_markdown_path, 'utf8'),
      pathAliases,
    );
    writeScrubbed(
      `${stagingProofDirRel}/continuity.json`,
      readFileSync(saveResult.continuity_path, 'utf8'),
      pathAliases,
    );
    scrubProofTree(stagingProofDir, pathAliases);
    rmSync(proofDir, { recursive: true, force: true });
    renameSync(stagingProofDir, proofDir);
    console.log(`captured ${proofDirRel}`);
  } catch (err) {
    rmSync(stagingProofDir, { recursive: true, force: true });
    throw err;
  }
}

async function captureCustomization(): Promise<void> {
  const proofDirRel = `${proofRunsRootRel}/customization`;
  const proofDir = resolve(projectRoot, proofDirRel);
  const stagingProofDirRel = `${proofRunsRootRel}/.capture-customization`;
  const stagingProofDir = resolve(projectRoot, stagingProofDirRel);
  const home = resolve(projectRoot, `${stagingProofDirRel}/custom-home`);
  const pathAliases = [{ fromRel: stagingProofDirRel, toRel: proofDirRel }];
  rmSync(stagingProofDir, { recursive: true, force: true });
  mkdirSync(stagingProofDir, { recursive: true });

  try {
    const now = deterministicNow(Date.UTC(2026, 3, 29, 23, 0, 0));
    const create = await runCli(
      [
        'create',
        '--name',
        'release-note-flow',
        '--description',
        'Draft release notes from a change summary.',
        '--home',
        home,
        '--publish',
        '--yes',
        '--created-at',
        '2026-04-29T23:00:00.000Z',
        '--progress',
        'jsonl',
      ],
      { now, configCwd: projectRoot },
    );
    const createResult = JSON.parse(create.stdout);
    writeScrubbed(`${stagingProofDirRel}/progress.jsonl`, create.stderr, pathAliases);
    writeScrubbed(`${stagingProofDirRel}/result.json`, create.stdout, pathAliases);
    writeScrubbed(
      `${stagingProofDirRel}/operator-summary.md`,
      readFileSync(createResult.operator_summary_markdown_path, 'utf8'),
      pathAliases,
    );
    scrubProofTree(stagingProofDir, pathAliases);
    rmSync(proofDir, { recursive: true, force: true });
    renameSync(stagingProofDir, proofDir);
    console.log(`captured ${proofDirRel}`);
  } catch (err) {
    rmSync(stagingProofDir, { recursive: true, force: true });
    throw err;
  }
}

const scenarios: Scenario[] = [
  {
    slug: 'routed-build',
    argv: ['run', 'build', '--goal', 'develop: add a small safe change'],
    relayer: buildRelayer(scenarioProjectPath('routed-build')),
    runtimeExecutors: buildProofExecutors(),
    prepareProject: prepareBuildProofProject,
    runId: '44444444-4444-4444-4444-444444444402',
    startMs: Date.UTC(2026, 3, 29, 18, 0, 0),
  },
  {
    slug: 'explicit-build',
    argv: ['run', 'build', '--goal', 'add a focused change', '--process', 'high'],
    relayer: buildRelayer(scenarioProjectPath('explicit-build')),
    runtimeExecutors: buildProofExecutors(),
    prepareProject: prepareBuildProofProject,
    runId: '44444444-4444-4444-4444-444444444403',
    startMs: Date.UTC(2026, 3, 29, 18, 30, 0),
  },
  {
    slug: 'review',
    argv: ['run', 'review', '--goal', 'review this change'],
    relayer: reviewRelayer(),
    prepareProject: prepareReviewProofProject,
    runId: '44444444-4444-4444-4444-444444444404',
    startMs: Date.UTC(2026, 3, 29, 19, 0, 0),
  },
  {
    slug: 'checkpoint',
    argv: ['run', 'build', '--goal', 'deep change that asks for scope', '--process', 'high'],
    relayer: buildRelayer(scenarioProjectPath('checkpoint')),
    runtimeExecutors: buildProofExecutors(),
    prepareProject: prepareBuildProofProject,
    resumeChoice: 'continue',
    runId: '44444444-4444-4444-4444-444444444405',
    startMs: Date.UTC(2026, 3, 29, 19, 30, 0),
  },
  {
    slug: 'abort',
    argv: ['run', 'build', '--goal', 'simulate connector failure'],
    relayer: buildAbortRelayer(scenarioProjectPath('abort')),
    runtimeExecutors: buildProofExecutors(),
    prepareProject: prepareBuildProofProject,
    runId: '44444444-4444-4444-4444-444444444406',
    startMs: Date.UTC(2026, 3, 29, 20, 0, 0),
  },
  {
    slug: 'fix',
    argv: ['run', 'fix', '--goal', 'quick fix: restore the failing login test'],
    relayer: fixRelayer(scenarioProjectPath('fix')),
    runtimeExecutors: fixProofExecutors(),
    prepareProject: prepareFixProofProject,
    runId: '44444444-4444-4444-4444-444444444407',
    startMs: Date.UTC(2026, 3, 29, 20, 30, 0),
  },
  {
    slug: 'pursue',
    argv: [
      'run',
      'pursue',
      '--goal',
      'add the fallback answer guard in src/example.ts; document the guard in notes.md',
    ],
    relayer: pursueRelayer(scenarioProjectPath('pursue')),
    prepareProject: preparePursueProofProject,
    runId: '44444444-4444-4444-4444-444444444412',
    startMs: Date.UTC(2026, 3, 29, 21, 0, 0),
  },
  {
    slug: 'explore-standard',
    argv: [
      'run',
      'explore',
      '--goal',
      'recommend a frontend framework for the new analytics dashboard',
    ],
    relayer: exploreStandardRelayer(),
    runId: '44444444-4444-4444-4444-444444444440',
    startMs: Date.UTC(2026, 3, 29, 16, 30, 0),
  },
  {
    slug: 'explore-decision',
    argv: ['run', 'explore', '--goal', 'decide: React vs Vue', '--tournament', '3'],
    relayer: exploreDecisionRelayer(),
    resumeChoice: 'option-2',
    runId: '44444444-4444-4444-4444-444444444441',
    startMs: Date.UTC(2026, 3, 29, 17, 0, 0),
  },
  {
    slug: 'explore-autonomous-decision',
    argv: ['run', 'explore', '--goal', 'decide: React vs Vue', '--tournament', '2', '--autonomous'],
    relayer: exploreAutonomousDecisionRelayer(),
    runId: '44444444-4444-4444-4444-444444444442',
    startMs: Date.UTC(2026, 3, 29, 17, 30, 0),
  },
  {
    slug: 'prototype',
    argv: [
      'run',
      'prototype',
      '--goal',
      'prototype: sketch a custom Circuit flow builder UI',
      '--process',
      'high',
    ],
    relayer: prototypeRelayer(),
    resumeChoice: 'save-build-input',
    runId: '44444444-4444-4444-4444-444444444443',
    startMs: Date.UTC(2026, 3, 29, 21, 30, 0),
  },
  {
    slug: 'plan-execution',
    argv: [
      'run',
      'build',
      '--goal',
      'Execute this plan: ./docs/specs/headless-engine-host-api-v1.md',
    ],
    relayer: buildRelayer(scenarioProjectPath('plan-execution')),
    runtimeExecutors: buildProofExecutors(),
    prepareProject: (root) => prepareBuildProofProject(root, { includePlanSpec: true }),
    runId: '44444444-4444-4444-4444-444444444410',
    startMs: Date.UTC(2026, 3, 29, 22, 0, 0),
  },
];

const cliArgs = process.argv.slice(2);
const validateStubsOnly = cliArgs.includes('--validate-stubs');
const scenarioFilter: string[] = [];
for (let i = 0; i < cliArgs.length; i++) {
  if (cliArgs[i] === '--scenario') {
    const value = cliArgs[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error('--scenario requires a slug');
    }
    scenarioFilter.push(value);
    i++;
  } else if (cliArgs[i] !== '--keep-staging' && cliArgs[i] !== '--validate-stubs') {
    throw new Error(`unknown argument: ${cliArgs[i]}`);
  }
}

// --validate-stubs is the fast freshness guard: run every scenario through the
// real runtime and fail loudly if any relay stub no longer satisfies its flow's
// current report schema, WITHOUT writing or mutating the committed golden
// proofs. This is what catches the F12 regression class at check time instead
// of surfacing later as an aborted golden run.
if (validateStubsOnly) {
  await validateStubFreshness();
} else {
  const knownSlugs = [...scenarios.map((s) => s.slug), 'handoff', 'customization', 'doctor'];
  for (const slug of scenarioFilter) {
    if (!knownSlugs.includes(slug)) {
      throw new Error(`unknown scenario: ${slug} (known: ${knownSlugs.join(', ')})`);
    }
  }
  const wants = (slug: string): boolean =>
    scenarioFilter.length === 0 || scenarioFilter.includes(slug);

  for (const scenario of scenarios) {
    if (wants(scenario.slug)) await captureCliScenario(scenario);
  }
  if (wants('handoff')) await captureHandoff();
  if (wants('customization')) await captureCustomization();
  if (wants('doctor')) captureDoctor();
}
