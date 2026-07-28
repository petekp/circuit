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

// The verdict has to come from a reviewer that is not the author of the work.
// A step satisfies that either by being a reviewer relay itself or by fanning
// out to reviewer relays: one reviewer or eight, the independence is the same
// property, and a flow that splits a large target across several reviewers
// must not fail an invariant about having one.
function isReviewerRelay(step: unknown): boolean {
  const s = objectRecord(step);
  if (s === undefined) return false;
  if (s.kind === 'relay') return s.role === 'reviewer';
  if (s.kind !== 'fanout') return false;
  const branches = objectRecord(s.branches);
  if (branches === undefined) return false;
  const templates =
    branches.kind === 'dynamic'
      ? [branches.template]
      : Array.isArray(branches.branches)
        ? branches.branches
        : [];
  // Every branch, not some branch: a fan-out where one arm is a reviewer and
  // the rest are something else is not an independent review of the whole.
  return (
    templates.length > 0 &&
    templates.every((branch) => objectRecord(objectRecord(branch)?.execution)?.role === 'reviewer')
  );
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

const REVIEW_IDENTITY_SEPARATION_AUTHORITY = 'flow-kind review-identity-separation policy';

// Intrinsic trigger for the review-identity-separation invariant: a flow whose
// close stage contains a compose step that writes the primary review.result
// report is producing a verdict, and must therefore route that verdict through
// an independent reviewer relay. Keying on this behavior — rather than on a
// hardcoded `id === 'review'` — holds composed flows (which carry no catalog id)
// to the same separation-of-duties rule.
function hasCloseStageReviewResultWriter(fixture: RecordLike): boolean {
  const stages = Array.isArray(fixture.stages) ? fixture.stages : [];
  const steps = Array.isArray(fixture.steps) ? fixture.steps : [];
  const closeStepIds = new Set(stringStepIdsForCanonical(stages, 'close'));
  for (const step of steps) {
    const s = objectRecord(step);
    if (s === undefined || typeof s.id !== 'string') continue;
    if (closeStepIds.has(s.id) && isReviewResultReportWriter(s)) return true;
  }
  return false;
}

// Returns a red result when the flow emits a verdict but violates identity
// separation; undefined when the invariant does not apply (no close-stage
// verdict writer) or is satisfied. Callers run this for every flow, including
// those with no canonical-set entry, so the verdict-producing rule cannot be
// skipped by composition.
function reviewIdentitySeparationViolation(
  id: string,
  fixture: RecordLike,
): CompiledFlowKindPolicyCheckResult | undefined {
  if (!hasCloseStageReviewResultWriter(fixture)) return undefined;
  const identity = checkReviewIdentitySeparationPolicy(fixture);
  if (identity.ok) return undefined;
  return {
    kind: 'red',
    detail: `${id}: ${identity.detail} (authority: ${REVIEW_IDENTITY_SEPARATION_AUTHORITY})`,
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

  // Intrinsic, kind-independent invariant, checked first — before exemption and
  // before the canonical-set table lookup. A flow that emits a verdict cannot
  // self-author it, regardless of its id, whether it has a table entry (a
  // composed flow does not), or whether it is exempt from stage-set enforcement
  // (exemption covers the partial-stage path, not separation of duties). This is
  // what closes the former pass-through hole: an unknown-id flow is no longer
  // waved through.
  const identityViolation = reviewIdentitySeparationViolation(id, f);
  if (identityViolation !== undefined) {
    return identityViolation;
  }

  if (table.exemptFlowIds.has(id)) {
    return {
      kind: 'exempt',
      detail: `${id}: exempt from kind-canonical enforcement (partial-stage path, recorded)`,
    };
  }

  const expected = table.canonicalSets[id];
  if (expected === undefined) {
    // No external canonical-set prescription for this id (e.g. a composed flow).
    // Internal canonical consistency is already enforced by CompiledFlow's Zod
    // superRefine, and the intrinsic identity check above has run, so this is a
    // clean pass-through rather than zero enforcement.
    return {
      kind: 'pass_through',
      detail: `${id}: no canonical-set entry (unknown or composed flow kind; pass-through — intrinsic identity policy enforced)`,
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

  // Identity separation is enforced intrinsically above (for known and composed
  // flows alike), so no id-specific branch is needed here.
  return {
    kind: 'green',
    detail: acceptedVariant.detail,
  };
}
