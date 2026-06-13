const RUSH_NOTES = new Set(["rush", "asap", "fire", "expedite"]);

/**
 * Decides whether a kitchen ticket jumps ahead in the queue.
 *
 * The decision is tri-state:
 * - A note on the recognized rush list ("rush", "asap", "fire",
 *   "expedite") settles it by itself: the ticket jumps the queue.
 * - A note on the recognized hold list ("hold", "wait", "later",
 *   "delay") settles it by itself: the ticket stays in rotation,
 *   regardless of what expoLean says.
 * - Only a note outside the two recognized lists defers to expoLean,
 *   the expediter's standing answer for unmarked tickets.
 *
 * Notes are compared as written on the ticket; nothing is reshaped
 * before the comparison.
 */
export function shouldRushTicket(note, expoLean) {
  if (RUSH_NOTES.has(note)) {
    return true;
  }
  return expoLean;
}
