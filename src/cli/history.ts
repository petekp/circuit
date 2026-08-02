import { basename } from 'node:path';
import { Command } from 'commander';
import {
  HistoryCommandError,
  type HistoryPathOptions,
  errorEnvelope,
  historyStatus,
  readHistoryManifest,
  rebuildHistoryIndex,
  resolveHistoryPaths,
} from '../app/history/indexer.js';
import { loadMemoryEffectReport } from '../app/history/memory-effect-read.js';
import { buildMemoryEffectReport, writeMemoryEffectReport } from '../app/history/memory-effect.js';
import { contentIdentityOf } from '../app/history/memory-identity.js';
import { buildMemoryMergeReport, writeMemoryMergeReport } from '../app/history/memory-merge.js';
import { historyMemoryInputPreview } from '../app/history/memory-preview.js';
import { appendPullLogEntry, readPullLog } from '../app/history/pull-log.js';
import { suppressMeasuredNegative } from '../app/history/pull-suppression.js';
import { queryHistory } from '../app/history/query.js';
import {
  HistoryDocumentKindV1,
  HistoryMemoryInputPreviewV1 as HistoryMemoryInputPreviewSchema,
  type HistoryMemoryInputPreviewV1,
  type PullLogEntryV1,
} from '../schemas/index.js';
import {
  commanderErrorMessage,
  configureCommanderProgram,
  isCommanderHelpSignal,
  namesSubcommand,
} from './commander-support.js';

type ParsedHistoryArgs =
  | {
      readonly command: 'rebuild';
      readonly json: boolean;
      readonly runsBase?: string;
      readonly indexDir?: string;
    }
  | {
      readonly command: 'query';
      readonly json: boolean;
      readonly query: string;
      readonly format: 'json' | 'memory-input';
      readonly limit?: number;
      readonly perRunLimit?: number;
      readonly runsBase?: string;
      readonly indexDir?: string;
      readonly flow?: string;
      readonly kind?: 'run' | 'report' | 'trace' | 'checkpoint';
      readonly rebuildIfStale: boolean;
    }
  | {
      readonly command: 'pull';
      readonly json: boolean;
      readonly query: string;
      // All three are required (validated post-parse): suppression keys on the
      // flow, the audit needs a decision-point label, and the log is written to
      // the run folder. A missing one is an invalid invocation (exit 2).
      readonly flow?: string;
      readonly decisionPoint?: string;
      readonly runFolder?: string;
      readonly limit?: number;
      readonly perRunLimit?: number;
      readonly runsBase?: string;
      readonly indexDir?: string;
      readonly rebuildIfStale: boolean;
    }
  | {
      readonly command: 'status';
      readonly json: boolean;
      readonly runsBase?: string;
      readonly indexDir?: string;
    }
  | {
      readonly command: 'memory-merge';
      readonly json: boolean;
      readonly runsBase?: string;
      readonly indexDir?: string;
      readonly write: boolean;
    }
  | {
      readonly command: 'memory-effect';
      readonly json: boolean;
      readonly runsBase?: string;
      readonly indexDir?: string;
      readonly write: boolean;
      readonly minArmSize?: number;
      readonly margin?: number;
    };

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

// A usage error before any work starts. Who is reading decides the shape: a
// caller that asked for JSON is parsing stdout and needs the envelope, and
// everyone else is a person at a terminal who should get the same plain
// `error:` line on stderr that every other circuit command gives them.
//
// The distinction is not cosmetic. `history commands require --json` was
// printed as JSON, which told the operator to pass a flag while demonstrating
// that the flag was not needed, and it put an error on stdout where a pipe
// would swallow it.
function invalidInvocation(
  message: string,
  input: { readonly json: boolean } & HistoryPathOptions,
): number {
  if (!input.json) {
    process.stderr.write(`error: ${message}\n`);
    return 2;
  }
  writeJson(
    errorEnvelope(
      new HistoryCommandError('invalid_invocation', message, {
        ...(input.runsBase === undefined ? {} : { runsBase: input.runsBase }),
        ...(input.indexDir === undefined ? {} : { indexDir: input.indexDir }),
      }),
    ),
  );
  return 2;
}

function operationalError(error: unknown): number {
  if (error instanceof HistoryCommandError) {
    writeJson(errorEnvelope(error));
    return error.code === 'invalid_invocation' ? 2 : 1;
  }
  writeJson(
    errorEnvelope(
      new HistoryCommandError(
        'internal_error',
        error instanceof Error ? error.message : String(error),
      ),
    ),
  );
  return 1;
}

function parsePositiveInteger(
  value: string | undefined,
  optionName: string,
): number | string | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return `${optionName} must be a positive integer`;
  return parsed;
}

// The D5 separation margin must satisfy 0 < margin <= 1. 0 is rejected (a tied
// comparison would satisfy both the positive and negative gate, leaving the
// verdict to evaluation order — a determinism hazard); > 1 can never fire.
function parseMargin(value: string | undefined): number | string | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    return '--margin must be greater than 0 and at most 1';
  }
  return parsed;
}

function parseHistoryArgs(argv: readonly string[]): ParsedHistoryArgs | string {
  let parsed: ParsedHistoryArgs | undefined;
  const program = configureCommanderProgram(new Command('circuit history'));

  program
    .command('rebuild')
    .option('--json')
    .option('--runs-base <path>')
    .option('--index-dir <path>')
    .action((options: { json?: boolean; runsBase?: string; indexDir?: string }) => {
      parsed = {
        command: 'rebuild',
        json: options.json === true,
        ...(options.runsBase === undefined ? {} : { runsBase: options.runsBase }),
        ...(options.indexDir === undefined ? {} : { indexDir: options.indexDir }),
      };
    });

  program
    .command('query')
    .argument('<query...>')
    .option('--json')
    .option('--format <json|memory-input>', 'output format', 'json')
    .option('--limit <n>')
    .option('--per-run-limit <n>')
    .option('--runs-base <path>')
    .option('--index-dir <path>')
    .option('--flow <flow-id>')
    .option('--kind <run|report|trace|checkpoint>')
    .option('--rebuild-if-stale')
    .action(
      (
        queryParts: string[],
        options: {
          json?: boolean;
          format?: string;
          limit?: string;
          perRunLimit?: string;
          runsBase?: string;
          indexDir?: string;
          flow?: string;
          kind?: string;
          rebuildIfStale?: boolean;
        },
      ) => {
        const format = options.format ?? 'json';
        if (format !== 'json' && format !== 'memory-input') {
          parsed = undefined;
          throw new Error('--format must be json or memory-input');
        }
        const limit = parsePositiveInteger(options.limit, '--limit');
        if (typeof limit === 'string') throw new Error(limit);
        const perRunLimit = parsePositiveInteger(options.perRunLimit, '--per-run-limit');
        if (typeof perRunLimit === 'string') throw new Error(perRunLimit);
        const kind = options.kind;
        if (kind !== undefined && !HistoryDocumentKindV1.safeParse(kind).success) {
          throw new Error('--kind must be run, report, trace, or checkpoint');
        }
        parsed = {
          command: 'query',
          json: options.json === true,
          query: queryParts.join(' '),
          format,
          ...(limit === undefined ? {} : { limit }),
          ...(perRunLimit === undefined ? {} : { perRunLimit }),
          ...(options.runsBase === undefined ? {} : { runsBase: options.runsBase }),
          ...(options.indexDir === undefined ? {} : { indexDir: options.indexDir }),
          ...(options.flow === undefined ? {} : { flow: options.flow }),
          ...(kind === undefined
            ? {}
            : { kind: kind as 'run' | 'report' | 'trace' | 'checkpoint' }),
          rebuildIfStale: options.rebuildIfStale === true,
        };
      },
    );

  program
    .command('pull')
    .argument('<query...>')
    .option('--json')
    .option('--flow <flow-id>')
    .option('--decision-point <label>')
    .option('--run-folder <path>')
    .option('--limit <n>')
    .option('--per-run-limit <n>')
    .option('--runs-base <path>')
    .option('--index-dir <path>')
    .option('--rebuild-if-stale')
    .action(
      (
        queryParts: string[],
        options: {
          json?: boolean;
          flow?: string;
          decisionPoint?: string;
          runFolder?: string;
          limit?: string;
          perRunLimit?: string;
          runsBase?: string;
          indexDir?: string;
          rebuildIfStale?: boolean;
        },
      ) => {
        const limit = parsePositiveInteger(options.limit, '--limit');
        if (typeof limit === 'string') throw new Error(limit);
        const perRunLimit = parsePositiveInteger(options.perRunLimit, '--per-run-limit');
        if (typeof perRunLimit === 'string') throw new Error(perRunLimit);
        parsed = {
          command: 'pull',
          json: options.json === true,
          query: queryParts.join(' '),
          ...(options.flow === undefined ? {} : { flow: options.flow }),
          ...(options.decisionPoint === undefined ? {} : { decisionPoint: options.decisionPoint }),
          ...(options.runFolder === undefined ? {} : { runFolder: options.runFolder }),
          ...(limit === undefined ? {} : { limit }),
          ...(perRunLimit === undefined ? {} : { perRunLimit }),
          ...(options.runsBase === undefined ? {} : { runsBase: options.runsBase }),
          ...(options.indexDir === undefined ? {} : { indexDir: options.indexDir }),
          rebuildIfStale: options.rebuildIfStale === true,
        };
      },
    );

  program
    .command('status')
    .option('--json')
    .option('--runs-base <path>')
    .option('--index-dir <path>')
    .action((options: { json?: boolean; runsBase?: string; indexDir?: string }) => {
      parsed = {
        command: 'status',
        json: options.json === true,
        ...(options.runsBase === undefined ? {} : { runsBase: options.runsBase }),
        ...(options.indexDir === undefined ? {} : { indexDir: options.indexDir }),
      };
    });

  program
    .command('memory-merge')
    .option('--json')
    .option('--runs-base <path>')
    .option('--index-dir <path>')
    .option('--write', 'also persist the report under <index-dir>/memory-merge.v1.json')
    .action(
      (options: { json?: boolean; runsBase?: string; indexDir?: string; write?: boolean }) => {
        parsed = {
          command: 'memory-merge',
          json: options.json === true,
          ...(options.runsBase === undefined ? {} : { runsBase: options.runsBase }),
          ...(options.indexDir === undefined ? {} : { indexDir: options.indexDir }),
          write: options.write === true,
        };
      },
    );

  program
    .command('memory-effect')
    .option('--json')
    .option('--runs-base <path>')
    .option('--index-dir <path>')
    .option('--write', 'also persist the report under <index-dir>/memory-effect.v1.json')
    .option('--min-arm-size <n>', 'minimum runs per arm before a verdict is eligible (default 2)')
    .option('--margin <0..1>', 'separation margin for a correlated verdict (default 0.5)')
    .action(
      (options: {
        json?: boolean;
        runsBase?: string;
        indexDir?: string;
        write?: boolean;
        minArmSize?: string;
        margin?: string;
      }) => {
        const minArmSize = parsePositiveInteger(options.minArmSize, '--min-arm-size');
        if (typeof minArmSize === 'string') throw new Error(minArmSize);
        const margin = parseMargin(options.margin);
        if (typeof margin === 'string') throw new Error(margin);
        parsed = {
          command: 'memory-effect',
          json: options.json === true,
          ...(options.runsBase === undefined ? {} : { runsBase: options.runsBase }),
          ...(options.indexDir === undefined ? {} : { indexDir: options.indexDir }),
          write: options.write === true,
          ...(minArmSize === undefined ? {} : { minArmSize }),
          ...(margin === undefined ? {} : { margin }),
        };
      },
    );

  try {
    program.parse(argv, { from: 'user' });
  } catch (err) {
    // Bare `circuit history` makes Commander raise its internal help error
    // ('(outputHelp)') before any action runs; fall through so the operator
    // sees the real missing-subcommand message below instead of the token.
    //
    // A flag with no subcommand lands here too, and Commander describes it as
    // an unknown option. That reads as a lie for `circuit history --json`,
    // where `--json` is not just known but required by every subcommand. When
    // no subcommand was named, none could have claimed the flags, so report
    // the thing that is actually missing. An argv that does name a subcommand
    // keeps Commander's own message: it is about that subcommand.
    if (!isCommanderHelpSignal(err) && namesSubcommand(argv)) return commanderErrorMessage(err);
  }

  if (parsed === undefined) {
    return 'history requires a subcommand: rebuild, query, pull, status, memory-merge, or memory-effect';
  }
  return parsed;
}

function pathOptions(parsed: ParsedHistoryArgs): HistoryPathOptions {
  return {
    ...(parsed.runsBase === undefined ? {} : { runsBase: parsed.runsBase }),
    ...(parsed.indexDir === undefined ? {} : { indexDir: parsed.indexDir }),
  };
}

// Project one pull result row from a surfaced memory input, computing the shared
// content_id via contentIdentityOf (Slice 3 D4) so pull-sourced and push-sourced
// memory share one identity space.
function pullLogResult(
  memory: HistoryMemoryInputPreviewV1['memory_inputs'][number],
): PullLogEntryV1['results'][number] {
  return {
    memory_input_id: memory.memory_id,
    content_id: contentIdentityOf(memory).contentId,
    staleness: memory.staleness.status,
    source_ref: memory.source.ref,
  };
}

// Compose the gated pull (D1/D2/D3): the existing query + preview, then the pure
// measured-negative suppression keyed on --flow, then an atomic pull-log append as
// a side effect. The log append is fail-soft — a logging failure surfaces a
// pull_log_unavailable warning in the printed preview but NEVER blocks the pull
// (orienting the agent outranks bookkeeping). Prints the (possibly trimmed)
// HistoryMemoryInputPreviewV1 and returns 0.
function runPull(parsed: Extract<ParsedHistoryArgs, { command: 'pull' }>): number {
  const flow = parsed.flow as string;
  const decisionPoint = parsed.decisionPoint as string;
  const runFolder = parsed.runFolder;

  const result = queryHistory({
    ...pathOptions(parsed),
    query: parsed.query,
    ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
    ...(parsed.perRunLimit === undefined ? {} : { perRunLimit: parsed.perRunLimit }),
    // Flow-scoped recall: the pull narrows candidates to the flow it suppresses on.
    flow,
    rebuildIfStale: parsed.rebuildIfStale,
  });
  const manifest = readHistoryManifest(resolveHistoryPaths(pathOptions(parsed)));
  const projected = historyMemoryInputPreview({
    query: result.query,
    indexState: result.index_state,
    rebuilt: result.rebuilt,
    warnings: result.warnings,
    hits: result.results,
    capturedAt: manifest.created_at,
  });

  // Load Slice 2's verdicts read-only and fail-open (same posture as Slice 3): a
  // missing/unreadable report suppresses nothing and carries an
  // effect_report_unavailable warning into the printed preview.
  const effect = loadMemoryEffectReport(resolveHistoryPaths(pathOptions(parsed)));
  const { preview: suppressed, suppressedCount } = suppressMeasuredNegative({
    preview: projected,
    flowId: flow,
    ...(effect.report === undefined ? {} : { effect: effect.report }),
  });

  // The audit append is a side effect of the pull (D2). effect_report_available is
  // built HERE (the per-pull flag the schema carries) — false means this pull's
  // suppression ran fail-open. pull_id is "pull-<next sequence>" over the prior log.
  const priorCount = runFolder === undefined ? 0 : (readPullLog(runFolder)?.entries.length ?? 0);
  const entry: PullLogEntryV1 = {
    pull_id: `pull-${priorCount + 1}`,
    recorded_at: new Date().toISOString(),
    decision_point: decisionPoint,
    query: parsed.query,
    flow_id: flow,
    result_count: suppressed.memory_inputs.length,
    suppressed_count: suppressedCount,
    effect_report_available: effect.report !== undefined,
    ...(effect.report === undefined
      ? {}
      : { effect_report_generated_at: effect.report.generated_at }),
    results: suppressed.memory_inputs.map(pullLogResult),
    authority: 'hint_only',
  };

  const logWarnings =
    runFolder === undefined
      ? [
          {
            code: 'pull_log_unavailable' as const,
            message: 'no --run-folder supplied; the pull returned results but was not logged',
          },
        ]
      : appendPullLogEntry(runFolder, {
          entry,
          // The pull-log header's run_id is the active run that pulled; derive it
          // from the run folder name (the run-folder layout convention).
          runId: basename(runFolder),
        }).warnings;

  // Surface any logging failure in the printed preview's warnings (fail-soft); the
  // suppression fail-open warnings ride along too. Re-validate the merged preview.
  const printed = HistoryMemoryInputPreviewSchema.parse({
    ...suppressed,
    warnings: [...suppressed.warnings, ...effect.warnings, ...logWarnings],
  });
  writeJson(printed);
  return 0;
}

export async function runHistoryCommand(argv: readonly string[]): Promise<number> {
  const parsed = parseHistoryArgs(argv);
  if (typeof parsed === 'string') {
    // Nothing parsed, so `parsed.json` does not exist yet. The literal flag is
    // the only evidence of who is reading.
    return invalidInvocation(parsed, { json: argv.includes('--json') });
  }
  if (!parsed.json) {
    // Naming the command back is the whole remedy. Without it the operator is
    // told a flag is missing and left to retype the line themselves.
    return invalidInvocation(
      `history commands require --json. Run \`circuit history ${parsed.command} --json\``,
      { json: false, ...pathOptions(parsed) },
    );
  }

  try {
    if (parsed.command === 'rebuild') {
      const index = rebuildHistoryIndex(pathOptions(parsed));
      writeJson(index.manifest);
      return 0;
    }
    if (parsed.command === 'status') {
      writeJson(historyStatus(pathOptions(parsed)));
      return 0;
    }
    if (parsed.command === 'memory-merge') {
      const report = buildMemoryMergeReport(pathOptions(parsed));
      if (parsed.write) {
        writeMemoryMergeReport(report, resolveHistoryPaths(pathOptions(parsed)));
      }
      writeJson(report);
      return 0;
    }
    if (parsed.command === 'memory-effect') {
      const report = buildMemoryEffectReport({
        ...pathOptions(parsed),
        ...(parsed.minArmSize === undefined ? {} : { minArmSize: parsed.minArmSize }),
        ...(parsed.margin === undefined ? {} : { margin: parsed.margin }),
      });
      if (parsed.write) {
        writeMemoryEffectReport(report, resolveHistoryPaths(pathOptions(parsed)));
      }
      writeJson(report);
      return 0;
    }
    if (parsed.command === 'pull') {
      // --flow and --decision-point are required: suppression keys on the flow
      // (D3) and the audit needs a label. A missing one is an invalid invocation
      // (exit 2), not an operational error.
      if (parsed.flow === undefined) {
        return invalidInvocation('history pull requires --flow', {
          json: true,
          ...pathOptions(parsed),
        });
      }
      if (parsed.decisionPoint === undefined) {
        return invalidInvocation('history pull requires --decision-point', {
          json: true,
          ...pathOptions(parsed),
        });
      }
      return runPull(parsed);
    }

    const result = queryHistory({
      ...pathOptions(parsed),
      query: parsed.query,
      ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
      ...(parsed.perRunLimit === undefined ? {} : { perRunLimit: parsed.perRunLimit }),
      ...(parsed.flow === undefined ? {} : { flow: parsed.flow }),
      ...(parsed.kind === undefined ? {} : { kind: parsed.kind }),
      rebuildIfStale: parsed.rebuildIfStale,
    });
    if (parsed.format === 'memory-input') {
      const manifest = readHistoryManifest(resolveHistoryPaths(pathOptions(parsed)));
      writeJson(
        historyMemoryInputPreview({
          query: result.query,
          indexState: result.index_state,
          rebuilt: result.rebuilt,
          warnings: result.warnings,
          hits: result.results,
          capturedAt: manifest.created_at,
        }),
      );
      return 0;
    }
    writeJson(result);
    return 0;
  } catch (error) {
    return operationalError(error);
  }
}
