// Single source of truth for flow-kind canonical stage-set policy.
//
// The core is table-parameterized so catalog-derived flow data can live on the
// flow side of the boundary while policy keeps the pure checks.

interface FlowKindPolicyVariant {
  readonly canonicals: readonly string[];
  readonly omits: readonly string[];
  readonly title: string;
}

export interface CompiledFlowKindPolicyEntry {
  readonly canonicals: readonly string[];
  readonly omits: readonly string[];
  /**
   * Canonicals that may be either declared or omitted by per-mode variants.
   * When declared, they must NOT appear in stage_path_policy.omits. When absent
   * from declared stages, they MUST appear in stage_path_policy.omits.
   */
  readonly optional_canonicals: readonly string[];
  /**
   * Complete alternate canonical policies for per-mode fixtures whose graph is
   * intentionally not the default graph.
   */
  readonly variants: readonly FlowKindPolicyVariant[];
  readonly title: string;
  readonly authority: string;
}

type RecordLike = Record<string, unknown>;

type PolicyVariantCheckResult =
  | { readonly ok: true; readonly detail: string }
  | { readonly ok: false; readonly detail: string };

type IndexedStep = { readonly step: RecordLike; readonly index: number };

export type ReviewIdentitySeparationPolicyResult =
  | { readonly ok: true; readonly detail: string }
  | { readonly ok: false; readonly detail: string };

export type CompiledFlowKindPolicyCheckResult =
  | { readonly kind: 'green'; readonly detail: string }
  | { readonly kind: 'exempt'; readonly detail: string }
  | { readonly kind: 'pass_through'; readonly detail: string }
  | { readonly kind: 'red'; readonly detail: string };

export interface CompiledFlowKindPolicyTable {
  readonly canonicalSets: Readonly<Record<string, CompiledFlowKindPolicyEntry>>;
  readonly exemptFlowIds: ReadonlySet<string>;
}

function objectRecord(value: unknown): RecordLike | undefined {
  return value !== null && typeof value === 'object' ? (value as RecordLike) : undefined;
}

function stringStepIdsForCanonical(stages: readonly unknown[], canonical: string): string[] {
  const ids: string[] = [];
  for (const stage of stages) {
    const p = objectRecord(stage);
    if (p === undefined || p.canonical !== canonical || !Array.isArray(p.steps)) continue;
    for (const id of p.steps) {
      if (typeof id === 'string') ids.push(id);
    }
  }
  return ids;
}

function isReviewResultReportWriter(step: unknown): boolean {
  const s = objectRecord(step);
  if (s === undefined || s.kind !== 'compose') return false;
  const writes = objectRecord(s.writes);
  const report = objectRecord(writes?.report);
  return report?.schema === 'review.result@v1';
}

function isReviewerRelay(step: unknown): boolean {
  const s = objectRecord(step);
  return s !== undefined && s.kind === 'relay' && s.role === 'reviewer';
}

function declaredCanonicalsFor(fixture: RecordLike): Set<string> {
  const declared = new Set<string>();
  const stages = Array.isArray(fixture.stages) ? fixture.stages : [];
  for (const stage of stages) {
    const stageRecord = objectRecord(stage);
    if (typeof stageRecord?.canonical === 'string') {
      declared.add(stageRecord.canonical);
    }
  }
  return declared;
}

function checkCanonicalStagePolicyVariant(
  id: string,
  fixture: RecordLike,
  variant: FlowKindPolicyVariant,
  optionalCanonicals: readonly string[],
  authority: string,
): PolicyVariantCheckResult {
  const declared = declaredCanonicalsFor(fixture);
  const optional = new Set(optionalCanonicals);
  const required = new Set(variant.canonicals.filter((c) => !optional.has(c)));
  const acceptedDeclared = new Set([...required, ...optional]);
  const missing = [...required].filter((c) => !declared.has(c));
  const extra = [...declared].filter((c) => !acceptedDeclared.has(c));
  if (missing.length > 0 || extra.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing canonical(s): ${missing.join(', ')}`);
    if (extra.length > 0) parts.push(`unexpected canonical(s): ${extra.join(', ')}`);
    return {
      ok: false,
      detail: `${id}: canonical stage-set mismatch — ${parts.join('; ')} (authority: ${authority})`,
    };
  }

  const sp = objectRecord(fixture.stage_path_policy);
  if (sp === undefined) {
    return {
      ok: false,
      detail: `${id}: stage_path_policy missing or not an object`,
    };
  }
  const omits = Array.isArray(sp.omits)
    ? sp.omits.filter((s): s is string => typeof s === 'string')
    : [];
  const optionalOmitted = [...optional].filter((c) => !declared.has(c));
  const expectedOmits = new Set([...variant.omits, ...optionalOmitted]);
  // A flow that omits no canonical stage uses the full spine. The SpinePolicy
  // schema forbids `partial` with an empty omit-set (partial requires >=1 omit),
  // so a full-canonical flow must declare `strict`. Require `strict` only when the
  // expected omit-set is empty, and `partial` otherwise. The omit cross-check below
  // still runs and is trivially satisfied in the empty (strict) case. Flows that omit
  // at least one stage are unaffected: they still require `partial`.
  const expectedMode = expectedOmits.size === 0 ? 'strict' : 'partial';
  if (sp.mode !== expectedMode) {
    return {
      ok: false,
      detail: `${id}: stage_path_policy.mode must be '${expectedMode}' for kind-canonical enforcement; got '${String(sp.mode)}'`,
    };
  }
  const missingOmits = [...expectedOmits].filter((o) => !omits.includes(o));
  const extraOmits = omits.filter((o) => !expectedOmits.has(o));
  if (missingOmits.length > 0 || extraOmits.length > 0) {
    const parts: string[] = [];
    if (missingOmits.length > 0) parts.push(`missing omit(s): ${missingOmits.join(', ')}`);
    if (extraOmits.length > 0) parts.push(`unexpected omit(s): ${extraOmits.join(', ')}`);
    return {
      ok: false,
      detail: `${id}: stage_path_policy.omits mismatch — ${parts.join('; ')} (authority: ${authority})`,
    };
  }

  return {
    ok: true,
    detail: `${id}: canonical set {${variant.canonicals.join(', ')}} + omits {${variant.omits.join(', ')}} enforced (authority: ${authority})`,
  };
}

export function checkReviewIdentitySeparationPolicy(
  fixture: unknown,
): ReviewIdentitySeparationPolicyResult {
  const f = objectRecord(fixture);
  if (f === undefined) {
    return { ok: false, detail: 'fixture is not an object' };
  }
  const stages = Array.isArray(f.stages) ? f.stages : [];
  const steps = Array.isArray(f.steps) ? f.steps : [];
  const analyzeStepIds = stringStepIdsForCanonical(stages, 'analyze');
  const closeStepIds = stringStepIdsForCanonical(stages, 'close');

  const stepsById = new Map<string, IndexedStep>();
  for (let index = 0; index < steps.length; index++) {
    const step = objectRecord(steps[index]);
    if (typeof step?.id === 'string') stepsById.set(step.id, { step, index });
  }

  const reviewerRelayIndices = analyzeStepIds
    .map((id) => stepsById.get(id))
    .filter((entry): entry is IndexedStep => entry !== undefined && isReviewerRelay(entry.step))
    .map((entry) => entry.index);
  if (reviewerRelayIndices.length === 0) {
    return {
      ok: false,
      detail:
        'analyze stage must contain a relay step with role=reviewer before the close report writer',
    };
  }

  const closeWriterIndices = closeStepIds
    .map((id) => stepsById.get(id))
    .filter(
      (entry): entry is IndexedStep =>
        entry !== undefined && isReviewResultReportWriter(entry.step),
    )
    .map((entry) => entry.index);
  if (closeWriterIndices.length === 0) {
    return {
      ok: false,
      detail:
        'close stage must contain a compose step that writes the primary review.result report',
    };
  }

  const everyCloseWriterPreceded = closeWriterIndices.every((closeIndex) =>
    reviewerRelayIndices.some((reviewerIndex) => reviewerIndex < closeIndex),
  );
  if (!everyCloseWriterPreceded) {
    return {
      ok: false,
      detail:
        'each close-stage review.result report writer must be preceded in steps[] by an analyze-stage reviewer relay',
    };
  }

  return {
    ok: true,
    detail: 'close review.result report writer is preceded by an analyze-stage reviewer relay',
  };
}

export function checkCompiledFlowKindCanonicalPolicyWithTable(
  fixture: unknown,
  table: CompiledFlowKindPolicyTable,
): CompiledFlowKindPolicyCheckResult {
  const f = objectRecord(fixture);
  if (f === undefined) {
    return {
      kind: 'red',
      detail: 'fixture is not an object',
    };
  }
  const id = f.id;
  if (typeof id !== 'string') {
    return {
      kind: 'red',
      detail: 'fixture missing top-level `id` string field',
    };
  }

  if (table.exemptFlowIds.has(id)) {
    return {
      kind: 'exempt',
      detail: `${id}: exempt from kind-canonical enforcement (partial-stage path, recorded)`,
    };
  }

  const expected = table.canonicalSets[id];
  if (expected === undefined) {
    return {
      kind: 'pass_through',
      detail: `${id}: no canonical-set entry (unknown flow kind; pass-through)`,
    };
  }

  const variants = [
    { canonicals: expected.canonicals, omits: expected.omits, title: expected.title },
    ...(expected.variants ?? []),
  ];
  const checkedVariants = variants.map((variant) =>
    checkCanonicalStagePolicyVariant(
      id,
      f,
      variant,
      expected.optional_canonicals,
      expected.authority,
    ),
  );
  const acceptedVariant = checkedVariants.find((variant) => variant.ok);
  if (acceptedVariant === undefined) {
    return {
      kind: 'red',
      detail: checkedVariants.map((variant) => variant.detail).join(' OR '),
    };
  }

  if (id === 'review') {
    const identitySeparation = checkReviewIdentitySeparationPolicy(f);
    if (!identitySeparation.ok) {
      return {
        kind: 'red',
        detail: `${id}: ${identitySeparation.detail} (authority: ${expected.authority})`,
      };
    }
  }

  return {
    kind: 'green',
    detail: acceptedVariant.detail,
  };
}
