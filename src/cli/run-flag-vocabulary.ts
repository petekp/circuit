// Run execution-flag vocabulary — the single source of truth for the
// `circuit run` / `circuit resume` option surface.
//
// `addExecutionOptions` in `src/cli/run.ts` derives every commander
// `.option()` call from these rows, and the doc lint
// (`tests/contracts/doc-command-claims.test.ts`) validates every flag a
// living doc teaches against the same rows. Adding a flag here is the
// only step needed for it to parse AND become teachable; a flag absent
// here cannot appear in a doc without failing the lint.
//
// Dependency-light leaf: imports only from `src/schemas/` (zod-only
// modules), never from `run.ts` or anything that could cycle back into
// the CLI. The `--process`/`--power` value hints derive from the zod
// enums so a tier rename is physically one edit that feeds the CLI
// parser, the help text, and the doc lint together.
import { PowerDialSetting } from '../schemas/power.js';
import { Process } from '../schemas/process.js';

export interface RunExecutionFlag {
  /** Long flag name as typed, e.g. '--goal'. */
  readonly flag: string;
  /** Commander value placeholder, e.g. '<goal>'. Absent for booleans. */
  readonly valueHint?: string;
  /**
   * Whether a living doc may teach this flag. `--dry-run` is declared
   * but hard-rejected at parse time (see the fail-closed guard in
   * `parseExecutionArgs`), so no doc is allowed to teach it.
   */
  readonly docValid: boolean;
}

export const RUN_EXECUTION_FLAGS: readonly RunExecutionFlag[] = [
  { flag: '--goal', valueHint: '<goal>', docValid: true },
  { flag: '--why', valueHint: '<why>', docValid: true },
  { flag: '--process', valueHint: `<${Process.options.join('|')}>`, docValid: true },
  { flag: '--power', valueHint: `<${PowerDialSetting.options.join('|')}>`, docValid: true },
  { flag: '--tournament', valueHint: '[2|3|4]', docValid: true },
  { flag: '--autonomous', docValid: true },
  { flag: '--run-folder', valueHint: '<path>', docValid: true },
  { flag: '--fixture', valueHint: '<path>', docValid: true },
  { flag: '--flow-root', valueHint: '<path>', docValid: true },
  { flag: '--checkpoint-choice', valueHint: '<choice>', docValid: true },
  { flag: '--checkpoint-response', valueHint: '<response>', docValid: true },
  { flag: '--progress', valueHint: '<format>', docValid: true },
  // Declared so the parser owns the rejection message; never teachable.
  { flag: '--dry-run', docValid: false },
  { flag: '--include-untracked-content', docValid: true },
  // Restart cheapness: a prior crashed run's folder whose finished sub-run
  // fanout branches this fresh run reuses by structural address instead of
  // re-running. Fresh-run only; rejected on resume.
  { flag: '--reuse-children-from', valueHint: '<path>', docValid: true },
];
