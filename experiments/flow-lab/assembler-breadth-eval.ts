// OFFLINE breadth eval — Phase 3 of the task-aware assembler rebuild.
//
// Scientific spine: docs/ideas/assembler-rebuild-preregistration.md (LOCKED
// before this file existed). This harness implements EXACTLY the §3 rubric and
// applies the §5 decision rule. It does NOT execute anything (no model, no
// network, no fs writes) — it generates each pre-registered task's flow with the
// NEW assembler N=10 times, scores it structurally, compares to the OLD stub and
// the hand-authored references, and prints the verdict.
//
//   npx tsx experiments/flow-lab/assembler-breadth-eval.ts
//
// Two pre-registered predicates turned out mis-specified against the real flows
// (a true false positive, anticipated by §8). They are DISCLOSED + DISCOUNTED
// here, never silently rewritten:
//   1. The rubric requires fix to have a `plan` stage. The hand-authored fix has
//      NONE — it goes frame -> diagnose(analyze) -> act -> verify -> close. So
//      the `plan` predicate scores fix 5/6 on the literal rubric; the fix
//      REFERENCE itself also scores 5/6. We report both the literal fraction and
//      the reference-relative fraction (discounting the over-spec).
//   2. The rubric requires review to have a "review relay (audit)". The
//      hand-authored review does its audit as an `analyze/relay` (stage=analyze,
//      not review). The detector recognizes an audit relay in EITHER the review
//      or analyze stage — faithful to the structural intent ("a relay that
//      audits"), not the stage label.
import { createHash } from 'node:crypto';

import { assembleFlowSchematic } from '../../src/flows/assemble-flow-schematic.js';
import { buildAssemblySpec } from '../../src/flows/build/assembly-spec.js';
import { compileSchematicToCompiledFlow } from '../../src/flows/compile-schematic-to-flow.js';
import { explainerFlowData } from '../../src/flows/explainer/data.js';
import { exploreAssemblySpec } from '../../src/flows/explore/assembly-spec.js';
import { fixAssemblySpec } from '../../src/flows/fix/assembly-spec.js';
import { prototypeAssemblySpec } from '../../src/flows/prototype/assembly-spec.js';
import { resolveArchetype } from '../../src/flows/resolvers/archetype.js';
import { type AssemblySignals, extractAssemblySignals } from '../../src/flows/resolvers/signals.js';
import { applyStructure, resolveStructure } from '../../src/flows/resolvers/structure.js';
import { reviewAssemblySpec } from '../../src/flows/review/assembly-spec.js';
import { collectSchematicCatalogIssues } from '../../src/flows/schematic-catalog-check.js';
import { FlowSchematic } from '../../src/schemas/flow-schematic.js';

type Schematic = ReturnType<typeof FlowSchematic.parse>;
type Item = Schematic['items'][number];
type ExpectedFamily = 'editorial' | 'fix' | 'review' | 'research' | 'prototype' | 'build';
type ExpectedGrain = 'whole' | 'decomposed' | null;

// ---------------------------------------------------------------------------
// The pre-registered task set (§2). The assembler does not see these columns.
// ---------------------------------------------------------------------------
interface Task {
  readonly id: string;
  readonly text: string;
  readonly expectedFamily: ExpectedFamily;
  readonly expectedGrain: ExpectedGrain;
  readonly hasReference: boolean;
}

const TASKS: readonly Task[] = [
  {
    id: 'explainer-paper',
    text: 'build an interactive explainer website for the research paper "Attention Is All You Need"',
    expectedFamily: 'editorial',
    expectedGrain: null,
    hasReference: true,
  },
  {
    id: 'feature-darkmode',
    text: "add a dark-mode toggle to the settings page that persists the user's choice",
    expectedFamily: 'build',
    expectedGrain: 'whole',
    hasReference: true,
  },
  {
    id: 'fix-race',
    text: 'fix the race condition causing duplicate webhook deliveries under retry',
    expectedFamily: 'fix',
    expectedGrain: null,
    hasReference: true,
  },
  {
    id: 'research-state',
    text: 'research and compare state-management options for our React app and recommend one',
    expectedFamily: 'research',
    expectedGrain: null,
    hasReference: true,
  },
  {
    id: 'review-auth',
    text: 'review the authentication module for security and correctness issues',
    expectedFamily: 'review',
    expectedGrain: null,
    hasReference: true,
  },
  {
    id: 'migrate-billing',
    text: 'migrate the entire billing system from Stripe Charges to PaymentIntents across the codebase',
    expectedFamily: 'build',
    expectedGrain: 'decomposed',
    hasReference: true,
  },
  {
    id: 'tweak-rename',
    text: 'rename the count variable to total in the request logger',
    expectedFamily: 'build',
    expectedGrain: 'whole',
    hasReference: true,
  },
  {
    id: 'proto-hero',
    text: 'prototype three landing-page hero layouts and pick the best one',
    expectedFamily: 'prototype',
    expectedGrain: null,
    hasReference: true,
  },
];

// ---------------------------------------------------------------------------
// Structural primitives (stage + execution kind — never step id).
// ---------------------------------------------------------------------------
function executionKind(item: Item): string {
  return (item.execution as { kind?: string } | undefined)?.kind ?? 'unknown';
}

function spineOf(items: readonly Item[]): Array<{ stage: string; kind: string }> {
  return items.map((it) => ({ stage: it.stage, kind: executionKind(it) }));
}

// The structural signature collapses text-only differences: two flows with the
// same stage/kind sequence ARE the same shape (so build-T2 === build-T7, which a
// full-JSON hash would wrongly call distinct because the purpose text differs).
function structuralSignature(items: readonly Item[]): string {
  return spineOf(items)
    .map((s) => `${s.stage}/${s.kind}`)
    .join(' ');
}

function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Per-family feature detector (§3.2), structural. Returns the required-feature
// presence map and the forbidden-feature presence map for the EXPECTED family.
// ---------------------------------------------------------------------------
interface FeatureScore {
  readonly required: Record<string, boolean>;
  readonly forbidden: Record<string, boolean>;
  readonly fraction: number; // present / total required
  readonly forbiddenCount: number;
  readonly note?: string;
}

function detectFeatures(
  family: ExpectedFamily,
  grain: ExpectedGrain,
  items: readonly Item[],
): FeatureScore {
  const kinds = items.map(executionKind);
  const stages: string[] = items.map((it) => it.stage);
  const has = (stage: string) => stages.includes(stage);
  const stageKind = (stage: string, kind: string) =>
    items.some((it, i) => it.stage === stage && kinds[i] === kind);
  const planCompose = items.filter((it, i) => it.stage === 'plan' && kinds[i] === 'compose').length;
  const checkpointIdx = items
    .map((it, i) => ({ i, kind: kinds[i], stage: it.stage }))
    .filter((x) => x.kind === 'checkpoint');
  const fanoutAny = kinds.includes('fanout');
  const subRunAny = kinds.includes('sub-run');
  const verifyIdx = items.reduce((acc, it, i) => (it.stage === 'verify' ? i : acc), -1);

  let required: Record<string, boolean>;
  let forbidden: Record<string, boolean>;
  let note: string | undefined;

  switch (family) {
    case 'editorial':
      required = {
        'digest/analyze': has('analyze'),
        'plan-stage ideation compose': planCompose >= 1,
        'plan-stage fanout (tournament)': items.some(
          (it, i) => it.stage === 'plan' && kinds[i] === 'fanout',
        ),
        'plan-stage pick checkpoint': checkpointIdx.some((x) => x.stage === 'plan'),
        'spec compose (2nd plan compose)': planCompose >= 2,
        'sub-run (delegated build)': subRunAny,
        verify: has('verify'),
        'post-verify sign-off checkpoint':
          verifyIdx >= 0 && checkpointIdx.some((x) => x.i > verifyIdx),
        'close compose': stageKind('close', 'compose'),
      };
      forbidden = {};
      break;
    case 'fix':
      required = {
        frame: has('frame'),
        'diagnose/analyze': has('analyze'),
        // DISCLOSED over-spec: the hand-authored fix has NO plan stage.
        'plan (rubric over-spec — fix has none)': has('plan'),
        'act relay': stageKind('act', 'relay'),
        verify: has('verify'),
        close: has('close'),
      };
      forbidden = {
        'plan-stage fanout': items.some((it, i) => it.stage === 'plan' && kinds[i] === 'fanout'),
        'sub-run': subRunAny,
        'second operator checkpoint': checkpointIdx.length >= 2,
      };
      note = 'plan predicate over-specifies fix; reference fix also scores 5/6.';
      break;
    case 'research':
      required = {
        // The hand-authored research (explore) family rides the analyze + plan
        // stages — there is no 'research' canonical stage. Analyze emphasis is
        // the gather/read signal.
        'gather/analyze emphasis': has('analyze'),
        'synthesizing close compose': stageKind('close', 'compose'),
      };
      forbidden = {
        'act implementation relay': stageKind('act', 'relay'),
        'verification-of-a-build': has('verify'),
      };
      break;
    case 'review':
      required = {
        // DISCLOSED: review's audit is an analyze/relay, not review/relay.
        'audit relay (analyze|review stage)': items.some(
          (it, i) => (it.stage === 'review' || it.stage === 'analyze') && kinds[i] === 'relay',
        ),
        'close verdict': has('close'),
      };
      forbidden = {
        'act implementation relay': stageKind('act', 'relay'),
        'build sub-run': subRunAny,
      };
      break;
    case 'prototype':
      required = {
        'fanout (variants)': fanoutAny,
        'checkpoint or variant-evidence': checkpointIdx.length >= 1,
        close: has('close'),
      };
      forbidden = {};
      break;
    default: {
      // build — base spine + grain-conditional folding.
      const base: Record<string, boolean> = {
        frame: has('frame'),
        plan: has('plan'),
        'act relay': stageKind('act', 'relay'),
        verify: has('verify'),
        close: has('close'),
      };
      if (grain === 'decomposed') {
        base['analyze present (decomposed)'] = has('analyze');
        base['review present (decomposed)'] = has('review');
      } else {
        base['analyze folded out (whole)'] = !has('analyze');
        base['review folded out (whole)'] = !has('review');
      }
      required = base;
      forbidden = {
        'plan-stage fanout': items.some((it, i) => it.stage === 'plan' && kinds[i] === 'fanout'),
        'sub-run': subRunAny,
      };
      break;
    }
  }

  const reqVals = Object.values(required);
  const fraction = reqVals.length === 0 ? 0 : reqVals.filter(Boolean).length / reqVals.length;
  const forbiddenCount = Object.values(forbidden).filter(Boolean).length;
  const base = { required, forbidden, fraction: Number(fraction.toFixed(3)), forbiddenCount };
  return note === undefined ? base : { ...base, note };
}

// ---------------------------------------------------------------------------
// Editorial 8-bit overlap (§3.6 / §5 E), the SAME detector the gate harness used
// (dynamic-shape-check.ts), inlined so this file runs standalone and stays
// directly comparable to the gate's baseline (E ≈ 0 for the OLD stub).
// ---------------------------------------------------------------------------
const EDITORIAL_KEYS = [
  'digestStage',
  'ideateStep',
  'tournamentFanout',
  'hardeningPass',
  'pickCheckpoint',
  'specStep',
  'subRunBuild',
  'signoffCheckpoint',
] as const;
type EditorialBits = Record<(typeof EDITORIAL_KEYS)[number], boolean>;

function detectEditorialBits(items: readonly Item[]): EditorialBits {
  const kinds = items.map(executionKind);
  const checkpointIdx: number[] = [];
  let analyzeStep = false;
  let planComposeCount = 0;
  let planRelayCount = 0;
  let verifyIdx = -1;
  let fanoutInPlan = false;
  let subRun = false;
  items.forEach((item, i) => {
    const kind = kinds[i];
    if (kind === 'checkpoint') checkpointIdx.push(i);
    if (kind === 'fanout' && item.stage === 'plan') fanoutInPlan = true;
    if (kind === 'sub-run') subRun = true;
    if (item.stage === 'analyze') analyzeStep = true;
    if (item.stage === 'plan' && kind === 'compose') planComposeCount += 1;
    if (item.stage === 'plan' && kind === 'relay') planRelayCount += 1;
    if (item.stage === 'verify') verifyIdx = i;
  });
  return {
    digestStage: analyzeStep,
    ideateStep:
      planComposeCount >= 2 || (planComposeCount >= 1 && (fanoutInPlan || planRelayCount > 0)),
    tournamentFanout: fanoutInPlan,
    hardeningPass: planRelayCount > 0,
    pickCheckpoint: checkpointIdx.some((i) => items[i]?.stage === 'plan'),
    specStep: planComposeCount >= 2,
    subRunBuild: subRun,
    signoffCheckpoint: checkpointIdx.some((i) => i > verifyIdx && verifyIdx >= 0),
  };
}

function editorialOverlap(gen: readonly Item[], ref: readonly Item[]): number {
  const g = detectEditorialBits(gen);
  const r = detectEditorialBits(ref);
  const refScore = EDITORIAL_KEYS.filter((k) => r[k]).length;
  if (refScore === 0) return 0;
  return Number((EDITORIAL_KEYS.filter((k) => g[k] && r[k]).length / refScore).toFixed(3));
}

// Feature overlap (§3.6): fraction of the reference's REQUIRED family features
// that the generated flow also has. The reference has all of them by definition,
// so this is "how many of the reference's features did we reproduce".
function featureOverlap(
  family: ExpectedFamily,
  grain: ExpectedGrain,
  gen: readonly Item[],
  ref: readonly Item[],
): number {
  const refFeat = detectFeatures(family, grain, ref).required;
  const genFeat = detectFeatures(family, grain, gen).required;
  const refKeys = Object.keys(refFeat).filter((k) => refFeat[k]);
  if (refKeys.length === 0) return 0;
  const both = refKeys.filter((k) => genFeat[k]).length;
  return Number((both / refKeys.length).toFixed(3));
}

// ---------------------------------------------------------------------------
// Compile + validity (§3.3). Per-mode aware: a per-mode package is a VALID
// compiled package (the rubric's "single package" wording predates the per-mode
// realization; disclosed). Validity = compiles + catalog-gate-clean + every mode
// binds primary_result.
// ---------------------------------------------------------------------------
interface CompileFacts {
  readonly ok: boolean;
  readonly kind: 'single' | 'per-mode' | 'error';
  readonly modes: string[];
  readonly catalogIssues: number;
  readonly primaryResultBoundAllModes: boolean;
  readonly compiledHash: string;
  readonly error?: string;
}

function primaryResultBound(flow: unknown): boolean {
  return (
    (flow as { runtime_surface?: { primary_result?: unknown } } | undefined)?.runtime_surface
      ?.primary_result !== undefined
  );
}

function compileFacts(schematic: Schematic): CompileFacts {
  const catalogIssues = collectSchematicCatalogIssues(schematic).length;
  try {
    const compiled = compileSchematicToCompiledFlow(schematic);
    if (compiled.kind === 'single') {
      return {
        ok: catalogIssues === 0 && primaryResultBound(compiled.flow),
        kind: 'single',
        modes: ['(single)'],
        catalogIssues,
        primaryResultBoundAllModes: primaryResultBound(compiled.flow),
        compiledHash: sha(JSON.stringify(compiled.flow)),
      };
    }
    const modeNames = [...compiled.flows.keys()].sort();
    const allBound = modeNames.every((m) => primaryResultBound(compiled.flows.get(m)));
    const canonical = modeNames
      .map((m) => `${m}:${JSON.stringify(compiled.flows.get(m))}`)
      .join('\n');
    return {
      ok: catalogIssues === 0 && allBound,
      kind: 'per-mode',
      modes: modeNames,
      catalogIssues,
      primaryResultBoundAllModes: allBound,
      compiledHash: sha(canonical),
    };
  } catch (err) {
    return {
      ok: false,
      kind: 'error',
      modes: [],
      catalogIssues,
      primaryResultBoundAllModes: false,
      compiledHash: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// The NEW assembler path, reproduced EXACTLY as src/cli/create.ts runs it:
//   extractAssemblySignals(text) -> resolveArchetype(slug, signals) -> compile.
// ---------------------------------------------------------------------------
interface NewGen {
  readonly signals: AssemblySignals;
  readonly family: string;
  readonly composition: string; // 'grain:whole' | 'grain:decomposed' | 'instantiated'
  readonly items: readonly Item[];
  readonly structuralSig: string;
  readonly compile: CompileFacts;
}

function generateNew(task: Task): NewGen {
  const signals = extractAssemblySignals(task.text);
  const resolution = resolveArchetype(task.id, signals);
  const items = resolution.schematic.items;
  return {
    signals,
    family: resolution.family,
    composition: resolution.composition,
    items,
    structuralSig: structuralSignature(items),
    compile: compileFacts(resolution.schematic),
  };
}

// The OLD stub path, reproduced EXACTLY as the gate harness did: build family,
// hardcoded small/low, task text -> slug + purpose only. No flags -> whole.
function generateOld(task: Task): NewGen {
  const resolution = resolveStructure({ summary: task.text, surface_area: 'small', risk: 'low' });
  const grained = applyStructure(
    { ...buildAssemblySpec, id: task.id, purpose: task.text },
    resolution,
  );
  const schematic = assembleFlowSchematic({ ...grained, id: task.id });
  const items = schematic.items;
  return {
    signals: {
      summary: task.text,
      surface_area: 'small',
      risk: 'low',
      family: 'build',
      domain: null,
      explicit_decompose: false,
      signals_used: [],
    },
    family: 'build',
    composition: `grain:${resolution.choice}`,
    items,
    structuralSig: structuralSignature(items),
    compile: compileFacts(schematic),
  };
}

// ---------------------------------------------------------------------------
// Hand-authored references for the overlap measure (§3.6).
// ---------------------------------------------------------------------------
function referenceItems(task: Task): readonly Item[] | null {
  if (!task.hasReference) return null;
  switch (task.expectedFamily) {
    case 'editorial':
      return FlowSchematic.parse(JSON.parse(JSON.stringify(explainerFlowData.schematic))).items;
    case 'fix':
      return assembleFlowSchematic({ ...fixAssemblySpec }).items;
    case 'research':
      return assembleFlowSchematic({ ...exploreAssemblySpec }).items;
    case 'review':
      return assembleFlowSchematic({ ...reviewAssemblySpec }).items;
    case 'prototype':
      return assembleFlowSchematic({ ...prototypeAssemblySpec }).items;
    default: {
      // build — at the grain the task implies.
      const res = resolveStructure({
        summary: task.text,
        surface_area: task.expectedGrain === 'decomposed' ? 'large' : 'small',
        risk: task.expectedGrain === 'decomposed' ? 'high' : 'low',
      });
      return assembleFlowSchematic(
        applyStructure({ ...buildAssemblySpec, id: 'ref', purpose: 'ref' }, res),
      ).items;
    }
  }
}

// ---------------------------------------------------------------------------
// Score one task end to end.
// ---------------------------------------------------------------------------
interface TaskResult {
  readonly id: string;
  readonly expectedFamily: ExpectedFamily;
  readonly expectedGrain: ExpectedGrain;
  readonly new: {
    readonly family: string;
    readonly grain: string;
    readonly signalsUsed: readonly string[];
    readonly signalUsed: boolean;
    readonly valid: boolean;
    readonly compileKind: string;
    readonly modes: string[];
    readonly catalogIssues: number;
    readonly features: FeatureScore;
    readonly deterministic: boolean;
    readonly distinctStructuralSigs: number;
    readonly distinctCompiledHashes: number;
    readonly structuralSig: string;
    readonly compiledHash: string;
    readonly editorialOverlap: number | null;
    readonly featureOverlap: number | null;
    readonly pass: boolean;
  };
  readonly old: {
    readonly family: string;
    readonly grain: string;
    readonly signalUsed: boolean;
    readonly valid: boolean;
    readonly features: FeatureScore;
    readonly editorialOverlap: number | null;
    readonly pass: boolean;
  };
}

function grainMatches(task: Task, composition: string): boolean {
  if (task.expectedGrain === null) return true; // no grain axis for this family
  return composition === `grain:${task.expectedGrain}`;
}

function scoreArm(
  task: Task,
  gen: NewGen,
  expectedFamilyForFeatures: ExpectedFamily,
): {
  signalUsed: boolean;
  valid: boolean;
  features: FeatureScore;
  editorialOverlap: number | null;
  pass: boolean;
} {
  const signalUsed = gen.family === task.expectedFamily && grainMatches(task, gen.composition);
  const valid = gen.compile.ok;
  // Features are scored against the EXPECTED family's checklist (the bar the task
  // should meet), so a misclassified arm is correctly penalized.
  const features = detectFeatures(expectedFamilyForFeatures, task.expectedGrain, gen.items);
  const ref = referenceItems(task);
  const eOverlap =
    task.expectedFamily === 'editorial' && ref ? editorialOverlap(gen.items, ref) : null;
  const shapeOk = features.fraction >= 0.75 && features.forbiddenCount === 0;
  const pass = valid && signalUsed && shapeOk; // determinism added by caller (N=10)
  return { signalUsed, valid, features, editorialOverlap: eOverlap, pass };
}

function scoreTask(task: Task): TaskResult {
  const N = 10;
  const draws = Array.from({ length: N }, () => generateNew(task));
  const first = draws[0];
  if (first === undefined) throw new Error('no draws');
  const distinctSigs = new Set(draws.map((d) => d.structuralSig));
  const distinctHashes = new Set(draws.map((d) => d.compile.compiledHash));
  const deterministic = distinctSigs.size === 1 && distinctHashes.size === 1;

  const newArm = scoreArm(task, first, task.expectedFamily);
  const ref = referenceItems(task);
  const fOverlap = ref
    ? featureOverlap(task.expectedFamily, task.expectedGrain, first.items, ref)
    : null;

  const old = generateOld(task);
  const oldArm = scoreArm(task, old, task.expectedFamily);

  return {
    id: task.id,
    expectedFamily: task.expectedFamily,
    expectedGrain: task.expectedGrain,
    new: {
      family: first.family,
      grain: first.composition,
      signalsUsed: first.signals.signals_used,
      signalUsed: newArm.signalUsed,
      valid: newArm.valid,
      compileKind: first.compile.kind,
      modes: first.compile.modes,
      catalogIssues: first.compile.catalogIssues,
      features: newArm.features,
      deterministic,
      distinctStructuralSigs: distinctSigs.size,
      distinctCompiledHashes: distinctHashes.size,
      structuralSig: first.structuralSig,
      compiledHash: first.compile.compiledHash,
      editorialOverlap: newArm.editorialOverlap,
      featureOverlap: fOverlap,
      pass: newArm.pass && deterministic,
    },
    old: {
      family: old.family,
      grain: old.composition,
      signalUsed: oldArm.signalUsed,
      valid: oldArm.valid,
      features: oldArm.features,
      editorialOverlap: oldArm.editorialOverlap,
      pass: oldArm.pass, // old is deterministic too, but it fails earlier gates
    },
  };
}

// ---------------------------------------------------------------------------
// Run + apply the §5 decision rule.
// ---------------------------------------------------------------------------
function main(): void {
  const results = TASKS.map(scoreTask);

  // §3.4 diversity — distinct shapes across the 8 tasks. Report BOTH the honest
  // structural count (collapses text-only twins like T2/T7) and the literal
  // full-compiled-hash count (text-inflated). The decision rule uses structural.
  const newStructuralShapes = new Set(results.map((r) => r.new.structuralSig)).size;
  const newCompiledShapes = new Set(results.map((r) => r.new.compiledHash)).size;
  const oldStructuralShapes = new Set(TASKS.map((t) => generateOld(t).structuralSig)).size;

  // §5 inputs.
  const P = results.filter((r) => r.new.pass).length;
  const editorial = results.find((r) => r.id === 'explainer-paper');
  const E = editorial?.new.editorialOverlap ?? 0;
  const D = newStructuralShapes;
  const V = results.filter((r) => r.new.valid).length;

  let tier: string;
  if (P >= 7 && E >= 0.6 && D >= 5 && V === 8) tier = 'VIABLE';
  else if (P >= 5 && P <= 6 && E >= 0.35 && D >= 4 && V === 8) tier = 'PROMISING';
  else tier = 'RESEARCH-GRADE-NOT-READY';
  if (V < 8) tier = 'RESEARCH-GRADE-NOT-READY'; // validity override (§5)

  const out = {
    harness: 'assembler-breadth-eval',
    pre_registration: 'docs/ideas/assembler-rebuild-preregistration.md',
    model_spend_usd: 0,
    note: 'offline + deterministic (no model, no network, no execution)',
    disclosed_rubric_corrections: [
      'fix: rubric requires a `plan` stage; hand-authored fix has none (frame->diagnose->act->verify->close). fix scores 5/6 literal; the fix REFERENCE also scores 5/6, so the generated fix is at the reference bar. Discounted: fix shape is appropriate.',
      'review: rubric requires a "review relay"; hand-authored review audits via an analyze/relay. Detector accepts an audit relay in review OR analyze stage (structural intent).',
      'validity: rubric §3.3 says "returns a single package"; per-mode families (fix/research/prototype) return a valid per-mode package. Validity = compiles + catalog-clean + every mode binds primary_result.',
    ],
    decision: {
      tier,
      inputs: { P, E, D_structural: D, D_compiled_literal: newCompiledShapes, V },
      thresholds: {
        VIABLE: 'P>=7 & E>=0.60 & D>=5 & V=8',
        PROMISING: 'P in 5..6 & E>=0.35 & D>=4 & V=8',
      },
    },
    diversity: {
      new_distinct_structural_shapes: newStructuralShapes,
      new_distinct_compiled_hashes_literal: newCompiledShapes,
      old_distinct_structural_shapes: oldStructuralShapes,
    },
    honesty_caveat:
      'High reference/feature overlap reflects INSTANTIATION/REUSE of proven family seeds (Phase 1 line), not genuine generation from typed blocks (Phase 2 question). Diversity ACROSS families is real (the assembler reads the task and picks family + grain); within-family novelty is instantiation.',
    tasks: results,
  };
  console.log(JSON.stringify(out, null, 2));

  // Compact human summary to stderr so stdout stays a clean JSON artifact.
  const line = (r: TaskResult) =>
    `${r.id.padEnd(18)} exp=${r.expectedFamily}/${r.expectedGrain ?? '-'} ` +
    `NEW fam=${r.new.family}/${r.new.grain} sig=${r.new.signalUsed ? 'Y' : 'n'} ` +
    `valid=${r.new.valid ? 'Y' : 'n'} feat=${r.new.features.fraction}(${r.new.features.forbiddenCount}!) ` +
    `det=${r.new.deterministic ? 'Y' : 'n'} PASS=${r.new.pass ? 'YES' : 'no'} | ` +
    `OLD fam=${r.old.family}/${r.old.grain} sig=${r.old.signalUsed ? 'Y' : 'n'} pass=${r.old.pass ? 'Y' : 'n'}`;
  process.stderr.write(`\n${results.map(line).join('\n')}\n\n`);
  process.stderr.write(
    `DECISION: ${tier}  (P=${P}/8, E=${E}, D=${D} structural / ${newCompiledShapes} literal, V=${V}/8)\n` +
      `OLD baseline: distinct shapes=${oldStructuralShapes}, passes=${results.filter((r) => r.old.pass).length}/8\n`,
  );
}

main();
