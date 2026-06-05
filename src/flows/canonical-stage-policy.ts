import {
  type CompiledFlowKindPolicyCheckResult,
  type CompiledFlowKindPolicyEntry,
  type CompiledFlowKindPolicyTable,
  checkCompiledFlowKindCanonicalPolicyWithTable,
} from '../policy/flow-kind-policy-core.js';
import {
  type ValidateCompiledFlowKindPolicyResult,
  validateCompiledFlowKindPolicyWithTable,
} from '../policy/flow-kind-policy.js';
import { flowDefinitions } from './catalog.js';
import type { FlowDefinitionCanonicalStagePolicy } from './flow-definition.js';

export type FlowCanonicalStagePolicyEntry = Omit<
  Extract<FlowDefinitionCanonicalStagePolicy, { readonly kind: 'enforce' }>,
  'kind'
>;

const canonicalStagePolicyById: Record<string, FlowCanonicalStagePolicyEntry> = {};
const canonicalStagePolicyExemptIds = new Set<string>();

for (const definition of flowDefinitions) {
  const policy = definition.canonicalStagePolicy;
  if (policy === undefined) continue;
  if (policy.kind === 'exempt') {
    canonicalStagePolicyExemptIds.add(definition.id);
    continue;
  }
  const { kind: _kind, ...entry } = policy;
  canonicalStagePolicyById[definition.id] = entry;
}

export const FLOW_CANONICAL_STAGE_POLICY_BY_ID: Readonly<
  Record<string, FlowCanonicalStagePolicyEntry>
> = canonicalStagePolicyById;

export const FLOW_CANONICAL_STAGE_POLICY_EXEMPT_IDS: ReadonlySet<string> =
  canonicalStagePolicyExemptIds;

export const FLOW_KIND_CANONICAL_SETS: Readonly<Record<string, CompiledFlowKindPolicyEntry>> =
  FLOW_CANONICAL_STAGE_POLICY_BY_ID;

export const EXEMPT_FLOW_IDS: ReadonlySet<string> = FLOW_CANONICAL_STAGE_POLICY_EXEMPT_IDS;

const FLOW_KIND_POLICY_TABLE: CompiledFlowKindPolicyTable = {
  canonicalSets: FLOW_KIND_CANONICAL_SETS,
  exemptFlowIds: EXEMPT_FLOW_IDS,
};

export type { CompiledFlowKindPolicyCheckResult, ValidateCompiledFlowKindPolicyResult };

export function checkCompiledFlowKindCanonicalPolicy(
  fixture: unknown,
): CompiledFlowKindPolicyCheckResult {
  return checkCompiledFlowKindCanonicalPolicyWithTable(fixture, FLOW_KIND_POLICY_TABLE);
}

export function validateCompiledFlowKindPolicy(
  flow: unknown,
): ValidateCompiledFlowKindPolicyResult {
  return validateCompiledFlowKindPolicyWithTable(flow, FLOW_KIND_POLICY_TABLE);
}
