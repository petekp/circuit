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

import type { FlowSchematic } from '../../schemas/flow-schematic.js';
import type { FlowSchematicAssemblySpec } from '../assemble-flow-schematic.js';
import { assembleFlowSchematic } from '../assemble-flow-schematic.js';
import { compileSchematicToCompiledFlow } from '../compile-schematic-to-flow.js';
import type { FlowDefinition } from '../flow-definition.js';
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
