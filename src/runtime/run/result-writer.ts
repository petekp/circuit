import type { EngineProvenance } from '../../schemas/engine-provenance.js';
import type { SurvivingWork } from '../../schemas/surviving-work.js';
import { RUN_RESULT_RELATIVE_PATH } from '../../shared/result-path.js';
import type { RunClosedOutcome, RunId } from '../domain/run.js';
import type { RunFileStore } from '../run-files/run-file-store.js';

export interface RuntimeRunResult {
  readonly schema_version: 1;
  readonly run_id: RunId;
  readonly flow_id: string;
  readonly goal: string;
  // Declared here because closeRun writes it (spread properties bypass excess
  // property checking, so its absence was invisible to tsc rather than
  // intentional). result-recovery cannot supply it: `why` is not on the
  // run.bootstrapped entry, so a crash-healed record still omits it.
  readonly why?: string;
  readonly outcome: RunClosedOutcome;
  readonly summary: string;
  readonly closed_at: string;
  readonly trace_entries_observed: number;
  readonly manifest_hash: string;
  readonly reason?: string;
  readonly verdict?: string;
  readonly engine?: EngineProvenance;
  // The reports that reached disk before a run that did not finish, so the
  // operator is handed the work instead of being told to start over. Absent on
  // a clean close and on a run that produced nothing. See surviving-work.ts.
  readonly surviving_work?: readonly SurvivingWork[];
}

export async function writeRuntimeRunResult(
  files: RunFileStore,
  result: RuntimeRunResult,
): Promise<string> {
  return await files.writeJson(RUN_RESULT_RELATIVE_PATH, result);
}
