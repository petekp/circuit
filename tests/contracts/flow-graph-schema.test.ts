// CompiledFlow graph closure schema — see docs/contracts/compiled-flow.md.

import { describe, expect, it } from 'vitest';
import { CompiledFlow } from '../../src/index.js';

describe('CompiledFlow graph closure', () => {
  const okFrameStep = {
    id: 'frame',
    title: 'Frame',
    executor: 'orchestrator' as const,
    kind: 'compose' as const,
    protocol: 'build-frame@v1',
    reads: [],
    writes: { report: { path: 'reports/brief.md', schema: 'brief@v1' } },
    check: {
      kind: 'schema_sections' as const,
      source: { kind: 'report' as const, ref: 'report' },
      required: ['Objective'],
    },
    routes: { pass: '@complete' },
  };

  // Partial stage path policy omitting the 6 non-frame canonicals, for fixtures that
  // only need to isolate one stage. Verbose by design (stage-I4): every omission
  // is named and rationalized.
  const partialSpineOmittingNonFrame = {
    mode: 'partial' as const,
    omits: ['analyze', 'plan', 'act', 'verify', 'review', 'close'] as const,
    rationale: 'minimal test fixture isolating the frame stage',
  };

  const okCompiledFlow = (overrides: Record<string, unknown> = {}) => ({
    schema_version: '3',
    id: 'build',
    version: '2026-04-18',
    purpose: 'Build features.',
    axes: {
      allowed_rigors: ['standard'],
      supports_tournament: false,
      supports_autonomous: false,
    },
    starts_at: 'frame',
    stages: [{ id: 'frame-stage', title: 'Frame', canonical: 'frame', steps: ['frame'] }],
    steps: [okFrameStep],
    stage_path_policy: partialSpineOmittingNonFrame,
    ...overrides,
  });

  it('happy path parses', () => {
    expect(CompiledFlow.safeParse(okCompiledFlow()).success).toBe(true);
  });

  it('WF-I1: rejects duplicate step ids', () => {
    expect(
      CompiledFlow.safeParse(okCompiledFlow({ steps: [okFrameStep, okFrameStep] })).success,
    ).toBe(false);
  });

  it('WF-I2: rejects starts_at referencing an unknown step', () => {
    const result = CompiledFlow.safeParse(
      okCompiledFlow({
        starts_at: 'nowhere',
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      const issuePaths = result.error.issues.map((i) => i.path.join('.'));
      expect(
        issuePaths.some((p) => p === 'starts_at'),
        `WF-I2 isolation: expected an issue at starts_at, got paths ${JSON.stringify(issuePaths)}`,
      ).toBe(true);
    }
  });

  it('WF-I3: rejects stage referencing an unknown step', () => {
    expect(
      CompiledFlow.safeParse(
        okCompiledFlow({
          stages: [{ id: 'frame-stage', title: 'Frame', canonical: 'frame', steps: ['ghost'] }],
        }),
      ).success,
    ).toBe(false);
  });

  it('WF-I4: rejects route target that is neither terminal nor a known step', () => {
    expect(
      CompiledFlow.safeParse(
        okCompiledFlow({
          steps: [{ ...okFrameStep, routes: { pass: 'missing-target' } }],
        }),
      ).success,
    ).toBe(false);
  });

  it('WF-I5: rejects legacy entry_modes fields', () => {
    expect(
      CompiledFlow.safeParse(
        okCompiledFlow({
          entry_modes: [
            { name: 'default', start_at: 'frame', depth: 'standard', description: 'a' },
            { name: 'default', start_at: 'frame', depth: 'standard', description: 'b' },
          ],
        }),
      ).success,
    ).toBe(false);
  });

  it('WF-I6: rejects duplicate stage ids', () => {
    expect(
      CompiledFlow.safeParse(
        okCompiledFlow({
          stages: [
            { id: 'frame-stage', title: 'Frame A', canonical: 'frame', steps: ['frame'] },
            { id: 'frame-stage', title: 'Frame B', steps: ['frame'] },
          ],
        }),
      ).success,
    ).toBe(false);
  });

  it('WF-I7: rejects schema_version other than the literal "3"', () => {
    expect(CompiledFlow.safeParse(okCompiledFlow({ schema_version: '1' })).success).toBe(false);
    expect(CompiledFlow.safeParse(okCompiledFlow({ schema_version: 3 })).success).toBe(false);
  });

  it('WF-I7: a retired schema_version fails with an issue at the schema_version path', () => {
    // Version-mismatch legibility (docs/contracts/schema-versioning.md):
    // a pre-bump artifact must fail with an error that names
    // schema_version, not just an unrecognized-key puzzle.
    const result = CompiledFlow.safeParse(okCompiledFlow({ schema_version: '2' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === 'schema_version')).toBe(true);
    }
  });

  it('WF-I8: rejects a flow with a step that cannot reach a terminal route target', () => {
    // Two steps routing only to each other — cycle with no terminal escape.
    // Neither step can reach @complete/@stop/@escalate/@handoff.
    const stepA = {
      ...okFrameStep,
      id: 'a',
      routes: { pass: 'b' },
    };
    const stepB = {
      ...okFrameStep,
      id: 'b',
      routes: { pass: 'a' },
    };
    const result = CompiledFlow.safeParse(
      okCompiledFlow({
        starts_at: 'a',
        stages: [{ id: 'frame-stage', title: 'Frame', canonical: 'frame', steps: ['a', 'b'] }],
        steps: [stepA, stepB],
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = JSON.stringify(result.error.issues);
      expect(msg).toContain('WF-I8');
    }
  });

  it('WF-I8: accepts a flow where every step has a terminal route chain', () => {
    // Two steps: a → b → @complete. Both reach a terminal.
    const stepA = {
      ...okFrameStep,
      id: 'a',
      routes: { pass: 'b' },
    };
    const stepB = {
      ...okFrameStep,
      id: 'b',
      routes: { pass: '@complete' },
    };
    const result = CompiledFlow.safeParse(
      okCompiledFlow({
        starts_at: 'a',
        stages: [{ id: 'frame-stage', title: 'Frame', canonical: 'frame', steps: ['a', 'b'] }],
        steps: [stepA, stepB],
      }),
    );
    expect(result.success).toBe(true);
  });

  it('WF-I9: rejects a flow with a step unreachable from starts_at', () => {
    // Step 'a' goes to @complete. Step 'b' goes to @complete but nothing
    // routes into 'b'. 'b' is declared but dead.
    const stepA = {
      ...okFrameStep,
      id: 'a',
      routes: { pass: '@complete' },
    };
    const stepB = {
      ...okFrameStep,
      id: 'b',
      routes: { pass: '@complete' },
    };
    const result = CompiledFlow.safeParse(
      okCompiledFlow({
        starts_at: 'a',
        stages: [{ id: 'frame-stage', title: 'Frame', canonical: 'frame', steps: ['a', 'b'] }],
        steps: [stepA, stepB],
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = JSON.stringify(result.error.issues);
      expect(msg).toContain('WF-I9');
    }
  });

  it('WF-I9: accepts when both steps are reached from starts_at', () => {
    // Step 'a' routes to 'b', so both declared steps are reached.
    const stepA = {
      ...okFrameStep,
      id: 'a',
      routes: { pass: 'b' },
    };
    const stepB = {
      ...okFrameStep,
      id: 'b',
      routes: { pass: '@complete' },
    };
    const result = CompiledFlow.safeParse(
      okCompiledFlow({
        starts_at: 'a',
        stages: [{ id: 'frame-stage', title: 'Frame', canonical: 'frame', steps: ['a', 'b'] }],
        steps: [stepA, stepB],
      }),
    );
    expect(result.success).toBe(true);
  });

  it('WF-I10: rejects a step whose routes use an author-friendly alias (no `pass` key)', () => {
    // Routes use `success` instead of `pass`. WF-I8 would accept (the
    // `success` edge reaches @complete) but at runtime the
    // check.evaluated outcome is `pass`, and routes['pass'] is undefined
    // — the run stalls. WF-I10 fails this at parse time.
    const aliasedStep = {
      ...okFrameStep,
      routes: { success: '@complete' },
    };
    const result = CompiledFlow.safeParse(
      okCompiledFlow({
        steps: [aliasedStep],
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = JSON.stringify(result.error.issues);
      expect(msg).toContain('WF-I10');
    }
  });

  it('WF-I10: accepts a step that contains the `pass` key among its routes', () => {
    // Minimum legal fixture for WF-I10: routes contains `pass`. Extra
    // route labels (like `fail`) are allowed but not required at v0.2.
    const result = CompiledFlow.safeParse(
      okCompiledFlow({
        steps: [{ ...okFrameStep, routes: { pass: '@complete', fail: '@stop' } }],
      }),
    );
    expect(result.success).toBe(true);
  });

  it('WF-I11 (Runtime Safety Floor): rejects a self-cycle on routes.pass even when fail reaches @complete', () => {
    const loopStep = {
      ...okFrameStep,
      id: 'loop-step',
      routes: { pass: 'loop-step', fail: '@complete' },
    };
    const result = CompiledFlow.safeParse(
      okCompiledFlow({
        starts_at: 'loop-step',
        stages: [{ id: 'frame-stage', title: 'Frame', canonical: 'frame', steps: ['loop-step'] }],
        steps: [loopStep],
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = JSON.stringify(result.error.issues);
      expect(msg).toContain('WF-I11');
      expect(msg).toContain('loop-step');
    }
  });

  it('WF-I11 (Runtime Safety Floor): rejects a multi-step pass-cycle even when alternate routes reach terminals', () => {
    const stepA = {
      ...okFrameStep,
      id: 'a',
      routes: { pass: 'b', fail: '@complete' },
    };
    const stepB = {
      ...okFrameStep,
      id: 'b',
      routes: { pass: 'a', fail: '@complete' },
    };
    const result = CompiledFlow.safeParse(
      okCompiledFlow({
        starts_at: 'a',
        stages: [{ id: 'frame-stage', title: 'Frame', canonical: 'frame', steps: ['a', 'b'] }],
        steps: [stepA, stepB],
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = JSON.stringify(result.error.issues);
      expect(msg).toContain('WF-I11');
      expect(msg).toContain('routes.pass');
    }
  });

  it('WF-I11 (Runtime Safety Floor): accepts a pass chain that reaches a terminal', () => {
    const stepA = {
      ...okFrameStep,
      id: 'a',
      routes: { pass: 'b', fail: '@complete' },
    };
    const stepB = {
      ...okFrameStep,
      id: 'b',
      routes: { pass: '@complete' },
    };
    const result = CompiledFlow.safeParse(
      okCompiledFlow({
        starts_at: 'a',
        stages: [{ id: 'frame-stage', title: 'Frame', canonical: 'frame', steps: ['a', 'b'] }],
        steps: [stepA, stepB],
      }),
    );
    expect(result.success).toBe(true);
  });
});
