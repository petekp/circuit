#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type * as CliCircuitModule from '../../src/cli/circuit.js';
import type * as CheckpointExecutorModule from '../../src/runtime/executors/checkpoint.js';
import type * as ComposeModule from '../../src/runtime/executors/compose.js';

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
    if (code !== 0) throw new Error(`circuit CLI exited ${code}`);
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
    if (!/\.(json|jsonl|md|ndjson|txt|yaml|yml)$/.test(rel)) continue;
    writeFileSync(abs, scrubText(readFileSync(abs, 'utf8'), pathAliases));
  }
}

function buildRelayer(): Relayer {
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

function buildAbortRelayer(): Relayer {
  return {
    connectorName: 'claude-code',
    relay: async (input: RelayInput): Promise<RelayOutcome> => {
      if (input.prompt.includes('Step: act-step')) {
        throw new Error('proof connector failure while implementing the synthetic Build change');
      }
      return buildRelayer().relay(input);
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
        : (context.axes?.rigor ?? 'standard'));
  const waitsForOperator = effectiveDepth === 'deep' || effectiveDepth === 'tournament';
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

function fixRelayer(): Relayer {
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

function readPromptJson(prompt: string, relPath: string): Record<string, unknown> {
  const marker = `--- ${relPath} ---\n`;
  const start = prompt.indexOf(marker);
  if (start < 0) throw new Error(`prompt did not include ${relPath}`);
  const jsonStart = start + marker.length;
  const nextReport = prompt.indexOf('\n\n--- ', jsonStart);
  const instructionStart = prompt.indexOf('\n\nRespond with', jsonStart);
  const endCandidates = [nextReport, instructionStart].filter((index) => index >= 0);
  const jsonEnd = endCandidates.length === 0 ? prompt.length : Math.min(...endCandidates);
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

function runProofGit(cwd: string, args: readonly string[]): void {
  const result = spawnSync('git', [...args], {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `proof git ${args.join(' ')} failed: ${result.stderr || result.stdout || 'no output'}`,
    );
  }
}

function prepareReviewProofProject(root: string): void {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"name":"review-proof-fixture","private":true}\n');
  writeFileSync(join(root, 'src', 'example.ts'), 'export const answer = 42;\n');
  runProofGit(root, ['init']);
  runProofGit(root, ['add', '.']);
  runProofGit(root, [
    '-c',
    'user.name=Circuit Proof',
    '-c',
    'user.email=circuit-proof@example.test',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'initial review proof fixture',
  ]);
  writeFileSync(join(root, 'src', 'example.ts'), 'export const answer = 43;\n');
  writeFileSync(join(root, 'notes.md'), 'Untracked review note.\n');
  runProofGit(root, ['add', 'src/example.ts']);
}

async function captureCliScenario(scenario: Scenario): Promise<void> {
  const proofDirRel = `${proofRunsRootRel}/${scenario.slug}`;
  const proofDir = resolve(projectRoot, proofDirRel);
  const stagingProofDirRel = `${proofRunsRootRel}/.capture-${scenario.slug}`;
  const stagingProofDir = resolve(projectRoot, stagingProofDirRel);
  const runFolderRel = `${stagingProofDirRel}/run`;
  const runFolder = resolve(projectRoot, runFolderRel);
  const scenarioProjectRel = `${stagingProofDirRel}/project`;
  const scenarioProjectRoot =
    scenario.prepareProject === undefined ? projectRoot : resolve(projectRoot, scenarioProjectRel);
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
    rmSync(stagingProofDir, { recursive: true, force: true });
    throw err;
  }
}

function captureDoctor(): void {
  const proofDirRel = `${proofRunsRootRel}/doctor`;
  const proofDir = resolve(projectRoot, proofDirRel);
  rmSync(proofDir, { recursive: true, force: true });
  mkdirSync(proofDir, { recursive: true });
  const result = spawnSync(process.execPath, ['plugins/codex/scripts/circuit.ts', 'doctor'], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 180_000,
  });
  writeScrubbed(
    `${proofDirRel}/output.txt`,
    [
      '$ node plugins/codex/scripts/circuit.ts doctor',
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
        '--rigor',
        'deep',
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
        '--template-flow-root',
        resolve(projectRoot, 'generated/flows'),
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
    relayer: buildRelayer(),
    runtimeExecutors: buildProofExecutors(),
    runId: '44444444-4444-4444-4444-444444444402',
    startMs: Date.UTC(2026, 3, 29, 18, 0, 0),
  },
  {
    slug: 'explicit-build',
    argv: ['run', 'build', '--goal', 'add a focused change', '--rigor', 'deep'],
    relayer: buildRelayer(),
    runtimeExecutors: buildProofExecutors(),
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
    argv: ['run', 'build', '--goal', 'deep change that asks for scope', '--rigor', 'deep'],
    relayer: buildRelayer(),
    runtimeExecutors: buildProofExecutors(),
    resumeChoice: 'continue',
    runId: '44444444-4444-4444-4444-444444444405',
    startMs: Date.UTC(2026, 3, 29, 19, 30, 0),
  },
  {
    slug: 'abort',
    argv: ['run', 'build', '--goal', 'simulate connector failure'],
    relayer: buildAbortRelayer(),
    runtimeExecutors: buildProofExecutors(),
    runId: '44444444-4444-4444-4444-444444444406',
    startMs: Date.UTC(2026, 3, 29, 20, 0, 0),
  },
  {
    slug: 'fix',
    argv: ['run', 'fix', '--goal', 'quick fix: restore the failing login test'],
    relayer: fixRelayer(),
    runtimeExecutors: fixProofExecutors(),
    runId: '44444444-4444-4444-4444-444444444407',
    startMs: Date.UTC(2026, 3, 29, 20, 30, 0),
  },
  {
    slug: 'explore-decision',
    argv: [
      'run',
      'explore',
      '--goal',
      'decide: React vs Vue',
      '--tournament',
      '--tournament-n',
      '3',
    ],
    relayer: exploreDecisionRelayer(),
    resumeChoice: 'option-2',
    runId: '44444444-4444-4444-4444-444444444441',
    startMs: Date.UTC(2026, 3, 29, 17, 0, 0),
  },
  {
    slug: 'explore-autonomous-decision',
    argv: [
      'run',
      'explore',
      '--goal',
      'decide: React vs Vue',
      '--tournament',
      '--tournament-n',
      '2',
      '--autonomous',
    ],
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
      '--rigor',
      'deep',
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
    relayer: buildRelayer(),
    runtimeExecutors: buildProofExecutors(),
    runId: '44444444-4444-4444-4444-444444444410',
    startMs: Date.UTC(2026, 3, 29, 22, 0, 0),
  },
];

for (const scenario of scenarios) {
  await captureCliScenario(scenario);
}
await captureHandoff();
await captureCustomization();
captureDoctor();
