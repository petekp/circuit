// Continuity record persistence and control-plane path layout. Extracted
// from src/cli/handoff.ts; the CLI actions (save/resume/done) stay there
// and call into this module.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { CompiledFlow } from '../../schemas/compiled-flow.js';
import {
  ContinuityIndex,
  type ContinuityIndex as ContinuityIndexValue,
  ContinuityRecord,
  type ContinuityRecord as ContinuityRecordValue,
} from '../../schemas/continuity.js';
import type { ControlPlaneFileStem } from '../../schemas/scalars.js';
import type { Snapshot, SnapshotStatus } from '../../schemas/snapshot.js';
import { readManifestSnapshot } from '../../shared/manifest-snapshot.js';
import { projectRunStatusFromRunFolder } from '../run-status/run-folder-projector.js';

export const DEFAULT_CONTROL_PLANE = '.circuit';

export function resolveProjectRootArg(args: { readonly projectRoot?: string }): string {
  return resolve(args.projectRoot ?? process.cwd());
}

/** The slice of the handoff CLI arguments that record construction reads. */
export interface BuildRecordArgs {
  readonly goal?: string;
  readonly next?: string;
  readonly stateMarkdown?: string;
  readonly debtMarkdown?: string;
  readonly runFolder?: string;
  readonly recordId?: string;
  readonly createdAt?: string;
  readonly projectRoot?: string;
}

export function continuityRoot(controlPlane: string): string {
  return resolve(controlPlane, 'continuity');
}

export function recordsRoot(controlPlane: string): string {
  return join(continuityRoot(controlPlane), 'records');
}

export function indexPath(controlPlane: string): string {
  return join(continuityRoot(controlPlane), 'index.json');
}

export function recordPath(controlPlane: string, recordId: string): string {
  return join(recordsRoot(controlPlane), `${recordId}.json`);
}

function utilityReportsRoot(controlPlane: string): string {
  return join(continuityRoot(controlPlane), 'reports');
}

export function handoffResultPath(controlPlane: string, action: string): string {
  return join(utilityReportsRoot(controlPlane), `${action}-result.json`);
}

export function operatorSummaryPath(controlPlane: string): string {
  return join(utilityReportsRoot(controlPlane), 'operator-summary.md');
}

function activeRunPath(controlPlane: string): string {
  return join(controlPlane, 'active-run.md');
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Atomic JSON write: stage to a sibling temp file, then rename over the
 * target. Rename is atomic within a filesystem, so a concurrent reader sees
 * either the old file or the new one, never a torn half-write. The ambient
 * harvest fires on every Stop, so torn writes are a real risk without this.
 */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const staging = `${path}.${randomUUID()}.tmp`;
  writeFileSync(staging, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(staging, path);
}

export function writeMarkdown(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value.endsWith('\n') ? value : `${value}\n`);
}

function stageForCurrentStep(flow: CompiledFlow, currentStep: string): string {
  const stage = flow.stages.find((candidate) => candidate.steps.includes(currentStep as never));
  return stage?.canonical ?? stage?.id ?? 'frame';
}

function snapshotStatusFromRunStatus(
  status: ReturnType<typeof projectRunStatusFromRunFolder>,
): SnapshotStatus {
  switch (status.engine_state) {
    case 'open':
    case 'waiting_checkpoint':
      return 'in_progress';
    case 'completed':
      return status.terminal_outcome;
    case 'aborted':
      return 'aborted';
    case 'invalid':
      throw new Error('cannot save run-backed continuity: run status is invalid');
  }
}

function loadRunBackedSnapshot(runFolder: string): {
  readonly snapshot: Pick<
    Snapshot,
    'run_id' | 'invocation_id' | 'current_step' | 'status' | 'updated_at'
  >;
  readonly currentStage: string;
} {
  const status = projectRunStatusFromRunFolder(runFolder);
  if (status.engine_state === 'invalid') {
    throw new Error(`cannot save run-backed continuity: ${status.error.message}`);
  }
  const manifest = readManifestSnapshot(runFolder);
  const flow = CompiledFlow.parse(
    JSON.parse(Buffer.from(manifest.bytes_base64, 'base64').toString('utf8')),
  );
  const currentStep =
    ('current_step' in status ? status.current_step?.step_id : undefined) ?? flow.starts_at;
  if (currentStep === undefined) {
    throw new Error(`cannot save run-backed continuity: ${runFolder} has no current step`);
  }
  const updatedAt = status.last_event?.timestamp;
  if (updatedAt === undefined) {
    throw new Error(`cannot save run-backed continuity: ${runFolder} has no latest event`);
  }
  return {
    snapshot: {
      run_id: status.run_id,
      current_step: currentStep,
      status: snapshotStatusFromRunStatus(status),
      updated_at: updatedAt,
    },
    currentStage: stageForCurrentStep(flow, currentStep),
  };
}

export function buildRecord(args: BuildRecordArgs, now: () => Date): ContinuityRecordValue {
  if (args.goal === undefined || args.goal.length === 0) {
    throw new Error('--goal is required when saving handoff continuity');
  }
  if (args.next === undefined || args.next.length === 0) {
    throw new Error('--next is required when saving handoff continuity');
  }
  const projectRoot = resolveProjectRootArg(args);
  const createdAt = args.createdAt ?? now().toISOString();
  const recordId = (args.recordId ?? `continuity-${randomUUID()}`) as ControlPlaneFileStem;
  const base = {
    schema_version: 1 as const,
    record_id: recordId,
    project_root: projectRoot,
    created_at: createdAt,
    git: { cwd: projectRoot },
    narrative: {
      goal: args.goal,
      next: args.next,
      state_markdown: args.stateMarkdown ?? '- No extra session state was provided.',
      debt_markdown: args.debtMarkdown ?? '- No open debt was recorded.',
    },
  };

  if (args.runFolder === undefined) {
    return ContinuityRecord.parse({
      ...base,
      continuity_kind: 'standalone',
      resume_contract: {
        mode: 'resume_standalone',
        auto_resume: false,
        requires_explicit_resume: true,
      },
    });
  }

  const runFolder = resolve(args.runFolder);
  const { snapshot, currentStage } = loadRunBackedSnapshot(runFolder);
  if (snapshot.current_step === undefined) {
    throw new Error(`cannot save run-backed continuity: ${runFolder} has no current step`);
  }
  return ContinuityRecord.parse({
    ...base,
    continuity_kind: 'run-backed',
    run_ref: {
      run_id: snapshot.run_id,
      ...(snapshot.invocation_id === undefined ? {} : { invocation_id: snapshot.invocation_id }),
      current_stage: currentStage,
      current_step: snapshot.current_step,
      runtime_status: snapshot.status,
      runtime_updated_at: snapshot.updated_at,
    },
    resume_contract: {
      mode: 'resume_run',
      auto_resume: false,
      requires_explicit_resume: true,
    },
  });
}

export function summaryForRecord(record: ContinuityRecordValue, source: string): string {
  return [
    '# Circuit Handoff',
    '',
    `Source: ${source}`,
    `Record: ${record.record_id}`,
    `Kind: ${record.continuity_kind}`,
    '',
    '## Goal',
    record.narrative.goal,
    '',
    '## Next Action',
    record.narrative.next,
    '',
    '## State',
    record.narrative.state_markdown,
    '',
    '## Debt',
    record.narrative.debt_markdown,
  ].join('\n');
}

export function writeActiveRun(
  controlPlane: string,
  record: ContinuityRecordValue,
): string | undefined {
  if (record.continuity_kind !== 'run-backed') return undefined;
  const path = activeRunPath(controlPlane);
  writeMarkdown(
    path,
    [
      '# Active Circuit Run',
      '',
      `Run: ${record.run_ref.run_id}`,
      `Status: ${record.run_ref.runtime_status}`,
      `Stage: ${record.run_ref.current_stage}`,
      `Step: ${record.run_ref.current_step}`,
      '',
      `Next: ${record.narrative.next}`,
    ].join('\n'),
  );
  return path;
}

export function readJsonSafely(path: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, 'utf8')) };
  } catch {
    return { ok: false };
  }
}

export function readContinuityIndexOrNull(controlPlane: string): ContinuityIndexValue | null {
  const indexAbs = indexPath(controlPlane);
  if (!existsSync(indexAbs)) return null;
  const raw = readJsonSafely(indexAbs);
  if (!raw.ok) return null;
  const parsed = ContinuityIndex.safeParse(raw.value);
  return parsed.success ? parsed.data : null;
}
