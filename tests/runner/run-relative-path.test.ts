import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow, makeStubRelayer } from '../helpers/runtime-fixtures.js';

import type { ExecutorRegistry } from '../../src/runtime/executors/index.js';
import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import type { CompiledFlow } from '../../src/schemas/compiled-flow.js';
import type { RelayFn } from '../../src/shared/relay-runtime-types.js';
import { resolveRunFilePath } from '../../src/shared/run-file-paths.js';
import { resolveRunRelative } from '../../src/shared/run-relative-path.js';

const FIXTURE_PATH = resolve('generated/flows/runtime-proof/circuit.json');

function loadFixture(): { flow: CompiledFlow } {
  const raw: unknown = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
  return { flow: raw as CompiledFlow };
}

function bytesFor(flow: CompiledFlow): Buffer {
  return Buffer.from(JSON.stringify(flow));
}

function relayerWithCapture(capture: string[]): RelayFn {
  return makeStubRelayer(
    (input) => {
      capture.push(input.prompt);
      return '{"verdict":"ok"}';
    },
    { receipt_id: 'stub-receipt-run-relative' },
  );
}

function composeExecutor(): Pick<ExecutorRegistry, 'compose'> {
  return {
    compose: async (step, context) => {
      if (step.kind !== 'compose') throw new Error('expected compose step');
      const report = step.writes?.report;
      if (report !== undefined) {
        const reportPath = context.files.resolve(report);
        mkdirSync(dirname(reportPath), { recursive: true });
        writeFileSync(reportPath, '{"summary":"path containment fixture"}\n', 'utf8');
      }
      return { route: 'pass', details: { report: report?.path } };
    },
  };
}

let runFolderBase: string;

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-path-'));
});

afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
});

describe('STEP-I8 runtime run-relative path containment', () => {
  it('exposes the shared helper with the same containment checks', () => {
    const runFolder = join(runFolderBase, 'run-shared-helper');

    expect(resolveRunRelative(runFolder, 'reports/result.json')).toBe(
      join(runFolder, 'reports', 'result.json'),
    );
    expect(() => resolveRunRelative(runFolder, '../escaped.json')).toThrow(/run-relative path/i);
    expect(() => resolveRunRelative(runFolder, 'reports/./result.json')).toThrow(
      /run-relative path/i,
    );
  });

  it('rejects compose writes.report.path escape or dot segment before writing', async () => {
    const { flow } = loadFixture();
    const cases = [
      ['parent', '../escaped.json', join(runFolderBase, 'escaped.json')],
      [
        'current',
        'reports/./escaped.json',
        join(runFolderBase, 'run-current', 'reports', 'escaped.json'),
      ],
    ] as const;

    for (const [label, path, forbiddenPath] of cases) {
      const runFolder = join(runFolderBase, `run-${label}`);
      const badCompiledFlow = structuredClone(flow) as CompiledFlow;
      const first = badCompiledFlow.steps[0];
      if (first === undefined || first.kind !== 'compose') throw new Error('fixture drift');
      first.writes.report.path = path as never;

      await expect(
        runCompiledFlow({
          runDir: runFolder,
          flowBytes: bytesFor(badCompiledFlow),
          runId: '68000000-0000-0000-0000-000000000101',
          goal: `prove compose report path cannot escape: ${label}`,
          depth: 'medium',
          now: deterministicNow(Date.UTC(2026, 3, 24, 12, 0, 0)),
          relayer: relayerWithCapture([]),
          executors: composeExecutor(),
        }),
      ).rejects.toThrow(/run-(?:relative|file) path/i);

      expect(existsSync(forbiddenPath)).toBe(false);
    }
  });

  it('rejects relay reads escape before prompt composition can read outside runFolder', async () => {
    const { flow } = loadFixture();
    const runFolder = join(runFolderBase, 'run');
    const secret = join(runFolderBase, 'secret.txt');
    writeFileSync(secret, 'outside-secret');
    const prompts: string[] = [];
    const badCompiledFlow = structuredClone(flow) as CompiledFlow;
    const relay = badCompiledFlow.steps.find((step) => step.kind === 'relay');
    if (relay === undefined || relay.kind !== 'relay') throw new Error('fixture drift');
    relay.reads = ['../secret.txt' as never];

    await expect(
      runCompiledFlow({
        runDir: runFolder,
        flowBytes: bytesFor(badCompiledFlow),
        runId: '68000000-0000-0000-0000-000000000102',
        goal: 'prove relay reads cannot escape',
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 3, 24, 12, 0, 0)),
        relayer: relayerWithCapture(prompts),
        executors: composeExecutor(),
      }),
    ).rejects.toThrow(/run-relative path/i);

    expect(prompts).toEqual([]);
  });

  it('rejects relay transcript and report path escapes before writing partial files', async () => {
    const validWrites = {
      request: 'reports/relay/request.txt',
      receipt: 'reports/relay/receipt.txt',
      result: 'reports/relay/result.txt',
      report: {
        path: 'reports/relay/report.json',
        schema: 'runtime-proof-canonical@v1',
      },
    };
    const cases = [
      ['request', { ...validWrites, request: '../request.txt' }],
      ['receipt', { ...validWrites, receipt: '../receipt.txt' }],
      ['result', { ...validWrites, result: '../result.txt' }],
      ['report', { ...validWrites, report: { ...validWrites.report, path: '../report.json' } }],
      ['current', { ...validWrites, request: 'reports/./request.txt' }],
    ] as const;

    for (const [field, writes] of cases) {
      const runFolder = join(runFolderBase, `run-${field}`);
      const { flow } = loadFixture();
      const badCompiledFlow = structuredClone(flow) as CompiledFlow;
      const relay = badCompiledFlow.steps.find((step) => step.kind === 'relay');
      if (relay === undefined || relay.kind !== 'relay') throw new Error('fixture drift');
      relay.writes = writes as never;

      await expect(
        runCompiledFlow({
          runDir: runFolder,
          flowBytes: bytesFor(badCompiledFlow),
          runId: '68000000-0000-0000-0000-000000000103',
          goal: `prove relay ${field} path cannot escape`,
          depth: 'medium',
          now: deterministicNow(Date.UTC(2026, 3, 24, 12, 0, 0)),
          relayer: relayerWithCapture([]),
          executors: composeExecutor(),
        }),
      ).rejects.toThrow(/run-(?:relative|file) path/i);

      expect(existsSync(join(runFolderBase, `${field}.txt`))).toBe(false);
      expect(existsSync(join(runFolderBase, `${field}.json`))).toBe(false);
      expect(existsSync(join(runFolder, 'reports'))).toBe(false);
    }
  });

  it('rejects symlinked compose, relay read, and relay write ancestors inside runFolder', () => {
    const composeRunFolder = join(runFolderBase, 'run-symlink-compose');
    const composeOutside = join(runFolderBase, 'outside-compose');
    mkdirSync(composeRunFolder, { recursive: true });
    mkdirSync(composeOutside, { recursive: true });
    symlinkSync(composeOutside, join(composeRunFolder, 'reports'));
    expect(() => resolveRunFilePath(composeRunFolder, 'reports/escaped.json')).toThrow(/symlink/i);
    expect(existsSync(join(composeOutside, 'escaped.json'))).toBe(false);

    const readRunFolder = join(runFolderBase, 'run-symlink-read');
    const readOutside = join(runFolderBase, 'outside-read');
    mkdirSync(readRunFolder, { recursive: true });
    mkdirSync(readOutside, { recursive: true });
    symlinkSync(readOutside, join(readRunFolder, 'links'));
    writeFileSync(join(readOutside, 'secret.txt'), 'outside-secret');
    expect(() => resolveRunRelative(readRunFolder, 'links/secret.txt')).toThrow(/symlink/i);

    const writeRunFolder = join(runFolderBase, 'run-symlink-write');
    const writeOutside = join(runFolderBase, 'outside-write');
    mkdirSync(writeRunFolder, { recursive: true });
    mkdirSync(writeOutside, { recursive: true });
    symlinkSync(writeOutside, join(writeRunFolder, 'reports'));
    expect(() => resolveRunFilePath(writeRunFolder, 'reports/request.txt')).toThrow(/symlink/i);
    expect(existsSync(join(writeOutside, 'request.txt'))).toBe(false);
  });
});
