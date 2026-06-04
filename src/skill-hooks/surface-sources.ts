// Edit-file surface sources — the per-flow declaration the dispatcher reads.
//
// The `after:edit-files` / `before:edit-files` hooks key on a file surface that a
// step wrote into a typed report, but the field that carries it is named per
// flow (the first-principles doc's "per-flow-declared self-report field"). This
// table maps a report schema id to (a) whether its surface is a PREDICTED
// pre-act surface (`before`) or the ACTUAL touched surface (`after`), and (b)
// how to pull the surface strings out of the report body.
//
// It is data, not flow-name branching: the dispatcher consults this table by
// report-schema string and never names a flow, so the "no flow names in the
// dispatcher" principle holds and the engine stays flow-agnostic. See
// docs/ideas/skill-hooks-dispatch-spec.md (D2).

export type EditFileTiming = 'before' | 'after';

export interface EditFileSurfaceSource {
  // 'after' reports carry actual touched paths; 'before' reports carry a
  // predicted surface (extensions/globs). The dispatcher only tests a report's
  // surface against hook keys of the matching timing.
  readonly timing: EditFileTiming;
  // Pull the surface strings (paths or extensions) out of the report body.
  // Returns [] for a malformed or absent field — never throws.
  readonly extract: (report: unknown) => readonly string[];
}

function stringArrayField(report: unknown, field: string): readonly string[] {
  if (report === null || typeof report !== 'object') return [];
  const value = (report as Record<string, unknown>)[field];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

// Build's predicted surface lives at two levels: the plan-level
// `anticipated_file_extensions` and each slice's own
// `slices[].anticipated_file_extensions`. Union them so a slice-specific
// extension still routes even when it is absent from the plan-level list.
function planAndSliceExtensions(report: unknown): readonly string[] {
  const top = stringArrayField(report, 'anticipated_file_extensions');
  const slices =
    report !== null &&
    typeof report === 'object' &&
    Array.isArray((report as Record<string, unknown>).slices)
      ? ((report as Record<string, unknown>).slices as unknown[]).flatMap((slice) =>
          stringArrayField(slice, 'anticipated_file_extensions'),
        )
      : [];
  return [...new Set([...top, ...slices])];
}

// v1 table. Seeded on Fix (the flow that already has both halves of the loop)
// and extended to Build by later slices.
export const EDIT_FILE_SURFACE_SOURCES: Readonly<Record<string, EditFileSurfaceSource>> = {
  // Fix: the runtime-computed change-set. `observed` is the ground-truth set of
  // actual touched paths (already computed against the baseline snapshot), so
  // it is the strongest `after:edit-files` surface in the codebase.
  'fix.change-set@v1': {
    timing: 'after',
    extract: (report) => stringArrayField(report, 'observed'),
  },
  // Build: the plan's predicted surface (a `compose` step, so it crosses the
  // trace as step.report_written). This is the `before:edit-files` prediction
  // arm — the advisory extensions the repo-grounded plan expects to touch, at
  // plan- and per-slice level. Build's actual touched-files self-report
  // (`build.implementation@v1` `changed_files`) is a relay report, not a
  // step.report_written, so the `after` arm on Build is a later follow-up
  // (Fix's change-set already proves the `after` arm).
  'build.plan@v1': {
    timing: 'before',
    extract: planAndSliceExtensions,
  },
};
