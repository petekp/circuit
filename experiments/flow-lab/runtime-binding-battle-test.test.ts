// Runtime-binding battle-test — the LIVE measurement.
//
// The offline demonstrator (context-pull-demonstrator.ts) scored three envelope
// strategies as pure functions: thin+pull reached fat-push completeness at ~10x
// fewer carried bytes. That proved the TRADE. This harness proves the trade
// survives the LIVE engine now that pull-then-retry delivery is wired: it runs
// the REAL Build flow through runCompiledFlow on a REAL eval task's content
// (heldout-wrap-index), lets the implementer step STARVE on its thin brief+plan
// envelope, pull the named upstream slices it is missing, and re-run on the
// enriched context — and it MEASURES the carried bytes from real engine
// artifacts (the trace's delivered_bytes and the analyze report the engine
// actually wrote), not from hand math.
//
// Throwaway, experiments/-only: it never moves to src/, but unlike the
// demonstrator it drives the real engine end to end, so it doubles as a
// real-task integration proof of the delivery seam. Both context-pull delivery
// and equipment reshape are enabled (the two runtime-binding siblings); reshape
// is available but only fires on a confirmed domain, which this plain-.mjs task
// has none of, so it is reported as enabled-not-fired (honest).
//
// "Count = cost": every byte figure in the SUMMARY block is read back from the
// run, so the report quotes measured values.

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
const TIMEOUT_MS = 120_000;

let runFolderBase: string;

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-battle-test-'));
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
});

function fixtureBytes(): Buffer {
  return readFileSync(FIXTURE_PATH);
}

// A real git project root whose verification commands trivially pass. The run
// reaches a clean close, so the measurement is about CONTEXT CARRYING, not real
// verification (the eval suite proves correctness separately). It is a real git
// repo so the touch-area gate the rich analyze report activates
// (allowed_touch_area is non-empty) is genuinely exercised: the baseline
// snapshots a clean tree, and because the stubbed implementer makes no on-disk
// edit the tree stays clean, so the post-verify touch-area check passes
// vacuously. The point is that the full Build pipeline runs end to end, gate and
// all, around the act-step pull — not a gate-disabled shortcut.
let projectRootCounter = 0;
// `dirtyFiles` are the paths the stubbed implementer declares in `changed_files`.
// They are reflected onto the working tree AFTER the baseline commit so the
// fix-act/build-act changed_on_disk gate sees the same real diff a worker would
// leave: a modeled change actually exists on disk, not just in the report.
function gitProjectRoot(dirtyFiles: readonly string[] = []): string {
  projectRootCounter += 1;
  const projectRoot = join(runFolderBase, `project-${projectRootCounter}`);
  mkdirSync(join(projectRoot, 'src'), { recursive: true });
  writeFileSync(
    join(projectRoot, 'package.json'),
    `${JSON.stringify({ private: true, scripts: { check: 'node -e "process.exit(0)"' } }, null, 2)}\n`,
  );
  // The actual buggy function the wrap-index task targets, so the repo content
  // matches the task the analyze report describes.
  writeFileSync(
    join(projectRoot, 'src/wrap.mjs'),
    'export function wrapIndex(index, len) {\n  return index;\n}\n',
  );
  const git = (...argv: string[]) =>
    execFileSync('git', argv, { cwd: projectRoot, stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'battle-test@circuit.local');
  git('config', 'user.name', 'battle-test');
  git('add', '-A');
  git('commit', '-q', '-m', 'baseline');
  reflectChangedFiles(projectRoot, dirtyFiles);
  return projectRoot;
}

// ---------------------------------------------------------------------------
// The real task: heldout-wrap-index. A genuine off-by-wrap bug in a pure
// function. The analyze report below is what a researcher would produce reading
// it — grounded in the actual file, test, and regression command.
// ---------------------------------------------------------------------------

const ANALYZE_REPORT = {
  verdict: 'accept',
  sources: [
    {
      kind: 'file',
      ref: 'src/wrap.mjs',
      summary:
        'the wrapIndex(index, len) stub that returns its index argument unchanged; the single function the fix must change',
    },
    {
      kind: 'file',
      ref: 'tests/wrap.test.mjs',
      summary:
        'the regression test that pages forward past the last slide and expects the index to wrap back to the start; currently failing',
    },
    {
      kind: 'command',
      ref: 'npm test',
      summary: 'the regression command; fails before the fix and must pass after it',
    },
  ],
  observations: [
    'wrapIndex currently returns its index argument unchanged, so paging past the last slide yields an out-of-range index instead of wrapping back to the start',
    'the correct wrap for both forward and backward paging is ((index % len) + len) % len, which keeps the result in [0, len) for negative and large indices alike',
    'a plain index % len is insufficient for the hidden negative-index test (tests/wrap.negative.test.mjs): a negative index modulo len stays negative, so len must be re-added before the final modulo',
    'the change is one indivisible edit to a single pure function: no callers to update, no schema or state to migrate, no other files in scope',
  ],
  open_questions: [],
  anticipated_file_extensions: ['.mjs'],
  slices: [
    {
      id: 'slice-1',
      intent:
        'replace the wrapIndex stub body with ((index % len) + len) % len so forward and backward paging both wrap into [0, len)',
      anticipated_file_extensions: ['.mjs'],
    },
  ],
  guardrails: {
    non_goals: [
      'do not change the signature of wrapIndex(index, len)',
      'do not touch any file other than src/wrap.mjs',
    ],
    invariants: [
      'wrapIndex returns an index within [0, len) for every integer input',
      'the tests that already pass keep passing',
    ],
  },
  allowed_touch_area: ['src/wrap.mjs'],
};

const REVIEW = JSON.stringify({
  verdict: 'accept',
  summary: 'the change wraps the index as specified and stays within the allowed touch area',
  findings: [],
  alignment: { scope_adherence: 'within_scope', non_goals: [], invariants: [] },
});

// The named slices the starving implementer pulls: the raw research the plan
// distilled away. It needs the synthesized observations and the sources behind
// them to implement the modulo wrap correctly (the negative-index edge in
// particular lives in observation 3, which the one-line plan slice drops).
const PULL_REQUEST = {
  queries: [
    { from_step: 'analyze-step', field_path: 'observations' },
    { from_step: 'analyze-step', field_path: 'sources' },
  ],
};

// A request that names a field the parent report does NOT expose: the honesty
// arm. The channel must refuse it (answered:false, recorded), fabricate nothing,
// and deliver nothing — so no retry fires and the run proceeds on what it has.
const UNPULLABLE_REQUEST = {
  queries: [{ from_step: 'analyze-step', field_path: 'root_cause_secret' }],
};

const STARVED_BODY = JSON.stringify({
  verdict: 'accept',
  summary: 'STARVED: implementing from the one-line plan slice without the research it distilled',
  changed_files: ['src/wrap.mjs'],
  evidence: ['stub edit pending the upstream context'],
  context_request: PULL_REQUEST,
});

const STARVED_UNPULLABLE_BODY = JSON.stringify({
  verdict: 'accept',
  summary: 'STARVED: asking for a slice the parent never exposed',
  changed_files: ['src/wrap.mjs'],
  evidence: ['stub edit pending the upstream context'],
  context_request: UNPULLABLE_REQUEST,
});

const ENRICHED_BODY = JSON.stringify({
  verdict: 'accept',
  summary:
    'ENRICHED: wrapped the index with ((index % len) + len) % len, covering the negative-index edge the pulled observations named',
  changed_files: ['src/wrap.mjs'],
  evidence: [
    'used the delivered analyze-step.observations (negative-index edge) and analyze-step.sources',
  ],
});

// The R3 deep-depth probe. Build's slice loop (iterates_slice_loop) wraps
// act-step -> verify-step and activates at depth 'high', running one
// implement+verify pass per plan slice. So at high depth the implementer (where
// a context_request surfaces) IS the corridor head step. A two-slice report makes
// the corridor genuinely iterate. allowed_touch_area is left empty so the gate
// stays inert across the iterations (this probe is about the corridor skip, not
// the touch-area gate).
const DEEP_ANALYZE_REPORT = {
  ...ANALYZE_REPORT,
  slices: [
    {
      id: 'slice-1',
      intent: 'replace the wrapIndex stub body with the modulo wrap',
      anticipated_file_extensions: ['.mjs'],
    },
    {
      id: 'slice-2',
      intent: 'add the regression guard for the negative-index edge',
      anticipated_file_extensions: ['.mjs'],
    },
  ],
  allowed_touch_area: [],
};

// ---------------------------------------------------------------------------
// The rich-surface arm. The wrap-index task above is a LEAN surface: a small fix
// whose tiny research the implementer needs almost all of, so pull saves little.
// The 10x regime the offline demonstrator measured needs the opposite — a WIDE
// investigation whose report carries a lot the implementer does not need.
//
// This is a realistic wide change: migrating every call site of a deprecated
// helper. The researcher reads a dozen files and records a read-note per file
// (provenance: what each call site looks like, why it is safe to migrate). The
// IMPLEMENTER works from the synthesized observations and the plan slices, not
// the dozen raw read-notes — those informed the research but are not what you
// type the change from. So the implementer pulls only `observations`, and the
// bulky `sources` array is exactly the irrelevant cost a fat push would carry.
// Constructed (not a committed eval task), but every byte is a plausible
// research read-note, and it is run through the same real engine.
// ---------------------------------------------------------------------------

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
  // Left empty: this arm isolates the carrying-cost measurement, so the
  // touch-area gate stays inert and no git baseline is needed.
  allowed_touch_area: [],
};

// The narrow need: the synthesis only. The bulky per-file read-notes stay behind.
const RICH_PULL_REQUEST = {
  queries: [{ from_step: 'analyze-step', field_path: 'observations' }],
};

const RICH_STARVED_BODY = JSON.stringify({
  verdict: 'accept',
  summary: 'STARVED: migrating from the one-line plan slice without the research synthesis',
  changed_files: RICH_SOURCE_FILES,
  evidence: ['edits pending the upstream synthesis'],
  context_request: RICH_PULL_REQUEST,
});

const RICH_ENRICHED_BODY = JSON.stringify({
  verdict: 'accept',
  summary:
    'ENRICHED: migrated every call site to formatCurrency with two-decimal rounding, preserving output as the pulled observations required',
  changed_files: RICH_SOURCE_FILES,
  evidence: ['used the delivered analyze-step.observations synthesis to keep rounding behavior'],
});

// A Build relayer whose implementer answers differently before and after
// delivery: starved (a context_request) on the first pass, enriched once the
// prompt carries the Delivered Context block. Parameterized by the analyze
// report (so a rich-surface arm can feed a bigger parent), the starved body (so
// the honesty arm can swap in the unpullable request), and the enriched body.
function buildRelayer(opts: {
  analyzeReport: unknown;
  starvedBody: string;
  enrichedBody: string;
}): RelayFn {
  return {
    connectorName: 'claude-code',
    relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
      const isAnalyze = input.prompt.includes('Step: analyze-step');
      const isAct = input.prompt.includes('Step: act-step');
      const hasDeliveredContext = input.prompt.includes('Delivered Context');
      const body =
        isAct && hasDeliveredContext
          ? opts.enrichedBody
          : isAnalyze
            ? JSON.stringify(opts.analyzeReport)
            : isAct
              ? opts.starvedBody
              : REVIEW;
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

async function readTrace(runFolder: string) {
  return await new TraceStore(runFolder).load();
}

function byKind(entries: Awaited<ReturnType<typeof readTrace>>, kind: string) {
  return entries.filter((entry) => entry.kind === kind);
}

// Bytes of one field of the analyze report, measured the same way the channel
// measures a delivered slice: JSON.stringify the value.
function fieldBytes(field: keyof typeof ANALYZE_REPORT): number {
  return Buffer.byteLength(JSON.stringify(ANALYZE_REPORT[field]), 'utf8');
}

describe('Runtime-binding battle-test (live Build flow, real wrap-index task)', () => {
  it(
    'thin+pull+deliver reaches a clean close carrying only the named slices, vs the whole analyze surface a fat push would carry',
    async () => {
      const runFolder = join(runFolderBase, 'thin-pull');
      const result = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: fixtureBytes(),
        runId: 'b0000000-0000-0000-0000-000000000001',
        goal: 'Fix wrapIndex so paging past the last slide wraps to the start',
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 5, 17, 8, 0, 0)),
        relayer: buildRelayer({
          analyzeReport: ANALYZE_REPORT,
          starvedBody: STARVED_BODY,
          enrichedBody: ENRICHED_BODY,
        }),
        projectRoot: gitProjectRoot(['src/wrap.mjs']),
        selectionConfigLayers: [],
        enableContextDelivery: true,
      });

      const entries = await readTrace(runFolder);
      const deliveries = byKind(entries, 'run.context-delivery').filter(
        (e) => (e as { step_id: string }).step_id === 'act-step',
      );
      const pulls = byKind(entries, 'run.context-pull');
      const reshapes = byKind(entries, 'run.equipment-reshape');

      // The starving implementer pulled and re-ran once on the enriched context,
      // and the run reached a clean (non-aborted) close: completeness.
      expect(deliveries.length).toBe(1);
      const delivery = deliveries[0] as {
        kept: string;
        delivered_slices: number;
        delivered_bytes: number;
      };
      expect(delivery.kept).toBe('retry');
      expect(delivery.delivered_slices).toBe(2);
      expect(result.outcome).not.toBe('aborted');

      // The body the run kept is the ENRICHED one (proves the delivered context
      // was actually used), not the starved stub.
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
      ) as { summary: string };
      expect(keptBody.summary.startsWith('ENRICHED')).toBe(true);

      // ---- THE MEASUREMENT (all read back from the run) ----
      // Thin+pull carried upstream-context = the bytes the engine folded in.
      const thinPullBytes = delivery.delivered_bytes;
      // Fat-push carried upstream-context = the whole analyze report the engine
      // wrote to disk (what a fat envelope would fold into the implementer).
      const analyzeReportBytes = Buffer.byteLength(
        readFileSync(join(runFolder, 'reports/build/context.json'), 'utf8'),
        'utf8',
      );
      // Per-field breakdown so the saving is legible (no padding hidden in a
      // blob): the implementer needed observations+sources; the rest of the
      // report is the focus/irrelevant cost a fat push would also carry.
      const breakdown = {
        verdict: fieldBytes('verdict'),
        sources: fieldBytes('sources'),
        observations: fieldBytes('observations'),
        open_questions: fieldBytes('open_questions'),
        anticipated_file_extensions: fieldBytes('anticipated_file_extensions'),
        slices: fieldBytes('slices'),
        guardrails: fieldBytes('guardrails'),
        allowed_touch_area: fieldBytes('allowed_touch_area'),
      };
      const pulledFieldBytes = breakdown.observations + breakdown.sources;
      const ratioFullReport = analyzeReportBytes / thinPullBytes;

      // The pulls were all answered (no starvation) and recorded (legible).
      const answeredPulls = pulls.filter((e) => (e as { answered: boolean }).answered);
      expect(answeredPulls.length).toBe(2);

      // eslint-disable-next-line no-console
      console.log(
        `\n===BATTLE_TEST_SUMMARY_START===\n${JSON.stringify(
          {
            task: 'heldout-wrap-index',
            outcome: result.outcome,
            completeness: 'clean close on the enriched context (not aborted)',
            delivery: {
              fired: true,
              kept: delivery.kept,
              delivered_slices: delivery.delivered_slices,
              delivered_bytes: thinPullBytes,
            },
            pulls_recorded: pulls.length,
            pulls_answered: answeredPulls.length,
            reshape: { enabled: true, fired: reshapes.length > 0, entries: reshapes.length },
            carried_upstream_context_bytes: {
              thin_pull_deliver: thinPullBytes,
              fat_push_whole_analyze_report: analyzeReportBytes,
              reduction_ratio_full_report: Number(ratioFullReport.toFixed(2)),
              irrelevant_bytes_avoided: analyzeReportBytes - thinPullBytes,
            },
            analyze_report_field_bytes: breakdown,
            pulled_field_bytes: pulledFieldBytes,
          },
          null,
          2,
        )}\n===BATTLE_TEST_SUMMARY_END===\n`,
      );
    },
    TIMEOUT_MS,
  );

  it(
    'rich surface, narrow need: pulling only the synthesis leaves the bulky read-notes behind, where the carrying saving climbs',
    async () => {
      const runFolder = join(runFolderBase, 'rich-pull');
      const result = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: fixtureBytes(),
        runId: 'b0000000-0000-0000-0000-000000000003',
        goal: 'Migrate every call site off the deprecated formatLegacy helper',
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 5, 17, 9, 0, 0)),
        relayer: buildRelayer({
          analyzeReport: RICH_ANALYZE_REPORT,
          starvedBody: RICH_STARVED_BODY,
          enrichedBody: RICH_ENRICHED_BODY,
        }),
        projectRoot: gitProjectRoot(RICH_SOURCE_FILES),
        selectionConfigLayers: [],
        enableContextDelivery: true,
      });

      const entries = await readTrace(runFolder);
      const deliveries = byKind(entries, 'run.context-delivery').filter(
        (e) => (e as { step_id: string }).step_id === 'act-step',
      );
      expect(deliveries.length).toBe(1);
      const delivery = deliveries[0] as {
        kept: string;
        delivered_slices: number;
        delivered_bytes: number;
      };
      expect(delivery.kept).toBe('retry');
      expect(delivery.delivered_slices).toBe(1);
      expect(result.outcome).not.toBe('aborted');

      const thinPullBytes = delivery.delivered_bytes;
      const analyzeReportBytes = Buffer.byteLength(
        readFileSync(join(runFolder, 'reports/build/context.json'), 'utf8'),
        'utf8',
      );
      const sourcesBytes = Buffer.byteLength(JSON.stringify(RICH_ANALYZE_REPORT.sources), 'utf8');
      const ratioFullReport = analyzeReportBytes / thinPullBytes;

      // eslint-disable-next-line no-console
      console.log(
        `\n===RICH_SUMMARY_START===\n${JSON.stringify(
          {
            scenario: 'wide call-site migration (constructed rich surface, real engine)',
            outcome: result.outcome,
            pulled: 'observations only (the synthesis)',
            delivered_slices: delivery.delivered_slices,
            carried_upstream_context_bytes: {
              thin_pull_deliver: thinPullBytes,
              fat_push_whole_analyze_report: analyzeReportBytes,
              reduction_ratio_full_report: Number(ratioFullReport.toFixed(2)),
              irrelevant_bytes_avoided: analyzeReportBytes - thinPullBytes,
              raw_read_notes_left_behind_bytes: sourcesBytes,
            },
          },
          null,
          2,
        )}\n===RICH_SUMMARY_END===\n`,
      );
    },
    TIMEOUT_MS,
  );

  it(
    'R3 deep-depth probe: at deep depth (slice loop active) the implementer runs inside the corridor; its pull is now RECORDED (resolve-and-record lifted) though delivery-in-corridor stays deferred',
    async () => {
      // Medium-depth control: the implementer is NOT in a corridor, so the pull
      // resolves and (with delivery on) re-runs — the baseline the deep run breaks.
      const mediumFolder = join(runFolderBase, 'r3-medium');
      await runCompiledFlow({
        runDir: mediumFolder,
        flowBytes: fixtureBytes(),
        runId: 'b0000000-0000-0000-0000-000000000004',
        goal: 'Fix wrapIndex so paging past the last slide wraps to the start',
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 5, 17, 10, 0, 0)),
        relayer: buildRelayer({
          analyzeReport: DEEP_ANALYZE_REPORT,
          starvedBody: STARVED_BODY,
          enrichedBody: ENRICHED_BODY,
        }),
        projectRoot: gitProjectRoot(['src/wrap.mjs']),
        selectionConfigLayers: [],
        enableContextDelivery: true,
      });
      const mediumEntries = await readTrace(mediumFolder);
      // Scope the pull/delivery counts to the act-step (the requesting step) the
      // way the sibling relay count below does, so a future fixture change that
      // makes another step emit a request cannot silently inflate these.
      const isActStep = (e: Awaited<ReturnType<typeof readTrace>>[number]) =>
        (e as { step_id?: string }).step_id === 'act-step';
      const mediumDeliveries = byKind(mediumEntries, 'run.context-delivery').filter(isActStep);
      const mediumPulls = byKind(mediumEntries, 'run.context-pull').filter(isActStep);

      // Deep-depth probe: same report, same starving implementer, run at the
      // 'autonomous' depth. The slice loop activates at depth >= 'high'; both
      // 'high' and 'autonomous' put the act-step inside the corridor identically.
      // 'autonomous' is the lever here because a plain 'high' run PARKS at the
      // frame checkpoint (by design: high/tournament wait for an operator) and the
      // checkpoint-resume path does not re-wire the context-pull channel, which
      // would confound the measurement. 'autonomous' auto-resolves the checkpoint
      // via its safe default and completes in one call with the channel wired.
      const deepFolder = join(runFolderBase, 'r3-deep');
      const deepResult = await runCompiledFlow({
        runDir: deepFolder,
        flowBytes: fixtureBytes(),
        runId: 'b0000000-0000-0000-0000-000000000005',
        goal: 'Fix wrapIndex so paging past the last slide wraps to the start',
        depth: 'autonomous',
        now: deterministicNow(Date.UTC(2026, 5, 17, 10, 30, 0)),
        relayer: buildRelayer({
          analyzeReport: DEEP_ANALYZE_REPORT,
          starvedBody: STARVED_BODY,
          enrichedBody: ENRICHED_BODY,
        }),
        projectRoot: gitProjectRoot(['src/wrap.mjs']),
        selectionConfigLayers: [],
        enableContextDelivery: true,
      });
      const deepEntries = await readTrace(deepFolder);
      const deepDeliveries = byKind(deepEntries, 'run.context-delivery').filter(isActStep);
      const deepPulls = byKind(deepEntries, 'run.context-pull').filter(isActStep);
      // The corridor genuinely iterated: act-step ran more than once (per slice).
      const deepActRelays = deepEntries.filter(
        (e) => e.kind === 'relay.completed' && (e as { step_id: string }).step_id === 'act-step',
      );

      // CONTROL: medium depth delivered + recorded the pull.
      expect(mediumDeliveries.length).toBe(1);
      expect(mediumPulls.length).toBeGreaterThan(0);
      // PROBE: deep depth ran the implementer inside the corridor (multiple act
      // passes). Delivery-in-corridor stays deferred, so NO delivery re-runs the
      // step — but the lifted resolve-and-record seam now RECORDS the pull as a
      // finding on the corridor passes, closing the legibility gap the prior cut
      // documented (the pull is no longer silently dropped).
      expect(deepActRelays.length).toBeGreaterThan(1);
      expect(deepDeliveries.length).toBe(0);
      expect(deepPulls.length).toBeGreaterThan(0);
      expect(deepResult.outcome).not.toBe('aborted');

      // eslint-disable-next-line no-console
      console.log(
        `\n===R3_SUMMARY_START===\n${JSON.stringify(
          {
            question: 'are pulls surfaced inside slice corridors, and how often?',
            slice_loop: 'act-step -> verify-step, activates at depth >= high',
            medium_depth_control: {
              act_passes: byKind(mediumEntries, 'relay.completed').filter(
                (e) => (e as { step_id: string }).step_id === 'act-step',
              ).length,
              deliveries: mediumDeliveries.length,
              pulls_recorded: mediumPulls.length,
            },
            deep_depth_probe: {
              depth: 'autonomous (>= the slice-loop floor of high)',
              act_passes: deepActRelays.length,
              deliveries: deepDeliveries.length,
              pulls_recorded: deepPulls.length,
              outcome: deepResult.outcome,
            },
            finding:
              'at deep depth the implementer is the corridor head step; the lifted resolve-and-record seam now records its pull as a finding on the corridor passes (legible), while delivery-in-corridor stays deferred so the step is not re-run on enriched context',
          },
          null,
          2,
        )}\n===R3_SUMMARY_END===\n`,
      );
    },
    TIMEOUT_MS,
  );

  it(
    'honesty: a step that asks for an unpullable slice gets an honest refusal, no fabricated context, and no retry',
    async () => {
      const runFolder = join(runFolderBase, 'honesty');
      const result = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: fixtureBytes(),
        runId: 'b0000000-0000-0000-0000-000000000002',
        goal: 'Fix wrapIndex so paging past the last slide wraps to the start',
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 5, 17, 8, 30, 0)),
        relayer: buildRelayer({
          analyzeReport: ANALYZE_REPORT,
          starvedBody: STARVED_UNPULLABLE_BODY,
          enrichedBody: ENRICHED_BODY,
        }),
        projectRoot: gitProjectRoot(['src/wrap.mjs']),
        selectionConfigLayers: [],
        enableContextDelivery: true,
      });

      const entries = await readTrace(runFolder);
      const pulls = byKind(entries, 'run.context-pull');
      const deliveries = byKind(entries, 'run.context-delivery');

      // The unpullable field was resolved to an honest refusal (answered:false),
      // recorded in the trace — NOT silently filled with a fabricated value.
      const refusals = pulls.filter((e) => (e as { answered: boolean }).answered === false);
      expect(refusals.length).toBeGreaterThanOrEqual(1);
      // Nothing was delivered, so no re-run fired: the run proceeded on the
      // context it honestly had, never on invented context.
      expect(deliveries.length).toBe(0);
      // The act-step never received a Delivered Context block. The relay request
      // file holds the raw prompt text the worker was sent.
      const actRequest = readFileSync(
        join(runFolder, 'reports/relay/build-act.request.json'),
        'utf8',
      );
      expect(actRequest).not.toContain('Delivered Context');

      // eslint-disable-next-line no-console
      console.log(
        `\n===HONESTY_SUMMARY_START===\n${JSON.stringify(
          {
            requested_field: 'analyze-step.root_cause_secret (does not exist)',
            outcome: result.outcome,
            refusals_recorded: refusals.length,
            deliveries: deliveries.length,
            fabricated_context: false,
            note: 'the channel records the unanswerable ask as a finding and delivers nothing; delivery only ever folds in genuinely-resolved slices',
          },
          null,
          2,
        )}\n===HONESTY_SUMMARY_END===\n`,
      );
    },
    TIMEOUT_MS,
  );
});
