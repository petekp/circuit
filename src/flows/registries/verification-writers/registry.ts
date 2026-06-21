// Registry of verification writers, keyed by output schema name.
//
// Builders come from src/flows/catalog.ts via buildVerificationRegistry.

import { buildVerificationRegistry } from '../../catalog-derivations.js';
import { flowPackages } from '../../catalog.js';
import { type RuntimeIndexedFlow, reportPathForSchemaInRuntimeFlow } from '../runtime-index.js';
import type { VerificationBuilder, VerificationStep } from './types.js';

const REGISTRY = buildVerificationRegistry(flowPackages);

export function findVerificationWriter(resultSchemaName: string): VerificationBuilder | undefined {
  return REGISTRY.get(resultSchemaName);
}

// Every registered verification writer, as [resultSchemaName, builder] pairs. The
// source-coverage test enumerates this so a newly-added writer cannot slip in
// without declaring its source reads (or being explicitly marked uncoupled).
export function listVerificationWriters(): readonly (readonly [string, VerificationBuilder])[] {
  return [...REGISTRY.entries()];
}

// Resolve a verification builder's declared reads against a specific runtime flow
// + step, the same way loadCommands enforces them: each REQUIRED read's report
// path must be produced by some step AND listed in the verification step's reads,
// or it throws with the writer's own "requires step '<id>' to read <path>"
// phrasing. Builders that declare no reads resolve to an empty map (nothing to
// check). This is the offline mirror the runnability floor uses so a composed
// verification step whose source is unwired is caught before it runs, not after.
export function resolveVerificationReadPaths(
  builder: VerificationBuilder,
  flow: RuntimeIndexedFlow,
  step: VerificationStep,
): Record<string, string> {
  const paths: Record<string, string> = {};
  for (const descriptor of builder.reads ?? []) {
    if (!descriptor.required) continue;
    const path = reportPathForSchemaInRuntimeFlow(flow, descriptor.schema);
    if (!step.reads.includes(path as never)) {
      throw new Error(`${builder.resultSchemaName} requires step '${step.id}' to read ${path}`);
    }
    paths[descriptor.name] = path;
  }
  return paths;
}
