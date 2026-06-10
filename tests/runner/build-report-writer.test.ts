import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow } from '../helpers/runtime-fixtures.js';

import {
  BuildBrief,
  BuildContext,
  BuildImplementation,
  BuildPlan,
  BuildResult,
  BuildReview,
  BuildTouchArea,
  BuildVerification,
} from '../../src/flows/build/reports.js';
import { findComposeBuilder } from '../../src/flows/registries/compose-writers/registry.js';
import type { ComposeBuildContext } from '../../src/flows/registries/compose-writers/types.js';
import { executeCompose } from '../../src/runtime/executors/compose.js';
import type { ExecutorRegistry } from '../../src/runtime/executors/index.js';
import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { CompiledFlow } from '../../src/schemas/compiled-flow.js';

function writeJson(root: string, rel: string, body: unknown): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${JSON.stringify(body, null, 2)}\n`);
}

function readJson(root: string, rel: string): unknown {
  return JSON.parse(readFileSync(join(root, rel), 'utf8')) as unknown;
}

function planCompiledFlow(options: { omitBriefRead?: boolean } = {}): {
  bytes: Buffer;
} {
  const raw = {
    schema_version: '3',
    id: 'build-plan-writer-test',
    version: '0.1.0',
    purpose: 'test Build plan writer',
    axes: {
      allowed_rigors: ['standard'],
      supports_tournament: false,
      supports_autonomous: false,
    },
    starts_at: 'seed-brief-step',
    stages: [
      {
        id: 'plan-stage',
        title: 'Plan',
        canonical: 'plan',
        steps: ['seed-brief-step', 'seed-context-step', 'plan-step'],
      },
    ],
    stage_path_policy: {
      mode: 'partial',
      omits: ['frame', 'analyze', 'act', 'verify', 'review', 'close'],
      rationale: 'test-only Build plan writer payload with all other stages out of scope.',
    },
    steps: [
      {
        id: 'seed-brief-step',
        title: 'Seed brief',
        protocol: 'test-seed-build-brief@v1',
        reads: [],
        routes: { pass: 'seed-context-step' },
        executor: 'orchestrator',
        kind: 'compose',
        writes: { report: { path: 'reports/build/brief.json', schema: 'build.brief@v1' } },
        check: {
          kind: 'schema_sections',
          source: { kind: 'report', ref: 'report' },
          required: ['objective', 'verification_command_candidates'],
        },
      },
      {
        id: 'seed-context-step',
        title: 'Seed context',
        protocol: 'test-seed-build-context@v1',
        reads: [],
        routes: { pass: 'plan-step' },
        executor: 'orchestrator',
        kind: 'compose',
        writes: { report: { path: 'reports/build/context.json', schema: 'build.context@v1' } },
        check: {
          kind: 'schema_sections',
          source: { kind: 'report', ref: 'report' },
          required: ['verdict', 'sources', 'observations'],
        },
      },
      {
        id: 'plan-step',
        title: 'Plan',
        protocol: 'build-plan@v1',
        reads:
          options.omitBriefRead === true
            ? ['reports/build/context.json']
            : ['reports/build/brief.json', 'reports/build/context.json'],
        routes: { pass: '@complete' },
        executor: 'orchestrator',
        kind: 'compose',
        writes: { report: { path: 'reports/build/plan.json', schema: 'build.plan@v1' } },
        check: {
          kind: 'schema_sections',
          source: { kind: 'report', ref: 'report' },
          required: ['objective', 'verification'],
        },
      },
    ],
  };
  const bytes = Buffer.from(JSON.stringify(raw));
  CompiledFlow.parse(raw);
  return { bytes };
}

function closeCompiledFlow(
  options: {
    reads?: string[];
    omitProducerSchema?: string;
  } = {},
): { bytes: Buffer } {
  const seedSteps = [
    {
      id: 'seed-brief-step',
      title: 'Seed brief',
      protocol: 'test-seed-build-brief@v1',
      reads: [],
      routes: { pass: 'seed-plan-step' },
      executor: 'orchestrator',
      kind: 'compose',
      writes: { report: { path: 'reports/build/brief.json', schema: 'build.brief@v1' } },
      check: {
        kind: 'schema_sections',
        source: { kind: 'report', ref: 'report' },
        required: ['objective', 'verification_command_candidates'],
      },
    },
    {
      id: 'seed-plan-step',
      title: 'Seed plan',
      protocol: 'test-seed-build-plan@v1',
      reads: ['reports/build/brief.json'],
      routes: { pass: 'seed-implementation-step' },
      executor: 'orchestrator',
      kind: 'compose',
      writes: { report: { path: 'reports/build/plan.json', schema: 'build.plan@v1' } },
      check: {
        kind: 'schema_sections',
        source: { kind: 'report', ref: 'report' },
        required: ['objective', 'verification'],
      },
    },
    {
      id: 'seed-implementation-step',
      title: 'Seed implementation',
      protocol: 'test-seed-build-implementation@v1',
      reads: ['reports/build/plan.json'],
      routes: { pass: 'seed-verification-step' },
      executor: 'orchestrator',
      kind: 'compose',
      writes: {
        report: {
          path: 'reports/build/implementation.json',
          schema: 'build.implementation@v1',
        },
      },
      check: {
        kind: 'schema_sections',
        source: { kind: 'report', ref: 'report' },
        required: ['summary', 'evidence'],
      },
    },
    {
      id: 'seed-verification-step',
      title: 'Seed verification',
      protocol: 'test-seed-build-verification@v1',
      reads: ['reports/build/implementation.json'],
      routes: { pass: 'seed-review-step' },
      executor: 'orchestrator',
      kind: 'compose',
      writes: {
        report: {
          path: 'reports/build/verification.json',
          schema: 'build.verification@v1',
        },
      },
      check: {
        kind: 'schema_sections',
        source: { kind: 'report', ref: 'report' },
        required: ['overall_status', 'commands'],
      },
    },
    {
      id: 'seed-review-step',
      title: 'Seed review',
      protocol: 'test-seed-build-review@v1',
      reads: ['reports/build/verification.json'],
      routes: { pass: 'close-step' },
      executor: 'orchestrator',
      kind: 'compose',
      writes: { report: { path: 'reports/build/review.json', schema: 'build.review@v1' } },
      check: {
        kind: 'schema_sections',
        source: { kind: 'report', ref: 'report' },
        required: ['verdict', 'summary'],
      },
    },
    {
      id: 'seed-touch-area-step',
      title: 'Seed touch area',
      protocol: 'test-seed-build-touch-area@v1',
      reads: ['reports/build/review.json'],
      routes: { pass: 'close-step' },
      executor: 'orchestrator',
      kind: 'compose',
      writes: {
        report: { path: 'reports/build/touch-area.json', schema: 'build.touch-area@v1' },
      },
      check: {
        kind: 'schema_sections',
        source: { kind: 'report', ref: 'report' },
        required: ['overall_status', 'enforcement', 'containment'],
      },
    },
  ].filter((step) => step.writes.report.schema !== options.omitProducerSchema);
  for (const [index, seedStep] of seedSteps.entries()) {
    seedStep.routes = { pass: seedSteps[index + 1]?.id ?? 'close-step' };
  }
  const raw = {
    schema_version: '3',
    id: 'build-result-writer-test',
    version: '0.1.0',
    purpose: 'test Build result writer',
    axes: {
      allowed_rigors: ['standard'],
      supports_tournament: false,
      supports_autonomous: false,
    },
    starts_at: seedSteps[0]?.id ?? 'close-step',
    stages: [
      {
        id: 'close-stage',
        title: 'Close',
        canonical: 'close',
        steps: [...seedSteps.map((step) => step.id), 'close-step'],
      },
    ],
    stage_path_policy: {
      mode: 'partial',
      omits: ['frame', 'analyze', 'plan', 'act', 'verify', 'review'],
      rationale: 'test-only Build close writer payload with prior reports prewritten.',
    },
    steps: [
      ...seedSteps,
      {
        id: 'close-step',
        title: 'Close',
        protocol: 'build-close@v1',
        // The close builder reads the 5 role reports (its evidence_links
        // pointers) plus the touch-area verdict it gates on. touch-area is a
        // verification report, not a close pointer, so it is not in
        // buildRoleReportPaths() (which the evidence_links assertion checks).
        reads: options.reads ?? [...buildRoleReportPaths(), 'reports/build/touch-area.json'],
        routes: { pass: '@complete' },
        executor: 'orchestrator',
        kind: 'compose',
        writes: {
          report: { path: 'reports/build-result.json', schema: 'build.result@v1' },
        },
        check: {
          kind: 'schema_sections',
          source: { kind: 'report', ref: 'report' },
          required: ['summary', 'evidence_links'],
        },
      },
    ],
  };
  const bytes = Buffer.from(JSON.stringify(raw));
  CompiledFlow.parse(raw);
  return { bytes };
}

function buildRoleReportPaths(): string[] {
  return [
    'reports/build/brief.json',
    'reports/build/plan.json',
    'reports/build/implementation.json',
    'reports/build/verification.json',
    'reports/build/review.json',
  ];
}

function seedBuildRoleReport(runFolder: string, schema: string): void {
  if (schema === 'build.brief@v1') {
    writeJson(
      runFolder,
      'reports/build/brief.json',
      BuildBrief.parse({
        objective: 'Add a small feature',
        scope: 'Runtime writer test',
        success_criteria: ['Build result parses'],
        verification_command_candidates: [
          {
            id: 'npm-verify',
            cwd: '.',
            argv: ['npm', 'run', 'verify'],
            timeout_ms: 120_000,
            max_output_bytes: 200_000,
            env: {},
          },
        ],
        checkpoint: {
          request_path: 'reports/checkpoints/frame-request.json',
          allowed_choices: ['proceed'],
        },
        checkpoint_packet: {
          kind: 'build.checkpoint_packet@v1',
          salience: {
            summary: 'Confirm the Build brief before implementation starts.',
            why_now: ['The next route can edit the checkout.'],
            hidden_routine_work: ['Routine implementation chores stay inside the Build flow.'],
          },
          decision: {
            question: 'Confirm the Build brief before implementation starts.',
            operator_judgment: 'Decide whether this scope and proof plan should proceed.',
          },
          recommendation: {
            choice_id: 'proceed',
            label: 'Proceed',
            rationale: 'The scope is bounded and the verification plan is explicit.',
          },
          artifact: {
            title: 'Build brief',
            preview: 'Objective: Add a small feature',
            scope: 'Runtime writer test',
            success_criteria: ['Build result parses'],
          },
          proof: {
            status: 'planned',
            summary: 'Circuit will verify with npm run verify.',
            commands: [
              {
                id: 'npm-verify',
                cwd: '.',
                argv: ['npm', 'run', 'verify'],
                timeout_ms: 120_000,
                max_output_bytes: 200_000,
                env: {},
              },
            ],
            evidence: ['No implementation proof has been collected before the checkpoint.'],
          },
          risk: {
            summary: 'Scope mismatch is the meaningful risk.',
            tradeoffs: ['Too narrow misses intent.', 'Too broad touches unrelated files.'],
          },
          choices: [
            {
              id: 'proceed',
              label: 'Proceed',
              description: 'Proceed on the executable Build route.',
              route: { key: 'proceed', target: 'plan-step' },
            },
          ],
          internal: {
            request_path: 'reports/checkpoints/frame-request.json',
            response_path: 'reports/checkpoints/frame-response.json',
            report_path: 'reports/build/brief.json',
            raw_evidence: ['reports/build/brief.json', 'reports/checkpoints/frame-request.json'],
          },
        },
      }),
    );
    return;
  }
  if (schema === 'build.context@v1') {
    writeJson(
      runFolder,
      'reports/build/context.json',
      BuildContext.parse({
        verdict: 'accept',
        sources: [
          {
            kind: 'file',
            ref: 'src/runtime/runner.ts',
            summary: 'Module the change touches.',
          },
        ],
        observations: ['The target module is small and self-contained.'],
        open_questions: [],
      }),
    );
    return;
  }
  if (schema === 'build.plan@v1') {
    writeJson(
      runFolder,
      'reports/build/plan.json',
      BuildPlan.parse({
        objective: 'Add a small feature',
        approach: 'Implement and verify',
        slices: [{ id: 'slice-1', intent: 'Runtime writer test', anticipated_file_extensions: [] }],
        verification: {
          commands: [
            {
              id: 'npm-verify',
              cwd: '.',
              argv: ['npm', 'run', 'verify'],
              timeout_ms: 120_000,
              max_output_bytes: 200_000,
              env: {},
            },
          ],
        },
      }),
    );
    return;
  }
  if (schema === 'build.implementation@v1') {
    writeJson(
      runFolder,
      'reports/build/implementation.json',
      BuildImplementation.parse({
        verdict: 'accept',
        summary: 'Implemented the requested change',
        changed_files: ['src/runtime/runner.ts'],
        evidence: ['Focused runtime writer test'],
      }),
    );
    return;
  }
  if (schema === 'build.verification@v1') {
    writeJson(
      runFolder,
      'reports/build/verification.json',
      BuildVerification.parse({
        overall_status: 'passed',
        commands: [
          {
            command_id: 'npm-verify',
            argv: ['npm', 'run', 'verify'],
            cwd: '.',
            exit_code: 0,
            status: 'passed',
            duration_ms: 1,
            stdout_summary: 'passed',
            stderr_summary: '',
          },
        ],
      }),
    );
    return;
  }
  if (schema === 'build.review@v1') {
    writeJson(
      runFolder,
      'reports/build/review.json',
      BuildReview.parse({
        verdict: 'accept',
        summary: 'No blocking issues',
        findings: [],
        alignment: { scope_adherence: 'within_scope', non_goals: [], invariants: [] },
      }),
    );
    return;
  }
  if (schema === 'build.touch-area@v1') {
    // The seeded plan declares no allowed_touch_area, so the gate is inert.
    writeJson(
      runFolder,
      'reports/build/touch-area.json',
      BuildTouchArea.parse({
        overall_status: 'passed',
        enforcement: 'not_enforced',
        containment: 'within',
        allowed_area: [],
        observed_paths: [],
        out_of_bounds_paths: [],
        head_diverged: false,
        hidden_index_flags: [],
      }),
    );
    return;
  }
  throw new Error(`unexpected test seed schema ${schema}`);
}

function seedThenDefaultWriter(
  options: { removeVerification?: boolean; corruptBrief?: boolean; corruptPlan?: boolean } = {},
): Pick<ExecutorRegistry, 'compose'> {
  return {
    compose: async (step, context) => {
      if (step.kind !== 'compose') throw new Error('expected compose step');
      if (!step.id.startsWith('seed-')) {
        return await executeCompose(step, context);
      }
      const report = step.writes?.report;
      if (report?.schema === undefined) {
        throw new Error(`seed step '${step.id}' must write a schema-bearing report`);
      }
      seedBuildRoleReport(context.runDir, report.schema);
      if (options.removeVerification === true) {
        rmSync(join(context.runDir, 'reports/build/verification.json'));
      }
      if (options.corruptBrief === true) {
        writeJson(context.runDir, 'reports/build/brief.json', {
          objective: 'missing required fields',
        });
      }
      if (options.corruptPlan === true) {
        writeJson(context.runDir, 'reports/build/plan.json', {
          objective: 'missing required fields',
        });
      }
      await context.trace.append({
        run_id: context.runId,
        kind: 'step.report_written',
        step_id: step.id,
        attempt: context.activeStepAttempt ?? 1,
        report_path: report.path,
        report_schema: report.schema,
      });
      return { route: 'pass', details: { report: report.path } };
    },
  };
}

let runFolderBase: string;

beforeEach(() => {
  runFolderBase = join(tmpdir(), `circuit-build-reports-${randomUUID()}`);
  mkdirSync(runFolderBase, { recursive: true });
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
});

describe('Build compose writers', () => {
  it('writes schema-valid build.plan with typed verification commands', async () => {
    const { bytes } = planCompiledFlow();
    const runFolder = join(runFolderBase, 'plan');

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: 'b1000000-0000-0000-0000-000000000000',
      goal: 'Add a Build plan writer',
      depth: 'standard',
      now: deterministicNow(Date.UTC(2026, 3, 25, 1, 0, 0)),
      executors: seedThenDefaultWriter(),
    });

    expect(outcome.outcome).toBe('complete');
    const plan = BuildPlan.parse(readJson(runFolder, 'reports/build/plan.json'));
    expect(plan.verification.commands).toEqual([
      {
        id: 'npm-verify',
        cwd: '.',
        argv: ['npm', 'run', 'verify'],
        timeout_ms: 120_000,
        max_output_bytes: 200_000,
        env: {},
      },
    ]);
    expect(plan.objective).toBe('Add a small feature');
    // No build.context@v1 in this reduced fixture, so the plan writer falls
    // back to a single slice covering the whole objective (single pass).
    expect(plan.slices).toEqual([
      { id: 'slice-1', intent: 'Add a small feature', anticipated_file_extensions: [] },
    ]);
  });

  it('aborts Build plan when the brief is not an explicit read', async () => {
    const { bytes } = planCompiledFlow({ omitBriefRead: true });
    const runFolder = join(runFolderBase, 'plan-missing-brief-read');

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: 'b1000000-0000-0000-0000-000000000006',
      goal: 'Reject ungrounded Build plan',
      depth: 'standard',
      now: deterministicNow(Date.UTC(2026, 3, 25, 1, 1, 0)),
      executors: seedThenDefaultWriter(),
    });

    expect(outcome.outcome).toBe('aborted');
    expect(existsSync(join(runFolder, 'reports/build/plan.json'))).toBe(false);
    expect(outcome.reason).toMatch(/build\.brief@v1|brief\.json/);
  });

  it('aborts Build plan when the brief is malformed', async () => {
    const { bytes } = planCompiledFlow();
    const runFolder = join(runFolderBase, 'plan-malformed-brief');

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: 'b1000000-0000-0000-0000-000000000007',
      goal: 'Reject malformed Build brief',
      depth: 'standard',
      now: deterministicNow(Date.UTC(2026, 3, 25, 1, 2, 0)),
      executors: seedThenDefaultWriter({ corruptBrief: true }),
    });

    expect(outcome.outcome).toBe('aborted');
    expect(existsSync(join(runFolder, 'reports/build/plan.json'))).toBe(false);
    expect(outcome.reason).toMatch(/verification_command_candidates|scope/);
  });

  it('writes schema-valid build.result at build-result.json while result.json remains universal', async () => {
    const { bytes } = closeCompiledFlow();
    const runFolder = join(runFolderBase, 'close');

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: 'b1000000-0000-0000-0000-000000000001',
      goal: 'Close a Build run',
      depth: 'standard',
      now: deterministicNow(Date.UTC(2026, 3, 25, 1, 5, 0)),
      executors: seedThenDefaultWriter(),
    });

    expect(outcome.outcome).toBe('complete');
    const buildResult = BuildResult.parse(readJson(runFolder, 'reports/build-result.json'));
    expect(buildResult.evidence_links.map((pointer) => pointer.path)).toEqual(
      buildRoleReportPaths(),
    );
    expect(buildResult.summary).toContain('Implemented the requested change');

    expect(existsSync(join(runFolder, 'reports', 'result.json'))).toBe(true);
    const universalResult = JSON.parse(
      readFileSync(join(runFolder, 'reports', 'result.json'), 'utf8'),
    ) as { result_path?: string; outcome?: string };
    expect(universalResult.outcome).toBe('complete');
    expect(universalResult).not.toHaveProperty('evidence_links');
  });

  it('aborts Build close instead of writing placeholder success when a prior report is missing', async () => {
    const { bytes } = closeCompiledFlow();
    const runFolder = join(runFolderBase, 'missing-prior');

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: 'b1000000-0000-0000-0000-000000000002',
      goal: 'Reject missing verification',
      depth: 'standard',
      now: deterministicNow(Date.UTC(2026, 3, 25, 1, 10, 0)),
      executors: seedThenDefaultWriter({ removeVerification: true }),
    });

    expect(outcome.outcome).toBe('aborted');
    expect(existsSync(join(runFolder, 'reports/build-result.json'))).toBe(false);
    expect(outcome.reason).toMatch(/build\.result@v1|verification\.json/);
  });

  it('aborts Build close when build.brief is malformed', async () => {
    const { bytes } = closeCompiledFlow();
    const runFolder = join(runFolderBase, 'malformed-brief-close');

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: 'b1000000-0000-0000-0000-000000000003',
      goal: 'Reject malformed brief at close',
      depth: 'standard',
      now: deterministicNow(Date.UTC(2026, 3, 25, 1, 15, 0)),
      executors: seedThenDefaultWriter({ corruptBrief: true }),
    });

    expect(outcome.outcome).toBe('aborted');
    expect(existsSync(join(runFolder, 'reports/build-result.json'))).toBe(false);
    expect(outcome.reason).toMatch(/verification_command_candidates|scope/);
  });

  it('aborts Build close when build.plan is malformed', async () => {
    const { bytes } = closeCompiledFlow();
    const runFolder = join(runFolderBase, 'malformed-plan-close');

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: 'b1000000-0000-0000-0000-000000000004',
      goal: 'Reject malformed plan at close',
      depth: 'standard',
      now: deterministicNow(Date.UTC(2026, 3, 25, 1, 20, 0)),
      executors: seedThenDefaultWriter({ corruptPlan: true }),
    });

    expect(outcome.outcome).toBe('aborted');
    expect(existsSync(join(runFolder, 'reports/build-result.json'))).toBe(false);
    expect(outcome.reason).toMatch(/verification|approach|slices/);
  });

  it('aborts Build close when a required producer step is absent', async () => {
    const { bytes } = closeCompiledFlow({ omitProducerSchema: 'build.plan@v1' });
    const runFolder = join(runFolderBase, 'missing-plan-producer');

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: 'b1000000-0000-0000-0000-000000000005',
      goal: 'Reject missing Build producer',
      depth: 'standard',
      now: deterministicNow(Date.UTC(2026, 3, 25, 1, 25, 0)),
      executors: seedThenDefaultWriter(),
    });

    expect(outcome.outcome).toBe('aborted');
    expect(existsSync(join(runFolder, 'reports/build-result.json'))).toBe(false);
    expect(outcome.reason).toMatch(/build\.plan@v1|exactly one flow step/);
  });
});

describe('Build plan writer surfaces grounding from build.context@v1', () => {
  const brief = BuildBrief.parse({
    objective: 'Add a focused change',
    scope: 'Make the smallest safe change that satisfies the requested goal.',
    success_criteria: ['The requested behavior is implemented'],
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
      request_path: 'reports/checkpoints/frame-step-request.json',
      allowed_choices: ['continue'],
    },
  });

  function buildPlan(inputs: Record<string, unknown>) {
    const builder = findComposeBuilder('build.plan@v1');
    if (builder === undefined) throw new Error('build.plan@v1 compose builder is not registered');
    // The plan builder reads only its declared inputs (brief, context); the
    // runFolder/flow/step fields are unused for this writer, so a minimal
    // ComposeBuildContext is enough to exercise the surfacing logic in isolation.
    return BuildPlan.parse(
      builder.build({
        runFolder: '.',
        goal: brief.objective,
        inputs,
      } as unknown as ComposeBuildContext),
    );
  }

  it('copies anticipated_file_extensions from the grounding context onto the plan', () => {
    const context = BuildContext.parse({
      verdict: 'accept',
      sources: [{ kind: 'file', ref: 'src/example.ts', summary: 'Touched module.' }],
      observations: ['The target module is small and self-contained.'],
      open_questions: [],
      anticipated_file_extensions: ['.tsx', '.test.ts'],
    });
    const plan = buildPlan({ brief, context });
    // Surfaced from the context, not hardcoded: a writer that dropped the field
    // (e.g. always []) would fail here.
    expect(plan.anticipated_file_extensions).toEqual(['.tsx', '.test.ts']);
    expect(plan.approach).toContain('Grounded in a codebase read');
  });

  it('falls back to a brief-only plan with no anticipated extensions when context is absent', () => {
    const plan = buildPlan({ brief });
    expect(plan.anticipated_file_extensions).toEqual([]);
    expect(plan.approach).toContain('Make the smallest safe change inside scope');
    expect(plan.approach).not.toContain('Grounded in a codebase read');
  });

  it('carries the grounding context guardrails (non_goals + invariants) onto the plan', () => {
    const context = BuildContext.parse({
      verdict: 'accept',
      sources: [{ kind: 'file', ref: 'src/example.ts', summary: 'Touched module.' }],
      observations: ['The target module is small and self-contained.'],
      open_questions: [],
      guardrails: {
        non_goals: ['Do not change the public API'],
        invariants: ['Keep the cache write-through'],
      },
    });
    const plan = buildPlan({ brief, context });
    expect(plan.guardrails.non_goals).toEqual(['Do not change the public API']);
    expect(plan.guardrails.invariants).toEqual(['Keep the cache write-through']);
  });

  it('falls back to empty guardrails when context is absent', () => {
    const plan = buildPlan({ brief });
    expect(plan.guardrails).toEqual({ non_goals: [], invariants: [] });
  });
});
