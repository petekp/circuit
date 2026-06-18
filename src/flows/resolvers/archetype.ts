import { FlowSchematic } from '../../schemas/flow-schematic.js';
// Resolver #2 — archetype (the family chooser + shape instantiator).
//
// This is the heart of the task-aware assembler. Given the task signals (from
// signals.ts), it picks an archetype FAMILY and instantiates a task-appropriate
// FlowSchematic for it. The old seam could only ever produce build's spine; this
// produces an editorial, fix, review, research, prototype, OR build shape,
// chosen from the task.
//
// Soundness by construction: every family instantiates from a seed that already
// ships as a hand-authored built-in (buildAssemblySpec, fixAssemblySpec,
// exploreAssemblySpec, reviewAssemblySpec, prototypeAssemblySpec) or, for the
// editorial family, the explainer's in-memory schematic. Each reuses a contract
// family whose bodies are registered globally by namespace (build.*, fix.*,
// explore.*, review.*, prototype.*, explainer.*), and single-producer is checked
// PER-GRAPH — so a custom-slug flow that reuses a proven family's typed seams
// passes the fail-closed catalog + kind gates exactly as the built-in does. This
// is the Phase 1 line: REUSE registered contract families. Inventing novel
// contracts from raw blocks is the Phase 2 research frontier, deliberately not
// attempted here.
//
// Engine boundary: this rides the assembler. It imports only public flow types +
// the family seeds + the structure resolver, and emits the FlowSchematic the
// assembler already eats. No engine edit, no new execution kind.
//
// What is genuine composition vs instantiation (reported honestly):
//   - build: COMPOSED — the structure resolver folds the spine to the whole or
//     decomposed grain from the task's surface_area/risk/explicit-decompose.
//   - fix / research / review / prototype / editorial: INSTANTIATED — the family
//     pattern is materialized for the task (slug + task purpose), reusing the
//     proven shape. Intra-family fold composition for these is future work.
import {
  type FlowSchematicAssemblySpec,
  assembleFlowSchematic,
} from '../assemble-flow-schematic.js';
import { buildAssemblySpec } from '../build/assembly-spec.js';
import { explainerFlowData } from '../explainer/data.js';
import { exploreAssemblySpec } from '../explore/assembly-spec.js';
import { fixAssemblySpec } from '../fix/assembly-spec.js';
import { prototypeAssemblySpec } from '../prototype/assembly-spec.js';
import { reviewAssemblySpec } from '../review/assembly-spec.js';
import type { ArchetypeFamily, AssemblySignals } from './signals.js';
import { applyStructure, resolveStructure } from './structure.js';

type FlowSchematicValue = ReturnType<typeof assembleFlowSchematic>;

export interface ArchetypeResolution {
  readonly family: ArchetypeFamily;
  // The assembled, ready-to-compile schematic, already carrying the slug as its
  // id so the caller can compile + publish it directly.
  readonly schematic: FlowSchematicValue;
  // Plain-English reason the operator sees: which family and why.
  readonly rationale: string;
  // How the shape was produced: 'grain:whole' | 'grain:decomposed' for the
  // composed build family, or 'instantiated' for the family-pattern families.
  readonly composition: string;
  // Echoes the signals that drove the choice (trace evidence).
  readonly signals_used: readonly string[];
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// Family seeds that flow through assembleFlowSchematic (they expose `items`).
// editorial is handled separately — explainer ships a finished schematic, not an
// assembly spec.
const SEED_BY_FAMILY: Partial<Record<ArchetypeFamily, FlowSchematicAssemblySpec>> = {
  build: buildAssemblySpec,
  fix: fixAssemblySpec,
  research: exploreAssemblySpec,
  review: reviewAssemblySpec,
  prototype: prototypeAssemblySpec,
};

// Plain-English family descriptions for the operator summary.
const FAMILY_RATIONALE: Record<ArchetypeFamily, string> = {
  editorial:
    'Editorial shape: the task asks to explain or teach a concept, so the flow digests the subject, ideates and hardens explanations, then builds and verifies an interactive explainer.',
  fix: 'Fix shape: the task asks to repair broken behavior, so the flow reproduces and diagnoses first, captures a regression baseline, makes the change, then re-verifies.',
  review:
    'Review shape: the task asks to audit existing work without changing it, so the flow intakes the scope, audits it, and writes a verdict — no implementation step.',
  research:
    'Research shape: the task asks to investigate or compare options, so the flow analyzes the question and runs a decision tournament rather than committing to one build.',
  prototype:
    'Prototype shape: the task asks for a throwaway visual exploration, so the flow plans and fans out variant directions for an operator to pick from.',
  build:
    'Build shape: a general change with no fix/review/research/prototype/explain signal, so the flow uses the standard frame-plan-act-verify spine.',
};

// Plain-English reason a given family was chosen — shared with the create
// operator summary so the published surfaces explain the shape even when
// recovered from a draft (where only the family name survives).
export function describeArchetypeFamily(family: ArchetypeFamily): string {
  return FAMILY_RATIONALE[family];
}

function instantiateEditorial(slug: string, signals: AssemblySignals): FlowSchematicValue {
  // explainer ships a finished schematic (no assembly spec). Re-id it to the slug
  // and stamp the task as its purpose, then re-validate. The contract family stays
  // explainer.* (registered), so it compiles clean under a custom slug — proven by
  // tests/runner/task-aware-assembler.test.ts.
  const raw = clone(explainerFlowData.schematic) as Record<string, unknown>;
  raw.id = slug;
  raw.purpose = signals.summary;
  return FlowSchematic.parse(raw);
}

function instantiateFromSeed(
  family: ArchetypeFamily,
  slug: string,
  signals: AssemblySignals,
): { schematic: FlowSchematicValue; composition: string } {
  const seed = SEED_BY_FAMILY[family];
  if (seed === undefined) {
    throw new Error(`archetype family '${family}' has no seed spec`);
  }

  if (family === 'build') {
    // The build family is COMPOSED: the structure resolver picks the grain from
    // the task's surface/risk/explicit-decompose. This preserves the prior
    // create behavior for build-shaped tasks byte-for-byte (the structure path).
    const resolution = resolveStructure({
      summary: signals.summary,
      surface_area: signals.surface_area,
      risk: signals.risk,
      explicit_decompose: signals.explicit_decompose,
    });
    const grained = applyStructure({ ...seed, id: slug, purpose: signals.summary }, resolution);
    return {
      schematic: assembleFlowSchematic({ ...grained, id: slug }),
      composition: `grain:${resolution.choice}`,
    };
  }

  // The remaining families instantiate their proven pattern for the task: same
  // shape, the slug as id, the task as purpose.
  return {
    schematic: assembleFlowSchematic({ ...clone(seed), id: slug, purpose: signals.summary }),
    composition: 'instantiated',
  };
}

// Pick an archetype family from the signals and instantiate its task-appropriate
// schematic under the given slug.
export function resolveArchetype(slug: string, signals: AssemblySignals): ArchetypeResolution {
  if (signals.family === 'editorial') {
    return {
      family: 'editorial',
      schematic: instantiateEditorial(slug, signals),
      rationale: FAMILY_RATIONALE.editorial,
      composition: 'instantiated',
      signals_used: signals.signals_used,
    };
  }

  const { schematic, composition } = instantiateFromSeed(signals.family, slug, signals);
  return {
    family: signals.family,
    schematic,
    rationale: FAMILY_RATIONALE[signals.family],
    composition,
    signals_used: signals.signals_used,
  };
}
