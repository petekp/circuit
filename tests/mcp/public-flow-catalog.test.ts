import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { McpPublicFlowV1 } from '../../src/hosts/codex-mcp/contracts.js';
import {
  PublicFlowCatalogError,
  loadPublicFlowCatalog,
} from '../../src/hosts/codex-mcp/public-flow-catalog.js';

const PUBLIC_FLOWS = McpPublicFlowV1.options;

function catalog(flows: readonly string[] = PUBLIC_FLOWS) {
  return {
    flows: flows.map((id) => ({ id, title: `${id} title`, purpose: `${id} purpose` })),
  };
}

describe('Codex MCP public flow catalog', () => {
  it('derives the complete public roster from the packaged catalog', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'circuit-mcp-catalog-'));
    const path = resolve(root, 'catalog.json');
    writeFileSync(path, JSON.stringify(catalog()));

    expect([...loadPublicFlowCatalog(path)]).toEqual(PUBLIC_FLOWS);
  });

  it('fails closed on missing, extra, duplicate, or linked catalog entries', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'circuit-mcp-catalog-'));
    const path = resolve(root, 'catalog.json');
    writeFileSync(path, JSON.stringify(catalog(PUBLIC_FLOWS.slice(0, 4))));
    expect(() => loadPublicFlowCatalog(path)).toThrow(PublicFlowCatalogError);

    writeFileSync(path, JSON.stringify(catalog([...PUBLIC_FLOWS, 'private-flow'])));
    expect(() => loadPublicFlowCatalog(path)).toThrow(PublicFlowCatalogError);

    const link = resolve(root, 'linked.json');
    symlinkSync(path, link);
    expect(() => loadPublicFlowCatalog(link)).toThrow(PublicFlowCatalogError);
  });
});
