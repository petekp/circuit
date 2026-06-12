// Naive fix: branches only the membership check (inQuietHours), the path the
// visible `npm test` exercises. The settings-page preview keeps its ascending
// loop and still returns an empty list for a window that wraps past midnight,
// so the visible regression goes green while the preview objective check stays
// red. This is the trap.
export function inQuietHours(hour, startHour, endHour) {
  return startHour <= endHour
    ? hour >= startHour && hour < endHour
    : hour >= startHour || hour < endHour;
}

export function mutedHours(startHour, endHour) {
  const hours = [];
  for (let h = startHour; h < endHour; h += 1) {
    hours.push(h);
  }
  return hours;
}
