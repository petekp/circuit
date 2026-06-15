import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { flowDefinitions } from '../../src/flows/catalog.js';

const SLICE_2_4_TARGETS = new Map<string, readonly string[]>([
  ['review', ['intake-step', 'verdict-step']],
  ['pursue', ['contract-step', 'graph-step', 'wave-plan-step', 'close-step']],
  ['build', ['close-step']],
  ['fix', ['fix-close-low', 'fix-close']],
]);

const SLICE_2_5_TARGETS = new Map<string, readonly string[]>([
  ['build', ['verify-step']],
  ['pursue', ['verify-step']],
  [
    'fix',
    [
      'fix-regression-baseline',
      'fix-baseline-snapshot',
      'fix-verify',
      'fix-change-set',
      'fix-regression-rerun',
    ],
  ],
]);

const SLICE_2_6_TARGETS = new Map<string, readonly string[]>([
  ['review', ['audit-step']],
  ['build', ['act-step', 'review-step']],
  ['pursue', ['batch-step', 'review-step']],
  ['explore', ['synthesize-step', 'review-step', 'stress-proposals-step']],
  ['fix', ['fix-gather-context', 'fix-diagnose', 'fix-act', 'fix-review']],
]);

const SLICE_2_7_TARGETS = new Map<string, readonly string[]>([
  ['build', ['frame-step']],
  ['fix', ['fix-no-repro-decision']],
  ['explore', ['proposal-fanout-step', 'tradeoff-checkpoint-step']],
]);

function expandedStepIds(flowId: string): readonly string[] {
  // A flow authors its block steps one of two ways. Most still call the Block
  // Step expansion helpers inline in data.ts. The assembler's production
  // customers (build, pursue — first-class composition M9) instead list raw
  // BlockStepUse items in assembly-spec.ts, which assembleFlowSchematic expands.
  // Read whichever source the flow uses so this migration guard tracks the
  // authored block sequence rather than one specific call site.
  const dataSource = readFileSync(`src/flows/${flowId}/data.ts`, 'utf8');
  const helperIds = [
    ...dataSource.matchAll(
      /(?:expandBlockStepUse|composeBlockStep|relayBlockStep|verificationBlockStep|checkpointBlockStep)\(\{\s+id: '([^']+)'/g,
    ),
  ].map((match) => match[1]);

  // Top-level BlockStepUse items in assembly-spec.ts sit at four-space indent
  // (biome-enforced); nested ids (checkpoint choices, acceptance checks) are
  // deeper, and stage-label ids are mid-line, so neither matches.
  const specPath = `src/flows/${flowId}/assembly-spec.ts`;
  const specIds = existsSync(specPath)
    ? [...readFileSync(specPath, 'utf8').matchAll(/^ {4}id: '([^']+)',/gm)].map((match) => match[1])
    : [];

  return [...helperIds, ...specIds].filter((stepId): stepId is string => stepId !== undefined);
}

describe('Block-simplified authoring migration', () => {
  it('migrates the Slice 2.4 compose and close steps to Block Step expansion', () => {
    for (const [flowId, expectedStepIds] of SLICE_2_4_TARGETS) {
      expect(expandedStepIds(flowId), flowId).toEqual(expect.arrayContaining([...expectedStepIds]));
    }
  });

  it('migrates the Slice 2.5 verification steps to Block Step expansion', () => {
    for (const [flowId, expectedStepIds] of SLICE_2_5_TARGETS) {
      expect(expandedStepIds(flowId), flowId).toEqual(expect.arrayContaining([...expectedStepIds]));
    }
  });

  it('migrates the Slice 2.6 relay steps to Block Step expansion', () => {
    for (const [flowId, expectedStepIds] of SLICE_2_6_TARGETS) {
      expect(expandedStepIds(flowId), flowId).toEqual(expect.arrayContaining([...expectedStepIds]));
    }
  });

  it('migrates the Slice 2.7 checkpoint, fanout, and special steps', () => {
    for (const [flowId, expectedStepIds] of SLICE_2_7_TARGETS) {
      expect(expandedStepIds(flowId), flowId).toEqual(expect.arrayContaining([...expectedStepIds]));
    }
  });

  it('keeps generated Schematic items complete after authoring compression', () => {
    for (const definition of flowDefinitions) {
      for (const item of definition.schematic.items) {
        expect(item.output, `${definition.id}:${item.id} output`).toBeDefined();
        expect(item.evidence_requirements, `${definition.id}:${item.id} evidence`).not.toHaveLength(
          0,
        );
        expect(item.execution, `${definition.id}:${item.id} execution`).toBeDefined();
        expect(item.writes, `${definition.id}:${item.id} writes`).toBeDefined();
        expect(item.check, `${definition.id}:${item.id} check`).toBeDefined();
      }
    }
  });
});
