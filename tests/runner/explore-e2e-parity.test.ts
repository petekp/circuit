import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import { CompiledFlow } from '../../src/schemas/compiled-flow.js';
import type { RelayFn } from '../../src/shared/relay-runtime-types.js';

import { validateCompiledFlowKindPolicy } from '../../src/flows/canonical-stage-policy.js';
import { makeStubRelayer } from '../helpers/runtime-fixtures.js';

// `explore` end-to-end fixture run.
//
// Structure mirrors the claude-code connector smoke file: always-running static
// declarations (ratchet-floor contribution) + AGENT_SMOKE-checkd
// real-subprocess end-to-end. Static tests bind the explore fixture
// shape, the normalization rule used to hash the normalized result
// report, and the `sha256Hex` helper format. The AGENT_SMOKE-checkd
// branch runs the real explore fixture through `runCompiledFlow` with the
// default `relayClaudeCode` (spawns `claude -p`), asserts the five-trace_entry
// relay transcript lands twice (synthesize + review), normalizes +
// hashes `reports/explore-result.json` against the checked-in golden.

const EXPLORE_FIXTURE_PATH = resolve('generated/flows/explore/circuit.json');
const GOLDEN_RESULT_SHA256_PATH = resolve('tests/fixtures/golden/explore/result.sha256');

const AGENT_SMOKE = process.env.AGENT_SMOKE === '1';
const UPDATE_GOLDEN = process.env.UPDATE_GOLDEN === '1';

function sha256Hex(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

// Normalize before hashing so deterministic sections stay stable across
// runs even when the run folder changes. The close-step report may include
// timestamps, receipt ids, run ids, or absolute paths, so the sentinel
// replacements keep the golden focused on semantic result shape.
function normalizeExploreResult(raw: string): string {
  const parsed: unknown = JSON.parse(raw);
  const canonical = canonicalize(parsed);
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function canonicalize(input: unknown): unknown {
  if (input === null || input === undefined) return input;
  if (typeof input === 'string') {
    if (ISO_TIMESTAMP_PATTERN.test(input)) return '<ISO_TIMESTAMP>';
    if (UUID_PATTERN.test(input)) return '<UUID>';
    if (input.startsWith('/')) return '<ABSOLUTE_PATH>';
    return input;
  }
  if (Array.isArray(input)) return input.map(canonicalize);
  if (typeof input === 'object') {
    const src = input as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) {
      if (k === 'summary') {
        sorted[k] = '<MODEL_TEXT>';
      } else if (k === 'compose_verdict' || k === 'review_verdict') {
        sorted[k] = '<VERDICT>';
      } else if (k === 'objection_count' || k === 'missed_angle_count') {
        sorted[k] = '<COUNT>';
      } else if (k === 'receipt_id' || k === 'run_id') {
        sorted[k] = '<ID>';
      } else if (k === 'recorded_at' || k === 'closed_at') {
        sorted[k] = '<ISO_TIMESTAMP>';
      } else {
        sorted[k] = canonicalize(src[k]);
      }
    }
    return sorted;
  }
  return input;
}

function loadExploreFixture(): { flow: CompiledFlow; bytes: Buffer } {
  const bytes = readFileSync(EXPLORE_FIXTURE_PATH);
  const raw: unknown = JSON.parse(bytes.toString('utf8'));
  return { flow: CompiledFlow.parse(raw), bytes };
}

function deterministicRelayer(): RelayFn {
  return makeStubRelayer((input) =>
    input.prompt.includes('Step: synthesize-step')
      ? JSON.stringify({
          verdict: 'accept',
          subject: 'explore: deterministic close-result parity run',
          recommendation: 'Keep the explore close aggregate deterministic',
          success_condition_alignment: 'The close result summarizes the typed reports',
          supporting_aspects: [
            {
              aspect: 'report-shape',
              contribution: 'The prior reports give the close step stable inputs',
              evidence_refs: ['reports/analysis.json'],
            },
          ],
        })
      : JSON.stringify({
          verdict: 'accept',
          overall_assessment: 'The compose is usable',
          objections: [],
          missed_angles: [],
        }),
  );
}

describe('explore fixture static declarations (ratchet-floor contribution)', () => {
  it('explore fixture parses through the production CompiledFlow schema', () => {
    const { flow } = loadExploreFixture();
    expect(flow.id).toBe('explore');
  });

  it('explore fixture satisfies validateCompiledFlowKindPolicy (canonical stages + omits)', () => {
    const { flow } = loadExploreFixture();
    const policy = validateCompiledFlowKindPolicy(flow);
    expect(policy.ok).toBe(true);
  });

  it('explore fixture declares 5 steps with the expected kind distribution', () => {
    const { flow } = loadExploreFixture();
    expect(flow.steps).toHaveLength(5);
    const compose = flow.steps.filter((s) => s.kind === 'compose');
    const relay = flow.steps.filter((s) => s.kind === 'relay');
    expect(compose).toHaveLength(3); // frame + analyze + close
    expect(relay).toHaveLength(2); // synthesize + review
  });

  it('explore close-step writes.report.path targets reports/explore-result.json', () => {
    const { flow } = loadExploreFixture();
    const close = flow.steps.find((s) => s.id === 'close-step');
    expect(close).toBeDefined();
    if (close?.kind !== 'compose') throw new Error('close-step must be compose');
    expect(close.writes.report.path).toBe('reports/explore-result.json');
  });

  it('explore synthesize-step + review-step declare role + check.pass vocabulary', () => {
    const { flow } = loadExploreFixture();
    const synthesize = flow.steps.find((s) => s.id === 'synthesize-step');
    const review = flow.steps.find((s) => s.id === 'review-step');
    if (synthesize?.kind !== 'relay' || review?.kind !== 'relay') {
      throw new Error('relay steps not found');
    }
    expect(synthesize.role).toBe('implementer');
    expect(review.role).toBe('reviewer');
    expect(synthesize.check.pass).toEqual(['accept']);
    expect(review.check.pass).toEqual(['accept', 'accept-with-fold-ins']);
  });

  it('sha256Hex over a known input is canonical 64-char lowercase hex', () => {
    const digest = sha256Hex('explore-parity');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toBe(createHash('sha256').update('explore-parity', 'utf8').digest('hex'));
  });

  it('normalizeExploreResult is pure — same input produces same output', () => {
    const raw = '{"summary":"<x>","verdict_snapshot":"<y>"}';
    const a = normalizeExploreResult(raw);
    const b = normalizeExploreResult(raw);
    expect(a).toBe(b);
  });

  it('normalizeExploreResult replaces ISO timestamps with the ISO_TIMESTAMP sentinel', () => {
    const raw = '{"recorded_at":"2026-04-22T00:00:00.000Z","note":"plain"}';
    const out = normalizeExploreResult(raw);
    expect(out).toContain('<ISO_TIMESTAMP>');
    expect(out).toContain('"note": "plain"');
  });

  it('normalizeExploreResult replaces UUID strings with the UUID sentinel', () => {
    const raw = '{"id":"11111111-1111-1111-1111-111111111111","other":"stay"}';
    const out = normalizeExploreResult(raw);
    expect(out).toContain('<UUID>');
    expect(out).toContain('"other": "stay"');
  });

  it('normalizeExploreResult replaces receipt_id + run_id keys with the ID sentinel', () => {
    const raw = '{"receipt_id":"anything","run_id":"anything","keep":"kept"}';
    const out = normalizeExploreResult(raw);
    expect(out).toContain('"receipt_id": "<ID>"');
    expect(out).toContain('"run_id": "<ID>"');
    expect(out).toContain('"keep": "kept"');
  });

  it('normalizeExploreResult redacts model-derived close-result fields', () => {
    const raw =
      '{"summary":"free prose","verdict_snapshot":{"compose_verdict":"accept","review_verdict":"accept-with-fold-ins","objection_count":3,"missed_angle_count":2}}';
    const out = normalizeExploreResult(raw);
    expect(out).toContain('"summary": "<MODEL_TEXT>"');
    expect(out).toContain('"compose_verdict": "<VERDICT>"');
    expect(out).toContain('"review_verdict": "<VERDICT>"');
    expect(out).toContain('"objection_count": "<COUNT>"');
    expect(out).toContain('"missed_angle_count": "<COUNT>"');
  });

  it('normalizeExploreResult sorts object keys alphabetically', () => {
    const raw = '{"z":1,"a":2,"m":3}';
    const out = normalizeExploreResult(raw);
    const lines = out.split('\n');
    const keyLines = lines.filter((l) => l.includes(':'));
    expect(keyLines[0]?.trim().startsWith('"a"')).toBe(true);
    expect(keyLines[1]?.trim().startsWith('"m"')).toBe(true);
    expect(keyLines[2]?.trim().startsWith('"z"')).toBe(true);
  });

  it('tests/fixtures/golden/explore/result.sha256 exists and is a single 64-char hex line', () => {
    expect(existsSync(GOLDEN_RESULT_SHA256_PATH)).toBe(true);
    const contents = readFileSync(GOLDEN_RESULT_SHA256_PATH, 'utf8').trim();
    expect(contents).toMatch(/^[0-9a-f]{64}$/);
  });

  it('golden sha256 is self-consistent with the deterministic explore.result close writer', async () => {
    const { bytes } = loadExploreFixture();
    const runFolder = mkdtempSync(join(tmpdir(), 'circuit-explore-golden-'));
    try {
      const outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId: '93000000-0000-0000-0000-000000000001',
        goal: 'explore: deterministic close-result parity run',
        depth: 'standard',
        now: () => new Date('2026-04-24T19:30:00.000Z'),
        relayer: deterministicRelayer(),
      });
      expect(outcome.outcome).toBe('complete');
      const normalized = normalizeExploreResult(
        readFileSync(join(runFolder, 'reports', 'explore-result.json'), 'utf8'),
      );
      const digest = sha256Hex(normalized);
      const golden = readFileSync(GOLDEN_RESULT_SHA256_PATH, 'utf8').trim();
      expect(digest).toBe(golden);
    } finally {
      rmSync(runFolder, { recursive: true, force: true });
    }
  });
});

// AGENT_SMOKE-checkd real-subprocess end-to-end. Runs ONLY when the
// operator explicitly opts in via AGENT_SMOKE=1 so CI (and developer-
// local runs without auth) stay green. Test body is written so a rerun
// against the golden locks normalized result-shape parity.
(AGENT_SMOKE ? describe : describe.skip)('explore fixture AGENT_SMOKE end-to-end', () => {
  let runFolderBase: string;

  beforeEach(() => {
    runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-explore-e2e-'));
  });

  afterEach(() => {
    rmSync(runFolderBase, { recursive: true, force: true });
  });

  it(
    'closes the explore run end-to-end through the real relayClaudeCode + 2x five-trace_entry transcript + normalized golden parity',
    async () => {
      const { bytes } = loadExploreFixture();
      const runFolder = join(runFolderBase, 'explore-e2e');
      const outcome = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytes,
        runId: '33333333-3333-3333-3333-333333333333',
        goal: 'explore: AGENT_SMOKE end-to-end parity run',
        depth: 'standard',
        now: () => new Date(),
      });

      expect(outcome.outcome).toBe('complete');

      // Close-step's explore-result.json landed at the expected path.
      const exploreResultPath = join(runFolder, 'reports', 'explore-result.json');
      expect(existsSync(exploreResultPath)).toBe(true);

      // Hash the normalized close-step report against the golden.
      const normalized = normalizeExploreResult(readFileSync(exploreResultPath, 'utf8'));
      const digest = sha256Hex(normalized);
      if (UPDATE_GOLDEN) {
        mkdirSync(dirname(GOLDEN_RESULT_SHA256_PATH), { recursive: true });
        writeFileSync(GOLDEN_RESULT_SHA256_PATH, `${digest}\n`);
      }
      const golden = readFileSync(GOLDEN_RESULT_SHA256_PATH, 'utf8').trim();
      expect(digest).toBe(golden);

      // Two relay transcripts landed; each carries the five-trace_entry
      // sequence on its own (step_id, attempt) pair.
      const relaySteps = ['synthesize-step', 'review-step'];
      const traceEntries = await new TraceStore(runFolder).load();
      for (const stepId of relaySteps) {
        const kindsForStep = traceEntries
          .filter((e) => 'step_id' in e && e.step_id === stepId)
          .map((e) => e.kind);
        expect(kindsForStep).toContain('relay.started');
        expect(kindsForStep).toContain('relay.request');
        expect(kindsForStep).toContain('relay.receipt');
        expect(kindsForStep).toContain('relay.result');
        expect(kindsForStep).toContain('relay.completed');
      }
    },
    5 * 60 * 1000,
  );
});
