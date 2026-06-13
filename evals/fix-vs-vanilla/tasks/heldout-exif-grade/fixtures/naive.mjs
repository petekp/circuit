// Capture-attribute grading for the photo culling pass. The culling
// profile hands this module a pair of marks per attribute; shots are
// graded one attribute at a time.

/**
 * Grade one numeric capture attribute against the culling profile's two
 * marks, returning 'keep', 'review', or 'reject'.
 *
 * The relative placement of the two marks tells the grader which end of
 * the scale is poor. With reviewAt placed below rejectAt, larger values
 * are poorer — as with sensor gain (ISO), where a high value means heavy
 * grain. With reviewAt placed above rejectAt, smaller values are poorer —
 * as with a focus score, where a low value means a blurred shot. The two
 * marks are distinct in any profile.
 *
 * In either placement, a value at or past rejectAt (measured toward the
 * poor end of the scale) grades 'reject'; otherwise a value at or past
 * reviewAt grades 'review'; anything else grades 'keep'.
 */
export function exifGrade(value, reviewAt, rejectAt) {
  if (value >= rejectAt) return 'reject';
  if (value >= reviewAt) return 'review';
  return 'keep';
}
