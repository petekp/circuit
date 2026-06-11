import { z } from 'zod';

// Operator-facing process dial. One of the two run dials (depth x power).
export const Depth = z.enum(['lite', 'standard', 'deep']);
export type Depth = z.infer<typeof Depth>;

// Compiled run thoroughness: the depth dial unioned with the mode flags,
// used where a single scalar describes how hard a run goes.
export const CompiledDepth = z.enum(['lite', 'standard', 'deep', 'tournament', 'autonomous']);
export type CompiledDepth = z.infer<typeof CompiledDepth>;
