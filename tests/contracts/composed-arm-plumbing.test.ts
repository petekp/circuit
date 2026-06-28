// The dynamic-vs-reference COMPOSED arm: offline plumbing proof.
//
// The composed arm runs a flow GENUINELY COMPOSED block by block (no family
// template) against the same fixtures as the reference and generated arms. Its
// one novel step is publishComposedFlow: it compiles a role set in process and
// writes it to disk exactly as `circuit create --publish` does — circuit.json
// under <home>/flows/<slug>/ plus a manifest.json the trust gate path-matches.
//
// This file proves, at $0, the two things that must hold for the live run to be
// meaningful, on BOTH composed shapes the harness runs:
//   1. The composed arc is genuine — VALID, RUNNABLE, and NOVEL (its block
//      sequence is not any built-in's), so the comparison can separate composed
//      from hand-authored rather than being parity by construction. FIX_LINEAR_FULL
//      is the fix arc; BUILD_LINEAR_FULL is the build arc (a content-checkpoint
//      frame, then plan/act/verify/review/close — leaner than the built-in build's
//      baseline + touch-area verifications, so novel).
//   2. publishComposedFlow writes a flow the runtime ACCEPTS: the trust gate
//      blesses it (manifest path-match) and the loader resolves + loads it with
//      flow.id === slug. This is the same trust gate + loader the subprocess run
//      uses, driven directly so no relay spend is needed.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type ComposeDeps,
  FIX_LINEAR_FULL,
  FIX_LINEAR_LEAN,
  FIX_LINEAR_LOOP,
  publishComposedFlowWith,
} from '../../evals/dynamic-vs-reference/composed-fix-shapes.js';
import { loadCompiledFlow, resolveCompiledFlowPath } from '../../src/cli/compiled-flow-loading.js';
import { fixtureEligibleForRuntime } from '../../src/cli/runtime-routing-policy.js';
import { assembleFlowSchematic } from '../../src/flows/assemble-flow-schematic.js';
import { flowDefinitions } from '../../src/flows/catalog.js';
import { compileSchematicToCompiledFlow } from '../../src/flows/compile-schematic-to-flow.js';
import { planCompiledFlowFiles } from '../../src/flows/compiled-flow-file-plan.js';
import {
  BUILD_LINEAR_FULL,
  composeFlow,
  evaluateNovelty,
  evaluateRunnability,
  evaluateValidity,
} from '../../src/flows/composition/index.js';

// The test binds the src exports as deps (vitest resolves the src .ts graph).
// The harness binds the built dist exports instead; both go through the same
// publishComposedFlowWith logic.
const srcDeps: ComposeDeps = {
  composeFlow,
  evaluateValidity,
  evaluateRunnability,
  assembleFlowSchematic,
  compileSchematicToCompiledFlow,
  planCompiledFlowFiles,
  flowDefinitions,
  BUILD_LINEAR_FULL,
};

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'composed-arm-'));
}

describe('composed fix arc — genuine, runnable, novel', () => {
  it('FIX_LINEAR_FULL is offline-valid and runtime-runnable', () => {
    const outcome = composeFlow(FIX_LINEAR_FULL, { definitions: flowDefinitions });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const validity = evaluateValidity(outcome.spec);
    expect(validity.valid).toBe(true);
    expect(validity.compiles).toBe(true);

    const runnability = evaluateRunnability(outcome.spec);
    expect(runnability.runnable).toBe(true);
    expect(runnability.aborts).toEqual([]);
  });

  it('FIX_LINEAR_FULL is NOVEL — not any built-in (so the comparison discriminates)', () => {
    const outcome = composeFlow(FIX_LINEAR_FULL, { definitions: flowDefinitions });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const validity = evaluateValidity(outcome.spec);
    expect(validity.schematic).toBeDefined();
    if (validity.schematic === undefined) return;

    const novelty = evaluateNovelty(validity.schematic, flowDefinitions);
    expect(novelty.novel).toBe(true);
    // Closest built-in is the fix flow, but not a match — a low-overlap neighbor.
    // Pinning the neighbor identity (not the exact jaccard) keeps this stable.
    expect(novelty.closest?.flowId).toBe('fix');
    expect(novelty.matches).toBeUndefined();
  });

  it('FIX_LINEAR_LOOP (recovery variant) is also valid and runnable', () => {
    const outcome = composeFlow(FIX_LINEAR_LOOP, { definitions: flowDefinitions });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const validity = evaluateValidity(outcome.spec);
    expect(validity.valid).toBe(true);
    const runnability = evaluateRunnability(outcome.spec);
    expect(runnability.runnable).toBe(true);
  });

  it('FIX_LINEAR_LEAN (no gather-context) is valid, runnable, and NOVEL', () => {
    // The lean arc drops gather-context: frame -> diagnose -> act -> verify ->
    // close (5 blocks). It keeps diagnose because the composer's `act` block
    // requires an analysis precursor (the writer-coupling wall) — a bare
    // frame->act->verify->close walls at act. So LEAN is the shortest arc that
    // still runs, the low end of the shape-sensitivity sweep.
    const outcome = composeFlow(FIX_LINEAR_LEAN, { definitions: flowDefinitions });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const validity = evaluateValidity(outcome.spec);
    expect(validity.valid).toBe(true);
    expect(validity.compiles).toBe(true);

    const runnability = evaluateRunnability(outcome.spec);
    expect(runnability.runnable).toBe(true);
    expect(runnability.aborts).toEqual([]);

    expect(validity.schematic).toBeDefined();
    if (validity.schematic === undefined) return;
    const novelty = evaluateNovelty(validity.schematic, flowDefinitions);
    expect(novelty.novel).toBe(true);
    // Still closest to the fix flow, but a more distant neighbor than FULL
    // (one fewer shared block), so the comparison discriminates.
    expect(novelty.closest?.flowId).toBe('fix');
    expect(novelty.matches).toBeUndefined();
  });
});

describe('composed build arc — genuine, runnable, novel', () => {
  it('BUILD_LINEAR_FULL is offline-valid and runtime-runnable', () => {
    const outcome = composeFlow(BUILD_LINEAR_FULL, { definitions: flowDefinitions });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const validity = evaluateValidity(outcome.spec);
    expect(validity.valid).toBe(true);
    expect(validity.compiles).toBe(true);

    const runnability = evaluateRunnability(outcome.spec);
    expect(runnability.runnable).toBe(true);
    expect(runnability.aborts).toEqual([]);
  });

  it('BUILD_LINEAR_FULL is NOVEL — not the built-in build (so the comparison discriminates)', () => {
    const outcome = composeFlow(BUILD_LINEAR_FULL, { definitions: flowDefinitions });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const validity = evaluateValidity(outcome.spec);
    expect(validity.schematic).toBeDefined();
    if (validity.schematic === undefined) return;

    const novelty = evaluateNovelty(validity.schematic, flowDefinitions);
    expect(novelty.novel).toBe(true);
    // Closest neighbor is fix-until-green, a partial-overlap neighbor: it is the
    // internal Converge flow whose loop body is a plan -> act -> verify -> review
    // arc, structurally nearer to this composed linear build than the built-in
    // build (which adds a baseline + touch-area verifications the linear arc omits).
    // The jaccard stays well below the duplicate threshold, so the arc is still
    // NOVEL and the comparison still discriminates. Pinning the neighbor identity
    // (not the exact jaccard) keeps this stable.
    expect(novelty.closest?.flowId).toBe('fix-until-green');
    expect(novelty.matches).toBeUndefined();
  });
});

describe('publishComposedFlow — trust-accepted and loadable', () => {
  it('writes a flow the trust gate blesses and the loader resolves', () => {
    const home = tempHome();
    try {
      const published = publishComposedFlowWith(srcDeps, {
        roleSet: FIX_LINEAR_FULL,
        home,
        description: 'composed fix arc (plumbing test)',
        createdAt: '2026-01-01T00:00:00.000Z',
      });

      expect(published.slug).toBe('fix-linear-full');
      const flowRoot = join(home, 'flows');
      const expectedPath = resolve(flowRoot, published.slug, 'circuit.json');
      expect(published.flowPath).toBe(expectedPath);

      // The trust gate: same call the CLI makes for a `run --flow-root` of a
      // published custom flow. The manifest beside flowRoot must path-match the
      // resolved circuit.json, or the runtime fails closed.
      const trusted = fixtureEligibleForRuntime({
        args: { flowRoot },
        fixturePath: published.flowPath,
      });
      expect(trusted).toBe(true);

      // The loader: resolve the slug to circuit.json (default mode) and load it.
      const resolved = resolveCompiledFlowPath(published.slug, undefined, undefined, flowRoot);
      expect(resolved).toBe(expectedPath);
      const { flow } = loadCompiledFlow(resolved);
      // validateCustomFlow requires flow.id === slug; the publish keeps them in step.
      expect(flow.id).toBe(published.slug);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('writes the build arc as a trust-accepted, loadable flow too', () => {
    const home = tempHome();
    try {
      const published = publishComposedFlowWith(srcDeps, {
        roleSet: BUILD_LINEAR_FULL,
        home,
        description: 'composed build arc (plumbing test)',
        createdAt: '2026-01-01T00:00:00.000Z',
      });

      expect(published.slug).toBe('build-linear-full');
      const flowRoot = join(home, 'flows');
      const expectedPath = resolve(flowRoot, published.slug, 'circuit.json');
      expect(published.flowPath).toBe(expectedPath);

      const trusted = fixtureEligibleForRuntime({
        args: { flowRoot },
        fixturePath: published.flowPath,
      });
      expect(trusted).toBe(true);

      const resolved = resolveCompiledFlowPath(published.slug, undefined, undefined, flowRoot);
      expect(resolved).toBe(expectedPath);
      const { flow } = loadCompiledFlow(resolved);
      expect(flow.id).toBe(published.slug);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('fails closed: the trust gate rejects a flow with no manifest beside it', () => {
    const home = tempHome();
    try {
      const flowRoot = join(home, 'flows');
      // A path inside an unpublished flow root — no manifest.json written.
      const orphan = resolve(flowRoot, 'fix-linear-full', 'circuit.json');
      const trusted = fixtureEligibleForRuntime({
        args: { flowRoot },
        fixturePath: orphan,
      });
      expect(trusted).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
