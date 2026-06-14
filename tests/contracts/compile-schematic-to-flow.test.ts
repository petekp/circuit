import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  FlowSchematicCompileError,
  compileSchematicToCompiledFlow,
  ensureSupportedKindReportPair,
} from '../../src/flows/compile-schematic-to-flow.js';
import { CompiledFlow } from '../../src/schemas/compiled-flow.js';
import { FlowSchematic } from '../../src/schemas/flow-schematic.js';
import {
  RUNTIME_SUCCESS_ROUTE,
  SCHEMATIC_SUCCESS_ROUTE_ALIASES,
  schematicOutcomeToRuntimeRoute,
} from '../../src/schemas/route-policy.js';

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function loadSchematic(path: string) {
  return FlowSchematic.parse(readJson(path));
}

function loadCompiledFlow(path: string) {
  return CompiledFlow.parse(readJson(path));
}

describe('compileSchematicToCompiledFlow — byte-equivalence with committed compiled flows', () => {
  const cases = [
    {
      label: 'build',
      schematicPath: 'src/flows/build/schematic.json',
      committedPath: 'generated/flows/build/circuit.json',
    },
    {
      label: 'review',
      schematicPath: 'src/flows/review/schematic.json',
      committedPath: 'generated/flows/review/circuit.json',
    },
  ] as const;

  for (const c of cases) {
    it(`compiles ${c.label} schematic to a single compiled flow that matches the committed fixture`, () => {
      const schematic = loadSchematic(c.schematicPath);
      const compiled = compileSchematicToCompiledFlow(schematic);
      expect(compiled.kind).toBe('single');
      if (compiled.kind !== 'single') return;
      const committed = loadCompiledFlow(c.committedPath);
      // toEqual on parsed objects ignores key order. The drift check
      // compares canonical-stringified bytes; for unit assertions,
      // structural equality is the right shape check.
      expect(compiled.flow).toEqual(committed);
    });
  }

  it('compiles explore schematic to default and tournament fixtures', () => {
    const schematic = loadSchematic('src/flows/explore/schematic.json');
    const compiled = compileSchematicToCompiledFlow(schematic);
    expect(compiled.kind).toBe('per-mode');
    if (compiled.kind !== 'per-mode') return;
    const defaultFlow = compiled.flows.get('default');
    if (defaultFlow === undefined) throw new Error('missing default Explore mode');
    const committedDefault = loadCompiledFlow('generated/flows/explore/circuit.json');
    expect(defaultFlow).toEqual(committedDefault);
    expect(committedDefault.starts_at).toBe('frame-step');
    expect(compiled.flows.get('tournament')).toEqual(
      loadCompiledFlow('generated/flows/explore/tournament.json'),
    );
  });
});

describe('compileSchematicToCompiledFlow — failure modes', () => {
  function loadBuildSchematic() {
    return FlowSchematic.parse(readJson('src/flows/build/schematic.json'));
  }

  // Build trimmed to a terminal verification step (frame → analyze → plan →
  // baseline → act → verify) whose output is a contract with no registered
  // writer, made catalog-compatible by aliasing it to the verification block's
  // generic output contract. This is the one construction where the fail-closed
  // catalog gate passes (the output is block-compatible via the alias, the step
  // is reachable, every input is produced) yet the per-item kind↔writer check
  // must still fire. It exists to prove that check is wired into the compile
  // path: delete the `ensureSupportedKindReportPair(item)` call in `compileItem`
  // and this flow compiles clean instead of throwing.
  function loadCatalogCleanWriterlessVerification() {
    const raw = readJson('src/flows/build/schematic.json') as {
      items: { id: string; output: string; routes: Record<string, string> }[];
      contract_aliases: { generic: string; actual: string }[];
    };
    const keep = new Set([
      'frame-step',
      'analyze-step',
      'plan-step',
      'build-baseline',
      'act-step',
      'verify-step',
    ]);
    const items = raw.items
      .filter((item) => keep.has(item.id))
      .map((item) =>
        item.id === 'verify-step'
          ? {
              ...item,
              output: 'test.writerless-verification@v1',
              routes: { continue: '@complete', stop: '@stop' },
            }
          : item,
      );
    const trimmed = {
      ...raw,
      items,
      contract_aliases: [
        ...raw.contract_aliases,
        { generic: 'verification.result@v1', actual: 'test.writerless-verification@v1' },
      ],
    };
    return FlowSchematic.parse(trimmed);
  }

  it('throws if a required schematic-level field is missing', () => {
    const schematic = loadBuildSchematic();
    // Force-clear via type assertion since FlowSchematic normally enforces presence
    // through the compiler, not through the parse layer (it is optional in zod).
    const broken = { ...schematic, version: undefined } as unknown as typeof schematic;
    expect(() => compileSchematicToCompiledFlow(broken)).toThrow(FlowSchematicCompileError);
    expect(() => compileSchematicToCompiledFlow(broken)).toThrow(/missing required.*version/);
  });

  it('throws if a step is missing protocol', () => {
    const schematic = loadBuildSchematic();
    const itemsCopy = schematic.items.map((item, i) =>
      i === 0 ? ({ ...item, protocol: undefined } as unknown as typeof item) : item,
    );
    const broken = { ...schematic, items: itemsCopy } as unknown as typeof schematic;
    expect(() => compileSchematicToCompiledFlow(broken)).toThrow(/missing.*protocol/);
  });

  it('compiling a catalog-clean flow whose verification output has no writer throws the writer error (proves the writer check is wired into compileItem)', () => {
    // The wiring proof for the kind↔writer invariant. The catalog gate runs first
    // and is strictly stronger than the writer check for incompatible outputs, so
    // a writer-check failure is only reachable through the full compile path when
    // the output is catalog-COMPATIBLE (via an alias) yet still has no registered
    // writer. This flow is exactly that case: the gate passes, and the throw comes
    // from `ensureSupportedKindReportPair` inside `compileItem`, not the gate.
    // Remove that call and this test fails (the flow compiles instead).
    const schematic = loadCatalogCleanWriterlessVerification();
    expect(() => compileSchematicToCompiledFlow(schematic)).toThrow(FlowSchematicCompileError);
    // Assert the offending step AND the writerless contract, so the test fails
    // loudly if the construction's contract name ever drifts (which would make
    // it a different, possibly vacuous, case).
    expect(() => compileSchematicToCompiledFlow(schematic)).toThrow(
      /verify-step.*test\.writerless-verification@v1.*no verification writer is registered for that schema/,
    );
  });

  it('rejects a verification step whose output has no registered writer', () => {
    // The per-item invariant in isolation. Through compileSchematicToCompiledFlow an
    // incompatible output like "foo.bar@v1" is caught first by the fail-closed
    // catalog gate, so the unit-level negative path is proven directly on the
    // validator the compiler runs for every verification step. The integration
    // wiring proof above covers the catalog-compatible-but-writerless case.
    const schematic = loadBuildSchematic();
    const verifyStep = schematic.items.find(
      (item) => item.id === ('verify-step' as unknown as typeof item.id),
    );
    if (verifyStep === undefined) throw new Error('verify-step missing');
    const broken = { ...verifyStep, output: 'foo.bar@v1' } as unknown as typeof verifyStep;
    expect(() => ensureSupportedKindReportPair(broken)).toThrow(
      /no verification writer is registered for that schema/,
    );
  });

  it('accepts the active Fix schematic (verify-step writes fix.verification@v1)', () => {
    const fixSchematic = FlowSchematic.parse(
      JSON.parse(readFileSync('src/flows/fix/schematic.json', 'utf8')),
    );
    expect(() => compileSchematicToCompiledFlow(fixSchematic)).not.toThrow();
  });

  it('rejects a checkpoint step whose report schema has no registered writer', () => {
    // M5 note: as above, the catalog gate rejects this mutation first on the
    // compile path (incompatible checkpoint output), so the kind↔writer invariant
    // is proven directly on the per-item validator the compiler runs for every
    // checkpoint step.
    const schematic = loadBuildSchematic();
    const frameStep = schematic.items.find(
      (item) => item.id === ('frame-step' as unknown as typeof item.id),
    );
    if (frameStep === undefined) throw new Error('frame-step missing');
    const broken = { ...frameStep, output: 'foo.bar@v1' } as unknown as typeof frameStep;
    expect(() => ensureSupportedKindReportPair(broken)).toThrow(
      /no checkpoint writer is registered for that schema/,
    );
  });

  it('maps documented schematic success aliases to the runtime success route', () => {
    expect(SCHEMATIC_SUCCESS_ROUTE_ALIASES).toEqual(['continue', 'complete']);
    for (const alias of SCHEMATIC_SUCCESS_ROUTE_ALIASES) {
      expect(schematicOutcomeToRuntimeRoute(alias)).toBe(RUNTIME_SUCCESS_ROUTE);
    }
    expect(schematicOutcomeToRuntimeRoute('retry')).toBeUndefined();
  });

  it('projects static checkpoint choices into explicit compiled routes', () => {
    const schematic = loadBuildSchematic();
    const mutated = {
      ...schematic,
      items: schematic.items.map((item) =>
        item.id === ('frame-step' as unknown as typeof item.id)
          ? {
              ...item,
              check: { allow: ['approve'] },
              checkpoint_policy: {
                ...item.checkpoint_policy,
                choices: [{ id: 'approve', label: 'Approve' }],
                safe_default_choice: 'approve',
              },
            }
          : item,
      ),
    };

    const compiled = compileSchematicToCompiledFlow(FlowSchematic.parse(mutated));
    expect(compiled.kind).toBe('single');
    if (compiled.kind !== 'single') return;
    const checkpoint = compiled.flow.steps.find((step) => step.id === 'frame-step');
    expect(checkpoint?.routes).toMatchObject({
      pass: 'analyze-step',
      approve: 'analyze-step',
    });
  });

  it('passes optional step skill slots through to the compiled flow', () => {
    const schematic = loadBuildSchematic();
    const mutated = {
      ...schematic,
      items: schematic.items.map((item) =>
        item.id === ('act-step' as unknown as typeof item.id)
          ? {
              ...item,
              skill_slots: [
                {
                  id: 'test-discipline',
                  description: 'Optional local skill for implementation discipline.',
                },
              ],
            }
          : item,
      ),
    };
    const compiled = compileSchematicToCompiledFlow(FlowSchematic.parse(mutated));
    expect(compiled.kind).toBe('single');
    if (compiled.kind !== 'single') return;
    const actStep = compiled.flow.steps.find((step) => step.id === 'act-step');
    expect(actStep?.skill_slots).toEqual([
      {
        id: 'test-discipline',
        description: 'Optional local skill for implementation discipline.',
      },
    ]);
  });

  it('throws if a step has no continue/complete route mapping to pass', () => {
    // Target close-step (a leaf): removing its success route leaves the rest of
    // the graph reachable, so the M5 catalog gate stays clean and the route-mapping
    // check is what fires. Disconnecting a mid-graph step like frame-step would now
    // trip the gate's reachability check first.
    const schematic = loadBuildSchematic();
    const itemsCopy = schematic.items.map((item) =>
      item.id === ('close-step' as unknown as typeof item.id)
        ? ({ ...item, routes: { stop: '@stop' } } as unknown as typeof item)
        : item,
    );
    const broken = { ...schematic, items: itemsCopy } as unknown as typeof schematic;
    expect(() => compileSchematicToCompiledFlow(broken)).toThrow(/no outcome that maps to 'pass'/);
  });

  it('throws if a step declares duplicate success aliases', () => {
    const schematic = loadBuildSchematic();
    const itemsCopy = schematic.items.map((item) =>
      item.id === ('frame-step' as unknown as typeof item.id)
        ? ({
            ...item,
            routes: { ...item.routes, complete: '@complete' },
          } as unknown as typeof item)
        : item,
    );
    const broken = { ...schematic, items: itemsCopy } as unknown as typeof schematic;
    expect(() => compileSchematicToCompiledFlow(broken)).toThrow(
      /multiple outcomes that map to 'pass'/,
    );
  });
});
