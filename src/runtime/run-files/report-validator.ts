import type { z } from 'zod';
import { buildReportSchemaRegistry } from '../../flows/catalog-derivations.js';
import { flowPackages } from '../../flows/catalog.js';
import { BUILTIN_REPORT_SCHEMAS } from '../../schemas/builtin-report-schemas.js';

export type ReportValidator = (schemaName: string, value: unknown) => void;

// channels:'relay+report' on purpose — run-file validation covers
// EVERY report written into a run dir: compose / close / verification
// / checkpoint / sub-run reports (channel:'report') as well as
// materialized relay reports. parseReport's registry
// (src/flows/registries/report-schemas.ts) stays channels:'relay'.
const REGISTRY = buildReportSchemaRegistry(flowPackages, {
  channels: 'relay+report',
  fixtures: BUILTIN_REPORT_SCHEMAS,
});

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
