// E1 fixture rendering. Builds an `ExperimentComparison` from recorded /
// synthetic run folders under experiments/e1/fixtures/, spending zero budget.
// This is the no-budget lane: it proves the whole extract -> compare -> report
// loop without ever running a flow. Imports only the pure E1 modules (no engine
// `src/` import), so the test suite can drive it directly.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVariants } from './compare.ts';
import { type ExtractInput, extractVariantRecord } from './extract.ts';
import type { ExperimentComparison, ObjectiveResult, VariantId } from './types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_ROOT = join(HERE, 'fixtures');

// Each fixture variant dir carries the run-folder artifacts plus this sidecar,
// which supplies the inputs a run folder does not itself record (the objective
// result, the committed diff, and a wall-time fallback). Kept beside the
// artifacts so the fixture is self-describing.
interface FixtureSidecar {
  readonly objective: ObjectiveResult;
  readonly changed_files: readonly string[];
  readonly fallback_wall_time_ms: number;
}

function readSidecar(fixtureDir: string): FixtureSidecar {
  const path = join(fixtureDir, 'e1-input.json');
  if (!existsSync(path)) {
    throw new Error(`fixture sidecar missing: ${path}`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as FixtureSidecar;
}

export function fixtureExtractInput(
  fixtureDir: string,
  variantId: VariantId,
  flowId: string,
): ExtractInput {
  const sidecar = readSidecar(fixtureDir);
  return {
    runFolder: fixtureDir,
    variantId,
    flowId,
    worktreePath: fixtureDir,
    objective: sidecar.objective,
    changedFiles: sidecar.changed_files,
    fallbackWallTimeMs: sidecar.fallback_wall_time_ms,
  };
}

// The bundled two-variant fixture: a holistic `fix` run that genuinely passed,
// and a separated `build` run that false-fixed (claimed done, hidden check
// still fails) at higher cost. It is a deliberately interesting pairing so the
// rendered report exercises verdict mismatch, a cost ratio, and the false-fix
// callout.
const FIXTURE_VARIANTS: ReadonlyArray<{
  dir: string;
  variantId: VariantId;
  flowId: string;
}> = [
  { dir: 'holistic-pass', variantId: 'holistic', flowId: 'fix' },
  { dir: 'separated-falsefix', variantId: 'separated', flowId: 'build' },
];

export function renderFixtureComparison(generatedAt: string): ExperimentComparison {
  const records = FIXTURE_VARIANTS.map((variant) =>
    extractVariantRecord(
      fixtureExtractInput(join(FIXTURES_ROOT, variant.dir), variant.variantId, variant.flowId),
    ),
  );
  return compareVariants(records, {
    task_id: 'heldout-wrap-index',
    done_when:
      'Fix wrapIndex so paging past the last slide wraps around. Objective: the bug ' +
      'reproduces at baseline, then every check passes after the fix (visible: npm test; ' +
      'plus 1 hidden ground-truth check the agent never sees).',
    base_ref: 'fixture-base-0000000',
    mode: 'fixture',
    generated_at: generatedAt,
  });
}
