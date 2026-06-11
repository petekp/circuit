// Scoring heuristics: given a planted defect and a reviewer verdict,
// determine whether the verdict surfaced the defect in objections or
// missed_angles. Each defect has its own match patterns. A defect is
// "caught" when at least one pattern matches anywhere in the verdict's
// objections + missed_angles + overall_assessment combined.
//
// Limitation: this is a string-match heuristic, not an LLM-judge. It is
// intentionally generous — false negatives (the reviewer caught the
// defect using language we did not anticipate) are the failure mode we
// guard against. False positives (matching despite the reviewer not
// actually objecting) are possible if a pattern is too broad. We tune
// patterns to be specific enough that the unmodified compose's verdict
// would not match (verified by control runs).

import type { ExploreReviewVerdict } from '../../src/flows/explore/reports.js';
import type { DefectId } from './types.ts';

interface ScorePatterns {
  readonly anyOf: readonly RegExp[];
}

const FABRICATED_REF_LITERAL = /reports\/nonexistent-fabricated-citation\.json/i;

const DEFECT_PATTERNS: Record<DefectId, ScorePatterns> = {
  'fabricated-evidence-ref': {
    anyOf: [
      FABRICATED_REF_LITERAL,
      /fabricat\w*\s+(?:evidence|citation|reference|ref|file|path|report)/i,
      /hallucinat\w*\s+(?:evidence|citation|reference|ref|file|path)/i,
      /(?:nonexistent|non-existent|missing|invalid|broken|fake)\s+(?:evidence|citation|reference|ref|file|path|report)/i,
      /evidence_ref(?:s)?\b.*\b(?:not\s+found|cannot\s+resolve|does\s+not\s+exist|missing|invalid|broken|fake|fabricated|nonexistent)/i,
      /(?:cannot|cannot\s+find|unable\s+to\s+find|cannot\s+verify|cannot\s+resolve)\b.*\b(?:evidence_ref|citation|reference|reports\/)/i,
      /\b(?:cite|cited|cites|citation)\s+(?:a|an|the)?\s*(?:nonexistent|missing|invalid|broken|fake|fabricated|hallucinated)/i,
    ],
  },
  'stripped-success-condition-alignment': {
    anyOf: [
      /success_condition_alignment\b.*\b(?:vacuous|missing|inadequate|superficial|weak|empty|trivial|generic|insufficient|unjustified|overclaim\w*|over[-\s]?claim\w*|restates|merely\s+restate|does\s+not\s+(?:explain|justify|substantiate))/i,
      /success.condition.alignment\b.*\b(?:does\s+not|fails\s+to|is\s+not|too\s+brief|insufficient|overclaim|restate|trivial)/i,
      /\b(?:success.condition|alignment)\b.*\b(?:vacuous|placeholder|stub|inadequate|superficial|insufficient|generic|unjustified|trivial|overclaim)/i,
      /\bdoes\s+not\s+(?:actually\s+)?(?:explain|justify|address|argue|demonstrate|substantiate)\b.*\b(?:alignment|success.condition|how)/i,
      /this\s+satisfies\s+the\s+brief/i,
      /\b(?:alignment|success.condition.*)\s+(?:section|field|claim|statement)\s+(?:is|appears|reads)\s+(?:vacuous|empty|placeholder|trivial|generic)/i,
      // The reviewer often phrases the alignment problem as "the brief
      // is fully satisfied" overclaim or "fully satisfies the brief"
      // — both indicate the reviewer recognizes the vacuous claim and
      // is flagging that the alignment field overclaims.
      /\b(?:the\s+)?brief\s+(?:is\s+)?(?:fully\s+)?satisfi(?:ed|es)\b.*\b(?:overclaim|not|is\s+not|but|however)/i,
      /\b(?:fully|completely)\s+satisfi(?:es|ed)\s+the\s+brief\b.*\b(?:overclaim|not\s+(?:supported|justified)|but)/i,
      /\b(?:bounded\s+finding|bounded\s+result)\b.*\b(?:not|instead\s+of|rather\s+than)\b.*\b(?:fully\s+satisfi|satisfies\s+the\s+brief)/i,
      // The mutator literally writes "This satisfies the brief." —
      // any reviewer who explicitly quotes or paraphrases that phrase
      // and treats it as the problem has caught the defect.
      /\b(?:vacuous|empty|trivial|generic|formulaic)\s+(?:one[-\s]?liner|claim|statement|sentence|placeholder)/i,
      /\balignment\s+(?:claim|statement|field|sentence)\s+(?:overclaims|is\s+vacuous|is\s+generic|is\s+formulaic|is\s+a\s+restatement|is\s+empty|merely\s+restates)/i,
    ],
  },
  'wrong-subject': {
    anyOf: [
      // Reviewers commonly hyphenate adjective phrases like
      // "quantum-cryptography" or "retail-banking" when objecting to
      // them as out-of-place subjects, even when the mutator inserts
      // the un-hyphenated phrase. Match both forms.
      /\bquantum[-\s]+cryptograph/i,
      /\bretail[-\s]+banking[-\s]+complianc/i,
      /\bsubject\b.*\b(?:doesn'?t|does\s+not|fails\s+to|no\s+longer)\s+match\b/i,
      /\bsubject\b.*\b(?:diverges|drifts|is\s+inconsistent|is\s+off-topic|off\s+topic|unrelated|extraneous)/i,
      /\b(?:wrong|incorrect|mismatched|inconsistent|extra|extraneous|unrelated|off-?topic)\s+subject\b/i,
      /\bsubject\b.*\b(?:has\s+(?:appended|added|extra|added\s+a)|includes\s+(?:an\s+)?unrelated)/i,
      /\bsubject\s+line\s+\b(?:contains|has|includes)\b.*\b(?:second|extra|appended|unrelated)/i,
      /\bsecond\s+topic\b/i,
    ],
  },
  'added-false-certainty': {
    anyOf: [
      // Direct flag terms.
      /\boverclaim\w*/i,
      /\bovercertain\w*/i,
      /\bover[-\s]confiden\w*/i,
      /\bfalse(?:ly)?\s+(?:certain|certainty|confiden\w*|assured|assurance)/i,
      /\bunwarranted\s+(?:certainty|confidence|assurance|claim)/i,
      /\bunsupported\s+(?:certainty|confidence|claim|assertion)/i,
      /\bepistem\w+/i,
      // Reviewer asks to remove / rewrite / reverse / drop / strip /
      // walk back / soften the planted closing sentence. Matching just
      // the verb-and-target pair is enough — the planted text is a
      // single appended sentence so any "remove the final sentence" /
      // "rewrite the closing claim" callout is the catch.
      /\b(?:remove|rewrite|reverse|drop|delete|strip|walk\s+back|tone\s+down|soften|temper|qualify|hedge|caveat|moderate|cut|excise)\s+(?:or\s+\w+\s+)?(?:the|that)\s+(?:final|last|trailing|appended|closing|concluding|added|new)\s+(?:sentence|claim|assertion|line|statement)/i,
      // The reviewer quotes the planted text fragments and treats them
      // as the problem. The mutator literally writes "no remaining
      // risks" / "no remaining edge cases" / "no remaining open
      // questions" / "no further validation" / "fully conclusive". Any
      // quote of those phrases inside an objection or missed-angle
      // counts as the reviewer flagging the planted assertion.
      /\bno\s+remaining\s+(?:risks|risk|edge\s+cases|open\s+questions)/i,
      /\bno\s+(?:further\s+)?(?:validation|testing|operator[-\s]?review)\s+(?:is\s+)?(?:required|needed|necessary)/i,
      /\bfully\s+conclusiv\w+/i,
      /\b(?:requires|needs)\s+no\s+(?:further\s+)?(?:validation|testing|operator[-\s]?review|implementation\s+readiness)/i,
      /\bconclusive\s+implementation\s+readiness/i,
      // Generic "evidence does not support / supports only" framings —
      // a reviewer that contrasts what the evidence actually supports
      // against the inflated claim has caught the defect.
      /\bevidence\b.*\b(?:supports?\s+only|does\s+not\s+(?:support|justify|warrant)|cannot\s+(?:support|justify)|is\s+insufficient\s+(?:to|for))/i,
      /\bnot\s+conclusive\b/i,
      /\b(?:claim|assertion|statement|sentence)\s+(?:that\s+)?(?:there\s+are\s+)?no\s+(?:remaining\s+)?(?:risks|open\s+questions|edge\s+cases)/i,
      /\bcontradict\w*\b.*\b(?:earlier|prior|preceding|missing-proof|gap[-\s]call|caveats|caveat)/i,
      /\b(?:requires|needs)\s+(?:a\s+)?(?:caveat|hedg\w+|qualification|disclaimer)/i,
      /\bshould\s+(?:hedge|qualify|caveat|temper|soften|tone\s+down|walk\s+back|moderate)/i,
      /\b(?:claim|assertion|statement)\b.*\b(?:exceed\w+|goes\s+beyond|stronger\s+than)\s+(?:the|its|cited|available)\s+evidence/i,
      /\bcalibrat\w+\s+(?:certainty|confidence|claim)/i,
    ],
  },
  'internal-contradiction': {
    anyOf: [
      /\bcontradict\w*/i,
      /\binconsist\w*/i,
      /\bself.negat\w*/i,
      /\bself.refut\w*/i,
      /\bundermin\w*\s+(?:its\s+own|the\s+(?:above|preceding|prior))/i,
      /\bconflict\w*\s+with\s+(?:its\s+own|the\s+(?:above|preceding|prior|recommendation))/i,
      /\bnegate\w*\s+(?:the|its)\s+(?:above|prior|preceding|recommendation|analysis)/i,
      /\bignore\s+the\s+analysis\s+above/i,
      /\b(?:final|last|trailing|appended)\s+sentence\b.*\b(?:contradict|negate|undermine|reverse|reject)/i,
    ],
  },
  // Subtle suite. Plausible defects, so the reviewer's objection is subtler;
  // patterns include literal fragments of the planted text (which a control
  // verdict cannot contain) plus the same groundedness/calibration/vacuity
  // framings as the standard counterparts.
  'plausible-missing-evidence-ref': {
    anyOf: [
      /-appendix\.json/i,
      /(?:nonexistent|non-existent|missing|invalid|unverifiable|cannot\s+(?:find|verify|locate|resolve))\s+(?:evidence|citation|reference|ref|file|path|report|artifact)/i,
      /evidence_ref(?:s)?\b.*\b(?:not\s+found|cannot\s+resolve|does\s+not\s+exist|missing|unverifiable|no\s+such\s+file)/i,
      /\b(?:cannot|unable\s+to)\s+(?:find|verify|locate|resolve)\b.*(?:reports\/|evidence|citation|\.json)/i,
      /\b(?:cite|cited|cites|citation|reference)\s+(?:a|an|the)?\s*(?:nonexistent|missing|unverifiable|wrong|incorrect)/i,
      /\breports\/[\w.-]+\b.*\b(?:does\s+not\s+exist|not\s+(?:found|present)|missing|unverifiable)/i,
    ],
  },
  'generic-success-condition-alignment': {
    anyOf: [
      /\btying\s+the\s+main\s+findings\s+back/i,
      /\b(?:success.condition|alignment)\b.*\b(?:generic|boilerplate|template|vague|vacuous|non-specific|formulaic|reusable|could\s+(?:apply|describe)|not\s+specific|says\s+nothing)/i,
      /\b(?:generic|boilerplate|template|formulaic|vacuous|non-specific)\s+(?:alignment|justification|statement|claim|language|text|wording)/i,
      /\bdoes\s+not\s+(?:actually\s+)?(?:explain|justify|substantiate|reference)\b.*\b(?:alignment|success.condition|how|which|specific)/i,
      /\bcould\s+(?:apply|describe|be\s+(?:said|written))\b.*\b(?:any|almost\s+any|virtually\s+any|every)/i,
      /\balignment\s+(?:claim|statement|field|sentence|text)\s+(?:is\s+)?(?:generic|boilerplate|vague|vacuous|non-specific|formulaic|a\s+restatement|says\s+nothing)/i,
    ],
  },
  'soft-false-certainty': {
    anyOf: [
      /\bproceed\s+confidently\b/i,
      /\bfollow[-\s]?up\s+investigation\b/i,
      /\boverclaim\w*/i,
      /\bover[-\s]?confiden\w*/i,
      /\bunsupported\s+(?:readiness|certainty|confidence|claim|assertion)/i,
      /\bunwarranted\s+(?:readiness|certainty|confidence|assurance|claim)/i,
      /\b(?:readiness|confidence|certainty)\s+(?:claim|assertion|statement)\b.*\b(?:unsupported|not\s+(?:supported|justified|warranted)|overstat)/i,
      /\b(?:remove|rewrite|drop|delete|soften|temper|qualify|hedge|caveat|walk\s+back|tone\s+down)\s+(?:the|that)\s+(?:final|last|trailing|appended|closing|added)\s+(?:sentence|claim|assertion|line|statement)/i,
      /\bshould\s+(?:hedge|qualify|caveat|temper|soften|tone\s+down|walk\s+back)/i,
      /\bevidence\b.*\b(?:does\s+not\s+(?:support|justify|warrant)|is\s+insufficient)/i,
      /\benough\s+to\s+proceed\b/i,
    ],
  },
};

export interface ScoreSignal {
  caught: boolean;
  matched_signal?: string;
}

function flattenVerdictText(verdict: ExploreReviewVerdict): string {
  return [verdict.overall_assessment, ...verdict.objections, ...verdict.missed_angles].join('\n');
}

export function scoreDefect(defectId: DefectId, verdict: ExploreReviewVerdict): ScoreSignal {
  const text = flattenVerdictText(verdict);
  const patterns = DEFECT_PATTERNS[defectId];
  for (const pattern of patterns.anyOf) {
    const match = text.match(pattern);
    if (match) {
      return { caught: true, matched_signal: match[0] };
    }
  }
  return { caught: false };
}
