import { clamp } from './clamp.mjs';

// Volume must stay within 0..100. Should use clamp once it exists.
export function setVolume(requested) {
  return clamp(0, 100, requested);
}
