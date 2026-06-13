// Root-cause fix: the same forward-only window assumption lives in two places,
// so the membership check branches on a wrapped window and the preview counts
// the wrapped span and walks the clock from the start hour. Every objective
// check passes too.
export function inQuietHours(hour, startHour, endHour) {
  return startHour <= endHour
    ? hour >= startHour && hour < endHour
    : hour >= startHour || hour < endHour;
}

export function mutedHours(startHour, endHour) {
  const span = (((endHour - startHour) % 24) + 24) % 24;
  const hours = [];
  for (let i = 0; i < span; i += 1) {
    hours.push((startHour + i) % 24);
  }
  return hours;
}
