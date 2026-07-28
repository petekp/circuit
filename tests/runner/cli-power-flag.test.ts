import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureStreams, deterministicNow, makeStubRelayer } from '../helpers/runtime-fixtures.js';
import { withScopedEnv } from '../helpers/scoped-env.js';

import { main } from '../../src/cli/circuit.js';
import { parseExecutionArgs } from '../../src/cli/run.js';
import { projectConfigPath } from '../../src/shared/config-loader.js';
import type { RelayFn, RelayInput } from '../../src/shared/relay-runtime-types.js';

let root: string;
let homeDir: string;
let cwdDir: string;

const REVIEW_RELAY_BODY = JSON.stringify({
  // Review fans out one reviewer per unit; a single-unit target has unit-1.
  unit_id: 'unit-1',
  verdict: 'NO_ISSUES_FOUND',
  findings: [],
  assessment: 'Stub reviewer: nothing actionable in the relayed evidence.',
  verification: ['Inspected the relayed intake report.'],
  confidence_limitations: [],
});

function writeProjectConfig(text: string): void {
  const path = projectConfigPath(cwdDir);
  mkdirSync(join(cwdDir, '.circuit'), { recursive: true });
  writeFileSync(path, text);
}

async function runReview(input: {
  readonly runFolder: string;
  readonly extraArgs?: readonly string[];
}): Promise<readonly Record<string, unknown>[]> {
  const relayInputs: RelayInput[] = [];
  const relayer: RelayFn = makeStubRelayer(
    (relayInput) => {
      relayInputs.push(relayInput);
      return REVIEW_RELAY_BODY;
    },
    { receipt_id: 'power-flag-receipt' },
  );
  await captureStreams(() =>
    withScopedEnv({ HOME: homeDir, CIRCUIT_GENERATED_FLOW_MIRROR_ROOT: undefined }, async () => {
      const exit = await main(
        [
          'run',
          'review',
          '--goal',
          'Review this supplied text: the power dial should reach relay selection.',
          '--run-folder',
          input.runFolder,
          ...(input.extraArgs ?? []),
        ],
        {
          relayer,
          now: deterministicNow(Date.UTC(2026, 5, 10, 12, 0, 0)),
          runId: '97979797-9797-4797-9797-979797979797',
          configHomeDir: homeDir,
          configCwd: cwdDir,
        },
      );
      expect(exit).toBe(0);
    }),
  );
  return readFileSync(join(input.runFolder, 'trace.ndjson'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function relayStartedSelection(
  traceEntries: readonly Record<string, unknown>[],
): Record<string, unknown> | undefined {
  const started = traceEntries.find((traceEntry) => traceEntry.kind === 'relay.started');
  return started?.resolved_selection as Record<string, unknown> | undefined;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'circuit-power-flag-'));
  homeDir = join(root, 'home');
  cwdDir = join(root, 'cwd');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('--power CLI flag parsing', () => {
  it('accepts each dial position', () => {
    for (const dial of ['low', 'medium', 'high'] as const) {
      const args = parseExecutionArgs('run', ['review', '--goal', 'g', '--power', dial]);
      expect(args.power).toBe(dial);
      expect(args.powerProvided).toBe(true);
    }
  });

  it('accepts auto', () => {
    const args = parseExecutionArgs('run', ['review', '--goal', 'g', '--power', 'auto']);
    expect(args.power).toBe('auto');
    expect(args.powerProvided).toBe(true);
  });

  it('leaves the dial unset when the flag is absent', () => {
    const args = parseExecutionArgs('run', ['review', '--goal', 'g']);
    expect(args.power).toBeUndefined();
    expect(args.powerProvided).toBe(false);
  });

  it('rejects values outside the dial', () => {
    expect(() => parseExecutionArgs('run', ['review', '--goal', 'g', '--power', 'turbo'])).toThrow(
      /power/i,
    );
  });

  it('rejects --power on checkpoint resume', () => {
    expect(() =>
      parseExecutionArgs('resume', [
        '--run-folder',
        '/tmp/some-run',
        '--checkpoint-choice',
        'approve',
        '--power',
        'high',
      ]),
    ).toThrow(/omit --power/);
  });
});

describe('--reuse-children-from CLI flag parsing', () => {
  it('carries the prior run folder on a fresh run', () => {
    const args = parseExecutionArgs('run', [
      'review',
      '--goal',
      'g',
      '--reuse-children-from',
      '/tmp/dead-run',
    ]);
    expect(args.reuseChildrenFrom).toBe('/tmp/dead-run');
  });

  it('leaves the pointer unset when the flag is absent', () => {
    const args = parseExecutionArgs('run', ['review', '--goal', 'g']);
    expect(args.reuseChildrenFrom).toBeUndefined();
  });

  it('rejects an empty path', () => {
    expect(() =>
      parseExecutionArgs('run', ['review', '--goal', 'g', '--reuse-children-from', '']),
    ).toThrow(/--reuse-children-from requires a non-empty path/);
  });

  it('rejects --reuse-children-from on checkpoint resume (fresh-run only)', () => {
    expect(() =>
      parseExecutionArgs('resume', [
        '--run-folder',
        '/tmp/some-run',
        '--checkpoint-choice',
        'approve',
        '--reuse-children-from',
        '/tmp/dead-run',
      ]),
    ).toThrow(/--reuse-children-from/);
  });
});

describe('--power dial reaches relay selection as an invocation config layer', () => {
  it('materializes the reviewer tier from the shipped claude-code table', async () => {
    // Dial low allocates reviewer → medium → the durable sonnet alias.
    const traceEntries = await runReview({
      runFolder: join(root, 'run-low'),
      extraArgs: ['--power', 'low'],
    });
    const selection = relayStartedSelection(traceEntries);
    expect(selection?.power).toBe('low');
    expect(selection?.model).toEqual({ provider: 'anthropic', model: 'sonnet' });
  });

  it('outranks a project-config dial (invocation layer wins)', async () => {
    writeProjectConfig(`
schema_version: 1
defaults:
  power: high
`);
    const traceEntries = await runReview({
      runFolder: join(root, 'run-precedence'),
      extraArgs: ['--power', 'low'],
    });
    const selection = relayStartedSelection(traceEntries);
    expect(selection?.power).toBe('low');
    expect(selection?.model).toEqual({ provider: 'anthropic', model: 'sonnet' });
  });

  it('defaults the dial to medium when neither the flag nor config set one', async () => {
    // Default-on: medium allocates reviewer → medium → the sonnet alias.
    const traceEntries = await runReview({ runFolder: join(root, 'run-default') });
    const selection = relayStartedSelection(traceEntries);
    expect(selection?.power).toBe('medium');
    expect(selection?.model).toEqual({ provider: 'anthropic', model: 'sonnet' });
  });
});
