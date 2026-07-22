import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const REPO_ROOT = resolve('.');
const ACCEPTANCE_PATH = resolve(REPO_ROOT, 'docs/contracts/host-adapter-acceptance.md');
const HOST_ADAPTER_PATH = resolve(REPO_ROOT, 'docs/contracts/host-adapter.md');

type MatrixRow = {
  readonly capability: string;
  readonly claudeCode: string;
  readonly codex: string;
};

type CoverageRow = {
  readonly capability: string;
  readonly host: string;
  readonly coverage: string;
};

type Workflow = {
  readonly concurrency?: {
    readonly group?: string;
    readonly 'cancel-in-progress'?: boolean;
  };
  readonly permissions?: Record<string, string>;
  readonly jobs: Record<
    string,
    {
      readonly concurrency?: {
        readonly group?: string;
        readonly 'cancel-in-progress'?: boolean;
      };
      readonly if?: string;
      readonly name?: string;
      readonly needs?: string | ReadonlyArray<string>;
      readonly permissions?: Record<string, string>;
      readonly steps?: ReadonlyArray<{
        readonly env?: Record<string, string>;
        readonly id?: string;
        readonly if?: string;
        readonly name?: string;
        readonly run?: string;
        readonly uses?: string;
        readonly with?: Record<string, unknown>;
      }>;
    }
  >;
};

function tableRowsAfterHeading(markdown: string, heading: string): string[] {
  const start = markdown.indexOf(`## ${heading}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = markdown.slice(start);
  const nextHeading = rest.indexOf('\n## ', 1);
  const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  return section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && !/^\|\s*-/.test(line));
}

function cells(line: string, options: { readonly stripCodeTicks?: boolean } = {}): string[] {
  const stripCodeTicks = options.stripCodeTicks ?? true;
  const parsed = line
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim());
  return stripCodeTicks ? parsed.map((cell) => cell.replace(/`/g, '')) : parsed;
}

function capabilityMatrix(markdown: string): MatrixRow[] {
  const rows = tableRowsAfterHeading(markdown, 'Capability Matrix').slice(1);
  return rows.map((row) => {
    const [capability, claudeCode, codex] = cells(row);
    return {
      capability: capability ?? '',
      claudeCode: claudeCode ?? '',
      codex: codex ?? '',
    };
  });
}

function coverageMap(markdown: string): CoverageRow[] {
  const rows = tableRowsAfterHeading(markdown, 'Coverage Map').slice(1);
  return rows.map((row) => {
    const [capability, host, coverage] = cells(row, { stripCodeTicks: false });
    return {
      capability: capability ?? '',
      host: host ?? '',
      coverage: coverage ?? '',
    };
  });
}

function codeSpans(value: string): string[] {
  return [...value.matchAll(/`([^`]+)`/g)].map((match) => match[1]).filter(Boolean) as string[];
}

function patternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}

function filesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  const entries = readdirSync(root, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    if (entry.isFile()) return [path];
    return [];
  });
}

function coveragePathExists(pattern: string): boolean {
  const normalized = pattern.replace(/\\/g, '/');
  if (!normalized.includes('*')) return existsSync(resolve(REPO_ROOT, normalized));

  const firstWildcard = normalized.indexOf('*');
  const searchRoot = resolve(REPO_ROOT, dirname(normalized.slice(0, firstWildcard)));
  const matcher = patternToRegex(normalized);
  return filesUnder(searchRoot).some((path) => {
    const rel = relative(REPO_ROOT, path).replace(/\\/g, '/');
    return matcher.test(rel);
  });
}

describe('host adapter acceptance contract', () => {
  it('defines the support states and is linked from the host adapter contract', () => {
    const doc = readFileSync(ACCEPTANCE_PATH, 'utf8');
    const hostAdapter = readFileSync(HOST_ADAPTER_PATH, 'utf8');

    expect(doc).toContain('contract: host-adapter-acceptance');
    for (const state of ['supported', 'experimental', 'unsupported', 'not-applicable']) {
      expect(doc).toContain(`\`${state}\``);
    }
    expect(hostAdapter).toContain('docs/contracts/host-adapter-acceptance.md');
  });

  it('requires every supported host capability to name deterministic coverage', () => {
    const doc = readFileSync(ACCEPTANCE_PATH, 'utf8');
    const matrix = capabilityMatrix(doc);
    const coverage = coverageMap(doc);

    expect(matrix.length).toBeGreaterThan(0);
    expect(coverage.length).toBeGreaterThan(0);

    const supported = matrix.flatMap((row) => [
      { capability: row.capability, host: 'Claude Code', state: row.claudeCode },
      { capability: row.capability, host: 'Codex', state: row.codex },
    ]);

    for (const claim of supported.filter((entry) => entry.state === 'supported')) {
      const matchingCoverage = coverage.filter(
        (entry) => entry.capability === claim.capability && entry.host === claim.host,
      );
      expect(matchingCoverage.length).toBeGreaterThan(0);

      for (const entry of matchingCoverage) {
        const paths = codeSpans(entry.coverage);
        expect(paths.length).toBeGreaterThan(0);
        for (const path of paths) {
          expect(path).toMatch(/^tests\//);
          expect(coveragePathExists(path)).toBe(true);
        }
      }
    }
  });

  it('keeps Claude Code and Codex hook registration claims aligned with packaged files', () => {
    const acceptance = readFileSync(ACCEPTANCE_PATH, 'utf8');
    const claudeManifest = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'plugins/claude/.claude-plugin/plugin.json'), 'utf8'),
    ) as { hooks?: string };
    const claudeHooks = readFileSync(resolve(REPO_ROOT, 'plugins/claude/hooks/hooks.json'), 'utf8');
    const claudeHookScript = readFileSync(
      resolve(REPO_ROOT, 'plugins/claude/hooks/session-start.ts'),
      'utf8',
    );
    const codexManifest = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'plugins/codex/.codex-plugin/plugin.json'), 'utf8'),
    ) as { hooks?: string };

    expect(acceptance).toContain('| bundled SessionStart registration | supported | unsupported |');
    expect(acceptance).toContain(
      '| user-level SessionStart registration | not-applicable | supported |',
    );

    expect(claudeManifest).not.toHaveProperty('hooks');
    expect(claudeHooks).toContain('SessionStart');
    expect(claudeHooks).toContain('${CLAUDE_PLUGIN_ROOT}/hooks/session-start.js');
    expect(claudeHookScript).toContain('scripts/circuit.ts');

    expect(codexManifest).not.toHaveProperty('hooks');
    expect(existsSync(resolve(REPO_ROOT, 'plugins/codex/hooks/hooks.json'))).toBe(false);
    expect(existsSync(resolve(REPO_ROOT, 'plugins/codex/hooks/session-start.ts'))).toBe(true);
  });

  it('keeps paid host work outside verify and runs no-spend Codex checks in CI', () => {
    const packageJson = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const codexSmoke = readFileSync(
      resolve(REPO_ROOT, 'scripts/hosts/smoke/codex-handoff.ts'),
      'utf8',
    );
    const claudeSmoke = readFileSync(
      resolve(REPO_ROOT, 'scripts/hosts/smoke/claude-handoff.ts'),
      'utf8',
    );
    const codexMcpSmoke = readFileSync(
      resolve(REPO_ROOT, 'scripts/hosts/smoke/codex-mcp.ts'),
      'utf8',
    );

    expect(packageJson.scripts['smoke:host:codex']).toBe(
      'node scripts/hosts/smoke/codex-handoff.ts',
    );
    expect(packageJson.scripts['smoke:host:claude']).toBe(
      'node scripts/hosts/smoke/claude-handoff.ts',
    );
    expect(packageJson.scripts['smoke:host:codex:mcp']).toBe(
      'node scripts/hosts/smoke/codex-mcp.ts',
    );
    expect(packageJson.scripts.verify).not.toContain('smoke:host');

    for (const smoke of [codexSmoke, claudeSmoke]) {
      expect(smoke).toMatch(/finish\(\s*'pass'/);
      expect(smoke).toMatch(/finish\(\s*'fail'/);
      expect(smoke).toMatch(/finish\(\s*'skip'/);
      expect(smoke).toContain('mkdtempSync');
    }
    expect(codexSmoke).toContain('--use-real-user-hooks');
    expect(codexSmoke).toContain('restore(hooksPath, originalHooks)');
    expect(codexMcpSmoke).toContain('--live');
    expect(codexMcpSmoke).toContain('tool_search_call');
    expect(codexMcpSmoke).toContain('circuit_list');
    expect(codexMcpSmoke).toContain('seedWorkspaceSentinel');
    expect(codexMcpSmoke).toContain("name: 'exact_workspace_identity'");
    expect(codexMcpSmoke).toContain("name: 'owned_process_cleanup'");
    expect(codexMcpSmoke).toContain("resolve(REPO_ROOT, '.mcp-host-tests')");
    expect(codexMcpSmoke).not.toContain('tmpdir()');
    expect(codexMcpSmoke).toContain('rmSync(root, { recursive: true, force: true })');

    const verifyWorkflow = readFileSync(resolve(REPO_ROOT, '.github/workflows/verify.yml'), 'utf8');
    expect(verifyWorkflow).toContain('macos-15');
    expect(verifyWorkflow).toContain('macos-15-intel');
    expect(verifyWorkflow).toContain('@openai/codex@${{ matrix.codex }}');
    expect(verifyWorkflow).toContain('host-sandbox-canary-live.test.ts');
    expect(verifyWorkflow).toContain('smoke:host:codex:mcp');
    expect(verifyWorkflow).toContain('retention-days: 14');
    const verifyConfig = YAML.parse(verifyWorkflow) as Workflow;
    expect(verifyConfig.permissions).toEqual({ contents: 'read' });
    const baselineCheckout = verifyConfig.jobs.verify?.steps?.find(
      (step) => step.uses === 'actions/checkout@v5',
    );
    expect(baselineCheckout?.with?.['fetch-depth']).toBe(0);
    for (const job of Object.values(verifyConfig.jobs)) {
      const checkout = job.steps?.find((step) => step.uses === 'actions/checkout@v5');
      if (checkout !== undefined) {
        expect(checkout.with?.['persist-credentials']).toBe(false);
      }
    }
    assertPinnedOldNodeLoaderProof(verifyConfig, 'codex-mcp');
    assertExactCodexVersionProof(verifyConfig, 'codex-mcp', '${{ matrix.codex }}');
    const codexReliability = verifyConfig.jobs['codex-reliability'];
    expect(codexReliability?.name).toBe('Codex reliability');
    expect(codexReliability?.if).toBe('${{ always() }}');
    expect(codexReliability?.needs).toEqual(['codex-versions', 'codex-mcp']);
    expect(codexReliability?.steps?.[0]?.env).toEqual({
      CODEX_MCP_RESULT: '${{ needs.codex-mcp.result }}',
      CODEX_VERSIONS_RESULT: '${{ needs.codex-versions.result }}',
    });
    expect(codexReliability?.steps?.[0]?.run).toContain('test "$CODEX_MCP_RESULT" = success');

    const compatibilityWorkflow = readFileSync(
      resolve(REPO_ROOT, '.github/workflows/codex-compatibility.yml'),
      'utf8',
    );
    expect(compatibilityWorkflow).toContain('cron:');
    expect(compatibilityWorkflow).toContain('npm view @openai/codex version');
    expect(compatibilityWorkflow).toContain('npm view @openai/codex version --json');
    expect(compatibilityWorkflow).toContain('/^\\\\d+\\\\.\\\\d+\\\\.\\\\d+$/');
    expect(compatibilityWorkflow).not.toContain('npm view @openai/codex version 2>&1 | tee');
    expect(compatibilityWorkflow).toContain('--mode packed');
    expect(compatibilityWorkflow).toContain('--mode published');
    expect(compatibilityWorkflow).toContain('isRetryablePublishedSmokeOutcome');
    expect(compatibilityWorkflow).toContain('public-tag-attempt-1.json');
    expect(compatibilityWorkflow).toContain('retention-days: 30');
    expect(compatibilityWorkflow).toContain('Codex compatibility failure');
    expect(compatibilityWorkflow).toContain("state: 'all'");
    expect(compatibilityWorkflow).toContain("state_reason: 'completed'");
    expect(compatibilityWorkflow).toContain("state: 'open'");
    expect(compatibilityWorkflow).toContain('gh pr list');
    expect(compatibilityWorkflow).toContain('git ls-remote --exit-code --heads origin');
    expect(compatibilityWorkflow).not.toContain('git push --force');
    const compatibilityConfig = YAML.parse(compatibilityWorkflow) as Workflow;
    expect(compatibilityConfig.permissions).toEqual({ contents: 'read' });
    // A newer passing run must cancel an older failing run before that older
    // run can publish stale issue state after the newer result.
    expect(compatibilityConfig.concurrency).toEqual({
      group: 'codex-compatibility-${{ github.repository }}-${{ github.ref }}',
      'cancel-in-progress': true,
    });
    expect(compatibilityConfig.jobs['compatibility-issue']?.permissions).toEqual({
      actions: 'read',
      contents: 'read',
      issues: 'write',
    });
    const compatibilityIssueJob = compatibilityConfig.jobs['compatibility-issue'];
    expect(compatibilityIssueJob?.if).toBe("${{ always() && github.ref == 'refs/heads/main' }}");
    expect(compatibilityIssueJob?.concurrency).toEqual({
      group: 'codex-compatibility-issue-${{ github.repository }}',
      'cancel-in-progress': false,
    });
    const compatibilityIssueStep = compatibilityIssueJob?.steps?.find(
      (step) => step.name === 'Open or update the compatibility issue',
    );
    expect(compatibilityIssueStep?.env).toMatchObject({
      CURRENT_RUN_NUMBER: '${{ github.run_number }}',
    });
    const compatibilityIssueScript = String(compatibilityIssueStep?.with?.script ?? '');
    expect(compatibilityIssueScript).toContain("workflow_id: 'codex-compatibility.yml'");
    expect(compatibilityIssueScript).toContain("branch: 'main'");
    expect(compatibilityIssueScript).toContain("status: 'completed'");
    expect(compatibilityIssueScript).toContain("new Set(['success', 'failure'])");
    expect(compatibilityIssueScript).toMatch(
      /run\.run_number > currentRunNumber\s+&&\s+actionableConclusions\.has\(run\.conclusion \?\? ''\)/,
    );
    expect(compatibilityIssueScript).toMatch(/run\.run_number > currentRunNumber/);
    expect(compatibilityIssueScript).toContain('circuit-codex-compatibility-run:');
    expect(compatibilityIssueScript).toMatch(/existingRunNumber > currentRunNumber/);
    expect(compatibilityIssueScript).toContain('body: recoveredBody');
    const updateLatestProven = compatibilityConfig.jobs['update-latest-proven'];
    expect(updateLatestProven?.if).toBe(
      "${{ github.ref == 'refs/heads/main' && needs.compatibility.result == 'success' }}",
    );
    expect(updateLatestProven?.permissions).toEqual({
      contents: 'write',
      'pull-requests': 'write',
    });
    const automationCheckout = updateLatestProven?.steps?.find(
      (step) => step.uses === 'actions/checkout@v5',
    );
    expect(automationCheckout?.with).toMatchObject({
      ref: 'main',
      'fetch-depth': 0,
    });
    expect(compatibilityWorkflow).toContain('group: codex-latest-proven');
    expect(compatibilityWorkflow).toContain('cancel-in-progress: false');
    expect(
      compatibilityWorkflow.indexOf('git fetch origin "$branch:refs/remotes/origin/$branch"'),
    ).toBeLessThan(compatibilityWorkflow.indexOf('if [ -n "$existing_pr" ]'));
    const resolvedEvidence = compatibilityConfig.jobs.resolve?.steps?.find(
      (step) => step.uses === 'actions/upload-artifact@v4',
    );
    expect(resolvedEvidence?.if).toBe('${{ always() }}');
    for (const jobName of ['resolve', 'compatibility']) {
      const checkout = compatibilityConfig.jobs[jobName]?.steps?.find(
        (step) => step.uses === 'actions/checkout@v5',
      );
      expect(checkout?.with?.['persist-credentials']).toBe(false);
    }
    assertPinnedOldNodeLoaderProof(compatibilityConfig, 'compatibility');
    assertExactCodexVersionProof(
      compatibilityConfig,
      'compatibility',
      '${{ needs.resolve.outputs.stable }}',
    );
  });
});

function assertExactCodexVersionProof(
  workflow: Workflow,
  jobName: string,
  expectedVersion: string,
): void {
  const step = workflow.jobs[jobName]?.steps?.find(
    (candidate) => candidate.name === 'Verify exact installed Codex version',
  );
  expect(step?.env).toEqual({ EXPECTED_CODEX_VERSION: expectedVersion });
  expect(step?.run).toContain('codex --version');
  expect(step?.run).toContain('actual_version');
  expect(step?.run).toContain('"$actual_version" != "$EXPECTED_CODEX_VERSION"');
}

function assertPinnedOldNodeLoaderProof(workflow: Workflow, jobName: string): void {
  const steps = workflow.jobs[jobName]?.steps ?? [];
  const npmCiIndex = steps.findIndex((step) => step.run === 'npm ci');
  const oldNodeIndex = steps.findIndex(
    (step) => step.uses === 'actions/setup-node@v6' && step.with?.['node-version'] === '22.17.1',
  );
  const captureIndex = steps.findIndex((step) => step.id === 'old-node-runtime');
  const restoredNodeIndex = steps.findIndex(
    (step, index) =>
      index > oldNodeIndex &&
      step.uses === 'actions/setup-node@v6' &&
      step.with?.['node-version'] === '22.18.0',
  );
  const proofIndex = steps.findIndex(
    (step) => step.name === 'Prove old Node has one clear loader remedy',
  );

  expect(npmCiIndex).toBeGreaterThanOrEqual(0);
  expect(oldNodeIndex).toBeGreaterThan(npmCiIndex);
  expect(captureIndex).toBeGreaterThan(oldNodeIndex);
  expect(steps[captureIndex]?.run).toContain('test "$(node --version)" = \'v22.17.1\'');
  expect(restoredNodeIndex).toBeGreaterThan(captureIndex);
  expect(proofIndex).toBeGreaterThan(restoredNodeIndex);
  expect(steps[proofIndex]?.env).toMatchObject({
    CIRCUIT_MCP_LIVE_OLD_NODE: '1',
    CIRCUIT_MCP_OLD_NODE_BIN: '${{ steps.old-node-runtime.outputs.bin }}',
  });
}
