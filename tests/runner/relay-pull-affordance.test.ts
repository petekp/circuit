import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryInputV0 } from '../../src/index.js';
import { composeRelayPrompt } from '../../src/runtime/run/relay-support.js';

let runFolder: string;

beforeEach(() => {
  runFolder = mkdtempSync(join(tmpdir(), 'relay-pull-affordance-'));
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

describe('composeRelayPrompt pull affordance', () => {
  it('renders the pull affordance as an always-on line even when recall is empty', () => {
    // memoryInputs empty -> the conditional memory section is absent, so the
    // affordance must be unconditional (D4).
    const prompt = composeRelayPrompt(step(), runFolder, [], undefined, undefined, [], 'build');

    // The conditional "Prior Circuit History" section is NOT present (empty recall).
    expect(prompt).not.toContain('Prior Circuit History (hint-only):');
    // The affordance line IS present, with --run-folder and --flow interpolated.
    expect(prompt).toContain('circuit history pull');
    expect(prompt).toContain(`--run-folder ${runFolder}`);
    expect(prompt).toContain('--flow build');
    expect(prompt).toContain('--decision-point <label>');
  });

  it('renders the affordance as hint-only with the full seven-kind authority enumeration (no authority)', () => {
    const prompt = composeRelayPrompt(step(), runFolder, [], undefined, undefined, [], 'fix');
    expect(prompt).toContain('hint-only');
    // The full seven-kind enumeration of HISTORY_AUTHORITY_NOTICE — no truncated subset.
    expect(prompt).toContain(
      'cannot satisfy any current proof, checkpoint, policy, route, recovery, verification, or write authority',
    );
    expect(prompt).toContain('--flow fix');
  });

  it('still renders the affordance alongside the memory section when recall is non-empty', () => {
    const memory = MemoryInputV0.parse({
      schema_version: 1,
      memory_id: 'prior-run-11111111-abc123',
      kind: 'prior_run',
      source: {
        ref: {
          kind: 'report',
          ref: 'reports/decision.json',
          sha256: 'a'.repeat(64),
          run_id: '11111111-1111-4111-8111-111111111111',
          flow_id: 'explore',
        },
        captured_at: '2026-05-26T12:00:00.000Z',
        sha256: 'a'.repeat(64),
      },
      summary: 'Prior run chose explicit recall.',
      hints: [{ id: 'hint-abc123', text: 'Recall must stay cited.', applies_to: 'context' }],
      staleness: {
        status: 'fresh',
        checked_at: '2026-05-26T12:01:00.000Z',
        reason_codes: ['source_hash_verified'],
      },
      authority: 'hint_only',
    });
    const prompt = composeRelayPrompt(
      step(),
      runFolder,
      [],
      undefined,
      undefined,
      [memory],
      'explore',
    );
    expect(prompt).toContain('Prior Circuit History (hint-only):');
    expect(prompt).toContain('circuit history pull');
    expect(prompt).toContain('--flow explore');
  });

  it('omits the --flow value gracefully when no flow id is threaded (advisory, never a gate)', () => {
    // Backwards-compatible call without the flowId argument: the affordance still
    // renders (it is unconditional) and never throws.
    const prompt = composeRelayPrompt(step(), runFolder, [], undefined, undefined, []);
    expect(prompt).toContain('circuit history pull');
    expect(prompt).toContain(`--run-folder ${runFolder}`);
  });
});
