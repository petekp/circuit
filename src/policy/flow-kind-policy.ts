import { CompiledFlow } from '../schemas/compiled-flow.js';
import {
  type CompiledFlowKindPolicyCheckResult,
  type CompiledFlowKindPolicyTable,
  checkCompiledFlowKindCanonicalPolicyWithTable,
} from './flow-kind-policy-core.js';

// Wraps the canonical-set check with a Zod CompiledFlow.safeParse pre-check.
// Callers supply the canonical policy table from the side that owns the data.

export type { CompiledFlowKindPolicyCheckResult };

export type ValidateCompiledFlowKindPolicyResult =
  | { ok: true; kind: Exclude<CompiledFlowKindPolicyCheckResult['kind'], 'red'>; detail: string }
  | { ok: false; reason: string };

function humanizeZodIssueMessage(message: string): string {
  return message
    .replace(/, received undefined/g, ' (missing)')
    .replace(/\breceived undefined\b/g, 'missing');
}

/**
 * Validates that an unknown input is a valid CompiledFlow (Zod safeParse)
 * AND that its declared flow kind satisfies the canonical stage-set policy.
 *
 * Returns ok:false with a human-readable reason string. Callers decide whether
 * to throw or surface the reason directly.
 */
export function validateCompiledFlowKindPolicyWithTable(
  flow: unknown,
  table: CompiledFlowKindPolicyTable,
): ValidateCompiledFlowKindPolicyResult {
  const parsed = CompiledFlow.safeParse(flow);
  if (!parsed.success) {
    const issueSummary = parsed.error.issues
      .slice(0, 5)
      .map((i) => `  ${i.path.join('.') || '<root>'}: ${humanizeZodIssueMessage(i.message)}`)
      .join('\n');
    const more =
      parsed.error.issues.length > 5 ? `\n  ... +${parsed.error.issues.length - 5} more` : '';
    return {
      ok: false,
      reason: `CompiledFlow.safeParse failed:\n${issueSummary}${more}`,
    };
  }

  const policyResult = checkCompiledFlowKindCanonicalPolicyWithTable(parsed.data, table);
  if (policyResult.kind === 'red') {
    return {
      ok: false,
      reason: `flow-kind canonical policy violation: ${policyResult.detail}`,
    };
  }
  return {
    ok: true,
    kind: policyResult.kind,
    detail: policyResult.detail,
  };
}
