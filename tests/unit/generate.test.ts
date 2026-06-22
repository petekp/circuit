// `circuit generate` — the PROPOSE half of the north star, as a product command.
//
// Unlike `circuit create` (which INSTANTIATES a family template offline), generate
// asks a model to PROPOSE a flow shape and runs the offline floor, then publishes
// the genuinely-composed flow through the SAME publish tail create uses. These
// tests drive runGenerateCommand with an INJECTED stub relay, so they are fully
// offline and spend nothing: the stub stands in for the model.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runGenerateCommand } from '../../src/cli/generate.js';
import type { CompositionRoleSet } from '../../src/flows/composition/index.js';
import type { RelayResult } from '../../src/shared/connector-relay.js';
import type { RelayFn, RelayInput } from '../../src/shared/relay-runtime-types.js';

// A known-runnable role set (the triage arc): frame -> gather-context ->
// diagnose -> close. Runnable through the real floor, so the stub serving it
// exercises the raw-runnable publish path end to end.
const RUNNABLE_ROLESET: CompositionRoleSet = {
  id: 'stub-triage',
  title: 'Stub Triage',
  purpose: 'A known-runnable role set for the offline generate test.',
  roles: [
    { stage: 'frame', block: 'frame', executionKind: 'compose' },
    { stage: 'analyze', block: 'gather-context', executionKind: 'relay', relayRole: 'researcher' },
    { stage: 'analyze', block: 'diagnose', executionKind: 'relay', relayRole: 'researcher' },
    { stage: 'close', block: 'close-with-evidence', executionKind: 'compose', terminal: true },
  ],
};

// A role set that cannot be made runnable: a lone non-terminal act step, no
// opener, no close. The floor rejects it; with --max-repair 0 the rejection is
// immediate (round 0 only), so this stays a fast, deterministic wall.
const WALL_ROLESET: CompositionRoleSet = {
  id: 'staller',
  title: 'Staller',
  purpose: 'An unrunnable role set.',
  roles: [{ stage: 'act', block: 'act', executionKind: 'relay', relayRole: 'implementer' }],
};

function stubRelayServing(body: string): RelayFn {
  return {
    connectorName: 'stub',
    relay: async (input: RelayInput): Promise<RelayResult> => ({
      request_payload: input.prompt,
      receipt_id: 'stub',
      result_body: body,
      duration_ms: 1,
      cli_version: '0.0.0-stub',
    }),
  };
}

let home: string;
let stdout: string[];

beforeEach(() => {
  home = join(tmpdir(), `circuit-generate-${Math.floor(performance.now() * 1000)}`);
  rmSync(home, { recursive: true, force: true });
  stdout = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

function lastJson(): Record<string, unknown> {
  const joined = stdout.join('');
  return JSON.parse(joined.slice(joined.indexOf('{'), joined.lastIndexOf('}') + 1));
}

describe('circuit generate — composes and publishes a bespoke flow', () => {
  it('drafts a runnable composed flow (no publish)', async () => {
    const code = await runGenerateCommand(
      ['--description', 'triage a flaky test and find the root cause', '--home', home],
      { relayer: stubRelayServing(JSON.stringify(RUNNABLE_ROLESET)) },
    );
    expect(code).toBe(0);
    const result = lastJson();
    expect(result.action).toBe('generate');
    expect(result.status).toBe('draft_created');
    expect(result.slug).toBe('stub-triage');
    // The draft exists; nothing is published yet.
    expect(existsSync(join(home, 'drafts', 'stub-triage', 'circuit.json'))).toBe(true);
    expect(existsSync(join(home, 'flows', 'stub-triage', 'circuit.json'))).toBe(false);
    // The validation result records the COMPOSED archetype and source, not a
    // template family — "instantiation is not generation" stays honest on disk.
    const validation = JSON.parse(
      readFileSync(join(home, 'drafts', 'stub-triage', 'validation-result.json'), 'utf8'),
    ) as { archetype: string; source: string };
    expect(validation.archetype).toBe('composed');
    expect(validation.source).toBe('composed');
  });

  it('publishes the composed flow with a trust-gate-matching manifest', async () => {
    const code = await runGenerateCommand(
      ['--description', 'triage a flaky test', '--home', home, '--publish', '--yes'],
      { relayer: stubRelayServing(JSON.stringify(RUNNABLE_ROLESET)) },
    );
    expect(code).toBe(0);
    const result = lastJson();
    expect(result.status).toBe('published');
    const slug = 'stub-triage';
    const flowPath = join(home, 'flows', slug, 'circuit.json');
    expect(existsSync(flowPath)).toBe(true);
    expect(existsSync(join(home, 'skills', slug, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(home, 'commands', `${slug}.md`))).toBe(true);
    // The compiled flow id equals the slug (validateCustomFlow's invariant), and
    // the manifest's flow_path points at exactly this file (what the trust gate
    // path-matches).
    const flow = JSON.parse(readFileSync(flowPath, 'utf8')) as { id: string };
    expect(flow.id).toBe(slug);
    const manifest = JSON.parse(readFileSync(join(home, 'manifest.json'), 'utf8')) as {
      custom_flows: { id: string; flow_path: string }[];
    };
    expect(manifest.custom_flows).toHaveLength(1);
    expect(manifest.custom_flows[0]?.id).toBe(slug);
    expect(manifest.custom_flows[0]?.flow_path).toBe(flowPath);
  });

  it('honors --name as the slug override', async () => {
    const code = await runGenerateCommand(
      [
        '--description',
        'triage a flaky test',
        '--name',
        'my-triage',
        '--home',
        home,
        '--publish',
        '--yes',
      ],
      { relayer: stubRelayServing(JSON.stringify(RUNNABLE_ROLESET)) },
    );
    expect(code).toBe(0);
    expect(lastJson().slug).toBe('my-triage');
    const flow = JSON.parse(
      readFileSync(join(home, 'flows', 'my-triage', 'circuit.json'), 'utf8'),
    ) as { id: string };
    expect(flow.id).toBe('my-triage');
  });

  it('fails honestly when the composed flow cannot be made runnable (wall)', async () => {
    const code = await runGenerateCommand(
      ['--description', 'do something impossible', '--home', home, '--max-repair', '0'],
      { relayer: stubRelayServing(JSON.stringify(WALL_ROLESET)) },
    );
    expect(code).toBe(1);
    const result = lastJson();
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('wall');
    // Nothing was drafted or published.
    expect(existsSync(join(home, 'flows'))).toBe(false);
  });

  it('fails honestly when the model output does not parse', async () => {
    const code = await runGenerateCommand(['--description', 'whatever', '--home', home], {
      relayer: stubRelayServing('this is not json at all'),
    });
    expect(code).toBe(1);
    const result = lastJson();
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('parse');
  });

  it('rejects a reserved slug BEFORE spending the model call', async () => {
    // A named slug is known up front, so a reserved/malformed name must fail
    // pre-flight — never after a full propose+repair spend. We assert the relay
    // is never invoked, which is the part of the contract that protects spend.
    const relay = vi.fn(
      async (input: RelayInput): Promise<RelayResult> => ({
        request_payload: input.prompt,
        receipt_id: 'stub',
        result_body: JSON.stringify(RUNNABLE_ROLESET),
        duration_ms: 1,
        cli_version: '0.0.0-stub',
      }),
    );
    const code = await runGenerateCommand(
      ['--description', 'triage a flaky test', '--name', 'run', '--home', home],
      { relayer: { connectorName: 'stub', relay } },
    );
    expect(code).toBe(1);
    expect(relay).not.toHaveBeenCalled();
  });

  it('requires --yes to publish', async () => {
    const code = await runGenerateCommand(
      ['--description', 'triage a flaky test', '--home', home, '--publish'],
      { relayer: stubRelayServing(JSON.stringify(RUNNABLE_ROLESET)) },
    );
    expect(code).toBe(1);
  });
});
