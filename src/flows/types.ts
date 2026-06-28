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
import type { ReportFileSurfaceDeclaration } from '../schemas/report-file-surface.js';
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
  // (Build: 'high'). Lower depths run a single pass, unchanged.
  readonly activateWhenDepthAtLeast: 'high';
}

// Describes a "repeat the body until a condition holds" loop: a while loop for
// flows, the third control shape after run-once (default) and the counted
// for-each of `iteratesSliceLoop`. The engine, when this is set, re-enters the
// [headStep..tailStep] body once per iteration until the iteration count
// reaches `maxIterations`. Like the slice loop it is keyed on step roles, not a
// flow name: any flow can opt in. See docs/ideas/until-loop.md.
//
// Slice 1 (this shape) is count-driven only: it loops a fixed `maxIterations`
// times with no stop-judge and no honesty ledger. The stop-judge that ends the
// loop early on a disposed goal-met claim, the carried-notes append, the
// cumulative budget caps, and the no-progress ceiling arrive in later slices,
// each adding the field the engine then branches on.
export interface UntilLoopEngineFlag {
  // The step the loop re-enters at the start of each iteration.
  readonly headStep: string;
  // The step whose forward route closes an iteration. On its forward route, if
  // the iteration count has not yet reached maxIterations, the engine selects
  // `reenterRoute` instead of letting the forward route through.
  readonly tailStep: string;
  // Every step in the loop body, head and tail included, in no required order.
  // This is the generalization the slice loop lacks: the slice loop's head and
  // tail are adjacent, so it only ever scopes those two. An until-loop body can
  // hold intermediate steps, and EVERY one must be iteration-scoped or the
  // first intermediate step aborts as an illegal re-entry on the second pass.
  readonly bodySteps: readonly string[];
  // The declared route on tailStep that targets headStep, selected by the
  // engine to re-enter the loop. Must be a normal, non-recovery route.
  readonly reenterRoute: string;
  // Hard cap on the number of iterations the loop will run.
  readonly maxIterations: number;
  // Slice 2 (the stop-judge): when set, the loop no longer advances on a fixed
  // count. Each iteration the tail step (a reviewer relay) PROPOSES whether the
  // goal is met by writing a boolean into its report; the engine reads ONLY that
  // boolean (never the goal text) and DISPOSES it against an independent evidence
  // floor. A met-claim the evidence does not confirm is a blocked false-done: the
  // engine re-enters the head for another pass instead of stopping. Absent =
  // slice-1 count-driven advance (the loop runs the full maxIterations).
  readonly stopJudge?: {
    // The run-file report the tail writes its judgment to, and the dotted path to
    // the goal-met boolean within it. Mirrors slicesFrom: {report, itemsPath}.
    readonly report: string;
    readonly goalMetPath: string;
    // Slice 4 (carried notes): the dotted path to a short, free-text lesson the
    // judge writes alongside its goal-met boolean. The engine reads it as opaque
    // data (never as instructions), appends it to the carried-notes file, and the
    // next iteration's head re-reads that file. This is what turns a loop that
    // repeats into one that learns. Absent = no lesson is carried.
    readonly lessonPath?: string;
    // Slice 6 (no-progress steering): the dotted path to a progress marker the
    // judge writes each iteration (any JSON scalar: a remaining-failure count, a
    // phase label). The engine treats it as OPAQUE and only compares it for
    // equality across iterations; it never interprets the value. When the marker
    // is unchanged for an iteration the loop made no measurable progress. Absent =
    // no-progress detection is off (the iteration cap is the only bound).
    readonly progressPath?: string;
  };
  // The declared route on tailStep the engine selects when the loop exhausts its
  // bounds without a confirmed goal (the iteration cap is reached). REQUIRED when
  // stopJudge is set, and it must target a non-@complete terminal: an exhausted
  // judge-gated loop must exit somewhere other than the clean-stop forward route,
  // so exhaustion can never read as success. Unused in the slice-1 count form.
  readonly needsAttentionRoute?: string;
  // Slice 4 (carried notes): the run-file the engine maintains across iterations,
  // appending one note (lesson plus any steer) per pass. The loop's head step
  // declares this path in its reads so the prompt composer re-inlines the
  // accumulated notes on the next iteration, framed as data. `maxEntries` caps how
  // many of the most recent notes are kept (default 20). Absent = no notes carried.
  // REQUIRES stopJudge (notes are appended only on the judge seam); the validator
  // rejects this without one rather than silently dropping it.
  readonly carriedNotes?: {
    readonly report: string;
    readonly maxEntries?: number;
  };
  // Slice 5 (cumulative budget cap, fail-closed): hard ceilings on the total spend
  // across all iterations, summed from the per-relay usage already on the trace. At
  // or above the cap the loop exits to needsAttentionRoute rather than spending
  // more, so an unconfirmed goal can never burn past the budget. FAIL CLOSED: if a
  // cap is set and any loop relay reported no usage, the engine cannot prove it is
  // under budget and treats the loop as over budget. A soft warning at 80% of the
  // cap attaches a closure-priority steer to the carried note. Set neither = no cap.
  // REQUIRES stopJudge (the cap is evaluated only on the judge seam); a count-driven
  // loop cannot honor it, so the validator rejects a cap declared without one.
  readonly cumulativeUsdCap?: number;
  readonly cumulativeTokenCap?: number;
  // Slice 6 (no-progress ceiling): the number of consecutive no-progress
  // iterations (the judge's progressPath marker unchanged) the loop tolerates
  // before exiting to needsAttentionRoute, even with iterations left. The first
  // stall attaches a "try a materially different approach" steer to the carried
  // note. Requires stopJudge.progressPath. Absent = only the iteration cap bounds
  // the loop.
  readonly noProgressCeiling?: number;
  // Slice 7 (per-iteration commit containment, opt-in, default off). When set
  // AND the host injects a commit-containment runner, each completed iteration
  // is committed to a throwaway branch named `${branchPrefix}-${runId}` so an
  // autonomous loop never mutates the operator's branch in place; the operator
  // owns the merge. Absent OR no runner injected => the engine makes zero git
  // calls and the loop mutates the working tree as before (byte-identical).
  // This is the highest-blast-radius switch in the feature, so it ships last
  // and stays off unless a flow and a host both opt in.
  readonly iterationCommitContainment?: {
    readonly branchPrefix: string;
  };
  // The loop's read-only eval surface — the test files, the verify command's own
  // definition, a spec or expected-output file the evidence floor trusts. The
  // engine fingerprints each path at loop entry and, at each iteration's tail
  // seam, re-fingerprints; if any body iteration changed one of these paths it
  // opens an honesty-ledger latch so the floor cannot honor that iteration's
  // goal-met claim (the run then re-enters or exhausts to needs-attention). This
  // is the generic engine mechanism only: wiring an operator-supplied frozen set
  // onto a real flow is a deliberate NEXT slice — freezing real repo paths risks
  // false positives on legitimate edits (e.g. a dependency bump), so no shipped
  // flow sets this yet. Absent = off, byte-identical (no guard, no fs reads).
  readonly frozenPaths?: readonly string[];
  // The loop only activates when the run's depth is at least this label.
  // Lower depths run a single pass, unchanged.
  readonly activateWhenDepthAtLeast: 'autonomous';
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
  // When set, the engine re-enters the body once per iteration until the
  // iteration count reaches maxIterations (a while loop for flows). Mutually
  // exclusive with iteratesSliceLoop: both drive one re-entry counter, so a
  // flow opts into at most one loop shape. Absent = single pass.
  readonly iteratesUntilCondition?: UntilLoopEngineFlag;
}

// A config prerequisite the CLI validates up-front, before any worker runs, so
// a missing requirement rejects like an unsupported axis (exit 2, no run
// folder) instead of aborting mid-run after framing and planning work.
// Currently only Prototype's tournament axis needs operator-provided variant
// models. Like engineFlags, this describes a requirement, not a flow name.
export interface CompiledFlowAxisConfigRequirement {
  // The boolean axis whose selection makes the config mandatory.
  readonly axis: 'tournament' | 'autonomous';
  // Dot path into the layered selection config, e.g.
  // 'circuits.prototype.variant_models'. The last layer that defines it wins.
  readonly path: string;
  // Operator-facing reason printed on rejection.
  readonly message: string;
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
  readonly reportFileSurfaces?: Readonly<Record<string, ReportFileSurfaceDeclaration>>;
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
  // Config prerequisites the CLI validates up-front before any worker runs.
  // Absent = no required config.
  readonly requiredConfig?: readonly CompiledFlowAxisConfigRequirement[];
}
