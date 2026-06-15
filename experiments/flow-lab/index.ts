// The offline flow lab — public surface.
//
// Generate flows (generator.ts), assemble + compile them in memory
// (harness.ts), and score their quality (quality.ts). `scoreSchematic` and
// `scoreSpec` are the one-call entry points: hand them a flow and get back its
// quality issues, per-class tally, and (for a spec) its assemble/compile
// outcomes — all offline, in milliseconds, for nothing.
import type { FlowSchematicAssemblySpec } from '../../src/flows/assemble-flow-schematic.js';
import type { FlowSchematic } from '../../src/schemas/flow-schematic.js';
import { type AssembleOutcome, type CompileOutcome, tryAssemble, tryCompile } from './harness.js';
import { collectFlowQualityIssues } from './quality.js';
import { type QualityIssue, type QualityTally, tallyByClass } from './types.js';

export * from './types.js';
export * from './quality.js';
export * from './harness.js';
export * from './generator.js';

// The score of one schematic: its issues, the count (== score), the per-class
// tally, and the compile outcome (so a caller sees whether the
// runtime_surface-dependent signal was checkable).
export interface SchematicScore {
  readonly issues: QualityIssue[];
  readonly score: number;
  readonly tally: QualityTally;
  readonly compiled: CompileOutcome;
}

export function scoreSchematic(
  schematic: FlowSchematic,
  options: { readonly compile?: boolean } = {},
): SchematicScore {
  const compiled = tryCompile(schematic);
  const flow = options.compile === false ? undefined : compiled.ok ? compiled.flow : undefined;
  const issues = collectFlowQualityIssues(schematic, flow);
  return { issues, score: issues.length, tally: tallyByClass(issues), compiled };
}

// The score of one spec: the assemble outcome plus, when it assembled, the
// schematic score. A spec that fails to assemble carries `score: null` — that
// is the "failure as data" the generator relies on instead of a throw.
export type SpecScore =
  | { readonly assembled: AssembleOutcome & { ok: false }; readonly score: null }
  | ({ readonly assembled: AssembleOutcome & { ok: true } } & SchematicScore);

export function scoreSpec(spec: FlowSchematicAssemblySpec): SpecScore {
  const assembled = tryAssemble(spec);
  if (!assembled.ok) return { assembled, score: null };
  return { assembled, ...scoreSchematic(assembled.schematic) };
}
