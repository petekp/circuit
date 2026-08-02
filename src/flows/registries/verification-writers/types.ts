// Verification writer registry types.
//
// A verification step has three pieces of flow-specific logic:
//
//   1. Where do the commands come from? (Build sources from
//      build.plan@v1; Fix sources from fix.brief@v1.)
//   2. What's the output report's shape? (BuildVerification vs.
//      FixVerification — Fix's wider schema carries timeout/env per
//      command result.)
//   3. What's the output schema name?
//
// The runner's spawnSync loop, output summarization, and trace_entry-writing
// stay universal. Each VerificationBuilder fills the flow-specific
// holes.
//
// To add a new flow's verification step:
//   1. Define the result schema in src/flows/<wf>/reports.ts
//   2. Implement a VerificationBuilder in
//      src/flows/<wf>/writers/<schema>.ts
//   3. Register it on the flow package's `writers.verification`

import type { RuntimeIndexedFlow, RuntimeIndexedVerificationStep } from '../runtime-index.js';

export type VerificationStep = RuntimeIndexedVerificationStep;

// One command to execute. Both Build and Fix use the same command
// shape (id, cwd, argv, timeout_ms, max_output_bytes, env), so this
// type is the structural intersection.
export interface VerificationCommand {
  readonly id: string;
  readonly cwd: string;
  readonly argv: readonly string[];
  readonly timeout_ms: number;
  readonly max_output_bytes: number;
  readonly env: Readonly<Record<string, string>>;
}

// What the runner observes after executing one command. CompiledFlow-
// specific result schemas may include a subset (Build) or superset
// (Fix carries the original timeout/env so the result is
// self-contained as repro evidence).
export interface VerificationCommandObservation {
  readonly command: VerificationCommand;
  readonly exit_code: number;
  readonly status: 'passed' | 'failed';
  readonly duration_ms: number;
  readonly stdout_summary: string;
  readonly stderr_summary: string;
  // True when the command was killed for hitting its verification budget
  // rather than exiting on its own.
  readonly timed_out: boolean;
}

export interface VerificationBuildContext {
  readonly runFolder: string;
  readonly projectRoot?: string;
  readonly flow: RuntimeIndexedFlow;
  readonly step: VerificationStep;
}

// Each verification writer sources its command list from one upstream typed
// report (Fix from fix.brief@v1; Build from build.plan@v1). loadCommands enforces
// that read imperatively, throwing if the step does not declare it. Declaring the
// SAME read here, as inspectable static descriptors, lets a composer wire the read
// in when it synthesizes the step (the block's input_contracts do not capture it)
// and lets the offline runnability check resolve it without invoking the writer —
// the verification analog of CloseReadDescriptor. The runtime guard stays the
// source of truth; these descriptors mirror it.
export interface VerificationReadDescriptor {
  // Stable name the step input uses to address this read (e.g. 'brief', 'plan').
  readonly name: string;
  // Report schema string (e.g. 'fix.brief@v1'). Resolved to a path via
  // reportPathForSchema(flow, schema), exactly as the runtime guard does.
  readonly schema: string;
  // When true, the read must be present or the run aborts at the writer. A
  // composer either produces it upstream and wires it, or walls.
  readonly required: boolean;
}

export interface VerificationBuilder {
  // Schema name of the report this builder produces (e.g.
  // 'build.verification@v1', 'fix.verification@v1'). Acts as the
  // registry key.
  readonly resultSchemaName: string;
  // The upstream typed reports loadCommands (and buildResult) source from, declared
  // so a composer can wire them and the offline floor can resolve them. Optional
  // ONLY for a writer with no typed source coupling — one whose loadCommands does
  // not guard on step.reads (explainer.verification, which resolves its command
  // from the project rather than from an upstream report).
  // Every source-coupled writer MUST declare its reads here; the
  // verification-writer-source-coverage test enforces that pairing so a new writer
  // cannot silently reintroduce the unwired-source gap. When present, it MUST match
  // what the writer actually reads.
  readonly reads?: readonly VerificationReadDescriptor[];
  // Source the command list for this verification step. CompiledFlow-
  // specific: Build reads from build.plan@v1; Fix reads from
  // fix.brief@v1.
  loadCommands(context: VerificationBuildContext): readonly VerificationCommand[];
  // Assemble the verification result report from the observed
  // command outcomes. CompiledFlow-specific: Build produces a narrow
  // BuildVerification; Fix produces a wider FixVerification with
  // per-command repro fields. Builders that need to read other typed
  // run-folder outputs (e.g. the change-set writer comparing
  // declared files against observed git state) use the build context
  // to resolve those paths; the regression-proof and verification
  // writers ignore it.
  buildResult(
    observations: readonly VerificationCommandObservation[],
    context: VerificationBuildContext,
  ): unknown;
}
