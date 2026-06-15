// The pure quality scorer.
//
// `collectFlowQualityIssues(schematic, compiled?)` returns one QualityIssue per
// deficiency it finds. It is pure and offline: it reads the already-parsed
// FlowSchematic (and, when supplied, the CompiledFlow the schematic compiled
// to) and never touches a file, network, or model. Mirrors the shape of
// `collectSchematicCatalogIssues` (src/flows/schematic-catalog-check.ts), which
// is the catalog-compatibility scorer this one sits beside: that one asks "does
// this flow fit the block catalog?", this one asks "is this flow well-shaped?".
//
// Two families of signal:
//   - Always-checkable signals fire on real, well-formed flows too
//     (absent skill slots, thin evidence, alias overage, single-step, no
//     primary-result binding). These give the ratchet a non-trivial baseline
//     and are the signals the resolvers are measured against.
//   - Guard signals stay at zero on a well-formed flow and only fire on a
//     hand-authored or mutated schematic that drops a canonical work stage
//     WITHOUT declaring the omission (undeclared-missing-*) or leaves a partial
//     spine unexplained (partial-spine-without-rationale). The assembler always
//     records omits + rationale, so these are regression catchers, not noise.
import type { CompiledFlow } from '../../src/schemas/compiled-flow.js';
import type { FlowSchematic } from '../../src/schemas/flow-schematic.js';
import { PARTIAL_SPINE_RATIONALE_MIN_LENGTH } from '../../src/schemas/stage.js';
import type { QualityClass, QualityIssue } from './types.js';

// A flow declaring more than this many contract aliases pays one issue per
// alias over the budget. Aliases are sometimes load-bearing (write-only
// block-reuse umbrellas), so the budget is generous; the signal flags only
// genuinely alias-heavy seams, the widening smell the M8 gate guards against.
export const EXCESS_ALIAS_BUDGET = 6;

// A work step that carries no evidence requirements asserts nothing about what
// it must produce. The canonical work stages whose absence (when undeclared) is
// a deficiency.
const GUARDED_WORK_STAGES = ['act', 'verify', 'review'] as const;

export function collectFlowQualityIssues(
  schematic: FlowSchematic,
  compiled?: CompiledFlow,
): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const stagesPresent = new Set(schematic.items.map((item) => item.stage));
  const policy = schematic.stage_path_policy;
  const declaredOmits = new Set(policy?.mode === 'partial' ? policy.omits : []);

  // single-step-flow — a one-item flow is the degenerate "one big step" shape
  // with no decomposition at all.
  if (schematic.items.length === 1) {
    issues.push({
      key: 'single-step-flow',
      message: `flow '${schematic.id}' has a single step; the work is not decomposed`,
    });
  }

  // undeclared-missing-{act,verify,review} — a canonical work stage is absent
  // AND the schematic does not declare it an intentional omit. A flow that
  // genuinely skips a stage (Explore omits act/verify/review) records it in
  // stage_path_policy.omits and pays nothing here.
  for (const stage of GUARDED_WORK_STAGES) {
    if (!stagesPresent.has(stage) && !declaredOmits.has(stage)) {
      issues.push({
        key: `undeclared-missing-${stage}` as QualityClass,
        message: `flow '${schematic.id}' has no '${stage}' stage and does not declare it an intentional omit`,
      });
    }
  }

  // partial-spine-without-rationale — a partial spine whose rationale is missing
  // or too short to explain the omission. The assembler enforces this, so it
  // fires only on a hand-authored or mutated schematic.
  if (policy?.mode === 'partial') {
    const rationale = policy.rationale ?? '';
    if (rationale.length < PARTIAL_SPINE_RATIONALE_MIN_LENGTH) {
      issues.push({
        key: 'partial-spine-without-rationale',
        message: `flow '${schematic.id}' omits ${policy.omits.join(', ')} but its rationale is shorter than the ${PARTIAL_SPINE_RATIONALE_MIN_LENGTH}-char minimum`,
      });
    }
  }

  for (const item of schematic.items) {
    const itemId = item.id as unknown as string;

    // work-step-without-skill-slots — a relay (worker) step that declares no
    // equipment. This is the gap the equipment resolver closes.
    if (item.execution.kind === 'relay' && item.skill_slots.length === 0) {
      issues.push({
        key: 'work-step-without-skill-slots',
        item_id: itemId,
        message: `relay step '${itemId}' declares no skill_slots; its worker gets no declared equipment`,
      });
    }

    // empty-evidence-requirements — a step that requires no evidence asserts
    // nothing about what it must produce.
    if (item.evidence_requirements.length === 0) {
      issues.push({
        key: 'empty-evidence-requirements',
        item_id: itemId,
        message: `step '${itemId}' declares no evidence_requirements`,
      });
    }
  }

  // excess-contract-aliases — one issue per alias beyond the budget. Each over-
  // budget alias is a distinct widening of the seam.
  schematic.contract_aliases.forEach((alias, index) => {
    if (index >= EXCESS_ALIAS_BUDGET) {
      issues.push({
        key: 'excess-contract-aliases',
        message: `contract alias #${index + 1} (${alias.generic} -> ${alias.actual}) exceeds the ${EXCESS_ALIAS_BUDGET}-alias budget`,
      });
    }
  });

  // no-primary-result-binding — the compiled flow has no derived
  // runtime_surface.primary_result, so its terminal outcome is not bound to a
  // result report. Only checkable once the schematic has compiled.
  if (compiled !== undefined && compiled.runtime_surface?.primary_result === undefined) {
    issues.push({
      key: 'no-primary-result-binding',
      message: `compiled flow '${compiled.id}' has no runtime_surface.primary_result; its terminal outcome binds to no result report`,
    });
  }

  return issues;
}
