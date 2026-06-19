// Brief: explainer post-editorial checkpoint (the remaining P0 from the
// paper-to-site generalization run). The expensive editorial fan-out (digest →
// ideate → tournament → harden → PICK → spec) must not be thrown away and
// re-spent when the child build fails. The probe (tests/runtime/checkpoint-resume
// PROBE arms) proved a single post-editorial checkpoint is NOT enough: in
// autonomous mode the gate auto-resolves `continue`, the build runs, and a build
// failure closes the run terminally with the gate already resolved — not
// resumable, so a retry re-runs editorial. The minimum that preserves editorial
// across a build failure is TWO gates:
//
//   spec-step → build-gate-step (plan) → build-step (act) → verify-step
//                                              │ stop (failed child)
//                                              ▼
//                                        retry-gate-step (act) → build-step (retry)
//                                                              → @stop
//
// build-step's `stop` recovery route lands on a FRESH retry-gate checkpoint, so a
// failed build parks the run resumably at an unresolved checkpoint instead of
// closing it. The editorial upstream of build-gate is recorded once and reused.
//
// These assertions are the failing-test-first surface for the wiring: they fail
// before the two gates exist and lock the structure after.
import { describe, expect, it } from 'vitest';

import { collectSchematicCatalogIssues } from '../../src/flows/schematic-catalog-check.js';
import type { FlowSchematic } from '../../src/schemas/flow-schematic.js';
import { schematicForFlow } from '../helpers/in-memory-schematics.js';

type Item = FlowSchematic['items'][number];

function explainer(): FlowSchematic {
  return schematicForFlow('explainer');
}

function itemById(schematic: FlowSchematic, id: string): Item {
  const item = schematic.items.find((candidate) => (candidate.id as unknown as string) === id);
  if (item === undefined) throw new Error(`explainer item '${id}' missing`);
  return item;
}

function routes(item: Item): Record<string, string> {
  return (item.routes ?? {}) as unknown as Record<string, string>;
}

describe('explainer post-editorial build gate + retry gate', () => {
  it('keeps the whole explainer schematic clean through the catalog gate', () => {
    expect(collectSchematicCatalogIssues(explainer())).toEqual([]);
  });

  it('inserts a build-gate checkpoint between spec-step and build-step', () => {
    const schematic = explainer();
    const gate = itemById(schematic, 'build-gate-step');
    expect(gate.stage as unknown as string).toBe('plan');
    expect(gate.block as unknown as string).toBe('human-decision');
    expect((gate.execution as unknown as { kind: string }).kind).toBe('checkpoint');
    // The spec routes into the gate; the gate proceeds to the build.
    expect(routes(itemById(schematic, 'spec-step')).continue).toBe('build-gate-step');
    expect(routes(gate).continue).toBe('build-step');
    // Autonomous-safe: the gate must auto-resolve `continue` for headless runs.
    const policy = gate.checkpoint_policy as unknown as { safe_default_choice?: string };
    expect(policy?.safe_default_choice).toBe('continue');
  });

  it('routes a failed build to a fresh retry-gate checkpoint, not to @stop', () => {
    const schematic = explainer();
    const build = itemById(schematic, 'build-step');
    // The recovery route that a non-complete child takes must land on the retry
    // gate so the run parks resumably instead of closing terminally.
    expect(routes(build).stop).toBe('retry-gate-step');
    expect(routes(build).continue).toBe('verify-step');

    const retry = itemById(schematic, 'retry-gate-step');
    expect(retry.block as unknown as string).toBe('human-decision');
    expect((retry.execution as unknown as { kind: string }).kind).toBe('checkpoint');
    // Retry re-enters the build (reusing editorial); stop ends cleanly.
    expect(routes(retry).continue).toBe('build-step');
    expect(routes(retry).stop).toBe('@stop');
    // Autonomous-safe: the retry gate must hold (stop) so an unattended run does
    // not loop retrying a deterministically failing build.
    const policy = retry.checkpoint_policy as unknown as { safe_default_choice?: string };
    expect(policy?.safe_default_choice).toBe('stop');
  });

  it('gives each new checkpoint a unique output contract (single producer)', () => {
    const schematic = explainer();
    const gateOutput = itemById(schematic, 'build-gate-step').output as unknown as string;
    const retryOutput = itemById(schematic, 'retry-gate-step').output as unknown as string;
    expect(gateOutput).toBe('explainer.build-authorization@v1');
    expect(retryOutput).toBe('explainer.build-retry@v1');
    // No other item may produce these outputs.
    const producersOf = (contract: string): string[] =>
      schematic.items
        .filter((item) => (item.output as unknown as string) === contract)
        .map((item) => item.id as unknown as string);
    expect(producersOf('explainer.build-authorization@v1')).toEqual(['build-gate-step']);
    expect(producersOf('explainer.build-retry@v1')).toEqual(['retry-gate-step']);
  });
});
