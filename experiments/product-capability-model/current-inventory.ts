import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { CLI_COMMAND_NAMES } from '../../src/cli/command-vocabulary.ts';
import type { CurrentSurfaceInventory } from './model.ts';

const EmittedBlockCatalogSchema = z
  .object({
    blocks: z.array(
      z
        .object({
          id: z.string().min(1),
        })
        .passthrough(),
    ),
  })
  .passthrough();

function emittedFlowIds(repositoryRoot: string): string[] {
  const generatedFlowsRoot = join(repositoryRoot, 'generated', 'flows');
  return readdirSync(generatedFlowsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => {
      const files = readdirSync(join(generatedFlowsRoot, entry.name));
      return files.includes('circuit.json');
    })
    .map((entry) => entry.name)
    .sort();
}

function emittedBlockIds(repositoryRoot: string): string[] {
  const blockCatalogPath = join(repositoryRoot, 'docs', 'flows', 'block-catalog.json');
  const raw: unknown = JSON.parse(readFileSync(blockCatalogPath, 'utf8'));
  const catalog = EmittedBlockCatalogSchema.parse(raw);
  return catalog.blocks.map((block) => block.id).sort();
}

export function loadCurrentSurfaceInventory(repositoryRoot: string): CurrentSurfaceInventory {
  return {
    commands: [...CLI_COMMAND_NAMES],
    flows: emittedFlowIds(repositoryRoot),
    blocks: emittedBlockIds(repositoryRoot),
  };
}
