// Pure derivation helpers that turn flow packages into engine
// registries. Each registry file delegates to one of these so the
// derivation logic (with its duplicate-detection and default-package
// invariants) is testable in isolation against synthetic packages.

import type { z } from 'zod';
import type { ReportFileSurfaceDeclaration } from '../schemas/report-file-surface.js';
import type { CheckpointBriefBuilder } from './registries/checkpoint-writers/types.js';
import type { CloseBuilder } from './registries/close-writers/types.js';
import type { ComposeBuilder } from './registries/compose-writers/types.js';
import type { CrossReportValidator } from './registries/cross-report-validators.js';
import type { StructuralShapeHint } from './registries/shape-hints/types.js';
import type { VerificationBuilder } from './registries/verification-writers/types.js';
import type { CompiledFlowPackage, CompiledFlowRuntimeSurface } from './types.js';

// Collect a Map keyed by builder.resultSchemaName from one writer slot
// across all packages. Throws on duplicate keys with a message that
// names both the slot and the offending flow id.
function collectBuilderRegistry<B extends { readonly resultSchemaName: string }>(
  packages: readonly CompiledFlowPackage[],
  slot: 'compose' | 'close' | 'verification' | 'checkpoint',
  pluck: (pkg: CompiledFlowPackage) => readonly B[],
): ReadonlyMap<string, B> {
  const map = new Map<string, B>();
  for (const pkg of packages) {
    for (const builder of pluck(pkg)) {
      if (map.has(builder.resultSchemaName)) {
        throw new Error(
          `duplicate ${slot} builder registered for schema '${builder.resultSchemaName}' (flow ${pkg.id})`,
        );
      }
      map.set(builder.resultSchemaName, builder);
    }
  }
  return map;
}

export function buildComposeRegistry(
  packages: readonly CompiledFlowPackage[],
): ReadonlyMap<string, ComposeBuilder> {
  return collectBuilderRegistry(packages, 'compose', (pkg) => pkg.writers.compose);
}

export function buildCloseRegistry(
  packages: readonly CompiledFlowPackage[],
): ReadonlyMap<string, CloseBuilder> {
  return collectBuilderRegistry(packages, 'close', (pkg) => pkg.writers.close);
}

export function buildVerificationRegistry(
  packages: readonly CompiledFlowPackage[],
): ReadonlyMap<string, VerificationBuilder> {
  return collectBuilderRegistry(packages, 'verification', (pkg) => pkg.writers.verification);
}

export function buildCheckpointRegistry(
  packages: readonly CompiledFlowPackage[],
): ReadonlyMap<string, CheckpointBriefBuilder> {
  return collectBuilderRegistry(packages, 'checkpoint', (pkg) => pkg.writers.checkpoint);
}

// Compose the relay-report zod registry from the catalog plus an
// optional fixtures map (used by tests). Throws when a schema name
// collides between fixtures and packages, or across packages.
export function buildReportSchemaRegistry(
  packages: readonly CompiledFlowPackage[],
  fixtures: Readonly<Record<string, z.ZodType<unknown>>> = {},
): Readonly<Record<string, z.ZodType<unknown>>> {
  const out: Record<string, z.ZodType<unknown>> = { ...fixtures };
  for (const pkg of packages) {
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

// Schema-keyed relay shape hints. Throws on duplicates so a hint
// authoring error fails loudly at registry construction.
export function buildSchemaHintMap(
  packages: readonly CompiledFlowPackage[],
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const pkg of packages) {
    for (const report of pkg.relayReports) {
      if (report.relayHint === undefined) continue;
      if (map.has(report.schemaName)) {
        throw new Error(
          `duplicate shape hint registered for schema '${report.schemaName}' (flow ${pkg.id})`,
        );
      }
      map.set(report.schemaName, report.relayHint);
    }
  }
  return map;
}

export function buildCrossReportValidatorRegistry(
  packages: readonly CompiledFlowPackage[],
): ReadonlyMap<string, CrossReportValidator> {
  const map = new Map<string, CrossReportValidator>();
  for (const pkg of packages) {
    for (const report of pkg.relayReports) {
      if (report.crossReportValidate === undefined) continue;
      if (map.has(report.schemaName)) {
        throw new Error(
          `duplicate cross-report validator registered for schema '${report.schemaName}' (flow ${pkg.id})`,
        );
      }
      map.set(report.schemaName, report.crossReportValidate);
    }
  }
  return map;
}

export function buildStructuralHintList(
  packages: readonly CompiledFlowPackage[],
): readonly StructuralShapeHint[] {
  const list: StructuralShapeHint[] = [];
  const seen = new Set<string>();
  for (const pkg of packages) {
    if (pkg.structuralHints === undefined) continue;
    for (const hint of pkg.structuralHints) {
      if (seen.has(hint.id)) {
        throw new Error(`duplicate structural shape hint id '${hint.id}' (flow ${pkg.id})`);
      }
      seen.add(hint.id);
      list.push(hint);
    }
  }
  return list;
}

export function buildRuntimeSurfaceRegistry(
  packages: readonly CompiledFlowPackage[],
): ReadonlyMap<string, CompiledFlowRuntimeSurface> {
  const map = new Map<string, CompiledFlowRuntimeSurface>();
  for (const pkg of packages) {
    if (pkg.runtimeSurface === undefined) continue;
    if (map.has(pkg.id)) {
      throw new Error(`duplicate runtime surface registered for flow '${pkg.id}'`);
    }
    map.set(pkg.id, pkg.runtimeSurface);
  }
  return map;
}

export function buildReportFileSurfaceRegistry(
  packages: readonly CompiledFlowPackage[],
): Readonly<Record<string, ReportFileSurfaceDeclaration>> {
  const out: Record<string, ReportFileSurfaceDeclaration> = {};
  for (const pkg of packages) {
    for (const [schemaName, declaration] of Object.entries(pkg.reportFileSurfaces ?? {})) {
      if (Object.hasOwn(out, schemaName)) {
        throw new Error(
          `duplicate report file surface registered for schema '${schemaName}' (flow ${pkg.id})`,
        );
      }
      out[schemaName] = declaration;
    }
  }
  return Object.freeze(out);
}
