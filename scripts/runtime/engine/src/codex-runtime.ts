import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";

import { resolveProjectRoot } from "./continuity.js";
import { writeTextFileAtomic } from "./file-utils.js";

export type RuntimeBoundary =
  | "agent"
  | "codex-isolated"
  | "codex-ambient"
  | "process";

export interface DispatchProcessResult {
  commandArgv: string[];
  diagnosticsPath?: string;
  runtimeBoundary: RuntimeBoundary;
  warnings: string[];
}

export interface LiveOwnedProcess {
  command: string;
  matchedPath: string;
  pgid: number;
  pid: number;
}

export interface OwnedArtifactRecord {
  path: string;
  reason: string;
}

export interface CleanupAction {
  action: string;
  details?: string;
  status: "killed" | "removed" | "skipped" | "warning";
  target: string;
}

export interface CodexLaunchReport {
  cleanupActions: CleanupAction[];
  exitStatus: number | null;
  finishedAt: string | null;
  launchId: string;
  launchTmpDir: string;
  liveOwnedProcesses: LiveOwnedProcess[];
  ownedArtifactsFound: OwnedArtifactRecord[];
  runtimeRoot: string;
  startedAt: string;
  warnings: string[];
  workspaceRoot: string;
}

interface RuntimeRootInfo {
  runtimeRoot: string;
  workspaceRoot: string;
}

interface LaunchPidRecord {
  launchId: string;
  launchTmpDir: string;
  pgid: number;
  pid: number;
  runtimeRoot: string;
  startedAt: string;
}

interface LaunchReportRecord {
  finishedAt?: string | null;
  launchId: string;
  launchTmpDir?: string;
}

interface ProcessRow {
  command: string;
  pgid: number;
  pid: number;
}

interface ProcessOps {
  killGroup(groupId: number, signal: NodeJS.Signals): void;
  listProcesses(): ProcessRow[];
  sleep(ms: number): void;
}

interface JanitorOptions {
  processOps?: ProcessOps;
  runtimeRoot: string;
}

interface JanitorResult {
  cleanupActions: CleanupAction[];
  ownedArtifactsFound: OwnedArtifactRecord[];
  warnings: string[];
}

interface StoredLaunchState {
  launchId: string;
  pidFilePath?: string;
  pidRecord?: LaunchPidRecord;
  report?: LaunchReportRecord;
  reportPath?: string;
  tmpPath?: string;
}

export interface CodexDispatchOptions {
  baseEnv?: NodeJS.ProcessEnv;
  cwd?: string;
  graceMs?: number;
  homeDir?: string;
  outputFile: string;
  promptFile: string;
}

const AMBIENT_WARNING = "codex-ambient inherits user Codex state; less deterministic.";
const DEFAULT_GRACE_MS = 30_000;
const PID_FILE_SUFFIX = ".pid.json";
const RUNTIME_KEEP_ENTRIES = new Set(["auth.json", "config.toml", "pids", "reports", "tmp"]);
const CODEX_SPAWN_PID_FILE = "CIRCUIT_CODEX_SPAWN_PID_FILE";
const SANITIZED_ENV_ALLOWLIST = [
  "ALL_PROXY",
  "CI",
  "COLORTERM",
  "FORCE_COLOR",
  "HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "NO_COLOR",
  "NO_PROXY",
  "PATH",
  "SHELL",
  "SSH_AUTH_SOCK",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "TZ",
  "USER",
  "NODE_EXTRA_CA_CERTS",
];
const CODEX_LAUNCHER_SOURCE = `
const { spawn } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");

const [cwd, promptFile, command, ...args] = process.argv.slice(1);
const pidFile = process.env.${CODEX_SPAWN_PID_FILE};

const child = spawn(command, args, {
  cwd,
  detached: true,
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});

child.on("error", (error) => {
  process.stderr.write(\`\${error.message}\\n\`);
  process.exit(1);
});

if (pidFile) {
  writeFileSync(pidFile, String(child.pid ?? ""), "utf-8");
}

child.stdout.on("data", (chunk) => process.stdout.write(chunk));
child.stderr.on("data", (chunk) => process.stderr.write(chunk));
child.on("close", (code) => process.exit(code ?? 1));
child.stdin.end(readFileSync(promptFile, "utf-8"));
`;

function defaultProcessOps(): ProcessOps {
  return {
    killGroup(groupId, signal) {
      process.kill(-groupId, signal);
    },
    listProcesses() {
      const result = spawnSync("ps", ["-axww", "-o", "pid=,pgid=,command="], {
        encoding: "utf-8",
      });

      if (result.error) {
        throw result.error;
      }
      if (result.status !== 0) {
        const detail = String(result.stderr ?? result.stdout ?? "").trim();
        throw new Error(detail || `ps exited with status ${result.status}`);
      }

      return String(result.stdout)
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .flatMap((line) => {
          const match = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
          if (!match) {
            return [];
          }

          return [{
            command: match[3] ?? "",
            pgid: Number.parseInt(match[2] ?? "", 10),
            pid: Number.parseInt(match[1] ?? "", 10),
          }];
        });
    },
    sleep(ms) {
      if (ms <= 0) {
        return;
      }

      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    },
  };
}

function workspaceSlug(workspaceRoot: string): string {
  const raw = basename(workspaceRoot) || "workspace";
  const sanitized = raw.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized || "workspace";
}

function reportNow(): string {
  return new Date().toISOString();
}

function normalizeOwnedPath(path: string): string {
  return resolve(path).replace(/\\/g, "/");
}

function pathMatchesCommand(command: string, candidatePath: string): boolean {
  return command.replace(/\\/g, "/").includes(candidatePath);
}

function buildReportPath(runtimeRoot: string, launchId: string): string {
  return join(runtimeRoot, "reports", `${launchId}.json`);
}

function reportDir(runtimeRoot: string): string {
  return join(runtimeRoot, "reports");
}

function pidDir(runtimeRoot: string): string {
  return join(runtimeRoot, "pids");
}

function pidFilePath(runtimeRoot: string, launchId: string): string {
  return join(pidDir(runtimeRoot), `${launchId}${PID_FILE_SUFFIX}`);
}

function readResultOutput(result: SpawnSyncReturns<string>): string {
  return [String(result.stderr ?? ""), String(result.stdout ?? "")]
    .map((value) => value.trim())
    .filter(Boolean)
    .join("\n");
}

function writeLaunchReport(reportPath: string, report: CodexLaunchReport): void {
  writeTextFileAtomic(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

function initializeReport(
  runtimeRoot: string,
  workspaceRoot: string,
  launchId: string,
  launchTmpDir: string,
): CodexLaunchReport {
  return {
    cleanupActions: [],
    exitStatus: null,
    finishedAt: null,
    launchId,
    launchTmpDir,
    liveOwnedProcesses: [],
    ownedArtifactsFound: [],
    runtimeRoot,
    startedAt: reportNow(),
    warnings: [],
    workspaceRoot,
  };
}

function appendWarning(report: CodexLaunchReport, warning: string): void {
  if (!report.warnings.includes(warning)) {
    report.warnings.push(warning);
  }
}

function safeReadDir(path: string): string[] {
  if (!existsSync(path)) {
    return [];
  }

  return readdirSync(path);
}

export function resolveCodexRuntimeRoot(
  cwd: string,
  homeDir = homedir(),
): RuntimeRootInfo {
  const workspaceRoot = resolveProjectRoot(cwd);
  const canonicalWorkspaceRoot = existsSync(workspaceRoot)
    ? normalizeOwnedPath(realpathSync(workspaceRoot))
    : normalizeOwnedPath(resolve(workspaceRoot));
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  return {
    runtimeRoot: resolve(homeDir, ".circuit", "runtime", "codex", `${workspaceSlug(canonicalWorkspaceRoot)}-${hash}`),
    workspaceRoot: canonicalWorkspaceRoot,
  };
}

export function buildIsolatedCodexConfig(workspaceRoot: string): string {
  return `[projects.${JSON.stringify(workspaceRoot)}]\ntrust_level = "untrusted"\n`;
}

export function bootstrapCodexAuth(runtimeRoot: string, homeDir = homedir()): string {
  const sourcePath = resolve(homeDir, ".codex", "auth.json");
  const targetPath = join(runtimeRoot, "auth.json");

  if (!existsSync(sourcePath)) {
    rmSync(targetPath, { force: true });
    throw new Error("circuit: Codex login required. Run `codex login` and retry.");
  }

  mkdirSync(runtimeRoot, { recursive: true });
  copyFileSync(sourcePath, targetPath);
  return targetPath;
}

function buildSanitizedEnv(
  baseEnv: NodeJS.ProcessEnv,
  homeDir: string,
  runtimeRoot: string,
  launchTmpDir: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const key of SANITIZED_ENV_ALLOWLIST) {
    const value = baseEnv[key];
    if (typeof value === "string" && value.length > 0) {
      env[key] = value;
    }
  }

  env.CODEX_HOME = runtimeRoot;
  env.HOME = homeDir;
  env.TMPDIR = launchTmpDir;
  env.TEMP = launchTmpDir;
  env.TMP = launchTmpDir;
  return env;
}

function safeListProcesses(
  processOps: ProcessOps,
  warnings: string[],
): ProcessRow[] {
  try {
    return processOps.listProcesses();
  } catch (error) {
    warnings.push(
      `process snapshot unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

function collectOwnedProcesses(
  paths: string[],
  processRows: ProcessRow[],
): LiveOwnedProcess[] {
  const normalizedPaths = [...new Set(paths.map(normalizeOwnedPath))];

  return processRows.flatMap((row) => {
    const matchedPath = normalizedPaths.find((candidate) => pathMatchesCommand(row.command, candidate));
    if (!matchedPath) {
      return [];
    }

    return [{
      command: row.command,
      matchedPath,
      pgid: row.pgid,
      pid: row.pid,
    }];
  });
}

function killOwnedGroup(
  processOps: ProcessOps,
  groupId: number,
  target: string,
  warnings: string[],
  cleanupActions: CleanupAction[],
): void {
  if (!Number.isInteger(groupId) || groupId <= 1) {
    cleanupActions.push({
      action: "kill_process_group",
      details: "invalid process group id",
      status: "skipped",
      target,
    });
    return;
  }

  try {
    processOps.killGroup(groupId, "SIGTERM");
    processOps.sleep(250);
    cleanupActions.push({
      action: "kill_process_group",
      status: "killed",
      target,
    });
  } catch (error) {
    warnings.push(
      `failed to kill owned process group ${groupId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    cleanupActions.push({
      action: "kill_process_group",
      details: error instanceof Error ? error.message : String(error),
      status: "warning",
      target,
    });
  }
}

function readLaunchPidRecords(runtimeRoot: string): Array<{ filePath: string; record: LaunchPidRecord }> {
  return safeReadDir(pidDir(runtimeRoot))
    .filter((name) => name.endsWith(PID_FILE_SUFFIX))
    .flatMap((name) => {
      const filePath = join(pidDir(runtimeRoot), name);

      try {
        const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as Partial<LaunchPidRecord>;
        if (
          typeof parsed.launchId !== "string"
          || typeof parsed.launchTmpDir !== "string"
          || typeof parsed.pgid !== "number"
          || typeof parsed.pid !== "number"
          || typeof parsed.runtimeRoot !== "string"
          || typeof parsed.startedAt !== "string"
        ) {
          return [];
        }

        return [{ filePath, record: parsed as LaunchPidRecord }];
      } catch {
        return [];
      }
    });
}

function readLaunchReportRecords(
  runtimeRoot: string,
): Array<{ filePath: string; record: LaunchReportRecord }> {
  return safeReadDir(reportDir(runtimeRoot))
    .filter((name) => name.endsWith(".json"))
    .flatMap((name) => {
      const filePath = join(reportDir(runtimeRoot), name);
      const derivedLaunchId = name.slice(0, -".json".length);

      try {
        const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as Partial<LaunchReportRecord>;
        const launchId =
          typeof parsed.launchId === "string" && parsed.launchId.length > 0
            ? parsed.launchId
            : derivedLaunchId;

        return [{
          filePath,
          record: {
            finishedAt: typeof parsed.finishedAt === "string" || parsed.finishedAt === null
              ? parsed.finishedAt
              : undefined,
            launchId,
            launchTmpDir:
              typeof parsed.launchTmpDir === "string" && parsed.launchTmpDir.length > 0
                ? parsed.launchTmpDir
                : undefined,
          },
        }];
      } catch {
        return [{
          filePath,
          record: {
            launchId: derivedLaunchId,
          },
        }];
      }
    });
}

function collectStoredLaunchStates(runtimeRoot: string): StoredLaunchState[] {
  const states = new Map<string, StoredLaunchState>();

  for (const { filePath, record } of readLaunchPidRecords(runtimeRoot)) {
    const state = states.get(record.launchId) ?? { launchId: record.launchId };
    state.pidFilePath = filePath;
    state.pidRecord = record;
    state.tmpPath ??= record.launchTmpDir;
    states.set(record.launchId, state);
  }

  for (const { filePath, record } of readLaunchReportRecords(runtimeRoot)) {
    const state = states.get(record.launchId) ?? { launchId: record.launchId };
    state.report = record;
    state.reportPath = filePath;
    state.tmpPath ??= record.launchTmpDir;
    states.set(record.launchId, state);
  }

  for (const launchId of safeReadDir(join(runtimeRoot, "tmp"))) {
    const state = states.get(launchId) ?? { launchId };
    state.tmpPath = join(runtimeRoot, "tmp", launchId);
    states.set(launchId, state);
  }

  return [...states.values()];
}

function dedupeOwnedProcesses(processes: LiveOwnedProcess[]): LiveOwnedProcess[] {
  const seen = new Set<string>();
  const deduped: LiveOwnedProcess[] = [];

  for (const processInfo of processes) {
    const key = `${processInfo.pid}:${processInfo.pgid}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(processInfo);
  }

  return deduped;
}

function collectLaunchOwnedProcesses(
  launch: StoredLaunchState,
  processRows: ProcessRow[],
): LiveOwnedProcess[] {
  const matches: LiveOwnedProcess[] = [];

  if (launch.pidRecord) {
    const matchedPath = launch.pidRecord.launchTmpDir;
    for (const row of processRows) {
      if (row.pid === launch.pidRecord.pid || row.pgid === launch.pidRecord.pgid) {
        matches.push({
          command: row.command,
          matchedPath,
          pgid: row.pgid,
          pid: row.pid,
        });
      }
    }
  }

  if (launch.tmpPath) {
    matches.push(...collectOwnedProcesses([launch.tmpPath], processRows));
  }

  return dedupeOwnedProcesses(matches);
}

function launchIsFinished(launch: StoredLaunchState): boolean {
  return typeof launch.report?.finishedAt === "string" && launch.report.finishedAt.length > 0;
}

function removeLaunchArtifacts(
  launch: StoredLaunchState,
  cleanupActions: CleanupAction[],
): void {
  if (launch.pidFilePath) {
    rmSync(launch.pidFilePath, { force: true });
    cleanupActions.push({
      action: "remove_pid_file",
      status: "removed",
      target: launch.pidFilePath,
    });
  }

  if (launch.tmpPath && existsSync(launch.tmpPath)) {
    rmSync(launch.tmpPath, { force: true, recursive: true });
    cleanupActions.push({
      action: "remove_tmp_root",
      status: "removed",
      target: launch.tmpPath,
    });
  }
}

export function janitorCodexRuntime(options: JanitorOptions): JanitorResult {
  const warnings: string[] = [];
  const cleanupActions: CleanupAction[] = [];
  const ownedArtifactsFound: OwnedArtifactRecord[] = [];
  const processOps = options.processOps ?? defaultProcessOps();
  const runtimeRoot = options.runtimeRoot;

  if (!existsSync(runtimeRoot)) {
    return { cleanupActions, ownedArtifactsFound, warnings };
  }

  const processRows = safeListProcesses(processOps, warnings);
  const snapshotsTrusted = warnings.length === 0;
  const launchStates = collectStoredLaunchStates(runtimeRoot);
  let hasActiveLaunch = false;

  for (const launch of launchStates) {
    if (launch.pidFilePath) {
      ownedArtifactsFound.push({
        path: launch.pidFilePath,
        reason: "persisted launch pid file",
      });
    }
    if (launch.tmpPath && existsSync(launch.tmpPath)) {
      ownedArtifactsFound.push({
        path: launch.tmpPath,
        reason: "prior launch tmp root",
      });
    }

    if (!snapshotsTrusted) {
      if (launch.pidFilePath || launch.tmpPath) {
        cleanupActions.push({
          action: "preserve_launch_state",
          details: "process snapshot unavailable; preserving launch metadata and temp roots",
          status: "skipped",
          target: launch.tmpPath ?? launch.pidFilePath ?? launch.launchId,
        });
      }
      continue;
    }

    let launchProcesses = collectLaunchOwnedProcesses(launch, processRows);
    const finished = launchIsFinished(launch);

    if (launchProcesses.length > 0 && !finished) {
      hasActiveLaunch = true;
      cleanupActions.push({
        action: "preserve_active_launch",
        details: "launch is still active",
        status: "skipped",
        target: launch.tmpPath ?? launch.pidFilePath ?? launch.launchId,
      });
      continue;
    }

    if (launchProcesses.length > 0) {
      const processGroups = [...new Set(launchProcesses.map((processInfo) => processInfo.pgid))];
      for (const groupId of processGroups) {
        killOwnedGroup(
          processOps,
          groupId,
          `${launch.tmpPath ?? launch.launchId} (launch ${launch.launchId})`,
          warnings,
          cleanupActions,
        );
      }

      launchProcesses = collectLaunchOwnedProcesses(
        launch,
        safeListProcesses(processOps, warnings),
      );
    }

    if (launchProcesses.length === 0) {
      removeLaunchArtifacts(launch, cleanupActions);
      continue;
    }

    cleanupActions.push({
      action: "preserve_launch_state",
      details: "owned processes are still live after janitor cleanup",
      status: "warning",
      target: launch.tmpPath ?? launch.pidFilePath ?? launch.launchId,
    });
  }

  if (snapshotsTrusted && !hasActiveLaunch) {
    for (const entry of safeReadDir(runtimeRoot)) {
      if (RUNTIME_KEEP_ENTRIES.has(entry)) {
        continue;
      }

      const entryPath = join(runtimeRoot, entry);
      ownedArtifactsFound.push({
        path: entryPath,
        reason: "stale runtime entry",
      });
      rmSync(entryPath, { force: true, recursive: true });
      cleanupActions.push({
        action: "remove_runtime_entry",
        status: "removed",
        target: entryPath,
      });
    }
  }

  return { cleanupActions, ownedArtifactsFound, warnings };
}

function persistLaunchPid(runtimeRoot: string, record: LaunchPidRecord): string {
  mkdirSync(pidDir(runtimeRoot), { recursive: true });
  const path = pidFilePath(runtimeRoot, record.launchId);
  writeTextFileAtomic(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

function readSpawnedCodexPid(path: string): number | null {
  if (!existsSync(path)) {
    return null;
  }

  const raw = readFileSync(path, "utf-8").trim();
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function finalizeIsolatedReport(
  report: CodexLaunchReport,
  reportPath: string,
  pidPath: string | null,
  processOps: ProcessOps,
  graceMs: number,
): void {
  const ownedPaths = [report.runtimeRoot, report.launchTmpDir];
  const initialProcesses = collectOwnedProcesses(
    ownedPaths,
    safeListProcesses(processOps, report.warnings),
  );
  let finalProcesses = initialProcesses;

  if (initialProcesses.length > 0 && graceMs > 0) {
    processOps.sleep(graceMs);
    finalProcesses = collectOwnedProcesses(
      ownedPaths,
      safeListProcesses(processOps, report.warnings),
    );
  }

  report.liveOwnedProcesses = finalProcesses;

  if (finalProcesses.length > 0) {
    appendWarning(
      report,
      `owned processes remained after dispatch: ${finalProcesses.map((item) => item.pid).join(", ")}`,
    );
  }

  const snapshotsTrusted = !report.warnings.some((warning) =>
    warning.startsWith("process snapshot unavailable:"),
  );

  if (finalProcesses.length === 0 && snapshotsTrusted) {
    if (pidPath) {
      rmSync(pidPath, { force: true });
      report.cleanupActions.push({
        action: "remove_pid_file",
        status: "removed",
        target: pidPath,
      });
    }

    rmSync(report.launchTmpDir, { force: true, recursive: true });
    report.cleanupActions.push({
      action: "remove_launch_tmp_root",
      status: "removed",
      target: report.launchTmpDir,
    });
  } else if (finalProcesses.length === 0) {
    report.cleanupActions.push({
      action: "preserve_launch_state",
      details: "process snapshots were unavailable; keeping pid metadata and tmp root for janitor follow-up",
      status: "skipped",
      target: report.launchTmpDir,
    });
  }

  writeLaunchReport(reportPath, report);
}

function finalizeSpawnResult(
  adapter: string,
  result: SpawnSyncReturns<string>,
): void {
  if (result.error) {
    throw new Error(`circuit: adapter "${adapter}" failed to start: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const detail = readResultOutput(result);
    throw new Error(
      `circuit: adapter "${adapter}" exited with status ${result.status}${detail ? `\n${detail}` : ""}`,
    );
  }
}

export function runAmbientCodexDispatch(options: CodexDispatchOptions): DispatchProcessResult {
  const workspaceRoot = resolveProjectRoot(options.cwd ?? process.cwd());
  const commandArgv = ["codex", "exec", "--full-auto", "-o", options.outputFile, "-"];
  const result = spawnSync(commandArgv[0], commandArgv.slice(1), {
    cwd: workspaceRoot,
    encoding: "utf-8",
    input: readFileSync(options.promptFile, "utf-8"),
  });

  finalizeSpawnResult("codex-ambient", result);

  return {
    commandArgv,
    runtimeBoundary: "codex-ambient",
    warnings: [AMBIENT_WARNING],
  };
}

export function runIsolatedCodexDispatch(options: CodexDispatchOptions): DispatchProcessResult {
  const homeDir = options.homeDir ?? homedir();
  const envGraceMs = Number.parseInt(process.env.CIRCUIT_CODEX_GRACE_MS ?? "", 10);
  const graceMs = options.graceMs ?? (Number.isFinite(envGraceMs) ? envGraceMs : DEFAULT_GRACE_MS);
  const processOps = defaultProcessOps();
  const runtimeInfo = resolveCodexRuntimeRoot(options.cwd ?? process.cwd(), homeDir);
  const launchId = randomUUID();
  const launchTmpDir = join(runtimeInfo.runtimeRoot, "tmp", launchId);
  const reportPath = buildReportPath(runtimeInfo.runtimeRoot, launchId);

  mkdirSync(runtimeInfo.runtimeRoot, { recursive: true });
  mkdirSync(join(runtimeInfo.runtimeRoot, "reports"), { recursive: true });

  const report = initializeReport(
    runtimeInfo.runtimeRoot,
    runtimeInfo.workspaceRoot,
    launchId,
    launchTmpDir,
  );

  try {
    const janitor = janitorCodexRuntime({
      processOps,
      runtimeRoot: runtimeInfo.runtimeRoot,
    });
    report.cleanupActions.push(...janitor.cleanupActions);
    report.ownedArtifactsFound.push(...janitor.ownedArtifactsFound);
    for (const warning of janitor.warnings) {
      appendWarning(report, warning);
    }

    mkdirSync(launchTmpDir, { recursive: true });
    writeLaunchReport(reportPath, report);

    writeTextFileAtomic(
      join(runtimeInfo.runtimeRoot, "config.toml"),
      buildIsolatedCodexConfig(runtimeInfo.workspaceRoot),
    );
    bootstrapCodexAuth(runtimeInfo.runtimeRoot, homeDir);

    const commandArgv = [
      "codex",
      "exec",
      "--full-auto",
      "--ephemeral",
      "-C",
      runtimeInfo.workspaceRoot,
      "-o",
      options.outputFile,
      "-",
    ];
    let pidPath: string | null = null;
    const spawnPidFile = resolve(launchTmpDir, "codex-child.pid");
    const launchResult = spawnSync(
      process.execPath,
      [
        "-e",
        CODEX_LAUNCHER_SOURCE,
        runtimeInfo.workspaceRoot,
        options.promptFile,
        commandArgv[0],
        ...commandArgv.slice(1),
      ],
      {
        cwd: runtimeInfo.workspaceRoot,
        encoding: "utf-8",
        env: {
          ...buildSanitizedEnv(
            options.baseEnv ?? process.env,
            homeDir,
            runtimeInfo.runtimeRoot,
            launchTmpDir,
          ),
          [CODEX_SPAWN_PID_FILE]: spawnPidFile,
        },
      },
    );

    const spawnedCodexPid = readSpawnedCodexPid(spawnPidFile);
    if (spawnedCodexPid) {
      pidPath = persistLaunchPid(runtimeInfo.runtimeRoot, {
        launchId,
        launchTmpDir,
        pgid: spawnedCodexPid,
        pid: spawnedCodexPid,
        runtimeRoot: runtimeInfo.runtimeRoot,
        startedAt: report.startedAt,
      });
    }

    report.exitStatus = launchResult.status ?? null;
    report.finishedAt = reportNow();
    finalizeIsolatedReport(report, reportPath, pidPath, processOps, graceMs);
    finalizeSpawnResult("codex-isolated", launchResult);

    return {
      commandArgv,
      diagnosticsPath: reportPath,
      runtimeBoundary: "codex-isolated",
      warnings: [...report.warnings],
    };
  } catch (error) {
    report.finishedAt = report.finishedAt ?? reportNow();
    writeLaunchReport(reportPath, report);
    if (
      error instanceof Error
      && error.message.includes("Codex login required")
      && !error.message.includes(reportPath)
    ) {
      throw new Error(`${error.message}\nDiagnostics: ${reportPath}`);
    }
    throw error;
  }
}
