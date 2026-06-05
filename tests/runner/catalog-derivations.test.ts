// Tests the pure derivation helpers that turn flow packages into
// engine registries. Synthetic mini-catalogs let us exercise the
// duplicate-detection and default-package invariants in isolation
// without touching the real flow set.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  buildCheckpointRegistry,
  buildCloseRegistry,
  buildComposeRegistry,
  buildReportFileSurfaceRegistry,
  buildReportSchemaRegistry,
  buildRuntimeSurfaceRegistry,
  buildSchemaHintMap,
  buildStructuralHintList,
  buildVerificationRegistry,
} from '../../src/flows/catalog-derivations.js';
import type { CheckpointBriefBuilder } from '../../src/flows/registries/checkpoint-writers/types.js';
import type { CloseBuilder } from '../../src/flows/registries/close-writers/types.js';
import type { ComposeBuilder } from '../../src/flows/registries/compose-writers/types.js';
import type { StructuralShapeHint } from '../../src/flows/registries/shape-hints/types.js';
import type { VerificationBuilder } from '../../src/flows/registries/verification-writers/types.js';
import { projectFlowReportDeclarations } from '../../src/flows/report-declarations.js';
import type { CompiledFlowPackage } from '../../src/flows/types.js';

function fakePackage(
  opts: Partial<CompiledFlowPackage> & { readonly id: string },
): CompiledFlowPackage {
  return {
    id: opts.id,
    visibility: opts.visibility ?? 'public',
    paths: opts.paths ?? { schematic: `synthetic/${opts.id}.schematic.json` },
    relayReports: opts.relayReports ?? [],
    ...(opts.reportSchemas === undefined ? {} : { reportSchemas: opts.reportSchemas }),
    ...(opts.reportFileSurfaces === undefined
      ? {}
      : { reportFileSurfaces: opts.reportFileSurfaces }),
    writers: opts.writers ?? { compose: [], close: [], verification: [], checkpoint: [] },
    ...(opts.structuralHints === undefined ? {} : { structuralHints: opts.structuralHints }),
    ...(opts.runtimeSurface === undefined ? {} : { runtimeSurface: opts.runtimeSurface }),
    ...(opts.engineFlags === undefined ? {} : { engineFlags: opts.engineFlags }),
  };
}

const fakeComposeBuilder = (schema: string): ComposeBuilder => ({
  resultSchemaName: schema,
  build: () => ({}),
});

const fakeCloseBuilder = (schema: string): CloseBuilder => ({
  resultSchemaName: schema,
  reads: [],
  build: () => ({}),
});

const fakeVerificationBuilder = (schema: string): VerificationBuilder => ({
  resultSchemaName: schema,
  loadCommands: () => [],
  buildResult: () => ({}),
});

const fakeCheckpointBuilder = (schema: string): CheckpointBriefBuilder => ({
  resultSchemaName: schema,
  build: () => ({}),
});

const fakeStructuralHint = (id: string): StructuralShapeHint => ({
  kind: 'structural',
  id,
  match: () => true,
  instruction: `instruction for ${id}`,
});

describe('flow report declarations', () => {
  it('projects package-owned report declarations to legacy report and writer surfaces', () => {
    const schema = z.object({ ok: z.boolean() });
    const composeBuilder = fakeComposeBuilder('a.report@v1');
    const closeBuilder = fakeCloseBuilder('a.result@v1');
    const verificationBuilder = fakeVerificationBuilder('a.verify@v1');
    const checkpointBuilder = fakeCheckpointBuilder('a.brief@v1');

    const projected = projectFlowReportDeclarations([
      {
        schemaName: 'a.relay@v1',
        channel: 'relay',
        schema,
        relayHint: 'emit a.relay JSON',
      },
      {
        schemaName: 'a.brief@v1',
        channel: 'report',
        schema,
        writers: { checkpoint: [checkpointBuilder] },
      },
      {
        schemaName: 'a.report@v1',
        channel: 'report',
        schema,
        fileSurface: {
          timing: 'after',
          extractor: { kind: 'string-array-field', field: 'observed' },
        },
        writers: { compose: [composeBuilder] },
      },
      {
        schemaName: 'a.verify@v1',
        channel: 'report',
        schema,
        writers: { verification: [verificationBuilder] },
      },
      {
        schemaName: 'a.result@v1',
        channel: 'report',
        schema,
        writers: { close: [closeBuilder] },
      },
    ]);

    expect(projected.relayReports.map((report) => report.schemaName)).toEqual(['a.relay@v1']);
    expect(projected.relayReports[0]?.relayHint).toBe('emit a.relay JSON');
    expect(projected.reportSchemas.map((report) => report.schemaName)).toEqual([
      'a.brief@v1',
      'a.report@v1',
      'a.verify@v1',
      'a.result@v1',
    ]);
    expect(projected.reportFileSurfaces).toEqual({
      'a.report@v1': {
        timing: 'after',
        extractor: { kind: 'string-array-field', field: 'observed' },
      },
    });
    expect(projected.writers.compose).toEqual([composeBuilder]);
    expect(projected.writers.close).toEqual([closeBuilder]);
    expect(projected.writers.verification).toEqual([verificationBuilder]);
    expect(projected.writers.checkpoint).toEqual([checkpointBuilder]);
  });
});

describe('catalog-derivations: report file surfaces', () => {
  it('flattens package-owned report file surfaces by schema name', () => {
    const registry = buildReportFileSurfaceRegistry([
      fakePackage({
        id: 'a',
        reportFileSurfaces: {
          'a.report@v1': {
            timing: 'after',
            extractor: { kind: 'string-array-field', field: 'observed' },
          },
        },
      }),
    ]);

    expect(registry).toEqual({
      'a.report@v1': {
        timing: 'after',
        extractor: { kind: 'string-array-field', field: 'observed' },
      },
    });
  });

  it('throws when two packages register a file surface for the same schema', () => {
    const declaration = {
      timing: 'before' as const,
      extractor: { kind: 'build-plan-and-slices-anticipated-file-extensions' as const },
    };

    expect(() =>
      buildReportFileSurfaceRegistry([
        fakePackage({ id: 'a', reportFileSurfaces: { 'shared@v1': declaration } }),
        fakePackage({ id: 'b', reportFileSurfaces: { 'shared@v1': declaration } }),
      ]),
    ).toThrow(/duplicate report file surface registered for schema 'shared@v1' \(flow b\)/);
  });
});

describe('catalog-derivations: builder registries', () => {
  it('flattens compose builders across packages by resultSchemaName', () => {
    const packages = [
      fakePackage({
        id: 'a',
        writers: {
          compose: [fakeComposeBuilder('a.one@v1'), fakeComposeBuilder('a.two@v1')],
          close: [],
          verification: [],
          checkpoint: [],
        },
      }),
      fakePackage({
        id: 'b',
        writers: {
          compose: [fakeComposeBuilder('b.one@v1')],
          close: [],
          verification: [],
          checkpoint: [],
        },
      }),
    ];
    const registry = buildComposeRegistry(packages);
    expect(registry.size).toBe(3);
    expect(registry.get('a.one@v1')).toBeDefined();
    expect(registry.get('a.two@v1')).toBeDefined();
    expect(registry.get('b.one@v1')).toBeDefined();
  });

  it('throws when two packages register compose builders for the same schema', () => {
    const packages = [
      fakePackage({
        id: 'a',
        writers: {
          compose: [fakeComposeBuilder('shared@v1')],
          close: [],
          verification: [],
          checkpoint: [],
        },
      }),
      fakePackage({
        id: 'b',
        writers: {
          compose: [fakeComposeBuilder('shared@v1')],
          close: [],
          verification: [],
          checkpoint: [],
        },
      }),
    ];
    expect(() => buildComposeRegistry(packages)).toThrow(
      /duplicate compose builder registered for schema 'shared@v1' \(flow b\)/,
    );
  });

  it('throws on duplicate close builders', () => {
    const packages = [
      fakePackage({
        id: 'a',
        writers: {
          compose: [],
          close: [fakeCloseBuilder('shared.result@v1')],
          verification: [],
          checkpoint: [],
        },
      }),
      fakePackage({
        id: 'b',
        writers: {
          compose: [],
          close: [fakeCloseBuilder('shared.result@v1')],
          verification: [],
          checkpoint: [],
        },
      }),
    ];
    expect(() => buildCloseRegistry(packages)).toThrow(/duplicate close builder/);
  });

  it('throws on duplicate verification builders', () => {
    const packages = [
      fakePackage({
        id: 'a',
        writers: {
          compose: [],
          close: [],
          verification: [fakeVerificationBuilder('v@v1')],
          checkpoint: [],
        },
      }),
      fakePackage({
        id: 'b',
        writers: {
          compose: [],
          close: [],
          verification: [fakeVerificationBuilder('v@v1')],
          checkpoint: [],
        },
      }),
    ];
    expect(() => buildVerificationRegistry(packages)).toThrow(/duplicate verification builder/);
  });

  it('throws on duplicate checkpoint builders', () => {
    const packages = [
      fakePackage({
        id: 'a',
        writers: {
          compose: [],
          close: [],
          verification: [],
          checkpoint: [fakeCheckpointBuilder('c@v1')],
        },
      }),
      fakePackage({
        id: 'b',
        writers: {
          compose: [],
          close: [],
          verification: [],
          checkpoint: [fakeCheckpointBuilder('c@v1')],
        },
      }),
    ];
    expect(() => buildCheckpointRegistry(packages)).toThrow(/duplicate checkpoint builder/);
  });
});

describe('catalog-derivations: runtime surfaces', () => {
  it('indexes package-owned runtime surface metadata by flow id', () => {
    const surface = {
      supportedEntryModes: [{ entryModeName: 'default', depth: 'standard' }],
      primaryResult: {
        schemaName: 'a.result@v1',
        path: 'reports/a-result.json',
        label: 'A result',
      },
    };
    const registry = buildRuntimeSurfaceRegistry([
      fakePackage({ id: 'a', runtimeSurface: surface }),
      fakePackage({ id: 'b' }),
    ]);

    expect(registry.get('a')).toBe(surface);
    expect(registry.has('b')).toBe(false);
  });
});

describe('catalog-derivations: report schema registry', () => {
  it('combines fixtures and per-package relay reports', () => {
    const fixture = z.object({ verdict: z.string() });
    const real = z.object({ verdict: z.string(), summary: z.string() });
    const registry = buildReportSchemaRegistry(
      [
        fakePackage({
          id: 'a',
          relayReports: [{ schemaName: 'a.one@v1', schema: real }],
        }),
      ],
      { 'fixture@v1': fixture },
    );
    expect(Object.hasOwn(registry, 'fixture@v1')).toBe(true);
    expect(Object.hasOwn(registry, 'a.one@v1')).toBe(true);
    expect(registry['a.one@v1']).toBe(real);
  });

  it('throws on duplicate schema between two packages', () => {
    const schema = z.object({ verdict: z.string() });
    const packages = [
      fakePackage({
        id: 'a',
        relayReports: [{ schemaName: 'shared@v1', schema }],
      }),
      fakePackage({
        id: 'b',
        relayReports: [{ schemaName: 'shared@v1', schema }],
      }),
    ];
    expect(() => buildReportSchemaRegistry(packages, {})).toThrow(
      /duplicate relay report schema 'shared@v1' registered \(flow b\)/,
    );
  });

  it('throws on collision between fixtures and a package report', () => {
    const schema = z.object({ verdict: z.string() });
    expect(() =>
      buildReportSchemaRegistry(
        [
          fakePackage({
            id: 'a',
            relayReports: [{ schemaName: 'fixture@v1', schema }],
          }),
        ],
        { 'fixture@v1': schema },
      ),
    ).toThrow(/duplicate relay report schema 'fixture@v1'/);
  });

  it('returns a frozen map', () => {
    const registry = buildReportSchemaRegistry([], {});
    expect(Object.isFrozen(registry)).toBe(true);
  });
});

describe('catalog-derivations: schema and structural hint maps', () => {
  it('maps schema name to relayHint and skips reports with no hint', () => {
    const schema = z.object({ verdict: z.string() });
    const packages = [
      fakePackage({
        id: 'a',
        relayReports: [
          { schemaName: 'with-hint@v1', schema, relayHint: 'use this shape' },
          { schemaName: 'no-hint@v1', schema },
        ],
      }),
    ];
    const map = buildSchemaHintMap(packages);
    expect(map.size).toBe(1);
    expect(map.get('with-hint@v1')).toBe('use this shape');
    expect(map.has('no-hint@v1')).toBe(false);
  });

  it('throws on duplicate schema hint across two packages', () => {
    const schema = z.object({ verdict: z.string() });
    const packages = [
      fakePackage({
        id: 'a',
        relayReports: [{ schemaName: 'shared@v1', schema, relayHint: 'a' }],
      }),
      fakePackage({
        id: 'b',
        relayReports: [{ schemaName: 'shared@v1', schema, relayHint: 'b' }],
      }),
    ];
    expect(() => buildSchemaHintMap(packages)).toThrow(
      /duplicate shape hint registered for schema 'shared@v1' \(flow b\)/,
    );
  });

  it('builds the structural hint list and preserves package order', () => {
    const packages = [
      fakePackage({ id: 'a', structuralHints: [fakeStructuralHint('a.struct@v1')] }),
      fakePackage({ id: 'b', structuralHints: [fakeStructuralHint('b.struct@v1')] }),
    ];
    const list = buildStructuralHintList(packages);
    expect(list.map((h) => h.id)).toEqual(['a.struct@v1', 'b.struct@v1']);
  });

  it('throws on duplicate structural hint id', () => {
    const packages = [
      fakePackage({ id: 'a', structuralHints: [fakeStructuralHint('shared@v1')] }),
      fakePackage({ id: 'b', structuralHints: [fakeStructuralHint('shared@v1')] }),
    ];
    expect(() => buildStructuralHintList(packages)).toThrow(
      /duplicate structural shape hint id 'shared@v1' \(flow b\)/,
    );
  });
});

describe('catalog-derivations: real catalog invariants', () => {
  // These run against the actual src/flows/catalog.ts so the
  // behavioral guarantees apply to the live engine state, not just
  // synthetic fixtures.
  it('the live catalog has no duplicate flow ids', async () => {
    const { flowPackages } = await import('../../src/flows/catalog.js');
    const ids = flowPackages.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('the live catalog has no duplicate relay report schema names', async () => {
    const { flowPackages } = await import('../../src/flows/catalog.js');
    // buildReportSchemaRegistry would throw if there were duplicates.
    // This is a smoke that the live state hasn't drifted into a broken
    // shape.
    expect(() => buildReportSchemaRegistry(flowPackages, {})).not.toThrow();
  });

  it('every catalog writer resolves through its registry by resultSchemaName', async () => {
    // Stage 4 audit gap: the architecture-boundary test is purely
    // static. This is the runtime parity check — for every writer
    // declared on a CompiledFlowPackage, the live registry's find function
    // returns exactly that builder. Catches: a writer accidentally
    // dropped from a registry-build path; a registry that returns a
    // different instance (identity matters because the runner uses
    // builder methods directly).
    const { flowPackages } = await import('../../src/flows/catalog.js');

    // Floor: at least 5 packages and at least one writer overall, so
    // the for-loop body must execute. Without this the test would
    // pass vacuously against an emptied catalog or empty writer arrays.
    expect(flowPackages.length).toBeGreaterThanOrEqual(5);
    const totalWriters = flowPackages.reduce(
      (n, pkg) =>
        n +
        pkg.writers.compose.length +
        pkg.writers.close.length +
        pkg.writers.verification.length +
        pkg.writers.checkpoint.length,
      0,
    );
    expect(totalWriters).toBeGreaterThan(0);
    const { findComposeBuilder } = await import(
      '../../src/flows/registries/compose-writers/registry.js'
    );
    const { findCloseBuilder } = await import(
      '../../src/flows/registries/close-writers/registry.js'
    );
    const { findVerificationWriter } = await import(
      '../../src/flows/registries/verification-writers/registry.js'
    );
    const { findCheckpointBriefBuilder } = await import(
      '../../src/flows/registries/checkpoint-writers/registry.js'
    );

    for (const pkg of flowPackages) {
      for (const builder of pkg.writers.compose) {
        expect(
          findComposeBuilder(builder.resultSchemaName),
          `compose builder for ${builder.resultSchemaName} (flow ${pkg.id}) does not resolve`,
        ).toBe(builder);
      }
      for (const builder of pkg.writers.close) {
        expect(
          findCloseBuilder(builder.resultSchemaName),
          `close builder for ${builder.resultSchemaName} (flow ${pkg.id}) does not resolve`,
        ).toBe(builder);
      }
      for (const builder of pkg.writers.verification) {
        expect(
          findVerificationWriter(builder.resultSchemaName),
          `verification builder for ${builder.resultSchemaName} (flow ${pkg.id}) does not resolve`,
        ).toBe(builder);
      }
      for (const builder of pkg.writers.checkpoint) {
        expect(
          findCheckpointBriefBuilder(builder.resultSchemaName),
          `checkpoint builder for ${builder.resultSchemaName} (flow ${pkg.id}) does not resolve`,
        ).toBe(builder);
      }
    }
  });
});
