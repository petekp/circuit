// Pure rendering-decision helpers for the Claude present wrapper. Kept
// side-effect free (no fs/spawn at import) so they can be unit-tested directly;
// the wrapper injects its fs probes (existsSync) and a result.json reader.

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// The final user-facing answer Markdown path. Per
// docs/contracts/host-rendering.md "Final Rendering", hosts MUST read
// `operator_summary_markdown_path` (the readable digest) when present and only
// fall back to `run_surface_markdown_path` (the compact Run surface, a status
// line plus artifact links) when the digest is absent. Returns the first of
// those that actually exists on disk.
export function finalAnswerMarkdownPath(
  result: Record<string, unknown>,
  exists: (path: string) => boolean,
): string | undefined {
  const operatorSummary = stringField(result, 'operator_summary_markdown_path');
  if (operatorSummary !== undefined && exists(operatorSummary)) return operatorSummary;
  const runSurface = stringField(result, 'run_surface_markdown_path');
  if (runSurface !== undefined && exists(runSurface)) return runSurface;
  return undefined;
}

// The abort reason for the present wrapper's no-blocks branch. Prefer the
// `reason` the runtime now copies onto the stdout envelope (F-H-2); when it is
// absent (an older runtime, or a non-streaming host whose envelope omits it)
// fall back to reading the specific reason from reports/result.json via
// `result_path`. Returns undefined only when neither source carries a reason,
// leaving the caller to use its generic fallback.
export function presentAbortReason(
  result: Record<string, unknown>,
  loadResultReason: (resultPath: string) => string | undefined,
): string | undefined {
  const direct = stringField(result, 'reason');
  if (direct !== undefined) return direct;
  const resultPath = stringField(result, 'result_path');
  if (resultPath === undefined) return undefined;
  return loadResultReason(resultPath);
}

export interface DeliberateClosePresentation {
  readonly headline: string;
  readonly reason?: string;
}

// stopped/escalated/handoff closes exit nonzero so scripts never chain onto
// unfinished work, but they are deliberate closes, not crashes: the operator
// chose stop, the flow escalated for human attention, or continuity was
// handed off. The wrapper renders the run's own status text for them and
// must never print the generic "Circuit run failed" line. Returns undefined
// for every other outcome so aborts and successes keep their branches.
export function deliberateClosePresentation(
  result: Record<string, unknown>,
  loadResultReason: (resultPath: string) => string | undefined,
): DeliberateClosePresentation | undefined {
  const outcome = stringField(result, 'outcome');
  if (outcome !== 'stopped' && outcome !== 'escalated' && outcome !== 'handoff') return undefined;
  const headline =
    stringField(result, 'run_surface_status_text') ?? `Run closed with outcome ${outcome}.`;
  // The close reason rides the same envelope-then-result.json channel aborts use.
  const reason = presentAbortReason(result, loadResultReason);
  return reason === undefined ? { headline } : { headline, reason };
}
