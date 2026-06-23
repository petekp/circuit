// Throwaway capture harness for the context-pull last-mile CONFIRM.
//
// The battle-test proved the MECHANISM with a scripted relayer whose
// context_request was hardcoded by the harness author. The CONFIRM's open
// question is BEHAVIORAL: given the now-rendered affordance (BUILD 1) and the
// "when to pull" guidance (BUILD 2), does a REAL model worker reading the
// engine-built act-step prompt choose to pull the slice it is missing?
//
// To ask a real worker that question we need the EXACT prompt the engine hands
// the act-step — relay-hint, shape skeleton (with the context_request describe
// now rendered), brief, and plan. This harness drives the real Build engine on
// the rich wide->narrow scenario and dumps two prompts to disk:
//   * act-prompt-starved.txt  — the first act pass (pre-delivery)
//   * act-prompt-enriched.txt — the re-run pass after a scripted pull delivers
// Then the main agent hands those captured prompts to a real sub-agent worker.
//
// experiments-only; never moves to src/. It writes the prompts under
// experiments/flow-lab/.capture/ for the main agent to read.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow } from '../../tests/helpers/runtime-fixtures.js';

import type { ClaudeCodeRelayInput } from '../../src/connectors/claude-code.js';
import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import type { RelayResult } from '../../src/shared/connector-relay.js';
import type { RelayFn } from '../../src/shared/relay-runtime-types.js';
import { reflectChangedFiles } from '../../tests/helpers/working-tree.js';

const FIXTURE_PATH = resolve('generated/flows/build/circuit.json');
const CAPTURE_DIR = resolve('experiments/flow-lab/.capture');
const TIMEOUT_MS = 20_000;

let runFolderBase: string;

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-capture-'));
  mkdirSync(CAPTURE_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
});

function fixtureBytes(): Buffer {
  return readFileSync(FIXTURE_PATH);
}

function gitProjectRoot(): string {
  const projectRoot = join(runFolderBase, 'project');
  mkdirSync(join(projectRoot, 'src'), { recursive: true });
  writeFileSync(
    join(projectRoot, 'package.json'),
    `${JSON.stringify({ private: true, scripts: { check: 'node -e "process.exit(0)"' } }, null, 2)}\n`,
  );
  const git = (...argv: string[]) =>
    execFileSync('git', argv, { cwd: projectRoot, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'capture@circuit.local');
  git('config', 'user.name', 'capture');
  git('add', '-A');
  git('commit', '-q', '-m', 'baseline');
  return projectRoot;
}

// The rich wide->narrow surface: a researcher who read a dozen call sites and
// recorded a verbose read-note per file. The bulky `sources` array is the wide
// cost; the synthesized `observations` are the narrow need.
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

const RICH_PULL_REQUEST = {
  queries: [{ from_step: 'analyze-step', field_path: 'sources' }],
};

const RICH_STARVED_BODY = JSON.stringify({
  verdict: 'accept',
  summary: 'STARVED: capturing the prompt',
  changed_files: RICH_SOURCE_FILES,
  evidence: ['edits pending the upstream synthesis'],
  context_request: RICH_PULL_REQUEST,
});

const RICH_ENRICHED_BODY = JSON.stringify({
  verdict: 'accept',
  summary: 'ENRICHED: capturing the enriched prompt',
  changed_files: RICH_SOURCE_FILES,
  evidence: ['used the delivered slice'],
});

const REVIEW = JSON.stringify({
  verdict: 'accept',
  summary: 'within scope',
  findings: [],
  alignment: { scope_adherence: 'within_scope', non_goals: [], invariants: [] },
});

function capturingRelayer(): RelayFn {
  let actPass = 0;
  return {
    connectorName: 'claude-code',
    relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
      const isAnalyze = input.prompt.includes('Step: analyze-step');
      const isAct = input.prompt.includes('Step: act-step');
      const hasDeliveredContext = input.prompt.includes('Delivered Context');
      let body: string;
      if (isAct && hasDeliveredContext) {
        writeFileSync(join(CAPTURE_DIR, 'act-prompt-enriched.txt'), input.prompt, 'utf8');
        body = RICH_ENRICHED_BODY;
      } else if (isAct) {
        actPass += 1;
        if (actPass === 1) {
          writeFileSync(join(CAPTURE_DIR, 'act-prompt-starved.txt'), input.prompt, 'utf8');
        }
        body = RICH_STARVED_BODY;
      } else if (isAnalyze) {
        body = JSON.stringify(RICH_ANALYZE_REPORT);
      } else {
        body = REVIEW;
      }
      return {
        request_payload: input.prompt,
        receipt_id: 'stub',
        result_body: body,
        duration_ms: 1,
        cli_version: '0.0.0-stub',
      };
    },
  };
}

describe('capture the real engine-built act-step prompt (rich wide->narrow)', () => {
  it(
    'dumps starved + enriched act prompts for the real-worker probe',
    async () => {
      const runFolder = join(runFolderBase, 'capture');
      // The stubbed act declares RICH_SOURCE_FILES; reflect them onto the tree
      // so the build-act changed_on_disk gate sees the same diff a real worker
      // would leave for the 12 migrated call sites.
      const projectRoot = gitProjectRoot();
      reflectChangedFiles(projectRoot, RICH_SOURCE_FILES);
      const result = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: fixtureBytes(),
        runId: 'c0000000-0000-0000-0000-000000000001',
        goal: 'Migrate every call site off the deprecated formatLegacy helper',
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 5, 17, 9, 0, 0)),
        relayer: capturingRelayer(),
        projectRoot,
        selectionConfigLayers: [],
        enableContextDelivery: true,
      });
      expect(result.outcome).not.toBe('aborted');
      // Also dump the analyze report bytes (what a fat push would carry) so the
      // saving math is reproducible from captured artifacts.
      writeFileSync(
        join(CAPTURE_DIR, 'analyze-report.json'),
        readFileSync(join(runFolder, 'reports/build/context.json'), 'utf8'),
        'utf8',
      );
    },
    TIMEOUT_MS,
  );
});
