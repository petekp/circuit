#!/usr/bin/env node

/**
 * Live producer for proof:codex-mcp-first-run (REL-014).
 *
 * Runs the first-attempt MCP Review through real headless Codex against the
 * exact release-candidate commit and writes evidence.json plus the four
 * digest-bound Review artifacts under docs/release/proofs/runs/
 * codex-mcp-first-run/. The bundle is validated with the same validator the
 * release checker runs before anything lands in docs/.
 *
 * Headless approval substitute, recorded openly in the evidence: the operator
 * pre-approves exactly one tool (mcp__circuit__circuit_start) through a Codex
 * permission hook trusted inside the isolated bench CODEX_HOME. The sandbox
 * stays workspace-write and the approval policy stays never; no escalation.
 *
 * Requires: macOS, codex >= 0.146.0 reachable on PATH (or --codex-dir), a
 * signed-in auth.json, network access for the marketplace install, and built
 * dist/ output (the npm script builds first). This run spends real model
 * tokens: the host model plus one nested Review relay.
 */

import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Command } from 'commander';

import { resolveCodexExecutableOnPath } from '../../src/hosts/codex-mcp/production-paths.ts';
import {
  type Evidence,
  type SmokeOutcome,
  assertSupportedSmokeVersions,
  buildMarketplaceInstallPlan,
  redactSmokeOutcome,
  runDetachedSmokeCommand,
  runLiveProbe,
} from '../hosts/smoke/codex-mcp.ts';
import { packageTreeSha256 } from '../plugins/package-tree.ts';
import {
  type FirstRunCaptureBundle,
  buildFirstRunInvocation,
  parseFirstRunHostTrace,
  renderCodexHookTrustToml,
  renderCodexHooksJson,
  renderFirstRunProofBundle,
  scanRenderedBundleForPrivateText,
} from './codex-mcp-first-run-capture.ts';
import {
  REQUIRED_EVIDENCE,
  validateCandidateGitBinding,
  validateCodexMcpFirstRunEvidence,
} from './codex-mcp-first-run-evidence.ts';
import { projectRoot } from './shared.ts';

const REPOSITORY = 'petekp/circuit';
const DEFAULT_SOURCE = 'https://github.com/petekp/circuit.git';
const DEFAULT_WORKSPACE = '/private/tmp/circuit-first-run-review';
const PROOF_ROOT = resolve(projectRoot, 'docs/release/proofs/runs/codex-mcp-first-run');
const PRIVATE_TEST_ROOT = resolve(projectRoot, '.mcp-host-tests');
const FULL_GIT_SHA = /^[a-f0-9]{40}$/;
const HOOK_MATCHER = 'mcp__circuit__circuit_start';
const ALLOW_HOOK_SCRIPT = `#!/bin/sh
cat > /dev/null
printf '%s' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
exit 0
`;
const REVIEW_PROMPT =
  'Use Circuit to review this workspace. If the Circuit tools are deferred, call tool_search ' +
  'first to load them. Then call the MCP tool circuit_start with arguments ' +
  '{"flow":"review","goal":"Review the staged README fix"}. Keep the run_id and next_cursor it ' +
  'returns. Then poll circuit_status with {"run_id": <run_id>, "after_cursor": <latest ' +
  'next_cursor>, "wait_ms": 10000}, replacing after_cursor with each response next_cursor. ' +
  'While state is starting or running you MUST call circuit_status again; never answer while ' +
  'the run is still active. Stop polling only when state is complete, then report the verdict. ' +
  'Do not run any shell command, do not edit any file, and do not call any tool other than ' +
  'tool_search, circuit_start, and circuit_status.';

interface CaptureOptions {
  readonly ref: string;
  readonly source: string;
  readonly expectedVersion: string;
  readonly codexDir?: string;
  readonly model: string;
  readonly auth: string;
  readonly loaderEvidence?: string;
  readonly timeoutMinutes: number;
  readonly keepBench: boolean;
  readonly workspace: string;
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function runSync(command: string, args: readonly string[], env?: NodeJS.ProcessEnv): string {
  const result = spawnSync(command, [...args], {
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
    ...(env === undefined ? {} : { env }),
  });
  if (result.error !== undefined || result.status !== 0) {
    const detail = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim().slice(0, 2_000);
    throw new Error(detail.length === 0 ? `${command} ${args[0] ?? ''} failed` : detail);
  }
  return result.stdout;
}

function parseOptions(argv: readonly string[]): CaptureOptions {
  const manifest = JSON.parse(
    readFileSync(resolve(projectRoot, 'plugins/version.json'), 'utf8'),
  ) as { readonly version?: unknown };
  const program = new Command('capture-codex-mcp-first-run-proof')
    .exitOverride()
    .requiredOption('--ref <sha>', 'full immutable candidate commit SHA')
    .option('--source <repository>', 'remote marketplace source', DEFAULT_SOURCE)
    .option(
      '--expected-version <version>',
      'published plugin version',
      typeof manifest.version === 'string' ? manifest.version : undefined,
    )
    .option('--codex-dir <dir>', 'directory holding the codex binary to prefer on PATH')
    .option('--model <name>', 'host model for the recorded exec run', 'gpt-5.4-mini')
    .option(
      '--auth <path>',
      'signed-in Codex auth.json to copy into the bench',
      join(homedir(), '.codex', 'auth.json'),
    )
    .option(
      '--loader-evidence <path>',
      'reuse a recorded loader smoke outcome instead of re-running it',
    )
    .option('--timeout-minutes <n>', 'review run timeout', '25')
    .option('--keep-bench', 'keep the isolated bench and workspace for inspection')
    .option(
      '--workspace <path>',
      'fixture workspace path recorded in the evidence',
      DEFAULT_WORKSPACE,
    );
  program.parse([...argv], { from: 'user' });
  const raw = program.opts<{
    ref: string;
    source: string;
    expectedVersion?: string;
    codexDir?: string;
    model: string;
    auth: string;
    loaderEvidence?: string;
    timeoutMinutes: string;
    keepBench?: boolean;
    workspace: string;
  }>();
  if (!FULL_GIT_SHA.test(raw.ref)) fail('--ref must be a full 40-character commit SHA');
  if (raw.expectedVersion === undefined) fail('--expected-version is required');
  const timeoutMinutes = Number(raw.timeoutMinutes);
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
    fail('--timeout-minutes must be a positive number');
  }
  return {
    ref: raw.ref,
    source: raw.source,
    expectedVersion: raw.expectedVersion,
    ...(raw.codexDir === undefined ? {} : { codexDir: resolve(raw.codexDir) }),
    model: raw.model,
    auth: resolve(raw.auth),
    ...(raw.loaderEvidence === undefined ? {} : { loaderEvidence: resolve(raw.loaderEvidence) }),
    timeoutMinutes,
    keepBench: raw.keepBench === true,
    workspace: resolve(raw.workspace),
  };
}

function assertLoaderEvidence(outcome: SmokeOutcome, expectedVersion: string): Evidence[] {
  if (outcome.status !== 'pass') {
    fail(`the loader smoke did not pass: ${outcome.reason}`);
  }
  for (const name of REQUIRED_EVIDENCE) {
    const matching = outcome.evidence.filter((item) => item.name === name && item.ok);
    if (matching.length !== 1) {
      fail(`loader evidence ${name} did not pass exactly once`);
    }
  }
  if (outcome.versions.plugin !== expectedVersion) {
    fail(
      `the loader smoke installed plugin ${String(outcome.versions.plugin)} but the capture expects ${expectedVersion}`,
    );
  }
  return [...outcome.evidence];
}

function seedWorkspace(workspace: string): void {
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const git = (...args: string[]): string => runSync('/usr/bin/git', ['-C', workspace, ...args]);
  runSync('/usr/bin/git', ['init', '-q', workspace]);
  git('config', 'user.name', 'Circuit Proof');
  git('config', 'user.email', 'proof@circuit.invalid');
  writeFileSync(
    join(workspace, 'README.md'),
    '# First-run fixture\n\nThs repository exists so Review has one staged change to inspect.\n',
  );
  git('add', 'README.md');
  git('commit', '-qm', 'Add the fixture README');
  writeFileSync(
    join(workspace, 'README.md'),
    '# First-run fixture\n\nThis repository exists so Review has one staged change to inspect.\n',
  );
  git('add', 'README.md');
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));

  const pluginTreeSha256 = packageTreeSha256(resolve(projectRoot, 'plugins/codex'));
  const bindingIssues = validateCandidateGitBinding({
    repoRoot: projectRoot,
    candidateRef: options.ref,
    headRef: 'HEAD',
    expectedPluginTreeSha256: pluginTreeSha256,
  });
  if (bindingIssues.length > 0) {
    fail(`the candidate ref cannot back this checkout: ${bindingIssues.join('; ')}`);
  }

  if (options.codexDir !== undefined) {
    process.env.PATH = `${options.codexDir}:${process.env.PATH ?? ''}`;
  }
  const codex = resolveCodexExecutableOnPath(process.env.PATH);
  const versionOutput = runSync(codex, ['--version']);
  const codexVersion = /(\d+\.\d+\.\d+)/.exec(versionOutput)?.[1];
  if (codexVersion === undefined) fail('codex --version did not report a version');
  assertSupportedSmokeVersions(process.versions.node, codexVersion);

  const [resultModule, reviewModule] = (await Promise.all([
    import(new URL('../../dist/schemas/result.js', import.meta.url).href),
    import(new URL('../../dist/flows/review/reports.js', import.meta.url).href),
  ])) as [
    { readonly RunResult?: { readonly safeParse: (v: unknown) => { readonly success: boolean } } },
    {
      readonly ReviewResult?: { readonly safeParse: (v: unknown) => { readonly success: boolean } };
    },
  ];
  const validateRunResult = (value: unknown): boolean =>
    resultModule.RunResult?.safeParse(value).success === true;
  const validateReviewResult = (value: unknown): boolean =>
    reviewModule.ReviewResult?.safeParse(value).success === true;
  if (resultModule.RunResult === undefined || reviewModule.ReviewResult === undefined) {
    fail('built result schemas are unavailable; run npm run build first');
  }

  console.log('1/5 no-spend loader proof against the published candidate');
  let loaderOutcome: SmokeOutcome;
  if (options.loaderEvidence !== undefined) {
    loaderOutcome = JSON.parse(readFileSync(options.loaderEvidence, 'utf8')) as SmokeOutcome;
  } else {
    const raw = await runLiveProbe({
      help: false,
      live: true,
      mode: 'published',
      marketplace: 'circuit',
      source: options.source,
      ref: options.ref,
      expectedVersion: options.expectedVersion,
    });
    // The smoke redacts machine paths only when writing its output file, so
    // an in-memory outcome must be redacted the same way before its evidence
    // details are committed.
    loaderOutcome = redactSmokeOutcome(raw, [
      PRIVATE_TEST_ROOT,
      projectRoot,
      process.env.HOME ?? '',
    ]);
  }
  const loaderEvidence = assertLoaderEvidence(loaderOutcome, options.expectedVersion);
  if (loaderOutcome.versions.codex !== codexVersion) {
    fail(
      `the loader smoke ran codex ${String(loaderOutcome.versions.codex)} but the review capture would run ${codexVersion}; use one binary for both halves`,
    );
  }

  console.log('2/5 isolated bench install of the published candidate');
  mkdirSync(PRIVATE_TEST_ROOT, { recursive: true, mode: 0o700 });
  const benchRoot = mkdtempSync(join(PRIVATE_TEST_ROOT, 'first-run-'));
  const home = join(benchRoot, 'home');
  const codexHome = join(home, '.codex');
  const privateTemp = join(home, 'tmp');
  for (const directory of [home, codexHome, privateTemp]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const environment: NodeJS.ProcessEnv = {
    HOME: home,
    CODEX_HOME: codexHome,
    PATH: `${dirname(codex)}:${dirname(process.execPath)}:/usr/bin:/bin`,
    TMPDIR: privateTemp,
    LANG: 'C',
    LC_ALL: 'C',
  };
  try {
    try {
      copyFileSync(options.auth, join(codexHome, 'auth.json'));
    } catch {
      fail(`no signed-in Codex auth.json at ${options.auth}; pass --auth`);
    }
    runSync('/bin/chmod', ['600', join(codexHome, 'auth.json')]);
    for (const step of buildMarketplaceInstallPlan({
      help: false,
      live: true,
      mode: 'published',
      marketplace: 'circuit',
      source: options.source,
      ref: options.ref,
      expectedVersion: options.expectedVersion,
    })) {
      runSync(codex, step.args, environment);
    }
    const allowPath = join(codexHome, 'allow-circuit-start.sh');
    writeFileSync(allowPath, ALLOW_HOOK_SCRIPT, { mode: 0o755 });
    const hook = { matcher: HOOK_MATCHER, command: allowPath, timeoutSeconds: 10 };
    const hooksJsonPath = join(codexHome, 'hooks.json');
    writeFileSync(hooksJsonPath, renderCodexHooksJson(hook), { mode: 0o600 });
    appendFileSync(join(codexHome, 'config.toml'), renderCodexHookTrustToml(hooksJsonPath, hook));

    console.log('3/5 first-attempt MCP Review through real headless codex');
    seedWorkspace(options.workspace);
    const argv = [
      'exec',
      '--strict-config',
      '--ephemeral',
      '--json',
      '-C',
      options.workspace,
      '--sandbox',
      'workspace-write',
      '-c',
      'approval_policy="never"',
      '-c',
      'analytics.enabled=false',
      '-c',
      'check_for_update_on_startup=false',
      '-m',
      options.model,
      '--color',
      'never',
      REVIEW_PROMPT,
    ];
    const run = await runDetachedSmokeCommand(codex, argv, environment, {
      timeout_ms: options.timeoutMinutes * 60_000,
      natural_cleanup_timeout_ms: 5_000,
    });
    // Persist the raw host output before any validation so a rejected
    // attempt still leaves its trace behind for diagnosis.
    writeFileSync(join(benchRoot, 'last-exec.stdout.jsonl'), run.stdout);
    writeFileSync(join(benchRoot, 'last-exec.stderr.txt'), run.stderr);
    if (run.timed_out || run.status !== 0) {
      fail(
        `the recorded codex run did not exit cleanly (status ${String(run.status)}, timed out ${String(run.timed_out)}): ${run.stderr.slice(-2_000)}`,
      );
    }
    if (!run.cleanup_confirmed || run.cleanup_intervention_required) {
      fail('the recorded codex run did not clean up its process group naturally');
    }

    console.log('4/5 extracting and validating the Review artifacts');
    const trace = parseFirstRunHostTrace(run.stdout);
    if (trace.issues.length > 0 || trace.runId === undefined) {
      fail(`the host trace is not a completed first-attempt Review: ${trace.issues.join('; ')}`);
    }
    const runResult = trace.finalReportData as Record<string, unknown>;
    if (!validateRunResult(runResult)) {
      fail('the terminal Review report does not match the RunResult contract');
    }
    const reviewReportPath = join(
      options.workspace,
      '.circuit',
      'runs',
      trace.runId,
      'reports',
      'review-result.json',
    );
    const reviewReport = JSON.parse(readFileSync(reviewReportPath, 'utf8')) as Record<
      string,
      unknown
    >;
    if (!validateReviewResult(reviewReport)) {
      fail('the run folder Review report does not match the ReviewResult contract');
    }
    if (runResult.outcome !== 'complete' || reviewReport.verdict !== 'CLEAN') {
      fail(
        `the Review did not complete clean (outcome ${String(runResult.outcome)}, verdict ${String(reviewReport.verdict)}); inspect the run folder and re-capture`,
      );
    }

    const architecture = process.arch === 'x64' ? ('x64' as const) : ('arm64' as const);
    const macosVersion = runSync('/usr/bin/sw_vers', ['-productVersion']).trim();
    const invocation = buildFirstRunInvocation({
      argv,
      workspacePath: options.workspace,
      source: {
        repository: REPOSITORY,
        ref: options.ref,
        expected_version: options.expectedVersion,
        plugin_tree_sha256: pluginTreeSha256,
      },
      host: {
        architecture,
        macos_version: macosVersion,
        codex_version: codexVersion,
        node_version: process.versions.node,
      },
      exitCode: 0,
      cleanupConfirmed: run.cleanup_confirmed,
      cleanupInterventionRequired: run.cleanup_intervention_required,
    });
    const bundle: FirstRunCaptureBundle = {
      reason:
        'The published plugin completed a first-attempt MCP Review through real headless Codex with a workspace-write sandbox and a never-approve policy.',
      source: {
        repository: REPOSITORY,
        ref: options.ref,
        expected_version: options.expectedVersion,
      },
      versions: {
        node: process.versions.node,
        codex: codexVersion,
        plugin: options.expectedVersion,
        plugin_tree_sha256: pluginTreeSha256,
        architecture,
        macos: macosVersion,
      },
      evidence: [
        ...loaderEvidence,
        {
          name: 'headless_start_preapproved_via_trusted_permission_hook',
          ok: true,
          detail:
            'The operator pre-approved exactly one tool, mcp__circuit__circuit_start, through a Codex permission hook trusted inside the isolated bench configuration. The sandbox stayed workspace-write and the approval policy stayed never.',
        },
        {
          name: 'first_attempt_review_completed_clean',
          ok: true,
          detail: `run ${trace.runId} completed with verdict CLEAN`,
        },
      ],
      review: { run_id: trace.runId, workspacePath: options.workspace },
      artifacts: {
        runResult,
        reviewReport,
        hostTraceText: run.stdout,
        invocation,
      },
    };
    const rendered = renderFirstRunProofBundle(bundle);
    const privateFindings = scanRenderedBundleForPrivateText(rendered, [
      { label: 'the home directory', value: process.env.HOME ?? '' },
      { label: 'the bench root', value: benchRoot },
      { label: 'the private test root', value: PRIVATE_TEST_ROOT },
    ]);
    if (privateFindings.length > 0) {
      fail(`the captured bundle contains private paths: ${privateFindings.join('; ')}`);
    }

    console.log('5/5 validating and writing the proof bundle');
    const staging = join(benchRoot, 'staging');
    for (const file of rendered.files) {
      const target = join(staging, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.text);
    }
    const evidenceValue = JSON.parse(rendered.evidenceText) as unknown;
    const issues = validateCodexMcpFirstRunEvidence(evidenceValue, {
      pluginVersion: options.expectedVersion,
      pluginTreeSha256,
      repository: REPOSITORY,
      proofRoot: staging,
      validateRunResult,
      validateReviewResult,
    });
    if (issues.length > 0) {
      fail(`the captured bundle does not satisfy the release validator: ${issues.join('; ')}`);
    }
    for (const file of rendered.files) {
      const target = join(PROOF_ROOT, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.text);
    }
    console.log(`wrote ${rendered.files.length} files under ${PROOF_ROOT}`);
    console.log(
      `review run ${trace.runId} verdict CLEAN on codex ${codexVersion} (${architecture})`,
    );
    console.log(
      'next: mark proof:codex-mcp-first-run verified_current in docs/release/proofs/index.yaml, add evidence.json to required_files and the four Review artifacts to backing_paths, then run node scripts/release/check-codex-mcp-first-run-proof.ts',
    );
  } finally {
    if (options.keepBench) {
      console.log(`bench kept at ${benchRoot}`);
    } else {
      rmSync(benchRoot, { recursive: true, force: true });
      rmSync(options.workspace, { recursive: true, force: true });
    }
  }
}

await main();
