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
