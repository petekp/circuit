// `circuit doctor`'s flow-readiness probe.
//
// Doctor is the run-readiness command, and it used to answer only "are the
// connectors healthy". A project config can pin a selection no connector can
// honor — `flows.build.selection.effort: none` against claude-code, say — and
// every Build run then dies at preflight. Doctor printed "Ready." anyway and
// exited 0. `circuit preview` knew, but nobody runs preview to find out
// whether they are ready; that is what doctor is for.

import { describe, expect, it } from 'vitest';

import {
  type DoctorConnectorEntry,
  probeFlowReadiness,
  renderDoctorReport,
} from '../../src/cli/doctor.js';
import { terminalPalette } from '../../src/cli/terminal-style.js';
import { Config, LayeredConfig } from '../../src/schemas/config.js';

const plain = terminalPalette(false);

// Parse through the real Config schema rather than casting a literal. The
// config loader always does, so a hand-built layer that skips it is missing
// defaults (`relay`, most importantly) that every reader assumes are present.
function projectLayer(config: Record<string, unknown>): LayeredConfig {
  return LayeredConfig.parse({
    layer: 'project',
    source_path: '/repo/.circuit/config.yaml',
    config: Config.parse({ schema_version: 1, ...config }),
  });
}

const HEALTHY_CONNECTORS: readonly DoctorConnectorEntry[] = [
  {
    connector: 'claude-code',
    state: 'ok',
    detail: '2.1.220 (Claude Code)',
    executable: 'claude',
    chosen: true,
    chosen_by: ['auto'],
  },
];

describe('probeFlowReadiness', () => {
  it('finds nothing to report when no config pins an impossible selection', () => {
    expect(probeFlowReadiness({ layers: [] })).toEqual([]);
  });

  it('names the flow whose steps cannot run and what the connector said', () => {
    const blockers = probeFlowReadiness({
      layers: [projectLayer({ flows: { build: { selection: { effort: 'none' } } } })],
    });

    expect(blockers).toHaveLength(1);
    const blocker = blockers[0];
    expect(blocker?.flowId).toBe('build');
    // Every relay step in Build is blocked, not just the first one found.
    expect(blocker?.stepIds.length).toBeGreaterThanOrEqual(3);
    expect(blocker?.detail).toContain("cannot honor effort 'none'");
  });

  it('names the config file the pin came from', () => {
    const blockers = probeFlowReadiness({
      layers: [projectLayer({ flows: { build: { selection: { effort: 'none' } } } })],
    });

    expect(blockers[0]?.pinnedAt).toBe('/repo/.circuit/config.yaml');
    expect(blockers[0]?.pinnedKey).toBe('flows.build.selection.effort');
  });

  it('reports only the flow that is pinned, not every public flow', () => {
    const blockers = probeFlowReadiness({
      layers: [projectLayer({ flows: { build: { selection: { effort: 'none' } } } })],
    });

    expect(blockers.map((blocker) => blocker.flowId)).toEqual(['build']);
  });
});

describe('the doctor verdict accounts for blocked flows', () => {
  it('does not say Ready while a public flow cannot start', () => {
    const report = renderDoctorReport(plain, HEALTHY_CONNECTORS, [], undefined, [
      {
        flowId: 'build',
        stepIds: ['analyze-step', 'act-step', 'review-step'],
        detail: "claude-code connector cannot honor effort 'none'",
        pinnedAt: '/repo/.circuit/config.yaml',
        pinnedKey: 'flows.build.selection.effort',
      },
    ]);

    expect(report).not.toContain('Ready.');
    expect(report).toContain('Not ready');
    expect(report).toContain('build');
  });

  it('names the file, the key, and a fix that can be pasted', () => {
    const report = renderDoctorReport(plain, HEALTHY_CONNECTORS, [], undefined, [
      {
        flowId: 'build',
        stepIds: ['analyze-step', 'act-step', 'review-step'],
        detail: "claude-code connector cannot honor effort 'none'",
        pinnedAt: '/repo/.circuit/config.yaml',
        pinnedKey: 'flows.build.selection.effort',
      },
    ]);

    expect(report).toContain('/repo/.circuit/config.yaml');
    expect(report).toContain('flows.build.selection.effort');
    expect(report).toContain('circuit config unset flows.build.selection.effort');
  });

  it('still says Ready when every flow can start', () => {
    const report = renderDoctorReport(plain, HEALTHY_CONNECTORS, [], undefined, []);
    expect(report).toContain('Ready.');
  });
});
