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

function userLayer(config: Record<string, unknown>): LayeredConfig {
  return LayeredConfig.parse({
    layer: 'user-global',
    source_path: '/home/someone/.config/circuit/config.yaml',
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

  // The printed line is "fix: circuit config unset <key>". That is a promise
  // about what happens next, so the key named has to be the one whose removal
  // actually unblocks the flow. Here two keys are set, only the model blocks,
  // and unsetting the perfectly good effort would change nothing.
  it('names the key that causes the blocker, not the first key it finds', () => {
    const blockers = probeFlowReadiness({
      layers: [
        projectLayer({
          relay: { default: 'claude-code' },
          flows: {
            build: {
              selection: { effort: 'high', model: { provider: 'openai', model: 'gpt-5.5' } },
            },
          },
        }),
      ],
    });

    expect(blockers[0]?.detail).toContain("cannot honor model provider 'openai'");
    expect(blockers[0]?.pinnedKey).toBe('flows.build.selection.model');
  });

  // A pin whose removal does not clear the blocker is not the fix, and saying
  // it is would send the operator to edit a file for nothing. Both layers pin
  // the same impossible effort, so neither unset alone helps. Doctor still
  // reports the blocker; it just does not claim to know the remedy.
  it('names no pin when no single unset would clear the blocker', () => {
    const blockers = probeFlowReadiness({
      layers: [
        userLayer({ flows: { build: { selection: { effort: 'none' } } } }),
        projectLayer({ flows: { build: { selection: { effort: 'none' } } } }),
      ],
    });

    expect(blockers).toHaveLength(1);
    expect(blockers[0]?.detail).toContain("cannot honor effort 'none'");
    expect(blockers[0]?.pinnedKey).toBeUndefined();
    expect(blockers[0]?.pinnedAt).toBeUndefined();
  });

  // Precedence decides which file to send the operator to: the project value
  // is the one in play, and unsetting the shadowed user-global one changes
  // nothing an operator would notice.
  it('names the layer in play when a lower layer is shadowed by it', () => {
    const blockers = probeFlowReadiness({
      layers: [
        userLayer({ flows: { build: { selection: { effort: 'high' } } } }),
        projectLayer({ flows: { build: { selection: { effort: 'none' } } } }),
      ],
    });

    expect(blockers[0]?.pinnedAt).toBe('/repo/.circuit/config.yaml');
    expect(blockers[0]?.pinnedKey).toBe('flows.build.selection.effort');
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
