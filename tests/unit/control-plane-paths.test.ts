import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  controlPlaneRoot,
  historyRoot,
  memoryRoot,
  normalizeProjectRoot,
  projectConfigPath,
  runsRoot,
} from '../../src/shared/control-plane-paths.js';

// Regression: a worker or hook whose cwd sits INSIDE a control plane (for
// example `.circuit/runs/<runId>`) passed that cwd as the project root, and the
// engine accepted it — creating a nested `.circuit/runs/.circuit/continuity`
// store with a project_root pointing inside the real store (observed 2026-06-16
// and 2026-07-12 in two repos). A directory inside `.circuit` is never a
// legitimate project root, so the path helpers re-anchor to the control plane's
// parent — the real project root — instead of nesting a second control plane.

const repo = mkdtempSync(join(tmpdir(), 'circuit-cpp-'));

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('normalizeProjectRoot', () => {
  it('returns an ordinary project root unchanged (resolved)', () => {
    expect(normalizeProjectRoot(repo)).toBe(resolve(repo));
  });

  it('re-roots a path inside the control plane to the control-plane parent', () => {
    expect(normalizeProjectRoot(join(repo, '.circuit', 'runs'))).toBe(resolve(repo));
    expect(normalizeProjectRoot(join(repo, '.circuit', 'runs', 'abc-123'))).toBe(resolve(repo));
    expect(normalizeProjectRoot(join(repo, '.circuit'))).toBe(resolve(repo));
  });
});

describe('control-plane path helpers reject nested control planes', () => {
  const nestedRoot = join(repo, '.circuit', 'runs', 'abc-123');

  it('controlPlaneRoot anchors to the real project root', () => {
    expect(controlPlaneRoot(nestedRoot)).toBe(resolve(repo, '.circuit'));
  });

  it('runsRoot anchors to the real project root', () => {
    expect(runsRoot(nestedRoot)).toBe(resolve(repo, '.circuit/runs'));
  });

  it('historyRoot anchors to the real project root', () => {
    expect(historyRoot(nestedRoot)).toBe(resolve(repo, '.circuit/history'));
  });

  it('memoryRoot anchors to the real project root', () => {
    expect(memoryRoot(nestedRoot)).toBe(resolve(repo, '.circuit/memory'));
  });

  it('projectConfigPath anchors to the real project root', () => {
    expect(projectConfigPath(nestedRoot)).toBe(resolve(repo, '.circuit/config.yaml'));
  });
});
