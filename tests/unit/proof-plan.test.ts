import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { gitStateCommand } from '../../src/shared/git-state-command.js';
import {
  resolveProjectRelativeProofCwd,
  runProofPlanCommand,
} from '../../src/shared/proof-plan.js';

let projectRoot: string;
let previousProofRunner: string | undefined;
let previousCancelFile: string | undefined;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'circuit-proof-plan-'));
  previousProofRunner = process.env.CIRCUIT_MCP_PROOF_RUNNER;
  previousCancelFile = process.env.CIRCUIT_MCP_CANCEL_FILE;
});

afterEach(() => {
  if (previousProofRunner === undefined) {
    Reflect.deleteProperty(process.env, 'CIRCUIT_MCP_PROOF_RUNNER');
  } else {
    process.env.CIRCUIT_MCP_PROOF_RUNNER = previousProofRunner;
  }
  if (previousCancelFile === undefined) {
    Reflect.deleteProperty(process.env, 'CIRCUIT_MCP_CANCEL_FILE');
  } else {
    process.env.CIRCUIT_MCP_CANCEL_FILE = previousCancelFile;
  }
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('proof plan boundary', () => {
  it('rejects project-relative cwd values that escape the project root', () => {
    expect(() => resolveProjectRelativeProofCwd(projectRoot, '../outside')).toThrow(
      /escapes project root/,
    );
  });

  it('preflights package-manager script commands before spawning', () => {
    writeFileSync(
      join(projectRoot, 'package.json'),
      JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
      'utf8',
    );

    expect(() =>
      runProofPlanCommand(
        {
          id: 'proof-verify',
          cwd: '.',
          argv: ['npm', 'run', 'verify'],
          timeout_ms: 1_000,
          max_output_bytes: 10_000,
          env: {},
        },
        projectRoot,
      ),
    ).toThrow(/references missing package script "verify"/);
  });

  it('runs direct argv commands through the shared proof-plan executor', () => {
    const result = runProofPlanCommand(
      {
        id: 'direct-proof',
        cwd: '.',
        argv: [process.execPath, '-e', "process.stdout.write('proof ok')"],
        timeout_ms: 5_000,
        max_output_bytes: 12,
        env: {},
      },
      projectRoot,
    );

    expect(result.status).toBe('passed');
    expect(result.stdout_summary).toBe('proof ok');
    expect(result.timed_out).toBe(false);
  });

  it('marks a command that outlives its budget as timed_out, not just failed', () => {
    const result = runProofPlanCommand(
      {
        id: 'slow-proof',
        cwd: '.',
        argv: [process.execPath, '-e', 'setTimeout(() => {}, 5000)'],
        timeout_ms: 200,
        max_output_bytes: 200,
        env: {},
      },
      projectRoot,
    );

    expect(result.status).toBe('failed');
    expect(result.timed_out).toBe(true);
  });

  it('delegates MCP proof commands to the trusted sandbox runner', () => {
    const runner = join(projectRoot, 'proof-runner.mjs');
    const cancelFile = join(projectRoot, 'cancel');
    writeFileSync(
      runner,
      [
        "let body = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { body += chunk; });",
        "process.stdin.on('end', () => {",
        '  const request = JSON.parse(body);',
        "  if (request.schema !== 'circuit.mcp-proof-request@v1') process.exit(2);",
        '  process.stdout.write(JSON.stringify({',
        "    schema: 'circuit.mcp-proof-response@v1',",
        '    observation: {',
        '      command: request.command,',
        '      exit_code: 0,',
        "      status: 'passed',",
        '      duration_ms: 1,',
        "      stdout_summary: 'sandboxed',",
        "      stderr_summary: '',",
        '      timed_out: false',
        '    },',
        '    execution: {',
        "      status: 'passed',",
        '      cleanup: { confirmed: true },',
        "      sandbox: { access: request.access, provider: 'fixture', network: 'denied', writable_roots: [request.projectRoot] }",
        '    }',
        '  }));',
        '});',
      ].join('\n'),
      'utf8',
    );
    process.env.CIRCUIT_MCP_PROOF_RUNNER = runner;
    process.env.CIRCUIT_MCP_CANCEL_FILE = cancelFile;

    const result = runProofPlanCommand(
      {
        id: 'sandboxed-proof',
        cwd: '.',
        argv: [process.execPath, '-e', 'process.exit(9)'],
        timeout_ms: 5_000,
        max_output_bytes: 1_000,
        env: {},
      },
      projectRoot,
    );

    expect(result).toMatchObject({
      status: 'passed',
      exit_code: 0,
      stdout_summary: 'sandboxed',
      timed_out: false,
    });
  });

  it('delegates fixed Build and Fix git-state commands through read-only Git access', () => {
    const runner = join(projectRoot, 'proof-runner.mjs');
    const cancelFile = join(projectRoot, 'cancel');
    writeFileSync(
      runner,
      [
        "let body = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { body += chunk; });",
        "process.stdin.on('end', () => {",
        '  const request = JSON.parse(body);',
        '  process.stdout.write(JSON.stringify({',
        "    schema: 'circuit.mcp-proof-response@v1',",
        '    observation: {',
        '      command: request.command,',
        '      exit_code: 0,',
        "      status: 'passed',",
        '      duration_ms: 1,',
        '      stdout_summary: request.access,',
        "      stderr_summary: '',",
        '      timed_out: false',
        '    },',
        '    execution: {',
        "      status: 'passed',",
        '      cleanup: { confirmed: true },',
        "      sandbox: { access: request.access, provider: 'fixture', network: 'denied', writable_roots: [request.projectRoot] }",
        '    }',
        '  }));',
        '});',
      ].join('\n'),
      'utf8',
    );
    process.env.CIRCUIT_MCP_PROOF_RUNNER = runner;
    process.env.CIRCUIT_MCP_CANCEL_FILE = cancelFile;

    const result = runProofPlanCommand(
      gitStateCommand('build-baseline-snapshot-git-state'),
      projectRoot,
    );

    expect(result).toMatchObject({
      status: 'passed',
      stdout_summary: 'git-read-only',
      mcp_execution: { access: 'git-read-only', network: 'denied' },
    });
  });
});
