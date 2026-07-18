import { z } from 'zod';
import { canonicalJson } from './hashing.js';
import { Snapshot, type SnapshotStatus } from './snapshot.js';
import {
  type RunBootstrappedTraceEntry,
  type RunClosedOutcome,
  type RunClosedTraceEntry,
  TraceEntry,
} from './trace-entry.js';

// RunTrace is a typed projection of `trace.ndjson` parsed into an ordered
// array. Individual TraceEntry variants are already strict-mode and
// individually validated; this aggregate encodes the log-level invariants
// that no single trace_entry can assert on its own:
//   - first entry is run.bootstrapped
//   - sequence is 0-based, contiguous, monotonic
//   - run_id is consistent across all entries
//   - exactly one bootstrap; at most one close; nothing after close

const RunTraceBody = z.array(TraceEntry).min(1);

const issueAt = (ctx: z.RefinementCtx, path: (string | number)[], message: string) => {
  ctx.addIssue({ code: 'custom', path, message });
};

type ParsedTraceEntry = z.infer<typeof TraceEntry>;
type GuidanceTraceEntry = Extract<ParsedTraceEntry, { kind: 'guidance.decision' }>;
type RelayTraceEntry = Extract<ParsedTraceEntry, { kind: 'relay.started' | 'relay.failed' }>;
type RelayStartedEntry = Extract<ParsedTraceEntry, { kind: 'relay.started' }>;
type RelayRequestEntry = Extract<ParsedTraceEntry, { kind: 'relay.request' }>;
type SkillsLoadedEntry = Extract<ParsedTraceEntry, { kind: 'skills.loaded' }>;
type CheckpointResolvedEntry = Extract<ParsedTraceEntry, { kind: 'checkpoint.resolved' }>;
type ProofAssessedEntry = Extract<ParsedTraceEntry, { kind: 'proof.assessed' }>;
type SafeApplyResultEntry = Extract<ParsedTraceEntry, { kind: 'safe_apply.result' }>;
type StepCompletedEntry = Extract<ParsedTraceEntry, { kind: 'step.completed' }>;

function isGuidanceDecision(entry: ParsedTraceEntry): entry is GuidanceTraceEntry {
  return entry.kind === 'guidance.decision';
}

function sameJson(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function selectedRecord(entry: GuidanceTraceEntry): Record<string, unknown> {
  return entry.selected as Record<string, unknown>;
}

function priorFlowSelectionIndex(
  traceEntries: readonly ParsedTraceEntry[],
  beforeIndex: number,
): number {
  return traceEntries.findIndex((entry, index) => {
    return index < beforeIndex && isGuidanceDecision(entry) && entry.subject === 'flow_selection';
  });
}

function findPriorRelayGuidance(
  traceEntries: readonly ParsedTraceEntry[],
  relay: RelayTraceEntry,
  beforeIndex: number,
): GuidanceTraceEntry | undefined {
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    const entry = traceEntries[index];
    if (entry === undefined || !isGuidanceDecision(entry) || entry.subject !== 'relay_execution') {
      continue;
    }
    if (entry.scope.step_id !== relay.step_id || entry.scope.attempt !== relay.attempt) {
      continue;
    }
    return entry;
  }
  return undefined;
}

function findFollowingRelayRequest(
  traceEntries: readonly ParsedTraceEntry[],
  relay: RelayStartedEntry,
  afterIndex: number,
): { readonly entry: RelayRequestEntry; readonly index: number } | undefined {
  for (let index = afterIndex + 1; index < traceEntries.length; index += 1) {
    const entry = traceEntries[index];
    if (entry === undefined) continue;
    if (
      entry.kind === 'relay.request' &&
      entry.step_id === relay.step_id &&
      entry.attempt === relay.attempt
    ) {
      return { entry, index };
    }
    if (
      (entry.kind === 'relay.started' || entry.kind === 'relay.completed') &&
      entry.step_id === relay.step_id &&
      entry.attempt === relay.attempt
    ) {
      return undefined;
    }
  }
  return undefined;
}

function findFollowingSkillsLoaded(
  traceEntries: readonly ParsedTraceEntry[],
  relay: RelayStartedEntry,
  afterIndex: number,
): SkillsLoadedEntry | undefined {
  for (let index = afterIndex + 1; index < traceEntries.length; index += 1) {
    const entry = traceEntries[index];
    if (entry === undefined) continue;
    if (
      entry.kind === 'skills.loaded' &&
      entry.step_id === relay.step_id &&
      entry.attempt === relay.attempt
    ) {
      return entry;
    }
    if (
      entry.kind === 'relay.request' &&
      entry.step_id === relay.step_id &&
      entry.attempt === relay.attempt
    ) {
      return undefined;
    }
  }
  return undefined;
}

function findPriorCheckpointGuidance(
  traceEntries: readonly ParsedTraceEntry[],
  checkpoint: CheckpointResolvedEntry,
  beforeIndex: number,
): GuidanceTraceEntry | undefined {
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    const entry = traceEntries[index];
    if (
      entry === undefined ||
      !isGuidanceDecision(entry) ||
      entry.subject !== 'checkpoint_resolution'
    ) {
      continue;
    }
    if (entry.scope.step_id !== checkpoint.step_id || entry.scope.attempt !== checkpoint.attempt) {
      continue;
    }
    return entry;
  }
  return undefined;
}

function findPriorProofPolicyGuidance(
  traceEntries: readonly ParsedTraceEntry[],
  proof: ProofAssessedEntry,
  beforeIndex: number,
): GuidanceTraceEntry | undefined {
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    const entry = traceEntries[index];
    if (
      entry === undefined ||
      !isGuidanceDecision(entry) ||
      entry.subject !== 'proof_policy' ||
      entry.decision_id !== proof.proof_policy_decision_id
    ) {
      continue;
    }
    return entry;
  }
  return undefined;
}

function findPriorSafeApplyGuidance(
  traceEntries: readonly ParsedTraceEntry[],
  result: SafeApplyResultEntry,
  beforeIndex: number,
): GuidanceTraceEntry | undefined {
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    const entry = traceEntries[index];
    if (
      entry === undefined ||
      !isGuidanceDecision(entry) ||
      entry.subject !== 'safe_apply' ||
      entry.decision_id !== result.decision_id
    ) {
      continue;
    }
    return entry;
  }
  return undefined;
}

function findFollowingStepCompleted(
  traceEntries: readonly ParsedTraceEntry[],
  guidance: GuidanceTraceEntry,
  afterIndex: number,
): { readonly entry: StepCompletedEntry; readonly index: number } | undefined {
  for (let index = afterIndex + 1; index < traceEntries.length; index += 1) {
    const entry = traceEntries[index];
    if (entry === undefined) continue;
    if (
      entry.kind === 'step.completed' &&
      entry.step_id === guidance.scope.step_id &&
      entry.attempt === guidance.scope.attempt
    ) {
      return { entry, index };
    }
    if (
      entry.kind === 'step.entered' &&
      entry.step_id === guidance.scope.step_id &&
      entry.attempt === guidance.scope.attempt
    ) {
      return undefined;
    }
  }
  return undefined;
}

function selectedSkills(selected: Record<string, unknown>): readonly Record<string, unknown>[] {
  if (!Array.isArray(selected.skills)) return [];
  return selected.skills.filter(
    (skill): skill is Record<string, unknown> =>
      skill !== null && typeof skill === 'object' && !Array.isArray(skill),
  );
}

function skillIdentity(skill: Record<string, unknown>): Record<string, unknown> {
  return {
    id: skill.id,
    ...(skill.slot === undefined ? {} : { slot: skill.slot }),
  };
}

function selectedSafeApplyActionMatches(selectedAction: unknown, resultAction: unknown): boolean {
  return (
    (selectedAction === 'reject' && resultAction === 'rejected') ||
    (selectedAction === 'accept' && resultAction === 'accepted_for_review') ||
    (selectedAction === 'apply' && resultAction === 'applied')
  );
}

function scopeMatchesGuidance(
  entry: ProofAssessedEntry | SafeApplyResultEntry,
  guidance: GuidanceTraceEntry,
): boolean {
  return (
    entry.scope.flow_id === guidance.scope.flow_id &&
    entry.scope.step_id === guidance.scope.step_id &&
    entry.scope.attempt === guidance.scope.attempt
  );
}

function proofPolicyRequiresProvenClose(guidance: GuidanceTraceEntry): boolean {
  if (guidance.subject !== 'proof_policy') return false;
  return selectedRecord(guidance).close_requires_proven === true;
}

function isPassingCloseProof(entry: ProofAssessedEntry, guidance: GuidanceTraceEntry): boolean {
  return (
    entry.proof_policy_decision_id === guidance.decision_id &&
    entry.overall_status === 'proven' &&
    entry.close_allowed &&
    scopeMatchesGuidance(entry, guidance)
  );
}

function isPassingSafeApplyResult(entry: SafeApplyResultEntry): boolean {
  return (
    entry.action === 'applied' &&
    entry.outcome === 'pass' &&
    entry.final_verification_ref !== undefined
  );
}

function proofPolicyCloseGateKey(guidance: GuidanceTraceEntry): string {
  const selected = selectedRecord(guidance);
  return JSON.stringify({
    flow_id: guidance.scope.flow_id,
    step_id: guidance.scope.step_id,
    proof_profile: selected.proof_profile,
    required_claim_kinds: selected.required_claim_kinds,
    required_evidence_kinds: selected.required_evidence_kinds,
  });
}

function validateCompleteCloseGates(
  traceEntries: readonly ParsedTraceEntry[],
  ctx: z.RefinementCtx,
): void {
  const closeIndex = traceEntries.findIndex(
    (entry) => entry?.kind === 'run.closed' && entry.outcome === 'complete',
  );
  if (closeIndex < 0) return;

  const latestRequiredProofByRequirement = new Map<
    string,
    { readonly guidance: GuidanceTraceEntry; readonly index: number }
  >();
  for (let index = 0; index < closeIndex; index += 1) {
    const guidance = traceEntries[index];
    if (
      guidance === undefined ||
      !isGuidanceDecision(guidance) ||
      !proofPolicyRequiresProvenClose(guidance)
    ) {
      continue;
    }
    latestRequiredProofByRequirement.set(proofPolicyCloseGateKey(guidance), { guidance, index });
  }

  for (const { guidance, index } of latestRequiredProofByRequirement.values()) {
    const hasPassingProof = traceEntries.some((entry, proofIndex) => {
      return (
        proofIndex > index &&
        proofIndex < closeIndex &&
        entry?.kind === 'proof.assessed' &&
        isPassingCloseProof(entry, guidance)
      );
    });
    if (!hasPassingProof) {
      issueAt(
        ctx,
        [closeIndex, 'kind'],
        `run.closed complete requires passing proof.assessed for proof_policy decision '${guidance.decision_id}'`,
      );
    }
  }

  let lastSafeApplyResult:
    | { readonly entry: SafeApplyResultEntry; readonly index: number }
    | undefined;
  for (let index = 0; index < closeIndex; index += 1) {
    const entry = traceEntries[index];
    if (entry?.kind === 'safe_apply.result') {
      lastSafeApplyResult = { entry, index };
    }
    if (entry === undefined || !isGuidanceDecision(entry) || entry.subject !== 'safe_apply') {
      continue;
    }
    if (selectedRecord(entry).action !== 'apply') continue;
    const hasPassingResult = traceEntries.some((candidate, resultIndex) => {
      return (
        resultIndex > index &&
        resultIndex < closeIndex &&
        candidate?.kind === 'safe_apply.result' &&
        candidate.decision_id === entry.decision_id &&
        isPassingSafeApplyResult(candidate) &&
        scopeMatchesGuidance(candidate, entry)
      );
    });
    if (!hasPassingResult) {
      issueAt(
        ctx,
        [closeIndex, 'kind'],
        `run.closed complete requires passing safe_apply.result for safe_apply decision '${entry.decision_id}'`,
      );
    }
  }

  if (lastSafeApplyResult !== undefined && !isPassingSafeApplyResult(lastSafeApplyResult.entry)) {
    issueAt(
      ctx,
      [closeIndex, 'kind'],
      `run.closed complete cannot follow non-passing safe_apply.result at index ${lastSafeApplyResult.index}`,
    );
  }
}

function validateGuidanceTraceSequence(
  traceEntries: readonly ParsedTraceEntry[],
  ctx: z.RefinementCtx,
): void {
  const decisionIds = new Map<string, number>();
  let hasGuidance = false;
  let hasProofAssessment = false;
  let hasSafeApplyResult = false;
  for (let index = 0; index < traceEntries.length; index += 1) {
    const entry = traceEntries[index];
    if (entry?.kind === 'proof.assessed') {
      hasProofAssessment = true;
    }
    if (entry?.kind === 'safe_apply.result') {
      hasSafeApplyResult = true;
    }
    if (entry === undefined || !isGuidanceDecision(entry)) continue;
    hasGuidance = true;
    const priorIndex = decisionIds.get(entry.decision_id);
    if (priorIndex !== undefined) {
      issueAt(
        ctx,
        [index, 'decision_id'],
        `duplicate guidance.decision id '${entry.decision_id}' first appeared at index ${priorIndex}`,
      );
    } else {
      decisionIds.set(entry.decision_id, index);
    }
  }
  if (!hasGuidance && !hasProofAssessment && !hasSafeApplyResult) return;

  const bootstrap = traceEntries[0];
  if (bootstrap?.kind !== 'run.bootstrapped') return;

  const firstMaterial = traceEntries[1];
  if (
    firstMaterial === undefined ||
    !isGuidanceDecision(firstMaterial) ||
    firstMaterial.subject !== 'flow_selection'
  ) {
    issueAt(
      ctx,
      [1, 'kind'],
      'when guidance decisions are present, flow_selection guidance must be the first entry after run.bootstrapped',
    );
  } else {
    const selected = selectedRecord(firstMaterial);
    if (selected.flow_id !== bootstrap.flow_id) {
      issueAt(
        ctx,
        [1, 'selected', 'flow_id'],
        `flow_selection guidance selected flow '${String(selected.flow_id)}' but bootstrap flow_id is '${bootstrap.flow_id}'`,
      );
    }
  }

  for (let index = 0; index < traceEntries.length; index += 1) {
    const entry = traceEntries[index];
    if (entry === undefined) continue;

    if (entry.kind === 'step.entered' && priorFlowSelectionIndex(traceEntries, index) < 0) {
      issueAt(
        ctx,
        [index, 'kind'],
        'step.entered requires prior flow_selection guidance when guidance decisions are present',
      );
    }

    if (isGuidanceDecision(entry) && entry.subject !== 'flow_selection') {
      if (entry.scope.flow_id !== bootstrap.flow_id) {
        issueAt(
          ctx,
          [index, 'scope', 'flow_id'],
          `guidance.decision scope.flow_id '${String(entry.scope.flow_id)}' does not match bootstrap flow_id '${bootstrap.flow_id}'`,
        );
      }
    }

    if (entry.kind !== 'relay.started' && entry.kind !== 'relay.failed') continue;
    const guidance = findPriorRelayGuidance(traceEntries, entry, index);
    if (guidance === undefined) {
      issueAt(
        ctx,
        [index, 'kind'],
        `${entry.kind} requires prior matching relay_execution guidance when guidance decisions are present`,
      );
      continue;
    }

    const selected = selectedRecord(guidance);
    if (selected.role !== entry.role) {
      issueAt(
        ctx,
        [index, 'role'],
        `${entry.kind} role '${entry.role}' does not match relay_execution guidance role '${String(selected.role)}'`,
      );
    }
    if (!sameJson(selected.connector, entry.connector)) {
      issueAt(
        ctx,
        [index, 'connector'],
        `${entry.kind} connector does not match relay_execution guidance connector`,
      );
    }
    if (!sameJson(selected.model, entry.resolved_selection.model)) {
      issueAt(
        ctx,
        [index, 'resolved_selection', 'model'],
        `${entry.kind} resolved_selection.model does not match relay_execution guidance model`,
      );
    }
    if (selected.effort !== entry.resolved_selection.effort) {
      issueAt(
        ctx,
        [index, 'resolved_selection', 'effort'],
        `${entry.kind} resolved_selection.effort does not match relay_execution guidance effort`,
      );
    }
    if (entry.kind === 'relay.started') {
      const request = findFollowingRelayRequest(traceEntries, entry, index);
      if (request === undefined) {
        issueAt(
          ctx,
          [index, 'kind'],
          'relay.started requires a following relay.request for the same step attempt when guidance decisions are present',
        );
      } else if (selected.request_payload_hash !== request.entry.request_payload_hash) {
        issueAt(
          ctx,
          [request.index, 'request_payload_hash'],
          'relay.request request_payload_hash does not match relay_execution guidance request_payload_hash',
        );
      }

      const selectedLoadedSkills = selectedSkills(selected).map(skillIdentity);
      const loaded = findFollowingSkillsLoaded(traceEntries, entry, index);
      if (loaded === undefined) {
        if (selectedLoadedSkills.length > 0) {
          issueAt(
            ctx,
            [index, 'kind'],
            'relay.started with selected skills requires a following skills.loaded entry for the same step attempt',
          );
        }
      } else {
        const loadedSkills = loaded.skills.map(skillIdentity);
        if (!sameJson(selectedLoadedSkills, loadedSkills)) {
          issueAt(
            ctx,
            [index, 'kind'],
            'skills.loaded entries do not match relay_execution guidance skills',
          );
        }
      }
    }
    if (
      entry.kind === 'relay.failed' &&
      selected.request_payload_hash !== entry.request_payload_hash
    ) {
      issueAt(
        ctx,
        [index, 'request_payload_hash'],
        'relay.failed request_payload_hash does not match relay_execution guidance request_payload_hash',
      );
    }
  }

  for (let index = 0; index < traceEntries.length; index += 1) {
    const entry = traceEntries[index];
    if (entry?.kind !== 'checkpoint.resolved') continue;

    const guidance = findPriorCheckpointGuidance(traceEntries, entry, index);
    if (guidance === undefined) {
      issueAt(
        ctx,
        [index, 'kind'],
        'checkpoint.resolved requires prior matching checkpoint_resolution guidance when guidance decisions are present',
      );
      continue;
    }

    const selected = selectedRecord(guidance);
    if (selected.choice_id !== entry.selection) {
      issueAt(
        ctx,
        [index, 'selection'],
        `checkpoint.resolved selection '${entry.selection}' does not match checkpoint guidance choice '${String(selected.choice_id)}'`,
      );
    }
    if (selected.route_id !== entry.route_id) {
      issueAt(
        ctx,
        [index, 'route_id'],
        `checkpoint.resolved route_id '${entry.route_id}' does not match checkpoint guidance route '${String(selected.route_id)}'`,
      );
    }
    if (selected.auto_resolved !== entry.auto_resolved) {
      issueAt(
        ctx,
        [index, 'auto_resolved'],
        'checkpoint.resolved auto_resolved does not match checkpoint guidance',
      );
    }
    if (selected.resolution_source !== entry.resolution_source) {
      issueAt(
        ctx,
        [index, 'resolution_source'],
        `checkpoint.resolved resolution_source '${entry.resolution_source}' does not match checkpoint guidance source '${String(selected.resolution_source)}'`,
      );
    }
  }

  for (let index = 0; index < traceEntries.length; index += 1) {
    const entry = traceEntries[index];
    if (entry?.kind !== 'proof.assessed') continue;

    if (entry.scope.flow_id !== bootstrap.flow_id) {
      issueAt(
        ctx,
        [index, 'scope', 'flow_id'],
        `proof.assessed scope.flow_id '${String(entry.scope.flow_id)}' does not match bootstrap flow_id '${bootstrap.flow_id}'`,
      );
    }

    const guidance = findPriorProofPolicyGuidance(traceEntries, entry, index);
    if (guidance === undefined) {
      issueAt(
        ctx,
        [index, 'proof_policy_decision_id'],
        'proof.assessed requires prior matching proof_policy guidance when guidance decisions are present',
      );
      continue;
    }

    if (guidance.scope.flow_id !== entry.scope.flow_id) {
      issueAt(
        ctx,
        [index, 'scope', 'flow_id'],
        'proof.assessed flow scope does not match proof_policy guidance',
      );
    }
    if (guidance.scope.step_id !== entry.scope.step_id) {
      issueAt(
        ctx,
        [index, 'scope', 'step_id'],
        'proof.assessed step scope does not match proof_policy guidance',
      );
    }
    if (guidance.scope.attempt !== entry.scope.attempt) {
      issueAt(
        ctx,
        [index, 'scope', 'attempt'],
        'proof.assessed attempt scope does not match proof_policy guidance',
      );
    }
  }

  for (let index = 0; index < traceEntries.length; index += 1) {
    const entry = traceEntries[index];
    if (entry === undefined || !isGuidanceDecision(entry) || entry.subject !== 'recovery_route') {
      continue;
    }

    const completed = findFollowingStepCompleted(traceEntries, entry, index);
    if (completed === undefined) {
      issueAt(
        ctx,
        [index, 'kind'],
        'recovery_route guidance requires a following step.completed for the same step attempt',
      );
      continue;
    }

    const selected = selectedRecord(entry);
    if (selected.route_id !== completed.entry.route_taken) {
      issueAt(
        ctx,
        [completed.index, 'route_taken'],
        `step.completed route_taken '${completed.entry.route_taken}' does not match recovery guidance route '${String(selected.route_id)}'`,
      );
    }
  }

  for (let index = 0; index < traceEntries.length; index += 1) {
    const entry = traceEntries[index];
    if (entry?.kind !== 'safe_apply.result') continue;

    if (entry.scope.flow_id !== bootstrap.flow_id) {
      issueAt(
        ctx,
        [index, 'scope', 'flow_id'],
        `safe_apply.result scope.flow_id '${String(entry.scope.flow_id)}' does not match bootstrap flow_id '${bootstrap.flow_id}'`,
      );
    }

    const guidance = findPriorSafeApplyGuidance(traceEntries, entry, index);
    if (guidance === undefined) {
      issueAt(
        ctx,
        [index, 'decision_id'],
        'safe_apply.result requires prior matching safe_apply guidance when guidance decisions are present',
      );
      continue;
    }

    if (guidance.scope.flow_id !== entry.scope.flow_id) {
      issueAt(
        ctx,
        [index, 'scope', 'flow_id'],
        'safe_apply.result flow scope does not match safe_apply guidance',
      );
    }
    if (guidance.scope.step_id !== entry.scope.step_id) {
      issueAt(
        ctx,
        [index, 'scope', 'step_id'],
        'safe_apply.result step scope does not match safe_apply guidance',
      );
    }
    if (guidance.scope.attempt !== entry.scope.attempt) {
      issueAt(
        ctx,
        [index, 'scope', 'attempt'],
        'safe_apply.result attempt scope does not match safe_apply guidance',
      );
    }

    const selected = selectedRecord(guidance);
    if (!selectedSafeApplyActionMatches(selected.action, entry.action)) {
      issueAt(
        ctx,
        [index, 'action'],
        `safe_apply.result action '${entry.action}' does not match safe_apply guidance action '${String(selected.action)}'`,
      );
    }
    if (!sameJson(selected.change_packet_ref, entry.change_packet_ref)) {
      issueAt(
        ctx,
        [index, 'change_packet_ref'],
        'safe_apply.result change_packet_ref does not match safe_apply guidance',
      );
    }
    if (!sameJson(selected.base_ref, entry.base_ref)) {
      issueAt(
        ctx,
        [index, 'base_ref'],
        'safe_apply.result base_ref does not match safe_apply guidance',
      );
    }
    if (selected.protected_file_decision !== entry.protected_file_decision) {
      issueAt(
        ctx,
        [index, 'protected_file_decision'],
        'safe_apply.result protected_file_decision does not match safe_apply guidance',
      );
    }
    if (!sameJson(selected.final_verification_ref, entry.final_verification_ref)) {
      issueAt(
        ctx,
        [index, 'final_verification_ref'],
        'safe_apply.result final_verification_ref does not match safe_apply guidance',
      );
    }
  }

  validateCompleteCloseGates(traceEntries, ctx);
}

// Own-property guard for identity fields on raw input. Zod normally reads
// inherited properties during parse, which lets `Object.create({run_id:
// other})` smuggle a phantom run_id past the discriminated union. We run
// the check as a preprocess on the raw array so the guard sees the
// original objects (with their prototype chains) before Zod copies
// properties into fresh plain objects. The guarded fields are the
// identity fields whose spoofing would defeat the bootstrap-first and
// run_id-consistency invariants.
const GUARDED_OWN_FIELDS = ['run_id', 'kind', 'sequence'] as const;

const ownPropertyGuardedArray = z.custom<unknown[]>((raw) => {
  if (!Array.isArray(raw)) return true;
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    for (const field of GUARDED_OWN_FIELDS) {
      if (!Object.hasOwn(entry, field)) return false;
    }
  }
  return true;
}, 'trace_entry has inherited (not own) identity field; prototype-chain smuggle rejected');

export const RunTrace = ownPropertyGuardedArray.pipe(
  RunTraceBody.superRefine((trace_entries, ctx) => {
    // First trace_entry must be `run.bootstrapped`. A RunTrace with any
    // other leading entry is structurally invalid: bootstrap carries
    // change_kind, depth, manifest_hash, and flow_id, none of which can
    // be inferred later.
    const first = trace_entries[0];
    if (first === undefined || first.kind !== 'run.bootstrapped') {
      issueAt(
        ctx,
        [0, 'kind'],
        `first trace_entry must be 'run.bootstrapped', got '${first?.kind ?? '<empty>'}'`,
      );
    }

    // Bootstrap singleton. Multiple bootstraps within one log would make
    // change_kind/depth/manifest_hash ambiguous at replay time.
    let bootstrapCount = 0;
    for (let i = 0; i < trace_entries.length; i++) {
      const e = trace_entries[i];
      if (e?.kind === 'run.bootstrapped') {
        bootstrapCount += 1;
        if (bootstrapCount > 1) {
          issueAt(
            ctx,
            [i, 'kind'],
            `second 'run.bootstrapped' at index ${i}; a RunTrace must bootstrap exactly once`,
          );
        }
      }
    }

    // Sequence is 0-based, contiguous, monotonic. Gaps or repeats indicate
    // an ingestion bug or a concurrent-writer race and make replay
    // non-deterministic. `sequence` is the authoritative ordering key;
    // `recorded_at` is diagnostic metadata and may legitimately be
    // non-monotonic under clock adjustments.
    for (let i = 0; i < trace_entries.length; i++) {
      const e = trace_entries[i];
      if (e === undefined) continue;
      if (e.sequence !== i) {
        issueAt(
          ctx,
          [i, 'sequence'],
          `trace_entry at index ${i} has sequence=${e.sequence}; expected contiguous 0-based sequence (should be ${i})`,
        );
      }
    }

    // Run_id consistency. Cross-run trace_entry smuggling is the single
    // most dangerous corruption mode for trace-sourced state.
    const canonical = first?.run_id;
    for (let i = 0; i < trace_entries.length; i++) {
      const e = trace_entries[i];
      if (e === undefined || canonical === undefined) continue;
      if (e.run_id !== canonical) {
        issueAt(
          ctx,
          [i, 'run_id'],
          `trace_entry at index ${i} has run_id='${e.run_id as unknown as string}' but RunTrace is for run_id='${canonical as unknown as string}'`,
        );
      }
    }

    // At-most-one close; no trace entries after close. A closed run whose
    // log grows again silently re-opens it; the transition from in-progress
    // to closed must be explicit and one-way.
    let closedAt = -1;
    for (let i = 0; i < trace_entries.length; i++) {
      const e = trace_entries[i];
      if (e?.kind !== 'run.closed') continue;
      if (closedAt >= 0) {
        issueAt(
          ctx,
          [i, 'kind'],
          `second 'run.closed' at index ${i}; a RunTrace closes at most once`,
        );
      } else {
        closedAt = i;
      }
    }
    if (closedAt >= 0 && closedAt !== trace_entries.length - 1) {
      issueAt(
        ctx,
        [closedAt + 1, 'kind'],
        `trace_entries after 'run.closed' at index ${closedAt}; nothing may be appended after closure`,
      );
    }

    // Skill-hook provenance. A loaded skill stamped cause 'skill-hook' claims
    // a run-time auto-injection actually happened. That claim is sound only if
    // a real run.skill-hook event in this same trace triggered that skill id.
    // This closes the laundering path where a hook-injected skill is read back
    // as author-declared, and its inverse: a 'skill-hook' stamp with no event
    // behind it.
    const hookTriggeredIds = new Set<string>();
    for (const e of trace_entries) {
      if (e?.kind !== 'run.skill-hook') continue;
      for (const triggered of e.event.triggered_skills) {
        hookTriggeredIds.add(triggered.id as unknown as string);
      }
    }
    for (let i = 0; i < trace_entries.length; i++) {
      const e = trace_entries[i];
      if (e?.kind !== 'skills.loaded') continue;
      e.skills.forEach((skill, skillIndex) => {
        if (skill.cause !== 'skill-hook') return;
        if (!hookTriggeredIds.has(skill.id as unknown as string)) {
          issueAt(
            ctx,
            [i, 'skills', skillIndex, 'cause'],
            `loaded skill '${skill.id as unknown as string}' has cause 'skill-hook' but no matching run.skill-hook event triggered it`,
          );
        }
      });
    }

    validateGuidanceTraceSequence(trace_entries, ctx);
  }),
);
export type RunTrace = z.infer<typeof RunTrace>;

// The outcome-to-status mapping is pinned as a compile-time total function.
// Typing the record as `Record<RunClosedOutcome, Exclude<SnapshotStatus,
// 'in_progress'>>` makes any future drift between the two enums a compile
// error, not just a runtime test failure.
type ClosedSnapshotStatus = Exclude<SnapshotStatus, 'in_progress'>;
const SNAPSHOT_STATUS_FOR_OUTCOME: Record<RunClosedOutcome, ClosedSnapshotStatus> = {
  complete: 'complete',
  aborted: 'aborted',
  evidence_invalid: 'evidence_invalid',
  handoff: 'handoff',
  stopped: 'stopped',
  escalated: 'escalated',
};

// Compile-time bidirectional guard: `ClosedSnapshotStatus` and `RunClosedOutcome`
// must be the same string-literal set. If one drifts, `OutcomeStatusEquality`
// collapses to `never` and the `_compileTimeOutcomeStatusParity` marker fails
// the build before the runtime ever sees an unmapped outcome.
type IsExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type OutcomeStatusEquality = IsExact<ClosedSnapshotStatus, RunClosedOutcome> extends true
  ? true
  : never;
export const _compileTimeOutcomeStatusParity: OutcomeStatusEquality = true;

const RunProjectionBody = z
  .object({
    log: RunTrace,
    snapshot: Snapshot,
  })
  .strict();

// RunProjection binds the trace and its derived snapshot. Schema-level
// statement of "snapshot is a pure function of log": if the two disagree
// on run_id, flow_id, change_kind, depth, manifest_hash, or invocation_id,
// or if `trace_entries_consumed` is not equal to `log.length`, or if
// snapshot.status contradicts the log's closure state, the projection is
// rejected. This proves a RunProjection a caller hands us is internally
// consistent; it does not prove the reducer that produced it is correct.
export const RunProjection = RunProjectionBody.superRefine(({ log, snapshot }, ctx) => {
  // Find the bootstrap trace_entry. RunTrace already guarantees it exists
  // and is at index 0, but we guard anyway so narrowing is explicit.
  const bootstrapTraceEntry = log[0];
  if (bootstrapTraceEntry === undefined || bootstrapTraceEntry.kind !== 'run.bootstrapped') {
    // RunTrace parsing will have already complained; bail without duplicating.
    return;
  }
  const bootstrap: RunBootstrappedTraceEntry = bootstrapTraceEntry;

  // Binding fields that are frozen at bootstrap and must survive into the
  // snapshot unchanged.
  if (snapshot.run_id !== bootstrap.run_id) {
    issueAt(ctx, ['snapshot', 'run_id'], 'snapshot.run_id differs from bootstrap.run_id');
  }
  if (snapshot.flow_id !== bootstrap.flow_id) {
    issueAt(ctx, ['snapshot', 'flow_id'], 'snapshot.flow_id differs from bootstrap.flow_id');
  }
  if (snapshot.manifest_hash !== bootstrap.manifest_hash) {
    issueAt(
      ctx,
      ['snapshot', 'manifest_hash'],
      'snapshot.manifest_hash differs from bootstrap.manifest_hash; manifest is immutable per run',
    );
  }
  if (snapshot.depth !== bootstrap.depth) {
    issueAt(ctx, ['snapshot', 'depth'], 'snapshot.depth differs from bootstrap.depth');
  }
  // Deep-compare change_kind: ChangeKindDeclaration is `.strict()` in every variant, so
  // surplus keys are already rejected at TraceEntry/Snapshot parse time. Remaining
  // work here is structural equality; we compare field-by-field against the
  // union's declared fields to avoid JSON.stringify ordering assumptions.
  if (!change_kindEquals(snapshot.change_kind, bootstrap.change_kind)) {
    issueAt(
      ctx,
      ['snapshot', 'change_kind'],
      'snapshot.change_kind differs from bootstrap.change_kind; change_kind is frozen at bootstrap',
    );
  }
  // InvocationId: both absent, or both present and equal. The direct `!==`
  // covers both (undefined === undefined is true; string === string is value
  // equality; one-side-undefined is rejected).
  if (snapshot.invocation_id !== bootstrap.invocation_id) {
    issueAt(
      ctx,
      ['snapshot', 'invocation_id'],
      'snapshot.invocation_id differs from bootstrap.invocation_id',
    );
  }

  // trace_entries_consumed is bound to log length exactly. A snapshot that
  // claims fewer entries than exist is a stale prefix cache, not "the"
  // current projection. Equality is the stronger bar than ≤.
  if (snapshot.trace_entries_consumed !== log.length) {
    issueAt(
      ctx,
      ['snapshot', 'trace_entries_consumed'],
      `snapshot.trace_entries_consumed=${snapshot.trace_entries_consumed} must equal log length=${log.length}; prefix snapshots are rejected`,
    );
  }

  const closed = log.find((e): e is RunClosedTraceEntry => e.kind === 'run.closed');
  if (closed === undefined) {
    if (snapshot.status !== 'in_progress') {
      issueAt(
        ctx,
        ['snapshot', 'status'],
        `log has no 'run.closed' trace_entry so snapshot.status must be 'in_progress', got '${snapshot.status}'`,
      );
    }
  } else {
    const expected = SNAPSHOT_STATUS_FOR_OUTCOME[closed.outcome];
    if (snapshot.status !== expected) {
      issueAt(
        ctx,
        ['snapshot', 'status'],
        `run.closed.outcome='${closed.outcome}' requires snapshot.status='${expected}', got '${snapshot.status}'`,
      );
    }
  }
});
export type RunProjection = z.infer<typeof RunProjection>;

// Structural change_kind equality without relying on key-order stability. Every
// ChangeKindDeclaration variant is `.strict()`, so surplus keys cannot smuggle
// through; here we compare the declared fields by value.
function change_kindEquals(
  a: RunBootstrappedTraceEntry['change_kind'],
  b: RunBootstrappedTraceEntry['change_kind'],
): boolean {
  if (a.change_kind !== b.change_kind) return false;
  if (a.failure_mode !== b.failure_mode) return false;
  if (a.acceptance_evidence !== b.acceptance_evidence) return false;
  if (a.alternate_framing !== b.alternate_framing) return false;
  if (a.change_kind === 'migration-escrow' && b.change_kind === 'migration-escrow') {
    return a.expires_at === b.expires_at && a.restoration_plan === b.restoration_plan;
  }
  if (a.change_kind === 'break-glass' && b.change_kind === 'break-glass') {
    return a.post_hoc_adr_deadline_at === b.post_hoc_adr_deadline_at;
  }
  return true;
}
