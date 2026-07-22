import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { z } from 'zod';

import { McpPublicFlowV1, type McpPublicFlowV1 as PublicFlow } from './contracts.js';

const MAX_CATALOG_BYTES = 1024 * 1024;
const REQUIRED_PUBLIC_FLOWS = new Set<PublicFlow>(McpPublicFlowV1.options);

const PublicCatalogV1 = z
  .object({
    flows: z
      .array(
        z
          .object({
            id: McpPublicFlowV1,
            title: z.string().trim().min(1).max(200),
            purpose: z.string().trim().min(1).max(8_000),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();

export class PublicFlowCatalogError extends Error {
  readonly code = 'flow_catalog_invalid' as const;
  readonly nextAction = 'Reinstall the Circuit plugin, then retry.';

  constructor(message: string) {
    super(message);
    this.name = 'PublicFlowCatalogError';
  }
}

export function loadPublicFlowCatalog(path: string): ReadonlySet<PublicFlow> {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd);
    if (!before.isFile() || before.size === 0 || before.size > MAX_CATALOG_BYTES) {
      throw new Error('catalog is not a bounded regular file');
    }
    const decoded = PublicCatalogV1.parse(JSON.parse(readFileSync(fd, 'utf8')) as unknown);
    const after = fstatSync(fd);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error('catalog changed while Circuit read it');
    }
    const roster = new Set(decoded.flows.map((flow) => flow.id));
    if (
      roster.size !== decoded.flows.length ||
      roster.size !== REQUIRED_PUBLIC_FLOWS.size ||
      [...REQUIRED_PUBLIC_FLOWS].some((flow) => !roster.has(flow))
    ) {
      throw new Error('catalog does not contain the exact public MCP flow roster');
    }
    return roster;
  } catch (error) {
    if (error instanceof PublicFlowCatalogError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new PublicFlowCatalogError(`Circuit could not trust its public flow catalog: ${message}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
