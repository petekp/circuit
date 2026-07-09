import { readFileSync } from 'node:fs';
import { lstat, mkdir, readdir } from 'node:fs/promises';
import type { CompiledFlowProgressSurface } from '../../flows/types.js';
import {
  controlPlaneRootFromDescendant,
  ensureCircuitGitignore,
} from '../../shared/control-plane-gitignore.js';
import type { ProgressReporter } from '../../shared/relay-runtime-types.js';
import type { RunFileRef } from '../domain/run-file.js';
import type { TraceEntry } from '../domain/trace.js';
import type { ExecutableFlow } from '../manifest/executable-flow.js';
import { createProgressProjector } from '../projections/progress.js';
import { validateReportValue } from '../run-files/report-validator.js';
import { RunFileStore } from '../run-files/run-file-store.js';
import { TraceStore } from '../trace/trace-store.js';
import { type ExternalFileReader, nodeExternalFileReader } from './external-files.js';
import type {
  ClockPort,
  ProgressPort,
  RunDirectoryPort,
  RunFilesPort,
  TraceLogPort,
} from './run-values.js';

export interface OpenRunBoundaryOptions {
  readonly runDir: string;
  readonly isResume: boolean;
  readonly runId: string;
  readonly flow: ExecutableFlow;
  readonly now?: () => Date;
  readonly progress?: ProgressReporter;
  readonly progressSurface?: CompiledFlowProgressSurface;
}

export interface RunBoundary {
  readonly runDirectory: RunDirectoryPort;
  readonly clock: ClockPort;
  readonly files: RunFileStore;
  readonly runFiles: RunFilesPort;
  readonly trace: TraceStore;
  readonly traceLog: TraceLogPort;
  readonly externalFiles: ExternalFileReader;
  readonly progress: ProgressPort;
  readonly existingTrace: readonly TraceEntry[];
}

async function assertFreshRunDir(runDir: string): Promise<void> {
  let stat: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    stat = await lstat(runDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(runDir, { recursive: true });
    stat = await lstat(runDir);
  }
  if (stat.isSymbolicLink()) {
    throw new Error('runtime baseline requires a fresh run directory; existing path is a symlink');
  }
  if (!stat.isDirectory()) {
    throw new Error(
      'runtime baseline requires a fresh run directory; existing path is not a directory',
    );
  }
  const entries = await readdir(runDir);
  if (entries.length > 0) {
    throw new Error(
      `runtime baseline requires a fresh run directory; existing directory is not empty (${entries.join(', ')})`,
    );
  }
}

function runFilesPortFromStore(store: RunFileStore): RunFilesPort {
  return {
    resolve: (ref) => store.resolve(ref),
    writeJson: (ref, value) => store.writeJson(ref, value),
    writeText: (ref, value) => store.writeText(ref, value),
    readText: (ref) => store.readText(ref),
    readJson: <T = unknown>(ref: RunFileRef | string) => store.readJson<T>(ref),
  };
}

function traceLogPortFromStore(store: TraceStore): TraceLogPort {
  return {
    load: () => store.load(),
    append: (input) => store.append(input),
    getAll: () => store.getAll(),
  };
}

export async function openRunBoundary(options: OpenRunBoundaryOptions): Promise<RunBoundary> {
  if (!options.isResume) {
    await assertFreshRunDir(options.runDir);
  } else {
    await mkdir(options.runDir, { recursive: true });
  }

  // Machine-write privacy (M3): a run creates `.circuit/runs/<id>` before any
  // ambient harvest runs — and on hosts without continuity hooks a harvest may
  // never run at all — so the run-open seam seeds `.circuit/.gitignore` too.
  // It no-ops for a run directory that does not live under a `.circuit` control
  // plane (a test's temp dir), and never clobbers a user's own ignore file.
  const controlPlane = controlPlaneRootFromDescendant(options.runDir);
  if (controlPlane !== undefined) {
    ensureCircuitGitignore(controlPlane);
  }

  const clock = { now: options.now ?? (() => new Date()) };
  const progressProjector = createProgressProjector({
    progress: options.progress,
    runDir: options.runDir,
    runId: options.runId,
    flow: options.flow,
    files: {
      readText(path) {
        try {
          return readFileSync(path, 'utf8');
        } catch {
          return undefined;
        }
      },
    },
    ...(options.progressSurface === undefined ? {} : { progressSurface: options.progressSurface }),
  });
  const trace = new TraceStore(options.runDir, {
    now: clock.now,
    onAppend: progressProjector,
  });
  const existingTrace = await trace.load();
  if (!options.isResume && existingTrace.length > 0) {
    throw new Error('runtime baseline requires a fresh run directory');
  }
  if (options.isResume && existingTrace.length === 0) {
    throw new Error('runtime resume requires an existing trace');
  }
  if (options.isResume && existingTrace.some((entry) => entry.kind === 'run.closed')) {
    throw new Error('runtime resume rejected: run is already closed');
  }

  const files = new RunFileStore(options.runDir, validateReportValue);
  return {
    runDirectory: { path: options.runDir },
    clock,
    files,
    runFiles: runFilesPortFromStore(files),
    trace,
    traceLog: traceLogPortFromStore(trace),
    externalFiles: nodeExternalFileReader,
    progress: {
      ...(options.progress === undefined ? {} : { report: options.progress }),
    },
    existingTrace,
  };
}
