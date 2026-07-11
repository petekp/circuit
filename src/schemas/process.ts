import { z } from 'zod';

// Operator-facing process dial. One of the two run dials (process x power).
export const Process = z.enum(['low', 'medium', 'high']);
export type Process = z.infer<typeof Process>;

// Compiled run thoroughness: the process dial unioned with the mode flags,
// used where a single scalar describes how hard a run goes.
export const CompiledDepth = z.enum(['low', 'medium', 'high', 'tournament', 'autonomous']);
export type CompiledDepth = z.infer<typeof CompiledDepth>;
