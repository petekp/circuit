import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ExecutableFlow } from '../../src/runtime/manifest/executable-flow.js';
import { fromCompiledFlow } from '../../src/runtime/manifest/from-compiled-flow.js';
import { validateExecutableFlow } from '../../src/runtime/manifest/validate-executable-flow.js';
import { CompiledFlow } from '../../src/schemas/compiled-flow.js';

function loadCompiledFlow(path: string): CompiledFlow {
  return CompiledFlow.parse(JSON.parse(readFileSync(path, 'utf8')));
}

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function stepById(flow: ExecutableFlow, id: string) {
  const step = flow.steps.find((candidate) => candidate.id === id);
  if (step === undefined) throw new Error(`missing step ${id}`);
  return step;
}

describe('fromCompiledFlow', () => {
  const representativeFlows = [
    'generated/flows/review/circuit.json',
    'generated/flows/fix/circuit.json',
    'generated/flows/build/circuit.json',
    'generated/flows/explore/tournament.json',
  ] as const;

  it('converts representative generated flows into valid executable manifests', () => {
    const converted = representativeFlows.map((path) => ({
      path,
      manifest: fromCompiledFlow(loadCompiledFlow(path)),
    }));

    for (const { manifest } of converted) {
      expect(validateExecutableFlow(manifest)).toEqual({ ok: true, issues: [] });
      expect(manifest.entry).toEqual(expect.any(String));
      expect(manifest.stages.length).toBeGreaterThan(0);
      expect(manifest.steps.length).toBeGreaterThan(0);
      expect(manifest.metadata).toMatchObject({
        source: 'compiled-flow-v1',
        schema_version: '3',
      });
    }

    const allKinds = new Set(
      converted.flatMap(({ manifest }) => manifest.steps.map((step) => step.kind)),
    );
    expect(allKinds).toEqual(new Set(['compose', 'verification', 'checkpoint', 'relay', 'fanout']));
  });

  it('preserves starts_at, stages, routes, reads, writes, and report refs', () => {
    const manifest = fromCompiledFlow(loadCompiledFlow('generated/flows/build/circuit.json'));

    expect(manifest.entry).toBe('frame-step');
    expect(manifest.entryModes).toBeUndefined();
    expect(manifest.stages.map((stage) => stage.id)).toEqual([
      'frame-stage',
      'analyze-stage',
      'plan-stage',
      'act-stage',
      'verify-stage',
      'review-stage',
      'close-stage',
    ]);

    const closeStep = stepById(manifest, 'close-step');
    expect(closeStep.routes.pass).toEqual({ kind: 'terminal', target: '@complete' });
    expect(closeStep.writes?.report).toEqual({
      path: 'reports/build-result.json',
      schema: 'build.result@v1',
    });

    const actStep = stepById(manifest, 'act-step');
    expect(actStep.reads).toEqual([
      { path: 'reports/build/brief.json' },
      { path: 'reports/build/plan.json' },
    ]);
    expect(actStep.writes).toMatchObject({
      request: { path: 'reports/relay/build-act.request.json' },
      receipt: { path: 'reports/relay/build-act.receipt.txt' },
      result: { path: 'reports/relay/build-act.result.json' },
      report: { path: 'reports/build/implementation.json', schema: 'build.implementation@v1' },
    });
  });

  it('uses compiled starts_at as the executable entry', () => {
    const raw = loadJson('generated/flows/review/circuit.json') as {
      starts_at: string;
    };

    const manifest = fromCompiledFlow(CompiledFlow.parse(raw));

    expect(manifest.entry).toBe(raw.starts_at);
  });

  it('preserves v1 selection field names at the adapter boundary', () => {
    const raw = loadJson('generated/flows/review/circuit.json') as {
      default_selection?: unknown;
    };
    raw.default_selection = {
      invocation_options: { temperature: 0.2 },
    };

    const manifest = fromCompiledFlow(CompiledFlow.parse(raw));

    expect(manifest.defaultSelection).toMatchObject({
      invocation_options: { temperature: 0.2 },
    });
    expect(manifest.defaultSelection).not.toHaveProperty('invocationOptions');
  });

  it('accepts overlapping stage membership from v1 compiled flows', () => {
    const raw = loadJson('generated/flows/review/circuit.json') as {
      stages: Array<{ id: string; title: string; steps: string[]; selection?: unknown }>;
    };
    raw.stages.push({
      id: 'overlap-stage',
      title: 'Overlap Selection',
      steps: ['intake-step'],
      selection: { effort: 'high' },
    });

    const parsed = CompiledFlow.parse(raw);
    const manifest = fromCompiledFlow(parsed);

    expect(validateExecutableFlow(manifest)).toEqual({ ok: true, issues: [] });
    expect(
      manifest.stages
        .filter((stage) => stage.stepIds.includes('intake-step'))
        .map((stage) => stage.id),
    ).toEqual(expect.arrayContaining(['overlap-stage']));
    expect(stepById(manifest, 'intake-step')).not.toHaveProperty('stageId');
  });

  it('preserves checkpoint policy and choice routes without implying execution parity', () => {
    const manifest = fromCompiledFlow(loadCompiledFlow('generated/flows/fix/circuit.json'));
    const checkpoint = stepById(manifest, 'fix-no-repro-decision');

    expect(checkpoint.kind).toBe('checkpoint');
    if (checkpoint.kind !== 'checkpoint') throw new Error('expected checkpoint');
    expect(checkpoint.choices).toEqual(['continue']);
    expect(checkpoint.routes.pass).toEqual({ kind: 'step', stepId: 'fix-act' });
    expect(checkpoint.routes).toMatchObject({
      revise: { kind: 'step', stepId: 'fix-diagnose' },
      handoff: { kind: 'step', stepId: 'fix-handoff' },
      escalate: { kind: 'terminal', target: '@escalate' },
      stop: { kind: 'terminal', target: '@stop' },
    });
    expect(checkpoint.policy).toMatchObject({
      prompt: expect.any(String),
    });
  });

  it('preserves fanout configuration and aggregate report refs', () => {
    const manifest = fromCompiledFlow(loadCompiledFlow('generated/flows/explore/tournament.json'));
    const fanout = stepById(manifest, 'proposal-fanout-step');

    expect(fanout.kind).toBe('fanout');
    if (fanout.kind !== 'fanout') throw new Error('expected fanout');
    expect(fanout.branches).toMatchObject({
      kind: 'dynamic',
      source_report: 'reports/decision-options.json',
    });
    expect(fanout.writes?.aggregate).toMatchObject({
      path: 'reports/tournament-aggregate.json',
      schema: 'explore.tournament-aggregate@v1',
    });
    expect(fanout.onChildFailure).toBe('continue-others');
    expect(fanout.check).toMatchObject({ join: { policy: 'aggregate-survivors' } });
  });

  it('fails validation when an adapted route target is unknown', () => {
    const bad = loadCompiledFlow('generated/flows/review/circuit.json') as CompiledFlow & {
      steps: Array<{ routes: Record<string, string> }>;
    };
    const firstStep = bad.steps[0];
    if (firstStep === undefined) throw new Error('missing first step');
    firstStep.routes.pass = 'missing-step';

    expect(() => fromCompiledFlow(bad)).toThrow(
      "step 'intake-step' route 'pass' targets unknown step 'missing-step'",
    );
  });

  it('fails validation when an adapted non-checkpoint step lacks pass route', () => {
    const bad = loadCompiledFlow('generated/flows/review/circuit.json') as CompiledFlow & {
      steps: Array<{ routes: Record<string, string> }>;
    };
    const firstStep = bad.steps[0];
    if (firstStep === undefined) throw new Error('missing first step');
    firstStep.routes = Object.fromEntries(
      Object.entries(firstStep.routes).filter(([routeName]) => routeName !== 'pass'),
    );

    expect(() => fromCompiledFlow(bad)).toThrow(
      "step 'intake-step' is missing required route 'pass'",
    );
  });

  it('validates stage membership, checkpoint choice uniqueness, and optional executable entry modes', () => {
    const manifest = fromCompiledFlow(loadCompiledFlow('generated/flows/build/circuit.json'));
    const missingMembership: ExecutableFlow = {
      ...manifest,
      stages: manifest.stages.map((stage) =>
        stage.id === 'plan-stage'
          ? { ...stage, stepIds: stage.stepIds.filter((stepId) => stepId !== 'plan-step') }
          : stage,
      ),
    };
    expect(validateExecutableFlow(missingMembership).issues).toContain(
      "step 'plan-step' is not listed in any stage",
    );

    const duplicateStageStep: ExecutableFlow = {
      ...manifest,
      stages: manifest.stages.map((stage) =>
        stage.id === 'plan-stage' ? { ...stage, stepIds: [...stage.stepIds, 'plan-step'] } : stage,
      ),
    };
    expect(validateExecutableFlow(duplicateStageStep).issues).toContain(
      "stage 'plan-stage' lists step 'plan-step' more than once",
    );

    const checkpoint = stepById(manifest, 'frame-step');
    if (checkpoint.kind !== 'checkpoint') throw new Error('expected checkpoint');
    const duplicateChoice: ExecutableFlow = {
      ...manifest,
      steps: manifest.steps.map((step) =>
        step.id === checkpoint.id && step.kind === 'checkpoint'
          ? { ...step, choices: ['continue', 'continue'] }
          : step,
      ),
    };
    expect(validateExecutableFlow(duplicateChoice).issues).toContain(
      "checkpoint step 'frame-step' has duplicate choice 'continue'",
    );

    const duplicateEntryMode: ExecutableFlow = {
      ...manifest,
      entryModes: [
        {
          name: 'default',
          startAt: 'frame-step',
          depth: 'standard',
          description: 'Default mode',
        },
        {
          name: 'default',
          startAt: 'missing-step',
          depth: 'standard',
          description: 'Duplicate default mode',
        },
      ],
    };
    expect(validateExecutableFlow(duplicateEntryMode).issues).toEqual(
      expect.arrayContaining([
        'duplicate entry mode name: default',
        "entry mode 'default' startAt references unknown step 'missing-step'",
      ]),
    );
  });
});
