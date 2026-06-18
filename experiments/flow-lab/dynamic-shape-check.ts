// OFFLINE dynamic-assembly SHAPE CHECK — throwaway measurement spike.
//
// Question: does Circuit's dynamic NL->flow path produce a viable
// explainer-SHAPED flow? We generate the flow N times for the same explainer
// task, OFFLINE (assemble + compile, never execute), and score the distribution
// against the hand-authored explainer reference (src/flows/explainer).
//
// The ONLY path cleanly invocable for an arbitrary natural-language task is
// `circuit create` (src/cli/create.ts -> assembleCustomFlow). This harness
// reproduces that path EXACTLY (clone buildAssemblySpec -> resolveStructure with
// create's hardcoded small/low context -> applyStructure -> assembleFlowSchematic
// -> compile) so the measured bytes equal what the shipped CLI emits. The CLI
// cross-check (run separately) diffs its circuit.json against these bytes.
//
// Pure + offline: no model, no network, no fs writes from this module. Run with
//   npx tsx experiments/flow-lab/dynamic-shape-check.ts
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { FlowSchematicAssemblySpec } from '../../src/flows/assemble-flow-schematic.js';
import { assembleFlowSchematic } from '../../src/flows/assemble-flow-schematic.js';
import { buildAssemblySpec } from '../../src/flows/build/assembly-spec.js';
import { compileSchematicToCompiledFlow } from '../../src/flows/compile-schematic-to-flow.js';
import { applyStructure, resolveStructure } from '../../src/flows/resolvers/structure.js';
import { FlowSchematic } from '../../src/schemas/flow-schematic.js';
import { collectFlowQualityIssues } from './quality.js';
import { tallyByClass } from './types.js';

// The explainer task a real operator would type. Paper choice barely affects
// shape (the path ignores task text), so we use a representative title.
const EXPLAINER_TASK =
  'build an interactive explainer website for the research paper "Attention Is All You Need"';

// The editorial features that make the explainer an explainer (not a generic
// build). Each is a structural predicate over a FlowSchematic. Overlap with this
// checklist is the meaningful shape-vs-reference signal; canonical-stage overlap
// is the trivial engine-skeleton signal.
type Schematic = ReturnType<typeof FlowSchematic.parse>;

interface ShapeMetrics {
  readonly stepCount: number;
  readonly canonicalStages: string[];
  readonly checkpointSteps: number;
  readonly fanoutSteps: number;
  readonly subRunSteps: number;
  readonly relaySteps: number;
  readonly verifySteps: number;
  readonly reviewSteps: number;
  readonly composeSteps: number;
  readonly spine: Array<{ id: string; stage: string; kind: string }>;
  // Editorial-feature checklist (presence bits).
  readonly editorial: {
    digestStage: boolean; // a dedicated analyze/digest step
    ideateStep: boolean; // a plan-stage step that drafts >1 candidate concept
    tournamentFanout: boolean; // a fanout (one advocate per concept)
    hardeningPass: boolean; // an adversarial relay over survivors
    pickCheckpoint: boolean; // an operator PICK among candidates
    specStep: boolean; // a build-law / house-style spec step
    subRunBuild: boolean; // build delegated to a child run
    signoffCheckpoint: boolean; // an operator fidelity SIGN-OFF before close
  };
  readonly editorialScore: number; // count of editorial bits set
}

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

function executionKind(item: Schematic['items'][number]): string {
  return (item.execution as { kind?: string } | undefined)?.kind ?? 'unknown';
}

// Detect editorial features structurally. We read the schematic shape, not step
// ids, so the detector is fair to a dynamic flow that used different names: a
// fanout in the plan stage IS a tournament regardless of label, a sub-run IS a
// delegated build, a second checkpoint after verify IS a sign-off, etc.
function detectEditorial(items: Schematic['items']): ShapeMetrics['editorial'] {
  const checkpointIdx: number[] = [];
  const fanoutIdx: number[] = [];
  const subRunIdx: number[] = [];
  let analyzeStep = false;
  let planComposeCount = 0;
  let planRelayCount = 0;
  let verifyIdx = -1;
  items.forEach((item, i) => {
    const kind = executionKind(item);
    const stage = item.stage;
    if (kind === 'checkpoint') checkpointIdx.push(i);
    if (kind === 'fanout') fanoutIdx.push(i);
    if (kind === 'sub-run') subRunIdx.push(i);
    if (stage === 'analyze') analyzeStep = true;
    if (stage === 'plan' && kind === 'compose') planComposeCount += 1;
    if (stage === 'plan' && kind === 'relay') planRelayCount += 1;
    if (stage === 'verify') verifyIdx = i;
  });
  const tournamentFanout = fanoutIdx.some((i) => items[i]?.stage === 'plan');
  return {
    // A digest is a dedicated analyze step that is NOT build's codebase-search
    // researcher relay; any analyze-stage compose/relay producing an outline.
    digestStage: analyzeStep,
    // Ideation: the plan stage carries MORE than one authored step (build's plan
    // is a single compose; the explainer plan has 5). >=2 plan composes, or a
    // plan compose alongside a plan fanout/relay, signals real ideation.
    ideateStep: planComposeCount >= 2 || (planComposeCount >= 1 && (tournamentFanout || planRelayCount > 0)),
    tournamentFanout,
    // Hardening: a relay in the plan stage (adversarial pass over candidates).
    hardeningPass: planRelayCount > 0,
    // PICK: a checkpoint inside the plan stage (choose among candidates), as
    // opposed to build's single frame-stage brief checkpoint.
    pickCheckpoint: checkpointIdx.some((i) => items[i]?.stage === 'plan'),
    // Spec: a plan-stage compose that follows a pick checkpoint (build law). We
    // approximate with >=2 plan composes (ideas + spec) which build never has.
    specStep: planComposeCount >= 2,
    subRunBuild: subRunIdx.length > 0,
    // SIGN-OFF: a checkpoint at/after the verify step (fidelity gate before
    // close), distinct from a frame-stage brief checkpoint.
    signoffCheckpoint: checkpointIdx.some((i) => i > verifyIdx && verifyIdx >= 0),
  };
}

function shapeMetricsOf(schematic: Schematic): ShapeMetrics {
  const items = schematic.items;
  const canonical = new Set<string>();
  let checkpointSteps = 0;
  let fanoutSteps = 0;
  let subRunSteps = 0;
  let relaySteps = 0;
  let verifySteps = 0;
  let reviewSteps = 0;
  let composeSteps = 0;
  const spine: Array<{ id: string; stage: string; kind: string }> = [];
  for (const item of items) {
    const kind = executionKind(item);
    canonical.add(item.stage);
    if (kind === 'checkpoint') checkpointSteps += 1;
    if (kind === 'fanout') fanoutSteps += 1;
    if (kind === 'sub-run') subRunSteps += 1;
    if (kind === 'relay') relaySteps += 1;
    if (kind === 'compose') composeSteps += 1;
    if (item.stage === 'verify') verifySteps += 1;
    if (item.stage === 'review') reviewSteps += 1;
    spine.push({ id: item.id as unknown as string, stage: item.stage, kind });
  }
  const editorial = detectEditorial(items);
  const editorialScore = EDITORIAL_KEYS.reduce((n, k) => n + (editorial[k] ? 1 : 0), 0);
  return {
    stepCount: items.length,
    canonicalStages: [...canonical],
    checkpointSteps,
    fanoutSteps,
    subRunSteps,
    relaySteps,
    verifySteps,
    reviewSteps,
    composeSteps,
    spine,
    editorial,
    editorialScore,
  };
}

// Reproduce `circuit create`'s assembleCustomFlow EXACTLY. `decompose` is the
// only operator lever; with no flags the path defaults to `whole`.
function generateDynamicFlow(
  task: string,
  decompose: boolean,
): { schematic: Schematic; compiledJson: string; compileOk: boolean; compileError?: string; primaryResultBound: boolean } {
  const seed: FlowSchematicAssemblySpec = {
    ...buildAssemblySpec,
    id: 'explainer-dynamic',
    purpose: task,
  };
  // create.ts structureTaskFromCreate: summary=description, surface_area='small',
  // risk='low'; --decompose -> explicit_decompose. Task TEXT is otherwise unused.
  const resolution = resolveStructure({
    summary: task,
    surface_area: 'small',
    risk: 'low',
    ...(decompose ? { explicit_decompose: true } : {}),
  });
  const grained = applyStructure(seed, resolution);
  const schematic = assembleFlowSchematic({ ...grained, id: 'explainer-dynamic' });
  try {
    const compiled = compileSchematicToCompiledFlow(schematic);
    if (compiled.kind !== 'single') {
      return {
        schematic,
        compiledJson: '',
        compileOk: false,
        compileError: `unexpected '${compiled.kind}' package`,
        primaryResultBound: false,
      };
    }
    const flow = compiled.flow;
    const json = JSON.stringify(flow);
    const primaryResultBound =
      (flow as { runtime_surface?: { primary_result?: unknown } }).runtime_surface?.primary_result !==
      undefined;
    return { schematic, compiledJson: json, compileOk: true, primaryResultBound };
  } catch (err) {
    return {
      schematic,
      compiledJson: '',
      compileOk: false,
      compileError: err instanceof Error ? err.message : String(err),
      primaryResultBound: false,
    };
  }
}

function hash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

function scoreSchematic(schematic: Schematic) {
  const issues = collectFlowQualityIssues(schematic);
  return { issueCount: issues.length, tally: tallyByClass(issues), issues: issues.map((i) => i.key) };
}

// Canonical-stage Jaccard (the trivial engine-skeleton overlap) and editorial
// overlap (the meaningful shape overlap).
function overlap(a: ShapeMetrics, ref: ShapeMetrics) {
  const sa = new Set(a.canonicalStages);
  const sr = new Set(ref.canonicalStages);
  const inter = [...sa].filter((x) => sr.has(x)).length;
  const union = new Set([...sa, ...sr]).size;
  const stageJaccard = union === 0 ? 0 : inter / union;
  const editorialOverlap =
    ref.editorialScore === 0
      ? 0
      : EDITORIAL_KEYS.filter((k) => a.editorial[k] && ref.editorial[k]).length / ref.editorialScore;
  return { stageJaccard: Number(stageJaccard.toFixed(3)), editorialOverlap: Number(editorialOverlap.toFixed(3)) };
}

function main(): void {
  // --- Reference: the hand-authored explainer schematic ---
  const refRaw = JSON.parse(readFileSync('src/flows/explainer/schematic.json', 'utf8'));
  const refSchematic = FlowSchematic.parse(refRaw);
  const refMetrics = shapeMetricsOf(refSchematic);
  const refScore = scoreSchematic(refSchematic);

  // --- N=10 draws of the dynamic default (whole), plus the decomposed variant ---
  const N = 10;
  const wholeDraws = Array.from({ length: N }, () => generateDynamicFlow(EXPLAINER_TASK, false));
  const decomposed = generateDynamicFlow(EXPLAINER_TASK, true);

  const wholeHashes = wholeDraws.map((d) => hash(d.compiledJson));
  const distinctWholeHashes = new Set(wholeHashes);

  const wholeMetrics = shapeMetricsOf(wholeDraws[0]!.schematic);
  const wholeScore = scoreSchematic(wholeDraws[0]!.schematic);
  const decMetrics = shapeMetricsOf(decomposed.schematic);
  const decScore = scoreSchematic(decomposed.schematic);

  const out = {
    task: EXPLAINER_TASK,
    model_spend_usd: 0,
    note: 'dynamic path is deterministic + offline (no model); task text does not influence shape',
    reference: {
      id: refSchematic.id,
      metrics: refMetrics,
      quality: refScore,
    },
    dynamic: {
      whole: {
        grain: 'whole (default, no flags)',
        draws: N,
        distinct_compiled_hashes: distinctWholeHashes.size,
        deterministic: distinctWholeHashes.size === 1,
        compiled_hash: wholeHashes[0],
        compile_ok: wholeDraws.every((d) => d.compileOk),
        primary_result_bound: wholeDraws[0]!.primaryResultBound,
        metrics: wholeMetrics,
        quality: wholeScore,
        overlap_vs_reference: overlap(wholeMetrics, refMetrics),
      },
      decomposed: {
        grain: 'decomposed (--decompose)',
        compiled_hash: hash(decomposed.compiledJson),
        compile_ok: decomposed.compileOk,
        primary_result_bound: decomposed.primaryResultBound,
        metrics: decMetrics,
        quality: decScore,
        overlap_vs_reference: overlap(decMetrics, refMetrics),
      },
    },
    reachable_shapes: 2,
  };
  console.log(JSON.stringify(out, null, 2));
}

main();
