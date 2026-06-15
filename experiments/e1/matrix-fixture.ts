// E1 matrix fixture lane (zero budget). Builds an `ExperimentMatrix` from the
// recorded run folders under experiments/e1/fixtures/, proving the grid +
// rollup + delta logic without running a flow. Reuses the same fixture readers
// the single-pair lane uses, so one set of recorded artifacts backs both lanes.

import { join } from 'node:path';
import { extractVariantRecord } from './extract.ts';
import { fixtureExtractInput } from './fixture.ts';
import { FIXTURES_ROOT } from './fixture.ts';
import {
  type ExperimentMatrix,
  type MatrixCell,
  type MatrixVariantSpec,
  buildMatrix,
} from './matrix.ts';

// The canonical two grains, as matrix columns. Holistic (fix) is the baseline
// column; separated (build --depth high) is the contrast. The live runner clears
// build's opening frame checkpoint by answering it with `circuit resume
// --checkpoint-choice continue`, not by changing the run's autonomy. This is the
// column set the live matrix runner uses too.
export const CANONICAL_VARIANTS: readonly MatrixVariantSpec[] = [
  { variant_label: 'holistic', flow_id: 'fix', extra_args: [] },
  { variant_label: 'separated', flow_id: 'build', extra_args: ['--depth', 'high'] },
];

// Map each canonical column to the bundled fixture dir that stands in for it.
const FIXTURE_DIR_BY_LABEL: Record<string, string> = {
  holistic: 'holistic-pass',
  separated: 'separated-falsefix',
};

function fixtureCell(taskId: string, spec: MatrixVariantSpec): MatrixCell {
  const dir = FIXTURE_DIR_BY_LABEL[spec.variant_label];
  if (dir === undefined) {
    throw new Error(`no fixture dir mapped for variant '${spec.variant_label}'`);
  }
  const variantId = spec.variant_label === 'holistic' ? 'holistic' : 'separated';
  const record = extractVariantRecord(
    fixtureExtractInput(join(FIXTURES_ROOT, dir), variantId, spec.flow_id),
  );
  return { task_id: taskId, variant_label: spec.variant_label, record };
}

// One task (the recorded heldout-wrap-index pairing) by two variant columns —
// the minimum grid the B1 milestone proves. The cells exercise a verdict
// disagreement (holistic pass vs separated false-fix) so the rollup, the
// per-task delta, and the ⚑ disagreement marker all light up.
export function renderFixtureMatrix(generatedAt: string): ExperimentMatrix {
  const cells = CANONICAL_VARIANTS.map((spec) => fixtureCell('heldout-wrap-index', spec));
  return buildMatrix(CANONICAL_VARIANTS, cells, { mode: 'fixture', generated_at: generatedAt });
}
