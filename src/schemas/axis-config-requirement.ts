import { z } from 'zod';

// Stage 3b (first-class composition): the serialized shape of a config
// prerequisite the CLI validates up-front, before any worker runs. One schema,
// two homes — the authored FlowSchematic DECLARES it and the compiled manifest
// carries it, so the CLI reads the requirement off the loaded flow without a
// by-id catalog package lookup. The shape is identical to the in-code
// `CompiledFlowAxisConfigRequirement` (src/flows/types.ts) — no camelCase rename
// — so the manifest->runtime boundary passes it through. Currently only
// Prototype's tournament axis needs operator-provided variant models. Like
// engine flags, this describes a requirement, not a flow name. Absent = the flow
// declares no required config.
export const AxisConfigRequirement = z
  .object({
    // The boolean axis whose selection makes the config mandatory.
    axis: z.enum(['tournament', 'autonomous']),
    // Dot path into the layered selection config, e.g.
    // 'circuits.prototype.variant_models'. The last layer that defines it wins.
    path: z.string().min(1),
    // Operator-facing reason printed on rejection.
    message: z.string().min(1),
  })
  .strict();
export type AxisConfigRequirement = z.infer<typeof AxisConfigRequirement>;

export const AxisConfigRequirementList = z.array(AxisConfigRequirement).min(1);
export type AxisConfigRequirementList = z.infer<typeof AxisConfigRequirementList>;
