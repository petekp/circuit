#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { packageTreeSha256 } from '../plugins/package-tree.ts';
import {
  validateCandidateGitBinding,
  validateCodexMcpFirstRunEvidence,
} from './codex-mcp-first-run-evidence.ts';
import { loadReleaseSchemas, loadYamlWithSchema, projectRoot } from './shared.ts';

const PROOF_ID = 'proof:codex-mcp-first-run';
const EVIDENCE_PATH = 'docs/release/proofs/runs/codex-mcp-first-run/evidence.json';

async function main(): Promise<void> {
  const [resultModule, reviewModule] = (await Promise.all([
    import(new URL('../../dist/schemas/result.js', import.meta.url).href),
    import(new URL('../../dist/flows/review/reports.js', import.meta.url).href),
  ])) as [
    {
      readonly RunResult?: {
        readonly safeParse: (value: unknown) => { readonly success: boolean };
      };
    },
    {
      readonly ReviewResult?: {
        readonly safeParse: (value: unknown) => { readonly success: boolean };
      };
    },
  ];
  if (resultModule.RunResult === undefined || reviewModule.ReviewResult === undefined) {
    throw new Error('built first-run result schemas are unavailable; run npm run build first');
  }
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
  const pluginTreeSha256 = packageTreeSha256(resolve(projectRoot, 'plugins/codex'));
  const proofRoot = resolve(projectRoot, 'docs/release/proofs/runs/codex-mcp-first-run');
  const issues = validateCodexMcpFirstRunEvidence(evidence, {
    pluginVersion: versionManifest.version,
    pluginTreeSha256,
    repository: 'petekp/circuit',
    proofRoot,
    validateRunResult: (value: unknown) =>
      resultModule.RunResult?.safeParse(value).success === true,
    validateReviewResult: (value: unknown) =>
      reviewModule.ReviewResult?.safeParse(value).success === true,
  });
  const root =
    typeof evidence === 'object' && evidence !== null && !Array.isArray(evidence)
      ? (evidence as Record<string, unknown>)
      : undefined;
  const source =
    typeof root?.source === 'object' && root.source !== null && !Array.isArray(root.source)
      ? (root.source as Record<string, unknown>)
      : undefined;
  if (typeof source?.ref === 'string') {
    issues.push(
      ...validateCandidateGitBinding({
        repoRoot: projectRoot,
        candidateRef: source.ref,
        headRef: 'HEAD',
        expectedPluginTreeSha256: pluginTreeSha256,
      }),
    );
  }
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
