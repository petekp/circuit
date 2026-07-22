#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { packageTreeSha256 } from '../plugins/package-tree.ts';
import { validateCodexMcpCandidateMatrix } from './codex-mcp-candidate-matrix.ts';
import { loadReleaseSchemas, loadYamlWithSchema, projectRoot } from './shared.ts';

const PROOF_ID = 'proof:codex-mcp-first-run';
const PROOF_ROOT = 'docs/release/proofs/runs/codex-mcp-first-run';
const FIRST_RUN_PATH = `${PROOF_ROOT}/evidence.json`;
const MATRIX_PATH = `${PROOF_ROOT}/candidate-matrix.json`;

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function main(): Promise<void> {
  const [traceModule, reviewModule, fixModule, buildModule, exploreModule, prototypeModule] =
    (await Promise.all([
      import(new URL('../../dist/schemas/trace-entry.js', import.meta.url).href),
      import(new URL('../../dist/flows/review/reports.js', import.meta.url).href),
      import(new URL('../../dist/flows/fix/reports.js', import.meta.url).href),
      import(new URL('../../dist/flows/build/reports.js', import.meta.url).href),
      import(new URL('../../dist/flows/explore/reports.js', import.meta.url).href),
      import(new URL('../../dist/flows/prototype/reports.js', import.meta.url).href),
    ])) as Array<Record<string, unknown>>;
  const trace = traceModule as {
    readonly TraceEntry?: { readonly safeParse: (value: unknown) => { readonly success: boolean } };
  };
  if (trace.TraceEntry === undefined) {
    throw new Error('built TraceEntry schema is unavailable; run npm run build first');
  }
  type RuntimeSchema = {
    readonly safeParse: (value: unknown) => { readonly success: boolean };
  };
  const flowResultSchemas = new Map<string, RuntimeSchema | undefined>([
    ['review.result@v1', reviewModule?.ReviewResult as RuntimeSchema | undefined],
    ['fix.result@v1', fixModule?.FixResult as RuntimeSchema | undefined],
    ['build.result@v1', buildModule?.BuildResult as RuntimeSchema | undefined],
    ['explore.result@v1', exploreModule?.ExploreResult as RuntimeSchema | undefined],
    ['prototype.result@v1', prototypeModule?.PrototypeResult as RuntimeSchema | undefined],
  ]);
  if ([...flowResultSchemas.values()].some((schema) => schema === undefined)) {
    throw new Error('built flow result schemas are unavailable; run npm run build first');
  }
  const schemas = await loadReleaseSchemas();
  const proofs = loadYamlWithSchema('docs/release/proofs/index.yaml', schemas.ProofScenarioIndex);
  const proof = proofs.scenarios.find((scenario) => scenario.id === PROOF_ID);
  if (proof === undefined) throw new Error(`${PROOF_ID} is missing from the proof index`);
  if (proof.status !== 'verified_current') {
    console.warn(`tracked: ${PROOF_ID} is ${proof.status}`);
    return;
  }
  for (const path of [FIRST_RUN_PATH, MATRIX_PATH]) {
    if (!proof.required_files.includes(path)) throw new Error(`${PROOF_ID} must require ${path}`);
  }

  const version = object(
    JSON.parse(readFileSync(resolve(projectRoot, 'plugins/version.json'), 'utf8')) as unknown,
  )?.version;
  if (typeof version !== 'string') throw new Error('plugins/version.json has no version');
  const firstRun = object(
    JSON.parse(readFileSync(resolve(projectRoot, FIRST_RUN_PATH), 'utf8')) as unknown,
  );
  const candidateRef = object(firstRun?.source)?.ref;
  if (typeof candidateRef !== 'string') {
    throw new Error('Codex MCP first-run evidence has no immutable candidate ref');
  }
  const matrix = JSON.parse(readFileSync(resolve(projectRoot, MATRIX_PATH), 'utf8')) as unknown;
  const compatibility = object(
    JSON.parse(
      readFileSync(resolve(projectRoot, '.github/codex-compatibility.json'), 'utf8'),
    ) as unknown,
  );
  const codexVersion = compatibility?.latest_proven;
  if (typeof codexVersion !== 'string') {
    throw new Error('.github/codex-compatibility.json has no latest_proven version');
  }
  const pluginTreeSha256 = packageTreeSha256(resolve(projectRoot, 'plugins/codex'));
  const issues = validateCodexMcpCandidateMatrix(matrix, {
    proofRoot: resolve(projectRoot, PROOF_ROOT),
    repository: 'petekp/circuit',
    candidateRef,
    pluginVersion: version,
    pluginTreeSha256,
    codexVersion,
    validateTraceEntry: (value: unknown) => trace.TraceEntry?.safeParse(value).success === true,
    validateFlowResult: (schema: string, value: unknown) =>
      flowResultSchemas.get(schema)?.safeParse(value).success === true,
  });
  if (issues.length > 0) {
    for (const issue of issues) console.error(`error: ${issue}`);
    process.exit(1);
  }
  console.log('✓ Codex MCP candidate matrix covers every release lane and architecture');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
