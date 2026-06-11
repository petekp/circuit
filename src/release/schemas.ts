import { z } from 'zod';

export const ReleaseCapabilityStatus = z.enum([
  'implemented',
  'missing',
  'partial',
  'release_blocker',
  'approved_exception',
  'planned',
]);
export type ReleaseCapabilityStatus = z.infer<typeof ReleaseCapabilityStatus>;

export const PublicClaimStatus = z.enum([
  'verified_current',
  'planned',
  'release_blocker',
  'approved_exception',
]);
export type PublicClaimStatus = z.infer<typeof PublicClaimStatus>;

export const ProofScenarioStatus = z.enum([
  'verified_current',
  'missing',
  'planned',
  'release_blocker',
  'approved_exception',
]);
export type ProofScenarioStatus = z.infer<typeof ProofScenarioStatus>;

export const ReleaseItemKind = z.enum([
  'flow',
  'utility',
  'mode',
  'router_intent',
  'route_outcome',
  'connector',
  'host',
  'continuity',
  'checkpoint',
  'customization',
  'proof',
  'plan_execution',
  'safety',
  'docs',
]);
export type ReleaseItemKind = z.infer<typeof ReleaseItemKind>;

export const ClaimType = z.enum([
  'flow',
  'mode',
  'connector',
  'host',
  'safety',
  'proof',
  'first-run',
  'plan-execution',
  'customization',
  'docs',
]);
export type ClaimType = z.infer<typeof ClaimType>;

export const ReleaseSourceRef = z
  .object({
    id: z.string().min(1),
    path: z.string().min(1),
    note: z.string().min(1),
  })
  .strict();
export type ReleaseSourceRef = z.infer<typeof ReleaseSourceRef>;

export const CapabilityAxes = z
  .object({
    invocation: z.string().optional(),
    intent_hints: z.array(z.string().min(1)).default([]),
    modes: z.array(z.string().min(1)).default([]),
    stage_path: z.array(z.string().min(1)).default([]),
    outputs: z.array(z.string().min(1)).default([]),
    checkpoint: z.string().optional(),
    review: z.string().optional(),
    verification: z.string().optional(),
    worker_handoff: z.string().optional(),
    continuity: z.string().optional(),
    host_surface: z.string().optional(),
    proof: z.string().optional(),
  })
  .strict();
export type CapabilityAxes = z.infer<typeof CapabilityAxes>;

const DEFAULT_CAPABILITY_AXES = {
  intent_hints: [],
  modes: [],
  stage_path: [],
  outputs: [],
} satisfies CapabilityAxes;

export const OriginalCapability = z
  .object({
    id: z.string().min(1),
    kind: ReleaseItemKind,
    title: z.string().min(1),
    summary: z.string().min(1),
    release_required: z.boolean().default(true),
    axes: CapabilityAxes.default(DEFAULT_CAPABILITY_AXES),
    source_refs: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type OriginalCapability = z.infer<typeof OriginalCapability>;

export const OriginalCapabilitySnapshot = z
  .object({
    schema_version: z.literal(1),
    sources: z.array(ReleaseSourceRef).min(1),
    capabilities: z.array(OriginalCapability).min(1),
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    const sourceIds = new Set(snapshot.sources.map((source) => source.id));
    const capabilityIds = new Set<string>();
    for (let index = 0; index < snapshot.capabilities.length; index += 1) {
      const capability = snapshot.capabilities[index];
      if (capability === undefined) continue;
      if (capabilityIds.has(capability.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['capabilities', index, 'id'],
          message: `duplicate capability id: ${capability.id}`,
        });
      }
      capabilityIds.add(capability.id);
      for (const sourceRef of capability.source_refs) {
        if (!sourceIds.has(sourceRef)) {
          ctx.addIssue({
            code: 'custom',
            path: ['capabilities', index, 'source_refs'],
            message: `unknown source ref: ${sourceRef}`,
          });
        }
      }
    }
  });
export type OriginalCapabilitySnapshot = z.infer<typeof OriginalCapabilitySnapshot>;

export const FlowAxisSupportRecord = z
  .object({
    allowed_depths: z.array(z.enum(['low', 'medium', 'high'])).min(1),
    supports_tournament: z.boolean(),
    supports_autonomous: z.boolean(),
    default: z
      .object({
        depth: z.enum(['low', 'medium', 'high']),
        tournament: z.boolean(),
        tournament_n: z.number().int().min(2).max(4),
        autonomous: z.boolean(),
      })
      .strict(),
    tournament_fan_out_stage: z.string().min(1).optional(),
  })
  .strict();
export type FlowAxisSupportRecord = z.infer<typeof FlowAxisSupportRecord>;

export const CurrentCapability = z
  .object({
    id: z.string().min(1),
    kind: ReleaseItemKind,
    title: z.string().min(1),
    status: ReleaseCapabilityStatus,
    summary: z.string().min(1),
    evidence: z.array(z.string().min(1)).default([]),
    readiness_refs: z.array(z.string().regex(/^REL-[0-9]+$/)).default([]),
    axes: CapabilityAxes.default(DEFAULT_CAPABILITY_AXES),
  })
  .strict();
export type CurrentCapability = z.infer<typeof CurrentCapability>;

export const FlowCapabilityRecord = z
  .object({
    id: z.string().min(1),
    source: z.string().min(1),
    command_path: z.string().optional(),
    contract_path: z.string().optional(),
    axis_support: FlowAxisSupportRecord,
    stages: z.array(z.string().min(1)).default([]),
    reports: z.array(z.string().min(1)).default([]),
    writers: z
      .object({
        compose: z.number().int().nonnegative(),
        close: z.number().int().nonnegative(),
        verification: z.number().int().nonnegative(),
        checkpoint: z.number().int().nonnegative(),
      })
      .strict(),
    route_outcomes: z.array(z.string().min(1)).default([]),
    unsupported_route_outcomes: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type FlowCapabilityRecord = z.infer<typeof FlowCapabilityRecord>;

export const ConnectorCapabilityRecord = z
  .object({
    id: z.string().min(1),
    status: ReleaseCapabilityStatus,
    filesystem: z.string().optional(),
    structured_output: z.string().optional(),
    protocol: z.string().optional(),
    summary: z.string().min(1),
    readiness_refs: z.array(z.string().regex(/^REL-[0-9]+$/)).default([]),
  })
  .strict();
export type ConnectorCapabilityRecord = z.infer<typeof ConnectorCapabilityRecord>;

export const HostCapabilityRecord = z
  .object({
    id: z.string().min(1),
    status: ReleaseCapabilityStatus,
    summary: z.string().min(1),
    evidence: z.array(z.string().min(1)).default([]),
    readiness_refs: z.array(z.string().regex(/^REL-[0-9]+$/)).default([]),
  })
  .strict();
export type HostCapabilityRecord = z.infer<typeof HostCapabilityRecord>;

export const CurrentCapabilitySnapshot = z
  .object({
    schema_version: z.literal(1),
    generated_by: z.string().min(1),
    flows: z.array(FlowCapabilityRecord),
    commands: z
      .object({
        source: z.array(z.string().min(1)),
        claude_plugin: z.array(z.string().min(1)),
        codex_plugin: z.array(z.string().min(1)),
        claude_plugin_skills: z.array(z.string().min(1)),
      })
      .strict(),
    connectors: z.array(ConnectorCapabilityRecord),
    hosts: z.array(HostCapabilityRecord),
    capabilities: z.array(CurrentCapability),
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    const ids = new Set<string>();
    for (let index = 0; index < snapshot.capabilities.length; index += 1) {
      const capability = snapshot.capabilities[index];
      if (capability === undefined) continue;
      if (ids.has(capability.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['capabilities', index, 'id'],
          message: `duplicate current capability id: ${capability.id}`,
        });
      }
      ids.add(capability.id);
    }
  });
export type CurrentCapabilitySnapshot = z.infer<typeof CurrentCapabilitySnapshot>;

export const ParityException = z
  .object({
    id: z.string().min(1),
    capability_id: z.string().min(1).optional(),
    claim_id: z.string().min(1).optional(),
    proof_id: z.string().min(1).optional(),
    status: z.enum(['release_blocker', 'approved_exception']),
    readiness_ref: z.string().regex(/^REL-[0-9]+$/),
    rationale: z.string().min(1),
    public_wording: z.string().min(1).optional(),
  })
  .strict()
  .refine(
    (exception) =>
      exception.capability_id !== undefined ||
      exception.claim_id !== undefined ||
      exception.proof_id !== undefined,
    'exception must bind to a capability_id, claim_id, or proof_id',
  );
export type ParityException = z.infer<typeof ParityException>;

export const ParityExceptionLedger = z
  .object({
    schema_version: z.literal(1),
    exceptions: z.array(ParityException),
  })
  .strict()
  .superRefine((ledger, ctx) => {
    const ids = new Set<string>();
    for (let index = 0; index < ledger.exceptions.length; index += 1) {
      const exception = ledger.exceptions[index];
      if (exception === undefined) continue;
      if (ids.has(exception.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['exceptions', index, 'id'],
          message: `duplicate exception id: ${exception.id}`,
        });
      }
      ids.add(exception.id);
    }
  });
export type ParityExceptionLedger = z.infer<typeof ParityExceptionLedger>;

export const PublicClaim = z
  .object({
    id: z.string().min(1),
    claim: z.string().min(1),
    type: ClaimType,
    status: PublicClaimStatus,
    surfaces: z.array(z.string().min(1)).min(1),
    backing: z
      .object({
        capability_ids: z.array(z.string().min(1)).default([]),
        proof_ids: z.array(z.string().min(1)).default([]),
        exception_ids: z.array(z.string().min(1)).default([]),
        test_paths: z.array(z.string().min(1)).default([]),
        script_checks: z.array(z.string().min(1)).default([]),
      })
      .strict()
      .default({
        capability_ids: [],
        proof_ids: [],
        exception_ids: [],
        test_paths: [],
        script_checks: [],
      }),
    user_risk: z.string().min(1),
    readiness_refs: z.array(z.string().regex(/^REL-[0-9]+$/)).default([]),
  })
  .strict();
export type PublicClaim = z.infer<typeof PublicClaim>;

export const PublicClaimLedger = z
  .object({
    schema_version: z.literal(1),
    claims: z.array(PublicClaim),
  })
  .strict()
  .superRefine((ledger, ctx) => {
    const ids = new Set<string>();
    for (let index = 0; index < ledger.claims.length; index += 1) {
      const claim = ledger.claims[index];
      if (claim === undefined) continue;
      if (ids.has(claim.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['claims', index, 'id'],
          message: `duplicate claim id: ${claim.id}`,
        });
      }
      ids.add(claim.id);
    }
  });
export type PublicClaimLedger = z.infer<typeof PublicClaimLedger>;

export const ProofScenario = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    category: z.enum([
      'doing-work',
      'deciding',
      'continuity',
      'customization',
      'first-run',
      'failure',
      'plan-execution',
    ]),
    command: z.string().min(1),
    expected_flow: z.string().min(1).optional(),
    expected_outcome: z.string().min(1),
    summary_contract: z.string().min(1),
    redaction_policy: z.string().min(1),
    required_files: z.array(z.string().min(1)).default([]),
    status: ProofScenarioStatus,
    backing_paths: z.array(z.string().min(1)).default([]),
    exception_ids: z.array(z.string().min(1)).default([]),
    readiness_refs: z.array(z.string().regex(/^REL-[0-9]+$/)).default([]),
  })
  .strict();
export type ProofScenario = z.infer<typeof ProofScenario>;

export const ProofScenarioIndex = z
  .object({
    schema_version: z.literal(1),
    scenarios: z.array(ProofScenario).min(1),
  })
  .strict()
  .superRefine((index, ctx) => {
    const ids = new Set<string>();
    for (let offset = 0; offset < index.scenarios.length; offset += 1) {
      const scenario = index.scenarios[offset];
      if (scenario === undefined) continue;
      if (ids.has(scenario.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['scenarios', offset, 'id'],
          message: `duplicate proof scenario id: ${scenario.id}`,
        });
      }
      ids.add(scenario.id);
    }
  });
export type ProofScenarioIndex = z.infer<typeof ProofScenarioIndex>;

export const ReleaseReadinessReport = z
  .object({
    schema_version: z.literal(1),
    summary: z.string().min(1),
    blockers: z.array(z.string().min(1)),
    warnings: z.array(z.string().min(1)),
    next_actions: z.array(z.string().min(1)),
  })
  .strict();
export type ReleaseReadinessReport = z.infer<typeof ReleaseReadinessReport>;
