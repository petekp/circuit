import { z } from 'zod';

// On-demand context-pull — the typed-lookup channel's wire contract.
//
// A running step may ask a parent for MORE context than its thin envelope
// carried, but only as a typed lookup: name one parent step and one dotted
// field of that parent's typed report. There is deliberately no "give me
// everything" shape here — an untyped/everything ask is refused at the channel
// and surfaced as a finding (see context-pull.ts). This schema is the queryable
// surface's contract: the surface is itself typed, so the ask must be too.

export const ContextQuery = z
  .object({
    from_step: z
      .string()
      .min(1)
      .max(120)
      .describe('the parent step whose typed report this query reads'),
    field_path: z
      .string()
      .min(1)
      .max(200)
      .describe('a dotted path naming exactly one field of the parent report; never "everything"'),
  })
  .strict();
export type ContextQuery = z.infer<typeof ContextQuery>;

export const ContextRequest = z
  .object({
    queries: z
      .array(ContextQuery)
      .min(1)
      .max(8)
      .describe('the named parent slices this step is asking for, one field each'),
  })
  .strict();
export type ContextRequest = z.infer<typeof ContextRequest>;
