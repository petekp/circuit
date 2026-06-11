import { z } from 'zod';

// The Power dial: how much model per unit of work. Operator-facing sibling of
// Depth (the process dial); both share the low/medium/high scale. The dial
// never names models — per-connector tier tables translate a tier word into a
// concrete model and/or effort at selection time, and explicit model config
// always wins over the dial.
//
// Kept import-free (zod only) like depth.ts so any schema can reference the
// dial without risking an import cycle.
export const Power = z.enum(['low', 'medium', 'high']);
export type Power = z.infer<typeof Power>;
