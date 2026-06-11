// CLI argument parsing for the verdict-correctness eval, kept separate from
// index.ts so it can be unit-tested without importing the runner (which loads
// the built connectors under dist/). index.ts owns the side-effecting main().

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeSegment } from '../../scripts/evals/shared/json.ts';
import { DEFECT_IDS, SUITES } from './defect-taxonomy.ts';
import type { DefectId, JudgeId, SuiteId } from './types.ts';

export const SUPPORTED_JUDGES: readonly JudgeId[] = ['codex', 'claude-code'];
export const SUITE_IDS: readonly SuiteId[] = ['standard', 'subtle', 'all'];

const RESULTS_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), 'results');

export interface CliArgs {
  readonly maxComposes: number;
  readonly defects: readonly DefectId[];
  // The selected defect group, or 'custom' when --defects overrode it.
  readonly suite: SuiteId | 'custom';
  readonly includeControl: boolean;
  readonly dryRun: boolean;
  readonly judge: JudgeId;
  // The Anthropic model id to pin the judge to, or null to let the connector
  // run its host default. Only meaningful for the claude-code judge.
  readonly model: string | null;
  readonly resultsDir: string;
}

export interface ParseArgsOptions {
  // Injected so unit tests get a stable results-dir name; production passes the
  // real clock.
  readonly now?: () => Date;
}

export function parseArgs(argv: readonly string[], options: ParseArgsOptions = {}): CliArgs {
  const now = options.now ?? (() => new Date());
  let maxComposes = Number.POSITIVE_INFINITY;
  // The default suite is 'standard' so the bare command keeps measuring the
  // historical near-ceiling defects. Phase C and the ledger run --suite subtle
  // explicitly because that is the tracked regression baseline.
  let suite: SuiteId = 'standard';
  // Non-null only when --defects overrides the suite's defect set.
  let defectsOverride: readonly DefectId[] | null = null;
  let includeControl = true;
  let dryRun = false;
  let judge: JudgeId = 'codex';
  let model: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--max-composes') {
      const next = argv[i + 1];
      if (!next) throw new Error('--max-composes requires a number');
      maxComposes = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === '--suite') {
      const next = argv[i + 1];
      if (!next) throw new Error(`--suite requires one of: ${SUITE_IDS.join(', ')}`);
      if (!(SUITE_IDS as readonly string[]).includes(next)) {
        throw new Error(`unknown suite '${next}'; supported: ${SUITE_IDS.join(', ')}`);
      }
      suite = next as SuiteId;
      i += 1;
    } else if (arg === '--defects') {
      const next = argv[i + 1];
      if (!next) throw new Error('--defects requires comma-separated ids');
      const requested = next.split(',') as DefectId[];
      const unknown = requested.filter((d) => !DEFECT_IDS.includes(d));
      if (unknown.length > 0) {
        throw new Error(`unknown defect ids: ${unknown.join(', ')}`);
      }
      defectsOverride = requested;
      i += 1;
    } else if (arg === '--no-control') {
      includeControl = false;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--judge') {
      const next = argv[i + 1];
      if (!next) throw new Error('--judge requires a connector name');
      if (!(SUPPORTED_JUDGES as readonly string[]).includes(next)) {
        throw new Error(`unknown judge '${next}'; supported: ${SUPPORTED_JUDGES.join(', ')}`);
      }
      judge = next as JudgeId;
      i += 1;
    } else if (arg === '--model') {
      const next = argv[i + 1];
      if (!next) throw new Error('--model requires a model id');
      model = next;
      i += 1;
    } else {
      throw new Error(`unknown arg: ${arg}`);
    }
  }

  // The claude-code connector takes the model via resolvedSelection.model
  // (provider 'anthropic'); the codex connector selects models through a
  // different channel the eval does not thread, so reject the combination
  // rather than silently ignoring --model.
  if (model !== null && judge !== 'claude-code') {
    throw new Error(`--model is only supported with --judge claude-code (got --judge ${judge})`);
  }

  // --defects is the precise override; when present it wins over --suite and
  // the run is recorded as 'custom'. Otherwise the suite selects the set.
  const defects = defectsOverride ?? SUITES[suite];
  const suiteLabel: SuiteId | 'custom' = defectsOverride ? 'custom' : suite;

  const timestamp = now().toISOString().replace(/[:.]/g, '-');
  // Tag results dir with judge (and model when pinned) so cross-judge and
  // cross-model runs are easy to compare side by side without overwriting
  // each other's output.
  const modelSuffix = model === null ? '' : `-${safeSegment(model)}`;
  const resultsDir = resolve(RESULTS_DIR, `${timestamp}-${judge}${modelSuffix}`);
  return {
    maxComposes,
    defects,
    suite: suiteLabel,
    includeControl,
    dryRun,
    judge,
    model,
    resultsDir,
  };
}
