// Cabin arc helpers for the dockside observation wheel.

export const CABIN_COUNT = 30;

/**
 * Tells whether `cabin` falls inside the arc named by (arcStart, arcEnd).
 *
 * How this module reads an arc: the wheel carries CABIN_COUNT cabins,
 * numbered 0 through CABIN_COUNT - 1, and the numbering rolls over, so
 * cabin 0 rides directly behind cabin CABIN_COUNT - 1. An arc opens at
 * arcStart, takes in one cabin after another in boarding order, and stops
 * just short of arcEnd. An arc whose end number is below its start number
 * rolls over with the wheel: it takes in arcStart through cabin
 * CABIN_COUNT - 1, then cabin 0 up to, but not including, arcEnd. Equal
 * start and end name an empty arc. Every reader of an (arcStart, arcEnd)
 * pair in this module shares this meaning.
 */
export function isCabinInArc(cabin, arcStart, arcEnd) {
  return cabin >= arcStart && cabin < arcEnd;
}

// Drives the closed-cabin panel on the loading platform display.
export function arcCabins(arcStart, arcEnd) {
  const cabins = [];
  for (let cabin = arcStart; cabin < arcEnd; cabin += 1) {
    cabins.push(cabin);
  }
  return cabins;
}
