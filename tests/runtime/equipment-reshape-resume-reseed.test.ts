import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { TraceEntry } from '../../src/runtime/domain/trace.js';
import { parseCompiledFlowBytes } from '../../src/runtime/run/compiled-flow-runner.js';
import { seedEquipmentReshapeFromTrace } from '../../src/runtime/run/equipment-reshape.js';
import type { CompiledFlow } from '../../src/schemas/compiled-flow.js';
import { RunEquipmentReshapeTraceEntry } from '../../src/schemas/trace-entry.js';

// F1 — the resume reseed for the live equipment reshape (Step 2).
//
// A reshape honored in the PRIOR process is recorded durably as a
// `run.equipment-reshape` trace entry (reshaped:true). On resume the run is
// rebuilt from the original, un-reshaped compiled-flow bytes, so without a
// reseed the resumed run silently drops the injected equipment. These tests pin
// the reseed: replay every honored reshape from the trace, in order, back onto
// the loaded flow, leaving everything else identical to today's resume.
//
// Mirrors the sibling reseeds (seedSkillHookInjectionsFromTrace,
// seedPowerInferenceFromTrace) — a pure fold over the trace. The fixture is the
// real Build compiled flow: a researcher relay (analyze-step) plus the
// implementer (act-step) and reviewer (review-step) relays a discovery equips.

const FIXTURE_PATH = resolve('generated/flows/build/circuit.json');

function buildFlow(): CompiledFlow {
  return parseCompiledFlowBytes(readFileSync(FIXTURE_PATH));
}

function slotIdsFor(flow: CompiledFlow, stepId: string): string[] {
  const step = flow.steps.find((s) => s.id === stepId);
  return ((step?.skill_slots ?? []) as ReadonlyArray<{ readonly id: string }>).map((s) => s.id);
}

const RUN_ID = '00000000-0000-4000-8000-000000000000';
let seq = 0;

// Build a real (schema-valid) run.equipment-reshape trace entry. Parsing through
// the schema keeps the fixture honest: these are the exact entries the live
// reshape writes, not hand-shaped stand-ins.
function reshapeEntry(overrides: {
  readonly step_id: string;
  readonly confirmed?: boolean;
  readonly reshaped?: boolean;
  readonly domain_tags?: string[];
  readonly equipped_steps?: string[];
  readonly reason?: string;
}): TraceEntry {
  seq += 1;
  return RunEquipmentReshapeTraceEntry.parse({
    schema_version: 1,
    sequence: seq,
    recorded_at: '2026-06-17T00:00:00.000Z',
    run_id: RUN_ID,
    kind: 'run.equipment-reshape',
    step_id: overrides.step_id,
    confirmed: overrides.confirmed ?? true,
    reshaped: overrides.reshaped ?? true,
    domain_tags: overrides.domain_tags ?? ['react'],
    ...(overrides.equipped_steps === undefined ? {} : { equipped_steps: overrides.equipped_steps }),
    reason: overrides.reason ?? 'confirmed react; equipped the remaining relays',
  }) as unknown as TraceEntry;
}

describe('seedEquipmentReshapeFromTrace', () => {
  it('replays an honored reshape back onto the loaded flow', () => {
    const flow = buildFlow();
    expect(slotIdsFor(flow, 'act-step')).not.toContain('react-expert');

    const reseeded = seedEquipmentReshapeFromTrace(
      [
        reshapeEntry({
          step_id: 'analyze-step',
          domain_tags: ['react'],
          equipped_steps: ['act-step', 'review-step'],
        }),
      ],
      flow,
    );

    // The injected equipment is back on the remaining relays ...
    expect(slotIdsFor(reseeded, 'act-step')).toContain('react-expert');
    expect(slotIdsFor(reseeded, 'review-step')).toContain('react-expert');
    // ... additively: the step's authored slot survives.
    expect(slotIdsFor(reseeded, 'act-step')).toContain('build-implementation');
  });

  it('never mutates the loaded flow (the original stays a valid fallback)', () => {
    const flow = buildFlow();
    seedEquipmentReshapeFromTrace(
      [
        reshapeEntry({
          step_id: 'analyze-step',
          domain_tags: ['react'],
          equipped_steps: ['act-step', 'review-step'],
        }),
      ],
      flow,
    );
    expect(slotIdsFor(flow, 'act-step')).not.toContain('react-expert');
  });

  it('returns the flow unchanged when the trace has no reshape entries', () => {
    const flow = buildFlow();
    const reseeded = seedEquipmentReshapeFromTrace([], flow);
    expect(slotIdsFor(reseeded, 'act-step')).toEqual(slotIdsFor(flow, 'act-step'));
    expect(slotIdsFor(reseeded, 'act-step')).not.toContain('react-expert');
  });

  it('ignores a parked reshape (reshaped:false) — the flow is unchanged', () => {
    const flow = buildFlow();
    const reseeded = seedEquipmentReshapeFromTrace(
      [
        reshapeEntry({
          step_id: 'analyze-step',
          reshaped: false,
          domain_tags: ['react'],
          equipped_steps: ['act-step', 'review-step'],
        }),
      ],
      flow,
    );
    expect(slotIdsFor(reseeded, 'act-step')).not.toContain('react-expert');
  });

  it('ignores an unconfirmed reshape (confirmed:false) — the flow is unchanged', () => {
    const flow = buildFlow();
    const reseeded = seedEquipmentReshapeFromTrace(
      [
        reshapeEntry({
          step_id: 'analyze-step',
          confirmed: false,
          reshaped: false,
          domain_tags: ['react'],
          equipped_steps: ['act-step', 'review-step'],
        }),
      ],
      flow,
    );
    expect(slotIdsFor(reseeded, 'act-step')).not.toContain('react-expert');
  });

  it('threads multiple honored reshapes in order onto one tail', () => {
    const flow = buildFlow();
    const reseeded = seedEquipmentReshapeFromTrace(
      [
        reshapeEntry({
          step_id: 'analyze-step',
          domain_tags: ['react'],
          equipped_steps: ['act-step', 'review-step'],
        }),
        reshapeEntry({
          step_id: 'act-step',
          domain_tags: ['sql'],
          equipped_steps: ['review-step'],
        }),
      ],
      flow,
    );
    // Both reshapes land: react from the first, sql from the second, stacked
    // additively on the review relay.
    expect(slotIdsFor(reseeded, 'act-step')).toContain('react-expert');
    expect(slotIdsFor(reseeded, 'review-step')).toContain('react-expert');
    expect(slotIdsFor(reseeded, 'review-step')).toContain('sql-schema');
  });

  it('is fail-safe: a replay that resolves to nothing is skipped, later honored reshapes still land', () => {
    const flow = buildFlow();
    const reseeded = seedEquipmentReshapeFromTrace(
      [
        // equipped_steps points at a step that is not a remaining relay, so the
        // replay re-resolves to no injection (ok:false). It must be skipped
        // without throwing or aborting the fold.
        reshapeEntry({
          step_id: 'analyze-step',
          domain_tags: ['react'],
          equipped_steps: ['no-such-step'],
        }),
        reshapeEntry({
          step_id: 'act-step',
          domain_tags: ['react'],
          equipped_steps: ['act-step', 'review-step'],
        }),
      ],
      flow,
    );
    expect(slotIdsFor(reseeded, 'act-step')).toContain('react-expert');
    expect(slotIdsFor(reseeded, 'review-step')).toContain('react-expert');
  });
});
