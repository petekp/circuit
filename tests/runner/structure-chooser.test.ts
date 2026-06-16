// B2 — the structure chooser wired into custom-flow creation.
//
// The created flow's grain (whole vs decomposed) now follows the structure
// resolver instead of always using build's full spine. The DEFAULT is
// thin-conservative: with no decompose signal a created flow folds to the whole
// grain (frame -> plan -> act -> verify -> close); an explicit decompose request
// (--decompose) gets build's full spine.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../../src/cli/circuit.js';
import { buildAssemblySpec } from '../../src/flows/build/assembly-spec.js';
import { CompiledFlow } from '../../src/index.js';
import { captureStreams } from '../helpers/runtime-fixtures.js';

const tempRoots: string[] = [];

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

// The full build spine has these step ids; the whole grain folds away the
// analyze relay, both auxiliary verify checks, and the review relay.
const FOLDED_AWAY = ['analyze-step', 'build-baseline', 'build-touch-area', 'review-step'];
const FULL_SPINE_STEP_COUNT = buildAssemblySpec.items.length; // 9

async function createCustomFlow(
  argv: readonly string[],
): Promise<{ code: number; stderr: string; flow: CompiledFlow }> {
  const result = await captureMain(argv, { now: () => new Date('2026-06-16T00:00:00.000Z') });
  if (result.code !== 0)
    return { code: result.code, stderr: result.stderr, flow: {} as CompiledFlow };
  const output = JSON.parse(result.stdout) as { draft_path: string };
  const flow = CompiledFlow.parse(
    JSON.parse(readFileSync(join(output.draft_path, 'circuit.json'), 'utf8')),
  );
  return { code: result.code, stderr: result.stderr, flow };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('structure chooser drives custom-flow grain', () => {
  it('a low/no-signal task folds to the WHOLE grain (frame -> plan -> act -> verify -> close)', async () => {
    const home = tempRoot('circuit-grain-whole-');
    const { code, stderr, flow } = await createCustomFlow([
      'create',
      '--name',
      'tidy-readme',
      '--description',
      'Tidy up a sentence in the README',
      '--home',
      home,
    ]);

    expect(code, stderr).toBe(0);
    // Identity is still the slug (the grain suffix must not leak into the id).
    expect(flow.id).toBe('tidy-readme');
    // The whole grain is strictly fewer steps than the full spine...
    const stepIds = flow.steps.map((step) => step.id);
    expect(stepIds.length).toBeLessThan(FULL_SPINE_STEP_COUNT);
    expect(stepIds.length).toBe(FULL_SPINE_STEP_COUNT - FOLDED_AWAY.length); // 5
    // ...and the folded-away steps are genuinely absent.
    for (const dropped of FOLDED_AWAY) {
      expect(stepIds).not.toContain(dropped);
    }
    // The surviving spine is frame -> plan -> act -> verify -> close.
    expect(stepIds).toEqual(
      expect.arrayContaining(['frame-step', 'plan-step', 'act-step', 'verify-step', 'close-step']),
    );
    // The absent canonical stages are declared as honest omits, not silently
    // missing. analyze and review folded away.
    const canonicals = flow.stages.map((stage) => stage.canonical);
    expect(canonicals).not.toContain('analyze');
    expect(canonicals).not.toContain('review');
    expect(flow.stage_path_policy.mode).toBe('partial');
  });

  it("an explicit --decompose request gets build's FULL spine", async () => {
    const home = tempRoot('circuit-grain-decomposed-');
    const { code, stderr, flow } = await createCustomFlow([
      'create',
      '--name',
      'release-pipeline',
      '--description',
      'Run the multi-stage release pipeline',
      '--home',
      home,
      '--decompose',
    ]);

    expect(code, stderr).toBe(0);
    expect(flow.id).toBe('release-pipeline');
    const stepIds = flow.steps.map((step) => step.id);
    // Full spine: every build step is present.
    expect(stepIds.length).toBe(FULL_SPINE_STEP_COUNT);
    for (const stepId of buildAssemblySpec.items.map((item) => item.id)) {
      expect(stepIds).toContain(stepId);
    }
    const canonicals = flow.stages.map((stage) => stage.canonical);
    expect(canonicals).toContain('analyze');
    expect(canonicals).toContain('review');
    expect(flow.stage_path_policy.mode).toBe('strict');
  });

  it('the whole grain stays a valid, publishable custom flow', async () => {
    const home = tempRoot('circuit-grain-publish-');
    const result = await captureMain(
      [
        'create',
        '--name',
        'tidy-changelog',
        '--description',
        'Tidy one line of the changelog',
        '--home',
        home,
        '--publish',
        '--yes',
        '--created-at',
        '2026-06-16T00:00:00.000Z',
      ],
      { now: () => new Date('2026-06-16T00:00:00.000Z') },
    );
    expect(result.code, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as { status: string; flow_path: string };
    expect(output.status).toBe('published');
    // Published bytes parse, keep the slug id, and are the folded grain.
    const flow = CompiledFlow.parse(JSON.parse(readFileSync(output.flow_path, 'utf8')));
    expect(flow.id).toBe('tidy-changelog');
    expect(flow.steps.length).toBe(FULL_SPINE_STEP_COUNT - FOLDED_AWAY.length);
    expect(existsSync(output.flow_path)).toBe(true);
  });
});
