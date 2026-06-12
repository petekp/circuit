import type {
  CapabilityAxes,
  CurrentCapability,
  CurrentCapabilitySnapshot,
  OriginalCapabilitySnapshot,
  ParityException,
  ParityExceptionLedger,
  ProofScenarioIndex,
  PublicClaimLedger,
} from './schemas.js';

export interface ReleaseCheckResult {
  readonly issues: readonly string[];
  readonly warnings: readonly string[];
}

function exceptionCoversCapability(
  exceptions: readonly ParityException[],
  capabilityId: string,
): boolean {
  return exceptions.some((exception) => exception.capability_id === capabilityId);
}

function exceptionCoversClaim(exceptions: readonly ParityException[], claimId: string): boolean {
  return exceptions.some((exception) => exception.claim_id === claimId);
}

function exceptionCoversProof(exceptions: readonly ParityException[], proofId: string): boolean {
  return exceptions.some((exception) => exception.proof_id === proofId);
}

type AxisKey = keyof CapabilityAxes;

const ARRAY_AXIS_KEYS: readonly AxisKey[] = ['intent_hints', 'modes', 'stage_path', 'outputs'];

const TEXT_AXIS_KEYS: readonly AxisKey[] = [
  'checkpoint',
  'review',
  'verification',
  'worker_handoff',
  'continuity',
  'host_surface',
  'proof',
];

const ORDERED_ARRAY_AXIS_KEYS = new Set<AxisKey>(['stage_path']);

function normalizeAxisValue(value: string): string {
  return value.trim().toLowerCase();
}

function compareArrayAxis(
  key: AxisKey,
  expectedValues: readonly string[],
  actualValues: readonly string[],
): string | undefined {
  if (expectedValues.length === 0) return undefined;
  const expected = expectedValues.map(normalizeAxisValue);
  const actual = actualValues.map(normalizeAxisValue);
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expectedValues.filter((value) => !actualSet.has(normalizeAxisValue(value)));
  const extra = actualValues.filter((value) => !expectedSet.has(normalizeAxisValue(value)));
  const orderDiffers =
    ORDERED_ARRAY_AXIS_KEYS.has(key) &&
    missing.length === 0 &&
    extra.length === 0 &&
    expected.some((value, index) => actual[index] !== value);

  const parts: string[] = [];
  if (missing.length > 0) parts.push(`missing ${missing.join(', ')}`);
  if (extra.length > 0) parts.push(`extra ${extra.join(', ')}`);
  if (orderDiffers) parts.push('order differs');
  if (parts.length === 0) return undefined;
  return `${String(key)} ${parts.join('; ')}`;
}

function compareTextAxis(
  key: AxisKey,
  expectedValue: string | undefined,
  actualValue: string | undefined,
): string | undefined {
  void key;
  if (expectedValue === undefined || expectedValue.trim() === '') return undefined;
  if (actualValue === undefined || actualValue.trim() === '') {
    return `${String(key)} missing current value`;
  }
  return undefined;
}

export function behavioralAxisMismatches(input: {
  readonly expected: { readonly axes: CapabilityAxes };
  readonly actual: { readonly axes?: CapabilityAxes };
}): readonly string[] {
  const mismatches: string[] = [];
  const actualAxes: Partial<CapabilityAxes> = input.actual.axes ?? {};

  for (const key of ARRAY_AXIS_KEYS) {
    const expectedValues = input.expected.axes[key];
    const actualValues = actualAxes[key];
    if (!Array.isArray(expectedValues)) continue;
    const mismatch = compareArrayAxis(
      key,
      expectedValues,
      Array.isArray(actualValues) ? actualValues : [],
    );
    if (mismatch !== undefined) mismatches.push(mismatch);
  }

  for (const key of TEXT_AXIS_KEYS) {
    const expectedValue = input.expected.axes[key];
    const actualValue = actualAxes[key];
    if (typeof expectedValue !== 'string') continue;
    const mismatch = compareTextAxis(
      key,
      expectedValue,
      typeof actualValue === 'string' ? actualValue : undefined,
    );
    if (mismatch !== undefined) mismatches.push(mismatch);
  }

  return mismatches;
}

function scriptCheckExists(check: string, pathExists: (path: string) => boolean): boolean {
  const [command] = check.trim().split(/\s+/);
  return command !== undefined && pathExists(command);
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

export function compareParity(input: {
  readonly original: OriginalCapabilitySnapshot;
  readonly current: CurrentCapabilitySnapshot;
  readonly exceptions: ParityExceptionLedger;
}): ReleaseCheckResult {
  const issues: string[] = [];
  const warnings: string[] = [];
  const currentById = capabilityMap(input.current);

  for (const expected of input.original.capabilities) {
    if (!expected.release_required) continue;
    const actual = currentById.get(expected.id);
    if (actual === undefined) {
      if (exceptionCoversCapability(input.exceptions.exceptions, expected.id)) {
        warnings.push(`tracked gap: ${expected.id} is absent from current capabilities`);
      } else {
        issues.push(`untracked parity gap: ${expected.id} is absent from current capabilities`);
      }
      continue;
    }
    if (actual.status !== 'implemented') {
      if (exceptionCoversCapability(input.exceptions.exceptions, expected.id)) {
        warnings.push(`tracked gap: ${expected.id} is ${actual.status}`);
      } else {
        issues.push(`untracked parity gap: ${expected.id} is ${actual.status}`);
      }
      continue;
    }
    const axisMismatches = behavioralAxisMismatches({ expected, actual });
    if (axisMismatches.length > 0) {
      const message = `${expected.id} behavioral axes differ: ${axisMismatches.join('; ')}`;
      if (exceptionCoversCapability(input.exceptions.exceptions, expected.id)) {
        warnings.push(`tracked behavioral gap: ${message}`);
      } else {
        issues.push(`untracked behavioral parity gap: ${message}`);
      }
    }
  }

  return { issues, warnings };
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
}): ReleaseCheckResult {
  const issues: string[] = [];
  const warnings: string[] = [];
  const currentById = capabilityMap(input.current);
  const proofById = new Map(input.proofs.scenarios.map((scenario) => [scenario.id, scenario]));
  const exceptionIds = new Set(input.exceptions.exceptions.map((exception) => exception.id));

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
