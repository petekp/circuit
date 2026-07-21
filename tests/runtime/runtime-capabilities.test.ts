import { describe, expect, it } from 'vitest';

import { RUNTIME_CAPABILITY_NAMES } from '../../src/runtime/run/capabilities.js';

describe('runtime capabilities', () => {
  it('names the execution capabilities that runtime adapters can provide', () => {
    expect([...RUNTIME_CAPABILITY_NAMES]).toEqual([
      'now',
      'executors',
      'childExecutors',
      'childCompiledFlowResolver',
      'childRunner',
      'externalFiles',
      'projectRoot',
      'evidencePolicy',
      'worktreeRunner',
      'relayConnector',
      'relayer',
      'hostKind',
      'selectionConfigLayers',
      'policyLayers',
      'progress',
      'progressSurface',
      'memoryInputs',
      'historyRecallReport',
      'historyRecallPrecision',
      'proofCommandRunner',
      'gitReader',
    ]);
  });
});
