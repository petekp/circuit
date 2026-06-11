#!/usr/bin/env node

import {
  currentPluginVersion,
  evalCadenceBlockers,
  lastReleaseTagDate,
  readLedgerEntries,
  readRegistryEvals,
  readWaivers,
} from './eval-cadence.ts';
import {
  loadReleaseChecks,
  loadReleaseSchemas,
  loadYamlWithSchema,
  projectRoot,
} from './shared.ts';

async function main() {
  const schemas = await loadReleaseSchemas();
  const checks = await loadReleaseChecks();
  const exceptions = loadYamlWithSchema(
    'docs/release/parity/exceptions.yaml',
    schemas.ParityExceptionLedger,
  );
  const claims = loadYamlWithSchema(
    'docs/release/claims/public-claims.yaml',
    schemas.PublicClaimLedger,
  );
  const proofs = loadYamlWithSchema('docs/release/proofs/index.yaml', schemas.ProofScenarioIndex);
  const cadenceBlockers = evalCadenceBlockers({
    evals: readRegistryEvals(projectRoot),
    ledgerEntries: readLedgerEntries(projectRoot),
    lastReleaseDate: lastReleaseTagDate(projectRoot),
    currentVersion: currentPluginVersion(projectRoot),
    waivers: readWaivers(projectRoot),
  });
  const blockers = [...checks.releaseBlockers({ exceptions, claims, proofs }), ...cadenceBlockers];
  if (blockers.length > 0) {
    for (const blocker of blockers) console.error(`release blocker: ${blocker}`);
    process.exit(1);
  }
  console.log('✓ no release blockers remain');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
