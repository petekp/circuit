import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow } from '../helpers/runtime-fixtures.js';

import {
  PrototypeArtifact,
  PrototypePlan,
  PrototypeResult,
  PrototypeVariantAggregate,
  PrototypeVariantArtifact,
  PrototypeVariantProviderEvidence,
  PrototypeVariantReview,
  PrototypeVariantVerification,
  PrototypeVerification,
} from '../../src/flows/prototype/reports.js';
import { resumeCompiledFlow } from '../../src/runtime/run/checkpoint-resume.js';
import {
  runCompiledFlow,
  runCompiledFlowWithWaiting,
} from '../../src/runtime/run/compiled-flow-runner.js';
import { isGraphCheckpointWaitingResult } from '../../src/runtime/run/graph-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import { CompiledFlow } from '../../src/schemas/compiled-flow.js';
import { LayeredConfig } from '../../src/schemas/config.js';
import type { RelayStartedTraceEntry } from '../../src/schemas/trace-entry.js';
import type { RelayResult } from '../../src/shared/connector-relay.js';
import type { RelayFn, RelayInput } from '../../src/shared/relay-runtime-types.js';

const FIXTURE_PATH = resolve('generated/flows/prototype/circuit.json');
const TOURNAMENT_FIXTURE_PATH = resolve('generated/flows/prototype/tournament.json');

function loadFixture(): { flow: CompiledFlow; bytes: Buffer } {
  const bytes = readFileSync(FIXTURE_PATH);
  const raw: unknown = JSON.parse(bytes.toString('utf8'));
  return { flow: CompiledFlow.parse(raw), bytes };
}

function readJson(runFolder: string, relPath: string): unknown {
  return JSON.parse(readFileSync(join(runFolder, relPath), 'utf8'));
}

function writeProjectFile(projectRoot: string, relPath: string, body: string): void {
  const abs = join(projectRoot, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}

function artifactBody(input: {
  readonly plan: PrototypePlan;
  readonly verdict?: 'accept' | 'blocked';
  readonly createdFiles?: readonly string[];
}): PrototypeArtifact {
  return PrototypeArtifact.parse({
    verdict: input.verdict ?? 'accept',
    summary:
      input.verdict === 'blocked'
        ? 'Could not create a useful prototype artifact.'
        : 'Created a local prototype for the requested UI.',
    prototype_root: input.plan.prototype_root,
    created_files:
      input.verdict === 'blocked'
        ? []
        : (input.createdFiles ?? [input.plan.files_to_create[0], input.plan.files_to_create[1]]),
    entry_points: input.verdict === 'blocked' ? [] : input.plan.entry_points,
    preview_instructions: input.plan.preview_instructions,
    known_limitations: ['Prototype is not wired to live Circuit flow-saving behavior.'],
    evidence:
      input.verdict === 'blocked'
        ? ['No prototype file was created.']
        : ['index.html and README.md were created under prototype_root.'],
    claim_limits: ['not production', 'not deployed'],
  });
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

function prototypeRelayer(input: {
  readonly runFolder: string;
  readonly projectRoot: string;
  readonly createFiles?: boolean;
  readonly reportOnlyFirstFile?: boolean;
  readonly verdict?: 'accept' | 'blocked';
}): RelayFn {
  return {
    connectorName: 'claude-code',
    relay: async (relayInput: RelayInput): Promise<RelayResult> => {
      expect(relayInput.prompt).toContain('Step: act-step');
      expect(relayInput.prompt).toContain('prototype.artifact@v1');
      expect(relayInput.prompt).toContain('not production');
      expect(relayInput.prompt).toContain('not deployed');

      const plan = PrototypePlan.parse(readJson(input.runFolder, 'reports/prototype/plan.json'));
      const indexFile = plan.files_to_create[0];
      const readmeFile = plan.files_to_create[1];
      if (indexFile === undefined || readmeFile === undefined) {
        throw new Error('prototype plan did not include index.html and README.md files');
      }
      if (input.createFiles !== false && input.verdict !== 'blocked') {
        writeProjectFile(
          input.projectRoot,
          indexFile,
          '<!doctype html><title>Circuit Prototype</title><main>Custom flow builder</main>',
        );
        writeProjectFile(
          input.projectRoot,
          readmeFile,
          '# Circuit Prototype\n\nLocal disposable prototype evidence.\n',
        );
      }
      return {
        request_payload: relayInput.prompt,
        receipt_id: 'prototype-act-stub',
        result_body: JSON.stringify(
          artifactBody({
            plan,
            ...(input.verdict === undefined ? {} : { verdict: input.verdict }),
            ...(input.reportOnlyFirstFile ? { createdFiles: [indexFile] } : {}),
          }),
        ),
        duration_ms: 1,
        cli_version: '0.0.0-stub',
      };
    },
  };
}

function variantLayer() {
  return LayeredConfig.parse({
    layer: 'project',
    config: {
      schema_version: 1,
      circuits: {
        prototype: {
          variant_models: [
            {
              id: 'variant-a',
              label: 'Variant A',
              selection: {
                model: { provider: 'anthropic', model: 'local-fixture-a' },
                effort: 'medium',
              },
            },
            {
              id: 'variant-b',
              label: 'Variant B',
              selection: {
                model: { provider: 'anthropic', model: 'local-fixture-b' },
                effort: 'high',
              },
            },
          ],
        },
      },
    },
  });
}

function prototypeVariantRelayer(input: {
  readonly runFolder: string;
  readonly projectRoot: string;
}): RelayFn {
  return {
    connectorName: 'claude-code',
    relay: async (relayInput: RelayInput): Promise<RelayResult> => {
      // The default-on power dial gives every relay a materialized model, so a
      // variant relay is identified by matching a configured variant model —
      // mere model presence no longer distinguishes it from the review relay.
      const modelName = relayInput.resolvedSelection?.model?.model;
      const isVariantModel = modelName?.startsWith('local-fixture') === true;
      if (isVariantModel) {
        const options = readJson(input.runFolder, 'reports/prototype/variant-options.json') as {
          readonly variants: ReadonlyArray<{
            readonly variant_id: string;
            readonly label: string;
            readonly model: string;
            readonly variant_root: string;
          }>;
        };
        const variant = options.variants.find((candidate) => candidate.model === modelName);
        if (variant === undefined) throw new Error('fixture variant was not configured');
        const indexFile = `${variant.variant_root}/index.html`;
        writeProjectFile(
          input.projectRoot,
          indexFile,
          `<!doctype html><title>${variant.label}</title><main>${variant.variant_id}</main>`,
        );
        return {
          request_payload: relayInput.prompt,
          receipt_id: `prototype-${variant.variant_id}-stub`,
          result_body: JSON.stringify(
            PrototypeVariantArtifact.parse({
              verdict: 'accept',
              variant_id: variant.variant_id,
              variant_label: variant.label,
              summary: `${variant.label} created a local comparison prototype.`,
              prototype_root: '.circuit/runs/model-comparison/prototype-files',
              variant_root: variant.variant_root,
              created_files: [indexFile],
              entry_points: [indexFile],
              preview_instructions: `Open ${indexFile} locally.`,
              known_limitations: ['Fixture prototype does not claim provider execution.'],
              evidence: [`${indexFile} exists`],
              rubric_model_judgments: PASSING_RUBRIC_MODEL_JUDGMENTS,
              claim_limits: ['not production', 'not deployed'],
            }),
          ),
          duration_ms: 1,
          cli_version: '0.0.0-fixture',
        };
      }

      const aggregate = PrototypeVariantAggregate.parse(
        readJson(input.runFolder, 'reports/prototype/variant-aggregate.json'),
      );
      expect(aggregate.branches).toHaveLength(2);
      return {
        request_payload: relayInput.prompt,
        receipt_id: 'prototype-variant-review-stub',
        result_body: JSON.stringify(
          PrototypeVariantReview.parse({
            verdict: 'recommend',
            recommended_variant_id: 'variant-a',
            comparison_summary: 'Variant A is clearer; Variant B is denser.',
            strengths: [
              { variant_id: 'variant-a', note: 'Clearer first screen.' },
              { variant_id: 'variant-b', note: 'Denser information layout.' },
            ],
            risks: ['Fixture review compares local artifacts only.'],
            missing_evidence: [],
            confidence: 'medium',
          }),
        ),
        duration_ms: 1,
        cli_version: '0.0.0-fixture',
      };
    },
  };
}

async function readTraceEntries(runFolder: string) {
  return await new TraceStore(runFolder).load();
}

function traceLabels(traceEntries: readonly { kind: string; step_id?: unknown }[]): string[] {
  return traceEntries.map((entry) =>
    typeof entry.step_id === 'string' ? `${entry.kind}:${entry.step_id}` : entry.kind,
  );
}

let tempRoot: string;
let projectRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'circuit-prototype-runtime-'));
  projectRoot = join(tempRoot, 'project');
  mkdirSync(projectRoot, { recursive: true });
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('Prototype runtime wiring', () => {
  it('runs the generated Prototype fixture through standard safe default and closes kept', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(projectRoot, '.circuit/runs/standard');

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '94000000-0000-0000-0000-000000000001',
      goal: 'prototype: sketch a custom flow builder UI',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 4, 20, 8, 0, 0)),
      projectRoot,
      relayer: prototypeRelayer({ runFolder, projectRoot }),
    });

    expect(outcome.outcome).toBe('complete');
    const result = PrototypeResult.parse(readJson(runFolder, 'reports/prototype-result.json'));
    expect(result).toMatchObject({
      outcome: 'kept',
      artifact_status: 'accepted',
      verification_status: 'passed',
      checkpoint_status: 'auto_resolved',
      checkpoint_selection: 'keep-prototype',
    });
    const entryPoint = result.entry_points[0];
    if (entryPoint === undefined) throw new Error('prototype result did not include entry point');
    expect(existsSync(join(projectRoot, entryPoint))).toBe(true);
    expect(result.prototype_root).toBe('.circuit/runs/standard/prototype-files');

    const verification = PrototypeVerification.parse(
      readJson(runFolder, 'reports/prototype/verification.json'),
    );
    expect(verification.commands[0]?.command_id).toBe('prototype-artifact-integrity');
    expect(verification.overall_status).toBe('passed');

    const trace = await readTraceEntries(runFolder);
    expect(traceLabels(trace)).toContain('checkpoint.resolved:prototype-checkpoint-step');
    expect(
      trace.find(
        (entry) =>
          entry.kind === 'checkpoint.resolved' && entry.step_id === 'prototype-checkpoint-step',
      ),
    ).toMatchObject({ selection: 'keep-prototype', resolution_source: 'declared-default' });
  });

  it("accepts a worker artifact whose created_files carry a leading './' prefix", async () => {
    const { bytes } = loadFixture();
    const runFolder = join(projectRoot, '.circuit/runs/dot-slash');

    let actAttempts = 0;
    const relayer: RelayFn = {
      connectorName: 'claude-code',
      relay: async (relayInput: RelayInput): Promise<RelayResult> => {
        actAttempts += 1;
        const plan = PrototypePlan.parse(readJson(runFolder, 'reports/prototype/plan.json'));
        const indexFile = plan.files_to_create[0];
        const readmeFile = plan.files_to_create[1];
        if (indexFile === undefined || readmeFile === undefined) {
          throw new Error('prototype plan did not include index.html and README.md files');
        }
        writeProjectFile(projectRoot, indexFile, '<!doctype html><main>dot-slash fixture</main>');
        writeProjectFile(projectRoot, readmeFile, '# dot-slash fixture\n');
        // Mirrors a real worker slip seen in release verification: one
        // created_files entry carries a './' prefix. The schema must
        // normalize it instead of failing validation and aborting the run.
        const body = {
          ...artifactBody({ plan }),
          created_files: [`./${indexFile}`, readmeFile],
        };
        return {
          request_payload: relayInput.prompt,
          receipt_id: `prototype-act-dot-slash-stub-${actAttempts}`,
          result_body: JSON.stringify(body),
          duration_ms: 1,
          cli_version: '0.0.0-stub',
        };
      },
    };

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '94000000-0000-0000-0000-000000000007',
      goal: 'prototype: sketch a custom flow builder UI',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 4, 20, 8, 5, 0)),
      projectRoot,
      relayer,
    });

    expect(outcome.outcome).toBe('complete');
    expect(actAttempts).toBe(1);
    const result = PrototypeResult.parse(readJson(runFolder, 'reports/prototype-result.json'));
    expect(result.outcome).toBe('kept');

    const artifact = PrototypeArtifact.parse(
      readJson(runFolder, 'reports/prototype/artifact.json'),
    );
    for (const created of artifact.created_files) {
      expect(created.startsWith('./')).toBe(false);
    }
  });

  it('pauses in deep mode and resumes with save-build-input', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(projectRoot, '.circuit/runs/deep');

    const waiting = await runCompiledFlowWithWaiting({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '94000000-0000-0000-0000-000000000002',
      goal: 'prototype: sketch a custom flow builder UI',
      depth: 'high',
      now: deterministicNow(Date.UTC(2026, 4, 20, 8, 10, 0)),
      projectRoot,
      relayer: prototypeRelayer({ runFolder, projectRoot }),
    });

    expect(waiting.outcome).toBe('checkpoint_waiting');
    if (!isGraphCheckpointWaitingResult(waiting)) throw new Error('expected checkpoint_waiting');
    expect(waiting.checkpoint).toMatchObject({
      stepId: 'prototype-checkpoint-step',
      allowedChoices: ['keep-prototype', 'save-build-input', 'discard-prototype'],
    });
    expect(existsSync(join(runFolder, 'reports/checkpoints/prototype-review-response.json'))).toBe(
      false,
    );

    const resumed = await resumeCompiledFlow({
      runDir: runFolder,
      selection: 'save-build-input',
      now: deterministicNow(Date.UTC(2026, 4, 20, 8, 20, 0)),
    });

    expect(resumed.outcome).toBe('complete');
    const result = PrototypeResult.parse(readJson(runFolder, 'reports/prototype-result.json'));
    expect(result.outcome).toBe('build_input_saved');
    expect(result.mode).toBe('single-artifact');
    if (result.mode !== 'single-artifact') throw new Error('expected single-artifact result');
    expect(result.checkpoint_status).toBe('operator_selected');
    expect(result.checkpoint_selection).toBe('save-build-input');
    expect(result.build_followup_prompt).toMatch(/Build from the Prototype artifact/);
  });

  it('runs model-comparison tournament variants, captures relay selection evidence, and resumes with a selected variant', async () => {
    const bytes = readFileSync(TOURNAMENT_FIXTURE_PATH);
    const raw: unknown = JSON.parse(bytes.toString('utf8'));
    CompiledFlow.parse(raw);
    const runFolder = join(projectRoot, '.circuit/runs/model-comparison');

    const waiting = await runCompiledFlowWithWaiting({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '94000000-0000-0000-0000-000000000007',
      goal: 'prototype: compare two custom flow builder UI variants',
      entryModeName: 'tournament',
      axes: { depth: 'medium', tournament: true, tournament_n: 2, autonomous: false },
      now: deterministicNow(Date.UTC(2026, 4, 20, 9, 10, 0)),
      projectRoot,
      selectionConfigLayers: [variantLayer()],
      relayer: prototypeVariantRelayer({ runFolder, projectRoot }),
    });

    expect(waiting.outcome).toBe('checkpoint_waiting');
    if (!isGraphCheckpointWaitingResult(waiting)) throw new Error('expected checkpoint_waiting');
    expect(waiting.checkpoint).toMatchObject({
      stepId: 'prototype-variant-checkpoint-step',
      allowedChoices: ['variant-a', 'variant-b'],
    });

    const providerEvidence = PrototypeVariantProviderEvidence.parse(
      readJson(runFolder, 'reports/prototype/variant-provider-evidence.json'),
    );
    expect(providerEvidence).toMatchObject({
      captured_count: 2,
      variants: [
        {
          variant_id: 'variant-a',
          status: 'captured',
          provider: 'anthropic',
          model: 'local-fixture-a',
          effort: 'medium',
        },
        {
          variant_id: 'variant-b',
          status: 'captured',
          provider: 'anthropic',
          model: 'local-fixture-b',
          effort: 'high',
        },
      ],
    });
    const variantVerification = PrototypeVariantVerification.parse(
      readJson(runFolder, 'reports/prototype/variant-verification.json'),
    );
    expect(variantVerification).toMatchObject({
      overall_status: 'passed',
      admitted_variant_count: 2,
      captured_provider_evidence_count: 2,
    });
    expect(
      existsSync(
        join(
          projectRoot,
          '.circuit/runs/model-comparison/prototype-files/variants/variant-a/index.html',
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(
          projectRoot,
          '.circuit/runs/model-comparison/prototype-files/variants/variant-b/index.html',
        ),
      ),
    ).toBe(true);

    const trace = await readTraceEntries(runFolder);
    const started = trace.filter(
      (entry): entry is RelayStartedTraceEntry =>
        entry.kind === 'relay.started' && String(entry.step_id).startsWith('variant-fanout-step-'),
    );
    expect(started.map((entry) => entry.resolved_selection.model?.model).sort()).toEqual([
      'local-fixture-a',
      'local-fixture-b',
    ]);

    const resumed = await resumeCompiledFlow({
      runDir: runFolder,
      selection: 'variant-b',
      now: deterministicNow(Date.UTC(2026, 4, 20, 9, 20, 0)),
    });

    expect(resumed.outcome).toBe('complete');
    const result = PrototypeResult.parse(readJson(runFolder, 'reports/prototype-result.json'));
    expect(result).toMatchObject({
      mode: 'model-comparison',
      outcome: 'kept',
      checkpoint_status: 'operator_selected',
      checkpoint_selection: 'variant-b',
      selected_variant_id: 'variant-b',
      selected_variant_label: 'Variant B',
      selected_variant_root: '.circuit/runs/model-comparison/prototype-files/variants/variant-b',
      verification_status: 'passed',
      captured_provider_evidence_count: 2,
      model_evidence_status: 'captured',
    });
  });

  it('closes needs_attention when artifact integrity verification fails before checkpoint', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(projectRoot, '.circuit/runs/missing-artifact');

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '94000000-0000-0000-0000-000000000003',
      goal: 'prototype: sketch a custom flow builder UI',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 4, 20, 8, 30, 0)),
      projectRoot,
      relayer: prototypeRelayer({ runFolder, projectRoot, createFiles: false }),
    });

    expect(outcome.outcome).toBe('complete');
    const result = PrototypeResult.parse(readJson(runFolder, 'reports/prototype-result.json'));
    expect(result).toMatchObject({
      outcome: 'needs_attention',
      artifact_status: 'accepted',
      verification_status: 'failed',
      checkpoint_status: 'not_reached',
      checkpoint_selection: 'not_reached',
    });
    expect(existsSync(join(runFolder, 'reports/checkpoints/prototype-review-request.json'))).toBe(
      false,
    );
    const verification = PrototypeVerification.parse(
      readJson(runFolder, 'reports/prototype/verification.json'),
    );
    expect(verification.overall_status).toBe('failed');
    expect(verification.commands[0]?.stderr_summary).toContain('prototype path does not exist');
  });

  it('fails verification when a planned file is omitted from the artifact report', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(projectRoot, '.circuit/runs/under-reported-artifact');

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '94000000-0000-0000-0000-000000000006',
      goal: 'prototype: sketch a custom flow builder UI',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 4, 20, 9, 0, 0)),
      projectRoot,
      relayer: prototypeRelayer({ runFolder, projectRoot, reportOnlyFirstFile: true }),
    });

    expect(outcome.outcome).toBe('complete');
    const result = PrototypeResult.parse(readJson(runFolder, 'reports/prototype-result.json'));
    expect(result).toMatchObject({
      outcome: 'needs_attention',
      artifact_status: 'accepted',
      verification_status: 'failed',
      checkpoint_status: 'not_reached',
      checkpoint_selection: 'not_reached',
    });
    const verification = PrototypeVerification.parse(
      readJson(runFolder, 'reports/prototype/verification.json'),
    );
    expect(verification.overall_status).toBe('failed');
    expect(verification.commands[0]?.stderr_summary).toContain(
      'planned file missing from created_files',
    );
  });

  it('writes a blocked artifact report and closes without inventing verification', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(projectRoot, '.circuit/runs/blocked');

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '94000000-0000-0000-0000-000000000004',
      goal: 'prototype: sketch a custom flow builder UI',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 4, 20, 8, 40, 0)),
      projectRoot,
      relayer: prototypeRelayer({ runFolder, projectRoot, verdict: 'blocked' }),
    });

    expect(outcome.outcome).toBe('complete');
    const artifact = PrototypeArtifact.parse(
      readJson(runFolder, 'reports/prototype/artifact.json'),
    );
    expect(artifact.verdict).toBe('blocked');
    const result = PrototypeResult.parse(readJson(runFolder, 'reports/prototype-result.json'));
    expect(result).toMatchObject({
      outcome: 'needs_attention',
      artifact_status: 'blocked',
      verification_status: 'blocked',
      checkpoint_status: 'not_reached',
      checkpoint_selection: 'not_reached',
    });
    expect(existsSync(join(runFolder, 'reports/prototype/verification.json'))).toBe(false);
  });

  it('keeps the happy-path artifact contained to prototype_root', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(projectRoot, '.circuit/runs/containment');

    await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '94000000-0000-0000-0000-000000000005',
      goal: 'prototype: sketch a custom flow builder UI',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 4, 20, 8, 50, 0)),
      projectRoot,
      relayer: prototypeRelayer({ runFolder, projectRoot }),
    });

    const result = PrototypeResult.parse(readJson(runFolder, 'reports/prototype-result.json'));
    const rootAbs = join(projectRoot, result.prototype_root);
    expect(readdirSync(rootAbs).sort()).toEqual(['README.md', 'index.html']);
    expect(existsSync(join(projectRoot, 'index.html'))).toBe(false);
    expect(existsSync(join(projectRoot, 'plugins'))).toBe(false);
  });
});
