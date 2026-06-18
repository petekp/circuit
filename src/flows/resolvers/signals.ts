// Resolver #0 — task signals (the NL-to-signals reader).
//
// The custom-flow seam used to be task-BLIND: it threw the description away and
// hardcoded surface_area:'small'/risk:'low', so the only shape it could ever
// emit was build's spine (folded or full). This resolver READS the one-line task
// description into the coarse signals the assembler actually needs: which
// archetype FAMILY the task belongs to, how much surface it touches, and how
// risky it is. The signals it derives are the same axes the hand-authored flows
// were shaped around, so picking a family from them lets the assembler
// instantiate a task-appropriate shape instead of always reaching for build.
//
// Engine boundary: this stays cleanly OUTSIDE the engine. It is pure string
// classification over public vocabulary — no engine dependency, no IO, no model
// call. The cue lists are exported data so the report and tests can cite them and
// so the vocabulary rides the data, not engine code.
//
// Deterministic by construction: the same description always yields the same
// signals. That determinism is a pre-registered acceptance gate (the breadth
// harness generates N=10 per task and requires identical shapes every time).

// The archetype families the assembler can instantiate. Each maps to a
// registered contract family (build.*, fix.*, explainer.*, explore.*, review.*,
// prototype.*) so the generated flow passes the fail-closed catalog gates.
export type ArchetypeFamily = 'editorial' | 'fix' | 'review' | 'research' | 'prototype' | 'build';

export type SurfaceArea = 'small' | 'medium' | 'large';
export type Risk = 'low' | 'medium' | 'high';

export interface AssemblySignals {
  // The raw description, kept verbatim so the assembler can stamp it as the
  // generated flow's purpose (the old seam already did this).
  readonly summary: string;
  readonly surface_area: SurfaceArea;
  readonly risk: Risk;
  readonly family: ArchetypeFamily;
  // A coarse subject label lifted from the task (auth, billing, ui, ...), or null
  // when none is recognized. Legibility only — never a control-flow lever.
  readonly domain: string | null;
  // The operator explicitly asked for the full decomposed spine. Passed through
  // to the structure resolver for the build family; recorded for the rest.
  readonly explicit_decompose: boolean;
  // The cues that fired, in plain English. Non-empty means the task description
  // was actually READ into a signal — this is the rubric's task-signal-used bit
  // and the trace evidence the operator sees.
  readonly signals_used: readonly string[];
}

interface CueSet {
  readonly family: ArchetypeFamily;
  // Substrings that, when present, are reliable evidence of this family's intent.
  readonly cues: readonly string[];
}

// Family cue lists, ordered by classification PRECEDENCE (first match wins).
// The order reflects how reliably each cue carries the task's actionable intent:
// fix / prototype / editorial verbs are near-unambiguous, so they win over the
// softer review / research cues that can merely precede a build. build is the
// fallthrough default — the conservative choice when no cue fires.
//
// Two cue kinds (see cueMatcher):
//   - WHOLE-WORD cues ('fix', 'audit', 'explore') match the word plus its simple
//     inflections (-s/-es/-ed/-ing) and NOTHING else: 'fix' fires on fix/fixes/
//     fixing but never inside 'fixture', 'audit' never inside 'auditorium',
//     'explore' never inside 'explorer'. This is the default and what kills the
//     derivational-collision class.
//   - STEM cues, marked with a trailing '*' ('migrat*', 'investigat*'), match
//     from a word-boundary START with no trailing anchor, so a deliberately
//     truncated stem fires across a whole inflection family ('migrat*' →
//     migration/migrating). Use only where the stem has no unwanted
//     longer-word neighbour.
// Either kind anchors the START at a word boundary, so a cue never fires mid-word
// ('hang' cannot match inside "changelog"). Cues curated to avoid common-noun
// collisions (e.g. no bare 'option', which would fire on "add an options page").
export const FAMILY_CUES: readonly CueSet[] = [
  {
    family: 'fix',
    cues: [
      'fix',
      'bug',
      'broken',
      'crash',
      'regression',
      'failing',
      'flaky',
      'repro*',
      'defect',
      'memory leak',
      'race condition',
      'deadlock',
      'hang',
      "doesn't work",
      'does not work',
      'not working',
      'misbehav*',
    ],
  },
  {
    family: 'prototype',
    cues: [
      'prototype',
      'mockup',
      'mock up',
      'mock-up',
      'proof of concept',
      'proof-of-concept',
      'wireframe',
      'visual direction',
      'design exploration',
      'experiment with the ui',
    ],
  },
  {
    family: 'editorial',
    cues: [
      'explain',
      'explanation',
      'teach',
      'tutorial',
      'walkthrough',
      'walk through',
      'interactive explainer',
      'explainer',
      'demystif*',
      'intuition for',
      'visualize how',
      'illustrate how',
    ],
  },
  {
    family: 'review',
    cues: ['review', 'audit', 'inspect', 'critique', 'assess', 'look over', 'go over the'],
  },
  {
    family: 'research',
    cues: [
      'research',
      'investigat*',
      'explore',
      'compar*',
      'evaluate option',
      'options for',
      'spike',
      'analyze',
      'analysis',
      'figure out',
      'trade-off',
      'tradeoff',
    ],
  },
];

// Surface-area cues. A large surface earns the decomposed (full-spine) build
// grain; otherwise the build family leans conservative-whole.
export const LARGE_SURFACE_CUES: readonly string[] = [
  'migrat*',
  'across every',
  'across all',
  'across the',
  'system-wide',
  'systemwide',
  'entire',
  'rewrite',
  'whole codebase',
  'end-to-end',
  'throughout',
  'every service',
  'all services',
];

export const MEDIUM_SURFACE_CUES: readonly string[] = [
  'refactor',
  'several',
  'multiple',
  'subsystem',
  'integrat*',
  'overhaul',
];

// Risk cues. High-risk subjects (auth, money, data, production) escalate risk,
// which (for the build family) also earns the decomposed grain so the full
// review + verification spine survives.
export const HIGH_RISK_CUES: readonly string[] = [
  'auth*',
  'security',
  'password',
  'credential',
  'payment',
  'billing',
  'production',
  'migrat*',
  'data loss',
  'breaking change',
  'encryption',
  'secret',
  'irreversible',
];

export const MEDIUM_RISK_CUES: readonly string[] = [
  'database',
  'schema',
  'api',
  'concurrency',
  'race',
  'performance',
  'permission',
  'access control',
];

// Coarse subject labels for legibility (operator summary + trace). Order matters
// only for which label is reported first; it never affects the shape.
const DOMAIN_CUES: readonly (readonly [string, readonly string[]])[] = [
  ['auth', ['auth*', 'login', 'password', 'credential', 'session']],
  ['billing', ['billing', 'payment', 'invoice', 'subscription', 'pricing']],
  ['data', ['database', 'schema', 'migration', 'data model', 'query']],
  ['api', ['api', 'endpoint', 'route handler', 'rest', 'graphql']],
  ['ui', ['ui', 'page', 'component', 'button', 'layout', 'hero', 'styling', 'css']],
  ['docs', ['docs', 'documentation', 'readme', 'release note', 'tutorial']],
  ['perf', ['performance', 'latency', 'throughput', 'slow', 'optimize']],
];

// The human-readable form of a cue (drops the stem '*' marker), for signals_used
// trace lines: the cue 'migrat*' is reported as "migrat".
export function cueLabel(cue: string): string {
  return cue.endsWith('*') ? cue.slice(0, -1) : cue;
}

// Compiled matchers, cached per cue. Every cue anchors its START at a word
// boundary, so a cue never fires mid-word ('hang' cannot match inside
// "changelog" — no boundary before the 'h'). The trailing anchor differs by kind:
//   - STEM cue ('migrat*'): no trailing anchor, so the truncated stem fires
//     across its whole inflection family (migration/migrating).
//   - WHOLE-WORD cue ('fix'): a trailing boundary that permits only simple
//     inflectional suffixes (-s/-es/-ed/-ing). This matches fix/fixes/fixing but
//     NOT 'fixture', 'audit' but not 'auditorium', 'explore' but not 'explorer' —
//     the derivational-noun collision class a bare start-anchor would let through.
const cueMatchers = new Map<string, RegExp>();
function cueMatcher(cue: string): RegExp {
  const cached = cueMatchers.get(cue);
  if (cached !== undefined) return cached;
  const isStem = cue.endsWith('*');
  const literal = isStem ? cue.slice(0, -1) : cue;
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matcher = isStem
    ? new RegExp(`\\b${escaped}`)
    : new RegExp(`\\b${escaped}(?:s|es|ed|ing)?\\b`);
  cueMatchers.set(cue, matcher);
  return matcher;
}

function firstMatchingCue(haystack: string, cues: readonly string[]): string | undefined {
  return cues.find((cue) => cueMatcher(cue).test(haystack));
}

function classifyFamily(text: string): { family: ArchetypeFamily; cue: string | undefined } {
  for (const { family, cues } of FAMILY_CUES) {
    const cue = firstMatchingCue(text, cues);
    if (cue !== undefined) return { family, cue };
  }
  return { family: 'build', cue: undefined };
}

function classifySurface(text: string): { surface: SurfaceArea; cue: string | undefined } {
  const large = firstMatchingCue(text, LARGE_SURFACE_CUES);
  if (large !== undefined) return { surface: 'large', cue: large };
  const medium = firstMatchingCue(text, MEDIUM_SURFACE_CUES);
  if (medium !== undefined) return { surface: 'medium', cue: medium };
  return { surface: 'small', cue: undefined };
}

function classifyRisk(text: string): { risk: Risk; cue: string | undefined } {
  const high = firstMatchingCue(text, HIGH_RISK_CUES);
  if (high !== undefined) return { risk: 'high', cue: high };
  const medium = firstMatchingCue(text, MEDIUM_RISK_CUES);
  if (medium !== undefined) return { risk: 'medium', cue: medium };
  return { risk: 'low', cue: undefined };
}

function classifyDomain(text: string): string | null {
  for (const [label, cues] of DOMAIN_CUES) {
    if (firstMatchingCue(text, cues) !== undefined) return label;
  }
  return null;
}

// Read a one-line task description into the assembler's signals. Deterministic,
// pure, lowercase-normalized substring classification.
export function extractAssemblySignals(
  description: string,
  options: { readonly explicit_decompose?: boolean } = {},
): AssemblySignals {
  const text = ` ${description.toLowerCase().trim()} `;
  const used: string[] = [];

  const { family, cue: familyCue } = classifyFamily(text);
  if (familyCue !== undefined) used.push(`family:${family} (matched "${cueLabel(familyCue)}")`);

  const { surface, cue: surfaceCue } = classifySurface(text);
  if (surfaceCue !== undefined) {
    used.push(`surface:${surface} (matched "${cueLabel(surfaceCue)}")`);
  }

  const { risk, cue: riskCue } = classifyRisk(text);
  if (riskCue !== undefined) used.push(`risk:${risk} (matched "${cueLabel(riskCue)}")`);

  const domain = classifyDomain(text);
  if (domain !== null) used.push(`domain:${domain}`);

  return {
    summary: description,
    surface_area: surface,
    risk,
    family,
    domain,
    explicit_decompose: options.explicit_decompose === true,
    signals_used: used,
  };
}
