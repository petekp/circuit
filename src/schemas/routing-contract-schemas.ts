// M8 (first-class composition): typed bodies for the routing-seam contracts.
//
// Three contracts wire the orchestrator to a flow: task.intake@v1 (the
// normalized request), route.decision@v1 (which flow was chosen), and
// flow.catalog@v1 (the set of flows to choose from). Until M8 all three were
// name-only identifiers — matched by string, never by shape. These are their
// real Zod bodies, grounded in each block's declared produces_evidence
// (src/schemas/flow-block-definitions.ts: intake line 120, route line 146).
//
// Engine built-ins, not flow-package reports. task.intake@v1 and
// route.decision@v1 are produced by the intake/route blocks and supplied as
// initial contracts to every flow; they are not relay or compose report bodies,
// so they live here next to BUILTIN_REPORT_SCHEMAS rather than in any flow
// package. The contract-body resolver (contract-body-signature.ts) merges this
// record so routing contracts resolve to a signature like any other contract.
//
// Inert at compile (M8.1). Contract matching is still name-only
// (contractIsCompatible, flow-schematic.ts), so authoring these bodies changes
// no compile behavior — it makes the seam legible and gives the M8.4
// anti-widening gate a uniform target across all three. The fields can be
// refined in M9 when a composed flow first produces and consumes them.

import { z } from 'zod';

// task.intake@v1 — the intake block's output. Evidence: normalized goal,
// requested flow, operator constraints.
const TaskIntakeShape = z
  .object({
    // The user's goal, preserved through normalization (the block check
    // requires the normalized task to preserve the goal).
    normalized_goal: z.string().min(1),
    // The flow the operator explicitly asked for, when they named one.
    requested_flow: z.string().min(1).optional(),
    // Immediate operator constraints carried into the flow (may be empty).
    constraints: z.array(z.string().min(1)),
  })
  .strict();

// route.decision@v1 — the route block's output. The check requires it to name
// one known flow OR stop with an explicit reason, so selected_flow is null on a
// stop and selection_reason always explains the choice.
const RouteDecisionShape = z
  .object({
    // The chosen flow id, or null when the router stopped instead of routing.
    selected_flow: z.string().min(1).nullable(),
    // Why this flow was chosen (or why the router stopped).
    selection_reason: z.string().min(1),
    // Why the router stayed conservative, when it fell back to a safer choice.
    fallback_reason: z.string().min(1).optional(),
  })
  .strict();

// flow.catalog@v1 — the set of flows the route block may choose from. Consumed
// only by the route block today; its PRODUCER is the open #15 / M9 decision
// (engine-provided vs a compose step). Typing the body now is independent of
// that decision: the shape is what a router needs to choose, regardless of who
// emits it.
const FlowCatalogShape = z
  .object({
    flows: z
      .array(
        z
          .object({
            id: z.string().min(1),
            title: z.string().min(1),
            purpose: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export const BUILTIN_ROUTING_CONTRACT_SCHEMAS: Readonly<Record<string, z.ZodType<unknown>>> =
  Object.freeze({
    'task.intake@v1': TaskIntakeShape,
    'route.decision@v1': RouteDecisionShape,
    'flow.catalog@v1': FlowCatalogShape,
  });
