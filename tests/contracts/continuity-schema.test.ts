// Continuity contract — see docs/contracts/continuity.md.

import { describe, expect, it } from 'vitest';
import {
  AmbientRecordPointer,
  AttachedRunPointer,
  ContinuityIndex,
  ContinuityRecord,
  PendingRecordPointer,
  RunAttachedProvenance,
} from '../../src/index.js';
import {
  CONT_AMBIENT_PROVENANCE,
  CONT_NARRATIVE,
  CONT_RUN,
  CONT_RUN_PROVENANCE,
} from '../helpers/continuity-builders.js';

describe('Continuity discriminated union (CONT-I3..I5)', () => {
  it('standalone form parses when auto_resume XOR requires_explicit_resume', () => {
    const ok = ContinuityRecord.safeParse({
      schema_version: 1,
      record_id: 'continuity-abc',
      project_root: '/Users/x/Code',
      continuity_kind: 'standalone',
      created_at: '2026-04-18T05:00:00.000Z',
      git: { cwd: '/Users/x/Code' },
      narrative: CONT_NARRATIVE,
      resume_contract: {
        mode: 'resume_standalone',
        auto_resume: false,
        requires_explicit_resume: true,
      },
    });
    expect(ok.success).toBe(true);
  });

  it('CONT-I4 — standalone form rejects run_ref (strict)', () => {
    const bad = ContinuityRecord.safeParse({
      schema_version: 1,
      record_id: 'continuity-abc',
      project_root: '/Users/x/Code',
      continuity_kind: 'standalone',
      created_at: '2026-04-18T05:00:00.000Z',
      git: { cwd: '/Users/x/Code' },
      narrative: CONT_NARRATIVE,
      resume_contract: {
        mode: 'resume_standalone',
        auto_resume: false,
        requires_explicit_resume: true,
      },
      run_ref: CONT_RUN_PROVENANCE,
    });
    expect(bad.success).toBe(false);
  });

  it('CONT-I4 — run-backed form requires run_ref', () => {
    const missing = ContinuityRecord.safeParse({
      schema_version: 1,
      record_id: 'continuity-abc',
      project_root: '/Users/x/Code',
      continuity_kind: 'run-backed',
      created_at: '2026-04-18T05:00:00.000Z',
      git: { cwd: '/Users/x/Code' },
      narrative: CONT_NARRATIVE,
      resume_contract: {
        mode: 'resume_run',
        auto_resume: false,
        requires_explicit_resume: true,
      },
    });
    expect(missing.success).toBe(false);
  });

  it('CONT-I5 — run-backed kind rejects resume_standalone mode', () => {
    const bad = ContinuityRecord.safeParse({
      schema_version: 1,
      record_id: 'continuity-abc',
      project_root: '/Users/x/Code',
      continuity_kind: 'run-backed',
      created_at: '2026-04-18T05:00:00.000Z',
      git: { cwd: '/Users/x/Code' },
      narrative: CONT_NARRATIVE,
      run_ref: CONT_RUN_PROVENANCE,
      resume_contract: {
        mode: 'resume_standalone',
        auto_resume: false,
        requires_explicit_resume: true,
      },
    });
    expect(bad.success).toBe(false);
  });

  it('CONT-I5 — standalone kind rejects resume_run mode', () => {
    const bad = ContinuityRecord.safeParse({
      schema_version: 1,
      record_id: 'continuity-abc',
      project_root: '/Users/x/Code',
      continuity_kind: 'standalone',
      created_at: '2026-04-18T05:00:00.000Z',
      git: { cwd: '/Users/x/Code' },
      narrative: CONT_NARRATIVE,
      resume_contract: {
        mode: 'resume_run',
        auto_resume: false,
        requires_explicit_resume: true,
      },
    });
    expect(bad.success).toBe(false);
  });

  it('run-backed form parses with full run_ref provenance', () => {
    const ok = ContinuityRecord.safeParse({
      schema_version: 1,
      record_id: 'continuity-xyz',
      project_root: '/Users/x/Code',
      continuity_kind: 'run-backed',
      created_at: '2026-04-19T00:00:00.000Z',
      git: { cwd: '/Users/x/Code' },
      narrative: CONT_NARRATIVE,
      run_ref: CONT_RUN_PROVENANCE,
      resume_contract: {
        mode: 'resume_run',
        auto_resume: true,
        requires_explicit_resume: false,
      },
    });
    expect(ok.success).toBe(true);
  });
});

describe('Continuity record_id — CONT-I1 (ControlPlaneFileStem)', () => {
  const baseStandalone = {
    schema_version: 1,
    project_root: '/Users/x/Code',
    continuity_kind: 'standalone' as const,
    created_at: '2026-04-18T05:00:00.000Z',
    git: { cwd: '/Users/x/Code' },
    narrative: CONT_NARRATIVE,
    resume_contract: {
      mode: 'resume_standalone' as const,
      auto_resume: false,
      requires_explicit_resume: true,
    },
  };

  it('CONT-I1 — rejects path separator in record_id', () => {
    const bad = ContinuityRecord.safeParse({
      ...baseStandalone,
      record_id: 'continuity/bad',
    });
    expect(bad.success).toBe(false);
  });

  it('CONT-I1 — rejects uppercase in record_id', () => {
    const bad = ContinuityRecord.safeParse({
      ...baseStandalone,
      record_id: 'Continuity-ABC',
    });
    expect(bad.success).toBe(false);
  });

  it('CONT-I1 — rejects parent-traversal in record_id', () => {
    const bad = ContinuityRecord.safeParse({
      ...baseStandalone,
      record_id: 'foo..bar',
    });
    expect(bad.success).toBe(false);
  });

  it('CONT-I1 — accepts UUID-suffixed lowercase record_id', () => {
    const ok = ContinuityRecord.safeParse({
      ...baseStandalone,
      record_id: 'continuity-19ee6b12-e0f6-4a67-a225-9cb93c6fa5b1',
    });
    expect(ok.success).toBe(true);
  });
});

describe('Continuity resume_contract — CONT-I6 (safety-boolean non-contradiction)', () => {
  const baseStandalone = {
    schema_version: 1,
    record_id: 'continuity-abc',
    project_root: '/Users/x/Code',
    continuity_kind: 'standalone' as const,
    created_at: '2026-04-18T05:00:00.000Z',
    git: { cwd: '/Users/x/Code' },
    narrative: CONT_NARRATIVE,
  };

  it('CONT-I6 — rejects auto_resume=true AND requires_explicit_resume=true', () => {
    const bad = ContinuityRecord.safeParse({
      ...baseStandalone,
      resume_contract: {
        mode: 'resume_standalone',
        auto_resume: true,
        requires_explicit_resume: true,
      },
    });
    expect(bad.success).toBe(false);
  });

  it('CONT-I6 — rejects auto_resume=false AND requires_explicit_resume=false', () => {
    const bad = ContinuityRecord.safeParse({
      ...baseStandalone,
      resume_contract: {
        mode: 'resume_standalone',
        auto_resume: false,
        requires_explicit_resume: false,
      },
    });
    expect(bad.success).toBe(false);
  });

  it('CONT-I6 — accepts explicit-resume (auto=false, requires=true)', () => {
    const ok = ContinuityRecord.safeParse({
      ...baseStandalone,
      resume_contract: {
        mode: 'resume_standalone',
        auto_resume: false,
        requires_explicit_resume: true,
      },
    });
    expect(ok.success).toBe(true);
  });

  it('CONT-I6 — accepts auto-resume (auto=true, requires=false)', () => {
    const ok = ContinuityRecord.safeParse({
      ...baseStandalone,
      resume_contract: {
        mode: 'resume_standalone',
        auto_resume: true,
        requires_explicit_resume: false,
      },
    });
    expect(ok.success).toBe(true);
  });
});

describe('RunAttachedProvenance — CONT-I7', () => {
  it('CONT-I7 — requires run_id + current_stage + current_step + runtime_status + runtime_updated_at', () => {
    expect(RunAttachedProvenance.safeParse(CONT_RUN_PROVENANCE).success).toBe(true);
  });

  it('CONT-I7 — rejects run_ref carrying only run_id (legacy under-provenance)', () => {
    const bad = RunAttachedProvenance.safeParse({ run_id: CONT_RUN });
    expect(bad.success).toBe(false);
  });

  it('CONT-I7 — rejects invalid runtime_status enum value', () => {
    const bad = RunAttachedProvenance.safeParse({
      ...CONT_RUN_PROVENANCE,
      runtime_status: 'frozen',
    });
    expect(bad.success).toBe(false);
  });

  it('CONT-I7 — accepts optional invocation_id', () => {
    const ok = RunAttachedProvenance.safeParse({
      ...CONT_RUN_PROVENANCE,
      invocation_id: 'inv_0191d2f0-cccc-7fff-8aaa-000000000031',
    });
    expect(ok.success).toBe(true);
  });

  it('CONT-I8 — strict: rejects surplus keys (legacy "manifest_present")', () => {
    const bad = RunAttachedProvenance.safeParse({
      ...CONT_RUN_PROVENANCE,
      manifest_present: true,
    });
    expect(bad.success).toBe(false);
  });
});

describe('Continuity transitive strict — CONT-I8', () => {
  const baseRunBacked = {
    schema_version: 1,
    record_id: 'continuity-abc',
    project_root: '/Users/x/Code',
    continuity_kind: 'run-backed' as const,
    created_at: '2026-04-18T05:00:00.000Z',
    git: { cwd: '/Users/x/Code' },
    narrative: CONT_NARRATIVE,
    run_ref: CONT_RUN_PROVENANCE,
    resume_contract: {
      mode: 'resume_run' as const,
      auto_resume: true,
      requires_explicit_resume: false,
    },
  };

  it('CONT-I8 — top-level rejects surplus keys', () => {
    const bad = ContinuityRecord.safeParse({ ...baseRunBacked, unknown: 'x' });
    expect(bad.success).toBe(false);
  });

  it('CONT-I8 — git rejects surplus keys', () => {
    const bad = ContinuityRecord.safeParse({
      ...baseRunBacked,
      git: { cwd: '/Users/x/Code', remote: 'origin' },
    });
    expect(bad.success).toBe(false);
  });

  it('CONT-I8 — narrative rejects surplus keys', () => {
    const bad = ContinuityRecord.safeParse({
      ...baseRunBacked,
      narrative: { ...CONT_NARRATIVE, tags: ['x'] },
    });
    expect(bad.success).toBe(false);
  });

  it('CONT-I8 — resume_contract rejects surplus keys', () => {
    const bad = ContinuityRecord.safeParse({
      ...baseRunBacked,
      resume_contract: {
        mode: 'resume_run',
        auto_resume: true,
        requires_explicit_resume: false,
        policy: 'immediate',
      },
    });
    expect(bad.success).toBe(false);
  });
});

describe('ContinuityIndex aggregate — CONT-I9..I11', () => {
  it('CONT-I9 — parses fully null (idle index)', () => {
    const ok = ContinuityIndex.safeParse({
      schema_version: 1,
      project_root: '/Users/x/Code',
      pending_record: null,
      current_run: null,
    });
    expect(ok.success).toBe(true);
  });

  it('CONT-I9 — parses with both pointers populated (attached + pending)', () => {
    const ok = ContinuityIndex.safeParse({
      schema_version: 1,
      project_root: '/Users/x/Code',
      pending_record: {
        record_id: 'continuity-abc',
        continuity_kind: 'run-backed',
        created_at: '2026-04-19T00:00:00.000Z',
      },
      current_run: {
        run_id: CONT_RUN,
        current_stage: 'frame',
        current_step: 'frame-goal',
        runtime_status: 'in_progress',
        attached_at: '2026-04-19T00:00:00.000Z',
        last_validated_at: '2026-04-19T00:00:00.000Z',
      },
    });
    expect(ok.success).toBe(true);
  });

  it('CONT-I10 — pending_record.record_id uses ControlPlaneFileStem (rejects uppercase)', () => {
    const bad = PendingRecordPointer.safeParse({
      record_id: 'CONTINUITY-ABC',
      continuity_kind: 'standalone',
      created_at: '2026-04-19T00:00:00.000Z',
    });
    expect(bad.success).toBe(false);
  });

  it('CONT-I10 — pending_record rejects unknown continuity_kind', () => {
    const bad = PendingRecordPointer.safeParse({
      record_id: 'continuity-abc',
      continuity_kind: 'archival',
      created_at: '2026-04-19T00:00:00.000Z',
    });
    expect(bad.success).toBe(false);
  });

  it('CONT-I11 — current_run requires run_id + stage/step + status + timestamps', () => {
    const bad = AttachedRunPointer.safeParse({
      run_id: CONT_RUN,
      current_stage: 'frame',
      current_step: 'frame-goal',
      runtime_status: 'in_progress',
    });
    expect(bad.success).toBe(false);
  });

  it('CONT-I8 — ContinuityIndex rejects surplus top-level keys', () => {
    const bad = ContinuityIndex.safeParse({
      schema_version: 1,
      project_root: '/Users/x/Code',
      pending_record: null,
      current_run: null,
      last_synced_at: '2026-04-19T00:00:00.000Z',
    });
    expect(bad.success).toBe(false);
  });

  it('CONT-I8 — pending_record rejects surplus keys (legacy "run_slug")', () => {
    const bad = PendingRecordPointer.safeParse({
      record_id: 'continuity-abc',
      continuity_kind: 'run-backed',
      created_at: '2026-04-19T00:00:00.000Z',
      run_slug: 'relay-connector-fallback-i5',
    });
    expect(bad.success).toBe(false);
  });
});

describe('Continuity own-property guard — CONT-I12', () => {
  const buildStandalone = (): Record<string, unknown> => ({
    schema_version: 1,
    record_id: 'continuity-abc',
    project_root: '/Users/x/Code',
    continuity_kind: 'standalone' as const,
    created_at: '2026-04-18T05:00:00.000Z',
    git: { cwd: '/Users/x/Code' },
    narrative: CONT_NARRATIVE,
    resume_contract: {
      mode: 'resume_standalone' as const,
      auto_resume: false,
      requires_explicit_resume: true,
    },
  });

  it('CONT-I12 — rejects record_id inherited via prototype chain', () => {
    const good = buildStandalone();
    const { record_id, ...rest } = good;
    const smuggled = Object.create({ record_id });
    Object.assign(smuggled, rest);
    const result = ContinuityRecord.safeParse(smuggled);
    expect(result.success).toBe(false);
  });

  it('CONT-I12 — rejects continuity_kind inherited via prototype chain', () => {
    const good = buildStandalone();
    const { continuity_kind, ...rest } = good;
    const smuggled = Object.create({ continuity_kind });
    Object.assign(smuggled, rest);
    const result = ContinuityRecord.safeParse(smuggled);
    expect(result.success).toBe(false);
  });

  it('CONT-I12 — rejects schema_version inherited via prototype chain', () => {
    const good = buildStandalone();
    const { schema_version, ...rest } = good;
    const smuggled = Object.create({ schema_version });
    Object.assign(smuggled, rest);
    const result = ContinuityRecord.safeParse(smuggled);
    expect(result.success).toBe(false);
  });

  it('CONT-I12 — ContinuityIndex rejects inherited pending_record key', () => {
    const good = {
      schema_version: 1,
      project_root: '/Users/x/Code',
      pending_record: null,
      current_run: null,
    };
    const { pending_record, ...rest } = good;
    const smuggled = Object.create({ pending_record });
    Object.assign(smuggled, rest);
    const result = ContinuityIndex.safeParse(smuggled);
    expect(result.success).toBe(false);
  });

  it('CONT-I12 — ContinuityIndex rejects inherited schema_version', () => {
    const good = {
      schema_version: 1,
      project_root: '/Users/x/Code',
      pending_record: null,
      current_run: null,
    };
    const { schema_version, ...rest } = good;
    const smuggled = Object.create({ schema_version });
    Object.assign(smuggled, rest);
    const result = ContinuityIndex.safeParse(smuggled);
    expect(result.success).toBe(false);
  });
});

describe('Continuity coverage additions', () => {
  it('CONT-I2 — rejects record with string schema_version "1" (legacy shape)', () => {
    const bad = ContinuityRecord.safeParse({
      schema_version: '1',
      record_id: 'continuity-abc',
      project_root: '/Users/x/Code',
      continuity_kind: 'standalone',
      created_at: '2026-04-18T05:00:00.000Z',
      git: { cwd: '/Users/x/Code' },
      narrative: CONT_NARRATIVE,
      resume_contract: {
        mode: 'resume_standalone',
        auto_resume: false,
        requires_explicit_resume: true,
      },
    });
    expect(bad.success).toBe(false);
  });

  it('CONT-I2 — rejects index with string schema_version "1"', () => {
    const bad = ContinuityIndex.safeParse({
      schema_version: '1',
      project_root: '/Users/x/Code',
      pending_record: null,
      current_run: null,
    });
    expect(bad.success).toBe(false);
  });

  it('CONT-I8 — AttachedRunPointer rejects surplus key (legacy "manifest_present")', () => {
    const bad = AttachedRunPointer.safeParse({
      run_id: CONT_RUN,
      current_stage: 'frame',
      current_step: 'frame-goal',
      runtime_status: 'in_progress',
      attached_at: '2026-04-19T00:00:00.000Z',
      last_validated_at: '2026-04-19T00:00:00.000Z',
      manifest_present: true,
    });
    expect(bad.success).toBe(false);
  });

  it('CONT-I10 — pending_record.record_id rejects path separator', () => {
    const bad = PendingRecordPointer.safeParse({
      record_id: 'continuity/abc',
      continuity_kind: 'standalone',
      created_at: '2026-04-19T00:00:00.000Z',
    });
    expect(bad.success).toBe(false);
  });

  it('CONT-I10 — pending_record.record_id rejects parent-traversal "..", ', () => {
    const bad = PendingRecordPointer.safeParse({
      record_id: 'foo..bar',
      continuity_kind: 'standalone',
      created_at: '2026-04-19T00:00:00.000Z',
    });
    expect(bad.success).toBe(false);
  });
});

describe('Ambient continuity record — CONT-I13..I16', () => {
  const baseAmbient = {
    schema_version: 1 as const,
    record_id: 'continuity-ambient-1',
    project_root: '/Users/x/Code',
    continuity_kind: 'ambient' as const,
    created_at: '2026-06-06T05:00:00.000Z',
    git: { cwd: '/Users/x/Code' },
    narrative: CONT_NARRATIVE,
    ambient_provenance: CONT_AMBIENT_PROVENANCE,
    resume_contract: {
      mode: 'resume_ambient' as const,
      auto_resume: false,
      requires_explicit_resume: true,
    },
  };

  it('CONT-I13 — ambient form parses with ambient_provenance + resume_ambient', () => {
    expect(ContinuityRecord.safeParse(baseAmbient).success).toBe(true);
  });

  it('CONT-I13 — ambient form accepts auto_resume=true (auto-resume framing)', () => {
    const ok = ContinuityRecord.safeParse({
      ...baseAmbient,
      resume_contract: {
        mode: 'resume_ambient',
        auto_resume: true,
        requires_explicit_resume: false,
      },
    });
    expect(ok.success).toBe(true);
  });

  it('CONT-I14 — ambient form requires ambient_provenance', () => {
    const { ambient_provenance: _omit, ...rest } = baseAmbient;
    expect(ContinuityRecord.safeParse(rest).success).toBe(false);
  });

  it('CONT-I14 — ambient form rejects run_ref (strict)', () => {
    const bad = ContinuityRecord.safeParse({ ...baseAmbient, run_ref: CONT_RUN_PROVENANCE });
    expect(bad.success).toBe(false);
  });

  it('CONT-I15 — ambient kind rejects resume_standalone mode', () => {
    const bad = ContinuityRecord.safeParse({
      ...baseAmbient,
      resume_contract: {
        mode: 'resume_standalone',
        auto_resume: false,
        requires_explicit_resume: true,
      },
    });
    expect(bad.success).toBe(false);
  });

  it('CONT-I15 — standalone kind rejects resume_ambient mode', () => {
    const bad = ContinuityRecord.safeParse({
      schema_version: 1,
      record_id: 'continuity-abc',
      project_root: '/Users/x/Code',
      continuity_kind: 'standalone',
      created_at: '2026-04-18T05:00:00.000Z',
      git: { cwd: '/Users/x/Code' },
      narrative: CONT_NARRATIVE,
      resume_contract: {
        mode: 'resume_ambient',
        auto_resume: false,
        requires_explicit_resume: true,
      },
    });
    expect(bad.success).toBe(false);
  });

  it('CONT-I16 — ambient resume_contract rejects both-true (non-contradiction)', () => {
    const bad = ContinuityRecord.safeParse({
      ...baseAmbient,
      resume_contract: {
        mode: 'resume_ambient',
        auto_resume: true,
        requires_explicit_resume: true,
      },
    });
    expect(bad.success).toBe(false);
  });

  it('CONT-I16 — ambient resume_contract rejects both-false', () => {
    const bad = ContinuityRecord.safeParse({
      ...baseAmbient,
      resume_contract: {
        mode: 'resume_ambient',
        auto_resume: false,
        requires_explicit_resume: false,
      },
    });
    expect(bad.success).toBe(false);
  });

  it('CONT-I8 — ambient_provenance rejects surplus keys (strict)', () => {
    const bad = ContinuityRecord.safeParse({
      ...baseAmbient,
      ambient_provenance: { ...CONT_AMBIENT_PROVENANCE, harvested_by: 'hook' },
    });
    expect(bad.success).toBe(false);
  });

  it('CONT-I14 — ambient_provenance requires transcript_path', () => {
    const { transcript_path: _omit, ...prov } = CONT_AMBIENT_PROVENANCE;
    const bad = ContinuityRecord.safeParse({ ...baseAmbient, ambient_provenance: prov });
    expect(bad.success).toBe(false);
  });

  it('CONT-I14 — ambient_provenance rejects invalid source enum', () => {
    const bad = ContinuityRecord.safeParse({
      ...baseAmbient,
      ambient_provenance: { ...CONT_AMBIENT_PROVENANCE, source: 'compact' },
    });
    expect(bad.success).toBe(false);
  });

  it('CONT-I14 — ambient_provenance accepts the pre-compact source', () => {
    const ok = ContinuityRecord.safeParse({
      ...baseAmbient,
      ambient_provenance: { ...CONT_AMBIENT_PROVENANCE, source: 'pre-compact' },
    });
    expect(ok.success).toBe(true);
  });

  it('CONT-I14 — ambient_provenance allows omitting optional session_id', () => {
    const { session_id: _omit, ...prov } = CONT_AMBIENT_PROVENANCE;
    const ok = ContinuityRecord.safeParse({ ...baseAmbient, ambient_provenance: prov });
    expect(ok.success).toBe(true);
  });
});

describe('Ambient index pointer — CONT-I17..I18', () => {
  const ambientPointer = {
    record_id: 'continuity-ambient-1',
    continuity_kind: 'ambient' as const,
    created_at: '2026-06-06T05:00:00.000Z',
  };

  it('CONT-I17 — AmbientRecordPointer parses', () => {
    expect(AmbientRecordPointer.safeParse(ambientPointer).success).toBe(true);
  });

  it('CONT-I17 — AmbientRecordPointer rejects non-ambient kind', () => {
    const bad = AmbientRecordPointer.safeParse({
      ...ambientPointer,
      continuity_kind: 'standalone',
    });
    expect(bad.success).toBe(false);
  });

  it('CONT-I17 — AmbientRecordPointer record_id uses ControlPlaneFileStem (rejects uppercase)', () => {
    const bad = AmbientRecordPointer.safeParse({ ...ambientPointer, record_id: 'Continuity-ABC' });
    expect(bad.success).toBe(false);
  });

  it('CONT-I8 — AmbientRecordPointer rejects surplus keys', () => {
    const bad = AmbientRecordPointer.safeParse({ ...ambientPointer, source: 'stop' });
    expect(bad.success).toBe(false);
  });

  it('CONT-I18 — index parses with ambient_record alongside the manual pointers', () => {
    const ok = ContinuityIndex.safeParse({
      schema_version: 1,
      project_root: '/Users/x/Code',
      pending_record: null,
      current_run: null,
      ambient_record: ambientPointer,
    });
    expect(ok.success).toBe(true);
  });

  it('CONT-I18 — index parses with ambient_record null', () => {
    const ok = ContinuityIndex.safeParse({
      schema_version: 1,
      project_root: '/Users/x/Code',
      pending_record: null,
      current_run: null,
      ambient_record: null,
    });
    expect(ok.success).toBe(true);
  });

  it('CONT-I18 — index parses with ambient_record absent (back-compat with pre-ambient indexes)', () => {
    const ok = ContinuityIndex.safeParse({
      schema_version: 1,
      project_root: '/Users/x/Code',
      pending_record: null,
      current_run: null,
    });
    expect(ok.success).toBe(true);
  });

  it('CONT-I18 — index rejects ambient_record carrying a non-ambient kind', () => {
    const bad = ContinuityIndex.safeParse({
      schema_version: 1,
      project_root: '/Users/x/Code',
      pending_record: null,
      current_run: null,
      ambient_record: { ...ambientPointer, continuity_kind: 'standalone' },
    });
    expect(bad.success).toBe(false);
  });
});
