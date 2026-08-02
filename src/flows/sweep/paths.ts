// Run-folder paths shared between Sweep's assembly spec and its writers.
//
// The partition writer reads the engine-written carried-notes file directly
// (a compose head has no relay prompt to re-inline it), so the path constant
// must be identical to the one the assembly spec hands the until-loop flag.
// Keeping them in one module removes the chance of a silent drift between where
// the engine writes the notes and where the writer looks for them.

export const SWEEP_CENSUS_REPORT_PATH = 'reports/sweep/census.json';
export const SWEEP_PARTITION_REPORT_PATH = 'reports/sweep/partition.json';
export const SWEEP_WAVE_AGGREGATE_PATH = 'reports/sweep/wave-aggregate.json';
export const SWEEP_WAVE_BRANCHES_DIR = 'reports/sweep/wave-branches';
export const SWEEP_RESCAN_REPORT_PATH = 'reports/sweep/rescan.json';
export const SWEEP_CARRIED_NOTES_PATH = 'reports/sweep/carried-notes.json';
export const SWEEP_JUDGE_REQUEST_PATH = 'reports/sweep/judgment.request.json';
export const SWEEP_JUDGE_RECEIPT_PATH = 'reports/sweep/judgment.receipt.txt';
export const SWEEP_JUDGE_RESULT_PATH = 'reports/sweep/judgment.result.json';
export const SWEEP_JUDGE_REPORT_PATH = 'reports/sweep/judgment.report.json';

// The config surface Sweep freezes on its own account: the file a TypeScript
// scanner reads to decide what counts as a finding. Declared here so the
// assembly spec's `frozen_paths` and the census's recorded `config_surface`
// cannot drift apart into two different answers.
//
// This list is what Sweep can know without being told. Any other toolchain adds
// its own through `verification.frozen_paths` in the project config, and the
// census refuses to run when nothing in the union is actually on disk.
export const SWEEP_FLOW_FROZEN_PATHS = ['tsconfig.json'] as const;
