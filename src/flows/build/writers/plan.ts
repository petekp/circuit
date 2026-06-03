// Build plan compose writer.
//
// Reads the build brief and lifts its verification command candidates
// into a deliberate, check-able plan. The plan is the report that
// build's verification step consumes (via build.plan@v1 → commands).
//
// The grounding context (build.context@v1) from the analyze stage is an
// enrichment, not a hard prerequisite: when present it folds the codebase
// read into the approach and seeds anticipated_file_extensions. The build
// flow always runs analyze before plan (the Frame → Analyze → Plan topology
// is asserted in tests/runner/build-grounded-planning.test.ts), so in a real
// run the context is always present. The writer treats it as optional so
// reduced fixtures that exercise only the checkpoint → plan → verify path
// still build a valid (brief-only) plan rather than hard-failing here.

import type {
  ComposeBuildContext,
  ComposeBuilder,
} from '../../registries/compose-writers/types.js';
import { BuildBrief, BuildContext, BuildPlan } from '../reports.js';

export const buildPlanComposeBuilder: ComposeBuilder = {
  resultSchemaName: 'build.plan@v1',
  reads: [
    { name: 'brief', schema: 'build.brief@v1', required: true },
    { name: 'context', schema: 'build.context@v1', required: false },
  ],
  build(context: ComposeBuildContext): unknown {
    const brief = BuildBrief.parse(context.inputs.brief);
    const grounding =
      context.inputs.context === undefined ? undefined : BuildContext.parse(context.inputs.context);
    const baseApproach = `Make the smallest safe change inside scope: ${brief.scope}`;
    const approach =
      grounding === undefined
        ? baseApproach
        : `Grounded in a codebase read (${grounding.sources.length} sources): ${grounding.observations.join(' ')} Then ${baseApproach}`;
    return BuildPlan.parse({
      objective: brief.objective,
      approach,
      slices: brief.success_criteria.map((criterion) => `Satisfy: ${criterion}`),
      anticipated_file_extensions: grounding?.anticipated_file_extensions ?? [],
      verification: {
        commands: brief.verification_command_candidates,
      },
    });
  },
};
