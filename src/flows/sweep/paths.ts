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
