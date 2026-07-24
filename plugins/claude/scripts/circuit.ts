#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldAutoOpenPath } from './auto-open-policy.ts';
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
import {
  deliberateClosePresentation,
  finalAnswerMarkdownPath,
  presentAbortReason,
} from './present-rendering.ts';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(scriptDir, '..');
const packagedFlowRoot = resolve(pluginRoot, 'skills');
const bundledRuntimePath = resolve(pluginRoot, 'runtime/circuit.js');
const CIRCUIT_HOST_KIND_ENV = 'CIRCUIT_HOST_KIND';
const DOCTOR_SMOKE_TIMEOUT_MS = 120_000;

type CheckResult = {
  name: string;
  ok: boolean;
  detail?: unknown;
};
type StatusBlockState = {
  openedBlockIds: Set<string>;
  renderedAnyBlock: boolean;
  lastBlockId: string | undefined;
};
type PresentationResult = {
  handled: boolean;
  rendered: boolean;
};
type ForwardedInvocation = {
  forwardedArgs: string[];
  childEnv: NodeJS.ProcessEnv;
};

function projectRoot(): string {
  return process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
}

// The dev-fallback bin/circuit lookup is anchored to the Claude project dir.
const runtimeContext: RuntimeContext = {
  pluginRoot,
  bundledRuntimePath,
  localLauncherBaseDir: projectRoot(),
};

function resolveRuntimeCommand(): RuntimeResolution {
  return resolveRuntimeCommandCore(runtimeContext);
}

function runtimeEnv(runtime: RuntimeCommand, baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return runtimeEnvCore(runtime, baseEnv, pluginRoot);
}

const rawArgs = process.argv.slice(2);

function check(name: string, ok: boolean, detail?: unknown): CheckResult {
  return detail === undefined ? { name, ok } : { name, ok, detail };
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringField(record: unknown, key: string): string | undefined {
  const value = isRecord(record) ? record[key] : undefined;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringArrayField(record: unknown, key: string): string[] {
  const value = isRecord(record) ? record[key] : undefined;
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

function shellSingleQuote(value: unknown): string {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function choiceLabel(choice: string): string {
  return choice
    .split(/[-_]/)
    .filter((part) => part.length > 0)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function readCheckpointPrompt(requestPath: string): string {
  try {
    const raw = JSON.parse(readFileSync(requestPath, 'utf8'));
    return stringField(raw, 'prompt') ?? 'Choose how to continue this checkpoint.';
  } catch {
    return 'Choose how to continue this checkpoint.';
  }
}

function renderCheckpointResumeCommands(runFolder: string, htmlPath: string | undefined): void {
  renderLine('');
  if (htmlPath !== undefined) {
    renderLine('Review with:');
    renderLine(
      `node "\${CLAUDE_PLUGIN_ROOT}/scripts/circuit.js" present resume --run-folder ${shellSingleQuote(
        runFolder,
      )} --checkpoint-review`,
    );
    renderLine('');
    renderLine('Manual fallback:');
  } else {
    renderLine('Resume with:');
  }
  renderLine(
    `node "\${CLAUDE_PLUGIN_ROOT}/scripts/circuit.js" present resume --run-folder ${shellSingleQuote(
      runFolder,
    )} --checkpoint-choice '<choice>'`,
  );
}

function hasProgressFlag(args: readonly string[]): boolean {
  return args.some((arg) => arg === '--progress' || arg.startsWith('--progress='));
}

function withProgressJsonl(args: readonly string[]): string[] {
  return hasProgressFlag(args) ? [...args] : [...args, '--progress', 'jsonl'];
}

function shouldRenderDisplay(event: unknown): boolean {
  const display = isRecord(event) ? event.display : undefined;
  if (!isRecord(display)) return false;
  const importance = stringField(display, 'importance');
  const tone = stringField(display, 'tone');
  return importance === 'major' || tone === 'warning' || tone === 'error' || tone === 'checkpoint';
}

function createStatusBlockState(): StatusBlockState {
  return {
    openedBlockIds: new Set(),
    renderedAnyBlock: false,
    lastBlockId: undefined,
  };
}

function renderLine(text = ''): void {
  process.stdout.write(`${text}\n`);
}

function renderStatusText(
  state: StatusBlockState,
  blockId: string | undefined,
  statusText: string,
): void {
  const id = blockId ?? state.lastBlockId ?? 'circuit';
  if (!state.openedBlockIds.has(id)) {
    if (state.renderedAnyBlock) renderLine('');
    renderLine('Circuit');
    state.openedBlockIds.add(id);
    state.renderedAnyBlock = true;
  }
  state.lastBlockId = id;
  renderLine(`⎿ ${statusText}`);
}

function renderPresentationEvent(state: StatusBlockState, event: unknown): PresentationResult {
  const presentation = isRecord(event) ? event.presentation : undefined;
  if (!isRecord(presentation)) return { handled: false, rendered: false };
  const lineMode = stringField(presentation, 'line_mode');
  if (lineMode === 'suppress') return { handled: true, rendered: false };
  if (lineMode !== 'append' && lineMode !== 'replace_slot') {
    return { handled: false, rendered: false };
  }
  const statusText = stringField(presentation, 'status_text');
  if (statusText === undefined) return { handled: false, rendered: false };
  renderStatusText(
    state,
    stringField(presentation, 'block_id') ?? stringField(event, 'run_id'),
    statusText,
  );
  return { handled: true, rendered: true };
}

function renderUserInputEvent(event: JsonRecord): void {
  const questions = Array.isArray(event.questions) ? event.questions : [];
  const question = questions.find((item) => isRecord(item));
  const questionText = stringField(question, 'question') ?? stringField(event.display, 'text');
  if (questionText !== undefined) renderLine(questionText);
  const options = Array.isArray(question?.options) ? question.options : [];
  for (const option of options) {
    if (!isRecord(option)) continue;
    const label = stringField(option, 'label');
    if (label === undefined) continue;
    const description = stringField(option, 'description');
    renderLine(description === undefined ? `- ${label}` : `- ${label}: ${description}`);
  }
}

function ensureCheckpointReviewUrlIsVisible(
  event: JsonRecord,
  presentation: PresentationResult,
): boolean {
  if (event.type !== 'checkpoint_review.ready') return false;
  const reviewUrl = stringField(event, 'review_url');
  if (reviewUrl === undefined) return presentation.handled;

  const presentationRecord = isRecord(event.presentation) ? event.presentation : undefined;
  const statusText = stringField(presentationRecord, 'status_text');
  const displayText = stringField(event.display, 'text');
  if (presentation.rendered && statusText?.includes(reviewUrl) === true) return true;
  if (!presentation.rendered && displayText?.includes(reviewUrl) === true) {
    renderLine(displayText);
    return true;
  }
  renderLine(`Checkpoint review: ${reviewUrl}`);
  return true;
}

function renderCheckpointFromResult(result: JsonRecord): void {
  const checkpoint = isRecord(result.checkpoint) ? result.checkpoint : undefined;
  if (checkpoint === undefined) {
    renderLine('Circuit is waiting for a checkpoint choice.');
  } else {
    const requestPath = stringField(checkpoint, 'request_path');
    renderLine(
      requestPath === undefined
        ? 'Choose how to continue this checkpoint.'
        : readCheckpointPrompt(requestPath),
    );
    for (const choice of stringArrayField(checkpoint, 'allowed_choices')) {
      renderLine(`- ${choiceLabel(choice)}: ${choice}`);
    }
  }
  const htmlPath = stringField(result, 'operator_summary_html_path');
  if (htmlPath !== undefined) {
    renderLine('');
    renderLine(`Rich summary: ${htmlPath}`);
  }
  const runFolder = stringField(result, 'run_folder');
  if (runFolder !== undefined) {
    renderCheckpointResumeCommands(runFolder, htmlPath);
  }
}

function debugPathFromResult(result: unknown): string | undefined {
  return (
    stringField(result, 'operator_summary_markdown_path') ??
    stringField(result, 'operator_summary_path') ??
    stringField(result, 'result_path') ??
    stringField(result, 'run_folder')
  );
}

// Read the specific abort reason from a run's reports/result.json (the file the
// envelope's result_path points at). Best-effort: returns undefined when the
// file is missing, unreadable, or carries no non-empty string reason. Injected
// into presentAbortReason so the reason-resolution logic stays pure/testable.
function loadResultReason(resultPath: string): string | undefined {
  if (!existsSync(resultPath)) return undefined;
  try {
    const parsed = readJson(resultPath);
    const reason = isRecord(parsed) ? parsed.reason : undefined;
    return typeof reason === 'string' && reason.length > 0 ? reason : undefined;
  } catch {
    return undefined;
  }
}

function autoOpenEnv() {
  return {
    CIRCUIT_NO_AUTO_OPEN: process.env.CIRCUIT_NO_AUTO_OPEN,
    CI: process.env.CI,
    DISPLAY: process.env.DISPLAY,
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
    isTTY: process.stdout.isTTY ?? false,
    platform: process.platform,
  };
}

function tryOpenInBrowser(path: string): void {
  if (!shouldAutoOpenPath(path, autoOpenEnv())) return;
  let command: string;
  let args: string[];
  if (process.platform === 'darwin') {
    command = 'open';
    args = [path];
  } else if (process.platform === 'linux') {
    command = 'xdg-open';
    args = [path];
  } else if (process.platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '""', path];
  } else {
    return;
  }
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    // Async ENOENT (e.g. xdg-open missing on a headless host) emits an
    // 'error' event on the child after spawn returns. Without a listener,
    // Node throws an unhandled error and crashes the wrapper after the
    // success summary already streamed to stdout.
    child.on('error', () => {});
    child.unref();
  } catch {
    // Best-effort. The path is also surfaced inline in the markdown summary.
  }
}

function renderFinalResult(
  stdoutText: string,
  checkpointWasRendered: boolean,
  statusBlocks: StatusBlockState,
): number {
  let result: unknown;
  try {
    result = JSON.parse(stdoutText.trim());
  } catch {
    process.stderr.write(
      'Circuit finished, but the presentation wrapper could not parse final JSON.\n',
    );
    return 1;
  }
  if (!isRecord(result)) {
    process.stderr.write('Circuit finished, but the final JSON was not an object.\n');
    return 1;
  }

  const outcome = stringField(result, 'outcome');
  if (outcome === 'complete') {
    // The streamed status block (channel B) already recorded progress live.
    // Separate it from the digest with a blank line so the readable summary
    // reads as its own block. On a quiet run there is no block to separate.
    if (statusBlocks.renderedAnyBlock) renderLine('');
    // Print the readable digest at completion regardless of whether the stream
    // rendered, so the operator sees the result and not just a one-line status
    // (docs/contracts/host-rendering.md "Final Rendering"). The digest wins
    // precedence over the terse Run surface.
    const finalAnswerPath = finalAnswerMarkdownPath(result, existsSync);
    if (finalAnswerPath !== undefined) {
      const markdown = readFileSync(finalAnswerPath, 'utf8');
      process.stdout.write(markdown.endsWith('\n') ? markdown : `${markdown}\n`);
      const htmlPath = stringField(result, 'operator_summary_html_path');
      if (htmlPath !== undefined && existsSync(htmlPath)) tryOpenInBrowser(htmlPath);
      return 0;
    }
    renderLine('Circuit completed, but the final-answer Markdown was not available.');
    const debugPath = debugPathFromResult(result);
    if (debugPath !== undefined) renderLine(`Debug path: ${debugPath}`);
    return 0;
  }

  if (outcome === 'checkpoint_waiting') {
    if (!checkpointWasRendered) renderCheckpointFromResult(result);
    const htmlPath = stringField(result, 'operator_summary_html_path');
    if (checkpointWasRendered && htmlPath !== undefined) {
      renderLine('');
      renderLine(`Rich summary: ${htmlPath}`);
    }
    const runFolder = stringField(result, 'run_folder');
    if (checkpointWasRendered && runFolder !== undefined) {
      renderCheckpointResumeCommands(runFolder, htmlPath);
    }
    return 0;
  }

  const deliberateClose = deliberateClosePresentation(result, loadResultReason);
  if (deliberateClose !== undefined) {
    // A close short of complete that is not a crash: the operator chose stop,
    // the flow escalated, or continuity was handed off. Render the run's own
    // status text; the caller decides what exit status to propagate.
    if (statusBlocks.renderedAnyBlock) renderLine('');
    renderLine(deliberateClose.headline);
    if (deliberateClose.reason !== undefined) renderLine(deliberateClose.reason);
    const summaryPath = finalAnswerMarkdownPath(result, existsSync);
    if (summaryPath !== undefined) renderLine(`Summary: ${summaryPath}`);
    const runFolder = stringField(result, 'run_folder');
    if (runFolder !== undefined) renderLine(`Run folder: ${runFolder}`);
    return 0;
  }

  if (outcome === 'aborted') {
    // In streamed mode the runtime's `run.aborted` progress event already
    // rendered the abort line (with the specific reason) as the final status
    // under this block. Don't emit a second, redundant generic line (F-H-2).
    if (statusBlocks.renderedAnyBlock) {
      return 0;
    }
    // No streamed block (quiet / non-streaming host): render the specific
    // reason from the envelope, falling back to reports/result.json via
    // result_path, before the generic fallback (F-H-2).
    const reason =
      presentAbortReason(result, loadResultReason) ?? 'Circuit aborted before completing.';
    renderLine(`Circuit aborted: ${reason}`);
    const runFolder = stringField(result, 'run_folder');
    if (runFolder !== undefined) renderLine(`Run folder: ${runFolder}`);
    return 0;
  }

  // Utility actions (e.g., `create`, `handoff`) emit `action` + `status`
  // rather than `outcome`. Render the operator summary the same way we do
  // for run-flow `complete` outcomes so the user sees the substantive output.
  const action = stringField(result, 'action');
  const status = stringField(result, 'status');
  if (action !== undefined && status !== undefined) {
    const finalAnswerPath = finalAnswerMarkdownPath(result, existsSync);
    if (finalAnswerPath !== undefined) {
      const markdown = readFileSync(finalAnswerPath, 'utf8');
      process.stdout.write(markdown.endsWith('\n') ? markdown : `${markdown}\n`);
      return 0;
    }
  }

  renderLine('Circuit finished, but the presentation wrapper did not recognize the outcome.');
  const debugPath = debugPathFromResult(result);
  if (debugPath !== undefined) renderLine(`Debug path: ${debugPath}`);
  return 0;
}

function shortDiagnostic(lines: readonly string[]): string[] {
  return lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('{') && !line.startsWith('['))
    .slice(-4);
}

function runDoctor(): number {
  const checks: CheckResult[] = [];
  const manifestPath = resolve(pluginRoot, '.claude-plugin/plugin.json');
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
      manifest?.name === 'circuit' && !('hooks' in (manifest ?? {})),
      manifestPath,
    ),
  );

  const hooksConfigPath = resolve(pluginRoot, 'hooks/hooks.json');
  const sessionStartPath = resolve(pluginRoot, 'hooks/session-start.js');
  checks.push(check('hooks_config_exists', existsSync(hooksConfigPath), hooksConfigPath));
  checks.push(check('session_start_hook_exists', existsSync(sessionStartPath), sessionStartPath));

  if (existsSync(hooksConfigPath)) {
    const hooks = readFileSync(hooksConfigPath, 'utf8');
    checks.push(
      check(
        'session_start_hook_uses_plugin_root',
        hooks.includes('${CLAUDE_PLUGIN_ROOT}/hooks/session-start.js'),
        hooksConfigPath,
      ),
    );
  }

  const commandsRoot = resolve(pluginRoot, 'commands');
  checks.push(check('commands_directory_exists', existsSync(commandsRoot), commandsRoot));
  for (const name of listMarkdownFiles(commandsRoot)) {
    const commandPath = resolve(commandsRoot, name);
    const text = readFileSync(commandPath, 'utf8');
    checks.push(
      check(
        `command_${name}_uses_wrapper`,
        text.includes('node "${CLAUDE_PLUGIN_ROOT}/scripts/circuit.js"') &&
          !text.includes('./bin/circuit') &&
          text.includes(' present '),
        commandPath,
      ),
    );
  }

  checks.push(check('packaged_flow_root_exists', existsSync(packagedFlowRoot), packagedFlowRoot));
  for (const flow of ['build', 'explore', 'fix', 'review']) {
    const flowPath = resolve(packagedFlowRoot, flow, 'circuit.json');
    checks.push(check(`packaged_flow_${flow}`, existsSync(flowPath), flowPath));
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
        cwd: projectRoot(),
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

    const smokeRoot = mkdtempSync(join(tmpdir(), 'circuit-claude-doctor-'));
    try {
      // Exercise the real built-in Claude connector without spending money.
      // The executable emits the reviewed stream-json protocol from the
      // prompt-only relay directory. A tracked marker proves Review captured
      // the selected working-tree diff before moving the connector away from
      // the repository.
      const smokeHome = resolve(smokeRoot, 'home');
      const userConfigDir = resolve(smokeHome, '.config', 'circuit');
      const smokeBin = resolve(smokeRoot, 'bin');
      const fakeClaude = resolve(smokeBin, 'claude');
      const smokePath = `${smokeBin}${delimiter}${process.env.PATH ?? ''}`;
      const smokeProject = resolve(smokeRoot, 'project');
      const runFolder = resolve(smokeRoot, 'run');
      const reviewFile = resolve(smokeProject, 'doctor-review.txt');
      const reviewMarker = 'CIRCUIT_CLAUDE_DOCTOR_WORKING_TREE_MARKER';
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
        fakeClaude,
        `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
const prompt = process.argv.at(-1) ?? '';
writeFileSync(${JSON.stringify(promptCapture)}, prompt);
if (!prompt.includes(${JSON.stringify(reviewMarker)})) {
  process.stderr.write('doctor marker missing from Review relay prompt\\n');
  process.exit(2);
}
const result = ${JSON.stringify({
          verdict: 'NO_ISSUES_FOUND',
          findings: [],
          assessment: 'Doctor stub reviewer: nothing actionable in the relayed evidence.',
          verification: ['Doctor stub: inspected the relayed intake report.'],
          confidence_limitations: [],
        })};
const structured = process.argv.includes('--json-schema');
for (const event of [
  { type: 'system', subtype: 'init', session_id: 'doctor-session', claude_code_version: 'doctor-stub', tools: structured ? ['StructuredOutput'] : [], mcp_servers: [], slash_commands: [] },
  { type: 'result', subtype: 'success', is_error: false, session_id: 'doctor-session', duration_ms: 0, num_turns: 1, result: structured ? '' : JSON.stringify(result), ...(structured ? { structured_output: result } : {}) },
]) process.stdout.write(JSON.stringify(event) + '\\n');
`,
      );
      chmodSync(fakeClaude, 0o700);
      writeFileSync(
        resolve(userConfigDir, 'config.yaml'),
        `${JSON.stringify(
          {
            schema_version: 1,
            host: { kind: 'claude-code' },
            defaults: {
              selection: {
                model: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
              },
            },
          },
          null,
          2,
        )}\n`,
      );
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
      } catch {
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
    } finally {
      rmSync(smokeRoot, { recursive: true, force: true });
    }
  }

  const ok = checks.every((item) => item.ok);
  process.stdout.write(
    `${JSON.stringify(
      {
        schema_version: 1,
        host: 'claude-code',
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

if (rawArgs[0] === 'doctor') {
  process.exit(runDoctor());
}

function forwardedInvocation(args: readonly string[]): ForwardedInvocation {
  const injectPackagedFlowRoot = shouldInjectPackagedFlowRoot(args);
  const forwardedArgs = injectPackagedFlowRoot
    ? [...args, '--flow-root', packagedFlowRoot]
    : shouldInjectCreateTemplateRoot(args)
      ? [...args, '--template-flow-root', packagedFlowRoot]
      : [...args];

  const childEnv = { ...process.env };
  childEnv[CIRCUIT_HOST_KIND_ENV] = 'claude-code';
  if (injectPackagedFlowRoot) {
    childEnv[GENERATED_FLOW_MIRROR_ROOT_ENV] = packagedFlowRoot;
  } else {
    delete childEnv[GENERATED_FLOW_MIRROR_ROOT_ENV];
  }
  return { forwardedArgs, childEnv };
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

if (rawArgs[0] === 'present') {
  const presentArgs = withProgressJsonl(rawArgs.slice(1));
  const { forwardedArgs, childEnv } = forwardedInvocation(presentArgs);
  const child = spawn(runtime.command, runtimeArgs(runtime, forwardedArgs), {
    cwd: projectRoot(),
    env: runtimeEnv(runtime, childEnv),
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  let stdoutText = '';
  let stderrRemainder = '';
  const diagnosticLines: string[] = [];
  let checkpointWasRendered = false;
  const statusBlocks = createStatusBlockState();

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutText += chunk;
  });

  function handleStderrLine(line: string): void {
    if (line.trim().length === 0) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch {
      diagnosticLines.push(line);
      return;
    }
    if (!isRecord(parsed)) return;
    const presentation = renderPresentationEvent(statusBlocks, parsed);
    if (parsed.type === 'route.selected') {
      if (presentation.handled) return;
      return;
    }
    if (parsed.type === 'user_input.requested') {
      renderUserInputEvent(parsed);
      checkpointWasRendered = true;
      return;
    }
    if (ensureCheckpointReviewUrlIsVisible(parsed, presentation)) return;
    if (presentation.handled) return;
    if (!shouldRenderDisplay(parsed)) return;
    const text = stringField(parsed.display, 'text');
    if (text !== undefined) renderLine(text);
  }

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderrRemainder += chunk;
    const lines = stderrRemainder.split(/\r?\n/);
    stderrRemainder = lines.pop() ?? '';
    for (const line of lines) handleStderrLine(line);
  });

  child.on('error', (err) => {
    process.stderr.write(`error: failed to start circuit: ${err.message}\n`);
    process.exit(1);
  });

  child.on('close', (status) => {
    if (stderrRemainder.trim().length > 0) handleStderrLine(stderrRemainder);
    const exitStatus = status ?? 1;
    if (exitStatus !== 0) {
      // The runtime may have produced a structured refusal envelope on stdout
      // (e.g. handoff resume against an invalid continuity record). Render
      // ONLY explicit refusal/abort envelopes — never `outcome: 'complete'`
      // or `outcome: 'checkpoint_waiting'`, which would print success text
      // (and on `complete` would even auto-open a browser) for a process that
      // exited non-zero. Genuine crashes still fall through to the generic
      // failure tag.
      const stdoutTrimmed = stdoutText.trim();
      if (stdoutTrimmed.length > 0) {
        try {
          const parsed = JSON.parse(stdoutTrimmed);
          if (isRecord(parsed)) {
            const outcome = stringField(parsed, 'outcome');
            const refusalStatus = stringField(parsed, 'status');
            const isAbortedFlow = outcome === 'aborted';
            const isUtilityRefusal =
              outcome === undefined && (refusalStatus === 'invalid' || refusalStatus === 'refused');
            const isDeliberateClose =
              deliberateClosePresentation(parsed, loadResultReason) !== undefined;
            if (isAbortedFlow || isUtilityRefusal || isDeliberateClose) {
              renderFinalResult(stdoutText, checkpointWasRendered, statusBlocks);
            }
            if (isDeliberateClose) {
              // The run closed on purpose (stop choice, escalation, handoff)
              // and the rendering above states how. A generic failure line
              // would misreport a deliberate close as a crash; the nonzero
              // exit still propagates so scripts see "not complete".
              process.exit(exitStatus);
            }
          }
        } catch {
          // No structured body — fall through to the generic failure line.
        }
      }
      process.stderr.write(`Circuit run failed (exit ${exitStatus}).\n`);
      const diagnostic = shortDiagnostic(diagnosticLines);
      if (diagnostic.length > 0) {
        process.stderr.write('Diagnostic:\n');
        for (const line of diagnostic) process.stderr.write(`${line}\n`);
      }
      process.exit(exitStatus);
    }
    process.exit(renderFinalResult(stdoutText, checkpointWasRendered, statusBlocks));
  });
} else {
  const { forwardedArgs, childEnv } = forwardedInvocation(rawArgs);

  const result = spawnSync(runtime.command, runtimeArgs(runtime, forwardedArgs), {
    cwd: projectRoot(),
    env: runtimeEnv(runtime, childEnv),
    stdio: ['inherit', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  if (typeof result.stdout === 'string' && result.stdout.length > 0) {
    process.stdout.write(result.stdout);
  }
  if (typeof result.stderr === 'string' && result.stderr.length > 0) {
    process.stderr.write(result.stderr);
  }

  if (result.error) {
    process.stderr.write(`error: failed to start circuit: ${result.error.message}\n`);
    process.exit(1);
  }

  process.exit(result.status ?? 1);
}
