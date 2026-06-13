/**
 * Reads the desk assignment out of one printed seating-chart cell.
 *
 * A cell carries up to three pieces, in this printed sequence:
 *
 *   - the student's roster text, e.g. "Nguyen, Bao"
 *   - parenthesized remarks, e.g. "(locker #214)"; teachers also park a
 *     student's old desk code inside a remark, e.g. "(was #C4)"
 *   - the desk assignment: the marker "#" immediately followed by a desk
 *     code, printed after any remarks; padding spaces from chart exports
 *     may follow it
 *
 * A desk code is a capital row letter A-F followed by the desk number 1-24.
 *
 * Guarantees:
 *   1. Only a "#" printed after the closing remark (or anywhere in the cell
 *      when it has no remarks) introduces an assignment; a "#" inside a
 *      remark belongs to that remark's text.
 *   2. A cell with no student text - one that begins with "#" once remarks
 *      and surrounding spaces are set aside - is a spare-desk placeholder.
 *      Nobody sits there, so it carries no assignment.
 *   3. The returned code is in canonical chart form: the "#" marker is not
 *      part of it, padding spaces are stripped, and a desk number an export
 *      padded to two digits is reported unpadded ("#B07" reads back as "B7").
 *   4. A cell with no assignment returns "".
 */
export function deskOf(cell) {
  // Guarantee 1: only the stretch after the closing remark can carry the
  // assignment marker.
  const closeAt = cell.lastIndexOf(")");
  const candidate = closeAt === -1 ? cell : cell.slice(closeAt + 1);
  const markAt = candidate.lastIndexOf("#");
  if (markAt === -1) return "";

  // Guarantee 2: with remarks set aside, a cell that begins with the marker
  // is a spare-desk placeholder, not a seated student.
  const occupant = cell.replace(/\([^)]*\)/g, " ").trimStart();
  if (occupant.startsWith("#")) return "";

  // Guarantee 3: report the code in canonical chart form - strip padding
  // spaces and any padded 0 in front of the desk number.
  const found = candidate
    .slice(markAt + 1)
    .trimEnd()
    .match(/^([A-F])0*([1-9]\d*)$/);
  if (found === null) return "";
  return found[1] + found[2];
}
