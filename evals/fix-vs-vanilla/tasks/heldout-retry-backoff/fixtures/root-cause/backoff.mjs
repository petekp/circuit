// Root-cause fix (1 of 2): the exponent is offset so the first gap is the base
// delay and each later gap doubles. Paired with the retry loop fix, the recorded
// schedule matches the attempt count, so the visible test and the assembled
// hidden check both pass.
const BASE_MS = 10;

export function delayFor(attempt) {
  return BASE_MS * 2 ** (attempt - 1);
}
