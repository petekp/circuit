import type { z } from 'zod';
import { flowPackages } from '../../flows/catalog.js';
import { BUILTIN_REPORT_SCHEMAS } from '../../schemas/builtin-report-schemas.js';

export type ReportValidator = (schemaName: string, value: unknown) => void;

// NOTE: deliberately NOT buildReportSchemaRegistry from
// src/flows/catalog-derivations.ts — that registry covers only
// pkg.relayReports. This validator also admits the channel:'report'
// schemas (pkg.reportSchemas), which live flows declare, and uses a
// distinct duplicate message for that branch.
function buildReportValidationRegistry(): Readonly<Record<string, z.ZodType<unknown>>> {
  const out: Record<string, z.ZodType<unknown>> = { ...BUILTIN_REPORT_SCHEMAS };
  for (const pkg of flowPackages) {
    for (const report of pkg.reportSchemas ?? []) {
      if (Object.hasOwn(out, report.schemaName)) {
        throw new Error(
          `duplicate report schema '${report.schemaName}' registered (flow ${pkg.id})`,
        );
      }
      out[report.schemaName] = report.schema;
    }
    for (const report of pkg.relayReports) {
      if (Object.hasOwn(out, report.schemaName)) {
        throw new Error(
          `duplicate relay report schema '${report.schemaName}' registered (flow ${pkg.id})`,
        );
      }
      out[report.schemaName] = report.schema;
    }
  }
  return Object.freeze(out);
}

const REGISTRY = buildReportValidationRegistry();

export const validateReportValue: ReportValidator = (schemaName, value) => {
  if (!Object.hasOwn(REGISTRY, schemaName)) {
    throw new Error(
      `report schema '${schemaName}' is not registered in the report-schema registry (fail-closed default)`,
    );
  }
  const schema = REGISTRY[schemaName] as z.ZodType<unknown>;
  const result = schema.safeParse(value);
  if (!result.success) {
    const issueSummary = result.error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
        return `${path}: ${issue.message}`;
      })
      .join('; ');
    throw new Error(
      `report body did not validate against schema '${schemaName}' (${issueSummary})`,
    );
  }
};
