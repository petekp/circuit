import { describe, expect, it } from 'vitest';

import {
  hashCanonicalWorkspace,
  validateCodexInvocationEvidence,
} from '../../scripts/release/codex-invocation-evidence.js';

const WORKSPACE = '/private/tmp/circuit fixture/review';
const expected = {
  workspaceSha256: hashCanonicalWorkspace(WORKSPACE),
  repository: 'petekp/circuit',
  candidateRef: 'c'.repeat(40),
  pluginVersion: '0.1.2',
  pluginTreeSha256: 'a'.repeat(64),
  codexVersion: '0.145.0',
  architecture: 'arm64' as const,
  macosVersion: '15.7.3',
};

function invocation(
  argv: string[] = [
    'exec',
    '--json',
    '-s',
    'workspace-write',
    '--strict-config',
    '-C',
    WORKSPACE,
    '--ephemeral',
    '-c',
    'approval_policy="never"',
    '--model',
    'gpt-5.4',
    'Use Circuit MCP. The prose may mention --add-dir without enabling it.',
  ],
): Record<string, unknown> {
  return {
    schema_version: 1,
    argv,
    workspace_sha256: expected.workspaceSha256,
    source: {
      repository: expected.repository,
      ref: expected.candidateRef,
      expected_version: expected.pluginVersion,
      plugin_tree_sha256: expected.pluginTreeSha256,
    },
    host: {
      architecture: expected.architecture,
      macos_version: expected.macosVersion,
      codex_version: expected.codexVersion,
      node_version: '22.18.0',
    },
    exit_code: 0,
    cleanup_confirmed: true,
    cleanup_intervention_required: false,
  };
}

describe('Codex release invocation evidence', () => {
  it('accepts one bounded workspace-write invocation with harmless optional flags', () => {
    expect(validateCodexInvocationEvidence(invocation(), 'Review invocation', expected)).toEqual(
      [],
    );
    expect(
      validateCodexInvocationEvidence(
        invocation([
          'exec',
          '--strict-config',
          '--cd',
          WORKSPACE,
          '--sandbox',
          'workspace-write',
          '--ephemeral',
          '--skip-git-repo-check',
          '--color',
          'never',
          '-c',
          'approval_policy="never"',
          '--json',
          'Run Circuit.',
        ]),
        'Review invocation',
        expected,
      ),
    ).toEqual([]);
  });

  it.each([
    ['network override', ['-c', 'sandbox_workspace_write.network_access=true']],
    ['write-root override', ['-c', 'sandbox_workspace_write.writable_roots=["/tmp"]']],
    ['provider override', ['-c', 'model_provider="custom"']],
    ['feature override', ['-c', 'features.apps=true']],
    ['extra root', ['--add-dir', '/tmp']],
    ['profile', ['--profile', 'unsafe']],
    ['output path', ['--output-last-message', '/tmp/result']],
    ['unknown option', ['--future-dangerous-option']],
  ])('rejects an unsafe %s', (_label, extra) => {
    const argv = invocation().argv as string[];
    argv.splice(argv.length - 1, 0, ...extra);
    expect(
      validateCodexInvocationEvidence(invocation(argv), 'Review invocation', expected),
    ).toContain('Review invocation contains an unapproved Codex option or configuration');
  });

  it('rejects duplicate or mismatched boundary settings and workspace identity', () => {
    const duplicate = invocation().argv as string[];
    duplicate.splice(duplicate.length - 1, 0, '--sandbox', 'workspace-write', '-C', WORKSPACE);
    expect(
      validateCodexInvocationEvidence(invocation(duplicate), 'Review invocation', expected),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining('exactly one workspace'),
        expect.stringContaining('exactly one workspace-write sandbox'),
      ]),
    );

    const wrong = invocation();
    wrong.workspace_sha256 = hashCanonicalWorkspace('/private/tmp/other');
    expect(validateCodexInvocationEvidence(wrong, 'Review invocation', expected)).toContain(
      'Review invocation does not match the exact fixture workspace',
    );
  });

  it('rejects a different candidate, host, failed exit, or forced cleanup', () => {
    const value = invocation();
    (value.source as Record<string, unknown>).ref = 'd'.repeat(40);
    (value.host as Record<string, unknown>).architecture = 'x64';
    value.exit_code = 1;
    value.cleanup_intervention_required = true;
    expect(validateCodexInvocationEvidence(value, 'Review invocation', expected)).toEqual(
      expect.arrayContaining([
        'Review invocation does not match the exact release candidate',
        'Review invocation does not match the recorded host',
        'Review invocation did not exit successfully with natural cleanup',
      ]),
    );
  });
});
