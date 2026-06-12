// Naive fix: reach for node:path's extname, the canonical idiom for the
// reported symptom. It handles the no-dot case, dotted directory names, and
// dotfiles natively -- but it preserves case, and the module contract reports
// the tag lowercased, so uppercase camera-style uploads still mis-tag.
import { extname } from 'node:path';

export function fileExtension(path) {
  return extname(path).slice(1);
}
