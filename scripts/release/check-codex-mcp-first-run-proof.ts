#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { packageTreeSha256 } from '../plugins/package-tree.ts';
import { validateCodexMcpFirstRunEvidence } from './codex-mcp-first-run-evidence.ts';
import { loadReleaseSchemas, loadYamlWithSchema, projectRoot } from './shared.ts';

const PROOF_ID = 'proof:codex-mcp-first-run';
const EVIDENCE_PATH = 'docs/release/proofs/runs/codex-mcp-first-run/evidence.json';

async function main(): Promise<void> {
  const schemas = await loadReleaseSchemas();
  const proofs = loadYamlWithSchema('docs/release/proofs/index.yaml', schemas.ProofScenarioIndex);
  const proof = proofs.scenarios.find((scenario) => scenario.id === PROOF_ID);
  if (proof === undefined) throw new Error(`${PROOF_ID} is missing from the proof index`);
  if (proof.status !== 'verified_current') {
    console.warn(`tracked: ${PROOF_ID} is ${proof.status}`);
    return;
  }
  if (!proof.required_files.includes(EVIDENCE_PATH)) {
    throw new Error(`${PROOF_ID} must require ${EVIDENCE_PATH}`);
  }

  const versionManifest = JSON.parse(
    readFileSync(resolve(projectRoot, 'plugins/version.json'), 'utf8'),
  ) as { readonly version?: unknown };
  if (typeof versionManifest.version !== 'string') {
    throw new Error('plugins/version.json has no version');
  }
  const evidence = JSON.parse(readFileSync(resolve(projectRoot, EVIDENCE_PATH), 'utf8')) as unknown;
  const issues = validateCodexMcpFirstRunEvidence(evidence, {
    pluginVersion: versionManifest.version,
    pluginTreeSha256: packageTreeSha256(resolve(projectRoot, 'plugins/codex')),
    repository: 'petekp/circuit',
    ref: `circuit--v${versionManifest.version}`,
  });
  if (issues.length > 0) {
    for (const issue of issues) console.error(`error: ${issue}`);
    process.exit(1);
  }
  console.log('✓ Codex MCP first-run evidence matches the current plugin version and tree');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
