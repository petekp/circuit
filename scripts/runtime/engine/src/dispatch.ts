import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";

import { loadCircuitConfig, type LoadCircuitConfigOptions } from "./config.js";

const PUBLIC_DISPATCH_ROLES = ["implementer", "reviewer", "researcher"] as const;

type PublicDispatchRole = typeof PUBLIC_DISPATCH_ROLES[number];
type DispatchTransport = "agent" | "process";

interface DispatchConfigShape {
  adapters: Record<string, string[]>;
  circuits: Record<string, string>;
  defaultAdapter?: string;
  roles: Partial<Record<PublicDispatchRole, string>>;
}

interface DispatchResolution {
  adapter: string;
  commandArgv?: string[];
  resolvedFrom: string;
  transport: DispatchTransport;
}

interface AgentParams {
  description: string;
  isolation: "worktree";
  output_path: string;
  prompt: string;
}

export interface DispatchReceipt {
  adapter: string;
  agent_params?: AgentParams;
  command_argv?: string[];
  output_file: string;
  prompt_file: string;
  resolved_from: string;
  status: "completed" | "ready";
  transport: DispatchTransport;
}

export interface DispatchTaskOptions extends LoadCircuitConfigOptions {
  adapterOverride?: string;
  circuit?: string;
  outputFile: string;
  promptFile: string;
  role?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertString(value: unknown, message: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(message);
  }
}

function normalizeRole(role?: string): PublicDispatchRole | undefined {
  if (!role) {
    return undefined;
  }

  if (PUBLIC_DISPATCH_ROLES.includes(role as PublicDispatchRole)) {
    return role as PublicDispatchRole;
  }

  throw new Error(
    `circuit: unsupported dispatch role "${role}". Use implementer, reviewer, or researcher`,
  );
}

function loadDispatchConfig(config: Record<string, unknown>): DispatchConfigShape {
  if ("roles" in config) {
    throw new Error('circuit: legacy dispatch key "roles" was removed; use "dispatch.roles"');
  }

  const rawDispatch = config.dispatch;
  if (rawDispatch === undefined || rawDispatch === null) {
    return {
      adapters: {},
      circuits: {},
      roles: {},
    };
  }

  if (!isRecord(rawDispatch)) {
    throw new Error('circuit: "dispatch" must be a mapping');
  }

  for (const legacyKey of ["commands", "engine", "per_circuit", "per_step"]) {
    if (legacyKey in rawDispatch) {
      throw new Error(`circuit: legacy dispatch key "dispatch.${legacyKey}" was removed`);
    }
  }

  const parsed: DispatchConfigShape = {
    adapters: {},
    circuits: {},
    roles: {},
  };

  if ("default" in rawDispatch && rawDispatch.default !== undefined) {
    assertString(rawDispatch.default, 'circuit: "dispatch.default" must be a non-empty string');
    parsed.defaultAdapter = rawDispatch.default;
  }

  if ("roles" in rawDispatch && rawDispatch.roles !== undefined) {
    if (!isRecord(rawDispatch.roles)) {
      throw new Error('circuit: "dispatch.roles" must be a mapping');
    }

    for (const [key, value] of Object.entries(rawDispatch.roles)) {
      const normalizedRole = normalizeRole(key);
      if (!normalizedRole) {
        throw new Error(
          `circuit: unsupported dispatch role "${key}". Use implementer, reviewer, or researcher`,
        );
      }
      assertString(value, `circuit: "dispatch.roles.${key}" must be a non-empty string`);
      parsed.roles[normalizedRole] = value;
    }
  }

  if ("circuits" in rawDispatch && rawDispatch.circuits !== undefined) {
    if (!isRecord(rawDispatch.circuits)) {
      throw new Error('circuit: "dispatch.circuits" must be a mapping');
    }

    for (const [key, value] of Object.entries(rawDispatch.circuits)) {
      assertString(value, `circuit: "dispatch.circuits.${key}" must be a non-empty string`);
      parsed.circuits[key] = value;
    }
  }

  if ("adapters" in rawDispatch && rawDispatch.adapters !== undefined) {
    if (!isRecord(rawDispatch.adapters)) {
      throw new Error('circuit: "dispatch.adapters" must be a mapping');
    }

    for (const [adapterName, adapterValue] of Object.entries(rawDispatch.adapters)) {
      if (adapterName === "agent" || adapterName === "codex") {
        throw new Error(`circuit: "${adapterName}" is a reserved built-in adapter name`);
      }
      if (!isRecord(adapterValue)) {
        throw new Error(`circuit: "dispatch.adapters.${adapterName}" must be a mapping`);
      }

      const command = adapterValue.command;
      if (!Array.isArray(command)) {
        throw new Error(
          `circuit: "dispatch.adapters.${adapterName}.command" must be an argv array`,
        );
      }
      if (command.length === 0) {
        throw new Error(
          `circuit: "dispatch.adapters.${adapterName}.command" cannot be empty`,
        );
      }

      parsed.adapters[adapterName] = command.map((entry, index) => {
        assertString(
          entry,
          `circuit: "dispatch.adapters.${adapterName}.command[${index}]" must be a non-empty string`,
        );
        return entry;
      });
    }
  }

  return parsed;
}

function commandExists(command: string): boolean {
  const result = spawnSync("sh", ["-c", `command -v "${command}" >/dev/null 2>&1`], {
    encoding: "utf-8",
  });

  return result.status === 0;
}

function resolveDispatchAdapter(
  config: Record<string, unknown>,
  options: Pick<DispatchTaskOptions, "adapterOverride" | "circuit" | "role">,
  configPath?: string | null,
): DispatchResolution {
  const dispatch = loadDispatchConfig(config);
  const role = normalizeRole(options.role);

  let selected = options.adapterOverride;
  let resolvedFrom = "override";

  if (!selected) {
    if (role && dispatch.roles[role]) {
      selected = dispatch.roles[role];
      resolvedFrom = `dispatch.roles.${role}`;
    } else if (options.circuit && dispatch.circuits[options.circuit]) {
      selected = dispatch.circuits[options.circuit];
      resolvedFrom = `dispatch.circuits.${options.circuit}`;
    } else if (dispatch.defaultAdapter) {
      selected = dispatch.defaultAdapter;
      resolvedFrom = "dispatch.default";
    } else {
      selected = "auto";
      resolvedFrom = "auto";
    }
  }

  if (selected === "auto") {
    selected = commandExists("codex") ? "codex" : "agent";
  }

  if (selected === "agent") {
    return {
      adapter: "agent",
      resolvedFrom,
      transport: "agent",
    };
  }

  if (selected === "codex") {
    return {
      adapter: "codex",
      commandArgv: ["codex", "exec", "--full-auto"],
      resolvedFrom,
      transport: "process",
    };
  }

  const commandArgv = dispatch.adapters[selected];
  if (!commandArgv) {
    throw new Error(
      `circuit: unknown adapter "${selected}". Use agent, codex, auto, or configure dispatch.adapters.${selected}.command`,
    );
  }

  return {
    adapter: selected,
    commandArgv:
      configPath && commandArgv.length > 0 && !isAbsolute(commandArgv[0])
        ? [resolvePath(dirname(configPath), commandArgv[0]), ...commandArgv.slice(1)]
        : commandArgv,
    resolvedFrom,
    transport: "process",
  };
}

function extractDescription(prompt: string): string {
  const lines = prompt.split(/\r?\n/);
  const heading = lines.find((line) => line.startsWith("# "));
  if (heading) {
    return heading.slice(2).trim();
  }

  const firstNonEmpty = lines.find((line) => line.trim().length > 0);
  return firstNonEmpty?.trim() || "worker task";
}

function runProcessAdapter(
  resolution: DispatchResolution,
  promptFile: string,
  outputFile: string,
): string[] {
  if (!resolution.commandArgv || resolution.commandArgv.length === 0) {
    throw new Error(`circuit: adapter "${resolution.adapter}" has no command argv`);
  }

  const commandArgv =
    resolution.adapter === "codex"
      ? [...resolution.commandArgv, "-o", outputFile, "-"]
      : [...resolution.commandArgv, promptFile, outputFile];

  if (resolution.adapter === "codex" && !commandExists("codex")) {
    throw new Error('circuit: adapter "codex" requires the codex CLI to be installed');
  }

  const result = spawnSync(commandArgv[0], commandArgv.slice(1), {
    encoding: "utf-8",
    input: resolution.adapter === "codex" ? readFileSync(promptFile, "utf-8") : undefined,
  });

  if (result.error) {
    throw new Error(`circuit: adapter "${resolution.adapter}" failed to start: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout]
      .filter((value) => value && value.trim().length > 0)
      .join("\n")
      .trim();
    throw new Error(
      `circuit: adapter "${resolution.adapter}" exited with status ${result.status}${detail ? `\n${detail}` : ""}`,
    );
  }

  return commandArgv;
}

export function dispatchTask(options: DispatchTaskOptions): DispatchReceipt {
  if (!options.promptFile || !options.outputFile) {
    throw new Error("circuit: --prompt and --output are required. Run with --prompt <file> --output <file>.");
  }
  if (!existsSync(options.promptFile)) {
    throw new Error(
      `circuit: prompt file not found: ${options.promptFile}. Run compose-prompt.sh first to assemble it.`,
    );
  }

  const { config, path: configPath } = loadCircuitConfig(options);
  const resolution = resolveDispatchAdapter(config, options, configPath);

  if (resolution.transport === "agent") {
    const prompt = readFileSync(options.promptFile, "utf-8");
    return {
      adapter: resolution.adapter,
      agent_params: {
        description: extractDescription(prompt),
        isolation: "worktree",
        output_path: options.outputFile,
        prompt,
      },
      output_file: options.outputFile,
      prompt_file: options.promptFile,
      resolved_from: resolution.resolvedFrom,
      status: "ready",
      transport: "agent",
    };
  }

  const commandArgv = runProcessAdapter(resolution, options.promptFile, options.outputFile);
  return {
    adapter: resolution.adapter,
    command_argv: commandArgv,
    output_file: options.outputFile,
    prompt_file: options.promptFile,
    resolved_from: resolution.resolvedFrom,
    status: "completed",
    transport: "process",
  };
}
