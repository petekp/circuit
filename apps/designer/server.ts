import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from '@fastify/cors';
import Fastify from 'fastify';
import { FlowBlockCatalog } from '../../src/schemas/flow-blocks.js';
import {
  FlowSchematic,
  validateFlowSchematicCatalogCompatibility,
} from '../../src/schemas/flow-schematic.js';
import { flowSchematicPath } from './flow-id.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const FLOWS_DIR = join(REPO_ROOT, 'src', 'flows');
const BLOCK_CATALOG_PATH = join(REPO_ROOT, 'docs', 'flows', 'block-catalog.json');

const app = Fastify({ logger: { level: 'info' } });
await app.register(cors, { origin: true });

async function loadCatalog(): Promise<unknown> {
  const raw = await readFile(BLOCK_CATALOG_PATH, 'utf8');
  return JSON.parse(raw);
}

app.get('/api/health', async () => ({ ok: true }));

app.get('/api/flows', async () => {
  const entries = await readdir(FLOWS_DIR, { withFileTypes: true });
  return {
    flows: entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
  };
});

app.get('/api/flows/:id/schematic', async (req, reply) => {
  const { id } = req.params as { id: string };
  const resolved = flowSchematicPath(FLOWS_DIR, id);
  if (!resolved.ok) {
    reply.code(400);
    return { error: resolved.reason };
  }
  try {
    const raw = await readFile(resolved.path, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    reply.code(404);
    return { error: `schematic not found: ${id}`, detail: String(err) };
  }
});

app.put('/api/flows/:id/schematic', async (req, reply) => {
  const { id } = req.params as { id: string };
  const resolved = flowSchematicPath(FLOWS_DIR, id);
  if (!resolved.ok) {
    reply.code(400);
    return { ok: false, errors: [{ message: resolved.reason }] };
  }
  const parsed = FlowSchematic.safeParse(req.body);
  if (!parsed.success) {
    reply.code(400);
    return { ok: false, errors: parsed.error.issues };
  }
  await writeFile(resolved.path, `${JSON.stringify(parsed.data, null, 2)}\n`, 'utf8');
  return { ok: true };
});

app.get('/api/blocks', async (_req, reply) => {
  try {
    const data = await loadCatalog();
    const parsed = FlowBlockCatalog.safeParse(data);
    if (!parsed.success) {
      reply.code(500);
      return { error: 'block catalog failed schema parse', issues: parsed.error.issues };
    }
    return parsed.data;
  } catch (err) {
    reply.code(500);
    return { error: 'failed to read block catalog', detail: String(err) };
  }
});

app.post('/api/validate', async (req) => {
  const schematicResult = FlowSchematic.safeParse(req.body);
  if (!schematicResult.success) {
    return { ok: false, schemaErrors: schematicResult.error.issues, compatibilityIssues: [] };
  }
  const catalogRaw = await loadCatalog();
  const catalogResult = FlowBlockCatalog.safeParse(catalogRaw);
  if (!catalogResult.success) {
    return {
      ok: false,
      schemaErrors: [],
      compatibilityIssues: [{ message: 'block catalog failed to parse on the server' }],
    };
  }
  const compatibilityIssues = validateFlowSchematicCatalogCompatibility(
    schematicResult.data,
    catalogResult.data,
  );
  return {
    ok: compatibilityIssues.length === 0,
    schemaErrors: [],
    compatibilityIssues,
  };
});

const port = Number(process.env.PORT ?? 5174);
await app.listen({ port, host: '127.0.0.1' });
