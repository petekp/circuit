// The local worker lane end to end, with no relayer stub: the operator's
// user-global config routes the reviewer role to a custom connector,
// `power_tiers.<name>` declares the connector's tier table, and the REAL
// relayCustom subprocess runs and reports the CIRCUIT_RELAY_* env vars it
// received. The connector is declared user-global on purpose: a custom command
// connector is honored only from a layer the operator controls, never from a
// project's committed `.circuit/config.yaml` (that is the C1 arbitrary-code-
// execution boundary). This is the CI-safe proof of the whole lane (role
// routing → dial materialization → env threading); the live OpenCode/Ollama
// wrapper swaps in for the node script without further engine involvement.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureStreams, deterministicNow } from '../helpers/runtime-fixtures.js';
import { withScopedEnv } from '../helpers/scoped-env.js';

import { main } from '../../src/cli/circuit.js';
import { userGlobalConfigPath } from '../../src/shared/config-loader.js';

let root: string;
let homeDir: string;
let cwdDir: string;
let flowMirrorRoot: string;

// The connector subprocess echoes its selection env vars into the relay
// report so the test can assert what actually crossed the process boundary.
const CONNECTOR_SCRIPT = `
const { writeFileSync } = require('node:fs');
const outputFile = process.argv[process.argv.length - 1];
writeFileSync(outputFile, JSON.stringify({
  verdict: 'NO_ISSUES_FOUND',
  findings: [],
  assessment: 'env model=' + (process.env.CIRCUIT_RELAY_MODEL ?? 'unset')
    + ' provider=' + (process.env.CIRCUIT_RELAY_MODEL_PROVIDER ?? 'unset'),
  verification: ['echoed the selection environment'],
  confidence_limitations: [],
}));
`;

function writeLaneWorkspace(): string {
  // The connector script lives in the operator's workspace, but the config that
  // authorizes running it as a custom connector is the operator's own
  // user-global config, not the project's `.circuit/config.yaml`. A project
  // config cannot supply a command-running connector, so the whole lane is
  // declared in the trusted user-global layer.
  const scriptPath = join(cwdDir, 'local-reviewer.cjs');
  mkdirSync(cwdDir, { recursive: true });
  writeFileSync(scriptPath, CONNECTOR_SCRIPT);

  // Production Review deliberately requires a built-in connector that can
  // prove prompt-only isolation. This older lane test instead exercises the
  // generic custom-connector path. A test-only trusted mirror turns that one
  // Review flag off without weakening the shipped Review contract.
  const mirroredFlowDir = join(flowMirrorRoot, 'review');
  mkdirSync(mirroredFlowDir, { recursive: true });
  const mirroredFlow = JSON.parse(readFileSync('generated/flows/review/circuit.json', 'utf8')) as {
    engine_flags: { relay_uses_prompt_only_context?: boolean };
  };
  mirroredFlow.engine_flags.relay_uses_prompt_only_context = false;
  writeFileSync(
    join(mirroredFlowDir, 'circuit.json'),
    `${JSON.stringify(mirroredFlow, null, 2)}\n`,
  );

  const userConfigPath = userGlobalConfigPath(homeDir);
  mkdirSync(dirname(userConfigPath), { recursive: true });
  writeFileSync(
    userConfigPath,
    `
schema_version: 1

relay:
  roles:
    reviewer: { kind: named, name: local-reviewer }
  connectors:
    local-reviewer:
      kind: custom
      name: local-reviewer
      command: ["${process.execPath}", "${scriptPath}"]
      prompt_transport: prompt-file
      output: { kind: output-file }
      capabilities: { filesystem: read-only, structured_output: json }

power_tiers:
  local-reviewer:
    low: { model: { provider: custom, model: fake-tier-low } }
    medium: { model: { provider: custom, model: fake-tier-medium } }
    high: { model: { provider: custom, model: fake-tier-high } }
`,
  );
  return scriptPath;
}

async function runReviewThroughLane(input: {
  readonly runFolder: string;
  readonly extraArgs?: readonly string[];
}): Promise<readonly Record<string, unknown>[]> {
  const command = await captureStreams(() =>
    withScopedEnv({ HOME: homeDir, CIRCUIT_GENERATED_FLOW_MIRROR_ROOT: undefined }, async () => {
      return main(
        [
          'run',
          'review',
          '--goal',
          'review this supplied text: prove the local worker lane end to end',
          '--flow-root',
          flowMirrorRoot,
          '--run-folder',
          input.runFolder,
          ...(input.extraArgs ?? []),
        ],
        {
          now: deterministicNow(Date.UTC(2026, 5, 11, 12, 0, 0)),
          runId: '42424242-4242-4242-4242-424242424242',
          configHomeDir: homeDir,
          configCwd: cwdDir,
          generatedFlowMirrorRoot: flowMirrorRoot,
        },
      );
    }),
  );
  if (command.result !== 0) {
    throw new Error(`review command failed:\n${command.stderr}\n${command.stdout}`);
  }
  return readFileSync(join(input.runFolder, 'trace.ndjson'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'circuit-local-lane-'));
  homeDir = join(root, 'home');
  cwdDir = join(root, 'cwd');
  flowMirrorRoot = join(root, 'flow-mirror');
  writeLaneWorkspace();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('local worker lane: custom connector + power tiers + env threading', () => {
  it('routes the reviewer to the custom connector and materializes its tier table', async () => {
    // Dial low allocates reviewer → medium (review is held one notch safer
    // than execution), so the connector's medium tier model must win.
    const traceEntries = await runReviewThroughLane({
      runFolder: join(root, 'run-low'),
      extraArgs: ['--power', 'low'],
    });

    const started = traceEntries.find((traceEntry) => traceEntry.kind === 'relay.started');
    expect(started).toBeDefined();
    const connector = started?.connector as Record<string, unknown>;
    expect(connector.kind).toBe('custom');
    expect(connector.name).toBe('local-reviewer');
    const selection = started?.resolved_selection as Record<string, unknown>;
    expect(selection.power).toBe('low');
    expect(selection.model).toEqual({ provider: 'custom', model: 'fake-tier-medium' });

    // The subprocess itself saw the materialized model through the env seam.
    const completed = traceEntries.find((traceEntry) => traceEntry.kind === 'relay.completed');
    const resultPath = completed?.result_path as string;
    const report = JSON.parse(readFileSync(join(root, 'run-low', resultPath), 'utf8')) as {
      assessment: string;
    };
    expect(report.assessment).toBe('env model=fake-tier-medium provider=custom');
  });

  it('dial high reaches the top tier of the declared table', async () => {
    const traceEntries = await runReviewThroughLane({
      runFolder: join(root, 'run-high'),
      extraArgs: ['--power', 'high'],
    });
    const started = traceEntries.find((traceEntry) => traceEntry.kind === 'relay.started');
    const selection = started?.resolved_selection as Record<string, unknown>;
    expect(selection.power).toBe('high');
    expect(selection.model).toEqual({ provider: 'custom', model: 'fake-tier-high' });
  });
});
