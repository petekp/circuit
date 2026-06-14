import { z } from 'zod';

export type EditFileTiming = 'before' | 'after';

export type ReportFileSurfaceExtractorDeclaration =
  | {
      readonly kind: 'string-array-field';
      readonly field: string;
    }
  | {
      readonly kind: 'build-plan-and-slices-anticipated-file-extensions';
    };

export interface ReportFileSurfaceDeclaration {
  readonly timing: EditFileTiming;
  readonly extractor: ReportFileSurfaceExtractorDeclaration;
}

// Stage 3b (first-class composition): the serialized zod shape of a report's
// file surface. One schema, two homes — the authored FlowSchematic carries it so
// a flow DECLARES which written reports are edit-file surfaces, and the compiled
// manifest carries it so the engine READS those surfaces without a by-id catalog
// package lookup. The shape is identical to the in-code
// `ReportFileSurfaceDeclaration` above (no camelCase rename), so the
// manifest->runtime boundary passes it through; the assignment site type-checks
// the correspondence. Absent = the flow declares no file surfaces.
export const ReportFileSurfaceExtractor = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('string-array-field'), field: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('build-plan-and-slices-anticipated-file-extensions') }).strict(),
]);

export const ReportFileSurface = z
  .object({
    timing: z.enum(['before', 'after']),
    extractor: ReportFileSurfaceExtractor,
  })
  .strict();

// Keyed by the report's schema name (e.g. 'build.plan@v1').
export const ReportFileSurfaceMap = z.record(z.string().min(1), ReportFileSurface);
export type ReportFileSurfaceMap = z.infer<typeof ReportFileSurfaceMap>;
