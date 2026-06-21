// Flow-shape composition (experimental, default-OFF): the eval predicates.
//
// These compute the locked rubric axes from the pre-registration
// (docs/ideas/flow-composition-preregistration.md):
//   - VALID    — run the composed spec through the SAME fail-closed path the
//                engine runs (assemble → compile → catalog gate) and bind a
//                primary result. Validity is the engine's verdict, never the
//                harness's: this module only reports what the real gates do.
//   - NOVEL    — the (block, executionKind) sequence is not any built-in's.
//   - SENSIBLE — contract closure, intent closure, no orphan, goal-reaching.
//
// Pure analysis over the assembled schematic; no model spend. Used by the Phase
// 0 make-or-break test and the Phase 1 breadth harness alike.

import type { CompiledFlow as CompiledFlowValue } from '../../schemas/compiled-flow.js';
import type { FlowSchematic } from '../../schemas/flow-schematic.js';
import type { FlowSchematicAssemblySpec } from '../assemble-flow-schematic.js';
import { assembleFlowSchematic } from '../assemble-flow-schematic.js';
import { compileSchematicToCompiledFlow } from '../compile-schematic-to-flow.js';
import type { FlowDefinition } from '../flow-definition.js';
import { findCloseBuilder, resolveCloseReadPaths } from '../registries/close-writers/registry.js';
import {
  findComposeBuilder,
  resolveComposeReadPaths,
} from '../registries/compose-writers/registry.js';
import type { RuntimeIndexedFlow, RuntimeIndexedStep } from '../registries/runtime-index.js';
import {
  findVerificationWriter,
  resolveVerificationReadPaths,
} from '../registries/verification-writers/registry.js';
import { collectSchematicCatalogIssues } from '../schematic-catalog-check.js';
import { type IntentState, blockIntent } from './intent.js';

function asString(value: unknown): string {
  return value as unknown as string;
}

// A step's output is a READABLE contract — something a downstream step can read
// as typed input — only when the step writes a report_path or a result_path.
// This is the engine's own truth: the compiler's read-path resolution binds a
// reader to a producer's report_path/result_path. A checkpoint that writes only
// its request/response paths produces a routing decision, not a readable
// contract; a checkpoint that ALSO writes a report_path (the shipping build
// flow's frame-step does) produces a readable contract like any other step. So
// the predicate keys on the WRITE, never on execution.kind.
export function outputIsReadableContract(
  writes:
    | {
        readonly report_path?: unknown;
        readonly result_path?: unknown;
        readonly [key: string]: unknown;
      }
    | undefined,
): boolean {
  if (writes === undefined) return false;
  return writes.report_path !== undefined || writes.result_path !== undefined;
}

// One (block, executionKind) step, the unit of the novelty comparison.
export interface SequenceStep {
  readonly block: string;
  readonly executionKind: string;
}

export function blockSequence(schematic: FlowSchematic): readonly SequenceStep[] {
  return schematic.items.map((item) => ({
    block: asString(item.block),
    executionKind: item.execution.kind,
  }));
}

function sequenceKey(sequence: readonly SequenceStep[]): string {
  return sequence.map((step) => `${step.block}:${step.executionKind}`).join(' > ');
}

export interface ValidityVerdict {
  readonly valid: boolean;
  readonly catalogIssueCount: number;
  readonly catalogIssues: readonly string[];
  readonly compiles: boolean;
  readonly boundPrimaryResult: boolean;
  readonly primaryResultSchema?: string;
  readonly error?: string;
  // The parsed schematic, when assembly succeeded — so callers chain the other
  // predicates without re-assembling.
  readonly schematic?: FlowSchematic;
}

function extractPrimaryResult(
  compiled: ReturnType<typeof compileSchematicToCompiledFlow>,
): { schema: string } | undefined {
  const flow = compiled.kind === 'single' ? compiled.flow : [...compiled.flows.values()][0];
  const primary = flow?.runtime_surface?.primary_result;
  if (primary === undefined) return undefined;
  return { schema: asString(primary.schema_name) };
}

// Run the real gates. VALID iff: assembly + compile both succeed, the catalog
// gate returns zero issues, and the compiled flow binds a primary result.
export function evaluateValidity(spec: FlowSchematicAssemblySpec): ValidityVerdict {
  let schematic: FlowSchematic;
  try {
    schematic = assembleFlowSchematic(spec);
  } catch (error) {
    return {
      valid: false,
      catalogIssueCount: -1,
      catalogIssues: [],
      compiles: false,
      boundPrimaryResult: false,
      error: `assemble: ${errorMessage(error)}`,
    };
  }

  const catalogIssues = collectSchematicCatalogIssues(schematic).map((issue) => issue.message);

  let primary: { schema: string } | undefined;
  let compiles = true;
  let compileError: string | undefined;
  try {
    primary = extractPrimaryResult(compileSchematicToCompiledFlow(schematic));
  } catch (error) {
    compiles = false;
    compileError = `compile: ${errorMessage(error)}`;
  }

  const valid = compiles && catalogIssues.length === 0 && primary !== undefined;

  return {
    valid,
    catalogIssueCount: catalogIssues.length,
    catalogIssues,
    compiles,
    boundPrimaryResult: primary !== undefined,
    ...(primary === undefined ? {} : { primaryResultSchema: primary.schema }),
    ...(compileError === undefined ? {} : { error: compileError }),
    schematic,
  };
}

// One step that would abort the run at its writer: a compose or close step whose
// builder declares a REQUIRED upstream read with no producer in the flow.
export interface RunnabilityAbort {
  readonly stepId: string;
  readonly schema: string;
  readonly reason: string;
}

export interface RunnabilityVerdict {
  // True iff no checked writer would abort. A non-compiling spec is not runnable.
  readonly runnable: boolean;
  readonly aborts: readonly RunnabilityAbort[];
  // How many compose/close writers were actually resolved (a guard against a
  // vacuous pass — a flow with zero registered writers cannot abort but also was
  // not really exercised).
  readonly checkedSteps: number;
  readonly error?: string;
}

// Present a compiled flow as the minimal runtime-index shape the read-path
// resolvers consume. A compiled step already carries `reads: string[]` and
// `writes.report: { path, schema }` — exactly what reportPathForSchemaInRuntimeFlow
// and the compose/close resolvers read — so this is an identity on the fields that
// matter. Keeping it here (a flows/ module) avoids importing the runtime/ adapter
// chain (fromCompiledFlow + buildRuntimePackageIndex), which would invert the
// engine boundary (runtime depends on flows, never the reverse). The FIDELITY test
// in composition-runnability.test.ts pins this against the engine's real
// CompiledFlow -> RuntimePackageIndex path so the shortcut cannot silently drift.
function runtimeIndexShape(flow: CompiledFlowValue): RuntimeIndexedFlow {
  return {
    id: flow.id,
    version: flow.version,
    stages: [],
    steps: flow.steps as unknown as RuntimeIndexedStep[],
  };
}

function reportSchemaOf(step: RuntimeIndexedStep): { path: string; schema: string } | undefined {
  const report = step.writes.report;
  if (typeof report !== 'object' || report === null) return undefined;
  return report;
}

// RUNNABLE — would the composed flow survive its compose/close writers, or abort
// the instant one runs? evaluateValidity proves a spec is STRUCTURALLY sound
// (assemble + compile + catalog + a bound primary result), but a compose or close
// builder also declares REQUIRED upstream reads by family schema, and the runtime
// aborts the step the moment a required read has no producer (the writer-coupling
// wall). This runs the SAME resolvers the runtime uses — resolveComposeReadPaths /
// resolveCloseReadPaths — against the compiled flow, offline, and reports every
// step that would throw. Closing the false-negative the floor was blind to.
//
// SCOPE: compose and close writers declare their reads as static `reads`
// descriptors, so they are inspectable without invocation. EVERY source-coupled
// VERIFICATION writer now does too — each writer whose loadCommands sources its
// command list from an upstream report (fix.verification reads fix.brief@v1;
// build.verification reads build.plan@v1; prototype.verification reads
// prototype.plan@v1 + artifact; pursuit.verification reads pursuit.contract@v1;
// prototype.variant-verification reads the variant aggregate + provider evidence)
// declares that source as a static `reads` descriptor, so all of them are resolved
// here. That closes the blind spot a composed verification step hit when its source
// went unwired (the live composed-arm abort), for every family the composer can
// select, not just fix/build. A verification writer with NO source coupling
// (explainer.verification — its commands are intrinsic) declares no `reads` and is
// correctly skipped: there is nothing to resolve. The
// verification-writer-source-coverage test locks that pairing so a future writer
// cannot reintroduce the silent-skip gap.
export function evaluateRunnability(spec: FlowSchematicAssemblySpec): RunnabilityVerdict {
  let schematic: FlowSchematic;
  try {
    schematic = assembleFlowSchematic(spec);
  } catch (error) {
    return {
      runnable: false,
      aborts: [],
      checkedSteps: 0,
      error: `assemble: ${errorMessage(error)}`,
    };
  }

  let compiled: ReturnType<typeof compileSchematicToCompiledFlow>;
  try {
    compiled = compileSchematicToCompiledFlow(schematic);
  } catch (error) {
    return {
      runnable: false,
      aborts: [],
      checkedSteps: 0,
      error: `compile: ${errorMessage(error)}`,
    };
  }

  const flows = compiled.kind === 'single' ? [compiled.flow] : [...compiled.flows.values()];
  const aborts: RunnabilityAbort[] = [];
  let checkedSteps = 0;
  for (const compiledFlow of flows) {
    const flow = runtimeIndexShape(compiledFlow);
    for (const step of flow.steps) {
      const report = reportSchemaOf(step);
      if (report === undefined) continue;
      const composeBuilder = findComposeBuilder(report.schema);
      const closeBuilder = findCloseBuilder(report.schema);
      const verificationBuilder = findVerificationWriter(report.schema);
      // Relay writers are not in any of these registries. A verification writer
      // that declares no `reads` (its imperative source coupling not modeled) is
      // likewise skipped — there is nothing to resolve. Skip — not abort.
      const verificationDeclaresReads =
        verificationBuilder !== undefined && verificationBuilder.reads !== undefined;
      if (
        composeBuilder === undefined &&
        closeBuilder === undefined &&
        !verificationDeclaresReads
      ) {
        continue;
      }
      checkedSteps += 1;
      try {
        if (composeBuilder !== undefined) {
          resolveComposeReadPaths(composeBuilder, flow, step as never);
        } else if (closeBuilder !== undefined) {
          resolveCloseReadPaths(closeBuilder, flow, step as never);
        } else if (verificationBuilder !== undefined) {
          resolveVerificationReadPaths(verificationBuilder, flow, step as never);
        }
      } catch (error) {
        aborts.push({ stepId: step.id, schema: report.schema, reason: errorMessage(error) });
      }
    }
  }

  return { runnable: aborts.length === 0, aborts, checkedSteps };
}

export interface NoveltyVerdict {
  readonly novel: boolean;
  readonly sequence: string;
  // The built-in flow whose sequence this equals, when not novel.
  readonly matches?: string;
  // Closest built-in by Jaccard over the (block, kind) multiset, for reporting.
  readonly closest?: { readonly flowId: string; readonly jaccard: number };
}

function multiset(sequence: readonly SequenceStep[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const step of sequence) {
    const key = `${step.block}:${step.executionKind}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function jaccard(a: Map<string, number>, b: Map<string, number>): number {
  const keys = new Set([...a.keys(), ...b.keys()]);
  let intersection = 0;
  let union = 0;
  for (const key of keys) {
    const av = a.get(key) ?? 0;
    const bv = b.get(key) ?? 0;
    intersection += Math.min(av, bv);
    union += Math.max(av, bv);
  }
  return union === 0 ? 0 : intersection / union;
}

// NOVEL iff the composed (block, executionKind) sequence equals no built-in's.
export function evaluateNovelty(
  schematic: FlowSchematic,
  definitions: readonly FlowDefinition[],
): NoveltyVerdict {
  const sequence = blockSequence(schematic);
  const key = sequenceKey(sequence);
  const composedMultiset = multiset(sequence);

  let matches: string | undefined;
  let closest: { flowId: string; jaccard: number } | undefined;
  for (const definition of definitions) {
    if (definition.id === asString(schematic.id)) continue;
    const builtinSequence = blockSequence(definition.schematic);
    if (sequenceKey(builtinSequence) === key) matches = definition.id;
    const score = jaccard(composedMultiset, multiset(builtinSequence));
    if (closest === undefined || score > closest.jaccard) {
      closest = { flowId: definition.id, jaccard: score };
    }
  }

  return {
    novel: matches === undefined,
    sequence: key,
    ...(matches === undefined ? {} : { matches }),
    ...(closest === undefined ? {} : { closest }),
  };
}

// One back-edge in the route graph: a route whose target resolves to a step at
// or before the producing step (a self-loop or an upstream loop).
export interface TopologyBackEdge {
  readonly from: string;
  readonly to: string;
  readonly route: string;
}

// A step whose routes fan out to two or more distinct forward steps (a branch).
export interface TopologyBranch {
  readonly step: string;
  readonly forwardTargets: number;
}

export interface TopologyVerdict {
  readonly stepCount: number;
  readonly backEdges: readonly TopologyBackEdge[];
  readonly branchPoints: readonly TopologyBranch[];
  readonly hasLoop: boolean;
  readonly hasBranch: boolean;
  // A canonical fingerprint of the route GRAPH, not just the step list. Two
  // flows over the same blocks but with different edges (a line vs a bounded
  // loop) get different signatures. This fills the blind spot in the locked
  // `evaluateNovelty` rubric, which compares only the (block, kind) sequence and
  // so cannot tell a loop from a line.
  readonly signature: string;
}

// Read the route graph of an assembled schematic. A route target is a graph
// edge unless it is a terminal ('@complete', '@stop', '@handoff', ...). An edge
// to a step at index <= the producer's is a back-edge (loop); a step with two or
// more distinct forward edges is a branch point. The signature folds the block
// sequence together with the loops and branches so topology-distinct flows are
// distinguishable.
export function evaluateTopology(schematic: FlowSchematic): TopologyVerdict {
  const items = schematic.items;
  const indexById = new Map<string, number>();
  items.forEach((item, i) => indexById.set(asString(item.id), i));
  const blockByIndex = items.map((item) => asString(item.block));

  const backEdges: TopologyBackEdge[] = [];
  const branchPoints: TopologyBranch[] = [];

  items.forEach((item, i) => {
    const forwardTargets = new Set<number>();
    for (const [route, target] of Object.entries(item.routes)) {
      const t = asString(target);
      if (t.startsWith('@')) continue; // terminal sink, not a graph edge
      const j = indexById.get(t);
      if (j === undefined) continue; // unresolved id — the compiler gate owns this
      if (j <= i) backEdges.push({ from: asString(item.id), to: t, route });
      else forwardTargets.add(j);
    }
    if (forwardTargets.size >= 2) {
      branchPoints.push({ step: asString(item.id), forwardTargets: forwardTargets.size });
    }
  });

  const blockOf = (id: string): string => blockByIndex[indexById.get(id) ?? -1] ?? id;
  const seqSig = items.map((item) => `${asString(item.block)}:${item.execution.kind}`).join('>');
  const loopSig = backEdges
    .map((edge) => `${blockOf(edge.from)}-${edge.route}->${blockOf(edge.to)}`)
    .sort()
    .join(',');
  const branchSig = branchPoints
    .map((branch) => `${blockOf(branch.step)}*${branch.forwardTargets}`)
    .sort()
    .join(',');
  const signature = `seq:[${seqSig}]|loops:[${loopSig}]|branches:[${branchSig}]`;

  return {
    stepCount: items.length,
    backEdges,
    branchPoints,
    hasLoop: backEdges.length > 0,
    hasBranch: branchPoints.length > 0,
    signature,
  };
}

export interface SensibilityVerdict {
  readonly sensible: boolean;
  readonly contractClosure: boolean;
  readonly intentClosure: boolean;
  readonly noOrphan: boolean;
  readonly goalReaching: boolean;
  readonly failures: readonly string[];
}

// SENSIBLE iff all four sub-checks hold over the assembled schematic.
export function evaluateSensibility(
  schematic: FlowSchematic,
  options: { readonly boundPrimaryResult: boolean },
): SensibilityVerdict {
  const failures: string[] = [];
  const initialContracts = new Set(schematic.initial_contracts.map(asString));

  // Contract closure: every input actual is produced by an earlier step or is
  // an initial contract.
  const producedSoFar = new Set<string>();
  let contractClosure = true;
  for (const item of schematic.items) {
    for (const value of Object.values(item.input)) {
      const contract = asString(value);
      if (!producedSoFar.has(contract) && !initialContracts.has(contract)) {
        contractClosure = false;
        failures.push(
          `contract closure: step '${asString(item.id)}' reads '${contract}' with no upstream producer or initial contract`,
        );
      }
    }
    producedSoFar.add(asString(item.output));
  }

  // Intent closure: every block's semantic preconditions are established by an
  // upstream block's postconditions (or hold initially).
  const established = new Set<IntentState>();
  let intentClosure = true;
  for (const item of schematic.items) {
    const intent = blockIntent(item.block as never);
    if (intent === undefined) {
      intentClosure = false;
      failures.push(`intent closure: block '${asString(item.block)}' has no declared intent`);
      continue;
    }
    for (const pre of intent.precondition) {
      if (!established.has(pre)) {
        intentClosure = false;
        failures.push(
          `intent closure: step '${asString(item.id)}' (${asString(item.block)}) needs '${pre}' which no upstream block establishes`,
        );
      }
    }
    for (const post of intent.postcondition) established.add(post);
  }

  // No orphan: every step's output is consumed downstream, except a terminal
  // close step's result.
  const consumed = new Set<string>();
  for (const item of schematic.items) {
    for (const value of Object.values(item.input)) consumed.add(asString(value));
  }
  let noOrphan = true;
  schematic.items.forEach((item, index) => {
    const output = asString(item.output);
    const isLast = index === schematic.items.length - 1;
    const reachesComplete = Object.values(item.routes).some(
      (target) => asString(target) === '@complete',
    );
    // Only a readable output can be consumed as a typed contract downstream, so
    // only a readable output can be an orphan. A step that writes no readable
    // contract — e.g. a checkpoint that writes only its request/response paths,
    // whose decision the engine consumes structurally by picking a route —
    // produces nothing to orphan. A checkpoint that ALSO writes a report_path
    // (build's frame-step does) IS readable and must be consumed or terminal.
    // Key on the readable write, not the execution kind.
    const readable = outputIsReadableContract(item.writes);
    if (readable && !consumed.has(output) && !(isLast || reachesComplete)) {
      noOrphan = false;
      failures.push(
        `no orphan: step '${asString(item.id)}' output '${output}' is never consumed and is not a terminal`,
      );
    }
  });

  const goalReaching = options.boundPrimaryResult;
  if (!goalReaching) failures.push('goal-reaching: no bound primary_result');

  const sensible = contractClosure && intentClosure && noOrphan && goalReaching;
  return { sensible, contractClosure, intentClosure, noOrphan, goalReaching, failures };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
