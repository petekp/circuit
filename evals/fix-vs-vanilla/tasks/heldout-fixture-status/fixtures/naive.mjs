const COMPLETED_PLAY = new Set(['FT', 'AET', 'PEN']);

/**
 * Decides whether a fixture's status code credits a played match in the
 * league table.
 *
 * Status codes come from the results feed. A code the table recognizes
 * decides the outcome on its own, in either direction:
 *   - completed-play codes ("FT", "AET", "PEN") count toward the table;
 *   - void codes ("ABD", "PST", "CANC") do not count toward the table.
 * Only a code outside these two lists defers to countWhenUnlisted, the
 * caller's preferred answer for codes the table has no opinion on.
 */
export function fixtureCountsForTable(statusCode, countWhenUnlisted) {
  if (COMPLETED_PLAY.has(statusCode)) {
    return true;
  }
  return countWhenUnlisted;
}
