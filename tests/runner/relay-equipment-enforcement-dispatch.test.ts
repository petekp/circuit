import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow, stubRelayResult } from '../helpers/runtime-fixtures.js';

import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import type { RelayFn, RelayInput } from '../../src/shared/relay-runtime-types.js';

// Enforced equipment scope must reach the connector through BOTH relay dispatch
// paths. The direct path (`relayWithResolvedConnector`, used by the shipped CLI
// when no relayer is injected) forwards the resolved tool allow-list. The
// injected-relayer path (`context.relayer.relay`, used by the eval harness and
// every in-process test) must forward it too — otherwise enforcement silently
// evaporates on the exact path we measure enforcement's effect through.
//
// This pins the dispatch seam: an enforced editor scope on an implementer relay,
// run against an allow-list-capable connector (claude-code), must arrive at the
// injected relayer as `input.toolAllowList`.

const FIXTURE_PATH = resolve('generated/flows/runtime-proof/circuit.json');
const ENFORCED_EDITOR_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write'] as const;

// The runtime-proof relay step is already an implementer relay. Attach an
// enforced editor allow-list to it (the write tier the parse gate permits to be
// enforced) so the resolver yields effective:'enforced' with a tool list.
function loadEnforcedFixture(): { bytes: Buffer } {
  const bytes = readFileSync(FIXTURE_PATH);
  const raw: {
    steps: Array<{
      id: string;
      kind: string;
      role?: string;
      equipment_scope?: unknown;
    }>;
  } = JSON.parse(bytes.toString('utf8'));
  const relayStep = raw.steps.find((step) => step.id === 'relay-step' && step.kind === 'relay');
  if (relayStep === undefined) throw new Error('runtime-proof relay step not found');
  relayStep.role = 'implementer';
  relayStep.equipment_scope = {
    tools: { allow: [...ENFORCED_EDITOR_TOOLS] },
    enforcement: 'enforced',
  };
  return { bytes: Buffer.from(JSON.stringify(raw)) };
}

// A claude-code-shaped relayer (tool_scope capability 'allow-list') that records
// every input it is handed, so the test can assert what the dispatch forwarded.
function capturingRelayer(): { relayer: RelayFn; inputs: RelayInput[] } {
  const inputs: RelayInput[] = [];
  return {
    inputs,
    relayer: {
      connectorName: 'claude-code',
      relay: async (input: RelayInput) => {
        inputs.push(input);
        return stubRelayResult({ request_payload: input.prompt, result_body: '{"verdict":"ok"}' });
      },
    },
  };
}

let runFolderBase: string;

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-relay-enforce-'));
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
});

describe('relay dispatch forwards an enforced tool allow-list to the injected relayer', () => {
  it('the injected relayer receives toolAllowList for an enforced implementer scope', async () => {
    const { bytes } = loadEnforcedFixture();
    const { relayer, inputs } = capturingRelayer();
    const runFolder = join(runFolderBase, 'enforced');

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '7e7e7e7e-7e7e-7e7e-7e7e-7e7e7e7e7e7e',
      goal: 'enforced-dispatch regression',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 3, 22, 14, 0, 0)),
      relayer,
      executors: {
        compose: async (step, context) => {
          if (step.kind !== 'compose') throw new Error('expected compose step');
          const report = step.writes?.report;
          if (report !== undefined) {
            const reportPath = context.files.resolve(report);
            mkdirSync(dirname(reportPath), { recursive: true });
            writeFileSync(reportPath, '{"summary":"enforced-dispatch setup"}\n', 'utf8');
          }
          return { route: 'pass', details: { report: report?.path } };
        },
      },
    });

    expect(outcome.outcome).toBe('complete');
    const relayInput = inputs.find((i) => i.toolAllowList !== undefined);
    expect(relayInput, 'no relay input carried a toolAllowList').toBeDefined();
    expect(relayInput?.toolAllowList).toEqual([...ENFORCED_EDITOR_TOOLS]);
  });
});
