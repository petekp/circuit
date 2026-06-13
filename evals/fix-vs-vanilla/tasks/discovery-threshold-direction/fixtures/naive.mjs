// Naive fix: the standard ascending severity ladder, a complete-looking answer
// to the latency story and the visible test. It assumes higher readings are
// worse, so a threshold pair with the critical level below the warn level
// (free-disk-style metrics) gets classified backwards. This is the trap.
export function severityOf(value, warnAt, critAt) {
  if (value >= critAt) return 'critical';
  if (value >= warnAt) return 'warn';
  return 'ok';
}
