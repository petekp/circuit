// Declaration-layer scalar schemas — `CompiledDepth`, `Role`, and
// `ChangeKindDeclaration` exports from `src/index.ts`. Covers closed-enum
// and structural-shape contracts that the larger family suites build on.

import { describe, expect, it } from 'vitest';
import {
  Axes,
  ChangeKindDeclaration,
  CompiledDepth,
  Depth,
  FlowAxes,
  Role,
  isConsequentialAxes,
  isConsequentialDepth,
} from '../../src/index.js';

describe('depth and axes', () => {
  it('accepts only low, medium, and high depth values', () => {
    expect(Depth.safeParse('low').success).toBe(true);
    expect(Depth.safeParse('medium').success).toBe(true);
    expect(Depth.safeParse('high').success).toBe(true);
    expect(Depth.safeParse('tournament').success).toBe(false);
    expect(Depth.safeParse('autonomous').success).toBe(false);
    expect(Depth.safeParse('max').success).toBe(false);
  });

  it('defaults axes to standard interactive non-tournament runs', () => {
    expect(Axes.parse({})).toEqual({
      depth: 'medium',
      tournament: false,
      tournament_n: 3,
      autonomous: false,
    });
  });

  it('validates the v1 tournament range', () => {
    expect(Axes.safeParse({ tournament: true, tournament_n: 2 }).success).toBe(true);
    expect(Axes.safeParse({ tournament: true, tournament_n: 4 }).success).toBe(true);
    expect(Axes.safeParse({ tournament: true, tournament_n: 1 }).success).toBe(false);
    expect(Axes.safeParse({ tournament: true, tournament_n: 5 }).success).toBe(false);
  });

  it('validates flow-owned axis allow-lists and defaults', () => {
    expect(
      FlowAxes.parse({
        allowed_depths: ['low', 'medium', 'high'],
        supports_tournament: true,
        supports_autonomous: true,
        tournament_fan_out_stage: 'decision-stage',
      }),
    ).toEqual({
      allowed_depths: ['low', 'medium', 'high'],
      supports_tournament: true,
      supports_autonomous: true,
      default: {
        depth: 'medium',
        tournament: false,
        tournament_n: 3,
        autonomous: false,
      },
      tournament_fan_out_stage: 'decision-stage',
    });

    expect(
      FlowAxes.safeParse({
        allowed_depths: ['medium'],
        supports_tournament: false,
        supports_autonomous: false,
        default: { depth: 'high' },
      }).success,
    ).toBe(false);
    expect(
      FlowAxes.safeParse({
        allowed_depths: ['medium'],
        supports_tournament: true,
      }).success,
    ).toBe(false);
    expect(
      FlowAxes.safeParse({
        allowed_depths: ['medium'],
        supports_tournament: false,
        tournament_fan_out_stage: 'decision-stage',
      }).success,
    ).toBe(false);
  });

  it('marks consequential axis combinations explicitly', () => {
    expect(isConsequentialAxes(Axes.parse({ depth: 'high' }))).toBe(true);
    expect(isConsequentialAxes(Axes.parse({ tournament: true }))).toBe(true);
    expect(isConsequentialAxes(Axes.parse({ autonomous: true }))).toBe(true);
    expect(isConsequentialAxes(Axes.parse({ depth: 'low' }))).toBe(false);
    expect(isConsequentialAxes(Axes.parse({ depth: 'medium' }))).toBe(false);
  });
});

describe('legacy depth compatibility', () => {
  it('keeps old flat depth values available during the axis migration', () => {
    expect(CompiledDepth.safeParse('medium').success).toBe(true);
    expect(CompiledDepth.safeParse('tournament').success).toBe(true);
    expect(CompiledDepth.safeParse('max').success).toBe(false);
  });

  it('maps consequential legacy depths through axes', () => {
    expect(isConsequentialDepth('high')).toBe(true);
    expect(isConsequentialDepth('tournament')).toBe(true);
    expect(isConsequentialDepth('autonomous')).toBe(true);
    expect(isConsequentialDepth('low')).toBe(false);
    expect(isConsequentialDepth('medium')).toBe(false);
  });
});

describe('role', () => {
  it('only includes relay roles; orchestrator is an executor, not a role', () => {
    expect(Role.safeParse('researcher').success).toBe(true);
    expect(Role.safeParse('implementer').success).toBe(true);
    expect(Role.safeParse('reviewer').success).toBe(true);
    expect(Role.safeParse('orchestrator').success).toBe(false);
  });
});

describe('ChangeKindDeclaration', () => {
  it('standard change_kinds require failure_mode + acceptance_evidence + alternate_framing', () => {
    const ok = ChangeKindDeclaration.safeParse({
      change_kind: 'ratchet-advance',
      failure_mode: 'regression on X',
      acceptance_evidence: 'test Y passes',
      alternate_framing: 'could frame as discovery',
    });
    expect(ok.success).toBe(true);
  });

  it('migration-escrow requires expires_at + restoration_plan', () => {
    const missingExpiry = ChangeKindDeclaration.safeParse({
      change_kind: 'migration-escrow',
      failure_mode: 'mid-migration state',
      acceptance_evidence: 'all old call sites removed',
      alternate_framing: 'could do it in one slice',
    });
    expect(missingExpiry.success).toBe(false);

    const ok = ChangeKindDeclaration.safeParse({
      change_kind: 'migration-escrow',
      failure_mode: 'mid-migration',
      acceptance_evidence: 'all old call sites removed',
      alternate_framing: 'one slice',
      expires_at: '2026-05-01T00:00:00.000Z',
      restoration_plan: 'revert commit X + re-run legacy test suite',
    });
    expect(ok.success).toBe(true);
  });

  it('break-glass requires post_hoc_adr_deadline_at', () => {
    const noDeadline = ChangeKindDeclaration.safeParse({
      change_kind: 'break-glass',
      failure_mode: 'prod down',
      acceptance_evidence: 'pager cleared',
      alternate_framing: 'triage then normal repair',
    });
    expect(noDeadline.success).toBe(false);
  });
});
