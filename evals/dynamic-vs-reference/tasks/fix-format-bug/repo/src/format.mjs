// Format a date as YYYY-MM-DD. Single-digit months and days must keep a
// leading zero.
export function formatDate(year, month, day) {
  return `${year}-${pad(month)}-${day}`;
}

function pad(n) {
  return String(n);
}
