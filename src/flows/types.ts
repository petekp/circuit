// CompiledFlow package — the per-flow unit the engine consumes.
//
// Each flow lives in src/flows/<id>/ and exports a FlowDefinition that
// compiles into a CompiledFlowPackage describing source files, relay
// reports, writers, and structural shape hints. The engine (registries,
// report-schemas, emit script) derives everything from the flowPackages
// aggregation in src/flows/catalog.ts — it never imports a flow module
// directly. Routing is model-only: the host or operator names the flow,
// so flows carry no routing/classification metadata.
//
// The flow-authoring playbook lives in docs/flows/authoring-model.md.
// No engine edits are needed for normal flow additions.

import type { z } from 'zod';
import type { CheckpointBriefBuilder } from './registries/checkpoint-writers/types.js';
import type { CloseBuilder } from './registries/close-writers/types.js';
import type { ComposeBuilder } from './registries/compose-writers/types.js';
import type { CrossReportValidator } from './registries/cross-report-validators.js';
import type { StructuralShapeHint } from './registries/shape-hints/types.js';
import type { VerificationBuilder } from './registries/verification-writers/types.js';

export interface CompiledFlowRelayReport {
  // Schema string (e.g. 'build.implementation@v1'). The engine uses
  // this both to look up the Zod validator (report-schemas.ts) and
  // to look up the relay shape hint (shape-hints/registry.ts).
  readonly schemaName: string;

  // Zod validator the relay handler runs against the connector's
  // result_body before materializing the report.
  readonly schema: z.ZodTypeAny;

  // Optional prompt instruction the worker receives describing the
  // exact JSON shape it must emit. Compose-only reports (written
  // by the orchestrator, not by connector relay) skip this; a few
  // relay reports also lack a hint and rely on the generic
  // relay shape instruction.
  readonly relayHint?: string;

  // Cross-report validator runs after `parseReport` succeeds for
  // this schema in the relay step-handler. Enforces constraints
  // that span more than one report and
  // therefore cannot be expressed in the single-report Zod schema.
  // Co-located here so the invariant "validators only fire on
  // relay-produced reports" is structurally enforced — there is
  // no other place to attach one.
  readonly crossReportValidate?: CrossReportValidator;
}

export interface CompiledFlowReportSchema {
  // Schema string (e.g. 'build.brief@v1'). This covers reports
  // written by compose, verification, checkpoint, close, sub-run, and
  // fanout paths. Relay-produced report schemas still belong in
  // `relayReports`, where relay-specific hints and cross-report
  // validators live.
  readonly schemaName: string;
  readonly schema: z.ZodTypeAny;
}

export interface CompiledFlowPaths {
  // Schematic path is required — every flow has a schematic.
  readonly schematic: string;
  // Optional: flow-owned command source copied into host plugin command dirs.
  // Root-authored direct command surfaces can still exist without this
  // field; package command ownership only means the source lives next
  // to the flow.
  readonly command?: string;
  // Optional: flow-specific contract narrative. Not every
  // flow has one yet.
  readonly contract?: string;
}

export type CompiledFlowVisibility = 'public' | 'internal';

// Describes a per-slice implement+verify loop. The engine, when this is
// set, iterates the [headStep..tailStep] sub-sequence once per slice read
// from a report array. Keyed on step roles, not a flow name: any flow can
// opt in. See docs/ideas/build-slice-decomposition.md.
export interface SliceLoopEngineFlag {
  // The step the loop re-enters for each slice (Build: 'act-step').
  readonly headStep: string;
  // The step whose forward route triggers a slice advance (Build:
  // 'verify-step'). On its forward route, if more slices remain, the
  // engine selects `advanceRoute` instead.
  readonly tailStep: string;
  // The declared route on tailStep that targets headStep, selected by the
  // engine on a slice advance (Build: 'advance'). Must be a normal,
  // non-recovery route.
  readonly advanceRoute: string;
  // Where the ordered slice array lives: a run-file report path and the
  // dotted path to the array within it (Build: reports/build/plan.json,
  // 'slices'). Read lazily on first headStep entry.
  readonly slicesFrom: {
    readonly report: string;
    readonly itemsPath: string;
  };
  // Hard cap on the number of slices the loop will iterate.
  readonly maxSlices: number;
  // The loop only activates when the run's depth is at least this label
  // (Build: 'deep'). Lower depths run a single pass, unchanged.
  readonly activateWhenDepthAtLeast: 'deep';
}

// Engine-visible flags a flow can opt into. Kept narrow on purpose:
// only flags that the engine currently branches on belong here. New
// flags should describe a behavior, not a flow name.
export interface CompiledFlowEngineFlags {
  // When true, the relay-selection layer threads the run's effective
  // depth into the per-flow circuit selection so a worker is
  // chosen based on depth (Build's pattern). Other flows resolve
  // selection without an injected depth layer.
  readonly bindsExecutionDepthToRelaySelection?: boolean;
  // When true, an @complete terminal close is downgraded to a
  // non-success run outcome when the flow's primary result report has
  // a non-complete semantic outcome. This keeps host-visible run status
  // honest for flows whose close writer can finish with follow-up needed.
  readonly bindsTerminalOutcomeToPrimaryResult?: boolean;
  // When set, the engine iterates a per-slice implement+verify loop over
  // the slices a prior step produced. Absent = single pass.
  readonly iteratesSliceLoop?: SliceLoopEngineFlag;
}

export interface CompiledFlowPrimaryResult {
  readonly schemaName: string;
  readonly path: string;
  readonly label: string;
}

export interface CompiledFlowProgressStep {
  readonly stepId: string;
  readonly taskTitle: string;
  readonly activeText: string;
  readonly relayRole?: 'researcher' | 'implementer' | 'reviewer';
  readonly relayStartedText?: string;
  readonly relayCompletedText?: string;
}

export interface CompiledFlowProgressSurface {
  readonly steps: readonly CompiledFlowProgressStep[];
}

export interface CompiledFlowRuntimeSurface {
  readonly primaryResult?: CompiledFlowPrimaryResult;
  readonly progress?: CompiledFlowProgressSurface;
}

export interface CompiledFlowPackage {
  readonly id: string;
  // Public flows are installed into host-visible plugin surfaces.
  // Internal flows are emitted only as canonical generated fixtures.
  readonly visibility: CompiledFlowVisibility;
  readonly paths: CompiledFlowPaths;
  readonly relayReports: readonly CompiledFlowRelayReport[];
  readonly reportSchemas?: readonly CompiledFlowReportSchema[];
  readonly writers: {
    readonly compose: readonly ComposeBuilder[];
    readonly close: readonly CloseBuilder[];
    readonly verification: readonly VerificationBuilder[];
    readonly checkpoint: readonly CheckpointBriefBuilder[];
  };
  // Structural hints for relay steps that don't write a typed
  // report (review's standalone audit step is the canonical case).
  readonly structuralHints?: readonly StructuralShapeHint[];
  // Public/operator-facing runtime metadata owned by the flow package.
  // Keep this serializable; live hooks stay in registries.
  readonly runtimeSurface?: CompiledFlowRuntimeSurface;
  // Optional engine-visible behavior flags. Absent = all defaults.
  readonly engineFlags?: CompiledFlowEngineFlags;
}
