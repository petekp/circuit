import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OperatorSummaryWriteResult } from '../app/operator-summary/writer.js';
import { writeProcessEvidenceProjection } from '../app/process-evidence/projection.js';
import {
  type WriteRunEnvelopeShadowRecordInput,
  writeRunEnvelopeShadowRecord,
} from '../app/run-envelope/shadow-record.js';
import {
  type WriteRunEnvelopeRecordInput,
  type WriteRunEnvelopeRecordResult,
  writeRunEnvelopeRecord as writeSourceRunEnvelopeRecord,
} from '../app/run-envelope/source-record.js';
import { findCompiledFlowPackageById } from '../flows/catalog.js';
// Post-run artifact emission for the run/resume execution paths.
//
// The four post-run artifacts (operator-summary, run-envelope-shadow,
// process-evidence, run-envelope) are written in a fixed order, each wrapped in
// tryPostRunArtifact so a single writer failure degrades to a recorded warning
// instead of aborting the run. The run-envelope is only written when process
// evidence succeeded (it consumes the projection result).
//
// This ordering + guard used to be inlined three times (closed run,
// checkpoint-waiting, resume), differing only in the child descriptor, the
// process-evidence projection, and whether a memory context is recorded. Owning
// it here closes the latent copy-divergence: the resume path passes
// memoryContext explicitly undefined rather than silently omitting it.
import type { ProcessEvidenceProjection as ProcessEvidenceProjectionValue } from '../schemas/process-evidence.js';

export type PostRunArtifactWarning = {
  readonly label: string;
  readonly message: string;
};

export type PostRunArtifactContext = {
  readonly progressJsonl: boolean;
  readonly warnings: PostRunArtifactWarning[];
};

export function tryPostRunArtifact<T>(
  label: string,
  context: PostRunArtifactContext,
  write: () => T,
): T | undefined {
  try {
    return write();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    context.warnings.push({ label, message });
    if (!context.progressJsonl) {
      process.stderr.write(`warning: post-run artifact ${label} failed: ${message}\n`);
    }
    return undefined;
  }
}

export function postRunArtifactWarningOutputFields(
  warnings: readonly PostRunArtifactWarning[],
): Record<string, unknown> {
  if (warnings.length === 0) return {};
  return {
    post_run_artifact_warnings: warnings.map((warning) => ({
      label: warning.label,
      message: warning.message,
    })),
  };
}

type WrittenProcessEvidence = {
  readonly path: string;
  readonly projection: ProcessEvidenceProjectionValue;
};

// Resolve the flow's own primary-result outcome word (e.g. a Fix `partial`) so
// the source run-envelope can name a degraded-but-complete run without itself
// importing the flow catalog (that would break the projection-only boundary the
// envelope is held to). The flow package names where its primary result lives;
// we read that outcome here, in the CLI layer that is allowed to know it.
//
// Fail open: a flow without a primary result, or a missing or malformed result
// file, returns undefined and leaves the surface exactly as before.
export function resolveFlowPrimaryOutcome(input: {
  readonly runFolder: string;
  readonly flowId: string;
}): string | undefined {
  const primaryResultPath = findCompiledFlowPackageById(input.flowId)?.runtimeSurface?.primaryResult
    ?.path;
  if (primaryResultPath === undefined) return undefined;
  let primaryResult: unknown;
  try {
    primaryResult = JSON.parse(readFileSync(join(input.runFolder, primaryResultPath), 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof primaryResult !== 'object' || primaryResult === null) return undefined;
  const outcome = (primaryResult as { readonly outcome?: unknown }).outcome;
  return typeof outcome === 'string' ? outcome : undefined;
}

export interface EmitPostRunArtifactsInput {
  readonly context: PostRunArtifactContext;
  readonly runFolder: string;
  readonly operatorIntent: string;
  readonly recordedAt: string;
  readonly selectedProcess: WriteRunEnvelopeShadowRecordInput['selectedProcess'];
  readonly child: WriteRunEnvelopeShadowRecordInput['child'];
  readonly writeOperatorSummary: () => OperatorSummaryWriteResult;
  readonly buildProcessEvidenceProjection: () => ProcessEvidenceProjectionValue;
  // Resume omits the memory context entirely; the run paths pass the history
  // recall context. Always supplied explicitly so the divergence is visible at
  // the call site rather than latent in this builder.
  readonly memoryContext: WriteRunEnvelopeRecordInput['memoryContext'];
  // Recall precision indicator (self-auditing memory): written into the source
  // run-envelope record when a run-start recall produced an earned-precision
  // audit. Optional; resume and recall-less paths omit it.
  readonly recallMemoryIndicator?: WriteRunEnvelopeRecordInput['recallMemoryIndicator'];
}

export interface EmitPostRunArtifactsResult {
  readonly operatorSummary: OperatorSummaryWriteResult | undefined;
  readonly processEvidence: WrittenProcessEvidence | undefined;
  readonly runEnvelope: WriteRunEnvelopeRecordResult | undefined;
}

export function emitPostRunArtifacts(input: EmitPostRunArtifactsInput): EmitPostRunArtifactsResult {
  const { context, runFolder, operatorIntent, recordedAt, selectedProcess, child } = input;

  const operatorSummary = tryPostRunArtifact(
    'operator-summary',
    context,
    input.writeOperatorSummary,
  );

  tryPostRunArtifact('run-envelope-shadow', context, () =>
    writeRunEnvelopeShadowRecord({
      runFolder,
      operatorIntent,
      selectedProcess,
      child,
      recordedAt,
    }),
  );

  const processEvidence = tryPostRunArtifact('process-evidence', context, () =>
    writeProcessEvidenceProjection({
      runFolder,
      projection: input.buildProcessEvidenceProjection(),
    }),
  );

  const runEnvelope =
    processEvidence === undefined
      ? undefined
      : tryPostRunArtifact('run-envelope', context, () => {
          const flowOutcome = resolveFlowPrimaryOutcome({
            runFolder,
            flowId: processEvidence.projection.flow_id,
          });
          return writeSourceRunEnvelopeRecord({
            runFolder,
            operatorIntent,
            selectedProcess,
            processEvidence,
            recordedAt,
            ...(flowOutcome === undefined ? {} : { flowOutcome }),
            ...(input.memoryContext === undefined ? {} : { memoryContext: input.memoryContext }),
            ...(input.recallMemoryIndicator === undefined
              ? {}
              : { recallMemoryIndicator: input.recallMemoryIndicator }),
          });
        });

  return { operatorSummary, processEvidence, runEnvelope };
}
