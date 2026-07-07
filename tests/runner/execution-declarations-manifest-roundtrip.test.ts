// Stage 3b (first-class composition): proves the execution-bearing declarations
// a flow needs at run time travel on its compiled MANIFEST, not only on the
// by-id catalog package. Three declarations move in this slice:
//
//   report_file_surfaces  the skill-hook edit-file surface table (graph-runner)
//   runtime_surface       the primary-result binding (run-close)
//   required_config       the CLI's up-front config gate (cli/run)
//
// `report_file_surfaces` and `required_config` ride verbatim from the schematic;
// `runtime_surface.primary_result` is DERIVED from the close-stage compose step.
// The load-bearing proof is the drift guard: for every built-in, the value the
// compiler puts on the manifest must equal the value the by-id package still
// carries. That equivalence is what lets M4 delete the package read without
// changing any resolved value. If the schematic field, the derive, the compiler
// propagation, or the boundary translation breaks, these tests go red.
//
// See docs/architecture/first-class-composition-optimal-path.md (M3b-B).
import { describe, expect, it } from 'vitest';
import { flowDefinitions, flowPackages } from '../../src/flows/catalog.js';
import {
  type CompileResult,
  FlowSchematicCompileError,
  compileSchematicToCompiledFlow,
} from '../../src/flows/compile-schematic-to-flow.js';
import { fromCompiledFlow } from '../../src/runtime/manifest/from-compiled-flow.js';

function firstCompiledFlow(result: CompileResult) {
  if (result.kind === 'single') return result.flow;
  const first = [...result.flows.values()][0];
  if (first === undefined) throw new Error('per-mode compile produced no flows');
  return first;
}

function compiledFlow(id: string) {
  const definition = flowDefinitions.find((candidate) => candidate.id === id);
  if (definition === undefined) throw new Error(`missing ${id} flow definition`);
  return firstCompiledFlow(compileSchematicToCompiledFlow(definition.schematic));
}

describe('execution declarations on the compiled manifest (Stage 3b drift guard)', () => {
  // The forward drift guard, run over every built-in: whatever the by-id package
  // declares must appear identically on the compiled manifest. This is the proof
  // that M4 can stop reading the package without losing a value.
  for (const definition of flowDefinitions) {
    const id = definition.id as unknown as string;
    const pkg = flowPackages.find((candidate) => candidate.id === id);
    if (pkg === undefined) throw new Error(`missing ${id} package`);

    it(`${id}: manifest runtime_surface.primary_result matches the package`, () => {
      const flow = compiledFlow(id);
      const authored = pkg.runtimeSurface?.primaryResult;
      if (authored === undefined) {
        // A flow with no authored primary result must derive none either, or the
        // engine would bind a terminal outcome the package never advertised.
        expect(flow.runtime_surface?.primary_result).toBeUndefined();
        return;
      }
      expect(flow.runtime_surface?.primary_result).toEqual({
        schema_name: authored.schemaName,
        path: authored.path,
      });
    });

    it(`${id}: manifest report_file_surfaces matches the package`, () => {
      const flow = compiledFlow(id);
      if (pkg.reportFileSurfaces === undefined) {
        expect(flow.report_file_surfaces).toBeUndefined();
        return;
      }
      expect(flow.report_file_surfaces).toEqual(pkg.reportFileSurfaces);
    });

    it(`${id}: manifest required_config matches the package`, () => {
      const flow = compiledFlow(id);
      if (pkg.requiredConfig === undefined) {
        expect(flow.required_config).toBeUndefined();
        return;
      }
      expect(flow.required_config).toEqual(pkg.requiredConfig);
    });
  }
});

describe('runtime_surface.primary_result is derived from the success close (Stage 3b)', () => {
  // fix is the load-bearing case: its close stage has TWO @complete compose
  // steps that write the result AND a handoff step that composes a different
  // record (continuity.record@v1) on @handoff. The derive must pick the result,
  // not the handoff record, and must not choke on the concordant pair.
  it('fix derives fix.result@v1, excluding the @handoff continuity record', () => {
    const flow = compiledFlow('fix');
    expect(flow.runtime_surface?.primary_result).toEqual({
      schema_name: 'fix.result@v1',
      path: 'reports/fix-result.json',
    });
  });

  // explore and prototype have two concordant @complete close paths (tournament
  // + normal); the derive must collapse them to the single shared result.
  it('explore collapses its dual @complete close to one primary result', () => {
    const flow = compiledFlow('explore');
    expect(flow.runtime_surface?.primary_result).toEqual({
      schema_name: 'explore.result@v1',
      path: 'reports/explore-result.json',
    });
  });
});

describe('runtime_surface.primary_result fails closed on discordant @complete closes (Stage 3b guard)', () => {
  // The fail-closed guard composed flows (M9) will lean on: when a schematic has
  // two close-stage @complete compose steps that write DIFFERENT result schema or
  // path, the derive cannot pick one silently, so it throws at compile time. No
  // built-in is discordant today (fix's two @complete closes both write
  // fix.result@v1 at reports/fix-result.json), so we mutate fix to diverge one
  // path and assert the specific compile error — without this red-path test a
  // regression to a silent first-wins pick would ship green.
  function fixSchematic() {
    const definition = flowDefinitions.find((candidate) => candidate.id === 'fix');
    if (definition === undefined) throw new Error('missing fix flow definition');
    return definition.schematic;
  }

  it('throws a discordant compile error when two @complete closes write divergent paths', () => {
    const schematic = fixSchematic();
    const broken = {
      ...schematic,
      items: schematic.items.map((item) =>
        (item.id as unknown as string) === 'fix-close'
          ? ({
              ...item,
              writes: { ...item.writes, report_path: 'reports/fix-result-divergent.json' },
            } as unknown as typeof item)
          : item,
      ),
    } as unknown as typeof schematic;
    expect(() => compileSchematicToCompiledFlow(broken)).toThrow(FlowSchematicCompileError);
    expect(() => compileSchematicToCompiledFlow(broken)).toThrow(
      /discordant @complete close-stage compose writes/,
    );
  });

  // Control: the unmutated built-in (whose two @complete closes are concordant)
  // compiles cleanly, proving the path divergence above is what trips the guard.
  it('does not throw for the concordant built-in fix', () => {
    expect(() => compileSchematicToCompiledFlow(fixSchematic())).not.toThrow();
  });
});

describe('execution declarations translate onto ExecutableFlow (Stage 3b boundary)', () => {
  it('build carries report_file_surfaces and runtimeSurface.primaryResult in camelCase', () => {
    const executable = fromCompiledFlow(compiledFlow('build'));
    expect(executable.reportFileSurfaces).toEqual({
      'build.plan@v1': {
        timing: 'before',
        extractor: { kind: 'build-plan-and-slices-anticipated-file-extensions' },
      },
    });
    expect(executable.runtimeSurface?.primaryResult).toEqual({
      schemaName: 'build.result@v1',
      path: 'reports/build-result.json',
    });
  });

  it('prototype carries requiredConfig at the runtime boundary', () => {
    const executable = fromCompiledFlow(compiledFlow('prototype'));
    expect(executable.requiredConfig).toEqual([
      {
        axis: 'tournament',
        path: 'flows.prototype.variant_models',
        message:
          "prototype --tournament requires 'flows.prototype.variant_models' in your Circuit config (one variant model per tournament branch). Add it under flows.prototype.variant_models, or run prototype without --tournament.",
      },
    ]);
  });

  it('a flow with no declarations carries none at the runtime boundary', () => {
    const executable = fromCompiledFlow(compiledFlow('review'));
    expect(executable.reportFileSurfaces).toBeUndefined();
    expect(executable.requiredConfig).toBeUndefined();
    // review still derives a primary result from its close stage.
    expect(executable.runtimeSurface?.primaryResult).toEqual({
      schemaName: 'review.result@v1',
      path: 'reports/review-result.json',
    });
  });
});
