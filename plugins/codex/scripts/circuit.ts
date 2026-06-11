#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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

  const wrapperPath = resolve(scriptDir, 'circuit.ts');
  checks.push(check('wrapper_exists', existsSync(wrapperPath), wrapperPath));
  checks.push(check('packaged_flow_root_exists', existsSync(packagedFlowRoot), packagedFlowRoot));
  for (const flow of ['build', 'explore', 'fix', 'review']) {
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
        text.includes("node '<plugin root>/scripts/circuit.ts'") &&
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
    const configDir = resolve(smokeRoot, '.circuit');
    const runFolder = resolve(smokeRoot, 'run');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      resolve(configDir, 'config.yaml'),
      `${JSON.stringify(
        {
          schema_version: 1,
          host: { kind: 'codex' },
          relay: {
            roles: {
              reviewer: { kind: 'named', name: 'doctor-reviewer' },
            },
            connectors: {
              'doctor-reviewer': {
                kind: 'custom',
                name: 'doctor-reviewer',
                command: [
                  process.execPath,
                  '-e',
                  "require('node:fs').writeFileSync(process.argv[2], JSON.stringify({verdict:'NO_ISSUES_FOUND',findings:[],assessment:'Doctor stub reviewer: nothing actionable in the relayed evidence.',verification:['Doctor stub: inspected the relayed intake report.'],confidence_limitations:[]}))",
                ],
                prompt_transport: 'prompt-file',
                output: { kind: 'output-file' },
                capabilities: { filesystem: 'read-only', structured_output: 'json' },
              },
            },
          },
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
          'review this patch',
          '--flow-root',
          packagedFlowRoot,
          '--run-folder',
          runFolder,
          '--progress',
          'jsonl',
        ]),
        {
          cwd: smokeRoot,
          encoding: 'utf8',
          env: runtimeEnv(resolved.runtime, {
            ...process.env,
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
          `status=${result.status ?? 'unknown'} error=${result.error?.message ?? 'none'} stderr=${result.stderr.slice(0, 500)}`,
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

      const checkpointRunFolder = resolve(smokeRoot, 'checkpoint-run');
      writeFileSync(
        resolve(smokeRoot, 'package.json'),
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
          '--depth',
          'high',
          '--flow-root',
          packagedFlowRoot,
          '--run-folder',
          checkpointRunFolder,
          '--progress',
          'jsonl',
        ]),
        {
          cwd: smokeRoot,
          encoding: 'utf8',
          env: runtimeEnv(resolved.runtime, {
            ...process.env,
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
