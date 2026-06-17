import { z } from 'zod';

// A runtime equipment discovery a researcher relay bubbles UP: what it learned
// reading the code that the assembly-time equipment choice did not know — e.g.
// "this turned out to be a React app, equip the remaining steps for it." It is
// the trigger for the first live reshape (Step 2): the engine acts on it ONLY
// when `confirmed` is true (unambiguous evidence, never a hunch), re-resolves
// equipment on the remaining relay steps, and re-validates the whole flow
// through the compiled-flow gate before continuing. An unconfirmed discovery is
// recorded as a finding and changes nothing.
//
// Sibling of PowerRecommendation (schemas/power.ts): the same shape of in-run
// signal a researcher emits in its report, read field-tolerantly at the
// post-step seam (see runtime/run/equipment-reshape.ts). Kept import-free (zod
// only) so any report schema can reference it without an import cycle.
export const EquipmentDiscovery = z
  .object({
    confirmed: z
      .boolean()
      .describe('true ONLY on unambiguous runtime evidence; a hunch or a maybe must be false'),
    // Bounded on both axes: the value is model-controlled and is copied verbatim
    // into the durable run.equipment-reshape trace entry. Only a handful of tags
    // map to a domain skill (the closed DOMAIN_SKILL table), so a long list is
    // never useful — the caps just keep a pathological report from bloating the
    // trace. Mirrors the evidence cap above.
    domain_tags: z
      .array(z.string().min(1).max(40))
      .max(16)
      .describe(
        'technology signals confirmed at runtime, e.g. ["react"], that map to domain skills',
      ),
    evidence: z
      .string()
      .min(1)
      .max(280)
      .describe('one short sentence grounding the discovery in what was read'),
  })
  .strict();
export type EquipmentDiscovery = z.infer<typeof EquipmentDiscovery>;
