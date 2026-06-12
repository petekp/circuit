// Notification quiet hours. A window runs from `startHour` up to `endHour` on
// the 24-hour clock and wraps past midnight when the end hour is the earlier one.
export function inQuietHours(hour, startHour, endHour) {
  return hour >= startHour && hour < endHour;
}

// Hour-by-hour mute preview shown on the notification settings page.
export function mutedHours(startHour, endHour) {
  const hours = [];
  for (let h = startHour; h < endHour; h += 1) {
    hours.push(h);
  }
  return hours;
}
