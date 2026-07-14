import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureStreams, deterministicNow, makeStubRelayer } from '../helpers/runtime-fixtures.js';

import type { ExecutorRegistry } from '../../src/runtime/executors/index.js';
import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import { ManifestSnapshot } from '../../src/schemas/manifest.js';
import { RunResult } from '../../src/schemas/result.js';

import type { RelayFn } from '../../src/shared/relay-runtime-types.js';

// Runner smoke test exercising one compose + one relay step
// end-to-end via the dry-run claude-code connector. The test reads the
// production runtime-proof flow fixture — the same JSON a user
// invocation of `./bin/circuit runtime-proof ...` would load — and
// composes the runtime boundary via `runCompiledFlow`.
//
// Two-run acceptance: same fixture, two different goals, two different
// result.json files with differing `goal` and `run_id` fields satisfy
// Close Criterion #4 "two different fixtures or goals ... differing
// result reports". The byte-match check is also exercised end-to-end.

const FIXTURE_PATH = resolve('generated/flows/runtime-proof/circuit.json');

function loadFixture(): { bytes: Buffer } {
  return { bytes: readFileSync(FIXTURE_PATH) };
}

// Deterministic stub relayer so the runner smoke doesn't spawn a
// real `claude` subprocess. The capability-boundary assertion at
// parseClaudeCodeStdout is a real-subprocess-only concern; the stub satisfies
// the RelayResult shape without traversing that path. The
// AGENT_SMOKE-checkd explore e2e exercises the real connector end-to-end.
//
// The stub uses the structured `RelayFn` descriptor shape and binds
// `connectorName: 'claude-code'` so the runner's `relay.started` trace_entry
// records the agent identity for this smoke suite; the dedicated
// codex-routing regression test at
// `runner-relay-connector-identity.test.ts` exercises the
// `connectorName: 'codex'` branch.
function stubRelayer(): RelayFn {
  return makeStubRelayer('{"verdict":"ok"}', { receipt_id: 'stub-receipt-runtime-proof' });
}

function composeExecutor(): Pick<ExecutorRegistry, 'compose'> {
  return {
    compose: async (step, context) => {
      if (step.kind !== 'compose') throw new Error('expected compose step');
      const attempt = { attempt: context.activeStepAttempt ?? 1 };
      const report = step.writes?.report;
      if (report !== undefined) {
        const reportPath = context.files.resolve(report);
        mkdirSync(dirname(reportPath), { recursive: true });
        writeFileSync(reportPath, '{"summary":"runtime smoke fixture"}\n', 'utf8');
        await context.trace.append({
          run_id: context.runId,
          kind: 'step.report_written',
          step_id: step.id,
          ...attempt,
          report_path: report.path,
          report_schema: report.schema ?? 'runtime.compose',
        });
      }
      await context.trace.append({
        run_id: context.runId,
        kind: 'check.evaluated',
        step_id: step.id,
        ...attempt,
        check_kind: 'schema_sections',
        outcome: 'pass',
      });
      return { route: 'pass', details: { report: report?.path } };
    },
  };
}

async function readTrace(runFolder: string) {
  return await new TraceStore(runFolder).load();
}

let runFolderBase: string;

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-runtime-smoke-'));
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
});

describe('runtime-proof runner smoke', () => {
  it('closes one run producing trace.ndjson / manifest.snapshot.json / reports/result.json', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'run-a');
    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '11111111-1111-1111-1111-111111111111',
      goal: 'prove circuit can close one run',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 3, 20, 12, 0, 0)),
      relayer: stubRelayer(),
      executors: composeExecutor(),
    });

    expect(outcome.outcome).toBe('complete');
    expect(existsSync(join(runFolder, 'trace.ndjson'))).toBe(true);
    expect(existsSync(join(runFolder, 'manifest.snapshot.json'))).toBe(true);
    expect(existsSync(join(runFolder, 'reports', 'result.json'))).toBe(true);

    // TraceStore reconstructs the NDJSON log cleanly; last trace_entry is
    // run.closed; bootstrap is first.
    const log = await readTrace(runFolder);
    expect(log).toHaveLength(outcome.trace_entries_observed);
    const first = log[0];
    const last = log[log.length - 1];
    if (first === undefined || first.kind !== 'run.bootstrapped') {
      throw new Error('expected run.bootstrapped first');
    }
    if (last === undefined || last.kind !== 'run.closed') {
      throw new Error('expected run.closed last');
    }

    // ManifestSnapshot parses and its hash equals the run's manifest_hash.
    const manifest = ManifestSnapshot.parse(
      JSON.parse(readFileSync(join(runFolder, 'manifest.snapshot.json'), 'utf8')),
    );
    expect(manifest.hash).toBe(outcome.manifest_hash);
    expect(manifest.algorithm).toBe('sha256-raw');

    // result.json parses as RunResult with the expected bindings.
    const result = RunResult.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports', 'result.json'), 'utf8')),
    );
    expect(result.run_id).toBe(outcome.run_id);
    expect(result.flow_id).toBe('runtime-proof');
    expect(result.goal).toBe('prove circuit can close one run');
    expect(result.outcome).toBe('complete');
    expect(result.trace_entries_observed).toBe(log.length);
  });

  it('exercises compose + relay + check trace_entry kinds via the injected-stub relayer', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(runFolderBase, 'run-kinds');
    await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '22222222-2222-2222-2222-222222222222',
      goal: 'exercise the broader trace_entry-kind subset',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 3, 20, 13, 0, 0)),
      relayer: stubRelayer(),
      executors: composeExecutor(),
    });

    const trace = await readTrace(runFolder);
    const kinds = new Set(trace.map((e) => e.kind));
    // Closure criterion: a broader trace_entry-kind subset is exercised. The
    // relay trail is the five-trace_entry transcript; all five kinds must
    // appear.
    expect(kinds.has('run.bootstrapped')).toBe(true);
    expect(kinds.has('step.entered')).toBe(true);
    expect(kinds.has('step.report_written')).toBe(true);
    expect(kinds.has('check.evaluated')).toBe(true);
    expect(kinds.has('relay.started')).toBe(true);
    expect(kinds.has('relay.request')).toBe(true);
    expect(kinds.has('relay.receipt')).toBe(true);
    expect(kinds.has('relay.result')).toBe(true);
    expect(kinds.has('relay.completed')).toBe(true);
    expect(kinds.has('step.completed')).toBe(true);
    expect(kinds.has('run.closed')).toBe(true);
    expect(kinds.size).toBeGreaterThanOrEqual(11);

    // The relay.started trace_entry carries the dry-run claude-code connector.
    const relayStarted = trace.find((e) => e.kind === 'relay.started');
    if (!relayStarted || relayStarted.kind !== 'relay.started') {
      throw new Error('expected relay.started trace_entry');
    }
    expect(relayStarted).toMatchObject({
      connector: { kind: 'builtin', name: 'claude-code' },
    });
    // `resolved_from` is derived from the runner's actual decision path
    // (see the runtime relay resolver): the test injects a stub relayer,
    // so the honest claim is `source: 'explicit'`.
    expect(relayStarted).toMatchObject({
      resolved_from: { source: 'explicit' },
    });
    // `resolved_selection` is derived from `flow.default_selection`
    // + `step.selection` (right-biased per SEL precedence). The
    // runtime-proof fixture and the explore fixture both use empty
    // default selections at v0, so the canonical empty selection is
    // the honest claim — and it is genuinely empty, not fabricated.
    expect(relayStarted).toMatchObject({
      resolved_selection: { skills: [], invocation_options: {} },
    });

    // run.closed is single and last.
    const closedTraceEntries = trace.filter((e) => e.kind === 'run.closed');
    expect(closedTraceEntries).toHaveLength(1);
    expect(trace[trace.length - 1]?.kind).toBe('run.closed');
  });

  it('produces DIFFERING result.json reports from two runs with different goals (Close Criterion #4)', async () => {
    const { bytes } = loadFixture();
    const runAFolder = join(runFolderBase, 'run-a');
    const runBFolder = join(runFolderBase, 'run-b');

    const runA = await runCompiledFlow({
      runDir: runAFolder,
      flowBytes: bytes,
      runId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      goal: 'prove circuit can close one run',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 3, 20, 12, 0, 0)),
      relayer: stubRelayer(),
      executors: composeExecutor(),
    });
    const runB = await runCompiledFlow({
      runDir: runBFolder,
      flowBytes: bytes,
      runId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      goal: 'prove circuit can close a SECOND run with a different goal',
      depth: 'medium',
      now: deterministicNow(Date.UTC(2026, 3, 20, 13, 0, 0)),
      relayer: stubRelayer(),
      executors: composeExecutor(),
    });

    const resultA = readFileSync(join(runAFolder, 'reports', 'result.json'), 'utf8');
    const resultB = readFileSync(join(runBFolder, 'reports', 'result.json'), 'utf8');
    expect(resultA).not.toBe(resultB);
    expect(runA.run_id).not.toBe(runB.run_id);
    expect(runA.goal).not.toBe(runB.goal);
    expect(runA.summary).toBe(runB.summary);
    // Same flow fixture ⇒ same manifest hash; this is the byte-match
    // property, not a freshness failure.
    expect(runA.manifest_hash).toBe(runB.manifest_hash);
  });

  it.skipIf(process.env.CLI_SMOKE !== '1')(
    'CLI entrypoint loads the fixture and closes a run end-to-end from a clean run-folder (CLI_SMOKE=1)',
    async () => {
      // The CLI's exported `main(argv)` function is the same entrypoint
      // the launcher invokes, so importing it directly exercises every
      // code path the subprocess version would (argv parsing, fixture
      // load, schema parse, runCompiledFlow composition, JSON
      // serialization to stdout) without depending on the IPC pipe
      // directory. The launcher binding is separately pinned by the
      // package.json
      // contract test below so the binary path remains covered.
      //
      // The launcher binding compiles JS — `dist/cli/circuit.js`. The
      // direct `main()` import strategy this test uses is unchanged —
      // `main()` is the same entrypoint the binding converges on.
      //
      // `main()` invokes the real `relayClaudeCode` default (which spawns
      // an authenticated `claude` CLI subprocess). That default fails
      // in sandboxed agent environments where the `claude` CLI is
      // unauthenticated, making the test non-portable across
      // operator-local and sandboxed environments. Env-checkd under
      // CLI_SMOKE=1 (same pattern as AGENT_SMOKE / CODEX_SMOKE) so the
      // default `npm run verify` path does not depend on a live CLI.
      // Operator-local full coverage via `CLI_SMOKE=1 npm run verify`.
      // The env-check IS the subprocess-boundary contract.
      const runFolder = join(runFolderBase, 'cli-run');
      const { main } = await import('../../src/cli/circuit.js');
      const { result: exit, stdout: captured } = await captureStreams(() =>
        main(['runtime-proof', '--goal', 'smoke via CLI', '--run-folder', runFolder], {
          configHomeDir: join(runFolderBase, 'empty-home'),
          configCwd: join(runFolderBase, 'empty-cwd'),
        }),
      );
      expect(exit).toBe(0);
      const parsed: unknown = JSON.parse(captured);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('CLI output was not a JSON object');
      }
      const obj = parsed as Record<string, unknown>;
      expect(obj.outcome).toBe('complete');
      expect(obj.run_folder).toBe(runFolder);
      expect(existsSync(join(runFolder, 'reports', 'result.json'))).toBe(true);

      const result = RunResult.parse(
        JSON.parse(readFileSync(join(runFolder, 'reports', 'result.json'), 'utf8')),
      );
      expect(result.goal).toBe('smoke via CLI');
    },
    15000,
  );

  // CLI binding pin. This contract test pins the launcher binding
  // statically without spawning a subprocess.
  //
  // Direct-launcher cleanup: the public test path now goes through
  // ./bin/circuit, which invokes dist/cli/circuit.js directly
  // instead of surfacing npm-script or runtime-proof.js names to plugin users.
  it("package.json's circuit:run script delegates to the direct Circuit launcher", () => {
    const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
      bin?: Record<string, string>;
    };
    expect(pkg.scripts?.['circuit:run']).toBe('./bin/circuit');
    // npm normalizes bin targets to the ./-less form at publish (and warns,
    // confusingly, that the entry "was invalid and removed" when it has to);
    // package.json carries the normalized form so publishes are warning-free.
    expect(pkg.bin?.circuit).toBe('bin/circuit');
  });
});
