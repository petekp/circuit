import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const Slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

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

const CapabilitySchema = z
  .object({
    id: Slug,
    area: Slug,
    title: z.string().min(1),
    summary: z.string().min(1),
    delivery: z.enum(['shipped', 'partial', 'proposed']),
    exposure: z.enum(['public-host', 'public-cli', 'mixed', 'internal', 'none']),
    vision: z
      .array(
        z
          .object({
            id: Slug,
            fit: z.enum(['direct', 'enabling']),
          })
          .strict(),
      )
      .min(1),
    proof: z
      .object({
        strength: z.enum(['release-proof', 'tested', 'source', 'proposal', 'decision']),
        refs: z.array(z.string().min(1)).min(1),
      })
      .strict(),
    surfaces: z
      .object({
        commands: z.array(Slug),
        flows: z.array(Slug),
        blocks: z.array(Slug),
      })
      .strict(),
    attention: z
      .object({
        kind: z.enum(['gap', 'overlap', 'young', 'boundary']),
        note: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

const RelationshipSchema = z
  .object({
    from: Slug,
    to: Slug,
    type: z.enum(['depends-on', 'enables', 'extends', 'overlaps', 'reveals']),
    reason: z.string().min(1),
  })
  .strict();

const BoundarySchema = z
  .object({
    id: Slug,
    title: z.string().min(1),
    reason: z.string().min(1),
    refs: z.array(z.string().min(1)).min(1),
  })
  .strict();

const ReviewQuestionSchema = z
  .object({
    question: z.string().min(1),
    capabilities: z.array(Slug).min(1),
  })
  .strict();

export const ProductCapabilityCatalogSchema = z
  .object({
    schema_version: z.literal('0.1-spike'),
    status: z.literal('disposable'),
    name: z.string().min(1),
    purpose: z.string().min(1),
    vision: z.array(VisionSchema).min(1),
    areas: z.array(AreaSchema).min(1),
    capabilities: z.array(CapabilitySchema).min(1),
    relationships: z.array(RelationshipSchema),
    boundaries: z.array(BoundarySchema),
    review_questions: z.array(ReviewQuestionSchema),
  })
  .strict();

export type ProductCapabilityCatalog = z.infer<typeof ProductCapabilityCatalogSchema>;
export type ProductCapability = ProductCapabilityCatalog['capabilities'][number];
export type SurfaceKind = keyof ProductCapability['surfaces'];

export interface CurrentSurfaceInventory {
  readonly commands: readonly string[];
  readonly flows: readonly string[];
  readonly blocks: readonly string[];
}

export interface SurfaceCoverage {
  readonly current: number;
  readonly mapped: number;
  readonly unmapped: readonly string[];
  readonly unknown: readonly string[];
}

export interface CatalogAudit {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly coverage: Readonly<Record<SurfaceKind, SurfaceCoverage>>;
  readonly overlaps: Readonly<Record<SurfaceKind, Readonly<Record<string, readonly string[]>>>>;
}

export const DEFAULT_CATALOG_PATH = fileURLToPath(new URL('./catalog.json', import.meta.url));
export const GENERATED_MARKDOWN_PATH = fileURLToPath(
  new URL('./capability-map.generated.md', import.meta.url),
);

const SURFACE_KINDS = ['commands', 'flows', 'blocks'] as const satisfies readonly SurfaceKind[];

export function loadCatalog(path = DEFAULT_CATALOG_PATH): ProductCapabilityCatalog {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return ProductCapabilityCatalogSchema.parse(raw);
}

function findDuplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  return [...duplicates].sort();
}

function recordDuplicateErrors(errors: string[], label: string, values: readonly string[]): void {
  for (const duplicate of findDuplicates(values)) {
    errors.push(`duplicate ${label} id '${duplicate}'`);
  }
}

function recordMissingPathErrors(
  errors: string[],
  root: string,
  owner: string,
  refs: readonly string[],
): void {
  for (const ref of refs) {
    if (!existsSync(resolve(root, ref))) {
      errors.push(`${owner} points to missing evidence '${ref}'`);
    }
  }
}

export function auditCatalog(
  catalog: ProductCapabilityCatalog,
  inventory: CurrentSurfaceInventory,
  repositoryRoot: string,
): CatalogAudit {
  const errors: string[] = [];
  const warnings: string[] = [];

  recordDuplicateErrors(
    errors,
    'vision',
    catalog.vision.map((item) => item.id),
  );
  recordDuplicateErrors(
    errors,
    'area',
    catalog.areas.map((item) => item.id),
  );
  recordDuplicateErrors(
    errors,
    'capability',
    catalog.capabilities.map((item) => item.id),
  );
  recordDuplicateErrors(
    errors,
    'boundary',
    catalog.boundaries.map((item) => item.id),
  );

  const areaIds = new Set(catalog.areas.map((item) => item.id));
  const visionIds = new Set(catalog.vision.map((item) => item.id));
  const capabilityIds = new Set(catalog.capabilities.map((item) => item.id));

  const mappedByKind = Object.fromEntries(
    SURFACE_KINDS.map((kind) => [kind, new Map<string, string[]>()]),
  ) as Record<SurfaceKind, Map<string, string[]>>;

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

    if (capability.delivery === 'proposed') {
      if (capability.exposure !== 'none') {
        errors.push(`proposed capability '${capability.id}' must have exposure 'none'`);
      }
      if (capability.proof.strength !== 'proposal') {
        errors.push(`proposed capability '${capability.id}' must use proposal proof`);
      }
    } else if (capability.exposure === 'none') {
      errors.push(`delivered capability '${capability.id}' cannot have exposure 'none'`);
    }

    recordMissingPathErrors(
      errors,
      repositoryRoot,
      `capability '${capability.id}'`,
      capability.proof.refs,
    );

    const surfaceCount = SURFACE_KINDS.reduce(
      (count, kind) => count + capability.surfaces[kind].length,
      0,
    );
    if (surfaceCount === 0 && capability.delivery !== 'proposed') {
      warnings.push(`delivered capability '${capability.id}' has no mapped product surface`);
    }

    for (const kind of SURFACE_KINDS) {
      recordDuplicateErrors(
        errors,
        `${kind} mapping on capability '${capability.id}'`,
        capability.surfaces[kind],
      );
      for (const surfaceId of capability.surfaces[kind]) {
        const owners = mappedByKind[kind].get(surfaceId) ?? [];
        owners.push(capability.id);
        mappedByKind[kind].set(surfaceId, owners);
      }
    }
  }

  const relationshipKeys: string[] = [];
  for (const relationship of catalog.relationships) {
    relationshipKeys.push(`${relationship.from}:${relationship.type}:${relationship.to}`);
    if (!capabilityIds.has(relationship.from)) {
      errors.push(`relationship uses unknown source capability '${relationship.from}'`);
    }
    if (!capabilityIds.has(relationship.to)) {
      errors.push(`relationship uses unknown target capability '${relationship.to}'`);
    }
    if (relationship.from === relationship.to) {
      errors.push(`capability '${relationship.from}' cannot relate to itself`);
    }
  }
  recordDuplicateErrors(errors, 'relationship', relationshipKeys);

  for (const [index, reviewQuestion] of catalog.review_questions.entries()) {
    recordDuplicateErrors(
      errors,
      `capability on review question ${index + 1}`,
      reviewQuestion.capabilities,
    );
    for (const capabilityId of reviewQuestion.capabilities) {
      if (!capabilityIds.has(capabilityId)) {
        errors.push(`review question ${index + 1} uses unknown capability '${capabilityId}'`);
      }
    }
  }

  for (const boundary of catalog.boundaries) {
    recordMissingPathErrors(errors, repositoryRoot, `boundary '${boundary.id}'`, boundary.refs);
  }

  const buildCoverage = (kind: SurfaceKind): SurfaceCoverage => {
    const current = new Set(inventory[kind]);
    const mapped = mappedByKind[kind];
    const unmapped = [...current].filter((id) => !mapped.has(id)).sort();
    const unknown = [...mapped.keys()].filter((id) => !current.has(id)).sort();

    for (const id of unmapped) {
      errors.push(`current ${kind.slice(0, -1)} '${id}' is not registered to a capability`);
    }
    for (const id of unknown) {
      errors.push(`catalog maps unknown ${kind.slice(0, -1)} '${id}'`);
    }

    return {
      current: current.size,
      mapped: current.size - unmapped.length,
      unmapped,
      unknown,
    };
  };

  const coverage: Record<SurfaceKind, SurfaceCoverage> = {
    commands: buildCoverage('commands'),
    flows: buildCoverage('flows'),
    blocks: buildCoverage('blocks'),
  };

  const buildOverlaps = (kind: SurfaceKind): Readonly<Record<string, readonly string[]>> =>
    Object.fromEntries(
      [...mappedByKind[kind].entries()]
        .filter(([, owners]) => owners.length > 1)
        .sort(([left], [right]) => left.localeCompare(right)),
    );

  const overlaps: Record<SurfaceKind, Readonly<Record<string, readonly string[]>>> = {
    commands: buildOverlaps('commands'),
    flows: buildOverlaps('flows'),
    blocks: buildOverlaps('blocks'),
  };

  return { errors, warnings, coverage, overlaps };
}

function markdownCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function formatSurfaces(capability: ProductCapability): string {
  const entries = SURFACE_KINDS.flatMap((kind) =>
    capability.surfaces[kind].map((id) => `${kind.slice(0, -1)}:${id}`),
  );
  return entries.length === 0 ? '—' : entries.map((entry) => `\`${entry}\``).join(', ');
}

function countBy<T extends string>(values: readonly T[]): Map<T, number> {
  const counts = new Map<T, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

export function renderMarkdown(catalog: ProductCapabilityCatalog, audit: CatalogAudit): string {
  const lines: string[] = [
    '# Circuit product capability map — disposable spike',
    '',
    '<!-- Generated by experiments/product-capability-model/render.ts. Edit catalog.json, not this file. -->',
    '',
    `> ${catalog.purpose}`,
    '',
    'This is a design probe, not a product authority. Its job is to expose bad categories, missing links, and review questions before a permanent catalog is designed.',
    '',
    '## Vision anchors',
    '',
    '| Anchor | Role | Product test |',
    '| --- | --- | --- |',
    ...catalog.vision.map(
      (item) => `| ${markdownCell(item.title)} | ${item.role} | ${markdownCell(item.statement)} |`,
    ),
    '',
    '## Coverage',
    '',
    '| Registered surface | Covered | Unmapped |',
    '| --- | ---: | --- |',
    ...SURFACE_KINDS.map((kind) => {
      const item = audit.coverage[kind];
      const unmapped = item.unmapped.length === 0 ? 'none' : item.unmapped.join(', ');
      return `| ${kind} | ${item.mapped}/${item.current} | ${unmapped} |`;
    }),
    '',
  ];

  const deliveryCounts = countBy(catalog.capabilities.map((item) => item.delivery));
  lines.push(
    `Capability states: ${deliveryCounts.get('shipped') ?? 0} shipped, ${deliveryCounts.get('partial') ?? 0} partial, ${deliveryCounts.get('proposed') ?? 0} proposed.`,
    '',
    '## Capability map',
    '',
  );

  for (const area of catalog.areas) {
    lines.push(`### ${area.title}`, '', area.summary, '');
    lines.push(
      '| Capability | Delivery | Exposure | Vision fit | Registered surfaces | Review signal |',
      '| --- | --- | --- | --- | --- | --- |',
    );
    for (const capability of catalog.capabilities.filter((item) => item.area === area.id)) {
      const vision = capability.vision.map((item) => `${item.id} (${item.fit})`).join(', ');
      const attention = capability.attention
        ? `${capability.attention.kind}: ${capability.attention.note}`
        : '—';
      lines.push(
        `| **${markdownCell(capability.title)}**<br>${markdownCell(capability.summary)} | ${capability.delivery} | ${capability.exposure} | ${markdownCell(vision)} | ${formatSurfaces(capability)} | ${markdownCell(attention)} |`,
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
    ...catalog.boundaries.flatMap((item) => [`- **${item.title}.** ${item.reason}`, '']),
    '## Questions for review',
    '',
    ...catalog.review_questions.map(
      (item, index) =>
        `${index + 1}. ${item.question} (${item.capabilities.map((id) => `\`${id}\``).join(', ')})`,
    ),
    '',
    '## Audit result',
    '',
    audit.errors.length === 0
      ? 'The disposable audit passes: every current command, flow, and block is registered, all references resolve, and all evidence paths exist.'
      : `The disposable audit fails with ${audit.errors.length} error(s).`,
    '',
  );

  if (audit.warnings.length > 0) {
    lines.push('Warnings:', '', ...audit.warnings.map((warning) => `- ${warning}`), '');
  }

  return `${lines.join('\n')}\n`;
}
