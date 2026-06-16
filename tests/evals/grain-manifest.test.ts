import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

type Band = 'separable' | 'mixed' | 'entangled';

type Separability = {
  co_change: number;
  coupling: number;
  cross_part_decision: number;
  independent_verifiability: number;
  sum: number;
  band: Band;
};

type GrainTask = {
  id: string;
  prompt: string;
  checks: unknown[];
  allowed_changed_files: unknown[];
  separability: Separability;
};

type GrainManifest = {
  set_id: string;
  tasks: string[];
  bands: Record<Band, string[]>;
};

const SET_ROOT = resolve(__dirname, '../../evals/grain-separability');
const TASKS_ROOT = join(SET_ROOT, 'tasks');

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function bandForSum(sum: number): Band {
  if (sum <= 2) return 'separable';
  if (sum <= 5) return 'mixed';
  return 'entangled';
}

const manifest = readJson<GrainManifest>(join(SET_ROOT, 'manifest.json'));

describe('grain-separability manifest hygiene', () => {
  it('keeps disk task dirs and manifest membership in sync', () => {
    const diskIds = readdirSync(TASKS_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(diskIds).toEqual([...manifest.tasks].sort());
  });

  it('requires checks, an allowed-changed-files array, a repo, an objective, and a valid pre-registered separability score', () => {
    for (const taskId of manifest.tasks) {
      const task = readJson<GrainTask>(join(TASKS_ROOT, taskId, 'task.json'));
      expect(task.id).toBe(taskId);
      expect(task.checks.length).toBeGreaterThan(0);
      expect(Array.isArray(task.allowed_changed_files)).toBe(true);
      expect(existsSync(join(TASKS_ROOT, taskId, 'repo'))).toBe(true);
      expect(existsSync(join(TASKS_ROOT, taskId, 'objective'))).toBe(true);

      const s = task.separability;
      for (const dim of [
        s.co_change,
        s.coupling,
        s.cross_part_decision,
        s.independent_verifiability,
      ]) {
        expect(dim).toBeGreaterThanOrEqual(0);
        expect(dim).toBeLessThanOrEqual(2);
      }
      const computed =
        s.co_change + s.coupling + s.cross_part_decision + s.independent_verifiability;
      expect(s.sum).toBe(computed);
      expect(s.band).toBe(bandForSum(s.sum));
    }
  });

  it('agrees with the manifest band index', () => {
    for (const band of ['separable', 'mixed', 'entangled'] as Band[]) {
      for (const taskId of manifest.bands[band]) {
        const task = readJson<GrainTask>(join(TASKS_ROOT, taskId, 'task.json'));
        expect(task.separability.band).toBe(band);
      }
    }
  });

  it('B0 precondition: the set spans all three bands with at least two tasks each', () => {
    const counts: Record<Band, number> = { separable: 0, mixed: 0, entangled: 0 };
    for (const taskId of manifest.tasks) {
      const task = readJson<GrainTask>(join(TASKS_ROOT, taskId, 'task.json'));
      counts[task.separability.band] += 1;
    }
    expect(counts.separable).toBeGreaterThanOrEqual(2);
    expect(counts.mixed).toBeGreaterThanOrEqual(2);
    expect(counts.entangled).toBeGreaterThanOrEqual(2);
  });
});
