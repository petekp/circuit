import {
  type RuntimeIndexedStep,
  requireRuntimeIndexedStep,
} from '../../flows/registries/runtime-index.js';
import type { RunFileRef } from '../domain/run-file.js';
import type { TraceEntry, TraceEntryInput } from '../domain/trace.js';
import type { RunContext } from './run-context.js';

export const RUN_PORT_NAMES = [
  'clock',
  'traceLog',
  'runFiles',
  'runDirectory',
  'progress',
  'connector',
  'childRun',
  'worktree',
  'selection',
] as const;

export type RunPortName = (typeof RUN_PORT_NAMES)[number];

export interface RunValue {
  readonly flow: RunContext['flow'];
  readonly packageIndex: RunContext['packageIndex'];
  readonly runId: RunContext['runId'];
  readonly goal: string;
  readonly manifestHash: string;
  readonly entryModeName?: string;
  readonly depth?: string;
  readonly axes?: RunContext['axes'];
  readonly activeStepAttempt?: number;
  readonly resumeCheckpoint?: RunContext['resumeCheckpoint'];
  // Run-wide context-pull delivery signal, projected so a compose writer can read
  // it via context.run. Absent on every run with delivery off (the default) and at
  // deep depth, keeping the projected value byte-identical to before this signal.
  readonly contextDeliveryActive?: boolean;
}

export interface ClockPort {
  readonly now: () => Date;
}

export interface TraceLogPort {
  load(): Promise<readonly TraceEntry[]>;
  append(input: TraceEntryInput): Promise<TraceEntry>;
  getAll(): readonly TraceEntry[];
}

export interface RunFilesPort {
  resolve(ref: RunFileRef | string): string;
  writeJson(ref: RunFileRef | string, value: unknown): Promise<string>;
  writeText(ref: RunFileRef | string, value: string): Promise<string>;
  readText(ref: RunFileRef | string): Promise<string>;
  readJson<T = unknown>(ref: RunFileRef | string): Promise<T>;
}

export interface RunDirectoryPort {
  readonly path: string;
}

export interface ProgressPort {
  readonly report?: RunContext['progress'];
}

export interface ConnectorPort {
  readonly relayConnector?: RunContext['relayConnector'];
  readonly relayer?: RunContext['relayer'];
}

export interface ChildRunPort {
  readonly executors?: RunContext['childExecutors'];
  readonly compiledFlowResolver?: RunContext['childCompiledFlowResolver'];
  readonly runner?: RunContext['childRunner'];
  readonly externalFiles: RunContext['externalFiles'];
}

export interface WorktreePort {
  readonly projectRoot?: string;
  readonly evidencePolicy?: RunContext['evidencePolicy'];
  readonly runner?: RunContext['worktreeRunner'];
  readonly gitReader?: RunContext['gitReader'];
}

export interface SelectionPort {
  readonly configLayers?: RunContext['selectionConfigLayers'];
}

export interface RunPorts {
  readonly clock: ClockPort;
  readonly traceLog: TraceLogPort;
  readonly runFiles: RunFilesPort;
  readonly runDirectory: RunDirectoryPort;
  readonly progress: ProgressPort;
  readonly connector: ConnectorPort;
  readonly childRun: ChildRunPort;
  readonly worktree: WorktreePort;
  readonly selection: SelectionPort;
}

export interface StepExecutionContext<Kind extends RuntimeIndexedStep['kind']> {
  readonly run: RunValue;
  readonly ports: RunPorts;
  readonly indexedStep: Extract<RuntimeIndexedStep, { readonly kind: Kind }>;
}

export function runValueFromContext(context: RunContext): RunValue {
  return {
    flow: context.flow,
    packageIndex: context.packageIndex,
    runId: context.runId,
    goal: context.goal,
    manifestHash: context.manifestHash,
    ...(context.entryModeName === undefined ? {} : { entryModeName: context.entryModeName }),
    ...(context.depth === undefined ? {} : { depth: context.depth }),
    ...(context.axes === undefined ? {} : { axes: context.axes }),
    ...(context.activeStepAttempt === undefined
      ? {}
      : { activeStepAttempt: context.activeStepAttempt }),
    ...(context.resumeCheckpoint === undefined
      ? {}
      : { resumeCheckpoint: context.resumeCheckpoint }),
    ...(context.contextDeliveryActive === undefined
      ? {}
      : { contextDeliveryActive: context.contextDeliveryActive }),
  };
}

export function runPortsFromContext(context: RunContext): RunPorts {
  return {
    clock: { now: context.now },
    traceLog: {
      load: () => context.trace.load(),
      append: (input) => context.trace.append(input),
      getAll: () => context.trace.getAll(),
    },
    runFiles: {
      resolve: (ref) => context.files.resolve(ref),
      writeJson: (ref, value) => context.files.writeJson(ref, value),
      writeText: (ref, value) => context.files.writeText(ref, value),
      readText: (ref) => context.files.readText(ref),
      readJson: <T = unknown>(ref: RunFileRef | string) => context.files.readJson<T>(ref),
    },
    runDirectory: { path: context.runDir },
    progress: {
      ...(context.progress === undefined ? {} : { report: context.progress }),
    },
    connector: {
      ...(context.relayConnector === undefined ? {} : { relayConnector: context.relayConnector }),
      ...(context.relayer === undefined ? {} : { relayer: context.relayer }),
    },
    childRun: {
      ...(context.childExecutors === undefined ? {} : { executors: context.childExecutors }),
      ...(context.childCompiledFlowResolver === undefined
        ? {}
        : { compiledFlowResolver: context.childCompiledFlowResolver }),
      ...(context.childRunner === undefined ? {} : { runner: context.childRunner }),
      externalFiles: context.externalFiles,
    },
    worktree: {
      ...(context.projectRoot === undefined ? {} : { projectRoot: context.projectRoot }),
      ...(context.gitReader === undefined ? {} : { gitReader: context.gitReader }),
      ...(context.evidencePolicy === undefined ? {} : { evidencePolicy: context.evidencePolicy }),
      ...(context.worktreeRunner === undefined ? {} : { runner: context.worktreeRunner }),
    },
    selection: {
      ...(context.selectionConfigLayers === undefined
        ? {}
        : { configLayers: context.selectionConfigLayers }),
    },
  };
}

export function stepExecutionContextFromContext<Kind extends RuntimeIndexedStep['kind']>(
  context: RunContext,
  stepId: string,
  kind: Kind,
): StepExecutionContext<Kind> {
  const run = runValueFromContext(context);
  return {
    run,
    ports: runPortsFromContext(context),
    indexedStep: requireRuntimeIndexedStep(run.packageIndex, stepId, kind),
  };
}
