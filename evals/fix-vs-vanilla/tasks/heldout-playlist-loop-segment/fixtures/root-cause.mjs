/**
 * Reports whether a playlist spot sits inside the featured segment.
 *
 * A playlist set to repeat is a ring of `playlistLength` spots, numbered 0
 * through playlistLength - 1. The pair (segmentStart, segmentEnd) describes
 * the segment the same way for any code in this module that reads it: the
 * segment begins at segmentStart (inclusive) and advances one spot at a
 * time, rolling from the final spot back to spot 0, until it reaches
 * segmentEnd (exclusive). So when segmentEnd is smaller than segmentStart,
 * the segment covers the tail of the playlist from segmentStart onward and
 * continues through the head up to (but not including) segmentEnd. When the
 * two values are equal, the segment is empty.
 */
export function isTrackInSegment(spot, segmentStart, segmentEnd, playlistLength) {
  if (segmentEnd < segmentStart) {
    return spot >= segmentStart || spot < segmentEnd;
  }
  return spot >= segmentStart && spot < segmentEnd;
}

// Builds the spot list shown on the Coming Up rail in the player sidebar.
export function segmentTrackRoster(segmentStart, segmentEnd, playlistLength) {
  const segmentLength = (segmentEnd - segmentStart + playlistLength) % playlistLength;
  return Array.from({ length: segmentLength }, (_, step) => (segmentStart + step) % playlistLength);
}
