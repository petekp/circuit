import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { flowDefinitions, flowPackages } from '../../src/flows/catalog.js';
import { compileSchematicToCompiledFlow } from '../../src/flows/compile-schematic-to-flow.js';
import {
  type FlowDefinition,
  compileFlowDefinition,
  compileFlowDefinitions,
  defineFlow,
  defineFlowData,
  defineFlowDataValue,
  schematicForFlowDefinition,
} from '../../src/flows/flow-definition.js';
import type { ComposeBuilder } from '../../src/flows/registries/compose-writers/types.js';
import type { CompiledFlowPackage } from '../../src/flows/types.js';
import {
  CompiledFlow,
  type CompiledFlow as CompiledFlowValue,
} from '../../src/schemas/compiled-flow.js';
import { FlowSchematic } from '../../src/schemas/flow-schematic.js';

const schema = z.object({ ok: z.boolean() }).strict();
const definitionsById = new Map(flowDefinitions.map((definition) => [definition.id, definition]));
const packagesById = new Map(flowPackages.map((pkg) => [pkg.id, pkg]));

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

function definitionFor(flowId: string): FlowDefinition {
  const definition = definitionsById.get(flowId);
  if (definition === undefined) {
    throw new Error(`missing FlowDefinition for ${flowId}`);
  }
  return definition;
}

function packageFor(flowId: string): CompiledFlowPackage {
  const pkg = packagesById.get(flowId);
  if (pkg === undefined) {
    throw new Error(`missing CompiledFlowPackage for ${flowId}`);
  }
  return pkg;
}

function graphIdentityHash(flow: CompiledFlowValue): string {
  return JSON.stringify(flow);
}

function plannedGeneratedFlows(
  flowId: string,
  compiled: ReturnType<typeof compileSchematicToCompiledFlow>,
): ReadonlyMap<string, CompiledFlowValue> {
  if (compiled.kind === 'single') {
    return new Map([[`generated/flows/${flowId}/circuit.json`, compiled.flow]]);
  }

  const groups = new Map<string, { modes: string[]; flow: CompiledFlowValue }>();
  for (const [modeName, flow] of compiled.flows) {
    const hash = graphIdentityHash(flow);
    const existing = groups.get(hash);
    if (existing === undefined) {
      groups.set(hash, { modes: [modeName], flow });
    } else {
      existing.modes.push(modeName);
    }
  }

  const ordered = [...groups.values()].sort((a, b) => {
    if (b.modes.length !== a.modes.length) return b.modes.length - a.modes.length;
    const aFirst = a.modes[0] ?? '';
    const bFirst = b.modes[0] ?? '';
    return aFirst.localeCompare(bFirst);
  });

  const planned = new Map<string, CompiledFlowValue>();
  const main = ordered[0];
  if (main === undefined) return planned;
  planned.set(`generated/flows/${flowId}/circuit.json`, main.flow);
  for (let i = 1; i < ordered.length; i++) {
    const group = ordered[i];
    if (group === undefined) continue;
    for (const modeName of group.modes) {
      const flow = compiled.flows.get(modeName);
      if (flow === undefined) {
        throw new Error(`compiled flow '${flowId}' mode '${modeName}' is missing`);
      }
      planned.set(`generated/flows/${flowId}/${modeName}.json`, flow);
    }
  }
  return planned;
}

function assertGeneratedManifests(flowId: string): void {
  const definition = definitionFor(flowId);
  const compiled = compileSchematicToCompiledFlow(schematicForFlowDefinition(definition));
  for (const [path, flow] of plannedGeneratedFlows(flowId, compiled)) {
    expect(flow).toEqual(CompiledFlow.parse(readJson(path)));
  }
}

function assertDefinitionPackageParity(flowId: string): void {
  const definition = definitionFor(flowId);
  const pkg = packageFor(flowId);
  const generatedSchematic = FlowSchematic.parse(readJson(pkg.paths.schematic));

  expect(schematicForFlowDefinition(definition)).toEqual(generatedSchematic);
  expect(pkg).toEqual(compileFlowDefinition(definition));
  expect(pkg.relayReports).toEqual(definition.relayReports ?? []);
  expect(pkg.reportSchemas).toEqual(definition.reportSchemas);
  expect(pkg.writers).toEqual({
    compose: definition.writers?.compose ?? [],
    close: definition.writers?.close ?? [],
    verification: definition.writers?.verification ?? [],
    checkpoint: definition.writers?.checkpoint ?? [],
  });
  expect(pkg.structuralHints).toEqual(definition.structuralHints);
  expect(pkg.engineFlags).toEqual(definition.engineFlags);
  assertGeneratedManifests(flowId);
}

function minimalDefinition(id: string) {
  return defineFlow({
    id,
    visibility: 'public',
    schematic: {
      schema_version: '2',
      id,
      title: `${id} test flow`,
      purpose: `${id} test purpose`,
      status: 'active',
      version: '0.1.0',
      starts_at: 'compose-step',
      initial_contracts: [],
      contract_aliases: [],
      axes: {
        allowed_depths: ['medium'],
        supports_tournament: false,
        supports_autonomous: false,
      },
      stage_path_policy: {
        mode: 'partial',
        omits: ['frame', 'analyze', 'act', 'verify', 'review', 'close'],
        rationale: 'Only the plan stage is needed for this compiler test.',
      },
      stages: [{ id: 'plan-stage', title: 'Plan', canonical: 'plan' }],
      items: [
        {
          id: 'compose-step',
          stage: 'plan',
          title: 'Compose test report',
          block: 'plan',
          input: {},
          output: 'plan.strategy@v1',
          evidence_requirements: ['ordered steps'],
          execution: { kind: 'compose' },
          protocol: `${id}-compose@v1`,
          writes: { report_path: 'reports/compose.json' },
          check: { required: ['ok'] },
          routes: { continue: '@complete' },
        },
      ],
    },
    runtimeSurface: {
      primaryResult: {
        schemaName: `${id}.result@v1`,
        path: 'reports/result.json',
        label: 'Result',
      },
      progress: {
        steps: [
          {
            stepId: 'compose-step',
            taskTitle: 'Compose test report',
            activeText: 'Composing test report',
          },
        ],
      },
    },
  });
}

describe('FlowDefinition compiler', () => {
  it('projects default package fields and runtime surface metadata', () => {
    const definition = minimalDefinition('definition-test');
    const pkg = compileFlowDefinition(definition);

    expect(pkg).toMatchObject({
      id: 'definition-test',
      visibility: 'public',
      paths: { schematic: 'src/flows/definition-test/schematic.json' },
      relayReports: [],
      writers: { compose: [], close: [], verification: [], checkpoint: [] },
      runtimeSurface: {
        progress: {
          steps: [
            {
              stepId: 'compose-step',
              taskTitle: 'Compose test report',
              activeText: 'Composing test report',
            },
          ],
        },
      },
    });
  });

  it('projects canonical FlowData through the existing FlowDefinition path', () => {
    const flowData = minimalDefinition('flow-data-test');

    const definition = defineFlowData(flowData);

    expect(definition).toEqual(defineFlow(flowData));
    expect(compileFlowDefinition(definition)).toEqual(compileFlowDefinition(defineFlow(flowData)));
  });

  it('returns typed errors behind the throwing FlowData adapter', () => {
    const flowData = minimalDefinition('flow-data-error');
    const result = defineFlowDataValue({
      ...flowData,
      id: 'outer-id',
      schematic: { ...flowData.schematic, id: 'inner-id' },
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected typed FlowData error');
    expect(result.errors).toMatchObject([
      {
        kind: 'flow-data-parse-error',
        message: expect.stringContaining(
          "flow definition id 'outer-id' does not match schematic id 'inner-id'",
        ),
      },
    ]);
    expect(() =>
      defineFlowData({
        ...flowData,
        id: 'outer-id',
        schematic: { ...flowData.schematic, id: 'inner-id' },
      }),
    ).toThrow(/does not match schematic id/);
  });

  it('projects report declarations owned by canonical FlowData', () => {
    const composeBuilder: ComposeBuilder = {
      resultSchemaName: 'flow-data-report@v1',
      build: () => ({ ok: true }),
    };
    const reports = [
      {
        schemaName: 'flow-data-relay@v1',
        channel: 'relay' as const,
        schema,
        relayHint: 'emit flow-data-relay JSON',
      },
      {
        schemaName: 'flow-data-report@v1',
        channel: 'report' as const,
        schema,
        fileSurface: {
          timing: 'after' as const,
          extractor: { kind: 'string-array-field' as const, field: 'observed' },
        },
        writers: { compose: [composeBuilder] },
      },
    ];
    const flowData = {
      ...minimalDefinition('flow-data-reports'),
      reports,
    };

    const definition = defineFlowData(flowData);
    const legacyDefinition = defineFlow({
      ...minimalDefinition('flow-data-reports'),
      reportDeclarations: reports,
    });

    expect(definition.reportDeclarations).toEqual(reports);
    expect(compileFlowDefinition(definition)).toEqual(compileFlowDefinition(legacyDefinition));
    expect(compileFlowDefinition(definition).reportFileSurfaces).toEqual({
      'flow-data-report@v1': {
        timing: 'after',
        extractor: { kind: 'string-array-field', field: 'observed' },
      },
    });
  });

  it('returns typed errors for invalid FlowData report ownership', () => {
    const duplicate = defineFlowDataValue({
      ...minimalDefinition('flow-data-duplicate-report'),
      reports: [
        { schemaName: 'flow-data-duplicate@v1', channel: 'report', schema },
        { schemaName: 'flow-data-duplicate@v1', channel: 'relay', schema },
      ],
    });

    expect(duplicate.ok).toBe(false);
    if (duplicate.ok) throw new Error('expected duplicate report error');
    expect(duplicate.errors).toContainEqual({
      kind: 'duplicate-flow-data-report',
      schemaName: 'flow-data-duplicate@v1',
    });

    const driftedWriter: ComposeBuilder = {
      resultSchemaName: 'other-report@v1',
      build: () => ({ ok: true }),
    };
    const writerDrift = defineFlowDataValue({
      ...minimalDefinition('flow-data-writer-drift'),
      reports: [
        {
          schemaName: 'flow-data-owned-report@v1',
          channel: 'report',
          schema,
          writers: { compose: [driftedWriter] },
        },
      ],
    });

    expect(writerDrift.ok).toBe(false);
    if (writerDrift.ok) throw new Error('expected writer drift error');
    expect(writerDrift.errors).toContainEqual({
      kind: 'flow-data-report-writer-drift',
      schemaName: 'flow-data-owned-report@v1',
      slot: 'compose',
      resultSchemaName: 'other-report@v1',
    });
  });

  it('allows documented FlowData report writer aliases', () => {
    const aliasedBuilder: ComposeBuilder = {
      resultSchemaName: 'plan.strategy@v1',
      build: () => ({ ok: true }),
    };

    const definition = defineFlowData({
      ...minimalDefinition('flow-data-writer-alias'),
      reportWriterSchemaAliases: ['plan.strategy@v1'],
      reports: [
        {
          schemaName: 'flow-data-owned-report@v1',
          channel: 'report',
          schema,
          writers: { compose: [aliasedBuilder] },
        },
      ],
    });

    expect(definition.reportDeclarations?.[0]?.schemaName).toBe('flow-data-owned-report@v1');
    expect(definition).not.toHaveProperty('reportWriterSchemaAliases');
    expect(compileFlowDefinition(definition).writers.compose).toEqual([aliasedBuilder]);
  });

  it('keeps Pursue internal for v1 with no host command or skill surfaces', () => {
    const pkg = packageFor('pursue');

    // Pursue was demoted to internal for v1 (see docs/release/v1-launch-plan.md
    // §4). Like every internal flow it drops its flow-owned command surface, so
    // `/circuit:pursue` is no longer advertised or emitted; it runs from a
    // checkout via `./bin/circuit run pursue`. The dormant command.md source
    // stays on disk for re-promotion.
    expect(pkg.visibility).toBe('internal');
    expect(pkg.paths.command).toBeUndefined();
    expect(existsSync('plugins/claude/commands/pursue.md')).toBe(false);
    expect(existsSync('plugins/claude/skills/pursue')).toBe(false);
    expect(existsSync('plugins/codex/commands/pursue.md')).toBe(false);
    expect(existsSync('plugins/codex/flows/pursue')).toBe(false);
    expect(existsSync('plugins/codex/skills/pursue')).toBe(false);
  });

  it('keeps Build checkpoint, writer, and engine-flag contracts', () => {
    const definition = definitionFor('build');
    const pkg = packageFor('build');
    const frameStep = definition.schematic.items.find((item) => item.id === 'frame-step');
    const actStep = definition.schematic.items.find((item) => item.id === 'act-step');
    const compiled = compileSchematicToCompiledFlow(schematicForFlowDefinition(definition));
    const compiledFlow = compiled.kind === 'single' ? compiled.flow : compiled.flows.get('default');
    const compiledActStep = compiledFlow?.steps.find((step) => step.id === 'act-step');

    expect(pkg.writers.checkpoint.map((writer) => writer.resultSchemaName)).toEqual([
      'build.brief@v1',
    ]);
    // Stage 3b (first-class composition): build's engine flags are rehomed off
    // the by-id catalog package onto the compiled manifest. The package no
    // longer carries them; the manifest does. The full manifest->runtime
    // roundtrip is proved in tests/runner/engine-flags-manifest-roundtrip.test.ts.
    expect(pkg.engineFlags).toBeUndefined();
    expect(compiledFlow?.engine_flags).toEqual({
      binds_execution_depth_to_relay_selection: true,
      binds_terminal_outcome_to_primary_result: true,
      iterates_slice_loop: {
        head_step: 'act-step',
        tail_step: 'verify-step',
        advance_route: 'advance',
        slices_from: { report: 'reports/build/plan.json', items_path: 'slices' },
        max_slices: 8,
        activate_when_depth_at_least: 'high',
      },
    });
    expect(frameStep?.execution.kind).toBe('checkpoint');
    expect(frameStep?.writes).toMatchObject({
      report_path: 'reports/build/brief.json',
      checkpoint_request_path: 'reports/checkpoints/frame-step-request.json',
      checkpoint_response_path: 'reports/checkpoints/frame-step-response.json',
    });
    expect(frameStep?.checkpoint_policy).toMatchObject({
      safe_default_choice: 'continue',
    });
    expect(actStep?.acceptance_criteria).toEqual({
      checks: [
        {
          kind: 'report_field',
          id: 'changed-files-present',
          path: ['changed_files'],
          predicate: 'present',
        },
        {
          kind: 'report_field',
          id: 'changed-files-on-disk',
          path: ['changed_files'],
          predicate: 'changed_on_disk',
        },
        {
          kind: 'report_field',
          id: 'evidence-non-empty',
          path: ['evidence'],
          predicate: 'non_empty',
        },
      ],
      on_failure: { mode: 'retry-with-feedback' },
    });
    expect(compiledActStep).toMatchObject({
      id: 'act-step',
      kind: 'relay',
      acceptance_criteria: actStep?.acceptance_criteria,
    });
  });

  it('projects report declarations for direct FlowDefinition callers', () => {
    const composeBuilder: ComposeBuilder = {
      resultSchemaName: 'definition-report@v1',
      build: () => ({ ok: true }),
    };
    const definition = defineFlow({
      ...minimalDefinition('definition-reports'),
      reportDeclarations: [
        {
          schemaName: 'definition-relay@v1',
          channel: 'relay',
          schema,
          relayHint: 'emit definition-relay JSON',
        },
        {
          schemaName: 'definition-report@v1',
          channel: 'report',
          schema,
          fileSurface: {
            timing: 'before',
            extractor: { kind: 'build-plan-and-slices-anticipated-file-extensions' },
          },
          writers: { compose: [composeBuilder] },
        },
      ],
    });
    const pkg = compileFlowDefinition(definition);

    expect(pkg.relayReports.map((report) => report.schemaName)).toEqual(['definition-relay@v1']);
    expect(pkg.relayReports[0]?.relayHint).toBe('emit definition-relay JSON');
    expect(pkg.reportSchemas?.map((report) => report.schemaName)).toEqual(['definition-report@v1']);
    expect(pkg.reportFileSurfaces).toEqual({
      'definition-report@v1': {
        timing: 'before',
        extractor: { kind: 'build-plan-and-slices-anticipated-file-extensions' },
      },
    });
    expect(pkg.writers.compose).toEqual([composeBuilder]);
  });

  it('fails when definition id and schematic id drift', () => {
    const definition = minimalDefinition('definition-id');
    expect(() =>
      defineFlow({
        ...definition,
        id: 'outer-id',
        schematic: { ...definition.schematic, id: 'inner-id' },
      }),
    ).toThrow(/does not match schematic id/);
  });

  it('fails closed on duplicate flow ids, report schemas, and writer result schemas', () => {
    const first = minimalDefinition('duplicate-a');
    const second = minimalDefinition('duplicate-b');
    const writer: ComposeBuilder = { resultSchemaName: 'shared.writer@v1', build: () => ({}) };

    expect(() => compileFlowDefinitions([first, first])).toThrow(/duplicate flow definition id/);
    expect(() =>
      compileFlowDefinitions([
        { ...first, reportSchemas: [{ schemaName: 'shared.report@v1', schema }] },
        { ...second, reportSchemas: [{ schemaName: 'shared.report@v1', schema }] },
      ]),
    ).toThrow(/duplicate report schema/);
    expect(() =>
      compileFlowDefinitions([
        { ...first, writers: { compose: [writer] } },
        { ...second, writers: { compose: [{ ...writer }] } },
      ]),
    ).toThrow(/duplicate writer result schema/);
  });

  it('fails closed when progress points outside the schematic', () => {
    const definition = minimalDefinition('bad-progress');

    expect(() =>
      compileFlowDefinition({
        ...definition,
        runtimeSurface: {
          ...definition.runtimeSurface,
          progress: {
            steps: [
              {
                stepId: 'missing-step',
                taskTitle: 'Missing',
                activeText: 'Missing',
              },
            ],
          },
        },
      }),
    ).toThrow(/is not a schematic item/);
  });

  it('keeps every built-in definition in parity with package and generated manifest surfaces', () => {
    expect(flowDefinitions.map((definition) => definition.id)).toEqual(
      flowPackages.map((pkg) => pkg.id),
    );
    for (const definition of flowDefinitions) {
      assertDefinitionPackageParity(definition.id);
    }
  });

  it('omits a route-disjoint optional read when its producer is absent in one mode', () => {
    const compiled = compileSchematicToCompiledFlow(
      schematicForFlowDefinition(definitionFor('fix')),
    );
    if (compiled.kind !== 'per-mode') throw new Error('expected Fix to compile per mode');

    const defaultAct = compiled.flows.get('default')?.steps.find((step) => step.id === 'fix-act');
    const lowAct = compiled.flows.get('low')?.steps.find((step) => step.id === 'fix-act');

    expect(defaultAct?.reads).toContain('reports/fix/review.json');
    expect(lowAct?.reads).not.toContain('reports/fix/review.json');
  });

  it('preserves per-flow runtime and routed command ownership expectations', () => {
    for (const flowId of ['review', 'build', 'explore', 'prototype', 'pursue'] as const) {
      expect(packageFor(flowId).runtimeSurface).not.toHaveProperty('supportedEntryModes');
    }
    // No flow owns a host command surface for v1: public flows route through
    // Run, and Pursue dropped its flow-owned `/circuit:pursue` when it went
    // internal (docs/release/v1-launch-plan.md §4).
    for (const flowId of [
      'build',
      'explore',
      'fix',
      'goal',
      'prototype',
      'pursue',
      'review',
    ] as const) {
      expect(packageFor(flowId).paths.command).toBeUndefined();
    }
    expect(packageFor('fix').runtimeSurface?.progress?.steps).toHaveLength(14);
    // Stage 3b (first-class composition): build and prototype follow goal off
    // the by-id catalog package onto their compiled manifests. Their packages no
    // longer carry engineFlags; the manifests do (proved in
    // tests/runner/engine-flags-manifest-roundtrip.test.ts).
    expect(packageFor('build').engineFlags).toBeUndefined();
    expect(packageFor('prototype').engineFlags).toBeUndefined();
    // Stage 3 (first-class composition): goal was the first flow rehomed off the
    // package onto its manifest. Its package no longer carries engineFlags; the
    // terminal-outcome bind now rides the compiled manifest's engine_flags and
    // the engine reads it through resolveEngineFlags.
    expect(packageFor('goal').engineFlags).toBeUndefined();
    const goalCompiled = compileSchematicToCompiledFlow(
      schematicForFlowDefinition(definitionFor('goal')),
    );
    const goalFlow =
      goalCompiled.kind === 'single' ? goalCompiled.flow : goalCompiled.flows.get('default');
    expect(goalFlow?.engine_flags).toEqual({ binds_terminal_outcome_to_primary_result: true });
  });
});
