import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { Command, CommanderError } from 'commander';
import { listCandidateRunFolders } from '../app/history/indexer.js';
import { catalogFlowIds } from '../flows/catalog.js';
import { resolveProjectId, stampMemoryManifest } from '../memory/project-identity.js';
import { appendProjectFact, forgetProjectFact, readProjectFacts } from '../memory/project-store.js';
import {
  CompiledFlowId,
  MemoryHintAppliesTo,
  type MemoryInputV0,
  MemoryInputV0 as MemoryInputV0Schema,
  type Ref,
  Ref as RefSchema,
} from '../schemas/index.js';
import { runsRoot } from '../shared/control-plane-paths.js';
import { commanderErrorMessage, namesSubcommand } from './commander-support.js';

// `circuit memory note|list|forget` — the operator-filed core of the cited-fact
// producer (Slice 5, phase 1). A note writes a `kind:"project"` MemoryInputV0
// record to the local project store (`.circuit/memory/project.v1.jsonl`) citing
// a real run artifact, prints a confirmation, and stamps the resolved project
// identity into the memory manifest as provenance. Operator-filed facts enter
// `action:"recorded"`-equivalent authority directly (the operator is the source
// of authority, D2) but remain hint-only and stale-checkable like any other
// fact. The command itself does NOT write a RunMemoryUpdateEvent into a run
// envelope — that lives only inside RunEnvelopeRecord.memory_update_events,
// written exclusively at run close (phase 2).

type ParsedMemoryArgs =
  | {
      readonly command: 'note';
      readonly json: boolean;
      readonly flow: string;
      readonly appliesTo: MemoryHintAppliesTo;
      readonly text: string;
      readonly runsBase?: string;
      readonly memoryDir?: string;
      readonly runFolder?: string;
    }
  | {
      readonly command: 'list';
      readonly json: boolean;
      readonly flow?: string;
      readonly runsBase?: string;
      readonly memoryDir?: string;
    }
  | {
      readonly command: 'forget';
      readonly json: boolean;
      readonly memoryId: string;
      readonly runsBase?: string;
      readonly memoryDir?: string;
    };

export interface RunMemoryCommandOptions {
  readonly now?: () => Date;
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function parseMemoryArgs(argv: readonly string[]): ParsedMemoryArgs | string {
  let parsed: ParsedMemoryArgs | undefined;
  const program = new Command('circuit memory')
    .exitOverride()
    .configureOutput({ writeErr: () => {} });

  program
    .command('note')
    .argument('<text...>')
    .requiredOption('--flow <flow-id>')
    .option('--applies-to <kind>', 'hint category', 'operator_note')
    .option('--json')
    .option('--runs-base <path>')
    .option('--memory-dir <path>')
    .option('--run-folder <path>', 'cite a specific run folder instead of the latest')
    .action(
      (
        textParts: string[],
        options: {
          flow: string;
          appliesTo?: string;
          json?: boolean;
          runsBase?: string;
          memoryDir?: string;
          runFolder?: string;
        },
      ) => {
        const appliesTo = options.appliesTo ?? 'operator_note';
        if (!MemoryHintAppliesTo.safeParse(appliesTo).success) {
          throw new Error(`--applies-to must be one of ${MemoryHintAppliesTo.options.join(', ')}`);
        }
        if (!CompiledFlowId.safeParse(options.flow).success) {
          throw new Error('--flow must be a valid flow id');
        }
        // `CompiledFlowId` only validates the slug shape; a well-formed but
        // unknown id (a typo or a renamed flow) would otherwise be persisted
        // under a flow recall can never match. Reject it like an unknown
        // --applies-to so the asymmetry the surface test found is closed.
        if (!catalogFlowIds.includes(options.flow)) {
          throw new Error(`--flow must be one of ${catalogFlowIds.join(', ')}`);
        }
        const text = textParts.join(' ').trim();
        if (text.length === 0) throw new Error('note text must be non-empty');
        parsed = {
          command: 'note',
          json: options.json === true,
          flow: options.flow,
          appliesTo: appliesTo as MemoryHintAppliesTo,
          text,
          ...(options.runsBase === undefined ? {} : { runsBase: options.runsBase }),
          ...(options.memoryDir === undefined ? {} : { memoryDir: options.memoryDir }),
          ...(options.runFolder === undefined ? {} : { runFolder: options.runFolder }),
        };
      },
    );

  program
    .command('list')
    .option('--flow <flow-id>')
    .option('--json')
    .option('--runs-base <path>')
    .option('--memory-dir <path>')
    .action((options: { flow?: string; json?: boolean; runsBase?: string; memoryDir?: string }) => {
      parsed = {
        command: 'list',
        json: options.json === true,
        ...(options.flow === undefined ? {} : { flow: options.flow }),
        ...(options.runsBase === undefined ? {} : { runsBase: options.runsBase }),
        ...(options.memoryDir === undefined ? {} : { memoryDir: options.memoryDir }),
      };
    });

  program
    .command('forget')
    .argument('<memory-id>')
    .option('--json')
    .option('--runs-base <path>')
    .option('--memory-dir <path>')
    .action(
      (memoryId: string, options: { json?: boolean; runsBase?: string; memoryDir?: string }) => {
        parsed = {
          command: 'forget',
          json: options.json === true,
          memoryId,
          ...(options.runsBase === undefined ? {} : { runsBase: options.runsBase }),
          ...(options.memoryDir === undefined ? {} : { memoryDir: options.memoryDir }),
        };
      },
    );

  try {
    program.parse(argv, { from: 'user' });
  } catch (err) {
    if (err instanceof CommanderError) {
      // `-h`/`--help` prints help and exits cleanly.
      if (err.code === 'commander.helpDisplayed') process.exit(0);
      // Invoking `circuit memory` with no subcommand makes commander emit its
      // help via an error (code `commander.help`, message `(outputHelp)`) before
      // any action runs. Surface the intended hint instead of leaking the raw
      // commander token (F-L-1).
      if (err.code === 'commander.help') {
        return 'memory requires a subcommand: note, list, or forget';
      }
    }
    // A flag typed before any subcommand is Commander's "unknown option", and
    // that is the wrong complaint twice over: the option belongs to a
    // subcommand, and the subcommand is what is missing. Once one is named,
    // the option message is about that subcommand and stands.
    if (!namesSubcommand(argv)) return 'memory requires a subcommand: note, list, or forget';
    return commanderErrorMessage(err);
  }
  if (parsed === undefined) return 'memory requires a subcommand: note, list, or forget';
  return parsed;
}

// Resolve a real run artifact to cite. Prefers the run envelope (a report ref
// with sha256), then the result report, then the trace file (a trace ref). The
// returned ref carries the flow_id so readProjectFacts({flowId}) can scope it.
function resolveNoteSource(input: {
  readonly runFolder: string;
  readonly flowId: string;
}): { readonly ref: Ref; readonly sha256: string } | undefined {
  const candidates: { readonly rel: string; readonly kind: 'report' | 'trace' }[] = [
    { rel: 'reports/run-envelope.json', kind: 'report' },
    { rel: 'reports/result.json', kind: 'report' },
  ];
  for (const candidate of candidates) {
    const abs = join(input.runFolder, candidate.rel);
    if (!existsSync(abs)) continue;
    const sha256 = sha256Text(readFileSync(abs, 'utf8'));
    const ref = RefSchema.parse({
      kind: candidate.kind,
      ref: candidate.rel,
      sha256,
      flow_id: input.flowId,
    });
    return { ref, sha256 };
  }
  // Trace fallback: a trace ref keys on run_id+sequence and carries no
  // ref.sha256; cite sequence 0 (the bootstrap) with the trace file hash on
  // source.sha256. Only reachable when neither report exists.
  const tracePath = join(input.runFolder, 'trace.ndjson');
  if (existsSync(tracePath)) {
    const runId = basename(input.runFolder);
    const sha256 = sha256Text(readFileSync(tracePath, 'utf8'));
    const trace = RefSchema.safeParse({
      kind: 'trace',
      ref: 'trace.ndjson#sequence=0',
      run_id: runId,
      flow_id: input.flowId,
      sequence: 0,
    });
    if (trace.success) return { ref: trace.data, sha256 };
  }
  return undefined;
}

function buildOperatorNote(input: {
  readonly flowId: string;
  readonly appliesTo: MemoryHintAppliesTo;
  readonly text: string;
  readonly source: { readonly ref: Ref; readonly sha256: string };
  readonly capturedAt: string;
}): MemoryInputV0 {
  // A stable-but-distinct id per note: hash the flow, category, text, and the
  // cited source sha so two identical notes against the same source derive the
  // SAME memory_id (and `appendProjectFact` upserts on that id, so re-filing an
  // identical note is idempotent — it replaces rather than duplicates) while
  // genuinely distinct notes derive distinct ids.
  const basis = `${input.flowId}\u0000${input.appliesTo}\u0000${input.text}\u0000${input.source.sha256}`;
  const memoryId = `project-note-${sha256Text(basis).slice(0, 16)}`;
  // A trace ref carries no ref.sha256, so bind source.sha256 to ref.sha256 only
  // when the cited ref actually carries one (a report ref); otherwise the trace
  // file hash sits on source.sha256 and the equality refine does not fire.
  const sourceSha = input.source.ref.sha256 ?? input.source.sha256;
  return MemoryInputV0Schema.parse({
    schema_version: 1,
    memory_id: memoryId,
    kind: 'project',
    source: {
      ref: input.source.ref,
      captured_at: input.capturedAt,
      sha256: sourceSha,
    },
    summary: input.text,
    hints: [
      {
        id: `operator-note-${sha256Text(memoryId).slice(0, 12)}`,
        text: input.text,
        applies_to: input.appliesTo,
      },
    ],
    // Operator-filed facts are verified at capture against a present, hashed
    // source; the injection path re-checks freshness later.
    staleness: {
      status: 'fresh',
      checked_at: input.capturedAt,
      reason_codes: ['source_hash_verified'],
    },
    authority: 'hint_only',
  });
}

function factSummary(record: MemoryInputV0): Record<string, unknown> {
  return {
    memory_id: record.memory_id,
    kind: record.kind,
    summary: record.summary,
    applies_to: record.hints[0]?.applies_to,
    flow_id: record.source.ref.flow_id ?? null,
    source_ref: { kind: record.source.ref.kind, ref: record.source.ref.ref },
    staleness: record.staleness.status,
  };
}

export async function runMemoryCommand(
  argv: readonly string[],
  options: RunMemoryCommandOptions = {},
): Promise<number> {
  const parsed = parseMemoryArgs(argv);
  if (typeof parsed === 'string') {
    process.stderr.write(`error: ${parsed}\n`);
    return 2;
  }
  const now = options.now ?? (() => new Date());
  // The store + identity both key off the memory dir (the local store IS the
  // project scope, D1) and the repo root (git-remote inference). repoRoot
  // defaults to cwd; memoryDir, when supplied, wins.
  const storeOptions = parsed.memoryDir === undefined ? {} : { memoryDir: parsed.memoryDir };

  try {
    if (parsed.command === 'note') {
      const runFolder = parsed.runFolder ?? latestRunFolder(parsed.runsBase);
      if (runFolder === undefined) {
        process.stderr.write(
          'error: no run folder to cite; run a flow first or pass --run-folder\n',
        );
        return 2;
      }
      const source = resolveNoteSource({ runFolder, flowId: parsed.flow });
      if (source === undefined) {
        process.stderr.write(
          `error: run folder has no citable artifact (run-envelope, result, or trace): ${runFolder}\n`,
        );
        return 2;
      }
      const record = buildOperatorNote({
        flowId: parsed.flow,
        appliesTo: parsed.appliesTo,
        text: parsed.text,
        source,
        capturedAt: now().toISOString(),
      });
      appendProjectFact(record, storeOptions);
      // Stamp the resolved project identity once (provenance for a future
      // cross-worktree shared store). The unstable warning surfaces in output.
      const resolved = resolveProjectId(storeOptions);
      stampMemoryManifest(resolved, storeOptions);
      const payload = {
        recorded: true,
        memory_id: record.memory_id,
        flow_id: parsed.flow,
        project_id: resolved.projectId,
        project_id_source: resolved.source,
        source_ref: { kind: record.source.ref.kind, ref: record.source.ref.ref },
        warnings: resolved.warnings.map((warning) => ({
          code: warning.code,
          message: warning.message,
        })),
      };
      if (parsed.json) {
        writeJson(payload);
      } else {
        process.stdout.write(
          `Recorded project memory ${record.memory_id} for flow ${parsed.flow} (project ${resolved.projectId}, citing ${record.source.ref.kind} ${record.source.ref.ref}).\n`,
        );
        for (const warning of resolved.warnings) {
          process.stdout.write(`warning: ${warning.message}\n`);
        }
      }
      return 0;
    }

    if (parsed.command === 'list') {
      const { facts, warnings } = readProjectFacts({
        ...(parsed.memoryDir === undefined ? {} : { memoryDir: parsed.memoryDir }),
        ...(parsed.flow === undefined ? {} : { flowId: parsed.flow }),
      });
      const payload = {
        count: facts.length,
        facts: facts.map(factSummary),
        warnings: warnings.map((warning) => ({
          code: warning.code,
          message: warning.message,
          line: warning.line,
        })),
      };
      if (parsed.json) {
        writeJson(payload);
      } else if (facts.length === 0) {
        // Endings point forward: name the command that records the first fact.
        process.stdout.write(
          'No project memory recorded. Record one with: circuit memory note "<what you learned>" --flow <flow-id>\n',
        );
      } else {
        for (const fact of facts) {
          process.stdout.write(
            `${fact.memory_id} [${fact.source.ref.flow_id ?? 'no-flow'}] ${fact.summary}\n`,
          );
        }
      }
      return 0;
    }

    // forget
    const result = forgetProjectFact(parsed.memoryId, {
      ...(parsed.memoryDir === undefined ? {} : { memoryDir: parsed.memoryDir }),
    });
    const payload = { forgotten: result.removed, memory_id: parsed.memoryId };
    if (parsed.json) {
      writeJson(payload);
    } else if (result.removed) {
      process.stdout.write(`Forgot project memory ${parsed.memoryId}.\n`);
    } else {
      process.stdout.write(`No project memory with id ${parsed.memoryId}.\n`);
    }
    return result.removed ? 0 : 1;
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

// The latest run folder by ascending basename order (matching the history
// indexer's ordering); the last entry is the most recent. Returns undefined
// when there is no runs base or no run folder.
function latestRunFolder(runsBase: string | undefined): string | undefined {
  const base = runsBase ?? runsRoot(process.cwd());
  try {
    const folders = listCandidateRunFolders(base);
    return folders.length === 0 ? undefined : folders[folders.length - 1];
  } catch {
    return undefined;
  }
}
