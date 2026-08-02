// What a run leaves behind when it does not finish, and how to say so.
//
// The shape and the sentence live here, away from both the run result and the
// runtime, because three layers need them and one of those layers is not
// allowed to see the other two. The source Run envelope is ratcheted
// projection-only: it may read a projection's schema and it may not reach into
// `schemas/result.js` or `runtime/`. Putting the shared pieces in their own
// module is what lets the envelope hand work over without breaking that.
//
// The read side (turning a run's trace into this list) stays in the runtime,
// in `runtime/run/surviving-work.ts`, because only the runtime has a trace.

import { z } from 'zod';

export const SurvivingWork = z
  .object({
    step_id: z.string().min(1),
    attempt: z.number().int().positive(),
    report_path: z.string().min(1),
    report_schema: z.string().min(1),
  })
  .strict();
export type SurvivingWork = z.infer<typeof SurvivingWork>;

// Beyond this the list stops being something an operator reads and starts being
// something they scroll past. The count in the sentence stays exact, so a
// truncated list never understates what is there.
const MAX_LISTED_PATHS = 8;

function reportWord(count: number): string {
  return count === 1 ? 'report' : 'reports';
}

/**
 * The sentence handed to an operator whose run did not finish.
 *
 * Returns undefined when there is nothing to hand over, so a genuinely empty
 * abort says nothing rather than reassuring the operator about files that do
 * not exist. The inverse lie matters as much as the original one.
 */
export function survivingWorkSummary(items: readonly SurvivingWork[]): string | undefined {
  if (items.length === 0) return undefined;
  const listed = items.slice(0, MAX_LISTED_PATHS).map((item) => item.report_path);
  const remainder = items.length - listed.length;
  const tail = remainder > 0 ? `, and ${remainder} more` : '';
  const inventory = `The steps that did finish left ${items.length} ${reportWord(items.length)} behind: ${listed.join(', ')}${tail}.`;
  return `${inventory} Nothing was deleted; read these before rerunning, because a rerun starts over.`;
}
