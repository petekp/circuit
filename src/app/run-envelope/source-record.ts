import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sha256OfFile, sha256OfString } from '../../schemas/hashing.js';
import { CompiledFlowId, RunId, StepId } from '../../schemas/ids.js';
import {
  PROCESS_EVIDENCE_RELATIVE_PATH,
  type ProcessEvidenceProjection,
  ProcessEvidenceProjection as ProcessEvidenceProjectionSchema,
} from '../../schemas/process-evidence.js';
import { type Ref, Sha256 } from '../../schemas/ref.js';
import {
  type RunDecisionPacket,
  RunEnvelopeRecord,
  type RunEnvelopeRecord as RunEnvelopeRecordValue,
  type RunEvidenceRef,
  type RunRequiredEvidence,
  type RunRequiredEvidenceKind,
} from '../../schemas/run-envelope.js';
import { type SurvivingWork, survivingWorkSummary } from '../../schemas/surviving-work.js';
import { harvestGoalCommandCandidates } from '../../shared/goal-commands.js';
import { isDegradedCompletionOutcome } from '../../shared/outcome.js';
import { runRelativePath } from '../../shared/run-artifact-io.js';
import { operatorFailureSentence } from './failure-language.js';

export const RUN_ENVELOPE_RELATIVE_PATH = 'reports/run-envelope.json';
export const RUN_SURFACE_RELATIVE_PATH = 'reports/run-surface.md';
export const RUN_DECISION_PACKET_RELATIVE_DIR = 'reports/decision-packets';

type SelectedProcess = {
  readonly process_id: string;
  readonly routed_by?: 'explicit';
  readonly router_reason: string;
  readonly entry_mode?: string;
};

type WrittenProcessEvidence = {
  readonly path: string;
  readonly projection: ProcessEvidenceProjection;
};

type MemoryContextInput = {
  readonly used: boolean;
  readonly memoryInputIds: readonly string[];
};

type MemoryUpdateInput = {
  readonly event_id: string;
  readonly scope: 'project' | 'flow';
  readonly flow_id?: string;
  readonly action: 'proposed' | 'recorded' | 'skipped' | 'rejected';
  readonly reason: string;
  readonly summary: string;
  readonly operator_indicator?: string;
};

export type WriteRunEnvelopeRecordInput = {
  readonly runFolder: string;
  readonly operatorIntent: string;
  readonly selectedProcess: SelectedProcess;
  readonly processEvidence: WrittenProcessEvidence;
  readonly recordedAt: string;
  readonly memoryContext?: MemoryContextInput;
  readonly memoryUpdates?: readonly MemoryUpdateInput[];
  // Slice 3: the earned-precision recall indicator. It fills
  // surface_output.memory_indicator ONLY when no proposed/recorded memory-write
  // event exists (a write-side indicator takes precedence — see writeRunEnvelopeRecord).
  readonly recallMemoryIndicator?: string;
  // The flow's own primary-result outcome word (e.g. a Fix `partial`), resolved
  // by the caller from the flow catalog. Passed in rather than read here so this
  // source-owned envelope stays projection-only and never imports the catalog.
  // Used to qualify an otherwise-clean run surface when the flow result was
  // degraded; omitted on clean runs.
  readonly flowOutcome?: string;
  // The flow's own primary-result summary, resolved by the caller from the same
  // artifact as flowOutcome. Names WHY a degraded-but-complete run is caveated so
  // the surface line carries the child's stated reason, not just the outcome
  // word. Omitted when the flow reports no summary or the run is not degraded.
  readonly flowOutcomeReason?: string;
};

export type WriteRunEnvelopeRecordResult = {
  readonly path: string;
  readonly processEvidencePath: string;
  readonly surfacePath: string;
  readonly decisionPacketPaths: readonly string[];
  readonly record: RunEnvelopeRecordValue;
};

export type MissingRunEvidence = {
  readonly claim_id: string;
  readonly reason: string;
  readonly missing_refs: readonly string[];
};

function childRunIdFromProjection(projection: ProcessEvidenceProjection): RunId {
  return RunId.parse(projection.child_run_ref.run_id);
}

function evidenceFileRef(input: {
  readonly runFolder: string;
  readonly path: string;
  readonly runId: string;
  readonly flowId: string;
}): Ref {
  return {
    kind: 'evidence',
    ref: runRelativePath(input.runFolder, input.path),
    sha256: sha256OfFile(input.path),
    run_id: RunId.parse(input.runId),
    flow_id: CompiledFlowId.parse(input.flowId),
  };
}

function evidence(source: RunEvidenceRef['source'], ref: Ref): RunEvidenceRef {
  return { source, ref };
}

type SurfaceArtifactRef = Pick<Ref, 'kind' | 'ref'>;

function artifactLabel(ref: SurfaceArtifactRef): string {
  if (ref.ref === RUN_ENVELOPE_RELATIVE_PATH) return 'Run envelope';
  if (ref.ref === PROCESS_EVIDENCE_RELATIVE_PATH) return 'Process evidence';
  if (ref.ref === 'reports/result.json') return 'Child result';
  if (ref.ref.startsWith(`${RUN_DECISION_PACKET_RELATIVE_DIR}/`)) return 'Decision packet';
  if (ref.kind === 'request') return 'Decision request';
  return ref.ref;
}

function markdownLink(label: string, path: string): string {
  return `[${label}](${path})`;
}

function renderSurfaceMarkdown(input: {
  readonly runFolder: string;
  readonly record: RunEnvelopeRecordValue;
}): string {
  const artifactRefs: readonly SurfaceArtifactRef[] = [
    {
      kind: 'report' as const,
      ref: RUN_ENVELOPE_RELATIVE_PATH,
    },
    ...input.record.surface_output.artifact_links,
  ];
  const uniqueArtifactRefs = artifactRefs.filter(
    (ref, index, refs) => refs.findIndex((candidate) => candidate.ref === ref.ref) === index,
  );
  const artifactLine = uniqueArtifactRefs
    .map((ref) => markdownLink(artifactLabel(ref), join(input.runFolder, ref.ref)))
    .join(' · ');
  return ['CIRCUIT', `⎿ ${input.record.surface_output.status_text}`, '', artifactLine, ''].join(
    '\n',
  );
}

function processAttemptOutcome(
  outcome: ProcessEvidenceProjection['outcome'],
): RunEnvelopeRecordValue['process_attempts'][number]['outcome'] {
  if (outcome === 'aborted') return 'failed';
  // The attempt vocabulary has no `stopped`; the canonical mapping for a
  // deliberate pause is `needs_attention` (see src/shared/outcome.ts).
  if (outcome === 'stopped') return 'needs_attention';
  return outcome;
}

export function missingRunEvidence(
  projection: ProcessEvidenceProjection,
): MissingRunEvidence | undefined {
  if (projection.outcome !== 'complete') return undefined;
  const refs = new Set(projection.evidence_refs.map((ref) => ref.ref));
  const missingRefs = projection.declared_report_paths.filter((path) => !refs.has(path));
  if (missingRefs.length === 0) return undefined;
  return {
    claim_id: 'process-evidence',
    reason: `Missing expected process evidence: ${missingRefs.join(', ')}.`,
    missing_refs: missingRefs,
  };
}

function runOutcome(input: {
  readonly projection: ProcessEvidenceProjection;
  readonly missingEvidence?: MissingRunEvidence;
}): RunEnvelopeRecordValue['outcome'] {
  if (input.missingEvidence !== undefined) return 'needs_attention';
  if (input.projection.outcome === 'checkpoint_waiting') return 'needs_attention';
  if (input.projection.outcome === 'aborted') return 'failed';
  // stopped -> needs_attention is the canonical mapping (src/shared/outcome.ts).
  // It keeps a deliberate pause out of the failure set, so a Review that ran
  // fully and reported findings is not filed as a failed run.
  if (input.projection.outcome === 'stopped') return 'needs_attention';
  return input.projection.outcome;
}

function selectionSourceFor(
  routedBy: SelectedProcess['routed_by'],
): RunEnvelopeRecordValue['process_plan']['selection_source'] {
  if (routedBy === 'explicit') return 'explicit_operator_request';
  return 'recovery';
}

// S2: derive the kind of proof a given process is expected to produce. This is
// the stable, deterministic mapping the recovery router (S5) re-uses to decide
// which recovery flow an unmet required-evidence entry should route to. Keeping
// it a pure function of the process id means the kind is always recoverable from
// the envelope without enriching the (kind-blind) process evidence projection.
// This is a deliberate hardcoded table for the single-claim model; deriving it
// from each flow's declared proof capabilities is a deferred refinement (see
// docs/specs/run-envelope-goal-loop-migration-v1.md). Unknown process ids fall
// through to the conservative 'report' default.
export function requiredEvidenceKindForProcess(processId: string): RunRequiredEvidenceKind {
  switch (processId) {
    case 'fix':
    case 'build':
      return 'command';
    case 'review':
    case 'explore':
      return 'review';
    case 'pursue':
    case 'prototype':
      return 'report';
    default:
      return 'report';
  }
}

function describeRequiredEvidence(kind: RunRequiredEvidenceKind, objective: string): string {
  switch (kind) {
    case 'command':
      return `A passing verification command proving: ${objective}`;
    case 'review':
      return `A review confirming no blocking findings for: ${objective}`;
    case 'report':
      return `A report-backed result proving: ${objective}`;
    case 'source':
      return `Source-backed justification for: ${objective}`;
    case 'checkpoint':
      return `An operator checkpoint resolving: ${objective}`;
  }
}

// S2: author task-specific required evidence for Run's single done_when claim,
// replacing the generic "projection exists" placeholder. Run has no Clarify step,
// so the proof requirement is derived from the selected process and the operator
// objective. Always returns at least one required entry to satisfy RunDoneClaim.
//
// When the goal itself states runnable command evidence ("pnpm typecheck exits
// 0", "`npm test` passes"), each stated command becomes its own required
// 'command' entry. A goal that names its proof must get a contract that
// requires that proof — dropping it authors a contract the contract-quality
// gate then rightly rejects, which dead-ends autonomous runs on flows whose
// process-derived kind is weaker than the objective (the pdk-poc Prototype
// + --autonomous failure).
export function deriveRequiredEvidence(
  processId: string,
  objective: string,
): RunRequiredEvidence[] {
  const kind = requiredEvidenceKindForProcess(processId);
  const goalCommandEntries = harvestGoalCommandCandidates(objective).map((candidate) => ({
    kind: 'command' as const,
    description: `Goal-stated command evidence passes: \`${candidate.argv.join(' ')}\` exits 0`,
    required: true,
  }));
  return [
    { kind, description: describeRequiredEvidence(kind, objective), required: true },
    ...goalCommandEntries,
  ];
}

// S5: route a recovery attempt by the kind of evidence that is still unmet,
// replacing the previous hardcoded "always review" follow-up. command -> fix
// (get it passing/verified), report -> build (produce the result), review ->
// review, source -> explore (justify the decision), checkpoint -> ask.
export const RECOVERY_ROUTE_FOR_UNMET_EVIDENCE_KIND: Readonly<
  Record<RunRequiredEvidenceKind, string>
> = {
  command: 'fix',
  report: 'build',
  review: 'review',
  source: 'explore',
  checkpoint: 'checkpoint',
};

// When several kinds are unmet, the most actionable proof wins: a missing
// command (failing/absent verification) is the strongest signal, then a missing
// report, then review, then source justification, then an operator checkpoint.
const RECOVERY_KIND_PRIORITY: readonly RunRequiredEvidenceKind[] = [
  'command',
  'report',
  'review',
  'source',
  'checkpoint',
];

export function recoveryRouteForUnmetKinds(unmetKinds: readonly RunRequiredEvidenceKind[]): string {
  for (const kind of RECOVERY_KIND_PRIORITY) {
    if (unmetKinds.includes(kind)) return RECOVERY_ROUTE_FOR_UNMET_EVIDENCE_KIND[kind];
  }
  return 'review';
}

function gateFor(input: {
  readonly projection: ProcessEvidenceProjection;
  readonly processEvidence: RunEvidenceRef;
  readonly missingEvidence?: MissingRunEvidence;
}): RunEnvelopeRecordValue['completion_gate'] {
  if (input.projection.outcome === 'complete') {
    if (input.missingEvidence !== undefined) {
      return {
        schema: 'run.completion-gate@v0',
        verdict: 'needs_followup',
        claim_results: [
          {
            claim_id: input.missingEvidence.claim_id,
            status: 'missing',
            evidence: [input.processEvidence],
            gap: input.missingEvidence.reason,
          },
        ],
        gate_passes: [],
        clean_streak: 0,
        required_passes: 2,
        next_action: 'plan-followup-process',
      };
    }
    return {
      schema: 'run.completion-gate@v0',
      verdict: 'complete',
      claim_results: [
        {
          claim_id: 'process-evidence',
          status: 'proved',
          evidence: [input.processEvidence],
        },
      ],
      gate_passes: [
        {
          pass_id: 'gate-process-evidence',
          attack_lens: 'required-evidence-present',
          evidence_checked: [input.processEvidence],
          verdict: 'gate-pass',
        },
        {
          pass_id: 'gate-child-outcome',
          attack_lens: 'child-outcome-consistent',
          evidence_checked: [input.processEvidence],
          verdict: 'gate-pass',
        },
      ],
      clean_streak: 2,
      required_passes: 2,
      next_action: 'close',
    };
  }

  if (input.projection.outcome === 'checkpoint_waiting') {
    return {
      schema: 'run.completion-gate@v0',
      verdict: 'needs_followup',
      claim_results: [
        {
          claim_id: 'process-evidence',
          status: 'missing',
          evidence: [input.processEvidence],
          gap: 'The selected process is waiting for an operator checkpoint choice.',
        },
      ],
      gate_passes: [],
      clean_streak: 0,
      required_passes: 2,
      next_action: 'ask-operator',
    };
  }

  if (input.projection.outcome === 'handoff') {
    return {
      schema: 'run.completion-gate@v0',
      verdict: 'handoff',
      claim_results: [
        {
          claim_id: 'process-evidence',
          status: 'blocked',
          evidence: [input.processEvidence],
          gap: 'The selected process handed off before Run could close complete.',
        },
      ],
      gate_passes: [],
      clean_streak: 0,
      required_passes: 2,
      next_action: 'handoff',
    };
  }

  // A stopped close needs follow-up, it is not blocked. The process evidence is
  // present — what is unproved is the claim that the work is DONE, because the
  // flow itself reported a non-clean result. Calling this 'blocked' told the
  // operator the process had failed to produce evidence it had in fact produced.
  if (input.projection.outcome === 'stopped') {
    return {
      schema: 'run.completion-gate@v0',
      verdict: 'needs_followup',
      claim_results: [
        {
          claim_id: 'process-evidence',
          status: 'missing',
          evidence: [input.processEvidence],
          gap:
            input.projection.blocked_reason ??
            'The selected process ran fully but did not close with a clean result.',
        },
      ],
      gate_passes: [],
      clean_streak: 0,
      required_passes: 2,
      next_action: 'plan-followup-process',
    };
  }

  const failed = input.projection.outcome === 'failed' || input.projection.outcome === 'aborted';
  return {
    schema: 'run.completion-gate@v0',
    verdict: failed ? 'failed' : 'blocked',
    claim_results: [
      {
        claim_id: 'process-evidence',
        status: failed ? 'contradicted' : 'blocked',
        evidence: [input.processEvidence],
        gap:
          input.projection.blocked_reason ??
          input.projection.missing_evidence[0]?.reason ??
          'The selected process did not produce complete evidence.',
      },
    ],
    gate_passes: [],
    clean_streak: 0,
    required_passes: 2,
    next_action: failed ? 'failed' : 'blocked',
  };
}

export function followupProcessId(primaryProcessId: string): CompiledFlowId {
  // For Run's single done_when claim, the unmet evidence kind is the proof kind
  // the primary process was expected to produce. Route the follow-up by that
  // kind instead of always sending it to review.
  const unmetKind = requiredEvidenceKindForProcess(primaryProcessId);
  return CompiledFlowId.parse(recoveryRouteForUnmetKinds([unmetKind]));
}

function followupPlannedAttempt(input: {
  readonly operatorIntent: string;
  readonly primaryProcessId: string;
  readonly missingEvidence?: MissingRunEvidence;
}): RunEnvelopeRecordValue['process_plan']['planned_attempts'][number] | undefined {
  if (input.missingEvidence === undefined) return undefined;
  const followupProcess = followupProcessId(input.primaryProcessId);
  return {
    attempt_id: 'attempt-followup-1',
    process_id: followupProcess,
    goal: `Run ${followupProcess} to produce the missing evidence to close: ${input.operatorIntent}`,
    expected_evidence: [PROCESS_EVIDENCE_RELATIVE_PATH, ...input.missingEvidence.missing_refs],
    depends_on_attempt_ids: ['attempt-primary'],
    followup_for: {
      claim_id: input.missingEvidence.claim_id,
      prior_attempt_id: 'attempt-primary',
      missing_evidence: [...input.missingEvidence.missing_refs],
    },
  };
}

function decisionPacketsFor(input: {
  readonly projection: ProcessEvidenceProjection;
  readonly processEvidence: RunEvidenceRef;
  readonly childRunId: RunId;
  readonly missingEvidence?: MissingRunEvidence;
}): RunEnvelopeRecordValue['decision_packets'] {
  if (input.missingEvidence !== undefined) {
    return [
      {
        schema: 'run.decision-packet@v0',
        decision_id: 'decision-missing-evidence-followup',
        reason: 'missing-evidence',
        prompt: 'Choose whether Run should continue with the planned follow-up.',
        choices: [
          {
            id: 'run-followup',
            label: 'Run follow-up',
            effect: 'Use the planned follow-up process to resolve the missing evidence.',
          },
          {
            id: 'stop',
            label: 'Stop here',
            effect: 'Leave the Run open with the missing evidence recorded.',
          },
        ],
        resume_target: {
          kind: 'run-envelope',
          run_id: input.childRunId,
        },
        artifact_refs: [input.processEvidence.ref],
      },
    ];
  }

  // A stopped close is a real decision point, not a failure: the process ran to
  // the end, produced its evidence, and reported a result that is not clean. A
  // Review that found issues lands here. Somebody has to decide what to do with
  // what it found, so say so and record the choice rather than filing the run
  // as blocked.
  if (input.projection.outcome === 'stopped') {
    return [
      {
        schema: 'run.decision-packet@v0',
        decision_id: 'decision-stopped-result',
        reason: 'operator-judgment',
        prompt: 'The process finished and reported a result that is not clean. Choose what to do.',
        choices: [
          {
            id: 'act-on-result',
            label: 'Act on the result',
            effect: 'Take the reported findings forward as follow-up work.',
          },
          {
            id: 'accept',
            label: 'Accept as is',
            effect: 'Record the result and close without further work.',
          },
        ],
        resume_target: {
          kind: 'run-envelope',
          run_id: input.childRunId,
        },
        artifact_refs: [input.processEvidence.ref],
      },
    ];
  }

  const checkpoint = input.projection.checkpoint;
  if (checkpoint === undefined) return [];

  return [
    {
      schema: 'run.decision-packet@v0',
      decision_id: 'decision-checkpoint-primary',
      reason: 'process-checkpoint',
      prompt: 'Choose how the selected process should continue.',
      choices: checkpoint.allowed_choices.map((choice) => ({
        id: choice,
        label: choice,
        effect: `Resume the checkpoint with '${choice}'.`,
      })),
      resume_target: {
        kind: 'process-checkpoint',
        run_id: input.childRunId,
        step_id: checkpoint.step_id,
        request_ref: checkpoint.request_ref,
      },
      artifact_refs: [input.processEvidence.ref, checkpoint.request_ref],
    },
  ];
}

function decisionPacketRelativePath(packet: RunDecisionPacket): string {
  const safeId = packet.decision_id.replace(/[^a-zA-Z0-9._-]+/g, '-');
  return `${RUN_DECISION_PACKET_RELATIVE_DIR}/${safeId}.json`;
}

function decisionPacketArtifacts(input: {
  readonly runId: RunId;
  readonly packets: readonly RunDecisionPacket[];
}): readonly { readonly packet: RunDecisionPacket; readonly ref: Ref; readonly body: string }[] {
  return input.packets.map((packet) => {
    const body = `${JSON.stringify(packet, null, 2)}\n`;
    return {
      packet,
      body,
      ref: {
        kind: 'report',
        ref: decisionPacketRelativePath(packet),
        sha256: Sha256.parse(sha256OfString(body)),
        run_id: input.runId,
      },
    };
  });
}

function memoryUpdateEvents(input: {
  readonly processId: string;
  readonly processEvidence: RunEvidenceRef;
  readonly updates?: readonly MemoryUpdateInput[];
}): RunEnvelopeRecordValue['memory_update_events'] {
  return (input.updates ?? []).map((update) => ({
    schema: 'run.memory-update-event@v0',
    event_id: update.event_id,
    scope: update.scope,
    ...(update.scope === 'flow'
      ? { flow_id: CompiledFlowId.parse(update.flow_id ?? input.processId) }
      : {}),
    action: update.action,
    reason: update.reason,
    summary: update.summary,
    source_refs: [input.processEvidence.ref],
    authority: 'hint_only',
    ...(update.operator_indicator === undefined
      ? {}
      : { operator_indicator: update.operator_indicator }),
  }));
}

function surfaceFor(input: {
  readonly outcome: RunEnvelopeRecordValue['outcome'];
  readonly processId: string;
  readonly processEvidence: RunEvidenceRef;
  readonly flowOutcome?: string;
  readonly flowOutcomeReason?: string;
  readonly missingEvidence?: MissingRunEvidence;
  readonly decisionPacketRefs?: readonly Ref[];
  readonly memoryIndicator?: string;
  readonly childResult?: RunEvidenceRef;
  readonly checkpointRequest?: Ref;
  // Set only when the child process closed `stopped` — a deliberate pause after
  // a full run, which shares the `needs_attention` outcome with a checkpoint
  // wait but means something different to the operator. Carries the flow's own
  // stated reason when it gave one.
  readonly stoppedReason?: string;
  // Set when the child process died (`aborted`) or its evidence failed
  // validation (`failed`): the run's own account of the cause, for example
  // which retry budget ran out. The failed headline quotes it so the operator
  // does not have to dig through process evidence to learn why the run died.
  readonly failureReason?: string;
  // The reports the run left behind, carried from its result. Present only on a
  // run that did not finish and did produce something.
  readonly survivingWork?: readonly SurvivingWork[];
}): RunEnvelopeRecordValue['surface_output'] {
  const artifactLinks = [
    input.processEvidence.ref,
    ...(input.decisionPacketRefs ?? []),
    ...(input.childResult === undefined ? [] : [input.childResult.ref]),
    ...(input.checkpointRequest === undefined ? [] : [input.checkpointRequest]),
  ];
  // A degraded flow outcome on an otherwise-complete run is the one case where
  // the flow quality word must reach the surface. Carry it so the machine
  // record exposes the partial/failed result the run lifecycle outcome alone
  // would hide. Clean runs leave flow_outcome absent.
  const degradedFlowOutcome =
    input.outcome === 'complete' && isDegradedCompletionOutcome(input.flowOutcome)
      ? input.flowOutcome
      : undefined;
  const base = {
    schema: 'run.surface-output@v0' as const,
    outcome: input.outcome,
    artifact_links: artifactLinks,
    ...(degradedFlowOutcome === undefined ? {} : { flow_outcome: degradedFlowOutcome }),
    ...(input.memoryIndicator === undefined ? {} : { memory_indicator: input.memoryIndicator }),
  };

  if (input.outcome === 'complete') {
    if (degradedFlowOutcome !== undefined) {
      // The run finished its process, but its own result is not a clean pass.
      // Name the degradation rather than reading as an unqualified "Done", and
      // carry the flow's own stated reason when it gave one so the caveat line
      // says why, not just that it is caveated.
      const reason = input.flowOutcomeReason?.trim();
      const reasonSuffix = reason ? ` ${reason}` : '';
      return {
        ...base,
        status_text: `Completed with caveats: ${input.processId} produced its required process evidence but reported a ${degradedFlowOutcome} outcome.${reasonSuffix}`,
        next_action: 'close',
      };
    }
    return {
      ...base,
      status_text: `Done: ${input.processId} completed with required process evidence.`,
      next_action: 'close',
    };
  }
  if (input.outcome === 'needs_attention') {
    if (input.stoppedReason !== undefined) {
      // The process ran to the end and produced its evidence; it just did not
      // close clean. Say that, and carry the flow's reason. Saying "did not
      // produce enough process evidence" here was a plain falsehood — it is
      // what made an honest Review headline as a broken run.
      const reason = input.stoppedReason.trim();
      const reasonSuffix = reason ? ` ${reason}` : '';
      return {
        ...base,
        status_text: `Needs follow-up: ${input.processId} ran its full process and stopped without a clean result.${reasonSuffix}`,
        next_action: 'Read the process result and decide whether to act on what it found.',
        ...(input.decisionPacketRefs?.[0] === undefined
          ? {}
          : { decision_packet_ref: input.decisionPacketRefs[0] }),
      };
    }
    if (input.missingEvidence !== undefined) {
      return {
        ...base,
        status_text: `Needs follow-up: ${input.processId} is missing expected process evidence.`,
        next_action: 'plan-followup-process',
        ...(input.decisionPacketRefs?.[0] === undefined
          ? {}
          : { decision_packet_ref: input.decisionPacketRefs[0] }),
      };
    }
    return {
      ...base,
      status_text: `Needs input: ${input.processId} is waiting at a checkpoint.`,
      next_action: 'ask-operator',
      ...(input.decisionPacketRefs?.[0] === undefined
        ? {}
        : { decision_packet_ref: input.decisionPacketRefs[0] }),
    };
  }
  if (input.outcome === 'blocked') {
    return {
      ...base,
      status_text: `Blocked: ${input.processId} did not produce enough process evidence.`,
      next_action: 'Inspect the process evidence and choose a recovery path.',
    };
  }
  if (input.outcome === 'handoff') {
    return {
      ...base,
      status_text: `Handoff ready: ${input.processId} paused with handoff evidence.`,
      next_action: 'resume from handoff',
    };
  }
  if (input.outcome === 'failed') {
    // Lead with the run's own account of what killed it. "Could not close with
    // the required process evidence" was technically true but useless — the
    // cause was already sitting in the run result, and telling the operator to
    // "rerun with a corrected goal" blamed the goal for an engine failure.
    //
    // Translated on the way past where the account is written in engine
    // vocabulary: the trace keeps its precise wording, the person gets a
    // sentence. Anything already plain passes through untouched.
    const reason = operatorFailureSentence(input.failureReason?.trim() ?? '');
    const reasonSuffix = reason ? ` ${reason}` : '';
    // A run that died partway has usually already produced real work. Naming
    // the cause and then saying "rerun" invites starting over on top of a
    // finished plan or implementation that is sitting on disk. Hand it over.
    const handover = survivingWorkSummary(input.survivingWork ?? []);
    const handoverSuffix = handover === undefined ? '' : ` ${handover}`;
    return {
      ...base,
      status_text: `Failed: ${input.processId} stopped before finishing its process.${reasonSuffix}${handoverSuffix}`,
      next_action:
        handover === undefined
          ? reason
            ? 'Address the reason above, then rerun.'
            : 'Inspect the process evidence for the cause before rerunning.'
          : 'Read the reports listed above before rerunning: a rerun starts over and will not build on them.',
    };
  }
  // Defensive default: every RunEnvelopeOutcome above is handled, so this only
  // fires if a new outcome is added without a branch.
  return {
    ...base,
    status_text: `Stopped: ${input.processId} could not close with enough process evidence.`,
    next_action: 'Inspect the process evidence for the cause before rerunning.',
  };
}

export function writeRunEnvelopeRecord(
  input: WriteRunEnvelopeRecordInput,
): WriteRunEnvelopeRecordResult {
  const projection = ProcessEvidenceProjectionSchema.parse(input.processEvidence.projection);
  const processEvidencePath = input.processEvidence.path;
  const childRunId = childRunIdFromProjection(projection);
  const processEvidence = evidence(
    'process_evidence',
    evidenceFileRef({
      runFolder: input.runFolder,
      path: processEvidencePath,
      runId: childRunId,
      flowId: projection.flow_id as unknown as string,
    }),
  );
  const childResult =
    projection.result_ref === undefined
      ? undefined
      : evidence('child_result', projection.result_ref);
  const missingEvidence = missingRunEvidence(projection);
  const gate = gateFor({
    projection,
    processEvidence,
    ...(missingEvidence && { missingEvidence }),
  });
  const outcome = runOutcome({ projection, ...(missingEvidence && { missingEvidence }) });
  const processId = projection.flow_id as unknown as string;
  const flowOutcome = input.flowOutcome;
  const flowOutcomeReason = input.flowOutcomeReason;
  const followupAttempt = followupPlannedAttempt({
    operatorIntent: input.operatorIntent,
    primaryProcessId: processId,
    ...(missingEvidence && { missingEvidence }),
  });
  const decisionPackets = decisionPacketsFor({
    projection,
    processEvidence,
    childRunId,
    ...(missingEvidence && { missingEvidence }),
  });
  const decisionArtifacts = decisionPacketArtifacts({
    runId: childRunId,
    packets: decisionPackets,
  });
  const memoryEvents = memoryUpdateEvents({
    processId,
    processEvidence,
    ...(input.memoryUpdates === undefined ? {} : { updates: input.memoryUpdates }),
  });
  // Slice 3 precedence rule: a write-side proposed/recorded memory-update
  // indicator (Slice 5's surface) wins the single surface_output.memory_indicator;
  // the recall-derived earned-precision indicator fills it only when no
  // memory-write event exists. On a Slice-3-only corpus there are no write events,
  // so the field carries the recall indicator; once Slice 5 also runs, the
  // write-side indicator takes precedence and the recall one stays in the sidecar.
  const writeIndicator = memoryEvents.find(
    (event) => event.action === 'proposed' || event.action === 'recorded',
  )?.operator_indicator;
  const memoryIndicator = writeIndicator ?? input.recallMemoryIndicator;

  const record = RunEnvelopeRecord.parse({
    schema: 'run.envelope@v0',
    run_id: projection.child_run_ref.run_id,
    operator_intent: input.operatorIntent,
    explicit_constraints: [],
    explicit_process_request:
      input.selectedProcess.routed_by === 'explicit'
        ? CompiledFlowId.parse(input.selectedProcess.process_id)
        : undefined,
    memory_context: {
      used: input.memoryContext?.used ?? false,
      memory_input_ids: [...(input.memoryContext?.memoryInputIds ?? [])],
      authority: 'hint_only',
    },
    goal_contract: {
      schema: 'run.goal-contract@v0',
      objective: input.operatorIntent,
      scope: {
        in: [input.operatorIntent],
        out: [],
        assumptions: [],
      },
      constraints: [],
      done_when: [
        {
          id: 'process-evidence',
          claim: `The ${input.selectedProcess.process_id} work is complete with the required proof for: ${input.operatorIntent}`,
          required_evidence: deriveRequiredEvidence(
            input.selectedProcess.process_id,
            input.operatorIntent,
          ),
        },
      ],
      recovery_policy: {
        max_process_attempts: 2,
        allowed_routes: ['retry-process', 'run-review', 'checkpoint', 'handoff', 'blocked'],
      },
      stop_conditions: ['Stop instead of closing complete when required evidence is missing.'],
      completion_gate: {
        required_passes: 2,
        blocking_severities: ['critical', 'high', 'medium'],
        reset_on_blocking_finding: true,
      },
    },
    process_plan: {
      schema: 'run.process-plan@v0',
      selection_source: selectionSourceFor(input.selectedProcess.routed_by),
      rationale: input.selectedProcess.router_reason,
      planned_attempts: [
        {
          attempt_id: 'attempt-primary',
          process_id: CompiledFlowId.parse(input.selectedProcess.process_id),
          goal: input.operatorIntent,
          expected_evidence: [PROCESS_EVIDENCE_RELATIVE_PATH],
          depends_on_attempt_ids: [],
        },
        ...(followupAttempt === undefined ? [] : [followupAttempt]),
      ],
    },
    process_attempts: [
      {
        schema: 'run.process-attempt@v0',
        attempt_id: 'attempt-primary',
        process_id: CompiledFlowId.parse(input.selectedProcess.process_id),
        goal: input.operatorIntent,
        started_at: input.recordedAt,
        ...(projection.outcome === 'checkpoint_waiting' ? {} : { completed_at: input.recordedAt }),
        outcome: processAttemptOutcome(projection.outcome),
        child_run: {
          run_id: projection.child_run_ref.run_id,
          run_folder: input.runFolder,
          ...(childResult === undefined ? {} : { result_ref: childResult }),
          trace_entries_observed: projection.trace_entries_observed,
          manifest_hash: projection.manifest_hash,
        },
        ...(projection.checkpoint === undefined
          ? {}
          : {
              checkpoint: {
                step_id: StepId.parse(projection.checkpoint.step_id),
                request_ref: projection.checkpoint.request_ref,
                allowed_choices: projection.checkpoint.allowed_choices,
              },
            }),
        evidence_refs: [processEvidence, ...(childResult === undefined ? [] : [childResult])],
        summary: projection.summary,
        ...(projection.blocked_reason === undefined
          ? {}
          : { blocked_reason: projection.blocked_reason }),
      },
    ],
    completion_gate: gate,
    decision_packets: decisionPackets,
    memory_update_events: memoryEvents,
    surface_output: surfaceFor({
      outcome,
      processId,
      processEvidence,
      ...(flowOutcome === undefined ? {} : { flowOutcome }),
      ...(flowOutcomeReason === undefined ? {} : { flowOutcomeReason }),
      ...(missingEvidence && { missingEvidence }),
      ...(projection.outcome === 'stopped'
        ? { stoppedReason: projection.blocked_reason ?? projection.summary }
        : {}),
      ...(projection.outcome === 'aborted' || projection.outcome === 'failed'
        ? { failureReason: projection.blocked_reason ?? projection.summary }
        : {}),
      ...(projection.surviving_work === undefined
        ? {}
        : { survivingWork: projection.surviving_work }),
      decisionPacketRefs: decisionArtifacts.map((artifact) => artifact.ref),
      ...(memoryIndicator === undefined ? {} : { memoryIndicator }),
      ...(childResult === undefined ? {} : { childResult }),
      ...(projection.checkpoint === undefined
        ? {}
        : { checkpointRequest: projection.checkpoint.request_ref }),
    }),
    outcome,
  });

  const outPath = join(input.runFolder, RUN_ENVELOPE_RELATIVE_PATH);
  mkdirSync(dirname(outPath), { recursive: true });
  const decisionPacketPaths = decisionArtifacts.map((artifact) => {
    const path = join(input.runFolder, artifact.ref.ref);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, artifact.body);
    return path;
  });
  writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`);
  const surfacePath = join(input.runFolder, RUN_SURFACE_RELATIVE_PATH);
  writeFileSync(surfacePath, renderSurfaceMarkdown({ runFolder: input.runFolder, record }));
  return {
    path: outPath,
    processEvidencePath,
    surfacePath,
    decisionPacketPaths,
    record,
  };
}
