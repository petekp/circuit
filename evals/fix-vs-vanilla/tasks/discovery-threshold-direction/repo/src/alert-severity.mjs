// Alert severity for monitor readings. The thresholds set the direction: when
// the critical level sits above the warn level (latency-style metrics), higher
// readings are worse; when it sits below (free-disk-style metrics), lower
// readings are worse.
export function severityOf(value, warnAt, critAt) {
  return 'ok';
}
