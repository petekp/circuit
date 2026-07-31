import { spawnSync } from 'node:child_process';
import type {
  CurrentCapability,
  CurrentCapabilitySnapshot,
  ParityException,
  ParityExceptionLedger,
  ProofScenarioIndex,
  PublicClaimLedger,
} from './schemas.js';

export interface ReleaseCheckResult {
  readonly issues: readonly string[];
  readonly warnings: readonly string[];
}

function exceptionCoversClaim(exceptions: readonly ParityException[], claimId: string): boolean {
  return exceptions.some((exception) => exception.claim_id === claimId);
}

function exceptionCoversProof(exceptions: readonly ParityException[], proofId: string): boolean {
  return exceptions.some((exception) => exception.proof_id === proofId);
}

function scriptCheckExists(check: string, pathExists: (path: string) => boolean): boolean {
  const [command] = check.trim().split(/\s+/);
  return command !== undefined && pathExists(command);
}

export interface ScriptCheckResult {
  readonly ok: boolean;
  readonly detail?: string;
}

// A backing `script_check` names a repo-relative script and its args, e.g.
// `scripts/release/emit-current-capabilities.ts --check`. The declared backing
// scripts are cheap, side-effect-free `--check`/validation runs, so honoring
// `verified_current` only means something if the script is actually executed
// and passes. Default: run it with the current Node under the repo root and
// require exit 0. Injectable so unit tests never spawn a subprocess.
export function executeScriptCheck(check: string): ScriptCheckResult {
  const parts = check.trim().split(/\s+/);
  const [file, ...args] = parts;
  if (file === undefined) return { ok: false, detail: 'empty script check' };
  const result = spawnSync(process.execPath, [file, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.status === 0) return { ok: true };
  const detail =
    result.stderr?.trim() ||
    result.stdout?.trim() ||
    (result.error ? result.error.message : `exit ${result.status ?? 'unknown'}`);
  return { ok: false, detail };
}

function verifiedBackingCount(backing: PublicClaimLedger['claims'][number]['backing']): number {
  return (
    backing.capability_ids.length +
    backing.proof_ids.length +
    backing.test_paths.length +
    backing.script_checks.length
  );
}

export function capabilityMap(
  current: CurrentCapabilitySnapshot,
): ReadonlyMap<string, CurrentCapability> {
  return new Map(current.capabilities.map((capability) => [capability.id, capability] as const));
}

// The one public claim that must enumerate the entire public flow catalog.
// Its backing `flow:*` capabilities are gated for completeness — not merely
// "each listed flow is implemented" but "the listed flows are exactly the
// catalog's flows" — so adding or removing a flow without updating this claim
// fails the release check instead of drifting silently.
export const FLOW_CATALOG_CLAIM_ID = 'CLAIM-FLOW-CATALOG-CURRENT';
const FLOW_CAPABILITY_PREFIX = 'flow:';

function flowCapabilityIds(ids: Iterable<string>): string[] {
  const flowIds = new Set<string>();
  for (const id of ids) {
    if (id.startsWith(FLOW_CAPABILITY_PREFIX)) flowIds.add(id);
  }
  return [...flowIds].sort();
}

export function validatePublicClaims(input: {
  readonly claims: PublicClaimLedger;
  readonly current: CurrentCapabilitySnapshot;
  readonly proofs: ProofScenarioIndex;
  readonly exceptions: ParityExceptionLedger;
  readonly pathExists: (path: string) => boolean;
  // How to actually run a backing script check. Defaults to executing it and
  // requiring exit 0; injected in tests to avoid spawning subprocesses.
  readonly runScriptCheck?: (check: string) => ScriptCheckResult;
}): ReleaseCheckResult {
  const issues: string[] = [];
  const warnings: string[] = [];
  const currentById = capabilityMap(input.current);
  const proofById = new Map(input.proofs.scenarios.map((scenario) => [scenario.id, scenario]));
  const exceptionIds = new Set(input.exceptions.exceptions.map((exception) => exception.id));
  const runScriptCheck = input.runScriptCheck ?? executeScriptCheck;
  // Run each distinct backing script at most once per validation pass.
  const scriptCheckCache = new Map<string, ScriptCheckResult>();
  const runScriptCheckCached = (check: string): ScriptCheckResult => {
    const cached = scriptCheckCache.get(check);
    if (cached !== undefined) return cached;
    const result = runScriptCheck(check);
    scriptCheckCache.set(check, result);
    return result;
  };

  for (const claim of input.claims.claims) {
    const backing = claim.backing;
    if (claim.status === 'verified_current') {
      if (verifiedBackingCount(backing) === 0) {
        issues.push(`claim ${claim.id} is verified_current without live backing`);
      }
      for (const capabilityId of backing.capability_ids) {
        if (currentById.get(capabilityId)?.status !== 'implemented') {
          issues.push(`claim ${claim.id} references unsupported capability: ${capabilityId}`);
        }
      }
      for (const proofId of backing.proof_ids) {
        if (proofById.get(proofId)?.status !== 'verified_current') {
          issues.push(`claim ${claim.id} references unverified proof: ${proofId}`);
        }
      }
      for (const path of backing.test_paths) {
        if (!input.pathExists(path)) {
          issues.push(`claim ${claim.id} references missing test path: ${path}`);
        }
      }
      for (const check of backing.script_checks) {
        if (!scriptCheckExists(check, input.pathExists)) {
          issues.push(`claim ${claim.id} references unavailable script check: ${check}`);
          continue;
        }
        // File existence is not enough: run the backing script and require it
        // to pass, so verified_current resists rot.
        const scriptResult = runScriptCheckCached(check);
        if (!scriptResult.ok) {
          const detail = scriptResult.detail !== undefined ? ` (${scriptResult.detail})` : '';
          issues.push(`claim ${claim.id} backing script check failed: ${check}${detail}`);
        }
      }
    }

    if (claim.status === 'release_blocker' || claim.status === 'approved_exception') {
      const listedExceptionOk = backing.exception_ids.every((id) => exceptionIds.has(id));
      const directExceptionOk = exceptionCoversClaim(input.exceptions.exceptions, claim.id);
      if (backing.exception_ids.length === 0 && !directExceptionOk) {
        issues.push(`claim ${claim.id} is ${claim.status} without an exception`);
      } else if (!listedExceptionOk) {
        issues.push(`claim ${claim.id} references an unknown exception`);
      } else {
        warnings.push(`tracked claim: ${claim.id} is ${claim.status}`);
      }
    }

    if (claim.status === 'planned' && backing.exception_ids.length > 0) {
      warnings.push(`planned claim ${claim.id} has exception backing; keep wording future-facing`);
    }
  }

  // Completeness, not just backing: when the flow-catalog claim is present its
  // flow capability set must EQUAL the catalog-derived flow set. The per-claim
  // loop above only proves each listed flow is implemented; this proves none is
  // missing, so a newly added flow cannot ship while the claim still names the
  // old roster. (Absence of the claim is gated by a release test, not here, so
  // the unit checks that pass minimal ledgers stay focused.)
  const flowCatalogClaim = input.claims.claims.find((claim) => claim.id === FLOW_CATALOG_CLAIM_ID);
  if (flowCatalogClaim !== undefined) {
    const catalogFlowIds = flowCapabilityIds(currentById.keys());
    const claimedFlowIds = flowCapabilityIds(flowCatalogClaim.backing.capability_ids);
    for (const id of catalogFlowIds) {
      if (!claimedFlowIds.includes(id)) {
        issues.push(`claim ${FLOW_CATALOG_CLAIM_ID} omits catalog flow capability: ${id}`);
      }
    }
    for (const id of claimedFlowIds) {
      if (!catalogFlowIds.includes(id)) {
        issues.push(
          `claim ${FLOW_CATALOG_CLAIM_ID} lists flow capability absent from the catalog: ${id}`,
        );
      }
    }
  }

  return { issues, warnings };
}

export function validateProofCoverage(input: {
  readonly proofs: ProofScenarioIndex;
  readonly exceptions: ParityExceptionLedger;
  readonly pathExists: (path: string) => boolean;
}): ReleaseCheckResult {
  const issues: string[] = [];
  const warnings: string[] = [];
  const requiredCategories = new Set([
    'doing-work',
    'deciding',
    'continuity',
    'customization',
    'first-run',
    'failure',
    'plan-execution',
  ]);
  for (const scenario of input.proofs.scenarios) {
    requiredCategories.delete(scenario.category);
    if (scenario.status === 'verified_current') {
      const missing = scenario.required_files.filter((path) => !input.pathExists(path));
      if (missing.length > 0) {
        issues.push(
          `proof ${scenario.id} is verified_current but missing files: ${missing.join(', ')}`,
        );
      }
    } else if (
      scenario.status === 'release_blocker' ||
      scenario.status === 'approved_exception' ||
      scenario.status === 'planned' ||
      scenario.status === 'missing'
    ) {
      const hasException =
        scenario.exception_ids.length > 0 ||
        exceptionCoversProof(input.exceptions.exceptions, scenario.id);
      if (!hasException) {
        issues.push(`proof ${scenario.id} is ${scenario.status} without an exception`);
      } else {
        warnings.push(`tracked proof: ${scenario.id} is ${scenario.status}`);
      }
    }
  }
  for (const category of requiredCategories) {
    issues.push(`proof category has no scenario: ${category}`);
  }
  return { issues, warnings };
}

export function releaseBlockers(input: {
  readonly exceptions: ParityExceptionLedger;
  readonly claims: PublicClaimLedger;
  readonly proofs: ProofScenarioIndex;
}): readonly string[] {
  const blockers: string[] = [];
  for (const exception of input.exceptions.exceptions) {
    if (exception.status === 'release_blocker') {
      blockers.push(`${exception.id}: ${exception.rationale}`);
    }
  }
  for (const claim of input.claims.claims) {
    if (claim.status === 'release_blocker') {
      blockers.push(`${claim.id}: ${claim.claim}`);
    }
  }
  for (const scenario of input.proofs.scenarios) {
    if (
      scenario.status === 'release_blocker' ||
      scenario.status === 'planned' ||
      scenario.status === 'missing'
    ) {
      blockers.push(`${scenario.id}: proof scenario is not captured`);
    }
  }
  return blockers;
}
