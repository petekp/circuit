import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const Slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const SurfaceId = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/);

const VisionSchema = z
  .object({
    id: Slug,
    title: z.string().min(1),
    role: z.enum(['lead', 'co-pillar', 'floor', 'enabler', 'future-loop']),
    statement: z.string().min(1),
  })
  .strict();

const AreaSchema = z
  .object({
    id: Slug,
    title: z.string().min(1),
    summary: z.string().min(1),
  })
  .strict();

const PathEvidenceRefSchema = z
  .object({
    kind: z.enum(['source', 'behavior-test', 'decision', 'proposal']),
    path: z.string().min(1),
    proves: z.string().min(1),
  })
  .strict();

const ReleaseProofEvidenceRefSchema = z
  .object({
    kind: z.literal('release-proof'),
    path: z.string().min(1).optional(),
    proof_id: z.string().min(1).optional(),
    proves: z.string().min(1),
  })
  .strict()
  .superRefine((ref, ctx) => {
    if (ref.path === undefined && ref.proof_id === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'release-proof evidence requires path or proof_id',
      });
    }
  });

const PublicClaimEvidenceRefSchema = z
  .object({
    kind: z.literal('public-claim'),
    claim_id: z.string().min(1),
    proves: z.string().min(1),
  })
  .strict();

export const EvidenceRefSchema = z.union([
  PathEvidenceRefSchema,
  ReleaseProofEvidenceRefSchema,
  PublicClaimEvidenceRefSchema,
]);
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

const ClaimSchema = z
  .object({
    id: Slug,
    statement: z.string().min(1),
    level: z.enum(['source', 'tested', 'release-observed', 'decision', 'proposal']),
    refs: z.array(EvidenceRefSchema).min(1),
  })
  .strict();

const AttentionDispositionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('review-question'), id: Slug }).strict(),
  z.object({ kind: z.literal('boundary'), id: Slug }).strict(),
  z.object({ kind: z.literal('accepted'), reason: z.string().min(1) }).strict(),
]);

const AttentionSchema = z
  .object({
    id: Slug,
    kind: z.enum(['gap', 'overlap', 'young', 'boundary']),
    note: z.string().min(1),
    related_nodes: z.array(Slug).default([]),
    disposition: AttentionDispositionSchema,
  })
  .strict();

const VisionLinkSchema = z
  .object({
    id: Slug,
    fit: z.enum(['direct', 'enabling']),
  })
  .strict();

const MaturitySchema = z.enum(['shipped', 'partial', 'proposed']);

const CapabilitySchema = z
  .object({
    id: Slug,
    area: Slug,
    title: z.string().min(1),
    outcome: z.string().min(1),
    maturity: MaturitySchema,
    vision: z.array(VisionLinkSchema).min(1),
    claims: z.array(ClaimSchema).min(1),
    attention: z.array(AttentionSchema).default([]),
  })
  .strict();

const SupportingElementSchema = z
  .object({
    id: Slug,
    kind: z.enum(['control', 'guarantee', 'mechanism']),
    title: z.string().min(1),
    summary: z.string().min(1),
    maturity: MaturitySchema,
    supports_capabilities: z.array(Slug).min(1),
    claims: z.array(ClaimSchema).min(1),
    attention: z.array(AttentionSchema).default([]),
  })
  .strict();

export const SurfaceBindingRoleSchema = z.enum([
  'entry-point',
  'delivery',
  'control',
  'proof',
  'example',
  'dormant-vocabulary',
]);
export type SurfaceBindingRole = z.infer<typeof SurfaceBindingRoleSchema>;

const SurfaceBindingSchema = z
  .object({
    surface: SurfaceId,
    node: Slug,
    role: SurfaceBindingRoleSchema,
    note: z.string().min(1).optional(),
  })
  .strict();

const SurfaceExclusionSchema = z
  .object({
    surface: SurfaceId,
    role: z.literal('excluded'),
    reason: z.string().min(1),
  })
  .strict();

const RelationshipSchema = z
  .object({
    from: Slug,
    to: Slug,
    type: z.enum(['depends-on', 'enables', 'extends', 'overlaps-with', 'reveals']),
    reason: z.string().min(1),
  })
  .strict();

const BoundarySchema = z
  .object({
    id: Slug,
    title: z.string().min(1),
    rule: z.string().min(1),
    scope: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('catalog') }).strict(),
      z.object({ kind: z.literal('nodes'), ids: z.array(Slug).min(1) }).strict(),
    ]),
    refs: z.array(EvidenceRefSchema).min(1),
  })
  .strict();

const ReviewQuestionSchema = z
  .object({
    id: Slug,
    question: z.string().min(1),
    state: z.enum(['open', 'decided-held', 'resolved']),
    nodes: z.array(Slug).min(1),
    refs: z.array(EvidenceRefSchema).default([]),
  })
  .strict();

export const ProductCapabilityCatalogSchema = z
  .object({
    schema_version: z.literal('0.2-spike'),
    status: z.literal('disposable'),
    name: z.string().min(1),
    purpose: z.string().min(1),
    baseline: z
      .object({
        target: z.literal('current-checkout'),
        note: z.string().min(1),
      })
      .strict(),
    vision: z.array(VisionSchema).min(1),
    areas: z.array(AreaSchema).min(1),
    capabilities: z.array(CapabilitySchema).min(1),
    supporting_elements: z.array(SupportingElementSchema),
    surface_map: z.array(z.union([SurfaceBindingSchema, SurfaceExclusionSchema])),
    relationships: z.array(RelationshipSchema),
    boundaries: z.array(BoundarySchema),
    review_questions: z.array(ReviewQuestionSchema),
  })
  .strict();

export type ProductCapabilityCatalog = z.infer<typeof ProductCapabilityCatalogSchema>;
export type ProductCapability = ProductCapabilityCatalog['capabilities'][number];
export type SupportingElement = ProductCapabilityCatalog['supporting_elements'][number];
export type CatalogNode = ProductCapability | SupportingElement;
export type SurfaceMapItem = ProductCapabilityCatalog['surface_map'][number];

export const SurfaceKindSchema = z.enum([
  'app',
  'cli-front-door',
  'cli-command',
  'cli-subcommand',
  'cli-flag',
  'flow',
  'block',
  'host-kind',
  'host-command',
  'host-catalog',
  'host-skill',
  'host-flow',
  'host-hook',
  'install-path',
  'mcp-tool',
  'connector',
  'config-key',
  'skill-hook',
  'public-claim',
  'positioning-claim',
  'release-record',
  'run-output',
]);
export type SurfaceKind = z.infer<typeof SurfaceKindSchema>;

export const SurfaceReachSchema = z
  .object({
    channel: z.enum([
      'cli',
      'host-command',
      'host-skill',
      'host-hook',
      'install',
      'mcp',
      'docs',
      'internal',
    ]),
    host: z.enum(['claude', 'codex']).optional(),
    access: z.enum(['direct', 'automatic', 'install-gated']),
  })
  .strict();
export type SurfaceReach = z.infer<typeof SurfaceReachSchema>;

const ALLOWED_REACH_CHANNELS: Readonly<Record<SurfaceKind, readonly SurfaceReach['channel'][]>> = {
  app: ['internal'],
  'cli-front-door': ['cli'],
  'cli-command': ['cli'],
  'cli-subcommand': ['cli', 'internal'],
  'cli-flag': ['cli', 'internal'],
  flow: ['cli', 'host-command', 'mcp', 'internal'],
  block: ['cli', 'host-command', 'mcp', 'internal'],
  'host-kind': ['cli', 'host-command', 'mcp'],
  'host-command': ['host-command', 'internal'],
  'host-catalog': ['host-skill'],
  'host-skill': ['host-skill'],
  'host-flow': ['host-command', 'mcp'],
  'host-hook': ['host-hook'],
  'install-path': ['install'],
  'mcp-tool': ['mcp'],
  connector: ['cli', 'host-command', 'mcp'],
  'config-key': ['cli', 'internal'],
  'skill-hook': ['cli', 'host-command', 'mcp', 'internal'],
  'public-claim': ['docs'],
  'positioning-claim': ['docs', 'internal'],
  'release-record': ['docs'],
  'run-output': ['cli', 'host-command', 'mcp'],
};

export const SurfaceRecordSchema = z
  .object({
    id: SurfaceId,
    kind: SurfaceKindSchema,
    state: z.enum(['active', 'dormant']),
    origin: z.enum(['derived', 'declared']),
    reach: z.array(SurfaceReachSchema).min(1),
    source_paths: z.array(z.string().min(1)).min(1),
  })
  .strict()
  .superRefine((surface, ctx) => {
    for (const reach of surface.reach) {
      if (!ALLOWED_REACH_CHANNELS[surface.kind].includes(reach.channel)) {
        ctx.addIssue({
          code: 'custom',
          message: `${surface.kind} cannot use ${reach.channel} reach`,
        });
      }
      if (['host-command', 'host-skill', 'host-hook'].includes(reach.channel) && !reach.host) {
        ctx.addIssue({
          code: 'custom',
          message: `${reach.channel} reach requires a host`,
        });
      }
      if (reach.channel === 'mcp' && reach.host !== 'codex') {
        ctx.addIssue({ code: 'custom', message: 'MCP reach requires host codex' });
      }
      if (['cli', 'docs', 'internal'].includes(reach.channel) && reach.host) {
        ctx.addIssue({
          code: 'custom',
          message: `${reach.channel} reach cannot name a host`,
        });
      }
    }

    const hasChannel = (channel: SurfaceReach['channel']): boolean =>
      surface.reach.some((reach) => reach.channel === channel);
    if (surface.kind === 'mcp-tool' && !hasChannel('mcp')) {
      ctx.addIssue({ code: 'custom', message: 'MCP tool requires MCP reach' });
    }
    if (surface.kind === 'install-path' && !hasChannel('install')) {
      ctx.addIssue({ code: 'custom', message: 'install path requires install reach' });
    }
    if (surface.kind === 'host-skill' && !hasChannel('host-skill')) {
      ctx.addIssue({ code: 'custom', message: 'host skill requires host-skill reach' });
    }
    if (surface.kind === 'host-hook' && !hasChannel('host-hook')) {
      ctx.addIssue({ code: 'custom', message: 'host hook requires host-hook reach' });
    }
  });
export type SurfaceRecord = z.infer<typeof SurfaceRecordSchema>;

const CensusPartitionSchema = z.discriminatedUnion('state', [
  z.object({ kind: SurfaceKindSchema, state: z.literal('populated') }).strict(),
  z
    .object({
      kind: SurfaceKindSchema,
      state: z.literal('empty'),
      reason: z.string().min(1),
    })
    .strict(),
]);

export const CurrentSurfaceInventorySchema = z
  .object({
    surfaces: z.array(SurfaceRecordSchema),
    census_partitions: z.array(CensusPartitionSchema),
    proof_ids: z.array(z.string().min(1)),
    public_claim_ids: z.array(z.string().min(1)),
  })
  .strict();
export type CurrentSurfaceInventory = z.infer<typeof CurrentSurfaceInventorySchema>;

export interface SurfaceCoverage {
  readonly current: number;
  readonly dispositioned: number;
  readonly excluded: number;
  readonly unmapped: readonly string[];
  readonly declared: number;
}

export type DerivedReach = 'cli' | 'claude' | 'codex' | 'claude-hook' | 'codex-hook' | 'internal';

export interface CatalogAudit {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly coverage: Readonly<Record<string, SurfaceCoverage>>;
  readonly reach: Readonly<Record<string, readonly DerivedReach[]>>;
}

export const DEFAULT_CATALOG_PATH = fileURLToPath(new URL('./catalog.json', import.meta.url));
export const GENERATED_MARKDOWN_PATH = fileURLToPath(
  new URL('./capability-map.generated.md', import.meta.url),
);
export const GENERATED_INVENTORY_PATH = fileURLToPath(
  new URL('./surface-inventory.generated.json', import.meta.url),
);

const EXPOSURE_ROLES = new Set<SurfaceBindingRole>(['entry-point', 'delivery', 'control']);
const DELIVERY_ROLES = new Set<SurfaceBindingRole>(['entry-point', 'delivery']);
const NON_DELIVERY_SURFACE_KINDS = new Set<SurfaceKind>([
  'public-claim',
  'positioning-claim',
  'release-record',
]);
const PUBLIC_PRODUCT_SURFACE_KINDS = new Set<SurfaceKind>([
  'cli-front-door',
  'cli-command',
  'cli-subcommand',
  'cli-flag',
  'flow',
  'host-kind',
  'host-command',
  'host-catalog',
  'host-skill',
  'host-flow',
  'host-hook',
  'install-path',
  'mcp-tool',
  'connector',
  'config-key',
  'run-output',
]);
const REACH_ORDER: readonly DerivedReach[] = [
  'cli',
  'claude',
  'codex',
  'claude-hook',
  'codex-hook',
  'internal',
];

export function loadCatalog(path = DEFAULT_CATALOG_PATH): ProductCapabilityCatalog {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return ProductCapabilityCatalogSchema.parse(raw);
}

function findDuplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function recordDuplicateErrors(errors: string[], label: string, values: readonly string[]): void {
  for (const duplicate of findDuplicates(values)) {
    errors.push(`duplicate ${label} '${duplicate}'`);
  }
}

function pathFromEvidence(ref: EvidenceRef): string | undefined {
  if (ref.kind === 'public-claim') return undefined;
  if (ref.kind === 'release-proof') return ref.path;
  return ref.path;
}

function validateRepositoryFile(
  errors: string[],
  owner: string,
  path: string,
  repositoryRoot: string,
): void {
  if (isAbsolute(path) || path.split(/[\\/]/).includes('..')) {
    errors.push(`${owner} uses non-repository-relative path '${path}'`);
    return;
  }
  const absolutePath = resolve(repositoryRoot, path);
  if (!existsSync(absolutePath)) {
    errors.push(`${owner} points to missing file '${path}'`);
    return;
  }
  if (!statSync(absolutePath).isFile()) {
    errors.push(`${owner} points to non-file evidence '${path}'`);
  }
}

function validateEvidenceRefs(
  errors: string[],
  owner: string,
  refs: readonly EvidenceRef[],
  inventory: CurrentSurfaceInventory,
  repositoryRoot: string,
): void {
  for (const ref of refs) {
    const path = pathFromEvidence(ref);
    if (path !== undefined) {
      validateRepositoryFile(errors, owner, path, repositoryRoot);
    }
    if (ref.kind === 'behavior-test' && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(ref.path)) {
      errors.push(`${owner} labels non-test path '${ref.path}' as behavior-test evidence`);
    }
    if (ref.proves.startsWith('Exercises the outcome:')) {
      errors.push(`${owner} uses boilerplate evidence text instead of naming the proved behavior`);
    }
    if (
      ref.kind === 'release-proof' &&
      ref.proof_id !== undefined &&
      !inventory.proof_ids.includes(ref.proof_id)
    ) {
      errors.push(`${owner} references unknown release proof '${ref.proof_id}'`);
    }
    if (ref.kind === 'public-claim' && !inventory.public_claim_ids.includes(ref.claim_id)) {
      errors.push(`${owner} references unknown public claim '${ref.claim_id}'`);
    }
  }
}

function validateClaims(
  errors: string[],
  warnings: string[],
  node: CatalogNode,
  inventory: CurrentSurfaceInventory,
  repositoryRoot: string,
): void {
  recordDuplicateErrors(
    errors,
    `claim id on node '${node.id}'`,
    node.claims.map((claim) => claim.id),
  );

  for (const claim of node.claims) {
    validateEvidenceRefs(
      errors,
      `claim '${claim.id}' on node '${node.id}'`,
      claim.refs,
      inventory,
      repositoryRoot,
    );

    const kinds = new Set(claim.refs.map((ref) => ref.kind));
    if (claim.level === 'tested' && !kinds.has('behavior-test')) {
      errors.push(
        `tested claim '${claim.id}' on node '${node.id}' requires behavior-test evidence`,
      );
    }
    if (claim.level === 'release-observed' && !kinds.has('release-proof')) {
      errors.push(
        `release-observed claim '${claim.id}' on node '${node.id}' requires release-proof evidence`,
      );
    }
    if (
      claim.level === 'release-observed' &&
      !claim.refs.some((ref) => ref.kind === 'release-proof' && ref.proof_id !== undefined)
    ) {
      errors.push(
        `release-observed claim '${claim.id}' on node '${node.id}' requires a known proof_id`,
      );
    }
    if (claim.level === 'decision' && !kinds.has('decision')) {
      errors.push(`decision claim '${claim.id}' on node '${node.id}' requires decision evidence`);
    }
    if (claim.level === 'proposal' && !kinds.has('proposal')) {
      errors.push(`proposal claim '${claim.id}' on node '${node.id}' requires proposal evidence`);
    }
    if (node.maturity === 'proposed' && !['decision', 'proposal'].includes(claim.level)) {
      errors.push(`proposed node '${node.id}' cannot use ${claim.level} claim '${claim.id}'`);
    }
  }

  const strength = new Set(node.claims.map((claim) => claim.level));
  if (
    node.maturity !== 'proposed' &&
    !node.claims.some((claim) => ['source', 'tested', 'release-observed'].includes(claim.level))
  ) {
    errors.push(
      `delivered node '${node.id}' requires source, tested, or release-observed evidence`,
    );
  }
  if (node.maturity === 'shipped' && strength.size === 1 && strength.has('source')) {
    warnings.push(`shipped node '${node.id}' has source-only evidence`);
  }
  if (
    'kind' in node &&
    node.kind === 'guarantee' &&
    node.maturity === 'shipped' &&
    !node.claims.some((claim) => ['tested', 'release-observed'].includes(claim.level))
  ) {
    errors.push(`shipped guarantee '${node.id}' requires tested or release-observed evidence`);
  }
}

function derivedReachForSurface(surface: SurfaceRecord, includePublic: boolean): DerivedReach[] {
  const reach = new Set<DerivedReach>();
  for (const item of surface.reach) {
    if (item.channel === 'internal') {
      reach.add('internal');
      continue;
    }
    if (!includePublic || item.channel === 'docs') continue;
    if (item.channel === 'cli') reach.add('cli');
    if (item.channel === 'install') {
      if (item.host === 'claude') reach.add('claude');
      else if (item.host === 'codex') reach.add('codex');
      else reach.add('cli');
    }
    if (item.channel === 'mcp') reach.add('codex');
    if (item.channel === 'host-command' || item.channel === 'host-skill') {
      if (item.host === 'claude') reach.add('claude');
      if (item.host === 'codex') reach.add('codex');
    }
    if (item.channel === 'host-hook') {
      if (item.host === 'claude') reach.add('claude-hook');
      if (item.host === 'codex') reach.add('codex-hook');
    }
  }
  return [...reach];
}

function sortedReach(values: ReadonlySet<DerivedReach>): DerivedReach[] {
  return REACH_ORDER.filter((value) => values.has(value));
}

function hasPublicProductReach(surface: SurfaceRecord): boolean {
  return surface.reach.some((reach) => !['docs', 'internal'].includes(reach.channel));
}

export function auditCatalog(
  catalog: ProductCapabilityCatalog,
  inventoryInput: CurrentSurfaceInventory,
  repositoryRoot: string,
): CatalogAudit {
  const errors: string[] = [];
  const warnings: string[] = [];
  const parsedInventory = CurrentSurfaceInventorySchema.safeParse(inventoryInput);
  if (!parsedInventory.success) {
    return {
      errors: parsedInventory.error.issues.map(
        (issue) =>
          `invalid surface inventory at ${issue.path.join('.') || '(root)'}: ${issue.message}`,
      ),
      warnings,
      coverage: {},
      reach: {},
    };
  }
  const inventory = parsedInventory.data;
  const nodes: CatalogNode[] = [...catalog.capabilities, ...catalog.supporting_elements];

  recordDuplicateErrors(
    errors,
    'vision id',
    catalog.vision.map((item) => item.id),
  );
  recordDuplicateErrors(
    errors,
    'area id',
    catalog.areas.map((item) => item.id),
  );
  recordDuplicateErrors(
    errors,
    'node id',
    nodes.map((item) => item.id),
  );
  recordDuplicateErrors(
    errors,
    'boundary id',
    catalog.boundaries.map((item) => item.id),
  );
  recordDuplicateErrors(
    errors,
    'review question id',
    catalog.review_questions.map((item) => item.id),
  );
  recordDuplicateErrors(
    errors,
    'surface inventory id',
    inventory.surfaces.map((item) => item.id),
  );
  recordDuplicateErrors(
    errors,
    'surface census partition',
    inventory.census_partitions.map((item) => item.kind),
  );
  recordDuplicateErrors(errors, 'release proof id', inventory.proof_ids);
  recordDuplicateErrors(errors, 'public claim id', inventory.public_claim_ids);

  const partitionByKind = new Map(
    inventory.census_partitions.map((partition) => [partition.kind, partition]),
  );
  for (const kind of SurfaceKindSchema.options) {
    const partition = partitionByKind.get(kind);
    const count = inventory.surfaces.filter((surface) => surface.kind === kind).length;
    if (partition === undefined) {
      errors.push(`surface census is missing partition '${kind}'`);
    } else if (partition.state === 'populated' && count === 0) {
      errors.push(`surface census partition '${kind}' is marked populated but has no surfaces`);
    } else if (partition.state === 'empty' && count > 0) {
      errors.push(`surface census partition '${kind}' is marked empty but has ${count} surfaces`);
    }
  }

  const areaIds = new Set(catalog.areas.map((item) => item.id));
  const visionIds = new Set(catalog.vision.map((item) => item.id));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const capabilityIds = new Set(catalog.capabilities.map((item) => item.id));
  const boundaryIds = new Set(catalog.boundaries.map((item) => item.id));
  const questionIds = new Set(catalog.review_questions.map((item) => item.id));
  const boundaryById = new Map(catalog.boundaries.map((item) => [item.id, item]));
  const questionById = new Map(catalog.review_questions.map((item) => [item.id, item]));

  for (const capability of catalog.capabilities) {
    if (!areaIds.has(capability.area)) {
      errors.push(`capability '${capability.id}' uses unknown area '${capability.area}'`);
    }
    recordDuplicateErrors(
      errors,
      `vision link on capability '${capability.id}'`,
      capability.vision.map((item) => item.id),
    );
    for (const link of capability.vision) {
      if (!visionIds.has(link.id)) {
        errors.push(`capability '${capability.id}' uses unknown vision '${link.id}'`);
      }
    }
  }

  for (const element of catalog.supporting_elements) {
    recordDuplicateErrors(
      errors,
      `supported capability on '${element.id}'`,
      element.supports_capabilities,
    );
    for (const id of element.supports_capabilities) {
      if (!capabilityIds.has(id)) {
        errors.push(`supporting element '${element.id}' uses unknown capability '${id}'`);
      }
    }
  }

  for (const node of nodes) {
    validateClaims(errors, warnings, node, inventory, repositoryRoot);
    recordDuplicateErrors(
      errors,
      `attention id on node '${node.id}'`,
      node.attention.map((item) => item.id),
    );
    for (const attention of node.attention) {
      for (const related of attention.related_nodes) {
        if (!nodeById.has(related)) {
          errors.push(`attention '${attention.id}' on '${node.id}' uses unknown node '${related}'`);
        }
      }
      if (
        attention.disposition.kind === 'review-question' &&
        !questionIds.has(attention.disposition.id)
      ) {
        errors.push(
          `attention '${attention.id}' on '${node.id}' uses unknown review question '${attention.disposition.id}'`,
        );
      }
      if (
        attention.disposition.kind === 'review-question' &&
        questionById.has(attention.disposition.id) &&
        !questionById.get(attention.disposition.id)?.nodes.includes(node.id)
      ) {
        errors.push(
          `attention '${attention.id}' on '${node.id}' is outside review question '${attention.disposition.id}' scope`,
        );
      }
      if (attention.disposition.kind === 'boundary' && !boundaryIds.has(attention.disposition.id)) {
        errors.push(
          `attention '${attention.id}' on '${node.id}' uses unknown boundary '${attention.disposition.id}'`,
        );
      }
      if (attention.disposition.kind === 'boundary') {
        const boundary = boundaryById.get(attention.disposition.id);
        if (boundary?.scope.kind === 'nodes' && !boundary.scope.ids.includes(node.id)) {
          errors.push(
            `attention '${attention.id}' on '${node.id}' is outside boundary '${attention.disposition.id}' scope`,
          );
        }
      }
      if (
        ['gap', 'overlap', 'young'].includes(attention.kind) &&
        !['review-question', 'accepted'].includes(attention.disposition.kind)
      ) {
        errors.push(
          `${attention.kind} attention '${attention.id}' on '${node.id}' requires a review question or accepted disposition`,
        );
      }
      if (
        attention.kind === 'boundary' &&
        !['boundary', 'accepted'].includes(attention.disposition.kind)
      ) {
        errors.push(
          `boundary attention '${attention.id}' on '${node.id}' requires a boundary or accepted disposition`,
        );
      }
      if (attention.kind === 'overlap') {
        if (attention.related_nodes.length === 0) {
          errors.push(`overlap attention '${attention.id}' on '${node.id}' requires related_nodes`);
        }
        for (const related of attention.related_nodes) {
          const hasRelationship = catalog.relationships.some(
            (relationship) =>
              relationship.type === 'overlaps-with' &&
              ((relationship.from === node.id && relationship.to === related) ||
                (relationship.from === related && relationship.to === node.id)),
          );
          if (!hasRelationship) {
            errors.push(
              `overlap attention '${attention.id}' on '${node.id}' lacks overlaps-with relationship to '${related}'`,
            );
          }
        }
      }
    }
  }

  const inventoryById = new Map(inventory.surfaces.map((surface) => [surface.id, surface]));
  for (const surface of inventory.surfaces) {
    for (const path of surface.source_paths) {
      validateRepositoryFile(errors, `surface '${surface.id}'`, path, repositoryRoot);
    }
  }

  const dispositions = new Map<string, SurfaceMapItem[]>();
  const bindingKeys: string[] = [];
  for (const item of catalog.surface_map) {
    const values = dispositions.get(item.surface) ?? [];
    values.push(item);
    dispositions.set(item.surface, values);

    if (item.role === 'excluded') {
      bindingKeys.push(`${item.surface}:excluded`);
      continue;
    }
    bindingKeys.push(`${item.surface}:${item.node}:${item.role}`);
    if (!nodeById.has(item.node)) {
      errors.push(`surface '${item.surface}' maps to unknown node '${item.node}'`);
    }
  }
  recordDuplicateErrors(errors, 'surface binding', bindingKeys);

  for (const [surfaceId, items] of dispositions) {
    if (!inventoryById.has(surfaceId)) {
      errors.push(`catalog maps unknown surface '${surfaceId}'`);
    }
    if (items.some((item) => item.role === 'excluded') && items.length > 1) {
      errors.push(`surface '${surfaceId}' cannot be both excluded and bound`);
    }
  }

  for (const surface of inventory.surfaces) {
    const items = dispositions.get(surface.id) ?? [];
    if (items.length === 0) {
      errors.push(`surface '${surface.id}' is not dispositioned`);
      continue;
    }
    if (
      surface.state === 'active' &&
      PUBLIC_PRODUCT_SURFACE_KINDS.has(surface.kind) &&
      hasPublicProductReach(surface) &&
      !items.some((item) => item.role !== 'excluded' && EXPOSURE_ROLES.has(item.role))
    ) {
      errors.push(
        `active public surface '${surface.id}' requires an entry-point, delivery, or control binding`,
      );
    }
    for (const item of items) {
      if (item.role === 'excluded') {
        if (
          surface.state === 'active' &&
          PUBLIC_PRODUCT_SURFACE_KINDS.has(surface.kind) &&
          hasPublicProductReach(surface)
        ) {
          errors.push(
            `active public surface '${surface.id}' cannot be excluded from the product map`,
          );
        }
        continue;
      }
      if (surface.state === 'dormant' && item.role !== 'dormant-vocabulary') {
        errors.push(`dormant surface '${surface.id}' must use dormant-vocabulary or be excluded`);
      }
      if (surface.state === 'active' && item.role === 'dormant-vocabulary') {
        errors.push(`active surface '${surface.id}' cannot use dormant-vocabulary`);
      }
      const node = nodeById.get(item.node);
      if (NON_DELIVERY_SURFACE_KINDS.has(surface.kind) && EXPOSURE_ROLES.has(item.role)) {
        errors.push(`${surface.kind} surface '${surface.id}' cannot be mapped as ${item.role}`);
      }
      if (
        item.role === 'control' &&
        (node === undefined || !('kind' in node) || node.kind !== 'control')
      ) {
        errors.push(`control surface '${surface.id}' must map to a supporting control`);
      }
      if (
        node?.maturity === 'proposed' &&
        surface.state === 'active' &&
        EXPOSURE_ROLES.has(item.role)
      ) {
        errors.push(
          `proposed node '${node.id}' cannot use active ${item.role} surface '${surface.id}'`,
        );
      }
      if (surface.origin === 'declared' && EXPOSURE_ROLES.has(item.role)) {
        warnings.push(
          `node '${item.node}' derives exposure from declared surface '${surface.id}' rather than a canonical registry`,
        );
      }
    }
  }

  const reachSets = new Map(nodes.map((node) => [node.id, new Set<DerivedReach>()]));
  for (const item of catalog.surface_map) {
    if (item.role === 'excluded') continue;
    const surface = inventoryById.get(item.surface);
    if (surface === undefined || surface.state !== 'active') continue;
    const includePublic = EXPOSURE_ROLES.has(item.role);
    const nodeReach = reachSets.get(item.node);
    if (nodeReach === undefined) continue;
    for (const reach of derivedReachForSurface(surface, includePublic)) nodeReach.add(reach);
  }

  for (const capability of catalog.capabilities) {
    if (capability.maturity === 'proposed') continue;
    const activeDelivery = catalog.surface_map.some((item) => {
      if (
        item.role === 'excluded' ||
        item.node !== capability.id ||
        !DELIVERY_ROLES.has(item.role)
      ) {
        return false;
      }
      return inventoryById.get(item.surface)?.state === 'active';
    });
    if (!activeDelivery) {
      errors.push(
        `delivered capability '${capability.id}' has no active entry-point or delivery surface`,
      );
    }
  }

  const relationshipKeys: string[] = [];
  for (const relationship of catalog.relationships) {
    relationshipKeys.push(`${relationship.from}:${relationship.type}:${relationship.to}`);
    if (!nodeById.has(relationship.from)) {
      errors.push(`relationship uses unknown source node '${relationship.from}'`);
    }
    if (!nodeById.has(relationship.to)) {
      errors.push(`relationship uses unknown target node '${relationship.to}'`);
    }
    if (relationship.from === relationship.to) {
      errors.push(`node '${relationship.from}' cannot relate to itself`);
    }
    if (
      relationship.type === 'overlaps-with' &&
      relationship.from.localeCompare(relationship.to) > 0
    ) {
      errors.push(
        `overlaps-with relationship must use lexical order: '${relationship.to}' before '${relationship.from}'`,
      );
    }
  }
  recordDuplicateErrors(errors, 'relationship', relationshipKeys);

  for (const boundary of catalog.boundaries) {
    validateEvidenceRefs(
      errors,
      `boundary '${boundary.id}'`,
      boundary.refs,
      inventory,
      repositoryRoot,
    );
    if (boundary.scope.kind === 'nodes') {
      for (const id of boundary.scope.ids) {
        if (!nodeById.has(id)) errors.push(`boundary '${boundary.id}' uses unknown node '${id}'`);
      }
    }
  }

  for (const question of catalog.review_questions) {
    for (const node of question.nodes) {
      if (!nodeById.has(node)) {
        errors.push(`review question '${question.id}' uses unknown node '${node}'`);
      }
    }
    validateEvidenceRefs(
      errors,
      `review question '${question.id}'`,
      question.refs,
      inventory,
      repositoryRoot,
    );
    if (question.state !== 'open' && !question.refs.some((ref) => ref.kind === 'decision')) {
      errors.push(`non-open review question '${question.id}' requires decision evidence`);
    }
  }

  const kindValues = [...new Set(inventory.surfaces.map((surface) => surface.kind))].sort();
  const coverage: Record<string, SurfaceCoverage> = {};
  for (const kind of kindValues) {
    const surfaces = inventory.surfaces.filter((surface) => surface.kind === kind);
    const unmapped = surfaces
      .filter((surface) => !dispositions.has(surface.id))
      .map((surface) => surface.id);
    const excluded = surfaces.filter((surface) =>
      dispositions.get(surface.id)?.some((item) => item.role === 'excluded'),
    ).length;
    coverage[kind] = {
      current: surfaces.length,
      dispositioned: surfaces.length - unmapped.length,
      excluded,
      unmapped: unmapped.sort(),
      declared: surfaces.filter((surface) => surface.origin === 'declared').length,
    };
  }

  for (const [surfaceId, items] of dispositions) {
    const owners = items.filter((item) => item.role !== 'excluded');
    if (owners.length > 1) {
      warnings.push(
        `surface '${surfaceId}' supports several nodes: ${owners.map((item) => item.node).join(', ')}`,
      );
    }
  }

  const reach = Object.fromEntries(
    [...reachSets.entries()].map(([id, values]) => [id, sortedReach(values)]),
  );

  return { errors, warnings: [...new Set(warnings)], coverage, reach };
}

function markdownCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function strongestClaim(node: CatalogNode): string {
  const order = ['release-observed', 'tested', 'source', 'decision', 'proposal'] as const;
  return order.find((level) => node.claims.some((claim) => claim.level === level)) ?? 'source';
}

function reachLabel(reach: readonly DerivedReach[]): string {
  return reach.length === 0 ? 'none' : reach.join(', ');
}

function attentionLabel(node: CatalogNode): string {
  return node.attention.length === 0
    ? '—'
    : node.attention
        .map((item) => {
          const related =
            item.related_nodes.length === 0 ? '' : ` Related: ${item.related_nodes.join(', ')}.`;
          const disposition =
            item.disposition.kind === 'accepted'
              ? `Accepted: ${item.disposition.reason}`
              : `${item.disposition.kind}: ${item.disposition.id}`;
          return `${item.kind}: ${item.note}${related} ${disposition}`;
        })
        .join(' ');
}

function visionLabel(capability: ProductCapability): string {
  return capability.vision.map((item) => `${item.id} (${item.fit})`).join(', ');
}

function boundaryScopeLabel(boundary: ProductCapabilityCatalog['boundaries'][number]): string {
  return boundary.scope.kind === 'catalog'
    ? 'all catalog nodes'
    : boundary.scope.ids.map((id) => `\`${id}\``).join(', ');
}

export function renderMarkdown(catalog: ProductCapabilityCatalog, audit: CatalogAudit): string {
  const lines: string[] = [
    '# Circuit feature and capability map — disposable v0.2',
    '',
    '<!-- Generated by experiments/product-capability-model/render.ts. Edit catalog.json, not this file. -->',
    '',
    `> ${catalog.purpose}`,
    '',
    `Baseline: **${catalog.baseline.target}** — ${catalog.baseline.note}`,
    '',
    'This is a product-modeling probe, not product authority. Capability, control, guarantee, mechanism, and surface are analytical categories here; they do not replace Circuit’s product vocabulary.',
    '',
    '## Summary',
    '',
    `- ${catalog.capabilities.length} user capabilities`,
    `- ${catalog.supporting_elements.filter((item) => item.kind === 'control').length} controls`,
    `- ${catalog.supporting_elements.filter((item) => item.kind === 'guarantee').length} guarantees`,
    `- ${catalog.supporting_elements.filter((item) => item.kind === 'mechanism').length} mechanisms`,
    `- ${Object.values(audit.coverage).reduce((total, item) => total + item.current, 0)} inventoried surfaces`,
    '',
    '## Vision anchors',
    '',
    ...catalog.vision.flatMap((item) => [
      `- **${item.title} · ${item.role}.** ${item.statement}`,
      '',
    ]),
    '## Surface coverage',
    '',
    '| Surface kind | Dispositioned | Excluded | Declared rather than derived | Unmapped |',
    '| --- | ---: | ---: | ---: | --- |',
    ...Object.entries(audit.coverage).map(([kind, item]) => {
      const unmapped = item.unmapped.length === 0 ? 'none' : item.unmapped.join(', ');
      return `| ${kind} | ${item.dispositioned}/${item.current} | ${item.excluded} | ${item.declared} | ${markdownCell(unmapped)} |`;
    }),
    '',
    'Only entry points, delivery surfaces, and controls create public reach. Proofs, examples, generated mirrors, and dormant vocabulary do not.',
    '',
    '## User capabilities',
    '',
  ];

  for (const area of catalog.areas) {
    const capabilities = catalog.capabilities.filter((item) => item.area === area.id);
    if (capabilities.length === 0) continue;
    lines.push(`### ${area.title}`, '', area.summary, '');
    lines.push(
      '| Capability | Maturity | Reach | Vision fit | Strongest evidence | Review signal |',
      '| --- | --- | --- | --- | --- | --- |',
    );
    for (const capability of capabilities) {
      lines.push(
        `| **${markdownCell(capability.title)}**<br>${markdownCell(capability.outcome)} | ${capability.maturity} | ${reachLabel(audit.reach[capability.id] ?? [])} | ${markdownCell(visionLabel(capability))} | ${strongestClaim(capability)} | ${markdownCell(attentionLabel(capability))} |`,
      );
    }
    lines.push('');
  }

  lines.push('## Supporting controls, guarantees, and mechanisms', '');
  for (const kind of ['control', 'guarantee', 'mechanism'] as const) {
    const elements = catalog.supporting_elements.filter((item) => item.kind === kind);
    if (elements.length === 0) continue;
    lines.push(`### ${kind.slice(0, 1).toUpperCase()}${kind.slice(1)}s`, '');
    lines.push(
      '| Element | Maturity | Reach | Supports | Strongest evidence | Review signal |',
      '| --- | --- | --- | --- | --- | --- |',
    );
    for (const element of elements) {
      lines.push(
        `| **${markdownCell(element.title)}**<br>${markdownCell(element.summary)} | ${element.maturity} | ${reachLabel(audit.reach[element.id] ?? [])} | ${element.supports_capabilities.map((id) => `\`${id}\``).join(', ')} | ${strongestClaim(element)} | ${markdownCell(attentionLabel(element))} |`,
      );
    }
    lines.push('');
  }

  lines.push(
    '## Important relationships',
    '',
    '| From | Relationship | To | Why |',
    '| --- | --- | --- | --- |',
    ...catalog.relationships.map(
      (item) =>
        `| \`${item.from}\` | ${item.type} | \`${item.to}\` | ${markdownCell(item.reason)} |`,
    ),
    '',
    '## Deliberate boundaries',
    '',
    ...catalog.boundaries.flatMap((item) => [
      `- **${item.title}.** ${item.rule} Scope: ${boundaryScopeLabel(item)}.`,
      '',
    ]),
    '## Questions for review',
    '',
    ...catalog.review_questions.map(
      (item) =>
        `- **${item.id} · ${item.state}.** ${item.question} (${item.nodes.map((id) => `\`${id}\``).join(', ')})`,
    ),
    '',
    '## Audit result',
    '',
    audit.errors.length === 0
      ? 'The disposable audit passes: every inventoried surface is bound or explicitly excluded, every active capability has a delivery path, and typed evidence references resolve.'
      : `The disposable audit fails with ${audit.errors.length} error(s).`,
    '',
  );

  if (audit.warnings.length > 0) {
    lines.push('Warnings:', '', ...audit.warnings.map((warning) => `- ${warning}`), '');
  }

  return `${lines.join('\n')}\n`;
}
