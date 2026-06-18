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
    // When on-demand context-pull DELIVERY is active for the implementer
    // (delivery opted in and the act-step is not inside a delivery-blind slice
    // corridor — context.contextDeliveryActive), THIN the plan: hand the
    // implementer the source count and a pointer to the pullable analyze-step
    // observations instead of inlining the full synthesis. The implementer then
    // starts lean and pulls the narrow observations only if it genuinely needs
    // them (context_request {from_step: "analyze-step", field_path:
    // "observations"}), which is what makes the pull channel load-bearing rather
    // than a rarely-exercised fallback. Off (the default), the full synthesis is
    // inlined exactly as before — byte-identical — because an implementer that
    // cannot pull-and-receive a withheld slice would only be starved by thinning.
    const approach =
      grounding === undefined
        ? baseApproach
        : context.contextDeliveryActive === true
          ? `Grounded in a codebase read (${grounding.sources.length} sources); the detailed observations are recorded in the analyze-step report and available to pull on demand if this step needs them (context_request from_step "analyze-step", field_path "observations"). Then ${baseApproach}`
          : `Grounded in a codebase read (${grounding.sources.length} sources): ${grounding.observations.join(' ')} Then ${baseApproach}`;
    // Carry the researcher's ordered work-unit slices. When the analyze
    // step found no decomposition (single indivisible change, or a reduced
    // fixture with no context), fall back to one slice covering the whole
    // objective so the plan always has >=1 slice and a single pass runs.
    const slices =
      grounding !== undefined && grounding.slices.length > 0
        ? grounding.slices
        : [
            {
              id: 'slice-1',
              intent: brief.objective,
              anticipated_file_extensions: grounding?.anticipated_file_extensions ?? [],
            },
          ];
    return BuildPlan.parse({
      objective: brief.objective,
      approach,
      slices,
      anticipated_file_extensions: grounding?.anticipated_file_extensions ?? [],
      // Carry the researcher's negative space forward so the implementer hint
      // and the reviewer's alignment check read from the plan. A context-less
      // plan (reduced fixtures) carries no guardrails.
      guardrails: grounding?.guardrails ?? { non_goals: [], invariants: [] },
      // Carry the researcher's allowed touch area forward so the touch-area gate
      // can check the git-proven change set against it. A context-less plan
      // carries no area, leaving the gate inert (opt-in).
      allowed_touch_area: grounding?.allowed_touch_area ?? [],
      verification: {
        commands: brief.verification_command_candidates,
      },
    });
  },
};
