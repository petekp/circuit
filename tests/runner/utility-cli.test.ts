import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../../src/cli/circuit.js';
import {
  codexInstallAssurance,
  missingDefaultLauncherMessage,
  resolveDefaultLauncher,
} from '../../src/cli/handoff-codex-hooks.js';
import { CUSTOM_FLOW_ROOT_RUNTIME_POLICY } from '../../src/cli/runtime-routing-policy.js';
import { assembleFlowSchematic } from '../../src/flows/assemble-flow-schematic.js';
import { buildAssemblySpec } from '../../src/flows/build/assembly-spec.js';
import { compileSchematicToCompiledFlow } from '../../src/flows/compile-schematic-to-flow.js';
import { applyStructure, resolveStructure } from '../../src/flows/resolvers/structure.js';
import {
  CompiledFlow,
  CompiledFlowId,
  ContinuityIndex,
  ContinuityRecord,
  RunId,
} from '../../src/index.js';
import { writeManifestSnapshot } from '../../src/shared/manifest-snapshot.js';
import type { RelayFn } from '../../src/shared/relay-runtime-types.js';
import { captureStreams, makeStubRelayer } from '../helpers/runtime-fixtures.js';

const tempRoots: string[] = [];
const BUILD_IMPLEMENTATION_BODY = JSON.stringify({
  verdict: 'accept',
  summary: 'Implemented the custom flow task',
  changed_files: ['src/custom-flow-output.ts'],
  evidence: ['Stub implementation relay completed'],
});
const BUILD_REVIEW_BODY = JSON.stringify({
  verdict: 'accept',
  summary: 'No blocking issue found',
  findings: [],
  alignment: { scope_adherence: 'within_scope', non_goals: [], invariants: [] },
});
const BUILD_CONTEXT_BODY = JSON.stringify({
  verdict: 'accept',
  sources: [
    { kind: 'file', ref: 'src/custom-flow-output.ts', summary: 'Module the change touches.' },
  ],
  observations: ['The target module is small and self-contained.'],
  open_questions: [],
  anticipated_file_extensions: ['.ts'],
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function captureMain(
  argv: readonly string[],
  options: Parameters<typeof main>[1] = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { result, stdout, stderr } = await captureStreams(() => main(argv, options));
  return { code: result, stdout, stderr };
}

function writeInvalidRunFolder(runFolder: string, runId: string): void {
  mkdirSync(runFolder, { recursive: true });
  const flowBytes = readFileSync(resolve('generated/flows/build/circuit.json'));
  const snapshot = writeManifestSnapshot(runFolder, {
    run_id: RunId.parse(runId),
    flow_id: CompiledFlowId.parse('build'),
    captured_at: '2026-04-29T23:25:00.000Z',
    bytes: flowBytes,
  });
  writeFileSync(
    join(runFolder, 'trace.ndjson'),
    `${JSON.stringify({
      schema_version: 1,
      kind: 'run.bootstrapped',
      run_id: runId,
      flow_id: 'build',
      depth: 'high',
      manifest_hash: snapshot.hash,
    })}\n`,
  );
}

function writeTraceOnlyInvalidRunFolder(runFolder: string, runId: string): void {
  mkdirSync(runFolder, { recursive: true });
  writeFileSync(
    join(runFolder, 'trace.ndjson'),
    `${JSON.stringify({
      schema_version: 1,
      kind: 'run.bootstrapped',
      run_id: runId,
      flow_id: 'build',
      depth: 'high',
      manifest_hash: 'invalid-manifest-hash',
    })}\n`,
  );
}

function writeStartedTraceOnlyInvalidRunFolder(runFolder: string): void {
  mkdirSync(runFolder, { recursive: true });
  writeFileSync(
    join(runFolder, 'trace.ndjson'),
    `${JSON.stringify({
      schema_version: 1,
      kind: 'run.started',
      flow_id: 'build',
    })}\n`,
  );
}

function relayerWithBuildBodies(): RelayFn {
  return makeStubRelayer(
    (input) => {
      if (input.prompt.includes('Step: analyze-step')) return BUILD_CONTEXT_BODY;
      return input.prompt.includes('Step: review-step')
        ? BUILD_REVIEW_BODY
        : BUILD_IMPLEMENTATION_BODY;
    },
    { receipt_id: 'stub-custom-flow-runtime' },
  );
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('utility CLI commands', () => {
  it('creates, validates, and publishes a custom flow package', async () => {
    const home = tempRoot('circuit-create-');
    // B2: this test also RUNS the published flow end-to-end. Running build's
    // close-with-evidence writer requires the full review + touch-area evidence
    // set, which only the decomposed (full-spine) grain produces — so create
    // with --decompose. The thin-conservative whole-grain choice (and that it is
    // a valid published package) is covered by tests/runner/structure-chooser.test.ts.
    const result = await captureMain(
      [
        'create',
        '--name',
        'release-note-flow',
        '--description',
        'Draft release notes from a change summary',
        '--home',
        home,
        '--publish',
        '--yes',
        '--decompose',
        '--created-at',
        '2026-04-29T23:00:00.000Z',
      ],
      { now: () => new Date('2026-04-29T23:00:00.000Z') },
    );

    expect(result.code, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as {
      status: string;
      slug: string;
      flow_path: string;
      manifest_path: string;
      operator_summary_markdown_path: string;
    };
    expect(output).toMatchObject({ status: 'published', slug: 'release-note-flow' });
    expect(existsSync(output.operator_summary_markdown_path)).toBe(true);
    const summary = readFileSync(output.operator_summary_markdown_path, 'utf8');
    expect(summary).toContain(CUSTOM_FLOW_ROOT_RUNTIME_POLICY);
    expect(summary).toContain('circuit run release-note-flow');
    expect(existsSync(join(home, 'skills/release-note-flow/SKILL.md'))).toBe(true);
    expect(existsSync(join(home, 'skills/release-note-flow/circuit.yaml'))).toBe(true);
    expect(existsSync(join(home, 'commands/release-note-flow.md'))).toBe(true);
    expect(readFileSync(join(home, 'skills/release-note-flow/SKILL.md'), 'utf8')).toContain(
      'circuit run release-note-flow',
    );
    expect(readFileSync(join(home, 'commands/release-note-flow.md'), 'utf8')).toContain(
      'circuit run release-note-flow',
    );
    expect(CompiledFlow.parse(JSON.parse(readFileSync(output.flow_path, 'utf8'))).id).toBe(
      'release-note-flow',
    );
    const manifest = JSON.parse(readFileSync(output.manifest_path, 'utf8')) as {
      custom_flows: Array<{ id: string; archetype?: unknown }>;
    };
    expect(manifest.custom_flows.map((flow) => flow.id)).toEqual(['release-note-flow']);
    // M9-C: custom flows no longer carry an archetype. The manifest entry
    // records identity, not "this is a build clone".
    expect(manifest.custom_flows.every((flow) => flow.archetype === undefined)).toBe(true);

    // The published flow is produced through the sanctioned assemble->compile
    // path build's own data.ts uses — not a clone of build's compiled bytes off
    // disk. B2: the structure chooser now picks the grain. This task was created
    // with --decompose, so it materializes the DECOMPOSED (full-spine) grain,
    // which is byte-identical to the former full-spine clone (modulo id/purpose).
    // Prove the published bytes ARE the assembler's output for this slug at that grain.
    const publishedFlow = CompiledFlow.parse(JSON.parse(readFileSync(output.flow_path, 'utf8')));
    const grained = applyStructure(
      {
        ...buildAssemblySpec,
        id: 'release-note-flow',
        purpose: 'Draft release notes from a change summary',
      },
      resolveStructure({
        summary: 'Draft release notes from a change summary',
        surface_area: 'small',
        risk: 'low',
        explicit_decompose: true,
      }),
    );
    const assembled = compileSchematicToCompiledFlow(
      assembleFlowSchematic({ ...grained, id: 'release-note-flow' }),
    );
    if (assembled.kind !== 'single') throw new Error(assembled.kind);
    expect(publishedFlow).toEqual(CompiledFlow.parse(assembled.flow));
    // The decomposed grain is build's full spine, step-for-step.
    expect(publishedFlow.steps.length).toBe(buildAssemblySpec.items.length);

    const projectRoot = tempRoot('circuit-create-run-project-');
    writeFileSync(
      join(projectRoot, 'package.json'),
      `${JSON.stringify({ scripts: { check: 'node -e "process.exit(0)"' } }, null, 2)}\n`,
    );
    const runFolder = join(home, 'runs', 'release-note-flow-runtime');
    const run = await captureMain(
      [
        'run',
        'release-note-flow',
        '--flow-root',
        join(home, 'flows'),
        '--goal',
        'Draft release notes from a test change',
        '--progress',
        'jsonl',
        '--run-folder',
        runFolder,
      ],
      { configCwd: projectRoot, relayer: relayerWithBuildBodies() },
    );

    expect(run.code, run.stderr).toBe(0);
    const runOutput = JSON.parse(run.stdout) as {
      flow_id: string;
      selected_flow: string;
      outcome: string;
      runtime_reason?: string;
    };
    expect(runOutput).toMatchObject({
      flow_id: 'release-note-flow',
      selected_flow: 'release-note-flow',
      outcome: 'complete',
    });
    expect(runOutput.runtime_reason).toBeUndefined();
    const firstTrace = JSON.parse(
      readFileSync(join(runFolder, 'trace.ndjson'), 'utf8').split(/\r?\n/, 1)[0] ?? '{}',
    ) as Record<string, unknown>;
    expect(firstTrace).toMatchObject({
      schema_version: 1,
      kind: 'run.bootstrapped',
      flow_id: 'release-note-flow',
    });
  });

  it('publishes reviewed draft contents without regenerating the draft', async () => {
    const home = tempRoot('circuit-create-reviewed-draft-');
    const draft = await captureMain([
      'create',
      '--name',
      'release-note-flow',
      '--description',
      'Draft release notes from a change summary',
      '--home',
      home,
    ]);

    expect(draft.code, draft.stderr).toBe(0);
    const drafted = JSON.parse(draft.stdout) as { draft_path: string };
    const draftFlowPath = join(drafted.draft_path, 'circuit.json');
    const draftFlow = JSON.parse(readFileSync(draftFlowPath, 'utf8'));
    draftFlow.purpose = 'Operator-reviewed release note flow';
    writeFileSync(draftFlowPath, `${JSON.stringify(draftFlow, null, 2)}\n`);
    writeFileSync(
      join(drafted.draft_path, 'command.md'),
      '# Reviewed command\n\ncustom draft command\n',
    );

    const publish = await captureMain([
      'create',
      '--name',
      'release-note-flow',
      '--description',
      'Publish-time description that should not override the reviewed draft',
      '--home',
      home,
      '--publish',
      '--yes',
      '--created-at',
      '2026-04-29T23:00:00.000Z',
    ]);

    expect(publish.code, publish.stderr).toBe(0);
    const published = JSON.parse(publish.stdout) as {
      flow_path: string;
      command_path: string;
      manifest_path: string;
      operator_summary_markdown_path: string;
    };
    expect(CompiledFlow.parse(JSON.parse(readFileSync(published.flow_path, 'utf8'))).purpose).toBe(
      'Operator-reviewed release note flow',
    );
    expect(readFileSync(published.command_path, 'utf8')).toContain('custom draft command');
    expect(
      (
        JSON.parse(readFileSync(published.manifest_path, 'utf8')) as {
          custom_flows: Array<{ id: string; description: string }>;
        }
      ).custom_flows[0],
    ).toMatchObject({
      id: 'release-note-flow',
      description: 'Operator-reviewed release note flow',
    });
    expect(readFileSync(published.operator_summary_markdown_path, 'utf8')).toContain(
      'Operator-reviewed release note flow',
    );
    expect(readFileSync(published.operator_summary_markdown_path, 'utf8')).not.toContain(
      'Publish-time description',
    );
    expect(
      JSON.parse(readFileSync(join(drafted.draft_path, 'validation-result.json'), 'utf8')),
    ).toMatchObject({ source: 'draft' });
  });

  it('rejects a reviewed draft with a mismatched circuit.yaml descriptor', async () => {
    const home = tempRoot('circuit-create-invalid-descriptor-');
    const draft = await captureMain([
      'create',
      '--name',
      'release-note-flow',
      '--description',
      'Draft release notes from a change summary',
      '--home',
      home,
    ]);

    expect(draft.code, draft.stderr).toBe(0);
    const drafted = JSON.parse(draft.stdout) as { draft_path: string };
    writeFileSync(
      join(drafted.draft_path, 'circuit.yaml'),
      [
        'schema_version: 1',
        'id: other-flow',
        'format: compiled-flow-package',
        'compiled_flow: circuit.json',
        'purpose: tampered descriptor',
      ].join('\n'),
    );

    const publish = await captureMain([
      'create',
      '--name',
      'release-note-flow',
      '--description',
      'Draft release notes from a change summary',
      '--home',
      home,
      '--publish',
      '--yes',
      '--created-at',
      '2026-04-29T23:00:00.000Z',
    ]);

    expect(publish.code).toBe(1);
    expect(publish.stderr).toContain('custom flow descriptor validation failed');
    expect(publish.stderr).toContain("descriptor id 'other-flow' does not match custom flow");
    expect(existsSync(join(home, 'skills/release-note-flow'))).toBe(false);
    expect(existsSync(join(home, 'flows/release-note-flow'))).toBe(false);
    expect(existsSync(join(home, 'skills/release-note-flow/circuit.yaml'))).toBe(false);
  });

  it('requires explicit confirmation before publishing a custom flow', async () => {
    const home = tempRoot('circuit-create-no-yes-');
    const result = await captureMain([
      'create',
      '--name',
      'release-note-flow',
      '--description',
      'Draft release notes',
      '--home',
      home,
      '--publish',
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--publish requires --yes');
  });

  it('rejects create without --description as a usage error (exit 2)', async () => {
    // Missing-flag misuse exits 2 like run/resume/config/memory; exit 1 stays
    // reserved for operational failures (B4).
    const result = await captureMain(['create']);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--description is required');
  });

  it('accepts equals-form create options through Commander', async () => {
    const home = tempRoot('circuit-create-equals-');
    const result = await captureMain([
      'create',
      '--name=release-note-flow',
      '--description=Draft release notes',
      `--home=${home}`,
    ]);

    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'draft_created',
      slug: 'release-note-flow',
    });
  });

  it('saves, resumes, and clears standalone continuity', async () => {
    const controlPlane = tempRoot('circuit-handoff-');
    const save = await captureMain([
      'handoff',
      'save',
      '--goal',
      'Resume release work',
      '--next',
      'DO: continue the parity matrix',
      '--state-markdown',
      '- release truth is current',
      '--debt-markdown',
      '- CONSTRAINT: keep claims generated',
      '--control-plane',
      controlPlane,
      '--record-id',
      'continuity-11111111-1111-4111-8111-111111111111',
      '--created-at',
      '2026-04-29T23:10:00.000Z',
    ]);

    expect(save.code, save.stderr).toBe(0);
    const saved = JSON.parse(save.stdout) as { continuity_path: string; index_path: string };
    expect(
      ContinuityRecord.parse(JSON.parse(readFileSync(saved.continuity_path, 'utf8'))),
    ).toMatchObject({
      continuity_kind: 'standalone',
      narrative: { next: 'DO: continue the parity matrix' },
    });
    expect(
      ContinuityIndex.parse(JSON.parse(readFileSync(saved.index_path, 'utf8'))).pending_record
        ?.record_id,
    ).toBe('continuity-11111111-1111-4111-8111-111111111111');

    const resume = await captureMain(['handoff', 'resume', '--control-plane', controlPlane]);
    expect(resume.code, resume.stderr).toBe(0);
    expect(JSON.parse(resume.stdout)).toMatchObject({
      status: 'resumed',
      source: 'pending_record',
    });

    const done = await captureMain(['handoff', 'done', '--control-plane', controlPlane]);
    expect(done.code, done.stderr).toBe(0);
    expect(
      ContinuityIndex.parse(JSON.parse(readFileSync(saved.index_path, 'utf8'))).pending_record,
    ).toBeNull();
  });

  it('accepts equals-form handoff options through Commander', async () => {
    const controlPlane = tempRoot('circuit-handoff-equals-');
    const result = await captureMain([
      'handoff',
      'save',
      '--goal=Resume release work',
      '--next=DO: continue the parity matrix',
      `--control-plane=${controlPlane}`,
    ]);

    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'saved',
    });
  });

  it('keeps bare handoff invocation as save through Commander', async () => {
    const controlPlane = tempRoot('circuit-handoff-default-save-');
    const result = await captureMain([
      'handoff',
      '--goal=Resume release work',
      '--next=DO: continue the parity matrix',
      `--control-plane=${controlPlane}`,
    ]);

    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      action: 'save',
      status: 'saved',
    });
  });

  it('answers a bare handoff missing its save inputs with the subcommand list (exit 2)', async () => {
    // Bare `circuit handoff` defaults to save. When that fails for missing
    // flags, the error must exit 2 (usage) and teach the command's shape by
    // naming the subcommands, since the operator never typed one (B4/P9).
    const controlPlane = tempRoot('circuit-handoff-bare-usage-');
    const result = await captureMain(['handoff', '--control-plane', controlPlane]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--goal');
    expect(result.stderr).toContain('--next');
    expect(result.stderr).toContain('save, resume, done, brief, hook, hooks, harvest');
  });

  it('rejects handoff save without --goal as a usage error (exit 2)', async () => {
    const controlPlane = tempRoot('circuit-handoff-save-usage-');
    const result = await captureMain([
      'handoff',
      'save',
      '--next',
      'DO: continue the parity matrix',
      '--control-plane',
      controlPlane,
    ]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--goal');
    // --next was supplied, so the collected message must not demand it.
    expect(result.stderr).not.toContain('--next');
  });

  it('returns a clean invalid envelope and exits non-zero when resuming a malformed record', async () => {
    const controlPlane = tempRoot('circuit-handoff-resume-invalid-');
    const save = await captureMain([
      'handoff',
      'save',
      '--goal',
      'Resume release work',
      '--next',
      'DO: continue the parity matrix',
      '--control-plane',
      controlPlane,
      '--record-id',
      'continuity-22222222-2222-4222-8222-222222222222',
      '--created-at',
      '2026-04-29T23:10:00.000Z',
    ]);
    expect(save.code, save.stderr).toBe(0);
    const saved = JSON.parse(save.stdout) as { continuity_path: string; index_path: string };
    const corrupted = JSON.parse(readFileSync(saved.continuity_path, 'utf8')) as {
      narrative: { goal?: string | undefined };
    };
    corrupted.narrative.goal = undefined;
    writeFileSync(saved.continuity_path, JSON.stringify(corrupted, null, 2));

    const resume = await captureMain(['handoff', 'resume', '--control-plane', controlPlane]);
    expect(resume.code).toBe(1);
    const envelope = JSON.parse(resume.stdout) as {
      action: string;
      status: string;
      record_id?: string;
      error: { code: string; message: string };
      operator_summary_markdown_path: string;
    };
    expect(envelope).toMatchObject({
      action: 'resume',
      status: 'invalid',
      record_id: 'continuity-22222222-2222-4222-8222-222222222222',
      error: { code: 'record_invalid' },
    });
    expect(resume.stderr).not.toContain('"code": "invalid_type"');
    expect(existsSync(envelope.operator_summary_markdown_path)).toBe(true);
  });

  it('returns invalid envelope on resume when the index points at a missing record', async () => {
    const projectRoot = tempRoot('circuit-handoff-resume-missing-');
    const controlPlane = join(projectRoot, '.circuit');
    const continuityRoot = join(controlPlane, 'continuity');
    mkdirSync(continuityRoot, { recursive: true });
    writeFileSync(
      join(continuityRoot, 'index.json'),
      `${JSON.stringify(
        {
          schema_version: 1,
          project_root: projectRoot,
          pending_record: {
            record_id: 'continuity-33333333-3333-4333-8333-333333333333',
            continuity_kind: 'standalone',
            created_at: '2026-04-29T23:12:00.000Z',
          },
          current_run: null,
        },
        null,
        2,
      )}\n`,
    );

    const resume = await captureMain(['handoff', 'resume', '--control-plane', controlPlane]);
    expect(resume.code).toBe(1);
    expect(JSON.parse(resume.stdout)).toMatchObject({
      action: 'resume',
      status: 'invalid',
      record_id: 'continuity-33333333-3333-4333-8333-333333333333',
      error: { code: 'record_missing' },
    });
  });

  it('returns invalid envelope on resume when the index kind disagrees with the record', async () => {
    const projectRoot = tempRoot('circuit-handoff-resume-mismatch-');
    const controlPlane = join(projectRoot, '.circuit');
    const continuityRoot = join(controlPlane, 'continuity');
    const recordsDir = join(continuityRoot, 'records');
    mkdirSync(recordsDir, { recursive: true });
    const recordId = 'continuity-44444444-4444-4444-8444-444444444444';
    writeFileSync(
      join(continuityRoot, 'index.json'),
      `${JSON.stringify(
        {
          schema_version: 1,
          project_root: projectRoot,
          pending_record: {
            record_id: recordId,
            continuity_kind: 'run-backed',
            created_at: '2026-04-29T23:12:00.000Z',
          },
          current_run: null,
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(recordsDir, `${recordId}.json`),
      `${JSON.stringify(
        {
          schema_version: 1,
          record_id: recordId,
          continuity_kind: 'standalone',
          project_root: projectRoot,
          created_at: '2026-04-29T23:12:00.000Z',
          git: { cwd: projectRoot },
          narrative: {
            goal: 'g',
            next: 'n',
            state_markdown: '- s',
            debt_markdown: '- d',
          },
          resume_contract: {
            mode: 'resume_standalone',
            auto_resume: false,
            requires_explicit_resume: true,
          },
        },
        null,
        2,
      )}\n`,
    );

    const resume = await captureMain(['handoff', 'resume', '--control-plane', controlPlane]);
    expect(resume.code).toBe(1);
    expect(JSON.parse(resume.stdout)).toMatchObject({
      action: 'resume',
      status: 'invalid',
      record_id: recordId,
      error: { code: 'record_kind_mismatch' },
    });
  });

  it('returns invalid envelope on resume when the index is unparseable', async () => {
    const projectRoot = tempRoot('circuit-handoff-resume-corrupt-');
    const controlPlane = join(projectRoot, '.circuit');
    const continuityRoot = join(controlPlane, 'continuity');
    mkdirSync(continuityRoot, { recursive: true });
    writeFileSync(join(continuityRoot, 'index.json'), '{not-json');

    const resume = await captureMain(['handoff', 'resume', '--control-plane', controlPlane]);
    expect(resume.code).toBe(1);
    expect(JSON.parse(resume.stdout)).toMatchObject({
      action: 'resume',
      status: 'invalid',
      error: { code: 'index_invalid' },
    });
  });

  it('renders a read-only handoff brief for host injection', async () => {
    const projectRoot = tempRoot('circuit-handoff-brief-project-');
    const controlPlane = join(projectRoot, '.circuit');
    const save = await captureMain([
      'handoff',
      'save',
      '--goal',
      'Resume release work',
      '--next',
      'continue the parity matrix',
      '--state-markdown',
      '- release truth is current',
      '--debt-markdown',
      '- keep claims generated',
      '--project-root',
      projectRoot,
      '--record-id',
      'continuity-33333333-3333-4333-8333-333333333333',
      '--created-at',
      '2026-04-29T23:12:00.000Z',
    ]);
    expect(save.code, save.stderr).toBe(0);
    const saved = JSON.parse(save.stdout) as { continuity_path: string; index_path: string };
    const indexBefore = readFileSync(saved.index_path, 'utf8');
    const recordBefore = readFileSync(saved.continuity_path, 'utf8');

    const brief = await captureMain(['handoff', 'brief', '--json', '--project-root', projectRoot]);

    expect(brief.code, brief.stderr).toBe(0);
    const output = JSON.parse(brief.stdout) as {
      api_version: string;
      status: string;
      record_id: string;
      additional_context: string;
    };
    expect(output).toMatchObject({
      api_version: 'handoff-brief-v1',
      status: 'available',
      record_id: 'continuity-33333333-3333-4333-8333-333333333333',
    });
    expect(output.additional_context).toContain('Circuit handoff is present for this repo.');
    expect(output.additional_context).toContain('Goal: Resume release work');
    expect(output.additional_context).toContain('Next: continue the parity matrix');
    expect(output.additional_context).toContain(
      'Boundary: Use this as context only. Do not continue unless the user asks.',
    );
    expect(output.additional_context.length).toBeLessThanOrEqual(3000);
    expect(readFileSync(saved.index_path, 'utf8')).toBe(indexBefore);
    expect(readFileSync(saved.continuity_path, 'utf8')).toBe(recordBefore);
    expect(existsSync(join(controlPlane, 'continuity/reports/brief-result.json'))).toBe(false);
  });

  it('keeps required handoff brief framing when narrative details are truncated', async () => {
    const projectRoot = tempRoot('circuit-handoff-brief-truncated-');
    const longState = `- ${'state '.repeat(700)}`;
    const longDebt = `- ${'debt '.repeat(700)}`;
    const save = await captureMain([
      'handoff',
      'save',
      '--goal',
      'Resume release work',
      '--next',
      'continue the parity matrix',
      '--state-markdown',
      longState,
      '--debt-markdown',
      longDebt,
      '--project-root',
      projectRoot,
      '--record-id',
      'continuity-44444444-4444-4444-8444-444444444444',
      '--created-at',
      '2026-04-29T23:13:00.000Z',
    ]);
    expect(save.code, save.stderr).toBe(0);

    const brief = await captureMain(['handoff', 'brief', '--json', '--project-root', projectRoot]);

    expect(brief.code, brief.stderr).toBe(0);
    const output = JSON.parse(brief.stdout) as {
      status: string;
      additional_context: string;
    };
    expect(output.status).toBe('available');
    expect(output.additional_context.length).toBeLessThanOrEqual(3000);
    expect(output.additional_context).toContain('Goal: Resume release work');
    expect(output.additional_context).toContain('Next: continue the parity matrix');
    expect(output.additional_context).toContain('[truncated]');
    expect(output.additional_context).toContain(
      'Boundary: Use this as context only. Do not continue unless the user asks.',
    );
  });

  it('returns invalid instead of dropping required handoff brief framing', async () => {
    const projectRoot = tempRoot('circuit-handoff-brief-too-large-');
    const save = await captureMain([
      'handoff',
      'save',
      '--goal',
      'Resume release work',
      '--next',
      'N'.repeat(4000),
      '--state-markdown',
      '- release truth is current',
      '--debt-markdown',
      '- keep claims generated',
      '--project-root',
      projectRoot,
      '--record-id',
      'continuity-55555555-5555-4555-8555-555555555555',
      '--created-at',
      '2026-04-29T23:14:00.000Z',
    ]);
    expect(save.code, save.stderr).toBe(0);

    const brief = await captureMain(['handoff', 'brief', '--json', '--project-root', projectRoot]);

    expect(brief.code, brief.stderr).toBe(0);
    expect(JSON.parse(brief.stdout)).toMatchObject({
      api_version: 'handoff-brief-v1',
      status: 'invalid',
      record_id: 'continuity-55555555-5555-4555-8555-555555555555',
      error: { code: 'brief_too_large' },
    });
  });

  it('returns empty for missing or cleared handoff state without writing files', async () => {
    const projectRoot = tempRoot('circuit-handoff-brief-empty-');

    const missing = await captureMain([
      'handoff',
      'brief',
      '--json',
      '--project-root',
      projectRoot,
    ]);
    expect(missing.code, missing.stderr).toBe(0);
    expect(JSON.parse(missing.stdout)).toMatchObject({
      api_version: 'handoff-brief-v1',
      status: 'empty',
      reason: 'no_index',
    });
    expect(existsSync(join(projectRoot, '.circuit'))).toBe(false);

    const done = await captureMain(['handoff', 'done', '--project-root', projectRoot]);
    expect(done.code, done.stderr).toBe(0);

    const cleared = await captureMain([
      'handoff',
      'brief',
      '--json',
      '--project-root',
      projectRoot,
    ]);
    expect(cleared.code, cleared.stderr).toBe(0);
    expect(JSON.parse(cleared.stdout)).toMatchObject({
      status: 'empty',
      reason: 'no_pending_record',
    });
  });

  it('returns invalid for corrupt or dangling handoff state', async () => {
    const projectRoot = tempRoot('circuit-handoff-brief-invalid-');
    const controlPlane = join(projectRoot, '.circuit');
    const continuityRoot = join(controlPlane, 'continuity');
    mkdirSync(continuityRoot, { recursive: true });
    writeFileSync(join(continuityRoot, 'index.json'), '{not-json');

    const corruptIndex = await captureMain([
      'handoff',
      'brief',
      '--json',
      '--project-root',
      projectRoot,
    ]);
    expect(corruptIndex.code, corruptIndex.stderr).toBe(0);
    expect(JSON.parse(corruptIndex.stdout)).toMatchObject({
      status: 'invalid',
      error: { code: 'index_invalid' },
    });

    writeFileSync(
      join(continuityRoot, 'index.json'),
      `${JSON.stringify(
        {
          schema_version: 1,
          project_root: projectRoot,
          pending_record: {
            record_id: 'continuity-missing',
            continuity_kind: 'standalone',
            created_at: '2026-04-29T23:12:00.000Z',
          },
          current_run: null,
        },
        null,
        2,
      )}\n`,
    );

    const missingRecord = await captureMain([
      'handoff',
      'brief',
      '--json',
      '--project-root',
      projectRoot,
    ]);
    expect(missingRecord.code, missingRecord.stderr).toBe(0);
    expect(JSON.parse(missingRecord.stdout)).toMatchObject({
      status: 'invalid',
      record_id: 'continuity-missing',
      error: { code: 'record_missing' },
    });

    mkdirSync(join(continuityRoot, 'records'), { recursive: true });
    writeFileSync(join(continuityRoot, 'records/continuity-missing.json'), '{not-json');
    const corruptRecord = await captureMain([
      'handoff',
      'brief',
      '--json',
      '--project-root',
      projectRoot,
    ]);
    expect(corruptRecord.code, corruptRecord.stderr).toBe(0);
    expect(JSON.parse(corruptRecord.stdout)).toMatchObject({
      status: 'invalid',
      record_id: 'continuity-missing',
      error: { code: 'record_invalid' },
    });
  });

  it('requires --json for handoff brief and explains why', async () => {
    const result = await captureMain(['handoff', 'brief']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('machine-readable JSON');
    expect(result.stderr).toContain('--json');
  });

  it('installs and removes the Codex user-level handoff hook without clobbering existing hooks', async () => {
    const root = tempRoot('circuit-handoff-hooks-');
    const hooksFile = join(root, 'codex/hooks.json');
    const launcher = join(root, 'bin/circuit');
    mkdirSync(join(root, 'codex'), { recursive: true });
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(launcher, '#!/usr/bin/env node\n');
    writeFileSync(
      hooksFile,
      `${JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                matcher: 'startup',
                hooks: [{ type: 'command', command: 'echo existing-hook' }],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );

    const install = await captureMain([
      'handoff',
      'hooks',
      'install',
      '--host',
      'codex',
      '--hooks-file',
      hooksFile,
      '--launcher',
      launcher,
    ]);

    expect(install.code, install.stderr).toBe(0);
    const installed = JSON.parse(install.stdout) as {
      status: string;
      backup_path: string;
      command: string;
    };
    expect(installed.status).toBe('installed');
    expect(installed.command).toContain('handoff hook --host codex');
    expect(existsSync(installed.backup_path)).toBe(true);
    const configAfterInstall = JSON.parse(readFileSync(hooksFile, 'utf8')) as {
      hooks: { SessionStart: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
    };
    expect(configAfterInstall.hooks.SessionStart).toHaveLength(2);
    expect(configAfterInstall.hooks.SessionStart[1]?.matcher).toBe('startup|resume|clear');
    expect(JSON.stringify(configAfterInstall)).toContain('echo existing-hook');
    expect(JSON.stringify(configAfterInstall)).toContain('handoff hook --host codex');

    const secondInstall = await captureMain([
      'handoff',
      'hooks',
      'install',
      '--host',
      'codex',
      '--hooks-file',
      hooksFile,
      '--launcher',
      launcher,
    ]);
    expect(secondInstall.code, secondInstall.stderr).toBe(0);
    expect(JSON.parse(secondInstall.stdout)).toMatchObject({ status: 'already_installed' });
    const configAfterSecondInstall = JSON.parse(readFileSync(hooksFile, 'utf8')) as {
      hooks: { SessionStart: unknown[] };
    };
    expect(
      configAfterSecondInstall.hooks.SessionStart.filter((entry) =>
        JSON.stringify(entry).includes('handoff hook --host codex'),
      ),
    ).toHaveLength(1);

    const doctor = await captureMain([
      'handoff',
      'hooks',
      'doctor',
      '--host',
      'codex',
      '--hooks-file',
      hooksFile,
    ]);
    expect(doctor.code, doctor.stderr).toBe(0);
    expect(JSON.parse(doctor.stdout)).toMatchObject({ status: 'ok' });

    const uninstall = await captureMain([
      'handoff',
      'hooks',
      'uninstall',
      '--host',
      'codex',
      '--hooks-file',
      hooksFile,
    ]);
    expect(uninstall.code, uninstall.stderr).toBe(0);
    expect(JSON.parse(uninstall.stdout)).toMatchObject({ status: 'uninstalled' });
    const configAfterUninstall = JSON.parse(readFileSync(hooksFile, 'utf8')) as {
      hooks: { SessionStart: unknown[] };
    };
    expect(JSON.stringify(configAfterUninstall)).toContain('echo existing-hook');
    expect(JSON.stringify(configAfterUninstall)).not.toContain('handoff hook --host codex');
  });

  it('resolves default launcher from CIRCUIT_PLUGIN_ROOT when the wrapper has set it', () => {
    const pluginRoot = tempRoot('circuit-launcher-plugin-root-');
    mkdirSync(join(pluginRoot, 'scripts'), { recursive: true });
    const wrapper = join(pluginRoot, 'scripts/circuit.js');
    writeFileSync(wrapper, '#!/usr/bin/env node\n');

    // moduleDir is irrelevant when CIRCUIT_PLUGIN_ROOT is set — the env var
    // is authoritative because the wrapper is the only piece of code that
    // knows the actual install layout.
    expect(resolveDefaultLauncher(pluginRoot, '/nonexistent/module/dir')).toBe(wrapper);
  });

  it('falls back to source-tree bin/circuit when CIRCUIT_PLUGIN_ROOT is absent', () => {
    const root = tempRoot('circuit-launcher-source-');
    const moduleDir = join(root, 'src/cli');
    const bin = join(root, 'bin/circuit');
    mkdirSync(moduleDir, { recursive: true });
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(bin, '#!/usr/bin/env node\n');

    expect(resolveDefaultLauncher(undefined, moduleDir)).toBe(bin);
    expect(resolveDefaultLauncher('', moduleDir)).toBe(bin);
  });

  it('explains the no-wrapper default launcher failure with both supported fixes', () => {
    const root = tempRoot('circuit-launcher-packaged-');
    const moduleDir = join(root, 'plugins/codex/runtime');

    const fallback = resolveDefaultLauncher(undefined, moduleDir);
    expect(fallback).toBe(resolve(root, 'plugins/bin/circuit'));
    expect(existsSync(fallback)).toBe(false);

    const message = missingDefaultLauncherMessage(fallback);
    expect(message).toContain('CIRCUIT_PLUGIN_ROOT is unset and no wrapper was detected');
    expect(message).toContain('set CIRCUIT_PLUGIN_ROOT');
    expect(message).toContain('invoke through plugins/<host>/scripts/circuit.js');
    expect(message).toContain(fallback);
  });

  it('reports a missing explicit launcher path without default-wrapper guidance', async () => {
    const root = tempRoot('circuit-launcher-missing-');
    const moduleDir = join(root, 'src/cli');
    mkdirSync(moduleDir, { recursive: true });

    const fallback = resolveDefaultLauncher(undefined, moduleDir);
    expect(fallback).toBe(resolve(moduleDir, '../..', 'bin/circuit'));
    expect(existsSync(fallback)).toBe(false);

    const hooksFile = join(root, 'codex/hooks.json');
    mkdirSync(join(root, 'codex'), { recursive: true });
    const install = await captureMain([
      'handoff',
      'hooks',
      'install',
      '--host',
      'codex',
      '--hooks-file',
      hooksFile,
      '--launcher',
      fallback,
    ]);
    expect(install.code).not.toBe(0);
    expect(install.stderr).toContain('Circuit launcher not found');
  });

  it('installs the Codex handoff hook with the default wrapper launcher when no --launcher is supplied', async () => {
    const root = tempRoot('circuit-handoff-hooks-default-launcher-');
    const hooksFile = join(root, 'codex/hooks.json');
    mkdirSync(join(root, 'codex'), { recursive: true });

    const install = await captureMain([
      'handoff',
      'hooks',
      'install',
      '--host',
      'codex',
      '--hooks-file',
      hooksFile,
    ]);

    expect(install.code, install.stderr).toBe(0);
    const installed = JSON.parse(install.stdout) as { status: string; command: string };
    expect(installed.status).toBe('installed');
    expect(installed.command).toContain('handoff hook --host codex');
  });

  it('reports missing when the Codex hooks file has no Circuit handoff hook', async () => {
    const root = tempRoot('circuit-handoff-hooks-missing-');
    const hooksFile = join(root, 'codex/hooks.json');
    mkdirSync(join(root, 'codex'), { recursive: true });
    writeFileSync(
      hooksFile,
      `${JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                matcher: 'startup',
                hooks: [{ type: 'command', command: 'echo foreign-hook' }],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );

    const doctor = await captureMain([
      'handoff',
      'hooks',
      'doctor',
      '--host',
      'codex',
      '--hooks-file',
      hooksFile,
    ]);

    expect(doctor.code, doctor.stderr).toBe(0);
    expect(JSON.parse(doctor.stdout)).toMatchObject({
      status: 'missing',
      checks: expect.arrayContaining([
        expect.objectContaining({
          name: 'circuit_handoff_hook_installed',
          ok: false,
        }),
      ]),
    });
  });

  it('reports invalid when duplicate Codex Circuit handoff hooks are installed', async () => {
    const root = tempRoot('circuit-handoff-hooks-duplicate-');
    const hooksFile = join(root, 'codex/hooks.json');
    const launcher = join(root, 'bin/circuit');
    mkdirSync(join(root, 'codex'), { recursive: true });
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(launcher, '#!/usr/bin/env node\n');
    const command = `${process.execPath} ${launcher} handoff hook --host codex`;
    writeFileSync(
      hooksFile,
      `${JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                matcher: 'startup',
                hooks: [{ type: 'command', command }],
              },
              {
                matcher: 'resume',
                hooks: [{ type: 'command', command }],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );

    const doctor = await captureMain([
      'handoff',
      'hooks',
      'doctor',
      '--host',
      'codex',
      '--hooks-file',
      hooksFile,
    ]);

    expect(doctor.code, doctor.stderr).toBe(0);
    expect(JSON.parse(doctor.stdout)).toMatchObject({
      status: 'invalid',
      checks: expect.arrayContaining([
        expect.objectContaining({
          name: 'circuit_handoff_hook_single',
          ok: false,
        }),
      ]),
    });
  });

  it('marks an installed Codex handoff hook invalid when the launcher is missing', async () => {
    const root = tempRoot('circuit-handoff-hooks-stale-launcher-');
    const hooksFile = join(root, 'codex/hooks.json');
    const launcher = join(root, 'bin/circuit');
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(launcher, '#!/usr/bin/env node\n');

    const install = await captureMain([
      'handoff',
      'hooks',
      'install',
      '--host',
      'codex',
      '--hooks-file',
      hooksFile,
      '--launcher',
      launcher,
    ]);
    expect(install.code, install.stderr).toBe(0);
    rmSync(launcher, { force: true });

    const doctor = await captureMain([
      'handoff',
      'hooks',
      'doctor',
      '--host',
      'codex',
      '--hooks-file',
      hooksFile,
    ]);

    expect(doctor.code, doctor.stderr).toBe(0);
    expect(JSON.parse(doctor.stdout)).toMatchObject({
      status: 'invalid',
      checks: expect.arrayContaining([
        expect.objectContaining({
          name: 'circuit_handoff_hook_launcher_exists',
          ok: false,
        }),
      ]),
    });
  });

  it('renders Codex SessionStart JSON from the CLI hook entrypoint', async () => {
    const projectRoot = tempRoot('circuit-handoff-hook-entry-project-');
    const save = await captureMain([
      'handoff',
      'save',
      '--goal',
      'Resume release work',
      '--next',
      'continue the parity matrix',
      '--state-markdown',
      '- release truth is current',
      '--debt-markdown',
      '- keep claims generated',
      '--project-root',
      projectRoot,
      '--record-id',
      'continuity-66666666-6666-4666-8666-666666666666',
      '--created-at',
      '2026-04-29T23:15:00.000Z',
    ]);
    expect(save.code, save.stderr).toBe(0);

    const hook = await captureMain([
      'handoff',
      'hook',
      '--host',
      'codex',
      '--project-root',
      projectRoot,
    ]);

    expect(hook.code, hook.stderr).toBe(0);
    const output = JSON.parse(hook.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(output.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(output.hookSpecificOutput.additionalContext).toContain(
      'Circuit handoff is present for this repo.',
    );
    expect(output.hookSpecificOutput.additionalContext).toContain(
      'Boundary: Use this as context only. Do not continue unless the user asks.',
    );

    const emptyProjectRoot = tempRoot('circuit-handoff-hook-entry-empty-');
    const empty = await captureMain([
      'handoff',
      'hook',
      '--host',
      'codex',
      '--project-root',
      emptyProjectRoot,
    ]);
    expect(empty.code, empty.stderr).toBe(0);
    expect(empty.stdout).toBe('');
  });

  it('Codex hook entrypoint surfaces a visible notice when the brief is invalid (A1)', async () => {
    const projectRoot = tempRoot('circuit-handoff-hook-invalid-');
    const save = await captureMain([
      'handoff',
      'save',
      '--goal',
      'Resume work that will be corrupted',
      '--next',
      'do the thing',
      '--project-root',
      projectRoot,
      '--record-id',
      'continuity-77777777-7777-4777-8777-777777777777',
      '--created-at',
      '2026-04-29T23:16:00.000Z',
    ]);
    expect(save.code, save.stderr).toBe(0);
    writeFileSync(
      join(
        projectRoot,
        '.circuit/continuity/records/continuity-77777777-7777-4777-8777-777777777777.json',
      ),
      '{ not valid json',
    );

    const hook = await captureMain([
      'handoff',
      'hook',
      '--host',
      'codex',
      '--project-root',
      projectRoot,
    ]);
    expect(hook.code, hook.stderr).toBe(0);
    const output = JSON.parse(hook.stdout) as {
      hookSpecificOutput: { additionalContext: string };
    };
    expect(output.hookSpecificOutput.additionalContext).toContain('could not load');
  });

  it('Codex hook entrypoint prepends the recovered notice when a broken manual save falls through to ambient (A4)', async () => {
    const projectRoot = tempRoot('circuit-handoff-hook-recovered-');
    const transcript = join(projectRoot, 'transcript.jsonl');
    writeFileSync(
      transcript,
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'ambient body that survives' } })}\n`,
    );
    const harvest = await captureMain([
      'handoff',
      'harvest',
      '--transcript-path',
      transcript,
      '--project-root',
      projectRoot,
      '--session-id',
      'rec-1',
      '--source',
      'stop',
      '--record-id',
      'ambient-latest',
    ]);
    expect(harvest.code, harvest.stderr).toBe(0);

    // Point pending_record at a record that does not exist on disk.
    const indexPath = join(projectRoot, '.circuit/continuity/index.json');
    const index = JSON.parse(readFileSync(indexPath, 'utf8'));
    index.pending_record = {
      record_id: 'continuity-feedface-feed-4eed-8eed-feedfeedfeed',
      continuity_kind: 'standalone',
      created_at: '2026-04-29T23:17:00.000Z',
    };
    writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);

    const hook = await captureMain([
      'handoff',
      'hook',
      '--host',
      'codex',
      '--project-root',
      projectRoot,
    ]);
    expect(hook.code, hook.stderr).toBe(0);
    const output = JSON.parse(hook.stdout) as {
      hookSpecificOutput: { additionalContext: string };
    };
    expect(output.hookSpecificOutput.additionalContext).toContain('could not load');
    expect(output.hookSpecificOutput.additionalContext).toContain('ambient body that survives');
  });

  it('Codex hook entrypoint suppresses injection on a suppressed source (E2)', async () => {
    const projectRoot = tempRoot('circuit-handoff-hook-source-');
    const save = await captureMain([
      'handoff',
      'save',
      '--goal',
      'Resume work that clear should not resurrect',
      '--next',
      'do the thing',
      '--project-root',
      projectRoot,
      '--record-id',
      'continuity-88888888-8888-4888-8888-888888888888',
      '--created-at',
      '2026-04-29T23:18:00.000Z',
    ]);
    expect(save.code, save.stderr).toBe(0);

    // Default (no env, no source): the brief injects as usual.
    const def = await captureMain([
      'handoff',
      'hook',
      '--host',
      'codex',
      '--project-root',
      projectRoot,
    ]);
    expect(def.code, def.stderr).toBe(0);
    expect(def.stdout).not.toBe('');

    // Opted in to suppress clear: a clear source injects nothing.
    const previous = process.env.CIRCUIT_HANDOFF_ON_CLEAR;
    process.env.CIRCUIT_HANDOFF_ON_CLEAR = 'suppress';
    try {
      const suppressed = await captureMain([
        'handoff',
        'hook',
        '--host',
        'codex',
        '--project-root',
        projectRoot,
        '--source',
        'clear',
      ]);
      expect(suppressed.code, suppressed.stderr).toBe(0);
      expect(suppressed.stdout).toBe('');
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, 'CIRCUIT_HANDOFF_ON_CLEAR');
      else process.env.CIRCUIT_HANDOFF_ON_CLEAR = previous;
    }
  });

  // A3: on Codex restore needs a one-time hook install (Claude is zero-setup),
  // so a Codex user can silently have no continuity. The assurance nudges once
  // per repo when the hook is absent and stays silent once installed or once
  // already nudged.
  it('codexInstallAssurance nudges once per repo when the Codex hook is not installed (A3)', () => {
    const projectRoot = tempRoot('circuit-codex-assure-nudge-');
    const hooksFile = join(projectRoot, 'codex-hooks.json');

    const first = codexInstallAssurance({
      projectRoot,
      hooksFile,
      now: () => new Date('2026-06-06T12:00:00.000Z'),
    });
    expect(first.status).toBe('nudge');
    expect(first.notice).toContain('install --host codex');
    expect(existsSync(first.marker_path)).toBe(true);

    // Once-per-repo: a second check on the same repo stays silent.
    const second = codexInstallAssurance({ projectRoot, hooksFile });
    expect(second.status).toBe('already_nudged');
    expect(second.notice).toBeUndefined();
  });

  it('codexInstallAssurance stays silent when the Codex hook is installed and its launcher resolves (A3)', () => {
    const projectRoot = tempRoot('circuit-codex-assure-ok-');
    const hooksFile = join(projectRoot, 'codex-hooks.json');
    // "Installed" now means the hook entry exists AND its launcher resolves on
    // disk, so the fixture writes a real launcher rather than a bare word.
    const launcher = join(projectRoot, 'bin/circuit');
    mkdirSync(join(projectRoot, 'bin'), { recursive: true });
    writeFileSync(launcher, '#!/usr/bin/env node\n');
    writeFileSync(
      hooksFile,
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: 'startup|resume|clear',
              hooks: [
                {
                  type: 'command',
                  command: `CIRCUIT_HANDOFF_HOOK=1 ${process.execPath} ${launcher} handoff hook --host codex`,
                  timeout: 3,
                },
              ],
            },
          ],
        },
      }),
    );

    const result = codexInstallAssurance({ projectRoot, hooksFile });
    expect(result.status).toBe('ok');
    expect(result.notice).toBeUndefined();
    // Nothing needed nudging, so no marker is written.
    expect(existsSync(result.marker_path)).toBe(false);
  });

  // Regression for the T3.4 gap: after a Circuit upgrade the version-pinned
  // launcher path baked into ~/.codex/hooks.json dangles — the old version
  // cache dir is deleted, so the absolute launcher path no longer resolves. The
  // hook ENTRY still matches, so the old presence-only front-door check read it
  // as installed and stayed silent, and a Codex user silently lost continuity
  // restore with no signal. A stale launcher must now surface a reinstall
  // notice, once per broken state.
  it('codexInstallAssurance flags a stale launcher for reinstall, once per broken state (T3.4)', () => {
    const projectRoot = tempRoot('circuit-codex-assure-stale-');
    const hooksFile = join(projectRoot, 'codex-hooks.json');
    // A version-pinned launcher path that does NOT exist on disk — the
    // post-upgrade dangling path. We deliberately never create this file.
    const staleLauncher = join(projectRoot, 'cache/circuit/0.1.0-old/scripts/circuit.js');
    writeFileSync(
      hooksFile,
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: 'startup|resume|clear',
              hooks: [
                {
                  type: 'command',
                  command: `CIRCUIT_HANDOFF_HOOK=1 ${process.execPath} ${staleLauncher} handoff hook --host codex`,
                  timeout: 3,
                },
              ],
            },
          ],
        },
      }),
    );

    const first = codexInstallAssurance({
      projectRoot,
      hooksFile,
      now: () => new Date('2026-07-03T12:00:00.000Z'),
    });
    expect(first.status).toBe('reinstall_nudge');
    expect(first.notice).toContain('install --host codex');
    // The reinstall notice explains the cause so the user knows why it broke.
    expect(first.notice).toContain('upgrade');
    expect(existsSync(first.marker_path)).toBe(true);

    // Once per broken state: a second check in the same broken state is silent.
    const second = codexInstallAssurance({ projectRoot, hooksFile });
    expect(second.status).toBe('already_reinstall_nudged');
    expect(second.notice).toBeUndefined();
  });

  // The reinstall signal must not be swallowed by the one-time install nudge: a
  // repo can be nudged to install, the user installs, then a later upgrade
  // dangles the launcher. "Stale" is a distinct state from "never installed"
  // and earns its own signal even after the install nudge already fired.
  it('codexInstallAssurance still nudges on a stale launcher after the install nudge already fired (T3.4)', () => {
    const projectRoot = tempRoot('circuit-codex-assure-stale-after-install-');
    const hooksFile = join(projectRoot, 'codex-hooks.json');

    // 1) No hook yet → the one-time install nudge fires and writes its marker.
    const installNudge = codexInstallAssurance({
      projectRoot,
      hooksFile,
      now: () => new Date('2026-07-03T12:00:00.000Z'),
    });
    expect(installNudge.status).toBe('nudge');

    // 2) The user installs, then upgrades: the hook entry exists but its
    //    launcher path dangles.
    const staleLauncher = join(projectRoot, 'cache/circuit/0.1.0-old/scripts/circuit.js');
    writeFileSync(
      hooksFile,
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: 'startup|resume|clear',
              hooks: [
                {
                  type: 'command',
                  command: `CIRCUIT_HANDOFF_HOOK=1 ${process.execPath} ${staleLauncher} handoff hook --host codex`,
                  timeout: 3,
                },
              ],
            },
          ],
        },
      }),
    );

    // 3) The stale state gets its own signal despite the earlier install nudge.
    const staleNudge = codexInstallAssurance({ projectRoot, hooksFile });
    expect(staleNudge.status).toBe('reinstall_nudge');
    expect(staleNudge.notice).toContain('install --host codex');
  });

  // Regression for the M11 gap: the Codex hook pins an ABSOLUTE node binary
  // path (process.execPath at install time), but the staleness check only
  // validated the launcher script, not the pinned node. An nvm/Node version
  // switch relocates node, so the launcher still resolves while the pinned node
  // is gone — continuity restore dies silently and doctor still reported
  // healthy. The check must now validate the node path too.
  it('codexInstallAssurance flags a relocated node binary for reinstall, once per broken state (M11)', () => {
    const projectRoot = tempRoot('circuit-codex-assure-stale-node-');
    const hooksFile = join(projectRoot, 'codex-hooks.json');
    // The launcher DOES resolve; only the pinned node path is gone (the nvm
    // switch case). We deliberately never create this node path.
    const launcher = join(projectRoot, 'bin/circuit');
    mkdirSync(join(projectRoot, 'bin'), { recursive: true });
    writeFileSync(launcher, '#!/usr/bin/env node\n');
    const relocatedNode = join(projectRoot, 'nvm/versions/node/v18.20.0/bin/node');
    writeFileSync(
      hooksFile,
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: 'startup|resume|clear',
              hooks: [
                {
                  type: 'command',
                  command: `CIRCUIT_HANDOFF_HOOK=1 ${relocatedNode} ${launcher} handoff hook --host codex`,
                  timeout: 3,
                },
              ],
            },
          ],
        },
      }),
    );

    const first = codexInstallAssurance({
      projectRoot,
      hooksFile,
      now: () => new Date('2026-07-09T12:00:00.000Z'),
    });
    expect(first.status).toBe('reinstall_nudge');
    expect(first.notice).toContain('install --host codex');
    // The node-specific notice names the cause so the user knows why it broke.
    expect(first.notice).toMatch(/Node/i);
    expect(existsSync(first.marker_path)).toBe(true);

    // Once per broken state: a second check in the same broken state is silent.
    const second = codexInstallAssurance({ projectRoot, hooksFile });
    expect(second.status).toBe('already_reinstall_nudged');
    expect(second.notice).toBeUndefined();
  });

  it('codexInstallAssurance stays silent when both the launcher and pinned node resolve (M11)', () => {
    const projectRoot = tempRoot('circuit-codex-assure-node-ok-');
    const hooksFile = join(projectRoot, 'codex-hooks.json');
    const launcher = join(projectRoot, 'bin/circuit');
    mkdirSync(join(projectRoot, 'bin'), { recursive: true });
    writeFileSync(launcher, '#!/usr/bin/env node\n');
    // process.execPath is a real, executable node binary — the valid case.
    writeFileSync(
      hooksFile,
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: 'startup|resume|clear',
              hooks: [
                {
                  type: 'command',
                  command: `CIRCUIT_HANDOFF_HOOK=1 ${process.execPath} ${launcher} handoff hook --host codex`,
                  timeout: 3,
                },
              ],
            },
          ],
        },
      }),
    );

    const result = codexInstallAssurance({ projectRoot, hooksFile });
    expect(result.status).toBe('ok');
    expect(result.notice).toBeUndefined();
    expect(existsSync(result.marker_path)).toBe(false);
  });

  it('marks an installed Codex handoff hook invalid when the pinned node binary is missing (M11)', async () => {
    const root = tempRoot('circuit-handoff-hooks-stale-node-');
    const hooksFile = join(root, 'codex/hooks.json');
    const launcher = join(root, 'bin/circuit');
    mkdirSync(join(root, 'codex'), { recursive: true });
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(launcher, '#!/usr/bin/env node\n');
    // Launcher resolves; only the pinned node path is gone (nvm switch).
    const relocatedNode = join(root, 'nvm/versions/node/v18.20.0/bin/node');
    writeFileSync(
      hooksFile,
      `${JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                matcher: 'startup|resume|clear',
                hooks: [
                  {
                    type: 'command',
                    command: `CIRCUIT_HANDOFF_HOOK=1 ${relocatedNode} ${launcher} handoff hook --host codex`,
                    timeout: 3,
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );

    const doctor = await captureMain([
      'handoff',
      'hooks',
      'doctor',
      '--host',
      'codex',
      '--hooks-file',
      hooksFile,
    ]);

    expect(doctor.code, doctor.stderr).toBe(0);
    expect(JSON.parse(doctor.stdout)).toMatchObject({
      status: 'invalid',
      checks: expect.arrayContaining([
        expect.objectContaining({
          name: 'circuit_handoff_hook_node_exists',
          ok: false,
        }),
        // The launcher itself still resolves — only the pinned node broke.
        expect.objectContaining({
          name: 'circuit_handoff_hook_launcher_exists',
          ok: true,
        }),
      ]),
    });
  });

  it('reports the pinned node binary healthy in doctor when it resolves (M11)', async () => {
    const root = tempRoot('circuit-handoff-hooks-node-ok-');
    const hooksFile = join(root, 'codex/hooks.json');
    const launcher = join(root, 'bin/circuit');
    mkdirSync(join(root, 'codex'), { recursive: true });
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(launcher, '#!/usr/bin/env node\n');
    writeFileSync(
      hooksFile,
      `${JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                matcher: 'startup|resume|clear',
                hooks: [
                  {
                    type: 'command',
                    command: `CIRCUIT_HANDOFF_HOOK=1 ${process.execPath} ${launcher} handoff hook --host codex`,
                    timeout: 3,
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );

    const doctor = await captureMain([
      'handoff',
      'hooks',
      'doctor',
      '--host',
      'codex',
      '--hooks-file',
      hooksFile,
    ]);
    expect(doctor.code, doctor.stderr).toBe(0);
    expect(JSON.parse(doctor.stdout)).toMatchObject({
      status: 'ok',
      checks: expect.arrayContaining([
        expect.objectContaining({ name: 'circuit_handoff_hook_node_exists', ok: true }),
      ]),
    });
  });

  it('can bind handoff continuity to a runtime waiting run and write active-run output', async () => {
    const root = tempRoot('circuit-handoff-run-');
    const runFolder = join(root, 'run');
    const controlPlane = join(root, 'control-plane');
    const run = await captureMain(
      [
        'run',
        'build',
        '--goal',
        'deep change that asks for scope',
        '--process',
        'high',
        '--run-folder',
        runFolder,
      ],
      {
        runId: '55555555-5555-4555-8555-555555555555',
        now: () => new Date('2026-04-29T23:20:00.000Z'),
      },
    );
    expect(run.code, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ outcome: 'checkpoint_waiting' });

    const save = await captureMain([
      'handoff',
      'save',
      '--goal',
      'Resume waiting Build run',
      '--next',
      'DO: resolve the Build checkpoint',
      '--state-markdown',
      '- checkpoint is waiting',
      '--debt-markdown',
      '- BLOCKED: needs checkpoint choice',
      '--run-folder',
      runFolder,
      '--control-plane',
      controlPlane,
      '--record-id',
      'continuity-22222222-2222-4222-8222-222222222222',
      '--created-at',
      '2026-04-29T23:21:00.000Z',
    ]);

    expect(save.code, save.stderr).toBe(0);
    const output = JSON.parse(save.stdout) as { continuity_path: string; active_run_path: string };
    const record = ContinuityRecord.parse(JSON.parse(readFileSync(output.continuity_path, 'utf8')));
    expect(record).toMatchObject({
      continuity_kind: 'run-backed',
      run_ref: { runtime_status: 'in_progress', current_step: 'frame-step' },
    });
    expect(readFileSync(output.active_run_path, 'utf8')).toContain(
      'DO: resolve the Build checkpoint',
    );
  });

  it('fails closed when binding handoff continuity to a saved waiting run', async () => {
    const root = tempRoot('circuit-handoff-saved-run-');
    const runFolder = join(root, 'run');
    const controlPlane = join(root, 'control-plane');
    writeInvalidRunFolder(runFolder, '55555555-5555-4555-8555-555555555556');

    const save = await captureMain([
      'handoff',
      'save',
      '--goal',
      'Resume saved waiting Build run',
      '--next',
      'DO: resolve the saved Build checkpoint',
      '--run-folder',
      runFolder,
      '--control-plane',
      controlPlane,
      '--record-id',
      'continuity-33333333-3333-4333-8333-333333333333',
      '--created-at',
      '2026-04-29T23:26:00.000Z',
    ]);

    expect(save.code).toBe(1);
    expect(save.stdout).toBe('');
    expect(save.stderr.trim()).toBe(
      'error: cannot save run-backed continuity: trace is missing or invalid for this run folder',
    );
  });

  it('fails closed when binding handoff continuity to a trace-only invalid run', async () => {
    const root = tempRoot('circuit-handoff-trace-only-run-');
    const runFolder = join(root, 'run');
    const controlPlane = join(root, 'control-plane');
    writeTraceOnlyInvalidRunFolder(runFolder, '55555555-5555-4555-8555-555555555558');

    const save = await captureMain([
      'handoff',
      'save',
      '--goal',
      'Resume trace-only invalid Build run',
      '--next',
      'DO: start a fresh run',
      '--run-folder',
      runFolder,
      '--control-plane',
      controlPlane,
      '--record-id',
      'continuity-55555555-5555-4555-8555-555555555558',
      '--created-at',
      '2026-04-29T23:27:00.000Z',
    ]);

    expect(save.code).toBe(1);
    expect(save.stdout).toBe('');
    expect(save.stderr.trim()).toContain(
      'error: cannot save run-backed continuity: manifest snapshot is missing or invalid',
    );
  });

  it('fails closed when binding handoff continuity to a run.started trace-only invalid run', async () => {
    const root = tempRoot('circuit-handoff-started-trace-only-run-');
    const runFolder = join(root, 'run');
    const controlPlane = join(root, 'control-plane');
    writeStartedTraceOnlyInvalidRunFolder(runFolder);

    const save = await captureMain([
      'handoff',
      'save',
      '--goal',
      'Resume run.started invalid Build run',
      '--next',
      'DO: start a fresh run',
      '--run-folder',
      runFolder,
      '--control-plane',
      controlPlane,
      '--record-id',
      'continuity-55555555-5555-4555-8555-555555555559',
      '--created-at',
      '2026-04-29T23:28:00.000Z',
    ]);

    expect(save.code).toBe(1);
    expect(save.stdout).toBe('');
    expect(save.stderr.trim()).toContain(
      'error: cannot save run-backed continuity: manifest snapshot is missing or invalid',
    );
  });

  it('fails closed for corrupted unmarked invalid folders before any adapter path', async () => {
    const root = tempRoot('circuit-handoff-saved-corrupt-');
    const runFolder = join(root, 'run');
    const controlPlane = join(root, 'control-plane');
    writeInvalidRunFolder(runFolder, '55555555-5555-4555-8555-555555555557');

    writeFileSync(join(runFolder, 'trace.ndjson'), '{not-json}\n');

    const save = await captureMain([
      'handoff',
      'save',
      '--goal',
      'Do not project corrupted invalid folder as runtime',
      '--next',
      'DO: inspect the saved trace corruption',
      '--run-folder',
      runFolder,
      '--control-plane',
      controlPlane,
      '--record-id',
      'continuity-44444444-4444-4444-8444-444444444444',
      '--created-at',
      '2026-04-29T23:31:00.000Z',
    ]);

    expect(save.code).toBe(1);
    expect(save.stdout).toBe('');
    expect(save.stderr.trim()).toBe(
      'error: cannot save run-backed continuity: trace is missing or invalid for this run folder',
    );
  });
});
