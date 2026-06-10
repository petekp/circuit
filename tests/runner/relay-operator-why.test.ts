import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseExecutionArgs } from '../../src/cli/run.js';
import { composeRelayPrompt } from '../../src/runtime/run/relay-support.js';

let runFolder: string;

beforeEach(() => {
  runFolder = mkdtempSync(join(tmpdir(), 'relay-operator-why-'));
});

afterEach(() => {
  rmSync(runFolder, { recursive: true, force: true });
});

// A minimal relay step with no reads, so the prompt is just the static composition.
function step() {
  return {
    id: 'act-step',
    title: 'Act',
    role: 'implementer',
    reads: [],
    writes: {
      request: { path: 'reports/relay/act.request.json' },
      receipt: { path: 'reports/relay/act.receipt.txt' },
      result: { path: 'reports/relay/act.result.json' },
    },
    check: { kind: 'result_verdict', pass: ['accept'] },
  } as unknown as Parameters<typeof composeRelayPrompt>[0];
}

describe('composeRelayPrompt operator why', () => {
  it('renders the why line inside the operator goal block when provided', () => {
    const prompt = composeRelayPrompt(
      step(),
      runFolder,
      [],
      undefined,
      'fix the checkout total',
      [],
      'fix',
      undefined,
      undefined,
      'totals are blocking the release cut',
    );
    expect(prompt).toContain(
      'Operator Goal:\nfix the checkout total\nWhy: totals are blocking the release cut',
    );
  });

  it('omits the why line when no why is provided (prompt unchanged)', () => {
    const withoutWhy = composeRelayPrompt(
      step(),
      runFolder,
      [],
      undefined,
      'fix the checkout total',
      [],
      'fix',
    );
    expect(withoutWhy).toContain('Operator Goal:\nfix the checkout total');
    expect(withoutWhy).not.toContain('Why:');

    // Trailing undefined must be byte-identical to omitting the parameter, so
    // existing call sites and recorded prompts are unchanged.
    const withUndefinedWhy = composeRelayPrompt(
      step(),
      runFolder,
      [],
      undefined,
      'fix the checkout total',
      [],
      'fix',
      undefined,
      undefined,
      undefined,
    );
    expect(withUndefinedWhy).toBe(withoutWhy);
  });

  it('omits the why line when why is an empty string', () => {
    const prompt = composeRelayPrompt(
      step(),
      runFolder,
      [],
      undefined,
      'fix the checkout total',
      [],
      'fix',
      undefined,
      undefined,
      '',
    );
    expect(prompt).not.toContain('Why:');
  });

  it('does not render a floating why when there is no operator goal', () => {
    // The why qualifies the goal; without a goal there is nothing for it to
    // qualify, so it must not render as an orphan section.
    const prompt = composeRelayPrompt(
      step(),
      runFolder,
      [],
      undefined,
      undefined,
      [],
      'fix',
      undefined,
      undefined,
      'orphan why',
    );
    expect(prompt).not.toContain('Why:');
    expect(prompt).not.toContain('orphan why');
  });
});

describe('parseExecutionArgs --why', () => {
  it('threads --why into ParsedArgs alongside the goal', () => {
    const args = parseExecutionArgs('run', [
      'fix',
      '--goal',
      'fix the checkout total',
      '--why',
      'totals are blocking the release cut',
    ]);
    expect(args.goal).toBe('fix the checkout total');
    expect(args.why).toBe('totals are blocking the release cut');
  });

  it('omits why from ParsedArgs when the flag is absent', () => {
    const args = parseExecutionArgs('run', ['fix', '--goal', 'fix the checkout total']);
    expect(args.why).toBeUndefined();
    expect('why' in args).toBe(false);
  });

  it('rejects an empty --why value', () => {
    expect(() =>
      parseExecutionArgs('run', ['fix', '--goal', 'fix the checkout total', '--why', '']),
    ).toThrow('--why must be non-empty when provided');
  });

  it('rejects --why on checkpoint resume, matching --goal semantics', () => {
    expect(() =>
      parseExecutionArgs('resume', [
        '--run-folder',
        '.circuit/runs/run-x',
        '--checkpoint-choice',
        'proceed',
        '--why',
        'totals are blocking the release cut',
      ]),
    ).toThrow('checkpoint resume reuses the saved run goal; omit --why');
  });
});
