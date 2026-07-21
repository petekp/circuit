export const PUBLIC_FLOWS: readonly string[];
export const PROCESS_LEVELS: readonly string[];
export const POWER_LEVELS: readonly string[];

export function parseStartArguments(value: unknown): Record<string, unknown>;
export function parseStatusArguments(value: unknown): {
  runId: string;
  afterCursor: number;
  maxEvents: number;
  waitMs: number;
};
export function parseResumeArguments(value: unknown): { runId: string; choice: string };
export function parseCancelArguments(value: unknown): { runId: string };

export function assertControlPlaneSafe(workspace: string): Promise<void>;
export function assertCodexOnlyConfigSummary(
  summary: unknown,
  flow: string,
  projectConfigPresent?: boolean,
): void;
export function interruptProcessTree(
  rootPid: number,
  graceMs?: number,
): Promise<{
  descendantPids: number[];
  enumerationSucceeded: boolean;
  remainingPids: number[];
  confirmed: boolean;
}>;

export interface CircuitLifecycleOptions {
  runtimePath: string;
  flowRoot: string;
  pluginRoot: string;
  stateRoot: string;
  baseEnv?: NodeJS.ProcessEnv;
  codexExecutable: string;
  host: {
    codex: CodexExecutablePin;
    codexHome: { path: string; source: string };
  };
  assets: PackagedAssetSnapshot;
  sealedState: { home: string; xdg_config_home: string; runs: string };
  proofRunner: string;
  supervisorPath?: string;
  verifyHost?: () => void | Promise<void>;
  verifyAssets?: () => void | Promise<void>;
  jobStore?: DurableJobStore;
  maxRunMs?: number;
  interruptGraceMs?: number;
}

export class CircuitLifecycle {
  constructor(options: CircuitLifecycleOptions);
  start(workspace: string, input: unknown): Promise<Record<string, unknown>>;
  status(workspace: string, input: unknown): Promise<Record<string, unknown>>;
  resume(workspace: string, input: unknown): Promise<Record<string, unknown>>;
  cancel(workspace: string, input: unknown): Promise<Record<string, unknown>>;
  shutdown(): Promise<void>;
}
import type { DurableJobStore } from './durable-job-store.mjs';
import type { CodexExecutablePin } from './host-discovery.mjs';
import type { PackagedAssetSnapshot } from './sealed-policy.mjs';
