import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  prototypeVariantVerificationWriter,
  prototypeVerificationWriter,
} from '../../src/flows/prototype/index.js';
import {
  PrototypeArtifact,
  PrototypePlan,
  PrototypeVariantAggregate,
  PrototypeVariantProviderEvidence,
  PrototypeVariantVerification,
  PrototypeVerification,
} from '../../src/flows/prototype/reports.js';
import type {
  VerificationBuildContext,
  VerificationCommandObservation,
} from '../../src/flows/registries/verification-writers/types.js';
import type { CompiledFlow } from '../../src/schemas/compiled-flow.js';

const roots: string[] = [];

function fixture(name: string): { readonly projectRoot: string; readonly runFolder: string } {
  const projectRoot = mkdtempSync(join(tmpdir(), `circuit-${name}-`));
  const runFolder = join(projectRoot, '.circuit', 'runs', 'run-1');
  mkdirSync(runFolder, { recursive: true });
  roots.push(projectRoot);
  return { projectRoot, runFolder };
}

function write(path: string, body: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    typeof body === 'string' || body instanceof Uint8Array
      ? body
      : `${JSON.stringify(body, null, 2)}\n`,
  );
}

function passedObservation(id: string): VerificationCommandObservation {
  return {
    command: {
      id,
      cwd: '.',
      argv: [process.execPath, '-e', 'process.exit(0)'],
      timeout_ms: 30_000,
      max_output_bytes: 20_000,
      env: {},
    },
    exit_code: 0,
    status: 'passed',
    duration_ms: 1,
    stdout_summary: 'ok',
    stderr_summary: '',
    timed_out: false,
  };
}

function context(input: {
  readonly projectRoot: string;
  readonly runFolder: string;
  readonly resultSchema: string;
  readonly reads: readonly { readonly schema: string; readonly path: string }[];
}): VerificationBuildContext {
  const flow = {
    steps: [
      ...input.reads.map((read, index) => ({
        id: `source-${index}`,
        kind: 'compose',
        writes: { report: read },
      })),
      {
        id: 'verify',
        kind: 'verification',
        writes: { report: { schema: input.resultSchema, path: 'reports/result.json' } },
      },
    ],
  } as unknown as CompiledFlow;
  return {
    projectRoot: input.projectRoot,
    runFolder: input.runFolder,
    flow,
    step: {
      id: 'verify',
      kind: 'verification',
      reads: input.reads.map((read) => read.path),
      writes: { report: { schema: input.resultSchema, path: 'reports/result.json' } },
    } as unknown as VerificationBuildContext['step'],
  };
}

const MODEL_JUDGMENTS = {
  evidence_rigor: 'pass',
  actionability: 'pass',
  coverage_adequacy: 'pass',
  scope_discipline: 'pass',
  honest_calibration: 'pass',
  project_specificity: 'pass',
  insight_density: 'pass',
  branch_distinctness: 'pass',
} as const;

function rubricResult() {
  const dims = Object.fromEntries(
    Object.keys(MODEL_JUDGMENTS).map((dimension) => [
      dimension,
      {
        runtime_signal: 'met',
        model_judgment: 'pass',
        final_score: 'pass',
        dim_score: 1,
        runtime_vetoed: false,
      },
    ]),
  );
  return {
    dims,
    aggregate_score: 1,
    runtime_veto_count: 0,
    tie_break: { ordered_dims: Object.keys(MODEL_JUDGMENTS), final_reason: 'All passed.' },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Prototype verification review asset identities', () => {
  it('keeps historical verification reports readable with an empty asset list', () => {
    const command = passedObservation('integrity');
    const historical = {
      overall_status: 'passed',
      commands: [
        {
          command_id: command.command.id,
          argv: command.command.argv,
          cwd: command.command.cwd,
          exit_code: command.exit_code,
          status: command.status,
          duration_ms: command.duration_ms,
          stdout_summary: command.stdout_summary,
          stderr_summary: command.stderr_summary,
        },
      ],
    };

    expect(PrototypeVerification.parse(historical).review_assets).toEqual([]);
    expect(
      PrototypeVariantVerification.parse({
        ...historical,
        required_captured_provider_evidence_count: 2,
        captured_provider_evidence_count: 2,
        admitted_variant_count: 2,
        variant_results: [
          {
            variant_id: 'variant-a',
            status: 'passed',
            entry_points: ['prototype/variants/variant-a/index.html'],
            created_files: ['prototype/variants/variant-a/index.html'],
            notes: [],
          },
        ],
      }).review_assets,
    ).toEqual([]);
  });

  it('adds a recursively computed group to the single-prototype verification report', () => {
    const input = fixture('prototype-review-assets');
    const root = 'prototype/card';
    const planPath = 'reports/prototype/plan.json';
    const artifactPath = 'reports/prototype/artifact.json';
    write(join(input.projectRoot, root, 'index.html'), '<main>Card</main>');
    write(join(input.projectRoot, root, 'styles.css'), 'main{color:red}');
    write(join(input.projectRoot, root, 'unreported.svg'), '<svg></svg>');
    write(join(input.projectRoot, root, 'app.js'), 'window.evil=true');
    write(
      join(input.runFolder, planPath),
      PrototypePlan.parse({
        objective: 'Review a card.',
        prototype_root: root,
        files_to_create: [`${root}/index.html`],
        entry_points: [`${root}/index.html`],
        interaction_path: `${root}/index.html`,
        preview_instructions: 'Open index.html.',
        verification: { commands: [] },
        build_followup_prompt: 'Build it later.',
        risks: ['Disposable only.'],
        claim_limits: ['not production', 'not deployed'],
      }),
    );
    write(
      join(input.runFolder, artifactPath),
      PrototypeArtifact.parse({
        verdict: 'accept',
        summary: 'Created the card.',
        prototype_root: root,
        created_files: [`${root}/index.html`],
        entry_points: [`${root}/index.html`],
        preview_instructions: 'Open index.html.',
        known_limitations: [],
        evidence: ['The file exists.'],
        claim_limits: ['not production', 'not deployed'],
      }),
    );

    const result = PrototypeVerification.parse(
      prototypeVerificationWriter.buildResult(
        [passedObservation('prototype-artifact-integrity')],
        context({
          ...input,
          resultSchema: 'prototype.verification@v1',
          reads: [
            { schema: 'prototype.plan@v1', path: planPath },
            { schema: 'prototype.artifact@v1', path: artifactPath },
          ],
        }),
      ),
    );

    expect(result.review_assets).toHaveLength(1);
    expect(result.review_assets[0]).toMatchObject({
      root,
      entry_points: [`${root}/index.html`],
    });
    expect(result.review_assets[0]?.files.map((file) => file.path)).toEqual([
      `${root}/index.html`,
      `${root}/styles.css`,
      `${root}/unreported.svg`,
    ]);
  });

  it('adds one recursively computed group for each admitted tournament variant', () => {
    const input = fixture('prototype-variant-review-assets');
    const prototypeRoot = 'prototype/tournament';
    const aggregatePath = 'reports/prototype/variant-aggregate.json';
    const evidencePath = 'reports/prototype/variant-provider-evidence.json';
    const variants = ['variant-a', 'variant-b'];
    const branches = variants.map((variantId) => {
      const root = `${prototypeRoot}/variants/${variantId}`;
      write(join(input.projectRoot, root, 'index.html'), `<main>${variantId}</main>`);
      write(join(input.projectRoot, root, 'theme.css'), `body{--variant:${variantId}}`);
      return {
        branch_id: variantId,
        child_run_id: `child-${variantId}`,
        child_outcome: 'complete',
        verdict: 'accept',
        admitted: true,
        result_path: `reports/${variantId}.json`,
        duration_ms: 1,
        result_body: {
          verdict: 'accept',
          variant_id: variantId,
          variant_label: variantId,
          summary: `Created ${variantId}.`,
          prototype_root: prototypeRoot,
          variant_root: root,
          created_files: [`${root}/index.html`],
          entry_points: [`${root}/index.html`],
          preview_instructions: 'Open index.html.',
          known_limitations: [],
          evidence: ['The file exists.'],
          rubric_model_judgments: MODEL_JUDGMENTS,
          claim_limits: ['not production', 'not deployed'],
        },
        rubric_result: rubricResult(),
      };
    });
    write(
      join(input.runFolder, aggregatePath),
      PrototypeVariantAggregate.parse({
        schema_version: 1,
        join_policy: 'aggregate-survivors',
        branch_count: 2,
        branches,
      }),
    );
    write(
      join(input.runFolder, evidencePath),
      PrototypeVariantProviderEvidence.parse({
        schema_version: 1,
        evidence_source: 'relay.started resolved_selection trace entries',
        required_captured_count: 2,
        captured_count: 2,
        variants: variants.map((variantId, index) => ({
          variant_id: variantId,
          label: variantId,
          relay_step_id: `relay-${variantId}`,
          status: 'captured',
          connector_name: 'claude-code',
          provider: 'anthropic',
          model: variantId,
          effort: 'low',
          trace_sequence: index,
          trace_entry_kind: 'relay.started',
          resolved_from: { source: 'role', role: 'implementer' },
        })),
        missing_evidence: [],
      }),
    );

    const result = PrototypeVariantVerification.parse(
      prototypeVariantVerificationWriter.buildResult(
        [passedObservation('prototype-variant-artifact-integrity')],
        context({
          ...input,
          resultSchema: 'prototype.variant-verification@v1',
          reads: [
            { schema: 'prototype.variant-aggregate@v1', path: aggregatePath },
            { schema: 'prototype.variant-provider-evidence@v1', path: evidencePath },
          ],
        }),
      ),
    );

    expect(result.review_assets.map((group) => group.root)).toEqual(
      variants.map((variantId) => `${prototypeRoot}/variants/${variantId}`),
    );
    expect(result.review_assets.map((group) => group.files.map((file) => file.path))).toEqual(
      variants.map((variantId) => [
        `${prototypeRoot}/variants/${variantId}/index.html`,
        `${prototypeRoot}/variants/${variantId}/theme.css`,
      ]),
    );
  });
});
