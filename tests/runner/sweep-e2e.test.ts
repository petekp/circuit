import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import type { RelayFn } from '../../src/shared/relay-runtime-types.js';
import { deterministicNow, stubRelayResult } from '../helpers/runtime-fixtures.js';

// Sweep's end-to-end test — the fan-out-over-a-set cousin of fix-until-green,
// driven the full way through `runCompiledFlow`. The census, partition, and
// rescan steps spawn the fixture's real `npm run scan` / `npm run audit`
// scripts as subprocesses, so the scanner's zero-finding exit and the audit's
// suppression exit are genuine — only the fanout workers and the judge are
// faked (the connector model call), exactly like fix-until-green.
//
// What this proves that fix-until-green does not: sweep's body FANS OUT one
// worker per partition unit and re-scans a whole backlog each wave. The four
// cases exercise the loop and both honesty floors beyond the scanner exit:
//   A  happy path — a two-wave sweep clears a three-finding backlog and stops
//      clean; the carried judge lesson reaches the second wave's partition.
//   B  suppression floor — a worker silences a finding instead of fixing it;
//      the scan goes green but the audit exits red, so overall_status is failed
//      and the run exits needs-attention, never complete.
//   C  frozen-config floor — a worker fixes its finding but also edits the
//      declared frozen tsconfig; the scan and audit both go green, yet the
//      frozen-eval latch blocks the clean stop.
//   D2 script-body swap — across waves a worker rewrites the pinned `scan`
//      script to a no-op; the oracle-command pin detects the fingerprint drift
//      and refuses to trust the rewritten oracle, so the run cannot complete.
//
// D1 (command narrowing) and the nested-config-create case (spec §9 E) are
// covered by the oracle-command-pin and frozen-eval unit tests; this file
// proves the wiring of the whole flow, not each guard in isolation.

const FIXTURE_ROOT = resolve('tests/fixtures/sweep-fixture');
const SWEEP_FIXTURE = readFileSync(resolve('generated/flows/sweep/circuit.json'));

interface TraceRow {
  readonly kind: string;
  readonly step_id?: string | undefined;
  readonly route_taken?: string | undefined;
  readonly reason?: string | undefined;
  readonly failure_reason?: string | undefined;
}

function enteredCount(trace: readonly TraceRow[], stepId: string): number {
  return trace.filter((e) => e.kind === 'step.entered' && e.step_id === stepId).length;
}

function judgeRoutesTaken(trace: readonly TraceRow[]): (string | undefined)[] {
  return trace
    .filter((e) => e.kind === 'step.completed' && e.step_id === 'judge-step')
    .map((e) => e.route_taken);
}

// The FINAL until-judgment: on a multi-wave run each wave stamps one, and the
// last is the disposition that decided the outcome (a single-pass run has one).
function untilJudgment(trace: readonly TraceRow[]) {
  return [...trace].reverse().find((e) => e.kind === 'run.until-judgment') as
    | {
        disposition?: string;
        goal_proposed?: boolean;
        evidence_confirmed?: boolean;
        open_latch_count?: number;
      }
    | undefined;
}

// Copy the checked-in fixture into a fresh project root the workers may mutate.
function scaffoldProject(base: string): string {
  const projectRoot = join(base, 'project');
  cpSync(FIXTURE_ROOT, projectRoot, { recursive: true });
  return projectRoot;
}

// What a faked worker does to the tree it was assigned. Behavior is keyed by the
// file the unit owns and how many times that file has been handed out, so the
// choreography is deterministic even though a wave's workers run concurrently
// (waves are sequential, and each file belongs to exactly one unit per wave).
type WorkerAction = 'fix' | 'blocked' | 'suppress' | 'freeze-config' | 'swap-scanner';

// A real fix removes the NEEDS_FIX marker; the other actions model the tamper
// vectors the honesty floors must catch.
function applyWorkerAction(
  projectRoot: string,
  file: string,
  action: WorkerAction,
): { verdict: 'fixed' | 'partial' | 'blocked'; changed: string[] } {
  const abs = join(projectRoot, file);
  if (action === 'blocked') {
    // Leave the finding untouched for the next wave. A blocked worker
    // legitimately changed nothing, so changed_files is empty.
    return { verdict: 'blocked', changed: [] };
  }
  if (action === 'suppress') {
    // Silence the finding instead of fixing it: the scan stops reporting it, but
    // the audit now exits red. Keep NEEDS_FIX so the suppression is what clears
    // the scan, not a real fix.
    writeFileSync(abs, `${readFileSync(abs, 'utf8')}\n// sweep-suppress: silenced\n`);
    return { verdict: 'fixed', changed: [file] };
  }
  // Every remaining action removes the marker (a real fix)...
  writeFileSync(abs, readFileSync(abs, 'utf8').replace(/NEEDS_FIX/g, 'RESOLVED'));
  if (action === 'freeze-config') {
    // ...but also relaxes the declared frozen config out from under the oracle.
    const tsconfigPath = join(projectRoot, 'tsconfig.json');
    const cfg = JSON.parse(readFileSync(tsconfigPath, 'utf8')) as {
      compilerOptions: Record<string, unknown>;
    };
    cfg.compilerOptions.strict = false;
    writeFileSync(tsconfigPath, `${JSON.stringify(cfg, null, 2)}\n`);
    return { verdict: 'fixed', changed: [file, 'tsconfig.json'] };
  }
  if (action === 'swap-scanner') {
    // ...but also rewrites the pinned scan script to an always-green no-op.
    const pkgPath = join(projectRoot, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts: Record<string, string> };
    pkg.scripts.scan =
      'node -e "process.stdout.write(String.fromCharCode(123,34)+`findings`+String.fromCharCode(34,58,91,93,125));process.exit(0)"';
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    return { verdict: 'fixed', changed: [file] };
  }
  return { verdict: 'fixed', changed: [file] };
}

// Build the sweep relayer. The judge (bound to converge.judgment@v1) proposes
// goal_met every wave and carries a lesson; whether the claim stands is the
// evidence floor's call. Each fanout branch worker's synthetic step id is
// `fanout-step-<unit_id>` and its goal is the partition writer's fix prompt,
// which names the one file the unit owns — so the relayer recovers both from the
// prompt and echoes unit_id back as the branch provenance field.
function sweepRelayer(input: {
  readonly projectRoot: string;
  readonly behavior: (file: string, encounter: number) => WorkerAction;
  readonly lesson?: string;
}): RelayFn {
  const encounters = new Map<string, number>();
  const lesson = input.lesson ?? 'none';
  return {
    connectorName: 'claude-code',
    relay: async (relayInput) => {
      const prompt = relayInput.prompt;
      if (prompt.includes('Step: judge-step')) {
        return stubRelayResult({
          request_payload: prompt,
          result_body: JSON.stringify({
            verdict: 'accept',
            goal_met: true,
            lesson,
            summary: 'judged the wave against the pinned rescan floor',
          }),
        });
      }
      const unitMatch = prompt.match(/Step: fanout-step-(\S+)/);
      // The fix prompt reads "Fix every finding in <file>. Change only this
      // file." — anchor on that suffix so the file keeps its extension (a
      // non-greedy match to the first dot would stop at `src/alpha`).
      const fileMatch = prompt.match(/Fix every finding in (\S+)\. Change only this file/);
      if (unitMatch && fileMatch) {
        const unitId = unitMatch[1] as string;
        const file = fileMatch[1] as string;
        const encounter = (encounters.get(file) ?? 0) + 1;
        encounters.set(file, encounter);
        const { verdict, changed } = applyWorkerAction(
          input.projectRoot,
          file,
          input.behavior(file, encounter),
        );
        return stubRelayResult({
          request_payload: prompt,
          result_body: JSON.stringify({
            unit_id: unitId,
            verdict,
            changed_files: changed,
            rule_fixed: 'no-needs-fix',
            evidence: `worker handled ${file} (encounter ${encounter})`,
          }),
        });
      }
      // No other relays are expected — census, partition, and rescan are engine
      // writers, not model calls.
      return stubRelayResult({ request_payload: prompt, result_body: '{"verdict":"ok"}' });
    },
  };
}

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'circuit-sweep-e2e-'));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('sweep: fan-out-over-a-set clears a backlog with a pinned oracle floor', () => {
  it('A: clears a three-finding backlog over two waves and stops clean; the judge lesson carries forward', async () => {
    const projectRoot = scaffoldProject(base);
    const runFolder = join(base, 'happy');

    // Wave 0 fixes alpha and beta but leaves gamma blocked, so the scan stays
    // red and the loop re-enters. Wave 1 fixes gamma; the scan and audit both go
    // green and the loop stops clean. Exactly the shape a real sweep has: a wave
    // that clears most of the backlog, then a wave that finishes the survivors.
    const result = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: SWEEP_FIXTURE,
      projectRoot,
      runId: '80000000-0000-0000-0000-0000000000a1',
      goal: 'clear every NEEDS_FIX finding until the scanner exits clean',
      depth: 'autonomous',
      now: deterministicNow(Date.UTC(2026, 6, 7, 9, 0, 0)),
      relayer: sweepRelayer({
        projectRoot,
        lesson: 'keep clearing the survivors, one file per unit',
        behavior: (file, encounter) =>
          file.endsWith('gamma.ts') && encounter === 1 ? 'blocked' : 'fix',
      }),
    });
    const trace = (await new TraceStore(runFolder).load()) as readonly TraceRow[];

    expect(result.outcome).toBe('complete');
    expect(result.flow_id).toBe('sweep');

    // The census is the preamble: it runs once, before the loop. The body's four
    // steps run twice — one blocked wave that re-enters, one clean wave.
    expect(enteredCount(trace, 'census-step')).toBe(1);
    expect(enteredCount(trace, 'partition-step')).toBe(2);
    expect(enteredCount(trace, 'fanout-step')).toBe(2);
    expect(enteredCount(trace, 'rescan-step')).toBe(2);
    expect(enteredCount(trace, 'judge-step')).toBe(2);
    expect(trace.find((e) => e.kind === 'step.aborted')).toBeUndefined();

    // Wave 0's judge re-entered the head via `advance` (the floor blocked the
    // premature goal_met on the still-red scan); wave 1's judge took the clean
    // forward route.
    expect(judgeRoutesTaken(trace)).toEqual(['advance', 'pass']);
    expect(untilJudgment(trace)?.disposition).toBe('stop-clean');

    // The final rescan passed: scanner clean AND audit clean.
    const rescan = JSON.parse(
      readFileSync(join(runFolder, 'reports/sweep/rescan.json'), 'utf8'),
    ) as { overall_status: string };
    expect(rescan.overall_status).toBe('passed');

    // Compounding: the lesson the judge wrote on the blocked wave reaches the
    // next wave. The engine appends it to carried-notes on re-enter, and the
    // partition writer reads that file itself (a compose head has no relay prompt
    // to re-inline it), folding it into every unit's fix prompt. So wave 1's
    // partition carries wave 0's lesson verbatim.
    const carriedNotesPath = join(runFolder, 'reports/sweep/carried-notes.json');
    expect(existsSync(carriedNotesPath)).toBe(true);
    const carried = JSON.parse(readFileSync(carriedNotesPath, 'utf8')) as Array<{ lesson: string }>;
    expect(carried).toHaveLength(1);
    expect(carried[0]?.lesson).toBe('keep clearing the survivors, one file per unit');

    const partition = JSON.parse(
      readFileSync(join(runFolder, 'reports/sweep/partition.json'), 'utf8'),
    ) as { units: Array<{ files: string[]; fix_prompt: string }> };
    expect(partition.units).toHaveLength(1);
    expect(partition.units[0]?.files).toEqual(['src/gamma.ts']);
    expect(partition.units[0]?.fix_prompt).toContain(
      'Lesson carried from an earlier attempt: keep clearing the survivors, one file per unit',
    );
  }, 60_000);

  it('B: a suppressed finding clears the scan but the audit floor keeps the run out of complete', async () => {
    const projectRoot = scaffoldProject(base);
    const runFolder = join(base, 'suppress');

    // Below the autonomous floor the body runs once and the tail disposes
    // honestly. Every worker suppresses instead of fixing: the scan goes green
    // (all findings silenced) but the audit exits red (three suppressions
    // against a baseline of zero), so overall_status is failed and the goal_met
    // claim cannot stand. A one-pass run can never launder a suppression into
    // complete.
    const result = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: SWEEP_FIXTURE,
      projectRoot,
      runId: '80000000-0000-0000-0000-0000000000b2',
      goal: 'a suppression must not launder a clean close',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 7, 9, 30, 0)),
      relayer: sweepRelayer({ projectRoot, behavior: () => 'suppress' }),
    });
    const trace = (await new TraceStore(runFolder).load()) as readonly TraceRow[];

    expect(result.outcome).toBe('stopped');
    expect(enteredCount(trace, 'partition-step')).toBe(1);
    expect(enteredCount(trace, 'fanout-step')).toBe(1);
    expect(enteredCount(trace, 'rescan-step')).toBe(1);
    expect(enteredCount(trace, 'judge-step')).toBe(1);
    expect(judgeRoutesTaken(trace)).toEqual(['close']);

    const judgment = untilJudgment(trace);
    expect(judgment?.disposition).toBe('needs-attention');
    expect(judgment?.goal_proposed).toBe(true);
    expect(judgment?.evidence_confirmed).toBe(false);

    // The audit is what failed the rescan: the scan itself found nothing (the
    // findings were silenced), but the suppression audit exited red.
    const rescan = JSON.parse(
      readFileSync(join(runFolder, 'reports/sweep/rescan.json'), 'utf8'),
    ) as { overall_status: string; commands: Array<{ command_id: string; status: string }> };
    expect(rescan.overall_status).toBe('failed');
    const audit = rescan.commands.find((c) => c.command_id === 'sweep-audit');
    expect(audit?.status).toBe('failed');
  }, 60_000);

  it('C: fixing the code but editing the frozen config latches the eval floor, so the run cannot complete', async () => {
    const projectRoot = scaffoldProject(base);
    const runFolder = join(base, 'frozen');

    // One worker fixes its finding AND relaxes the declared frozen tsconfig; the
    // others fix cleanly. The scan and audit both go green, so the rescan passes
    // and the goal_met claim would otherwise stand — but the frozen-eval guard
    // sees the config drift and opens a latch the evidence floor refuses to
    // honor. A green scan bought by relaxing the rules is not a clean close.
    const result = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: SWEEP_FIXTURE,
      projectRoot,
      runId: '80000000-0000-0000-0000-0000000000c3',
      goal: 'editing the frozen config must not buy a clean close',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 6, 7, 10, 0, 0)),
      relayer: sweepRelayer({
        projectRoot,
        behavior: (file) => (file.endsWith('alpha.ts') ? 'freeze-config' : 'fix'),
      }),
    });
    const trace = (await new TraceStore(runFolder).load()) as readonly TraceRow[];

    expect(result.outcome).toBe('stopped');
    expect(judgeRoutesTaken(trace)).toEqual(['close']);

    // The rescan itself PASSED (scan clean, audit clean) — the block came from
    // the frozen latch, not the scanner. That is the distinguishing signal from
    // case B: an open latch with a green rescan.
    const rescan = JSON.parse(
      readFileSync(join(runFolder, 'reports/sweep/rescan.json'), 'utf8'),
    ) as { overall_status: string };
    expect(rescan.overall_status).toBe('passed');

    const judgment = untilJudgment(trace);
    expect(judgment?.disposition).toBe('needs-attention');
    expect(judgment?.evidence_confirmed).toBe(false);
    expect(judgment?.open_latch_count ?? 0).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('D2: rewriting the pinned scan script between waves trips the oracle-command pin and the run cannot complete', async () => {
    const projectRoot = scaffoldProject(base);
    const runFolder = join(base, 'script-swap');

    // Wave 0 fixes alpha and beta but leaves gamma blocked, so the scan stays red
    // and the loop re-enters — and the first rescan pins the `scan` script body.
    // Wave 1's gamma worker rewrites `scripts.scan` to an always-green no-op; the
    // pinned rescan re-checks the fingerprint, sees the drift, and refuses to run
    // the rewritten oracle. The run cannot complete on a laundered scan.
    const result = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: SWEEP_FIXTURE,
      projectRoot,
      runId: '80000000-0000-0000-0000-0000000000d2',
      goal: 'a rewritten scan script must not launder a clean close',
      depth: 'autonomous',
      now: deterministicNow(Date.UTC(2026, 6, 7, 10, 30, 0)),
      relayer: sweepRelayer({
        projectRoot,
        behavior: (file, encounter) => {
          if (file.endsWith('gamma.ts')) return encounter === 1 ? 'blocked' : 'swap-scanner';
          return 'fix';
        },
      }),
    });

    expect(result.outcome).not.toBe('complete');

    // The abort is specifically the oracle-command pin firing: the rescan's
    // report writer refuses to run once it sees the pinned scan body drifted.
    // Asserting the reason (not just "not complete") keeps this from passing on
    // an incidental failure.
    const trace = (await new TraceStore(runFolder).load()) as readonly TraceRow[];
    const driftReason = trace
      .map((e) => e.reason ?? e.failure_reason ?? '')
      .find((reason) => reason.includes('oracle script "scan" changed since the loop entered'));
    expect(driftReason).toBeDefined();

    // The worker did rewrite the script — the pin, not a missing edit, is what
    // stopped the laundered close.
    const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.scan).not.toBe('node scan.mjs');
  }, 60_000);
});
