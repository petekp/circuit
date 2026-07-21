import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CODEX_VERSION_TIMEOUT_MS = 5_000;

function requiredAbsolutePath(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty absolute path.`);
  }
  if (!path.isAbsolute(value)) throw new Error(`${label} must be absolute.`);
  return value;
}

function identityFromStat(value) {
  return {
    device: String(value.dev),
    inode: String(value.ino),
    size: value.size,
    modified_ms: value.mtimeMs,
  };
}

function sameIdentity(left, right) {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modified_ms === right.modified_ms
  );
}

async function defaultVersionProbe(executable) {
  const result = await execFileAsync(executable, ['--version'], {
    encoding: 'utf8',
    timeout: CODEX_VERSION_TIMEOUT_MS,
    maxBuffer: 64 * 1024,
  });
  return result.stdout.trim();
}

function automaticCandidates(options) {
  if (options.platform === 'darwin') {
    return [
      path.join(options.systemApplicationsRoot, 'ChatGPT.app/Contents/Resources/codex'),
      path.join(options.userApplicationsRoot, 'ChatGPT.app/Contents/Resources/codex'),
    ];
  }
  return [];
}

async function executablePin(candidate, source, versionProbe) {
  const realPath = await realpath(candidate);
  const executableStat = await stat(realPath);
  if (!executableStat.isFile()) throw new Error(`Trusted Codex path is not a file: ${candidate}`);
  await access(realPath, constants.X_OK);
  const version = await versionProbe(realPath);
  if (typeof version !== 'string' || !/^codex-cli(?:\s|$)/i.test(version.trim())) {
    throw new Error(`Trusted Codex executable returned an unexpected version: ${String(version)}`);
  }
  return {
    executable: realPath,
    source,
    version: version.trim(),
    identity: identityFromStat(executableStat),
  };
}

/**
 * Resolve Codex without consulting PATH. PATH may include a workspace-owned
 * directory, so it is not a trust source for the MCP server.
 */
export async function discoverTrustedCodexExecutable(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? homedir();
  const versionProbe = options.versionProbe ?? defaultVersionProbe;
  const explicit = [
    ['CIRCUIT_MCP_CODEX_EXECUTABLE', env.CIRCUIT_MCP_CODEX_EXECUTABLE],
    ['CODEX_CLI_PATH', env.CODEX_CLI_PATH],
  ].find((entry) => typeof entry[1] === 'string' && entry[1].length > 0);

  if (explicit !== undefined) {
    const [source, rawPath] = explicit;
    return await executablePin(requiredAbsolutePath(rawPath, source), source, versionProbe);
  }

  const candidates = automaticCandidates({
    platform,
    systemApplicationsRoot: options.systemApplicationsRoot ?? '/Applications',
    userApplicationsRoot: options.userApplicationsRoot ?? path.join(homeDir, 'Applications'),
  });
  for (const candidate of candidates) {
    try {
      return await executablePin(candidate, 'chatgpt-app-bundle', versionProbe);
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
    }
  }

  throw new Error(
    'No trusted Codex executable was found. The MCP host must provide CIRCUIT_MCP_CODEX_EXECUTABLE or CODEX_CLI_PATH as an absolute path.',
  );
}

export async function assertTrustedCodexExecutableUnchanged(pin, options = {}) {
  const versionProbe = options.versionProbe ?? defaultVersionProbe;
  const realPath = await realpath(pin.executable);
  if (realPath !== pin.executable) throw new Error('The trusted Codex executable path changed.');
  const executableStat = await stat(realPath);
  if (!sameIdentity(pin.identity, identityFromStat(executableStat))) {
    throw new Error('The trusted Codex executable changed after it was pinned.');
  }
  const version = (await versionProbe(realPath)).trim();
  if (version !== pin.version) {
    throw new Error('The trusted Codex executable version changed after it was pinned.');
  }
}

export async function discoverTrustedCodexHome(options = {}) {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const explicit = env.CODEX_HOME;
  const source =
    typeof explicit === 'string' && explicit.length > 0 ? 'CODEX_HOME' : 'home-default';
  const candidate =
    source === 'CODEX_HOME'
      ? requiredAbsolutePath(explicit, 'CODEX_HOME')
      : path.join(homeDir, '.codex');
  const realPath = await realpath(candidate);
  const homeStat = await stat(realPath);
  if (!homeStat.isDirectory())
    throw new Error(`Trusted CODEX_HOME is not a directory: ${candidate}`);
  return { path: realPath, source };
}

export async function discoverTrustedCodexHost(options = {}) {
  const [codex, codexHome] = await Promise.all([
    discoverTrustedCodexExecutable(options),
    discoverTrustedCodexHome(options),
  ]);
  return { codex, codexHome };
}
