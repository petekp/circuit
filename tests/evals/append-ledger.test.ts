import { describe, expect, it } from 'vitest';

import {
  buildFixLedgerEntry,
  buildVerdictLedgerEntry,
  isoFromPathTimestamp,
  validateLedgerEntry,
} from '../../scripts/evals/shared/ledger.ts';

// A fix summary carries operator-private content at the top level
// (absolute paths, the working-tree status, task ids, full task records with
// prompts). The ledger builder must copy ONLY named safe fields, so none of
// that content can reach a committed ledger file by construction.
const POISON_FIX_SUMMARY = {
  schema_version: 1,
  benchmark_id: 'fix-vs-vanilla',
  result_root: '/Users/secret/Code/circuit/evals/fix-vs-vanilla/results/run',
  repo_root: '/Users/secret/Code/circuit',
  repo_commit: 'f361e5f538568d642586a86c345045e4dad1db3f',
  git_status_short: ' M src/secret-file.ts',
  provider: 'claude-code',
  model: 'claude-haiku-4-5-20251001',
  effort: 'medium',
  circuit_mode: 'default',
  set: 'held-out',
  task_ids: ['secret-task-one', 'secret-task-two'],
  commands: ['/Users/secret/bin/run --flag'],
  tasks: [
    {
      id: 'secret-task-one',
      prompt: 'Fix the secret bug in /Users/secret/Code/circuit/src/secret-file.ts',
    },
  ],
  aggregates: {
    all: {
      'circuit-claude-code': {
        task_count: 5,
        false_fixed_count: 0,
        false_fixed_rate: 0,
        objective_fixed_rate: 1,
        verification_pass_rate: 1,
        mean_proof_quality: 3,
        mean_wallclock_ms: 184691.66,
      },
      'vanilla-claude-code': {
        task_count: 5,
        false_fixed_rate: 0,
        objective_fixed_rate: 1,
        verification_pass_rate: 1,
        mean_proof_quality: 3,
        mean_wallclock_ms: 62000,
      },
    },
  },
  claim: { supported: false, reason: 'tie' },
};

describe('buildFixLedgerEntry allowlist', () => {
  it('copies only safe fields and never leaks paths, prompts, or task ids', () => {
    const entry = buildFixLedgerEntry(POISON_FIX_SUMMARY, {
      ranAt: '2026-06-11T05:00:35.157Z',
    });
    const serialized = JSON.stringify(entry);

    expect(entry.eval_id).toBe('fix-vs-vanilla');
    expect(entry.ran_at).toBe('2026-06-11T05:00:35.157Z');
    expect(entry.repo_commit).toBe('f361e5f538568d642586a86c345045e4dad1db3f');
    expect(entry.model).toBe('claude-haiku-4-5-20251001');
    expect(entry.metrics.circuit_false_fixed_rate).toBe(0);
    expect(entry.metrics.vanilla_false_fixed_rate).toBe(0);
    expect(entry.metrics.task_count).toBe(5);

    // None of the operator-private content survives the allowlist.
    expect(serialized).not.toContain('/Users/');
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('prompt');
    expect(serialized).not.toContain('git_status');

    expect(validateLedgerEntry(entry, 'fix')).toEqual([]);
  });

  it('lets explicit options override the summary fields', () => {
    const entry = buildFixLedgerEntry(POISON_FIX_SUMMARY, {
      ranAt: '2026-06-11T05:00:35.157Z',
      model: 'claude-sonnet-4-6',
      repoCommit: 'a'.repeat(40),
      set: 'discovery',
    });
    expect(entry.model).toBe('claude-sonnet-4-6');
    expect(entry.repo_commit).toBe('a'.repeat(40));
    expect(entry.descriptors.set).toBe('discovery');
  });
});

describe('buildVerdictLedgerEntry', () => {
  const VERDICT_SUMMARY = {
    started_at: '2026-06-11T05:00:50.208Z',
    finished_at: '2026-06-11T05:37:26.998Z',
    judge: 'claude-code',
    overall: {
      cases: 54,
      catches: 41,
      misses: 1,
      errors: 3,
      catch_rate: 0.9761904761904762,
    },
    controls: { cases: 9, accept: 6, accept_with_fold_ins: 1, reject: 2, errors: 0 },
  };

  it('records ran_at from finished_at and tags the suite + repo commit', () => {
    const entry = buildVerdictLedgerEntry(VERDICT_SUMMARY, {
      model: 'claude-haiku-4-5-20251001',
      repoCommit: 'f361e5f538568d642586a86c345045e4dad1db3f',
      suite: 'standard',
    });
    expect(entry.eval_id).toBe('verdict-correctness');
    expect(entry.ran_at).toBe('2026-06-11T05:37:26.998Z');
    expect(entry.model).toBe('claude-haiku-4-5-20251001');
    expect(entry.descriptors.suite).toBe('standard');
    expect(entry.descriptors.judge).toBe('claude-code');
    expect(entry.metrics.catch_rate).toBeCloseTo(0.9761904761904762, 10);
    expect(entry.metrics.errors).toBe(3);
    // old-shape summary has no protocol_failure_rate, so it is simply omitted
    expect(entry.metrics.protocol_failure_rate).toBeUndefined();
    // The control verdict distribution is recorded as separate metrics; the
    // accept-with-fold-ins + reject counts are the reviewer false-positive
    // signal that the former control_passes/control_fails pair hid.
    expect(entry.metrics.control_accept).toBe(6);
    expect(entry.metrics.control_accept_with_fold_ins).toBe(1);
    expect(entry.metrics.control_reject).toBe(2);
    expect(entry.metrics.control_errors).toBe(0);
    expect(entry.metrics.control_passes).toBeUndefined();
    expect(validateLedgerEntry(entry, 'verdict')).toEqual([]);
  });

  it('prefers an explicit ranAt override', () => {
    const entry = buildVerdictLedgerEntry(VERDICT_SUMMARY, {
      model: 'm',
      repoCommit: 'b'.repeat(40),
      suite: 'subtle',
      ranAt: '2026-01-01T00:00:00.000Z',
    });
    expect(entry.ran_at).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('validateLedgerEntry', () => {
  function base() {
    return {
      schema_version: 1 as const,
      eval_id: 'verdict-correctness',
      ran_at: '2026-06-11T05:37:26.998Z',
      repo_commit: 'f361e5f538568d642586a86c345045e4dad1db3f',
      model: 'claude-haiku-4-5-20251001',
      descriptors: { suite: 'standard' },
      metrics: { catch_rate: 0.97 },
    };
  }

  it('accepts a well-formed entry', () => {
    expect(validateLedgerEntry(base(), 'ok')).toEqual([]);
  });

  it('rejects a wrong schema_version', () => {
    const problems = validateLedgerEntry({ ...base(), schema_version: 2 }, 'x');
    expect(problems.some((p) => p.includes('schema_version'))).toBe(true);
  });

  it('rejects a non-hex repo_commit', () => {
    const problems = validateLedgerEntry({ ...base(), repo_commit: 'not-a-sha' }, 'x');
    expect(problems.some((p) => p.includes('repo_commit'))).toBe(true);
  });

  it('rejects an unparseable ran_at', () => {
    const problems = validateLedgerEntry({ ...base(), ran_at: 'whenever' }, 'x');
    expect(problems.some((p) => p.includes('ran_at'))).toBe(true);
  });

  it('rejects a non-numeric metric', () => {
    const problems = validateLedgerEntry(
      { ...base(), metrics: { catch_rate: '0.97' } },
      'x',
    );
    expect(problems.some((p) => p.includes('metrics.catch_rate'))).toBe(true);
  });

  it('rejects a descriptor that leaks an absolute home path', () => {
    const problems = validateLedgerEntry(
      { ...base(), descriptors: { suite: '/Users/secret/run' } },
      'x',
    );
    expect(problems.some((p) => p.includes('descriptors.suite'))).toBe(true);
  });

  it('rejects a model that contains a newline', () => {
    const problems = validateLedgerEntry({ ...base(), model: 'a\nb' }, 'x');
    expect(problems.some((p) => p.includes('model'))).toBe(true);
  });
});

describe('isoFromPathTimestamp', () => {
  it('converts a fix result dir timestamp back to ISO', () => {
    expect(isoFromPathTimestamp('2026-06-11T05-00-35-157Z-held-out')).toBe(
      '2026-06-11T05:00:35.157Z',
    );
  });

  it('returns undefined when the prefix is not a timestamp', () => {
    expect(isoFromPathTimestamp('held-out')).toBeUndefined();
  });
});
