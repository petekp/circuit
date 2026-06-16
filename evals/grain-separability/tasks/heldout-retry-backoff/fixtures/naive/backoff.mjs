// Under the naive fix this module is left UNCHANGED from the shipped repo: the
// exponent still uses the raw attempt number, so the recorded delay schedule is
// one step too large and the assembled hidden check fails.
const BASE_MS = 10;

export function delayFor(attempt) {
  return BASE_MS * 2 ** attempt;
}
