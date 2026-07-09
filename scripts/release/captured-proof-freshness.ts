// Freshness guard for the captured golden proofs that are produced OUTSIDE the
// scenario loop (doctor, handoff, customization). Those captures were never
// re-checked by `--validate-stubs`, so a capture could pin an old Circuit
// version at a newer HEAD and still back a `verified_current` public claim.
//
// This is the pure, unit-testable half of that guard: given the current release
// version and each capture's discovered files, it returns one operator-facing
// message per staleness — a version-drifted `runtime_version`, or a capture
// with no files at all. The capture script (capture-golden-run-proofs.ts) walks
// the proof directories and feeds the results in, mirroring how
// proof-recency.ts backs the scenario stub-freshness guard.

export type CapturedProofFile = {
  /** Repo-relative path, for operator-facing messages. */
  readonly rel: string;
  /** File contents (read as utf8). */
  readonly content: string;
};

export type CapturedProof = {
  readonly slug: string;
  /** Repo-relative capture directory, reported when the capture is empty. */
  readonly dirRel: string;
  /** Every file discovered under dirRel. Empty when the capture is missing. */
  readonly files: readonly CapturedProofFile[];
};

export type CapturedProofFreshnessInput = {
  /** Current plugins/version.json version — the source of truth. */
  readonly currentVersion: string;
  readonly captures: readonly CapturedProof[];
};

// Matches the Circuit runtime version a `circuit doctor` capture records, e.g.
//   "runtime_version": "0.1.0-alpha.9"
// The exact-quote closing after `runtime_version` avoids matching the unrelated
// check name "runtime_version_executes".
const RUNTIME_VERSION_RE = /"runtime_version"\s*:\s*"([^"]+)"/g;

function recaptureHint(slug: string): string {
  return `re-run \`npm run capture-proofs:golden-runs -- --scenario ${slug}\` at the release/tag cut`;
}

export function capturedProofFreshnessFailures(input: CapturedProofFreshnessInput): string[] {
  const failures: string[] = [];
  for (const capture of input.captures) {
    if (capture.files.length === 0) {
      failures.push(
        `captured proof '${capture.slug}' has no files under ${capture.dirRel}; ${recaptureHint(capture.slug)}.`,
      );
      continue;
    }
    for (const file of capture.files) {
      for (const match of file.content.matchAll(RUNTIME_VERSION_RE)) {
        const pinned = match[1];
        if (pinned !== undefined && pinned !== input.currentVersion) {
          failures.push(
            `captured proof '${capture.slug}' pins runtime_version '${pinned}' in ${file.rel} but the current release is '${input.currentVersion}'; the capture is stale. ${recaptureHint(capture.slug)}.`,
          );
        }
      }
    }
  }
  return failures;
}
