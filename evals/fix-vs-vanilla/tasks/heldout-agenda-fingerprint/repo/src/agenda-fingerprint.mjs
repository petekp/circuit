// Identifier builders for the conference scheduling pipeline.
//
// Family contract: a builder in this file gives logically equal field
// collections byte-identical identifiers, no matter the sequence in
// which the call site assembled the fields. Field labels serialize in
// plain ascending lexicographic sort, and each builder keeps its own
// output format stable for its downstream consumer.

// Agenda merge: drops duplicate bookings imported from more than one
// calendar.
export function bookingFingerprint(kind, fields) {
  const parts = [];
  for (const [label, value] of Object.entries(fields)) {
    parts.push(`${label}=${value}`);
  }
  return `${kind}|${parts.join(';')}`;
}

// Reminder fan-out: groups jobs so one reminder goes out per distinct
// session.
export function reminderDigest(kind, fields) {
  let body = '';
  for (const slot in fields) {
    if (body !== '') {
      body += ',';
    }
    body += slot + ':' + fields[slot];
  }
  return kind + '::' + body;
}
