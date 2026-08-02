import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import type { RelayFn } from '../../src/shared/relay-runtime-types.js';
import { deterministicNow, stubRelayResult } from '../helpers/runtime-fixtures.js';

// Sweep's end-to-end test — the fan-out-over-a-set cousin of fix-until-green,
// driven the full way through `runCompiledFlow`. The census, partition, and
// rescan steps spawn the fixture's real scanner and audit as subprocesses, so
// the scanner's zero-finding exit and the audit's suppression exit are genuine
// — only the fanout workers and the judge are faked (the connector model call),
// exactly like fix-until-green.
//
// What this proves that fix-until-green does not: sweep's body FANS OUT one
// worker per partition unit and re-scans a whole backlog each wave. The cases
// exercise the loop and every honesty floor beyond the scanner exit:
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
//   D3 scanner-program rewrite — the script body is untouched but the program
//      it launches is neutered; the pin's program closure catches it (spec 6.6).
//   F  set narrowing — nothing about the oracle is touched at all; a worker
//      deletes the file its finding lived in, so the scan honestly goes green
//      over a smaller tree. The set-identity floor blocks the close (spec 6.4).
//   F2 the same floor on an honest run, so the cost of F is not a false alarm
//      on every normal sweep.
//   G  portability — a project with no npm scripts and no tsconfig declares its
//      scanner, audit, and config surface in .circuit/config.yaml, and sweeps.
//   H  the same project declaring nothing is refused, with a message naming the
//      key that would fix it instead of blaming a package.json it never had.
//   H2 declaring both commands but no config surface is also refused: sweep
//      could run, but the only path it would freeze is absent, and a frozen path
//      that does not exist fingerprints the same forever — an inert floor.
//
// D1 (command narrowing) and the nested-config-create case (spec §9 E) are
// covered by the oracle-command-pin and frozen-eval unit tests; this file
// proves the wiring of the whole flow, not each guard in isolation.

const FIXTURE_ROOT = resolve('tests/fixtures/sweep-fixture');
const SWEEP_FIXTURE = readFileSync(resolve('generated/flows/sweep/circuit.json'));
const SWEEP_E2E_TIMEOUT_MS = 180_000;

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

// The same fixture with every npm-shaped affordance removed: no `scan` or
// `audit` script to fall back to, and no tsconfig.json for the frozen surface to
// land on. It stands in for the Python or Rust repo that has a real scanner and
// none of Node's conventions.
//
// `declareToolchain: false` leaves it with no way to tell Sweep any of that,
// which is the case that must be refused rather than run.
function scaffoldForeignProject(
  base: string,
  name: string,
  options: { readonly declareToolchain: boolean },
): string {
  const projectRoot = join(base, name);
  cpSync(FIXTURE_ROOT, projectRoot, { recursive: true });

  const packageJsonPath = join(projectRoot, 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const { scan: _scan, audit: _audit, ...keptScripts } = packageJson.scripts ?? {};
  writeFileSync(
    packageJsonPath,
    `${JSON.stringify({ ...packageJson, scripts: keptScripts }, null, 2)}\n`,
  );

  // The config the scanner reads is named something Sweep has never heard of, so
  // only the project can say what it is.
  rmSync(join(projectRoot, 'tsconfig.json'));
  writeFileSync(join(projectRoot, 'toolchain.json'), '{"rules": ["no-needs-fix"]}\n');

  if (options.declareToolchain) {
    mkdirSync(join(projectRoot, '.circuit'), { recursive: true });
    writeFileSync(
      join(projectRoot, '.circuit', 'config.yaml'),
      [
        'verification:',
        '  scan: {argv: [node, scan.mjs]}',
        '  audit: {argv: [node, audit.mjs]}',
        '  frozen_paths: [toolchain.json]',
        '',
      ].join('\n'),
    );
  }
  return projectRoot;
}

// What a faked worker does to the tree it was assigned. Behavior is keyed by the
// file the unit owns and how many times that file has been handed out, so the
// choreography is deterministic even though a wave's workers run concurrently
// (waves are sequential, and each file belongs to exactly one unit per wave).
type WorkerAction =
  | 'fix'
  | 'blocked'
  | 'suppress'
  | 'freeze-config'
  | 'swap-scanner'
  | 'rewrite-scanner-program'
  | 'delete-file';

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
  if (action === 'delete-file') {
    // Delete the file the finding lives in. The scanner honestly reports no
    // finding for a file that no longer exists, so scan and audit both go green
    // over a SHRUNKEN set. Only the set-identity invariant separates this from a
    // real fix. Report it as a normal fix, which is what a dishonest worker does.
    rmSync(abs, { force: true });
    return { verdict: 'fixed', changed: [file] };
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
  if (action === 'rewrite-scanner-program') {
    // ...but also neuters the scanner PROGRAM the pinned script launches. The
    // argv and the package.json script body both stay byte-identical, so only
    // the program-closure fingerprint can see this.
    writeFileSync(
      join(projectRoot, 'scan.mjs'),
      'process.stdout.write(JSON.stringify({ findings: [] }));\nprocess.exit(0);\n',
    );
    return { verdict: 'fixed', changed: [file] };
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
  it(
    'A: clears a three-finding backlog over two waves and stops clean; the judge lesson carries forward',
    async () => {
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
      const carried = JSON.parse(readFileSync(carriedNotesPath, 'utf8')) as Array<{
        lesson: string;
      }>;
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
    },
    SWEEP_E2E_TIMEOUT_MS,
  );

  it(
    'B: a suppressed finding clears the scan but the audit floor keeps the run out of complete',
    async () => {
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
    },
    SWEEP_E2E_TIMEOUT_MS,
  );

  it(
    'C: fixing the code but editing the frozen config latches the eval floor, so the run cannot complete',
    async () => {
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
    },
    SWEEP_E2E_TIMEOUT_MS,
  );

  it(
    'D2: rewriting the pinned scan script between waves trips the oracle-command pin and the run cannot complete',
    async () => {
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
    },
    SWEEP_E2E_TIMEOUT_MS,
  );

  it(
    'D3: rewriting the scanner PROGRAM between waves trips the pin even though the script body is untouched',
    async () => {
      const projectRoot = scaffoldProject(base);
      const runFolder = join(base, 'program-rewrite');

      // The sibling of D2, and the one the script-body fingerprint alone cannot
      // see: `scripts.scan` still reads `node scan.mjs` byte for byte, but
      // scan.mjs itself is neutered to print an empty finding list and exit 0.
      const result = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: SWEEP_FIXTURE,
        projectRoot,
        runId: '80000000-0000-0000-0000-0000000000d3',
        goal: 'a rewritten scanner program must not launder a clean close',
        depth: 'autonomous',
        now: deterministicNow(Date.UTC(2026, 6, 7, 11, 0, 0)),
        relayer: sweepRelayer({
          projectRoot,
          behavior: (file, encounter) => {
            if (file.endsWith('gamma.ts'))
              return encounter === 1 ? 'blocked' : 'rewrite-scanner-program';
            return 'fix';
          },
        }),
      });

      expect(result.outcome).not.toBe('complete');

      const trace = (await new TraceStore(runFolder).load()) as readonly TraceRow[];
      const driftReason = trace
        .map((e) => e.reason ?? e.failure_reason ?? '')
        .find((reason) => reason.includes('oracle program "scan.mjs"'));
      expect(driftReason).toBeDefined();

      // The script body is untouched — the program fingerprint, not the body
      // fingerprint, is what caught this.
      const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      };
      expect(pkg.scripts.scan).toBe('node scan.mjs');
    },
    SWEEP_E2E_TIMEOUT_MS,
  );

  it(
    'F: deleting a censused file clears the scan over a shrunken set, and the set-identity floor blocks the close',
    async () => {
      const projectRoot = scaffoldProject(base);
      const runFolder = join(base, 'set-narrowing');

      // The scope-narrowing cheat with no tampering anywhere the other floors
      // look: the oracle command, its script body, its program, the config, and
      // the suppression count are all untouched. A worker simply deletes the file
      // its finding lives in. The scanner honestly reports zero findings and exits
      // 0 over a set two files smaller than the one the census pinned.
      //
      // Only the set-identity invariant separates that from a real fix, so the
      // rescan must fail with the censused files it can no longer account for.
      const result = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: SWEEP_FIXTURE,
        projectRoot,
        runId: '80000000-0000-0000-0000-0000000000f6',
        goal: 'deleting the finding must not count as clearing it',
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 6, 7, 11, 30, 0)),
        relayer: sweepRelayer({
          projectRoot,
          behavior: (file) => (file.endsWith('alpha.ts') ? 'delete-file' : 'fix'),
        }),
      });
      const trace = (await new TraceStore(runFolder).load()) as readonly TraceRow[];

      expect(result.outcome).not.toBe('complete');
      expect(result.outcome).toBe('stopped');

      // Both oracle commands passed. The rescan still failed, and it names the
      // file that went missing — the operator can see exactly what was narrowed.
      const rescan = JSON.parse(
        readFileSync(join(runFolder, 'reports/sweep/rescan.json'), 'utf8'),
      ) as {
        overall_status: string;
        set_covers_census: boolean;
        missing_censused_files: string[];
        reason?: string;
        commands: Array<{ command_id: string; status: string }>;
      };
      expect(rescan.commands.every((command) => command.status === 'passed')).toBe(true);
      expect(rescan.overall_status).toBe('failed');
      expect(rescan.set_covers_census).toBe(false);
      expect(rescan.missing_censused_files).toEqual(['src/alpha.ts']);
      expect(rescan.reason ?? '').toContain('src/alpha.ts');

      const judgment = untilJudgment(trace);
      expect(judgment?.disposition).toBe('needs-attention');
      expect(judgment?.evidence_confirmed).toBe(false);
    },
    SWEEP_E2E_TIMEOUT_MS,
  );

  it(
    'F2: an honest sweep still reports the census set as covered',
    async () => {
      const projectRoot = scaffoldProject(base);
      const runFolder = join(base, 'set-honest');

      // The set-identity floor must not tax the normal case: every censused file
      // is still there, fixed in place, so coverage holds and the run completes.
      const result = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: SWEEP_FIXTURE,
        projectRoot,
        runId: '80000000-0000-0000-0000-0000000000f7',
        goal: 'an honest sweep must still close clean',
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 6, 7, 12, 0, 0)),
        relayer: sweepRelayer({ projectRoot, behavior: () => 'fix' }),
      });

      expect(result.outcome).toBe('complete');
      const rescan = JSON.parse(
        readFileSync(join(runFolder, 'reports/sweep/rescan.json'), 'utf8'),
      ) as {
        overall_status: string;
        set_covers_census: boolean;
        missing_censused_files: string[];
      };
      expect(rescan.overall_status).toBe('passed');
      expect(rescan.set_covers_census).toBe(true);
      expect(rescan.missing_censused_files).toEqual([]);
    },
    SWEEP_E2E_TIMEOUT_MS,
  );

  it(
    'G: a project that declares its own scanner sweeps without any npm scripts',
    async () => {
      const projectRoot = scaffoldForeignProject(base, 'foreign-declared', {
        declareToolchain: true,
      });
      const runFolder = join(base, 'foreign-declared-run');

      // Nothing here is npm-shaped: no `scan` script, no `audit` script, no
      // tsconfig.json. The project states its toolchain in .circuit/config.yaml
      // and sweep runs on it exactly as it does on a Node repo.
      const result = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: SWEEP_FIXTURE,
        projectRoot,
        runId: '80000000-0000-0000-0000-0000000000f8',
        goal: 'a declared toolchain must sweep like any other',
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 6, 7, 12, 30, 0)),
        relayer: sweepRelayer({ projectRoot, behavior: () => 'fix' }),
      });

      expect(result.outcome).toBe('complete');

      // The pinned oracles are the declared argv, not an npm invocation, and the
      // frozen surface is the config file only the project could have named.
      const census = JSON.parse(
        readFileSync(join(runFolder, 'reports/sweep/census.json'), 'utf8'),
      ) as {
        scanner: { argv: string[] };
        suppression_audit: { argv: string[] };
        config_surface: string[];
        total_finding_count: number;
      };
      expect(census.scanner.argv).toEqual(['node', 'scan.mjs']);
      expect(census.suppression_audit.argv).toEqual(['node', 'audit.mjs']);
      expect(census.config_surface).toContain('toolchain.json');
      expect(census.total_finding_count).toBeGreaterThan(0);

      const rescan = JSON.parse(
        readFileSync(join(runFolder, 'reports/sweep/rescan.json'), 'utf8'),
      ) as { overall_status: string; commands: Array<{ argv: string[] }> };
      expect(rescan.overall_status).toBe('passed');
      expect(rescan.commands.every((command) => command.argv[0] !== 'npm')).toBe(true);
    },
    SWEEP_E2E_TIMEOUT_MS,
  );

  it(
    'H: a project that declares nothing is refused rather than swept with an inert floor',
    async () => {
      const projectRoot = scaffoldForeignProject(base, 'foreign-silent', {
        declareToolchain: false,
      });
      const runFolder = join(base, 'foreign-silent-run');

      // Without a declaration there is no scanner to resolve, so the run must
      // stop at the census. The failure that matters is not this one though: it
      // is the one that would happen if sweep ran anyway with frozen_paths
      // pointing at a tsconfig.json that does not exist, freezing nothing while
      // reporting a guarded config surface.
      const result = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: SWEEP_FIXTURE,
        projectRoot,
        runId: '80000000-0000-0000-0000-0000000000f9',
        goal: 'an undeclared toolchain must be refused',
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 6, 7, 13, 0, 0)),
        relayer: sweepRelayer({ projectRoot, behavior: () => 'fix' }),
      });

      expect(result.outcome).not.toBe('complete');
      expect(existsSync(join(runFolder, 'reports/sweep/census.json'))).toBe(false);

      // Refused for the right reason, and the message names the key that fixes
      // it rather than complaining about a package.json this project was never
      // going to fill in.
      const reason = (result as { reason?: string }).reason ?? '';
      expect(reason).toContain('verification.scan');
      expect(reason).toContain('.circuit/config.yaml');
    },
    SWEEP_E2E_TIMEOUT_MS,
  );

  it(
    'H2: declaring the commands but no config surface is refused as an inert floor',
    async () => {
      const projectRoot = scaffoldForeignProject(base, 'foreign-unfrozen', {
        declareToolchain: true,
      });
      // Same declared scanner, but the config surface line is withdrawn. Sweep
      // could now run: it has both oracles. It must still refuse, because the
      // only thing it would freeze is a tsconfig.json that is not there, and a
      // frozen path that does not exist fingerprints identically forever.
      writeFileSync(
        join(projectRoot, '.circuit', 'config.yaml'),
        [
          'verification:',
          '  scan: {argv: [node, scan.mjs]}',
          '  audit: {argv: [node, audit.mjs]}',
          '',
        ].join('\n'),
      );
      const runFolder = join(base, 'foreign-unfrozen-run');

      const result = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: SWEEP_FIXTURE,
        projectRoot,
        runId: '80000000-0000-0000-0000-0000000000fa',
        goal: 'an unguardable config surface must be refused',
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 6, 7, 13, 30, 0)),
        relayer: sweepRelayer({ projectRoot, behavior: () => 'fix' }),
      });

      expect(result.outcome).not.toBe('complete');
      const reason = (result as { reason?: string }).reason ?? '';
      expect(reason).toContain('tsconfig.json');
      expect(reason).toContain('frozen_paths');
    },
    SWEEP_E2E_TIMEOUT_MS,
  );
});
