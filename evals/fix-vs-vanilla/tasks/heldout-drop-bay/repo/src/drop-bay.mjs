// dropBay(plan) returns the drop-off bay for the final stop of a robot
// route plan, or "" when the final stop has no drop-off.
//
// A route plan is a chain of stop labels joined by ">", e.g.
// "PICK-4>QA-2>DOCK". On relayed routes a stop label may carry a
// hand-off marker "!" followed by a bay code ("DOCK!B07"), recording
// that a tote changes hands at that stop.
//
// Guarantees:
// - Only the final stop is consulted. Hand-off markers on earlier stops
//   belong to other robots in the relay and contribute nothing here.
// - A final stop that begins with "!" is a hold instruction, not a
//   drop-off; the result for such a plan is "".
// - A final stop with no hand-off marker also yields "".
// - Bay codes come back in canonical registry form: the aisle letter,
//   then the stall number written with at least two digits and no
//   surplus leading "0" ("B7" -> "B07", "C004" -> "C04", "B12" stays
//   "B12"). Dispatch compares the result byte-for-byte against the bay
//   registry, which stores canonical codes and nothing else.
export function dropBay(plan) {
  return plan.split('!').pop();
}
