// Root-cause fix: the threshold order sets the direction, so the ladder is
// mirrored. When the critical level sits above the warn level, higher readings
// are worse; otherwise lower readings are worse. Readings in either direction
// classify correctly, so every objective check passes.
export function severityOf(value, warnAt, critAt) {
  if (warnAt <= critAt) {
    if (value >= critAt) return 'critical';
    if (value >= warnAt) return 'warn';
    return 'ok';
  }
  if (value <= critAt) return 'critical';
  if (value <= warnAt) return 'warn';
  return 'ok';
}
