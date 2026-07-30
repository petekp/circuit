import { resolve } from 'node:path';
import { Command } from 'commander';
import { healClosedRunResult } from '../app/run-status/projection-common.js';
import {
  RunStatusFolderError,
  projectRunStatusFromRunFolder,
} from '../app/run-status/run-folder-projector.js';
import { discoverRunsList, renderRunsList } from '../app/runs-list/list.js';
import { type EngineErrorCodeV1, EngineErrorV1 } from '../schemas/run-status.js';
import { runsRoot } from '../shared/control-plane-paths.js';
import {
  commanderErrorMessage,
  configureCommanderProgram,
  isCommanderHelpSignal,
} from './commander-support.js';

function engineError(input: {
  readonly code: EngineErrorCodeV1;
  readonly message: string;
  readonly runFolder?: string;
}): EngineErrorV1 {
  return EngineErrorV1.parse({
    api_version: 'engine-error-v1',
    schema_version: 1,
    error: {
      code: input.code,
      message: input.message,
    },
    ...(input.runFolder === undefined ? {} : { run_folder: input.runFolder }),
  });
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function invalidInvocation(message: string, runFolder?: string): number {
  writeJson(
    engineError({
      code: 'invalid_invocation',
      message,
      ...(runFolder === undefined ? {} : { runFolder }),
    }),
  );
  return 2;
}

function parseShowArgs(argv: readonly string[]): { readonly runFolder: string } | string {
  let showOptions: { json?: boolean; runFolder?: string } | undefined;
  const program = configureCommanderProgram(new Command('circuit runs'));
  const show = program
    .command('show')
    .option('--json')
    .option('--run-folder <path>')
    .action(() => {
      showOptions = show.opts<{ json?: boolean; runFolder?: string }>();
    });
  try {
    program.parse(argv, { from: 'user' });
  } catch (err) {
    if (!isCommanderHelpSignal(err)) return commanderErrorMessage(err);
  }

  if (showOptions === undefined) {
    return 'runs show requires --run-folder <path> --json';
  }

  if (showOptions.json !== true) return 'runs show requires --json';
  if (showOptions.runFolder === undefined) return '--run-folder is required';
  return { runFolder: showOptions.runFolder };
}

interface ParsedListArgs {
  readonly runsBase: string;
  readonly json: boolean;
}

function parseListArgs(argv: readonly string[]): ParsedListArgs | string {
  let options: { json?: boolean; projectRoot?: string; runsBase?: string } | undefined;
  const program = configureCommanderProgram(new Command('circuit runs'))
    .option('--json')
    .option('--project-root <path>')
    .option('--runs-base <path>')
    .allowExcessArguments(false)
    .action(() => {
      options = program.opts<{ json?: boolean; projectRoot?: string; runsBase?: string }>();
    });
  try {
    program.parse(argv, { from: 'user' });
  } catch (err) {
    return commanderErrorMessage(err);
  }
  if (options === undefined) return 'runs could not parse its arguments';

  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const runsBase =
    options.runsBase === undefined ? runsRoot(projectRoot) : resolve(options.runsBase);
  return { runsBase, json: options.json === true };
}

/**
 * Bare `circuit runs` is the recent-runs listing; `circuit runs show` stays
 * the per-folder detail projection.
 */
export async function runRunsCommand(argv: readonly string[]): Promise<number> {
  if (argv[0] !== 'show') {
    const parsed = parseListArgs(argv);
    if (typeof parsed === 'string') return invalidInvocation(parsed);
    const list = discoverRunsList({ runsRoot: parsed.runsBase });
    if (parsed.json) {
      writeJson({
        api_version: 'runs-list-v1',
        schema_version: 1,
        runs_root: list.runs_root,
        rows: list.rows,
      });
    } else {
      process.stdout.write(`${renderRunsList(list)}\n`);
    }
    return 0;
  }

  const parsed = parseShowArgs(argv);
  if (typeof parsed === 'string') return invalidInvocation(parsed);

  try {
    // Heal-on-read: if a crash landed between the run.closed trace append and
    // the result.json write, rebuild result.json from the durable trace before
    // projecting, so `circuit runs show` self-repairs and surfaces result_path
    // instead of silently omitting it. Idempotent and safe for healthy and open
    // runs; a heal failure never breaks the read.
    await healClosedRunResult(parsed.runFolder);
    writeJson(projectRunStatusFromRunFolder(parsed.runFolder));
    return 0;
  } catch (err) {
    if (err instanceof RunStatusFolderError) {
      writeJson(
        engineError({
          code: err.code,
          message: err.message,
          runFolder: err.runFolder,
        }),
      );
      return 1;
    }
    writeJson(
      engineError({
        code: 'internal_error',
        message: err instanceof Error ? err.message : String(err),
        runFolder: parsed.runFolder,
      }),
    );
    return 1;
  }
}
