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
import { captureStreams, deterministicNow } from '../helpers/runtime-fixtures.js';

import { projectRunStatusFromRunFolder } from '../../src/app/run-status/run-folder-projector.js';
import { parseExecutionArgs, runResumeCommand } from '../../src/cli/run.js';
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
import { CheckpointReviewResponse } from '../../src/schemas/checkpoint-review-response.js';
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
      flows: {
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
  readonly reportVariantRelativePaths?: boolean;
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
        const report = {
          verdict: 'accept' as const,
          variant_id: variant.variant_id,
          variant_label: variant.label,
          summary: `${variant.label} created a local comparison prototype.`,
          prototype_root: '.circuit/runs/model-comparison/prototype-files',
          variant_root: variant.variant_root,
          created_files: input.reportVariantRelativePaths ? ['index.html'] : [indexFile],
          entry_points: input.reportVariantRelativePaths ? ['index.html'] : [indexFile],
          preview_instructions: `Open ${indexFile} locally.`,
          known_limitations: ['Fixture prototype does not claim provider execution.'],
          evidence: [`${indexFile} exists`],
          rubric_model_judgments: PASSING_RUBRIC_MODEL_JUDGMENTS,
          claim_limits: ['not production', 'not deployed'],
        };
        return {
          request_payload: relayInput.prompt,
          receipt_id: `prototype-${variant.variant_id}-stub`,
          result_body: JSON.stringify(
            input.reportVariantRelativePaths ? report : PrototypeVariantArtifact.parse(report),
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

  it("accepts a worker artifact whose created_files carry a stray leading '/' prefix", async () => {
    const { bytes } = loadFixture();
    const runFolder = join(projectRoot, '.circuit/runs/leading-slash');

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
        writeProjectFile(
          projectRoot,
          indexFile,
          '<!doctype html><main>leading-slash fixture</main>',
        );
        writeProjectFile(projectRoot, readmeFile, '# leading-slash fixture\n');
        // Mirrors a live tournament slip (run 515503b2, sonnet variant): the
        // worker reported an existing project-relative file as
        // '/.circuit/runs/.../index.html'. One stray leading slash on an
        // otherwise-valid relative path must normalize like './' does instead
        // of aborting the branch.
        const body = {
          ...artifactBody({ plan }),
          created_files: [`/${indexFile}`, readmeFile],
          entry_points: [`/${indexFile}`],
        };
        return {
          request_payload: relayInput.prompt,
          receipt_id: `prototype-act-leading-slash-stub-${actAttempts}`,
          result_body: JSON.stringify(body),
          duration_ms: 1,
          cli_version: '0.0.0-stub',
        };
      },
    };

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '94000000-0000-0000-0000-000000000008',
      goal: 'prototype: sketch a custom flow builder UI',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 4, 20, 8, 6, 0)),
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
    for (const reported of [...artifact.created_files, ...artifact.entry_points]) {
      expect(reported.startsWith('/')).toBe(false);
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
      checkpointResponse: CheckpointReviewResponse.parse({
        schema: 'checkpoint.review-response@v1',
        run_id: '94000000-0000-0000-0000-000000000002',
        step_id: 'prototype-checkpoint-step',
        attempt: waiting.checkpoint.attempt,
        request_sha256: waiting.checkpoint.requestSha256,
        selection: 'save-build-input',
        comments: [
          {
            scope: 'choice',
            choice_id: 'save-build-input',
            body: 'Preserve the compact navigation in the Build brief.',
          },
        ],
      }),
      now: deterministicNow(Date.UTC(2026, 4, 20, 8, 20, 0)),
    });

    expect(resumed.outcome).toBe('complete');
    const result = PrototypeResult.parse(readJson(runFolder, 'reports/prototype-result.json'));
    expect(result.outcome).toBe('build_input_saved');
    expect(result.mode).toBe('single-artifact');
    if (result.mode !== 'single-artifact') throw new Error('expected single-artifact result');
    expect(result.checkpoint_status).toBe('operator_selected');
    expect(result.checkpoint_selection).toBe('save-build-input');
    expect(result.checkpoint_comments).toEqual([
      {
        scope: 'choice',
        choice_id: 'save-build-input',
        body: 'Preserve the compact navigation in the Build brief.',
      },
    ]);
    expect(readJson(runFolder, 'reports/checkpoints/prototype-review-response.json')).toMatchObject(
      {
        comments: [{ choice_id: 'save-build-input' }],
      },
    );
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

    const reviewReportPath = join(runFolder, 'reports/prototype/variant-review.json');
    const originalReviewReport = readFileSync(reviewReportPath);
    const changedReviewReport = JSON.parse(originalReviewReport.toString('utf8')) as Record<
      string,
      unknown
    >;
    changedReviewReport.comparison_summary =
      'A changed recommendation must not appear under the old checkpoint identity.';
    writeFileSync(reviewReportPath, `${JSON.stringify(changedReviewReport, null, 2)}\n`);
    await expect(
      resumeCompiledFlow({
        runDir: runFolder,
        selection: 'variant-b',
        now: deterministicNow(Date.UTC(2026, 4, 20, 9, 18, 0)),
      }),
    ).rejects.toThrow(/review input .* changed/i);
    let openedChangedReview = false;
    const blocked = await captureStreams(() =>
      runResumeCommand(
        parseExecutionArgs('resume', ['--run-folder', runFolder, '--checkpoint-review']),
        {
          now: deterministicNow(Date.UTC(2026, 4, 20, 9, 19, 0)),
          openCheckpointReview: () => {
            openedChangedReview = true;
          },
        },
      ),
    );
    expect(blocked.result).toBe(2);
    expect(blocked.stderr).toContain('could not regenerate the trusted checkpoint review page');
    expect(openedChangedReview).toBe(false);
    writeFileSync(reviewReportPath, originalReviewReport);

    const reviewResponse = CheckpointReviewResponse.parse({
      schema: 'checkpoint.review-response@v1',
      run_id: '94000000-0000-0000-0000-000000000007',
      step_id: 'prototype-variant-checkpoint-step',
      attempt: waiting.checkpoint.attempt,
      request_sha256: waiting.checkpoint.requestSha256,
      selection: 'variant-b',
      comments: [
        {
          scope: 'choice',
          choice_id: 'variant-a',
          body: 'The opening is calm, but the comparison is too shallow.',
        },
        {
          scope: 'choice',
          choice_id: 'variant-b',
          body: 'Keep the clearer navigation and shorten the intro.',
        },
        {
          scope: 'overall',
          body: 'Carry the restrained visual language into Build.',
        },
      ],
    });
    const args = parseExecutionArgs('resume', ['--run-folder', runFolder, '--checkpoint-review']);
    let browserSubmission: Promise<Response> | undefined;

    const command = captureStreams(() =>
      runResumeCommand(args, {
        now: deterministicNow(Date.UTC(2026, 4, 20, 9, 20, 0)),
        openCheckpointReview: (url) => {
          browserSubmission = (async () => {
            const page = await fetch(url);
            const html = await page.text();
            const match = html.match(/window\.__CIRCUIT_REVIEW_SESSION__ = (.*?);<\/script>/);
            if (match?.[1] === undefined) throw new Error('missing review bootstrap');
            const session = JSON.parse(match[1]) as {
              readonly endpoint: string;
              readonly authorization: string;
            };
            const submit = () =>
              fetch(session.endpoint, {
                method: 'POST',
                headers: {
                  Origin: new URL(url).origin,
                  'Content-Type': 'application/json',
                  'X-Circuit-Review-Session': session.authorization,
                },
                body: JSON.stringify(reviewResponse),
              });
            const accepted = await submit();
            if (accepted.ok) await submit();
            return accepted;
          })();
        },
      }),
    );

    const { result: exitCode, stderr } = await command;
    const submitted = browserSubmission;
    if (submitted === undefined) throw new Error(`review browser was not opened: ${stderr}`);
    const submissionResponse = await submitted;

    expect(submissionResponse.status).toBe(200);
    expect(exitCode).toBe(0);
    expect(stderr).not.toContain('error:');
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
      checkpoint_comments: reviewResponse.comments,
    });
    expect(result.checkpoint_comments).toEqual(reviewResponse.comments);
  });

  it('rejects a trusted browser review when a bound artifact changes after the page opens', async () => {
    const bytes = readFileSync(TOURNAMENT_FIXTURE_PATH);
    const runFolder = join(projectRoot, '.circuit/runs/model-comparison');
    const runId = '94000000-0000-0000-0000-000000000017';

    const waiting = await runCompiledFlowWithWaiting({
      runDir: runFolder,
      flowBytes: bytes,
      runId,
      goal: 'prototype: reject a changed review artifact after opening the trusted page',
      entryModeName: 'tournament',
      axes: { depth: 'medium', tournament: true, tournament_n: 2, autonomous: false },
      now: deterministicNow(Date.UTC(2026, 4, 20, 9, 30, 0)),
      projectRoot,
      selectionConfigLayers: [variantLayer()],
      relayer: prototypeVariantRelayer({ runFolder, projectRoot }),
    });

    expect(waiting.outcome).toBe('checkpoint_waiting');
    if (!isGraphCheckpointWaitingResult(waiting)) throw new Error('expected checkpoint_waiting');

    const changedEntryPoint =
      '.circuit/runs/model-comparison/prototype-files/variants/variant-b/index.html';
    const verification = PrototypeVariantVerification.parse(
      readJson(runFolder, 'reports/prototype/variant-verification.json'),
    );
    expect(
      verification.review_assets.some(
        (group) =>
          group.entry_points.includes(changedEntryPoint) &&
          group.files.some((file) => file.path === changedEntryPoint),
      ),
    ).toBe(true);

    const response = CheckpointReviewResponse.parse({
      schema: 'checkpoint.review-response@v1',
      run_id: runId,
      step_id: 'prototype-variant-checkpoint-step',
      attempt: waiting.checkpoint.attempt,
      request_sha256: waiting.checkpoint.requestSha256,
      selection: 'variant-b',
      comments: [
        {
          scope: 'choice',
          choice_id: 'variant-b',
          body: 'Use the quieter second option.',
        },
      ],
    });
    const tracePath = join(runFolder, 'trace.ndjson');
    const traceBefore = readFileSync(tracePath);
    const canonicalResponsePath = join(
      runFolder,
      'reports/checkpoints/prototype-variant-choice-response.json',
    );
    const attemptResponsePath = join(
      runFolder,
      `reports/checkpoints/prototype-variant-choice-response.attempt-${waiting.checkpoint.attempt}.json`,
    );
    let browserSubmission: Promise<{ readonly status: number; readonly body: unknown }> | undefined;

    const command = captureStreams(() =>
      runResumeCommand(
        parseExecutionArgs('resume', ['--run-folder', runFolder, '--checkpoint-review']),
        {
          now: deterministicNow(Date.UTC(2026, 4, 20, 9, 31, 0)),
          openCheckpointReview: (url) => {
            browserSubmission = (async () => {
              const page = await fetch(url);
              expect(page.status).toBe(200);
              const html = await page.text();
              const match = html.match(/window\.__CIRCUIT_REVIEW_SESSION__ = (.*?);<\/script>/);
              if (match?.[1] === undefined) throw new Error('missing review bootstrap');
              const session = JSON.parse(match[1]) as {
                readonly endpoint: string;
                readonly authorization: string;
              };

              writeProjectFile(
                projectRoot,
                changedEntryPoint,
                '<!doctype html><title>Changed after open</title><main>Unreviewed bytes</main>',
              );

              const submitted = await fetch(session.endpoint, {
                method: 'POST',
                headers: {
                  Origin: new URL(url).origin,
                  'Content-Type': 'application/json',
                  'X-Circuit-Review-Session': session.authorization,
                },
                body: JSON.stringify(response),
              });
              return { status: submitted.status, body: (await submitted.json()) as unknown };
            })();
          },
        },
      ),
    );

    const { result: exitCode, stderr } = await command;
    const submitted = browserSubmission;
    if (submitted === undefined) throw new Error(`review browser was not opened: ${stderr}`);
    const submission = await submitted;

    expect(submission.status).toBe(409);
    expect(submission.body).toMatchObject({ ok: false, terminal: true });
    expect(exitCode).toBe(2);
    expect(stderr).toContain('did not record this checkpoint review');
    expect(readFileSync(tracePath)).toEqual(traceBefore);
    expect(existsSync(canonicalResponsePath)).toBe(false);
    expect(existsSync(attemptResponsePath)).toBe(false);
    expect(existsSync(join(runFolder, 'resume.lock'))).toBe(false);
    expect(existsSync(join(runFolder, 'resume.lock.reclaiming'))).toBe(false);
    expect(projectRunStatusFromRunFolder(runFolder)).toMatchObject({
      engine_state: 'waiting_checkpoint',
      checkpoint: {
        step_id: 'prototype-variant-checkpoint-step',
        attempt: waiting.checkpoint.attempt,
        request_sha256: waiting.checkpoint.requestSha256,
      },
    });
  });

  it('normalizes variant-relative worker paths before tournament verification', async () => {
    const bytes = readFileSync(TOURNAMENT_FIXTURE_PATH);
    const runFolder = join(projectRoot, '.circuit/runs/model-comparison');

    const waiting = await runCompiledFlowWithWaiting({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '94000000-0000-0000-0000-000000000009',
      goal: 'prototype: compare two custom flow builder UI variants',
      entryModeName: 'tournament',
      axes: { depth: 'medium', tournament: true, tournament_n: 2, autonomous: false },
      now: deterministicNow(Date.UTC(2026, 4, 20, 9, 30, 0)),
      projectRoot,
      selectionConfigLayers: [variantLayer()],
      relayer: prototypeVariantRelayer({
        runFolder,
        projectRoot,
        reportVariantRelativePaths: true,
      }),
    });

    expect(waiting.outcome).toBe('checkpoint_waiting');
    const aggregate = PrototypeVariantAggregate.parse(
      readJson(runFolder, 'reports/prototype/variant-aggregate.json'),
    );
    for (const branch of aggregate.branches) {
      const artifact = branch.result_body;
      expect(artifact).toBeDefined();
      if (artifact === undefined) continue;
      expect(artifact.created_files).toEqual([`${artifact.variant_root}/index.html`]);
      expect(artifact.entry_points).toEqual([`${artifact.variant_root}/index.html`]);
    }
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

  it("judges the implementer's delivered files, not the plan's guess: a CLI-shaped artifact passes integrity with the plan mismatch surfaced as advisory", async () => {
    // The F11 finding from the live surface test: the plan writer always guesses
    // an index.html/README.md shape, so a goal whose right deliverable is
    // something else (here a CLI script) failed artifact integrity on
    // "planned file missing from created_files" even though every DELIVERED file
    // was real, declared, and inside prototype_root. Integrity judges the final
    // declared work; the plan's anticipated file list is advisory, surfaced in
    // the command's stdout so the mismatch stays legible without failing the run.
    const { bytes } = loadFixture();
    const runFolder = join(projectRoot, '.circuit/runs/cli-shaped');

    const relayer: RelayFn = {
      connectorName: 'claude-code',
      relay: async (relayInput: RelayInput): Promise<RelayResult> => {
        const plan = PrototypePlan.parse(readJson(runFolder, 'reports/prototype/plan.json'));
        const cliFile = `${plan.prototype_root}/cli.mjs`;
        const usageFile = `${plan.prototype_root}/USAGE.md`;
        writeProjectFile(projectRoot, cliFile, 'console.log("circuit prototype cli");\n');
        writeProjectFile(projectRoot, usageFile, '# Usage\n\nnode cli.mjs\n');
        return {
          request_payload: relayInput.prompt,
          receipt_id: 'prototype-cli-stub',
          result_body: JSON.stringify(
            PrototypeArtifact.parse({
              verdict: 'accept',
              summary: 'Created a CLI prototype instead of an HTML sketch.',
              prototype_root: plan.prototype_root,
              created_files: [cliFile, usageFile],
              entry_points: [cliFile],
              preview_instructions: `Run node ${cliFile} locally.`,
              known_limitations: ['CLI prototype is not wired to production behavior.'],
              evidence: ['cli.mjs and USAGE.md were created under prototype_root.'],
              claim_limits: ['not production', 'not deployed'],
            }),
          ),
          duration_ms: 1,
          cli_version: '0.0.0-stub',
        };
      },
    };

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '94000000-0000-0000-0000-000000000007',
      goal: 'prototype: sketch a CLI that lists custom flows',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 4, 20, 9, 15, 0)),
      projectRoot,
      relayer,
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
    const verification = PrototypeVerification.parse(
      readJson(runFolder, 'reports/prototype/verification.json'),
    );
    expect(verification.overall_status).toBe('passed');
    // The plan/delivery mismatch is surfaced, not enforced.
    expect(verification.commands[0]?.stdout_summary).toContain('advisory');
    expect(verification.commands[0]?.stdout_summary).toContain('index.html');
  });

  it('accepts an integration spike: declared touchpoints outside prototype_root pass integrity and reach the result', async () => {
    // Modeled on the pdk-poc leads-pipeline spike: the goal requires splicing
    // into existing production files and writing a keeper learnings doc outside
    // prototype_root. Declared integration touchpoints make that expressible;
    // the flow must not fail for doing exactly what the goal asked.
    const { bytes } = loadFixture();
    const runFolder = join(projectRoot, '.circuit/runs/integration-spike');

    const featureFile = 'src/features/home/home.feature.tsx';
    const learningsFile = 'docs/migration/SPIKE_LEARNINGS.md';
    writeProjectFile(projectRoot, featureFile, 'export const Home = () => null;\n');

    const relayer: RelayFn = {
      connectorName: 'claude-code',
      relay: async (relayInput: RelayInput): Promise<RelayResult> => {
        expect(relayInput.prompt).toContain('integration_touchpoints');
        const plan = PrototypePlan.parse(readJson(runFolder, 'reports/prototype/plan.json'));
        const spikeFile = `${plan.prototype_root}/build-index.spike.ts`;
        writeProjectFile(projectRoot, spikeFile, 'export const buildIndex = () => [];\n');
        writeProjectFile(
          projectRoot,
          featureFile,
          'export const Home = () => null; // spike splice\n',
        );
        writeProjectFile(projectRoot, learningsFile, '# Spike learnings\n\nS1: works.\n');
        return {
          request_payload: relayInput.prompt,
          receipt_id: 'prototype-integration-spike-stub',
          result_body: JSON.stringify(
            PrototypeArtifact.parse({
              verdict: 'accept',
              summary: 'Spliced the spike into the Home feature and wrote the learnings doc.',
              prototype_root: plan.prototype_root,
              created_files: [spikeFile, learningsFile],
              entry_points: [spikeFile, featureFile],
              integration_touchpoints: [
                {
                  path: learningsFile,
                  change: 'created',
                  reason: 'The goal names this learnings doc as the keeper deliverable.',
                },
                {
                  path: featureFile,
                  change: 'modified',
                  reason: 'The goal requires rendering the spike on the Home screen.',
                },
              ],
              preview_instructions: 'Open the Home screen; the spike replaces the funnel module.',
              known_limitations: ['Spike code is disposable and must not be merged.'],
              evidence: ['Spike file, feature splice, and learnings doc exist.'],
              claim_limits: ['not production', 'not deployed'],
            }),
          ),
          duration_ms: 1,
          cli_version: '0.0.0-stub',
        };
      },
    };

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '94000000-0000-0000-0000-000000000008',
      goal: 'prototype: integration spike that splices a leads index into the Home screen',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 4, 20, 9, 30, 0)),
      projectRoot,
      relayer,
    });

    expect(outcome.outcome).toBe('complete');
    const result = PrototypeResult.parse(readJson(runFolder, 'reports/prototype-result.json'));
    expect(result).toMatchObject({
      outcome: 'kept',
      artifact_status: 'accepted',
      verification_status: 'passed',
    });
    // The touchpoints survive into the final result so the operator sees which
    // files outside the disposable root were touched and why.
    expect(result.integration_touchpoints.map((touchpoint) => touchpoint.path)).toEqual([
      learningsFile,
      featureFile,
    ]);
    const verification = PrototypeVerification.parse(
      readJson(runFolder, 'reports/prototype/verification.json'),
    );
    expect(verification.overall_status).toBe('passed');
    expect(verification.commands[0]?.stdout_summary).toContain('integration touchpoint');
  });

  it('closes evidence_invalid with the root-cause reason when the artifact report fails validation (pdk-poc bug 3)', async () => {
    // Modeled on pdk-poc run f7fe10d0: the worker finished real work, but its
    // report failed schema validation. The run must close with a distinct
    // outcome naming the ROOT CAUSE (the schema failure), not the downstream
    // close-step symptom, and the summary must list what the worker reported
    // creating so the operator can salvage instead of deleting real work.
    const { bytes } = loadFixture();
    const runFolder = join(projectRoot, '.circuit/runs/undeclared-touchpoint');

    const strayFile = 'docs/migration/UNDECLARED.md';
    const relayer: RelayFn = {
      connectorName: 'claude-code',
      relay: async (relayInput: RelayInput): Promise<RelayResult> => {
        const plan = PrototypePlan.parse(readJson(runFolder, 'reports/prototype/plan.json'));
        const spikeFile = `${plan.prototype_root}/index.html`;
        writeProjectFile(projectRoot, spikeFile, '<!doctype html>\n');
        writeProjectFile(projectRoot, strayFile, 'stray\n');
        // Bypass PrototypeArtifact.parse: this simulates a worker whose report
        // slips an undeclared out-of-root path past its own honesty. Schema
        // validation catches it first; this test pins the message operators see.
        return {
          request_payload: relayInput.prompt,
          receipt_id: 'prototype-undeclared-stub',
          result_body: JSON.stringify({
            verdict: 'accept',
            summary: 'Created files including an undeclared out-of-root path.',
            prototype_root: plan.prototype_root,
            created_files: [spikeFile, strayFile],
            entry_points: [spikeFile],
            preview_instructions: 'Open index.html locally.',
            known_limitations: [],
            evidence: ['Files were created.'],
            claim_limits: ['not production', 'not deployed'],
          }),
          duration_ms: 1,
          cli_version: '0.0.0-stub',
        };
      },
    };

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '94000000-0000-0000-0000-000000000009',
      goal: 'prototype: sketch a custom flow builder UI',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 4, 20, 9, 45, 0)),
      projectRoot,
      relayer,
    });

    // The run closes with the distinct completed-but-unproven outcome, not a
    // bare abort that reads as "nothing happened".
    expect(outcome.outcome).toBe('evidence_invalid');
    const resultJson = readJson(runFolder, 'reports/result.json') as {
      readonly outcome: string;
      readonly reason?: string;
      readonly summary: string;
    };
    expect(resultJson.outcome).toBe('evidence_invalid');
    // reason carries the root-cause check failure, not the close-step throw.
    expect(resultJson.reason).toContain('did not validate against schema');
    expect(resultJson.reason).not.toContain('close requires');
    // The salvage summary lists what the worker reported so the operator does
    // not delete real work.
    expect(resultJson.summary).toContain(strayFile);
    expect(resultJson.summary).toContain('index.html');
  });

  it("treats the plan's file list as advisory: an artifact that declares fewer files than planned still passes integrity", async () => {
    const { bytes } = loadFixture();
    const runFolder = join(projectRoot, '.circuit/runs/under-reported-artifact');

    // Both planned files exist on disk, but the artifact declares only the
    // first. The declared set is the integrity contract (every declared file
    // must be real and inside prototype_root); the plan's guess is not — the
    // unrealized planned file rides along as an advisory note.
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
      outcome: 'kept',
      artifact_status: 'accepted',
      verification_status: 'passed',
      checkpoint_status: 'auto_resolved',
      checkpoint_selection: 'keep-prototype',
    });
    const verification = PrototypeVerification.parse(
      readJson(runFolder, 'reports/prototype/verification.json'),
    );
    expect(verification.overall_status).toBe('passed');
    expect(verification.commands[0]?.stdout_summary).toContain('advisory');
    expect(verification.commands[0]?.stdout_summary).toContain('README.md');
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
