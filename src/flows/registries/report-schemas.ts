// Relay-report schema registry + parse helper.
//
// The REGISTRY is built from src/flows/catalog.ts via
// buildReportSchemaRegistry, plus the engine-built-in schemas from
// src/schemas/builtin-report-schemas.ts.
//
// Fail-closed default. When `writes.report.schema` names a schema
// that is NOT present in the registry below, `parseReport` returns
// a fail result and the runner aborts the step. The contract MUST at
// src/flows/explore/contract.md does not admit a "schema unknown → pass"
// path; a future slice that lands a schema authoring surface MUST keep
// fail-closed as the default for unknown schema names.
//
// TraceEntry-surface uniformity. This content/schema-failure path does NOT
// emit `relay.failed`; that trace_entry is reserved for connector
// invocation exceptions, where no connector result exists. A parse
// failure is surfaced through the reject-on-bad-verdict sequence:
//   check.evaluated outcome=fail (reason=the parse error)
//   → step.aborted (reason byte-identical)
//   → run.closed outcome=aborted (reason byte-identical)
//   → RunResult.reason mirrors the close reason.

import type { z } from 'zod';
import { BUILTIN_REPORT_SCHEMAS } from '../../schemas/builtin-report-schemas.js';
import { buildReportSchemaRegistry } from '../catalog-derivations.js';
import { flowPackages } from '../catalog.js';

// channels:'relay' on purpose — this registry only parses connector
// relay result bodies. channel:'report' schemas (compose/close/
// verification/checkpoint/sub-run reports) are validated by the
// run-file validator instead; keeping them out of this registry is
// what makes a channel:'report' name on a relay step fail closed.
const REGISTRY = buildReportSchemaRegistry(flowPackages, {
  channels: 'relay',
  fixtures: BUILTIN_REPORT_SCHEMAS,
});

export type ReportParseResult =
  // `data` is the schema's OUTPUT, not the raw body: defaults are materialized
  // and transforms have run. Callers that persist a relay report write this,
  // so what lands in the run folder is the shape the schema actually admits.
  | { readonly kind: 'ok'; readonly data: unknown }
  | { readonly kind: 'fail'; readonly reason: string };

// Resolve the Zod schema for a registered report name, or undefined when
// the schema is not registered. Used by the relay executor to convert
// the schema to JSON Schema for connectors that support structured
// output flags (claude-code's `--json-schema`, codex's `--output-schema`).
export function findReportZodSchema(schemaName: string): z.ZodType<unknown> | undefined {
  if (!Object.hasOwn(REGISTRY, schemaName)) return undefined;
  return REGISTRY[schemaName] as z.ZodType<unknown>;
}

export function parseReport(schemaName: string, resultBody: string): ReportParseResult {
  if (!Object.hasOwn(REGISTRY, schemaName)) {
    return {
      kind: 'fail',
      reason: `report schema '${schemaName}' is not registered in the report-schema registry (fail-closed default)`,
    };
  }
  const schema = REGISTRY[schemaName] as z.ZodType<unknown>;

  let parsed: unknown;
  try {
    parsed = JSON.parse(resultBody);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      kind: 'fail',
      reason: `report body did not parse as JSON against schema '${schemaName}' (${msg})`,
    };
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issueSummary = result.error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
        return `${path}: ${issue.message}`;
      })
      .join('; ');
    return {
      kind: 'fail',
      reason: `report body did not validate against schema '${schemaName}' (${issueSummary})`,
    };
  }
  return { kind: 'ok', data: result.data };
}
