import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readJson } from '../../scripts/evals/shared/json.ts';

type EvalRegistryEntry = {
  id: string;
  claim_level: string;
  claim_eligible?: boolean;
  default_command: unknown[];
  readme_path: string;
};
type EvalRegistry = {
  schema_version: number;
  evals: EvalRegistryEntry[];
};

const registry = readJson<EvalRegistry>(resolve('evals/registry.json'));
const claimLevels = new Set(['smoke', 'regression', 'discovery', 'claim-grade']);

describe('eval registry', () => {
  it('has valid claim levels and readmes', () => {
    expect(registry.schema_version).toBe(1);
    for (const entry of registry.evals) {
      expect(claimLevels.has(entry.claim_level)).toBe(true);
      expect(existsSync(resolve(entry.readme_path))).toBe(true);
      expect(Array.isArray(entry.default_command)).toBe(true);
      expect(entry.default_command.length).toBeGreaterThan(0);
    }
  });

  it('allows claim eligibility only for claim-grade evals', () => {
    for (const entry of registry.evals) {
      if (entry.claim_eligible) {
        expect(entry.claim_level).toBe('claim-grade');
      }
    }
  });

  it('publishes no eval number, so no eval is claim-grade', () => {
    const claimGradeIds = registry.evals
      .filter((entry) => entry.claim_level === 'claim-grade')
      .map((entry) => entry.id);
    expect(claimGradeIds).toEqual([]);
  });

  it('does not track raw eval result folders', () => {
    const tracked = execFileSync('git', ['ls-files', 'evals'], { encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.includes('/results/'));
    expect(tracked).toEqual([]);
  });
});
