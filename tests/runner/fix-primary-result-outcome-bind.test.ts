import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { exitCodeForClosedOutcome } from '../../src/cli/run.js';
import { flowPackages } from '../../src/flows/catalog.js';
import { terminalOutcomeBoundToPrimaryResult } from '../../src/runtime/run/run-close.js';
import type { RunContext } from '../../src/runtime/run/run-context.js';

// H1 (pre-launch audit): the Fix flow — a flagship public flow — could close
// `@complete` and exit 0 even when its own primary result reported `partial`.
// The printed summary carried the caveat; the exit code and automation-facing
// run outcome did not. Two seams had to move together to make the outcome honest:
//
//   1. The primary-result -> run-outcome mapper must be vocabulary-agnostic. The
//      old mapper downgraded EVERY non-`complete`, non-`handoff` word to
//      `stopped`, so Fix's success words `fixed` / `not-reproduced` would have
//      been downgraded too — which is exactly why Fix could not arm the bind.
//   2. Fix must declare its primary result so the bind actually reads
//      reports/fix-result.json at close time and downgrades a degraded result.
//      That declaration used to sit alongside a separate opt-in flag; the flag
//      is gone and the declaration alone arms the bind.
//
// This drives the bind directly with a Fix-shaped close context (the run-close.ts
// characterization idiom) and pins the resulting exit code, then locks the
// source-level arming so the two seams can never drift apart.

// A Fix-shaped close context: the real Fix primary-result path, which is what
// arms the bind, reading a fix-result.json whose `outcome` is `outcome`.
function fixCloseContext(outcome: string): RunContext {
  return {
    flow: {
      id: 'fix',
      runtimeSurface: {
        primaryResult: { schemaName: 'fix.result@v1', path: 'reports/fix-result.json' },
      },
    },
    files: { readJson: async () => ({ outcome }) },
  } as unknown as RunContext;
}

describe('H1 — a Fix primary-result outcome binds the run outcome and exit code', () => {
  // The full FixResult vocabulary (src/flows/fix/reports.ts) exercised through the
  // real close-time bind, with the exit code each closed outcome yields.
  const cases: Array<{
    fixOutcome: string;
    boundOutcome: 'stopped' | 'handoff' | undefined;
    exitCode: number;
    note: string;
  }> = [
    { fixOutcome: 'partial', boundOutcome: 'stopped', exitCode: 1, note: 'the H1 leak' },
    { fixOutcome: 'failed', boundOutcome: 'stopped', exitCode: 1, note: 'degraded' },
    { fixOutcome: 'stopped', boundOutcome: 'stopped', exitCode: 1, note: 'degraded' },
    { fixOutcome: 'handoff', boundOutcome: 'handoff', exitCode: 1, note: 'neutral pause' },
    { fixOutcome: 'fixed', boundOutcome: undefined, exitCode: 0, note: 'clean success' },
    { fixOutcome: 'not-reproduced', boundOutcome: undefined, exitCode: 0, note: 'clean success' },
  ];

  for (const c of cases) {
    it(`fix-result outcome '${c.fixOutcome}' (${c.note}) binds to ${
      c.boundOutcome ?? 'complete'
    } / exit ${c.exitCode}`, async () => {
      const bound = await terminalOutcomeBoundToPrimaryResult(
        fixCloseContext(c.fixOutcome),
        'complete',
      );

      if (c.boundOutcome === undefined) {
        // Clean success words leave the proof-derived @complete close untouched.
        expect(bound).toBeUndefined();
        expect(exitCodeForClosedOutcome('complete')).toBe(0);
      } else {
        expect(bound?.outcome).toBe(c.boundOutcome);
        expect(bound?.reason).toContain('reports/fix-result.json');
        expect(bound?.reason).toContain(`'${c.fixOutcome}'`);
        expect(exitCodeForClosedOutcome(bound?.outcome ?? 'complete')).toBe(c.exitCode);
      }
    });
  }

  it('closes a partial Fix run short of complete: stopped, exit 1 (H1 fixed)', async () => {
    const bound = await terminalOutcomeBoundToPrimaryResult(fixCloseContext('partial'), 'complete');
    expect(bound?.outcome).toBe('stopped');
    expect(exitCodeForClosedOutcome(bound?.outcome ?? 'complete')).toBe(1);
  });

  it('still closes a clean Fix run complete: exit 0 (no success regression)', async () => {
    const bound = await terminalOutcomeBoundToPrimaryResult(fixCloseContext('fixed'), 'complete');
    expect(bound).toBeUndefined();
    expect(exitCodeForClosedOutcome('complete')).toBe(0);
  });
});

// The generated manifest is the surface the runtime actually reads:
// run-close.ts looks up runtime_surface.primary_result on exactly this JSON to
// decide whether to bind, so the declaration here is what it sees at close
// time. Fix authors it on its assembly spec; the in-code compileFlowDefinition
// path is a separate surface, so pinning the manifest — not the compiled
// package — is what proves the declaration reaches the engine and that
// emit-flows was re-run.
const FIX_MANIFEST = JSON.parse(
  readFileSync(resolve('generated/flows/fix/circuit.json'), 'utf8'),
) as {
  runtime_surface?: { primary_result?: { path?: string; schema_name?: string } };
};

describe('H1 — Fix reaches the terminal-outcome bind at the source', () => {
  it('fix declares at the source the primary result that arms the bind', () => {
    // The bind was a separate opt-in on engine_flags once. Declaring the
    // primary result IS the opt-in now, so this one declaration is the whole
    // arming surface and losing it would silently un-arm the flow.
    const fix = flowPackages.find((candidate) => candidate.id === 'fix');
    expect(fix?.runtimeSurface?.primaryResult?.path).toBe('reports/fix-result.json');
  });

  it('the generated manifest points primary_result at reports/fix-result.json', () => {
    expect(FIX_MANIFEST.runtime_surface?.primary_result?.path).toBe('reports/fix-result.json');
    expect(FIX_MANIFEST.runtime_surface?.primary_result?.schema_name).toBe('fix.result@v1');
  });
});
