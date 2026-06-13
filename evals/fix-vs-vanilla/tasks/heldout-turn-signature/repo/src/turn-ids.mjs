// Flat identifier builders for the turn engine. Downstream dedupe subsystems
// compare these identifiers byte-for-byte. Each builder in this file
// guarantees one canonical identifier per logical input: a given tag joined
// with a given group of labeled values yields the same string no matter the
// sequence in which the call site assembled the group, with the group's
// labels serialized in ascending lexicographic sequence. Each builder also
// owns a fixed pair-and-delimiter format that its consumer parses.

// Move signatures feed the replay viewer's duplicate-move collapse.
export function moveSignature(moveTag, modifiers) {
  const parts = [];
  for (const [label, value] of Object.entries(modifiers)) {
    parts.push(`${label}=${value}`);
  }
  return `${moveTag}|${parts.join(';')}`;
}

// Event digests feed the spectator broadcast deduper.
export function eventDigest(eventTag, details) {
  let body = '';
  for (const field in details) {
    if (body !== '') body += ',';
    body += field + ':' + details[field];
  }
  return eventTag + '::' + body;
}
