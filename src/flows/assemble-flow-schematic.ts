// Sequence-level flow assembler (first-class composition, M7).
//
// `expandBlockStepUse` turns ONE block use into one SchematicStep, defaulting
// its output/evidence/execution from the block definition. This module is the
// SEQUENCE-level counterpart: given a block sequence plus the flow's
// scaffolding, `assembleFlowSchematic` produces a complete, validated
// FlowSchematic. Its net-new value over hand authoring is that it DERIVES the
// three fields that today are kept in sync with the item list by hand:
//
//   - `starts_at`          — the first item's id.
//   - `stages`             — one entry per canonical stage the sequence
//                            touches, emitted in canonical order, labelled
//                            from `spec.stageLabels` (titles like pursue's
//                            "Coordinate" are not mechanical, so the caller
//                            supplies id + title; the assembler decides WHICH
//                            canonicals appear and in what order).
//   - `stage_path_policy`  — `strict` when the sequence covers every canonical
//                            stage, otherwise `partial` with `omits` set to the
//                            absent canonicals and the caller's rationale.
//
// Everything else (identity, axes, contract aliases, engine flags, report file
// surfaces, required config) is flow-level scaffolding the caller passes
// through verbatim. The assembler hands its result to `FlowSchematic.parse`, so
// any inconsistency it introduces is caught by the schema's superRefine rather
// than reaching the compiler.
//
// Scope note (M7): this is additive. The built-in flows still hand-author their
// schematics; making them the assembler's first customers is M9's job. The
// prove-by-equivalence tests show a built-in's schematic can be reconstructed
// from its block sequence and compiles to the same CompiledFlow.
import type { z } from 'zod';

import {
  FlowSchematic,
  type FlowSchematic as FlowSchematicValue,
} from '../schemas/flow-schematic.js';
import {
  CANONICAL_STAGES,
  type CanonicalStage,
  PARTIAL_SPINE_RATIONALE_MIN_LENGTH,
} from '../schemas/stage.js';
import { type BlockStepUse, expandBlockStepUse } from './block-step-expansion.js';

type FlowSchematicInput = z.input<typeof FlowSchematic>;

// Author-facing label for one canonical stage. `id` and `title` are not
// derivable from the item sequence, so the caller supplies them.
export interface StageLabel {
  readonly id: string;
  readonly title: string;
}

export type StageLabelMap = Partial<Record<CanonicalStage, StageLabel>>;

export interface FlowSchematicAssemblySpec {
  readonly id: FlowSchematicInput['id'];
  readonly title: string;
  readonly purpose: string;
  readonly status: FlowSchematicInput['status'];
  readonly version?: FlowSchematicInput['version'];
  readonly initial_contracts?: FlowSchematicInput['initial_contracts'];
  readonly contract_aliases?: FlowSchematicInput['contract_aliases'];
  readonly axes?: FlowSchematicInput['axes'];
  readonly default_selection?: FlowSchematicInput['default_selection'];
  readonly engine_flags?: FlowSchematicInput['engine_flags'];
  readonly report_file_surfaces?: FlowSchematicInput['report_file_surfaces'];
  readonly required_config?: FlowSchematicInput['required_config'];
  // The flow's block sequence. Each entry expands to one SchematicStep.
  readonly items: readonly BlockStepUse[];
  // Per-canonical-stage labels. Only canonicals the sequence touches need an
  // entry; extras are ignored.
  readonly stageLabels: StageLabelMap;
  // Required when the sequence leaves a canonical stage empty (partial path).
  // Must satisfy SpinePolicy's partial rationale (min 20 chars). Ignored when
  // the sequence covers every canonical stage (strict path).
  readonly stagePathRationale?: string;
}

export function assembleFlowSchematic(spec: FlowSchematicAssemblySpec): FlowSchematicValue {
  if (spec.items.length === 0) {
    throw new Error(
      `assembleFlowSchematic: flow '${spec.id}' has no items; a flow needs at least one step`,
    );
  }
  const items = spec.items.map((use) => expandBlockStepUse(use));
  const first = items[0];
  if (first === undefined) {
    // Unreachable: items mirrors the non-empty spec.items above. Keeps the
    // first-item read total for the type checker.
    throw new Error(`assembleFlowSchematic: flow '${spec.id}' produced no items`);
  }

  const present = CANONICAL_STAGES.filter((canonical) =>
    items.some((item) => item.stage === canonical),
  );
  const stages = present.map((canonical) => {
    const label = spec.stageLabels[canonical];
    if (label === undefined) {
      throw new Error(
        `assembleFlowSchematic: flow '${spec.id}' uses canonical stage '${canonical}' but spec.stageLabels has no label for it`,
      );
    }
    return { canonical, id: label.id, title: label.title };
  });

  const absent = CANONICAL_STAGES.filter((canonical) => !present.includes(canonical));
  const stagePathPolicy: FlowSchematicInput['stage_path_policy'] =
    absent.length === 0
      ? { mode: 'strict' }
      : { mode: 'partial', omits: absent, rationale: requireRationale(spec, absent) };

  const input: FlowSchematicInput = {
    schema_version: '2',
    id: spec.id,
    title: spec.title,
    purpose: spec.purpose,
    status: spec.status,
    starts_at: first.id,
    items,
    stages,
    stage_path_policy: stagePathPolicy,
    ...(spec.version === undefined ? {} : { version: spec.version }),
    ...(spec.initial_contracts === undefined ? {} : { initial_contracts: spec.initial_contracts }),
    ...(spec.contract_aliases === undefined ? {} : { contract_aliases: spec.contract_aliases }),
    ...(spec.axes === undefined ? {} : { axes: spec.axes }),
    ...(spec.default_selection === undefined ? {} : { default_selection: spec.default_selection }),
    ...(spec.engine_flags === undefined ? {} : { engine_flags: spec.engine_flags }),
    ...(spec.report_file_surfaces === undefined
      ? {}
      : { report_file_surfaces: spec.report_file_surfaces }),
    ...(spec.required_config === undefined ? {} : { required_config: spec.required_config }),
  };

  return FlowSchematic.parse(input);
}

function requireRationale(
  spec: FlowSchematicAssemblySpec,
  absent: readonly CanonicalStage[],
): string {
  const rationale = spec.stagePathRationale;
  if (rationale === undefined || rationale.length < PARTIAL_SPINE_RATIONALE_MIN_LENGTH) {
    const absentList = absent.map((canonical) => `'${canonical}'`).join(', ');
    throw new Error(
      `assembleFlowSchematic: flow '${spec.id}' leaves canonical stage(s) ${absentList} empty; spec.stagePathRationale must explain why (min ${PARTIAL_SPINE_RATIONALE_MIN_LENGTH} chars)`,
    );
  }
  return rationale;
}
