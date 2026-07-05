// Whole-grain close tolerance — a folded build-derived flow runs end-to-end.
//
// The whole-grain (folded) structure drops build's analyze relay, both
// auxiliary verify checks, and the review relay, leaving one folded work spine:
// frame -> plan -> act -> verify -> close. That spine has NO review step and NO
// touch-area step, so the close writer receives neither report.
//
// This test folds build's real assembly spec to the whole grain, compiles it,
// and drives it through the real graph runner to a terminal outcome. Before the
// close writer learned to tolerate absent review/touch-area reads, the close
// step threw at runtime ("expected exactly one report writer for schema
// 'build.review@v1', found 0") and the run never reached a terminal close. Now
// it closes with a schema-valid build.result that marks both aspects "not
// assessed" rather than fabricating a passing verdict or a clean containment.
//
// build's OWN full flow always supplies both reports; its byte-identical
// behavior is pinned by tests/runner/m9-truth-test-assembled-build.test.ts,
// which still drives the full spine to 'complete' with review_verdict 'accept'.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow } from '../helpers/runtime-fixtures.js';

import type { ClaudeCodeRelayInput } from '../../src/connectors/claude-code.js';
import { assembleFlowSchematic } from '../../src/flows/assemble-flow-schematic.js';
import { buildAssemblySpec } from '../../src/flows/build/assembly-spec.js';
import { BuildResult } from '../../src/flows/build/reports.js';
import { compileSchematicToCompiledFlow } from '../../src/flows/compile-schematic-to-flow.js';
import { applyStructure } from '../../src/flows/resolvers/structure.js';
import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { CompiledFlow } from '../../src/schemas/compiled-flow.js';
import type { RelayResult } from '../../src/shared/connector-relay.js';
import type { RelayFn } from '../../src/shared/relay-runtime-types.js';

const RUNTIME_TIMEOUT_MS = 120_000;

// The folded spine keeps only the act relay; analyze and review are gone.
function actOnlyRelayer(): RelayFn {
  const implementationBody = JSON.stringify({
    verdict: 'accept',
    summary: 'Implemented the requested change',
    changed_files: ['src/example.ts'],
    evidence: ['Stub implementation relay completed'],
  });
  return {
    connectorName: 'claude-code',
    relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
      // The whole grain has exactly one relay step (act-step). Anything else is
      // a sign the fold did not drop the analyze/review relays.
      expect(input.prompt.includes('Step: act-step')).toBe(true);
      return {
        request_payload: input.prompt,
        receipt_id: 'stub-whole-act',
        result_body: implementationBody,
        duration_ms: 1,
        cli_version: '0.0.0-stub',
      };
    },
  };
}

let runFolderBase: string;

function makeVerificationProjectRoot(): string {
  const projectRoot = join(runFolderBase, 'verification-project');
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(
    join(projectRoot, 'package.json'),
    `${JSON.stringify({ private: true, scripts: { check: 'node -e "process.exit(0)"' } }, null, 2)}\n`,
  );
  return projectRoot;
}

function wholeGrainBuildBytes(): Buffer {
  const wholeSpec = applyStructure(buildAssemblySpec, {
    axis: 'structure',
    choice: 'whole',
    binding_time: 'assembly',
    enforcement: 'enforced',
    rationale: 'test: fold build to the whole grain',
  });
  const compiled = compileSchematicToCompiledFlow(assembleFlowSchematic(wholeSpec));
  if (compiled.kind !== 'single') {
    throw new Error(`expected a single compiled flow, got '${compiled.kind}'`);
  }
  return Buffer.from(`${JSON.stringify(compiled.flow)}\n`);
}

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-whole-close-'));
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
});

describe('whole-grain close tolerates absent review and touch area', () => {
  it('the folded flow has no review or touch-area step', () => {
    const compiled = CompiledFlow.parse(JSON.parse(wholeGrainBuildBytes().toString('utf8')));
    const stepIds = compiled.steps.map((step) => step.id);
    expect(stepIds).not.toContain('review-step');
    expect(stepIds).not.toContain('build-touch-area');
    expect(stepIds).toEqual(
      expect.arrayContaining(['frame-step', 'plan-step', 'act-step', 'verify-step', 'close-step']),
    );
  });

  it(
    'runs to a terminal close and marks review + touch area not assessed',
    async () => {
      const runFolder = join(runFolderBase, 'whole-run');
      const outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: wholeGrainBuildBytes(),
        runId: 'c9000000-0000-0000-0000-000000000000',
        goal: 'Add a tiny feature to the example module',
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 5, 16, 8, 0, 0)),
        relayer: actOnlyRelayer(),
        projectRoot: makeVerificationProjectRoot(),
      });

      // The run reaches a terminal outcome instead of throwing at close.
      expect(['complete', 'needs_attention']).toContain(outcome.outcome);

      const result = BuildResult.parse(
        JSON.parse(readFileSync(join(runFolder, 'reports/build-result.json'), 'utf8')),
      );
      // No reviewer looked and no gate ran, so the result is honestly degraded:
      // verification passed, but the build needs a human. Neither aspect is
      // fabricated as a clean pass.
      expect(result.outcome).toBe('needs_attention');
      expect(result.verification_status).toBe('passed');
      expect(result.review_verdict).toBe('not_assessed');
      expect(result.touch_area.containment).toBe('not_assessed');
      // The absent review pointer is dropped, not faked with an empty path.
      expect(result.evidence_links).toHaveLength(4);
      expect(result.evidence_links.some((link) => link.report_id === 'build.review')).toBe(false);
    },
    RUNTIME_TIMEOUT_MS,
  );
});
