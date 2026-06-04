import { z } from 'zod';

export const FLOW_BLOCK_IDS = [
  'intake',
  'route',
  'frame',
  'clarify',
  'human-decision',
  'gather-context',
  'diagnose',
  'plan',
  'act',
  'run-verification',
  'review',
  'goal',
  'pursue',
  'coordinate-pursuits',
  'queue',
  'batch',
  'risk-rollback-check',
  'close-with-evidence',
  'handoff',
] as const;

export const FlowBlockId = z.enum(FLOW_BLOCK_IDS);
export type FlowBlockId = z.infer<typeof FlowBlockId>;

export const FlowRoute = z.enum([
  'continue',
  'connector-failed',
  'retry',
  'revise',
  'ask',
  'split',
  'stop',
  'handoff',
  'escalate',
  'complete',
  'fix',
  'build',
  'review',
  'explore',
  'pursue',
  'completion-gate',
  'retry-selected-flow',
  'run-fix',
  'run-review',
  'run-explore',
  'split-to-pursue',
  'checkpoint',
  'blocked',
  'recover',
  'run-next-gate-pass',
  'close',
  // Slice-loop forward edge: a passed slice verify re-enters the loop head
  // for the next slice (deep-rigor Build). See
  // docs/ideas/build-slice-decomposition.md.
  'advance',
]);
export type FlowRoute = z.infer<typeof FlowRoute>;

export const FlowBlockActionSurface = z.enum(['orchestrator', 'worker', 'host', 'mixed']);
export type FlowBlockActionSurface = z.infer<typeof FlowBlockActionSurface>;

export const FlowBlockCheckKind = z.enum([
  'schema',
  'decision',
  'command',
  'review',
  'risk',
  'queue',
  'coordination',
]);
export type FlowBlockCheckKind = z.infer<typeof FlowBlockCheckKind>;

export const FlowBlockHumanInteraction = z.enum([
  'never',
  'optional',
  'required',
  'mode-dependent',
]);
export type FlowBlockHumanInteraction = z.infer<typeof FlowBlockHumanInteraction>;

export const FlowContractRef = z.string().regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+@v[0-9]+$/);
export type FlowContractRef = z.infer<typeof FlowContractRef>;

export const FlowInputContractSet = z
  .array(FlowContractRef)
  .min(1)
  .superRefine((contracts, ctx) => {
    const seen = new Set<string>();
    for (const [index, contract] of contracts.entries()) {
      if (seen.has(contract)) {
        ctx.addIssue({
          code: 'custom',
          path: [index],
          message: `duplicate input contract: ${contract}`,
        });
      }
      seen.add(contract);
    }
  });
export type FlowInputContractSet = z.infer<typeof FlowInputContractSet>;

const nonEmptyUniqueStrings = z
  .array(z.string().min(1))
  .min(1)
  .superRefine((values, ctx) => {
    const seen = new Set<string>();
    for (const [index, value] of values.entries()) {
      if (seen.has(value)) {
        ctx.addIssue({
          code: 'custom',
          path: [index],
          message: `duplicate value: ${value}`,
        });
      }
      seen.add(value);
    }
  });

const HostCapabilities = z
  .object({
    claude: z.array(z.string().min(1)).default([]),
    codex: z.array(z.string().min(1)).default([]),
    non_interactive: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type HostCapabilities = z.infer<typeof HostCapabilities>;

export const FlowBlock = z
  .object({
    id: FlowBlockId,
    title: z.string().min(1),
    purpose: z.string().min(1),
    input_contracts: FlowInputContractSet,
    alternative_input_contracts: z.array(FlowInputContractSet).default([]),
    output_contract: FlowContractRef,
    action_surface: FlowBlockActionSurface,
    produces_evidence: nonEmptyUniqueStrings,
    check: z
      .object({
        kind: FlowBlockCheckKind,
        description: z.string().min(1),
      })
      .strict(),
    allowed_routes: z.array(FlowRoute).min(1),
    human_interaction: FlowBlockHumanInteraction,
    host_capabilities: HostCapabilities,
    notes: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((block, ctx) => {
    const routeSet = new Set<FlowRoute>();
    for (const [index, route] of block.allowed_routes.entries()) {
      if (routeSet.has(route)) {
        ctx.addIssue({
          code: 'custom',
          path: ['allowed_routes', index],
          message: `duplicate route: ${route}`,
        });
      }
      routeSet.add(route);
    }

    if (block.id === 'human-decision') {
      if (block.human_interaction !== 'mode-dependent') {
        ctx.addIssue({
          code: 'custom',
          path: ['human_interaction'],
          message: 'human-decision must be mode-dependent',
        });
      }
      if (block.host_capabilities.claude.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['host_capabilities', 'claude'],
          message: 'human-decision must name a Claude host strategy',
        });
      }
      if (block.host_capabilities.codex.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['host_capabilities', 'codex'],
          message: 'human-decision must name a Codex host strategy',
        });
      }
      if (block.host_capabilities.non_interactive.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['host_capabilities', 'non_interactive'],
          message: 'human-decision must name a non-interactive host strategy',
        });
      }
    }

    if (block.id === 'close-with-evidence' && !routeSet.has('complete')) {
      ctx.addIssue({
        code: 'custom',
        path: ['allowed_routes'],
        message: 'close-with-evidence must allow complete',
      });
    }
  });
export type FlowBlock = z.infer<typeof FlowBlock>;

export const FlowBlockCatalog = z
  .object({
    schema_version: z.literal('1'),
    blocks: z.array(FlowBlock).min(FLOW_BLOCK_IDS.length),
  })
  .strict()
  .superRefine((catalog, ctx) => {
    const seen = new Map<FlowBlockId, number>();
    for (const [index, block] of catalog.blocks.entries()) {
      const prior = seen.get(block.id);
      if (prior !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['blocks', index, 'id'],
          message: `duplicate block id: ${block.id} also appears at index ${prior}`,
        });
      }
      seen.set(block.id, index);
    }

    for (const requiredId of FLOW_BLOCK_IDS) {
      if (!seen.has(requiredId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['blocks'],
          message: `missing block id: ${requiredId}`,
        });
      }
    }
  });
export type FlowBlockCatalog = z.infer<typeof FlowBlockCatalog>;
