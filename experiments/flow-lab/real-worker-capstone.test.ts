// Real-worker capstone for the context-pull last-mile CONFIRM.
//
// The four isolated probes (capture-act-prompt + main-agent sub-workers) showed
// a REAL model, reading the exact engine-built act-step prompt, decides to pull
// the named slice when genuinely starved (Probe B), stays conservative when the
// envelope is sufficient (Probe A), and refuses honestly when the fact is
// unpullable (Probe C). This capstone threads the REAL worker's ACTUAL Probe B /
// Probe B2 JSON bodies back through the live engine to prove the last link: that
// the engine ACCEPTS and RESOLVES a real model's chosen context_request
// end-to-end (parse -> resolve against the parent report -> deliver -> re-run to
// a clean close), not just a harness author's hand-crafted request.
//
// $0 model spend: the worker bodies below are verbatim outputs captured from the
// real sub-agent workers; this run only replays them through runCompiledFlow.
// experiments-only; never moves to src/.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow } from '../../tests/helpers/runtime-fixtures.js';

import type { ClaudeCodeRelayInput } from '../../src/connectors/claude-code.js';
import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import type { RelayResult } from '../../src/shared/connector-relay.js';
import type { RelayFn } from '../../src/shared/relay-runtime-types.js';
import { reflectChangedFiles } from '../../tests/helpers/working-tree.js';

const FIXTURE_PATH = resolve('generated/flows/build/circuit.json');
const TIMEOUT_MS = 20_000;

let runFolderBase: string;
beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-capstone-'));
});
afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
});

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

// VERBATIM real-worker outputs captured from the live sub-agent probes.
// Probe B (genuinely starved): the real model chose to pull analyze-step.sources.
const REAL_WORKER_PROBE_B = JSON.stringify({
  verdict: 'accept',
  summary:
    'Cannot yet implement the formatLegacy migration safely: the plan states several of the twelve call sites need special handling, and it points to per-site migration notes in the analyze-step report field `sources`. That slice was not included in the envelope I was handed, and this step has no file-read tools, so I cannot open the call sites myself. Requesting that one named slice before making any edit.',
  changed_files: [],
  evidence: [
    'No files changed yet. The plan.approach explicitly defers the per-call-site migration notes to the analyze-step report under the field `sources`. This step has no file-read tools. Requesting the analyze-step `sources` slice via context_request before implementing.',
  ],
  context_request: { queries: [{ from_step: 'analyze-step', field_path: 'sources' }] },
});

// Probe B2 (enriched, sources delivered): the real model completed the migration.
const REAL_WORKER_PROBE_B2 = JSON.stringify({
  verdict: 'accept',
  summary:
    'Migrated all 12 call sites off the deprecated formatLegacy helper, replacing formatLegacy(value) with formatCurrency(value, { minimumFractionDigits: 2 }) and updating each import to the shim. The explicit two-decimal rounding preserves prior implicit rounding, so no rendered currency output changes.',
  changed_files: RICH_SOURCE_FILES,
  evidence: [
    'All 12 sources delivered in context were modified; grep for formatLegacy across src/ returns no remaining call sites.',
    'Each migrated call passes { minimumFractionDigits: 2 } so two-decimal rounding is preserved (invariant held, non_goal respected).',
  ],
});

const REVIEW = JSON.stringify({
  verdict: 'accept',
  summary: 'within scope',
  findings: [],
  alignment: { scope_adherence: 'within_scope', non_goals: [], invariants: [] },
});

function replayRealWorkerRelayer(): RelayFn {
  return {
    connectorName: 'claude-code',
    relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
      const isAnalyze = input.prompt.includes('Step: analyze-step');
      const isAct = input.prompt.includes('Step: act-step');
      const hasDelivered = input.prompt.includes('Delivered Context');
      const body =
        isAct && hasDelivered
          ? REAL_WORKER_PROBE_B2
          : isAnalyze
            ? JSON.stringify(RICH_ANALYZE_REPORT)
            : isAct
              ? REAL_WORKER_PROBE_B
              : REVIEW;
      return {
        request_payload: input.prompt,
        receipt_id: 'stub',
        result_body: body,
        duration_ms: 1,
        cli_version: '0.0.0-real-replay',
      };
    },
  };
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
  git('config', 'user.email', 'capstone@circuit.local');
  git('config', 'user.name', 'capstone');
  git('add', '-A');
  git('commit', '-q', '-m', 'baseline');
  return projectRoot;
}

describe('Real-worker capstone: a real model decision resolves end-to-end through the live engine', () => {
  it(
    'accepts the real worker context_request, resolves the named slice, delivers it, and re-runs to a clean close',
    async () => {
      const runFolder = join(runFolderBase, 'capstone');
      // The enriched re-run (real Probe B2) declares all 12 RICH_SOURCE_FILES;
      // reflect them onto the tree so the build-act changed_on_disk gate sees
      // the same diff the real worker left after migrating the call sites.
      const projectRoot = gitProjectRoot();
      reflectChangedFiles(projectRoot, RICH_SOURCE_FILES);
      const result = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: readFileSync(FIXTURE_PATH),
        runId: 'd0000000-0000-0000-0000-000000000001',
        goal: 'Migrate every call site off the deprecated formatLegacy helper',
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 5, 17, 10, 0, 0)),
        relayer: replayRealWorkerRelayer(),
        projectRoot,
        selectionConfigLayers: [],
        enableContextDelivery: true,
      });

      const entries = await new TraceStore(runFolder).load();
      const pulls = entries.filter((e) => e.kind === 'run.context-pull');
      const deliveries = entries
        .filter((e) => e.kind === 'run.context-delivery')
        .filter((e) => (e as { step_id: string }).step_id === 'act-step');

      // The engine PARSED the real model's context_request and RESOLVED the
      // named slice against the parent report (answered:true) — proving the real
      // worker's output is engine-valid, not just plausible-looking.
      expect(pulls.length).toBe(1);
      const pull = pulls[0] as { from_step: string; field_path: string; answered: boolean };
      expect(pull.from_step).toBe('analyze-step');
      expect(pull.field_path).toBe('sources');
      expect(pull.answered).toBe(true);

      // It delivered the resolved slice and the enriched re-run reached a clean
      // close (equal completeness on the delivered context).
      expect(deliveries.length).toBe(1);
      const delivery = deliveries[0] as { kept: string; delivered_bytes: number };
      expect(delivery.kept).toBe('retry');
      expect(result.outcome).not.toBe('aborted');

      // The kept body is the ENRICHED completion (real Probe B2), not the
      // starved request — the delivered slice was actually used.
      const actCompleted = [...entries]
        .reverse()
        .find(
          (e) => e.kind === 'relay.completed' && (e as { step_id: string }).step_id === 'act-step',
        ) as { result_path: string } | undefined;
      const keptBody = JSON.parse(
        readFileSync(
          join(runFolder, (actCompleted as { result_path: string }).result_path),
          'utf8',
        ),
      ) as { summary: string; changed_files: string[] };
      expect(keptBody.summary.startsWith('Migrated all 12')).toBe(true);
      expect(keptBody.changed_files.length).toBe(12);

      const fullReportBytes = Buffer.byteLength(
        readFileSync(join(runFolder, 'reports/build/context.json'), 'utf8'),
        'utf8',
      );
      // eslint-disable-next-line no-console
      console.log(
        `\n===CAPSTONE_SUMMARY_START===\n${JSON.stringify(
          {
            real_worker_decision: 'pull analyze-step.sources (verbatim Probe B output)',
            engine_resolved: pull.answered,
            outcome: result.outcome,
            kept: delivery.kept,
            delivered_bytes_engine_measured: delivery.delivered_bytes,
            fat_push_full_report_bytes: fullReportBytes,
            reduction_ratio_this_pull: Number(
              (fullReportBytes / delivery.delivered_bytes).toFixed(2),
            ),
            enriched_completion: 'all 12 sites migrated on the delivered slice',
          },
          null,
          2,
        )}\n===CAPSTONE_SUMMARY_END===\n`,
      );
    },
    TIMEOUT_MS,
  );
});
