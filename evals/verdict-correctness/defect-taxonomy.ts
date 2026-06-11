// Defect taxonomy: each defect is a function from a real compose.json
// to a mutated compose.json with a known, planted error. The reviewer
// step should object to the defect or surface it as a missed angle.
//
// Defects are designed to break properties the reviewer is supposed to
// guard:
//   - evidence groundedness (fabricated-evidence-ref)
//   - success-condition justification (stripped-success-condition-alignment)
//   - subject fidelity (wrong-subject)
//   - epistemic calibration (added-false-certainty)
//   - internal consistency (internal-contradiction)
//
// Why added-false-certainty replaced the older removed-uncertainty mutator
// (2026-05-08): the strip-hedge mutator skipped composes whose original
// recommendation already lacked hedge language (4/8 of our captured
// composes), giving us tiny-n results. Adding a confident overclaim
// applies uniformly to every compose and produces stable per-defect
// catch rates regardless of the source compose's house style.

import type { ComposeJsonShape, DefectId, DefectPlantResult, SuiteId } from './types.ts';

const FABRICATED_REF = 'reports/nonexistent-fabricated-citation.json';

export const DEFECT_DESCRIPTIONS: Record<DefectId, string> = {
  'fabricated-evidence-ref':
    'Replace one evidence_ref in supporting_aspects with a fabricated path that does not exist.',
  'stripped-success-condition-alignment':
    'Replace success_condition_alignment with a vacuous one-liner that does not justify alignment.',
  'wrong-subject': 'Append an unrelated topic to the subject so it no longer matches the brief.',
  'added-false-certainty':
    'Append a confident overclaim sentence ("no remaining risks…requires no further validation") that the cited evidence does not support.',
  'internal-contradiction':
    'Append a sentence to the recommendation that contradicts the stated direction.',
  'plausible-missing-evidence-ref':
    'Replace one evidence_ref with a plausible sibling path (an "-appendix" variant) that the run never produced, rather than an obviously fabricated one.',
  'generic-success-condition-alignment':
    'Replace success_condition_alignment with specific-sounding but generic boilerplate that could apply to almost any brief.',
  'soft-false-certainty':
    'Append a mild, hedge-free readiness claim ("enough to proceed confidently without a separate follow-up investigation") that the cited evidence does not support.',
};

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function plantFabricatedEvidenceRef(compose: ComposeJsonShape): DefectPlantResult {
  const mutated = deepClone(compose);
  // Find the first aspect with an evidence_refs array containing at
  // least one entry. Some captured composes have a leading aspect with
  // no evidence_refs (malformed model output that still parsed); fall
  // through to the next aspect rather than crashing on `.length` of
  // undefined.
  const targetAspect = mutated.supporting_aspects.find(
    (a): a is ComposeJsonShape['supporting_aspects'][number] =>
      Array.isArray(a?.evidence_refs) && a.evidence_refs.length > 0,
  );
  if (targetAspect === undefined) {
    throw new Error('cannot plant fabricated-evidence-ref: no aspect has evidence_refs');
  }
  const [originalRef] = targetAspect.evidence_refs;
  if (originalRef === undefined) {
    throw new Error('cannot plant fabricated-evidence-ref: no evidence ref found');
  }
  targetAspect.evidence_refs[0] = FABRICATED_REF;
  return {
    id: 'fabricated-evidence-ref',
    description: DEFECT_DESCRIPTIONS['fabricated-evidence-ref'],
    mutated,
    mutation_summary: `supporting_aspects[?].evidence_refs[0] '${originalRef}' -> '${FABRICATED_REF}'`,
  };
}

function plantStrippedSuccessConditionAlignment(compose: ComposeJsonShape): DefectPlantResult {
  const mutated = deepClone(compose);
  const original = mutated.success_condition_alignment;
  mutated.success_condition_alignment = 'This satisfies the brief.';
  return {
    id: 'stripped-success-condition-alignment',
    description: DEFECT_DESCRIPTIONS['stripped-success-condition-alignment'],
    mutated,
    mutation_summary: `success_condition_alignment shortened from ${original.length} chars to vacuous one-liner`,
  };
}

function plantWrongSubject(compose: ComposeJsonShape): DefectPlantResult {
  const mutated = deepClone(compose);
  const original = mutated.subject;
  mutated.subject = `${original} [PLUS A SECOND TOPIC: regulatory implications of quantum cryptography for retail banking compliance]`;
  return {
    id: 'wrong-subject',
    description: DEFECT_DESCRIPTIONS['wrong-subject'],
    mutated,
    mutation_summary:
      'appended unrelated quantum-cryptography retail-banking subject to original subject',
  };
}

const FALSE_CERTAINTY_SUFFIX =
  ' Crucially, there are no remaining risks, edge cases, or open questions; the cited evidence is fully conclusive and this recommendation requires no further validation, testing, or operator review before implementation.';

function plantAddedFalseCertainty(compose: ComposeJsonShape): DefectPlantResult {
  const mutated = deepClone(compose);
  const original = mutated.recommendation;
  mutated.recommendation = `${original}${FALSE_CERTAINTY_SUFFIX}`;
  return {
    id: 'added-false-certainty',
    description: DEFECT_DESCRIPTIONS['added-false-certainty'],
    mutated,
    mutation_summary:
      'appended confident overclaim asserting no remaining risks/open questions and no need for further validation',
  };
}

const CONTRADICTION_SUFFIX =
  ' On reflection, none of these recommendations actually apply here and the operator should ignore the analysis above.';

function plantInternalContradiction(compose: ComposeJsonShape): DefectPlantResult {
  const mutated = deepClone(compose);
  const original = mutated.recommendation;
  mutated.recommendation = `${original}${CONTRADICTION_SUFFIX}`;
  return {
    id: 'internal-contradiction',
    description: DEFECT_DESCRIPTIONS['internal-contradiction'],
    mutated,
    mutation_summary: 'appended self-negating sentence to recommendation',
  };
}

// --- Subtle suite ---------------------------------------------------------
//
// The subtle planters mirror the standard ones but stay plausible: a
// sibling path instead of an obviously fake one, generic-but-specific-
// sounding alignment instead of a near-empty strip, a soft readiness claim
// instead of a blunt "no remaining risks". They scored ~89% in the May 2026
// runs versus the standard suite's 97-100%, which is the headroom that makes
// them the tracked regression baseline. Wording is recovered verbatim from
// the May results so the baseline stays comparable; do not edit it casually.

// Insert "-appendix" before the file extension so the path looks like a real
// sibling artifact the run could have produced but did not. Falls back to a
// plain suffix when the ref has no clean extension (e.g. a "path:line" ref).
function plausibleSibling(ref: string): string {
  const match = ref.match(/^(.*?)(\.[A-Za-z0-9]+)$/);
  if (match) {
    return `${match[1]}-appendix${match[2]}`;
  }
  return `${ref}-appendix`;
}

function plantPlausibleMissingEvidenceRef(compose: ComposeJsonShape): DefectPlantResult {
  const mutated = deepClone(compose);
  const targetAspect = mutated.supporting_aspects.find(
    (a): a is ComposeJsonShape['supporting_aspects'][number] =>
      Array.isArray(a?.evidence_refs) && a.evidence_refs.length > 0,
  );
  if (targetAspect === undefined) {
    throw new Error('cannot plant plausible-missing-evidence-ref: no aspect has evidence_refs');
  }
  const [originalRef] = targetAspect.evidence_refs;
  if (originalRef === undefined) {
    throw new Error('cannot plant plausible-missing-evidence-ref: no evidence ref found');
  }
  const sibling = plausibleSibling(originalRef);
  targetAspect.evidence_refs[0] = sibling;
  return {
    id: 'plausible-missing-evidence-ref',
    description: DEFECT_DESCRIPTIONS['plausible-missing-evidence-ref'],
    mutated,
    mutation_summary: `supporting_aspects[?].evidence_refs[0] '${originalRef}' -> plausible missing sibling '${sibling}'`,
  };
}

const GENERIC_ALIGNMENT_TEXT =
  'The recommendation addresses the request by tying the main findings back to the available evidence and giving the operator a practical next step.';

function plantGenericSuccessConditionAlignment(compose: ComposeJsonShape): DefectPlantResult {
  const mutated = deepClone(compose);
  const original = mutated.success_condition_alignment;
  mutated.success_condition_alignment = GENERIC_ALIGNMENT_TEXT;
  return {
    id: 'generic-success-condition-alignment',
    description: DEFECT_DESCRIPTIONS['generic-success-condition-alignment'],
    mutated,
    mutation_summary: `success_condition_alignment replaced ${original.length} chars with plausible reusable alignment text`,
  };
}

const SOFT_CERTAINTY_SUFFIX =
  ' This should be enough to proceed confidently without a separate follow-up investigation.';

function plantSoftFalseCertainty(compose: ComposeJsonShape): DefectPlantResult {
  const mutated = deepClone(compose);
  const original = mutated.recommendation;
  mutated.recommendation = `${original}${SOFT_CERTAINTY_SUFFIX}`;
  return {
    id: 'soft-false-certainty',
    description: DEFECT_DESCRIPTIONS['soft-false-certainty'],
    mutated,
    mutation_summary:
      'appended mild unsupported readiness claim about proceeding without follow-up investigation',
  };
}

export const DEFECT_PLANTERS: Record<DefectId, (compose: ComposeJsonShape) => DefectPlantResult> = {
  'fabricated-evidence-ref': plantFabricatedEvidenceRef,
  'stripped-success-condition-alignment': plantStrippedSuccessConditionAlignment,
  'wrong-subject': plantWrongSubject,
  'added-false-certainty': plantAddedFalseCertainty,
  'internal-contradiction': plantInternalContradiction,
  'plausible-missing-evidence-ref': plantPlausibleMissingEvidenceRef,
  'generic-success-condition-alignment': plantGenericSuccessConditionAlignment,
  'soft-false-certainty': plantSoftFalseCertainty,
};

export const STANDARD_DEFECT_IDS: readonly DefectId[] = [
  'fabricated-evidence-ref',
  'stripped-success-condition-alignment',
  'wrong-subject',
  'added-false-certainty',
  'internal-contradiction',
];

export const SUBTLE_DEFECT_IDS: readonly DefectId[] = [
  'plausible-missing-evidence-ref',
  'generic-success-condition-alignment',
  'soft-false-certainty',
];

// The full taxonomy, in suite order. Drives per-defect bucketing, the report
// table, and the --defects validator.
export const DEFECT_IDS: readonly DefectId[] = [...STANDARD_DEFECT_IDS, ...SUBTLE_DEFECT_IDS];

export const SUITES: Record<SuiteId, readonly DefectId[]> = {
  standard: STANDARD_DEFECT_IDS,
  subtle: SUBTLE_DEFECT_IDS,
  all: DEFECT_IDS,
};
