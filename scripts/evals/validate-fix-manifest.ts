#!/usr/bin/env node
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { readJson } from './shared/json.ts';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const BENCH_ROOT = resolve(REPO_ROOT, 'evals/fix-vs-vanilla');
const MANIFEST_PATH = resolve(BENCH_ROOT, 'manifest.json');
const TASKS_ROOT = resolve(BENCH_ROOT, 'tasks');
const SPLITS = ['discovery', 'regression', 'held-out'] as const;
const EXPECTED_PROVENANCE = {
  discovery: 'discovery-created',
  regression: 'regression-demoted',
  'held-out': 'held-out-created',
};
const EXPECTED_TUNING_USED = {
  discovery: true,
  regression: true,
  'held-out': false,
};

type Split = (typeof SPLITS)[number];
type FixManifest = {
  sets: Record<Split, string[]>;
};
type FixTask = {
  id: string;
  split: Split;
  provenance: string;
  tuning_used: boolean;
  checks: unknown[];
  allowed_changed_files: unknown[];
  prompt: string;
};

function fail(message: string): never {
  throw new Error(message);
}

function taskIdsFromDisk(): string[] {
  return readdirSync(TASKS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function checkFixManifest() {
  const manifest = readJson<FixManifest>(MANIFEST_PATH);
  const manifestIds = new Map<string, Split>();
  for (const split of SPLITS) {
    if (!Array.isArray(manifest.sets?.[split])) fail(`manifest set missing: ${split}`);
    for (const taskId of manifest.sets[split]) {
      if (manifestIds.has(taskId)) fail(`${taskId}: appears in multiple manifest sets`);
      manifestIds.set(taskId, split);
    }
  }

  const diskIds = taskIdsFromDisk();
  for (const taskId of diskIds) {
    if (!manifestIds.has(taskId)) fail(`${taskId}: task exists on disk but not in manifest`);
  }
  for (const [taskId, split] of manifestIds.entries()) {
    const taskPath = resolve(TASKS_ROOT, taskId, 'task.json');
    const repoPath = resolve(TASKS_ROOT, taskId, 'repo');
    if (!existsSync(taskPath)) fail(`${taskId}: missing task.json`);
    if (!existsSync(repoPath)) fail(`${taskId}: missing repo fixture`);
    const task = readJson<FixTask>(taskPath);
    if (task.id !== taskId) fail(`${taskId}: task id does not match directory`);
    if (task.split !== split)
      fail(`${taskId}: split ${task.split} does not match manifest ${split}`);
    if (task.provenance !== EXPECTED_PROVENANCE[split]) {
      fail(`${taskId}: provenance ${task.provenance} does not match split ${split}`);
    }
    if (typeof task.tuning_used !== 'boolean') fail(`${taskId}: tuning_used must be boolean`);
    if (task.tuning_used !== EXPECTED_TUNING_USED[split]) {
      fail(`${taskId}: tuning_used ${task.tuning_used} does not match split ${split}`);
    }
    if (!Array.isArray(task.checks) || task.checks.length === 0) fail(`${taskId}: missing checks`);
    if (!Array.isArray(task.allowed_changed_files))
      fail(`${taskId}: allowed_changed_files must be an array`);
    if (typeof task.prompt !== 'string' || task.prompt.length === 0)
      fail(`${taskId}: prompt is required`);
  }
  return manifestIds.size;
}

try {
  const count = checkFixManifest();
  process.stdout.write(`Fix manifest OK (${count} tasks)\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Fix manifest check failed: ${message}\n`);
  process.exit(1);
}
