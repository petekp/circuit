#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GENERATED_FLOW_MIRROR_ROOT_ENV,
  type JsonRecord,
  MIN_NODE_VERSION,
  type RuntimeCommand,
  type RuntimeContext,
  type RuntimeResolution,
  listMarkdownFiles,
  nodeVersionSupported,
  parseProgressEvents,
  readJson,
  resolveRuntimeCommand as resolveRuntimeCommandCore,
  runtimeArgs,
  runtimeEnv as runtimeEnvCore,
  shouldInjectCreateTemplateRoot,
  shouldInjectPackagedFlowRoot,
} from './launcher-core.ts';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(scriptDir, '..');
const packagedFlowRoot = resolve(pluginRoot, 'flows');
const bundledRuntimePath = resolve(pluginRoot, 'runtime/circuit.js');
const CIRCUIT_HOST_KIND_ENV = 'CIRCUIT_HOST_KIND';
const DOCTOR_SMOKE_TIMEOUT_MS = 120_000;
const CODEX_FEATURES_TIMEOUT_MS = 5_000;
const MINIMUM_CODEX_VERSION = '0.144.3';
const MCP_LAUNCH_SCRIPT = [
  'circuit_node_error() {',
  "IFS= read -r request || request='';",
  `id=$(printf '%s\\n' "$request" | /usr/bin/sed -n 's/.*"id"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p');`,
  `case "$id" in ''|*[!0-9]*) id=0 ;; esac;`,
  'printf \'{"jsonrpc":"2.0","id":%s,"error":{"code":-32000,"message":"%s"}}\\n\' "$id" "$1";',
  'exit 1;',
  '};',
  'if ! command -v node >/dev/null 2>&1; then circuit_node_error "Circuit MCP requires Node.js 22.18 or newer. Install Node.js 22.18 or newer, ensure node is on PATH, restart Codex, and try again."; fi;',
  'node_version=$(node -p \'process.versions.node\' 2>/dev/null) || circuit_node_error "Circuit MCP could not read the Node.js version. Install Node.js 22.18 or newer, ensure node is on PATH, restart Codex, and try again.";',
  'case "$node_version" in \'\'|*[!0-9.]*) circuit_node_error "Circuit MCP could not read the Node.js version. Install Node.js 22.18 or newer, ensure node is on PATH, restart Codex, and try again." ;; esac;',
  'node_major=${node_version%%.*}; node_minor_tail=${node_version#*.}; node_minor=${node_minor_tail%%.*};',
  'if [ "$node_major" -lt 22 ] || { [ "$node_major" -eq 22 ] && [ "$node_minor" -lt 18 ]; }; then circuit_node_error "Circuit MCP requires Node.js 22.18 or newer. Current Node.js is $node_version. Install Node.js 22.18 or newer, ensure node is on PATH, restart Codex, and try again."; fi;',
  'exec node ./mcp/server.cjs',
].join(' ');
const MCP_TOOL_NAMES = [
  'circuit_start',
  'circuit_status',
  'circuit_resume',
  'circuit_cancel',
  'circuit_list',
  'circuit_recover',
] as const;
const MCP_TRANSIENT_ENVIRONMENT_NAMES = [
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOGNAME',
  'PATH',
  'SHELL',
  'TERM',
  'TMPDIR',
  'TZ',
  'USER',
  'CODEX_HOME',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_ORGANIZATION',
  'OPENAI_PROJECT',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
] as const;
const MCP_RUNTIME_FILES = [
  ['server_cjs', 'mcp/server.cjs'],
  ['server_mjs', 'mcp/server.mjs'],
  ['supervisor_mjs', 'mcp/supervisor.mjs'],
  ['worker_mjs', 'mcp/worker.mjs'],
] as const;

type CheckResult = {
  name: string;
  ok: boolean;
  detail?: unknown;
  severity?: 'warning';
};

const rawArgs = process.argv.slice(2);

// The dev-fallback bin/circuit lookup is anchored to the current working dir.
const runtimeContext: RuntimeContext = {
  pluginRoot,
  bundledRuntimePath,
  localLauncherBaseDir: process.cwd(),
};

function resolveRuntimeCommand(): RuntimeResolution {
  return resolveRuntimeCommandCore(runtimeContext);
}

function runtimeEnv(runtime: RuntimeCommand, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return runtimeEnvCore(runtime, baseEnv, pluginRoot);
}

function check(name: string, ok: boolean, detail?: unknown): CheckResult {
  return detail === undefined ? { name, ok } : { name, ok, detail };
}

function warningCheck(name: string, ok: boolean, detail?: unknown): CheckResult {
  return detail === undefined
    ? { name, ok, severity: 'warning' }
    : { name, ok, detail, severity: 'warning' };
}

function skillNameFromMarkdown(path: string): string | undefined {
  const text = readFileSync(path, 'utf8');
  const match = /^name:\s*(\S+)\s*$/m.exec(text);
  return match?.[1];
}

function codexHome(): string {
  return process.env.CODEX_HOME ?? resolve(process.env.HOME ?? '', '.codex');
}

function codexUserHooksPath(): string {
  return resolve(codexHome(), 'hooks.json');
}

function codexHooksEnabledFromConfig(): boolean {
  const home = process.env.CODEX_HOME ?? resolve(process.env.HOME ?? '', '.codex');
  const configPath = resolve(home, 'config.toml');
  if (!existsSync(configPath)) return false;
  const text = readFileSync(configPath, 'utf8');
  return /^\s*codex_hooks\s*=\s*true\s*$/m.test(text);
}

function codexHooksEnabled(): boolean {
  const result = spawnSync('codex', ['features', 'list'], {
    encoding: 'utf8',
    timeout: CODEX_FEATURES_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (
    result.error === undefined &&
    result.status === 0 &&
    /\bcodex_hooks\b[^\n]*\btrue\b/.test(result.stdout)
  ) {
    return true;
  }
  return codexHooksEnabledFromConfig();
}

function codexUserHandoffHookInstalled(): boolean {
  const hooksPath = codexUserHooksPath();
  if (!existsSync(hooksPath)) return false;
  try {
    return JSON.stringify(readJson(hooksPath)).includes('handoff hook --host codex');
  } catch {
    return false;
  }
}

function parseVersionTuple(value: string): readonly [number, number, number] | undefined {
  const match = /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(value.trim());
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionAtLeast(
  actual: readonly [number, number, number],
  minimum: readonly [number, number, number],
): boolean {
  const [actualMajor, actualMinor, actualPatch] = actual;
  const [minimumMajor, minimumMinor, minimumPatch] = minimum;
  for (const [actualPart, minimumPart] of [
    [actualMajor, minimumMajor],
    [actualMinor, minimumMinor],
    [actualPatch, minimumPatch],
  ] as const) {
    if (actualPart > minimumPart) return true;
    if (actualPart < minimumPart) return false;
  }
  return true;
}

function sameStrings(actual: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function mcpRuntimeFileIsSafe(path: string): boolean {
  try {
    const info = lstatSync(path);
    return info.isFile() && !info.isSymbolicLink() && info.size > 0;
  } catch {
    return false;
  }
}

function runDoctor(): number {
  const checks: CheckResult[] = [];
  const manifestPath = resolve(pluginRoot, '.codex-plugin/plugin.json');
  checks.push(check('plugin_manifest_exists', existsSync(manifestPath), manifestPath));

  let manifest: JsonRecord | undefined;
  try {
    manifest = existsSync(manifestPath) ? readJson<JsonRecord>(manifestPath) : undefined;
    checks.push(check('plugin_manifest_parseable', manifest !== undefined, manifestPath));
  } catch (err) {
    checks.push(
      check('plugin_manifest_parseable', false, err instanceof Error ? err.message : String(err)),
    );
  }
  checks.push(
    check(
      'plugin_manifest_shape',
      manifest?.name === 'circuit' &&
        manifest?.skills === './skills/' &&
        manifest?.hooks === undefined &&
        (manifest?.interface as JsonRecord | undefined)?.displayName === 'Circuit',
      manifestPath,
    ),
  );
  checks.push(
    check(
      'plugin_manifest_mcp_activation',
      manifest?.mcpServers === './.mcp.json',
      'The Codex plugin manifest must activate ./.mcp.json.',
    ),
  );

  const mcpConfigPath = resolve(pluginRoot, '.mcp.json');
  checks.push(check('mcp_config_exists', existsSync(mcpConfigPath), mcpConfigPath));
  let mcpConfig: JsonRecord | undefined;
  try {
    mcpConfig = existsSync(mcpConfigPath) ? readJson<JsonRecord>(mcpConfigPath) : undefined;
    checks.push(check('mcp_config_parseable', mcpConfig !== undefined, mcpConfigPath));
  } catch (error) {
    checks.push(
      check('mcp_config_parseable', false, error instanceof Error ? error.message : String(error)),
    );
  }
  const mcpServers = mcpConfig?.mcpServers;
  const mcpServer =
    typeof mcpServers === 'object' && mcpServers !== null && !Array.isArray(mcpServers)
      ? ((mcpServers as JsonRecord).circuit as JsonRecord | undefined)
      : undefined;
  checks.push(
    check(
      'mcp_config_shape',
      typeof mcpServer === 'object' &&
        mcpServer !== null &&
        !Array.isArray(mcpServer) &&
        mcpServer.command === '/bin/sh' &&
        sameStrings(mcpServer.args, ['-c', MCP_LAUNCH_SCRIPT]) &&
        mcpServer.cwd === '.' &&
        mcpServer.required === true &&
        mcpServer.startup_timeout_sec === 10 &&
        mcpServer.tool_timeout_sec === 240 &&
        mcpServer.env === undefined &&
        sameStrings(mcpServer.env_vars, MCP_TRANSIENT_ENVIRONMENT_NAMES),
      mcpConfigPath,
    ),
  );
  checks.push(
    check(
      'mcp_tool_roster',
      sameStrings(mcpServer?.enabled_tools, MCP_TOOL_NAMES),
      `expected=${MCP_TOOL_NAMES.join(',')}`,
    ),
  );
  for (const [name, relativePath] of MCP_RUNTIME_FILES) {
    const path = resolve(pluginRoot, relativePath);
    checks.push(check(`mcp_runtime_${name}`, mcpRuntimeFileIsSafe(path), path));
  }
  checks.push(
    warningCheck(
      'codex_bundled_handoff_hooks_unregistered',
      manifest?.hooks === undefined,
      'Codex bundled plugin hooks are not registered in V1; use circuit handoff hooks install --host codex',
    ),
  );

  const hooksRoot = resolve(pluginRoot, 'hooks');
  const hooksConfigPath = resolve(hooksRoot, 'hooks.json');
  const sessionStartPath = resolve(hooksRoot, 'session-start.ts');
  checks.push(
    check(
      'bundled_hooks_config_absent',
      !existsSync(hooksConfigPath),
      'Codex loads hooks/hooks.json by default; V1 uses user-level hooks instead',
    ),
  );
  checks.push(check('session_start_hook_exists', existsSync(sessionStartPath), sessionStartPath));
  checks.push(
    warningCheck(
      'codex_hooks_feature_flag_visible',
      codexHooksEnabled(),
      'Codex SessionStart hooks require codex_hooks to be enabled or stable',
    ),
  );
  checks.push(
    warningCheck(
      'codex_user_handoff_hook_installed',
      codexUserHandoffHookInstalled(),
      `Install with: circuit handoff hooks install --host codex (checks ${codexUserHooksPath()})`,
    ),
  );

  const skillsRoot = resolve(pluginRoot, 'skills');
  const skillDirs = existsSync(skillsRoot)
    ? readdirSync(skillsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    : [];
  checks.push(check('skills_directory_exists', existsSync(skillsRoot), skillsRoot));
  checks.push(check('skills_present', skillDirs.length > 0, `${skillDirs.length} skills`));
  for (const entry of skillDirs) {
    const skillPath = resolve(skillsRoot, entry.name, 'SKILL.md');
    const skillName = existsSync(skillPath) ? skillNameFromMarkdown(skillPath) : undefined;
    checks.push(
      check(
        `skill_name_${entry.name}`,
        skillName === entry.name && !/^circuit[:-]/.test(skillName ?? ''),
        skillName === undefined ? `${skillPath} missing name` : `name=${skillName}`,
      ),
    );
  }

  const wrapperPath = resolve(scriptDir, 'circuit.js');
  checks.push(check('wrapper_exists', existsSync(wrapperPath), wrapperPath));
  checks.push(check('packaged_flow_root_exists', existsSync(packagedFlowRoot), packagedFlowRoot));
  for (const flow of ['build', 'explore', 'fix', 'prototype', 'review']) {
    const flowPath = resolve(packagedFlowRoot, flow, 'circuit.json');
    checks.push(check(`packaged_flow_${flow}`, existsSync(flowPath), flowPath));
  }

  const commandsRoot = resolve(pluginRoot, 'commands');
  checks.push(check('commands_directory_exists', existsSync(commandsRoot), commandsRoot));
  for (const name of listMarkdownFiles(commandsRoot)) {
    const commandPath = resolve(commandsRoot, name);
    const text = readFileSync(commandPath, 'utf8');
    checks.push(
      check(
        `command_${name}_uses_wrapper`,
        text.includes("node '<plugin root>/scripts/circuit.js'") &&
          !text.includes('./bin/circuit') &&
          text.includes('--progress jsonl') &&
          text.includes('task_list.updated') &&
          text.includes('user_input.requested'),
        commandPath,
      ),
    );
  }

  checks.push(
    check(
      'node_version_supported',
      nodeVersionSupported(),
      `node=${process.versions.node} required>=${MIN_NODE_VERSION}`,
    ),
  );

  const codexVersionResult = spawnSync('codex', ['--version'], {
    encoding: 'utf8',
    timeout: CODEX_FEATURES_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const codexVersionText = (codexVersionResult.stdout ?? '').trim();
  const codexVersion = parseVersionTuple(codexVersionText);
  const minimumCodexVersion = parseVersionTuple(MINIMUM_CODEX_VERSION);
  if (codexVersionResult.error !== undefined || codexVersionResult.status !== 0) {
    checks.push(
      check(
        'codex_version_supported',
        false,
        `Codex was not found. Install Codex ${MINIMUM_CODEX_VERSION} or newer, restart Codex, and try again.`,
      ),
    );
  } else if (codexVersion === undefined || minimumCodexVersion === undefined) {
    checks.push(
      check(
        'codex_version_supported',
        false,
        `Codex returned an unreadable version (${JSON.stringify(codexVersionText)}). Update Codex to ${MINIMUM_CODEX_VERSION} or newer, restart Codex, and try again.`,
      ),
    );
  } else {
    const supported = versionAtLeast(codexVersion, minimumCodexVersion);
    checks.push(
      check(
        'codex_version_supported',
        supported,
        supported
          ? `codex=${codexVersion.join('.')} required>=${MINIMUM_CODEX_VERSION}`
          : `codex=${codexVersion.join('.')} required>=${MINIMUM_CODEX_VERSION}. Update Codex to ${MINIMUM_CODEX_VERSION} or newer, restart Codex, and try again.`,
      ),
    );
  }
  checks.push(check('bundled_runtime_exists', existsSync(bundledRuntimePath), bundledRuntimePath));

  const resolved = resolveRuntimeCommand();
  checks.push(
    check(
      'runtime_resolved',
      resolved.ok,
      resolved.ok ? `${resolved.runtime.source}:${resolved.runtime.path}` : resolved.message,
    ),
  );

  let runtimeVersion: JsonRecord | undefined;
  if (resolved.ok) {
    const versionResult = spawnSync(
      resolved.runtime.command,
      runtimeArgs(resolved.runtime, ['version', '--json']),
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: runtimeEnv(resolved.runtime, process.env),
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    try {
      runtimeVersion =
        versionResult.stdout.length > 0
          ? (JSON.parse(versionResult.stdout) as JsonRecord)
          : undefined;
    } catch {
      runtimeVersion = undefined;
    }
    checks.push(
      check(
        'runtime_version_executes',
        versionResult.status === 0 &&
          versionResult.error === undefined &&
          runtimeVersion?.runtime_source === resolved.runtime.source,
        `status=${versionResult.status ?? 'unknown'} source=${runtimeVersion?.runtime_source ?? 'missing'} stderr=${versionResult.stderr.slice(0, 500)}`,
      ),
    );
  }

  const smokeRoot = mkdtempSync(join(tmpdir(), 'circuit-codex-doctor-'));
  try {
    // Exercise the real built-in Codex connector without spending money. The
    // executable emits the reviewed JSONL protocol from the prompt-only relay
    // directory. A tracked marker proves Review captured the selected
    // working-tree diff before moving the connector away from the repository.
    const smokeHome = resolve(smokeRoot, 'home');
    const userConfigDir = resolve(smokeHome, '.config', 'circuit');
    const smokeBin = resolve(smokeRoot, 'bin');
    const fakeCodex = resolve(smokeBin, 'codex');
    const smokePath = `${smokeBin}${delimiter}${process.env.PATH ?? ''}`;
    const smokeProject = resolve(smokeRoot, 'project');
    const runFolder = resolve(smokeRoot, 'run');
    const reviewFile = resolve(smokeProject, 'doctor-review.txt');
    const reviewMarker = 'CIRCUIT_CODEX_DOCTOR_WORKING_TREE_MARKER';
    const promptCapture = resolve(smokeRoot, 'review-prompt.txt');
    mkdirSync(userConfigDir, { recursive: true });
    mkdirSync(smokeBin, { recursive: true });
    mkdirSync(smokeProject, { recursive: true });
    const gitSetup = [
      spawnSync('git', ['init'], { cwd: smokeProject, stdio: 'ignore' }),
      spawnSync('git', ['config', 'user.name', 'Circuit Doctor'], {
        cwd: smokeProject,
        stdio: 'ignore',
      }),
      spawnSync('git', ['config', 'user.email', 'doctor@circuit.local'], {
        cwd: smokeProject,
        stdio: 'ignore',
      }),
    ];
    writeFileSync(reviewFile, 'base review fixture\n');
    gitSetup.push(
      spawnSync('git', ['add', 'doctor-review.txt'], { cwd: smokeProject, stdio: 'ignore' }),
      spawnSync('git', ['commit', '-m', 'Create doctor review fixture'], {
        cwd: smokeProject,
        stdio: 'ignore',
      }),
    );
    writeFileSync(reviewFile, `base review fixture\n${reviewMarker}\n`);
    checks.push(
      check(
        'temp_repo_review_fixture',
        gitSetup.every((result) => result.status === 0 && result.error === undefined),
        gitSetup
          .map((result) => result.error?.message ?? `status=${result.status ?? 'unknown'}`)
          .join(', '),
      ),
    );
    writeFileSync(
      fakeCodex,
      `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.144.3\\n');
  process.exit(0);
}
const prompt = process.argv.at(-1) ?? '';
writeFileSync(${JSON.stringify(promptCapture)}, prompt);
if (!prompt.includes(${JSON.stringify(reviewMarker)})) {
  process.stderr.write('doctor marker missing from Review relay prompt\\n');
  process.exit(2);
}
// The audit step fans out one reviewer per unit, and each reviewer has to
// report under the unit id it was handed. The branch's step id carries it:
// \`audit-step-<unit id>\`.
const unitId = /Step: audit-step-([a-z0-9-]+)/u.exec(prompt)?.[1] ?? 'unit-1';
const result = { unit_id: unitId, ...${JSON.stringify({
        verdict: 'NO_ISSUES_FOUND',
        findings: [],
        assessment: 'Doctor stub reviewer: nothing actionable in the relayed evidence.',
        verification: ['Doctor stub: inspected the relayed intake report.'],
        confidence_limitations: [],
      })} };
for (const event of [
  { type: 'thread.started', thread_id: 'doctor-thread' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'doctor-item', type: 'agent_message', text: JSON.stringify(result) } },
  { type: 'turn.completed', usage: {} },
]) process.stdout.write(JSON.stringify(event) + '\\n');
`,
    );
    chmodSync(fakeCodex, 0o700);
    writeFileSync(
      resolve(userConfigDir, 'config.yaml'),
      `${JSON.stringify(
        {
          schema_version: 1,
          host: { kind: 'codex' },
          defaults: { selection: { model: { provider: 'openai', model: 'gpt-5.4' } } },
        },
        null,
        2,
      )}\n`,
    );
    if (resolved.ok) {
      const result = spawnSync(
        resolved.runtime.command,
        runtimeArgs(resolved.runtime, [
          'run',
          'review',
          '--goal',
          'review current working tree changes',
          '--flow-root',
          packagedFlowRoot,
          '--run-folder',
          runFolder,
          '--progress',
          'jsonl',
        ]),
        {
          cwd: smokeProject,
          encoding: 'utf8',
          env: runtimeEnv(resolved.runtime, {
            ...process.env,
            HOME: smokeHome,
            PATH: smokePath,
            [GENERATED_FLOW_MIRROR_ROOT_ENV]: packagedFlowRoot,
          }),
          timeout: DOCTOR_SMOKE_TIMEOUT_MS,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let output: JsonRecord | undefined;
      try {
        output = result.stdout.length > 0 ? (JSON.parse(result.stdout) as JsonRecord) : undefined;
      } catch {
        output = undefined;
      }
      let progressEvents: JsonRecord[] = [];
      try {
        progressEvents = parseProgressEvents(result.stderr);
      } catch (_err) {
        progressEvents = [];
      }
      const progressTypes = progressEvents
        .map((event) => event.type)
        .filter((type) => typeof type === 'string');
      checks.push(
        check(
          'temp_repo_review_smoke',
          result.status === 0 &&
            result.error === undefined &&
            output?.selected_flow === 'review' &&
            output?.outcome === 'complete' &&
            existsSync(resolve(runFolder, 'reports', 'review-result.json')),
          `status=${result.status ?? 'unknown'} error=${result.error?.message ?? 'none'} output=${JSON.stringify(output).slice(0, 1_000)} stderr=${result.stderr.slice(0, 500)}`,
        ),
      );
      checks.push(
        check(
          'temp_repo_review_progress',
          progressTypes.includes('route.selected') && progressTypes.includes('run.completed'),
          progressTypes.length > 0
            ? `events=${progressTypes.join(',')}`
            : `stderr=${result.stderr.slice(0, 500)}`,
        ),
      );
      checks.push(
        check(
          'temp_repo_review_progress_display',
          progressEvents.length > 0 &&
            progressEvents.every((event) => {
              const display = event.display as JsonRecord | undefined;
              return (
                typeof display?.text === 'string' &&
                display.text.length > 0 &&
                typeof display?.importance === 'string' &&
                typeof display?.tone === 'string'
              );
            }),
          progressEvents.length > 0
            ? `display_events=${progressEvents.length}`
            : `stderr=${result.stderr.slice(0, 500)}`,
        ),
      );
      checks.push(
        check(
          'temp_repo_review_operator_summary',
          typeof output?.operator_summary_markdown_path === 'string' &&
            existsSync(output.operator_summary_markdown_path),
          typeof output?.operator_summary_markdown_path === 'string'
            ? output.operator_summary_markdown_path
            : 'operator_summary_markdown_path missing',
        ),
      );
      const intakePath = resolve(runFolder, 'reports', 'review-intake.json');
      const intakeText = existsSync(intakePath) ? readFileSync(intakePath, 'utf8') : '';
      const promptText = existsSync(promptCapture) ? readFileSync(promptCapture, 'utf8') : '';
      checks.push(
        check(
          'temp_repo_review_intake_includes_marker',
          intakeText.includes(reviewMarker),
          intakeText.includes(reviewMarker)
            ? intakePath
            : `${reviewMarker} missing from ${intakePath}`,
        ),
      );
      checks.push(
        check(
          'temp_repo_review_prompt_includes_marker',
          promptText.includes(reviewMarker),
          promptText.includes(reviewMarker)
            ? promptCapture
            : `${reviewMarker} missing from ${promptCapture}`,
        ),
      );

      const checkpointRunFolder = resolve(smokeRoot, 'checkpoint-run');
      writeFileSync(
        resolve(smokeProject, 'package.json'),
        `${JSON.stringify(
          {
            private: true,
            scripts: {
              verify: 'node -e "process.exit(0)"',
            },
          },
          null,
          2,
        )}\n`,
      );
      const checkpointResult = spawnSync(
        resolved.runtime.command,
        runtimeArgs(resolved.runtime, [
          'run',
          'build',
          '--goal',
          'develop: add a focused feature that waits for framing',
          '--process',
          'high',
          '--flow-root',
          packagedFlowRoot,
          '--run-folder',
          checkpointRunFolder,
          '--progress',
          'jsonl',
        ]),
        {
          cwd: smokeProject,
          encoding: 'utf8',
          env: runtimeEnv(resolved.runtime, {
            ...process.env,
            HOME: smokeHome,
            PATH: smokePath,
            [GENERATED_FLOW_MIRROR_ROOT_ENV]: packagedFlowRoot,
          }),
          timeout: DOCTOR_SMOKE_TIMEOUT_MS,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let checkpointOutput: JsonRecord | undefined;
      try {
        checkpointOutput =
          checkpointResult.stdout.length > 0
            ? (JSON.parse(checkpointResult.stdout) as JsonRecord)
            : undefined;
      } catch {
        checkpointOutput = undefined;
      }
      let checkpointProgressEvents: JsonRecord[] = [];
      try {
        checkpointProgressEvents = parseProgressEvents(checkpointResult.stderr);
      } catch (_err) {
        checkpointProgressEvents = [];
      }
      const checkpointProgressTypes = checkpointProgressEvents
        .map((event) => event.type)
        .filter((type) => typeof type === 'string');
      checks.push(
        check(
          'temp_repo_checkpoint_user_input_requested',
          checkpointResult.status === 0 &&
            checkpointOutput?.outcome === 'checkpoint_waiting' &&
            checkpointProgressTypes.includes('checkpoint.waiting') &&
            checkpointProgressTypes.includes('user_input.requested'),
          checkpointProgressTypes.length > 0
            ? `events=${checkpointProgressTypes.join(',')}`
            : `stderr=${checkpointResult.stderr.slice(0, 500)}`,
        ),
      );
    } else {
      checks.push(check('temp_repo_review_smoke', false, resolved.message));
    }
  } finally {
    rmSync(smokeRoot, { recursive: true, force: true });
  }

  const ok = checks.every((item) => item.ok || item.severity === 'warning');
  process.stdout.write(
    `${JSON.stringify(
      {
        schema_version: 1,
        host: 'codex',
        status: ok ? 'ok' : 'fail',
        plugin_root: pluginRoot,
        flow_root: packagedFlowRoot,
        runtime_source: resolved.ok ? resolved.runtime.source : 'unresolved',
        runtime_path: resolved.ok ? resolved.runtime.path : undefined,
        runtime_version: runtimeVersion?.version,
        checks,
      },
      null,
      2,
    )}\n`,
  );
  return ok ? 0 : 1;
}

const injectPackagedFlowRoot = shouldInjectPackagedFlowRoot(rawArgs);
const forwardedArgs = injectPackagedFlowRoot
  ? [...rawArgs, '--flow-root', packagedFlowRoot]
  : shouldInjectCreateTemplateRoot(rawArgs)
    ? [...rawArgs, '--template-flow-root', packagedFlowRoot]
    : rawArgs;
const childEnv = { ...process.env };
childEnv[CIRCUIT_HOST_KIND_ENV] = 'codex';
if (injectPackagedFlowRoot) {
  childEnv[GENERATED_FLOW_MIRROR_ROOT_ENV] = packagedFlowRoot;
} else {
  delete childEnv[GENERATED_FLOW_MIRROR_ROOT_ENV];
}

if (rawArgs[0] === 'doctor') {
  process.exit(runDoctor());
}

const resolvedRuntime = resolveRuntimeCommand();

if (!nodeVersionSupported()) {
  process.stderr.write(
    `error: Circuit requires Node.js ${MIN_NODE_VERSION} or newer. Current Node.js is ${process.versions.node}.\n`,
  );
  process.exit(1);
}

if (!resolvedRuntime.ok) {
  process.stderr.write(`error: ${resolvedRuntime.message}\n`);
  process.exit(1);
}

const runtime = resolvedRuntime.runtime;
const result = spawnSync(runtime.command, runtimeArgs(runtime, forwardedArgs), {
  cwd: process.cwd(),
  env: runtimeEnv(runtime, childEnv),
  stdio: 'inherit',
});

if (result.error) {
  process.stderr.write(`error: failed to start circuit: ${result.error.message}\n`);
  process.exit(1);
}

process.exit(result.status ?? 1);
