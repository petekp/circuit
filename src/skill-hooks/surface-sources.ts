// Edit-file surface sources — the dispatcher-facing projection of per-flow
// serializable declarations.
//
// The `after:edit-files` / `before:edit-files` hooks key on a file surface that a
// step wrote into a typed report, but the field that carries it is named per
// flow (the first-principles doc's "per-flow-declared self-report field"). This
// table maps a report schema id to (a) whether its surface is a PREDICTED
// pre-act surface (`before`) or the ACTUAL touched surface (`after`), and (b)
// how to pull the surface strings out of the report body.
//
// Flow packages own the serializable declaration. This module interprets the
// small tagged-union vocabulary into live extractors for the dispatcher. It
// never imports flow packages, so the "no flow names in the dispatcher"
// principle holds and the engine stays flow-agnostic. See
// docs/ideas/skill-hooks-dispatch-spec.md (D2).

import type {
  EditFileTiming,
  ReportFileSurfaceDeclaration,
  ReportFileSurfaceExtractorDeclaration,
} from '../schemas/report-file-surface.js';

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

function extractorFor(
  declaration: ReportFileSurfaceExtractorDeclaration,
): EditFileSurfaceSource['extract'] {
  if (declaration.kind === 'string-array-field') {
    return (report) => stringArrayField(report, declaration.field);
  }
  return planAndSliceExtensions;
}

export function surfaceSourceFromDeclaration(
  declaration: ReportFileSurfaceDeclaration,
): EditFileSurfaceSource {
  return {
    timing: declaration.timing,
    extract: extractorFor(declaration.extractor),
  };
}

export function surfaceSourcesFromDeclarations(
  declarations: Readonly<Record<string, ReportFileSurfaceDeclaration>>,
): Readonly<Record<string, EditFileSurfaceSource>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(declarations).map(([schemaName, declaration]) => [
        schemaName,
        surfaceSourceFromDeclaration(declaration),
      ]),
    ),
  );
}
