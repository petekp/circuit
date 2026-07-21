import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { sealedMcpOptionsFromEnvironment } from '../../src/cli/circuit.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'circuit-mcp-entry-'));
  roots.push(root);
  const project = path.join(root, 'workspace');
  mkdirSync(project);
  return project;
}

function sealedEnv(projectRoot: string): NodeJS.ProcessEnv {
  return {
    CIRCUIT_RUNTIME_SOURCE: 'mcp-spike',
    CIRCUIT_MCP_SEALED: '1',
    CIRCUIT_MCP_PROJECT_ROOT: projectRoot,
    CIRCUIT_MCP_CODEX_EXECUTABLE: '/trusted/codex',
    CIRCUIT_MCP_WEB_SEARCH_MODE: 'disabled',
    CIRCUIT_MCP_PROOF_RUNNER: '/trusted/proof-runner.mjs',
    CIRCUIT_MCP_GIT_STATE_HELPER: '/trusted/git-state.js',
    CIRCUIT_MCP_CANCEL_FILE: '/trusted/runs/run-1/cancel',
    CODEX_HOME: '/trusted/codex-home',
  };
}

describe('sealed MCP plugin runtime entrypoint', () => {
  it('turns the sealed environment into an internal run option', () => {
    const projectRoot = workspace();
    expect(
      sealedMcpOptionsFromEnvironment(
        ['run', 'review', '--goal', 'Review'],
        sealedEnv(projectRoot),
        projectRoot,
      ),
    ).toEqual({ sealedMcp: { projectRoot: realpathSync(projectRoot) } });
  });

  it('does nothing for ordinary CLI runs', () => {
    const projectRoot = workspace();
    expect(sealedMcpOptionsFromEnvironment(['run', 'review'], {}, projectRoot)).toEqual({});
  });

  it('fails closed on incomplete policy, a different cwd, or a non-run command', () => {
    const projectRoot = workspace();
    const other = workspace();
    expect(() =>
      sealedMcpOptionsFromEnvironment(['run', 'review'], sealedEnv(projectRoot), other),
    ).toThrow('must match');
    expect(() =>
      sealedMcpOptionsFromEnvironment(['preview', 'review'], sealedEnv(projectRoot), projectRoot),
    ).toThrow('only permits run and resume');
    expect(() =>
      sealedMcpOptionsFromEnvironment(
        ['run', 'review'],
        { ...sealedEnv(projectRoot), CIRCUIT_MCP_CODEX_EXECUTABLE: undefined },
        projectRoot,
      ),
    ).toThrow('CIRCUIT_MCP_CODEX_EXECUTABLE');
  });
});
