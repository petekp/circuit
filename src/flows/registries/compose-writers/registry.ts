// Registry of compose writers, keyed by output schema name.
//
// Builders come from src/flows/catalog.ts via buildComposeRegistry.

import { buildComposeRegistry } from '../../catalog-derivations.js';
import { flowPackages } from '../../catalog.js';
import {
  type RuntimeIndexedFlow,
  flowHasReportSchemaInRuntimeFlow,
  reportPathForSchemaInRuntimeFlow,
} from '../runtime-index.js';
import type { ComposeBuilder, ComposeStep } from './types.js';

const REGISTRY = buildComposeRegistry(flowPackages);

export function findComposeBuilder(resultSchemaName: string): ComposeBuilder | undefined {
  return REGISTRY.get(resultSchemaName);
}

// Every registered compose builder, keyed by output schema. The compose-reads
// collision guard enumerates these to prove no required read name shadows a
// declared input key (mirrors listVerificationWriters for the verification side).
export function listComposeWriters(): readonly (readonly [string, ComposeBuilder])[] {
  return [...REGISTRY.entries()];
}

// Resolve declared reads to run-relative paths and check that each
// required read is actually present in the compose step's reads
// list. Required-but-missing throws with the same phrasing the
// runner used historically so error message stability is preserved.
// Builders that omit `reads` get an empty inputs map and resolve
// paths themselves inside build().
//
// An optional read whose schema has no producer in this flow resolves to
// undefined rather than throwing: optional genuinely means the read may be
// absent, including in reduced flows that omit the producing stage. A
// required read still demands exactly one producer, and an ambiguous
// (>1 producer) schema still throws for required and optional alike.
export function resolveComposeReadPaths(
  builder: ComposeBuilder,
  flow: RuntimeIndexedFlow,
  step: ComposeStep,
): Record<string, string | undefined> {
  const paths: Record<string, string | undefined> = {};
  if (builder.reads === undefined) return paths;
  for (const descriptor of builder.reads) {
    if (!descriptor.required && !flowHasReportSchemaInRuntimeFlow(flow, descriptor.schema)) {
      paths[descriptor.name] = undefined;
      continue;
    }
    const path = reportPathForSchemaInRuntimeFlow(flow, descriptor.schema);
    if (descriptor.required && !step.reads.includes(path as never)) {
      throw new Error(`${step.writes.report.schema} requires step '${step.id}' to read ${path}`);
    }
    paths[descriptor.name] = step.reads.includes(path as never) ? path : undefined;
  }
  return paths;
}
