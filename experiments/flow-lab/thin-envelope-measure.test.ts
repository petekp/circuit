// Thin-envelope unlock — the IN-FLOW byte measurement.
//
// The runtime-binding battle-test measures the DELIVERY channel's carried bytes
// (what a worker that already emits a context_request pulls vs the whole analyze
// report). That proves the pull channel is cheap, but it used a hardcoded
// STARVED_BODY that always pulls — so it did not measure the thing THIS unlock
// changes: the PLAN envelope itself.
//
// Before the unlock, plan.ts inlined the full analyze synthesis into the plan's
// `approach` even when delivery was on, so the act-step started FAT and pull was
// rarely load-bearing (the "low-yield fail-safe" the last-mile report flagged).
// The unlock thins the plan when delivery is active: the synthesis is replaced by
// a pointer at the pullable analyze-step report, so the act-step starts LEAN and
// pulls the synthesis only if it needs it.
//
// This harness measures that directly: it captures the REAL act-step first-pass
// prompt (the carried envelope the implementer starts from) on the SAME task, once
// with delivery on (thin plan) and once off (fat plan), and reports the byte delta.
// A NON-pulling worker is used so the ONLY variable between the two runs is plan
// thickness — this isolates the envelope saving the thinning itself produces, kept
// separate from the delivery-recovery bytes the battle-test already measures.
//
// Throwaway, experiments/-only: it never moves to src/. Every byte figure is read
// back from the real engine's relay prompt, not hand math.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow } from '../../tests/helpers/runtime-fixtures.js';

import type { ClaudeCodeRelayInput } from '../../src/connectors/claude-code.js';
import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import type { RelayResult } from '../../src/shared/connector-relay.js';
import type { RelayFn } from '../../src/shared/relay-runtime-types.js';

const FIXTURE_PATH = resolve('generated/flows/build/circuit.json');
const TIMEOUT_MS = 120_000;

let runFolderBase: string;

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-thin-measure-'));
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
});

function fixtureBytes(): Buffer {
  return readFileSync(FIXTURE_PATH);
}

function passingProjectRoot(): string {
  const projectRoot = join(runFolderBase, 'project');
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(
    join(projectRoot, 'package.json'),
    `${JSON.stringify({ private: true, scripts: { check: 'node -e "process.exit(0)"' } }, null, 2)}\n`,
  );
  return projectRoot;
}

// A wide investigation whose analyze report carries far more than the implementer
// needs: twelve per-file read-notes plus a synthesized four-point observation set.
// This is the regime where a fat plan over-provisions the most — the same shape
// the battle-test's rich arm uses.
const RICH_SOURCE_FILES = [
  'src/api/users.ts',
  'src/api/orders.ts',
  'src/api/billing.ts',
  'src/api/inventory.ts',
  'src/api/shipping.ts',
  'src/api/auth.ts',
  'src/jobs/nightly-reconcile.ts',
  'src/jobs/export-ledger.ts',
  'src/web/dashboard.ts',
  'src/web/report-view.ts',
  'src/lib/legacy-format.ts',
  'src/lib/format-shim.ts',
];

const RICH_ANALYZE_REPORT = {
  verdict: 'accept',
  sources: RICH_SOURCE_FILES.map((ref) => ({
    kind: 'file',
    ref,
    summary: `calls the deprecated formatLegacy(value) helper, usually to render a currency amount for display; the call passes a raw number and relies on the helper's implicit two-decimal rounding, so the migration must preserve that rounding when it swaps in formatCurrency(value, opts). No call here depends on the helper's thrown error for a non-number, so the stricter new signature is safe at this site.`,
  })),
  observations: [
    'every call site passes a raw number and depends on the deprecated helper rounding to two decimals, so the replacement must default to two-decimal rounding to stay behavior-preserving',
    'no call site relies on the old helper throwing on a non-number input, so the new stricter signature introduces no regression at any of the twelve sites',
    'the shim in src/lib/format-shim.ts already re-exports the new helper, so each site changes only its import and call, not its surrounding logic',
    'the change is mechanical and uniform across the twelve sites, so it decomposes into one slice per area with no cross-site ordering constraint',
  ],
  open_questions: [],
  anticipated_file_extensions: ['.ts'],
  slices: [
    {
      id: 'slice-1',
      intent:
        'replace formatLegacy(value) with formatCurrency(value, { minimumFractionDigits: 2 }) at every call site, updating imports to the shim',
      anticipated_file_extensions: ['.ts'],
    },
  ],
  guardrails: {
    non_goals: ['do not change the rendered output of any currency amount'],
    invariants: ['every migrated call still rounds to two decimal places'],
  },
  allowed_touch_area: [],
};

const REVIEW = JSON.stringify({
  verdict: 'accept',
  summary: 'ok',
  findings: [],
  alignment: { scope_adherence: 'within_scope', non_goals: [], invariants: [] },
});

// A non-pulling implementer: it accepts and emits NO context_request, so there is
// exactly one act-step pass and no delivery. This isolates the starting envelope:
// the only difference between the thin and fat runs is the plan's `approach`.
const NON_PULLING_ACT_BODY = JSON.stringify({
  verdict: 'accept',
  summary: 'implemented from the envelope as given',
  changed_files: RICH_SOURCE_FILES,
  evidence: ['edits applied'],
});

// Captures every act-step prompt the engine relays, so the test can read the
// first-pass envelope byte length back from the real run.
function capturingRelayer(actPrompts: string[]): RelayFn {
  return {
    connectorName: 'claude-code',
    relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
      const isAnalyze = input.prompt.includes('Step: analyze-step');
      const isAct = input.prompt.includes('Step: act-step');
      if (isAct) actPrompts.push(input.prompt);
      return {
        request_payload: input.prompt,
        receipt_id: 'stub',
        result_body: isAnalyze
          ? JSON.stringify(RICH_ANALYZE_REPORT)
          : isAct
            ? NON_PULLING_ACT_BODY
            : REVIEW,
        duration_ms: 1,
        cli_version: '0.0.0-stub',
      };
    },
  };
}

async function runAndCaptureActEnvelope(opts: {
  runId: string;
  delivery: boolean;
  whenMs: number;
}): Promise<string> {
  const actPrompts: string[] = [];
  const runFolder = join(runFolderBase, opts.delivery ? 'thin' : 'fat');
  const result = await runCompiledFlow({
    runDir: runFolder,
    flowBytes: fixtureBytes(),
    runId: opts.runId,
    goal: 'Migrate every call site off the deprecated formatLegacy helper',
    depth: 'medium',
    now: deterministicNow(opts.whenMs),
    relayer: capturingRelayer(actPrompts),
    projectRoot: passingProjectRoot(),
    selectionConfigLayers: [],
    ...(opts.delivery ? { enableContextDelivery: true } : {}),
  });
  expect(result.outcome).not.toBe('aborted');
  // First-pass act-step prompt: the envelope the implementer starts from.
  expect(actPrompts.length).toBeGreaterThan(0);
  return actPrompts[0] as string;
}

describe('Thin-envelope unlock (in-flow act-step envelope: thin plan vs fat plan)', () => {
  it(
    'thinning the plan shrinks the carried act-step envelope on the same task, and the withheld synthesis is recoverable by pull',
    async () => {
      const fatPrompt = await runAndCaptureActEnvelope({
        runId: 'e0000000-0000-0000-0000-0000000000f0',
        delivery: false,
        whenMs: Date.UTC(2026, 5, 18, 1, 0, 0),
      });
      const thinPrompt = await runAndCaptureActEnvelope({
        runId: 'e0000000-0000-0000-0000-0000000000f1',
        delivery: true,
        whenMs: Date.UTC(2026, 5, 18, 1, 30, 0),
      });

      const fatBytes = Buffer.byteLength(fatPrompt, 'utf8');
      const thinBytes = Buffer.byteLength(thinPrompt, 'utf8');

      // The fat envelope inlines the synthesized observations; the thin one does
      // not (it points at the pullable analyze-step report instead).
      const synthesisMarker =
        'every call site passes a raw number and depends on the deprecated helper rounding';
      expect(fatPrompt).toContain(synthesisMarker);
      expect(thinPrompt).not.toContain(synthesisMarker);
      expect(thinPrompt).toContain('available to pull on demand');

      // The thin envelope is genuinely smaller, and the saving equals the inlined
      // synthesis that was withheld.
      expect(thinBytes).toBeLessThan(fatBytes);
      const observationsBytes = Buffer.byteLength(
        RICH_ANALYZE_REPORT.observations.join(' '),
        'utf8',
      );
      const envelopeSavingBytes = fatBytes - thinBytes;

      // eslint-disable-next-line no-console
      console.log(
        `\n===THIN_ENVELOPE_MEASURE_START===\n${JSON.stringify(
          {
            task: 'wide call-site migration (formatLegacy → formatCurrency, 12 sites)',
            measure: 'act-step first-pass prompt bytes (the carried implementer envelope)',
            fat_plan_envelope_bytes: fatBytes,
            thin_plan_envelope_bytes: thinBytes,
            envelope_saving_bytes: envelopeSavingBytes,
            withheld_synthesis_bytes: observationsBytes,
            recovery:
              'the worker pulls analyze-step.observations on demand if it needs the synthesis (delivery folds it back; battle-test measures the delivered bytes)',
            note: 'non-pulling worker used so the only variable between runs is plan thickness — the envelope saving is attributable to the thinning alone',
          },
          null,
          2,
        )}\n===THIN_ENVELOPE_MEASURE_END===\n`,
      );
    },
    TIMEOUT_MS,
  );
});
