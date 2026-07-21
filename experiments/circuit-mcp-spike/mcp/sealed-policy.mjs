import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

export const SEALED_POLICY_SCHEMA = 'circuit.mcp.sealed-policy@v1';
export const SEALED_PUBLIC_FLOWS = ['build', 'explore', 'fix', 'prototype', 'review'];
export const WEB_SEARCH_CHOICES = ['off', 'cached'];

export const SEALED_ENV_KEYS = {
  enabled: 'CIRCUIT_MCP_SEALED',
  projectRoot: 'CIRCUIT_MCP_PROJECT_ROOT',
  codexExecutable: 'CIRCUIT_MCP_CODEX_EXECUTABLE',
  webSearchMode: 'CIRCUIT_MCP_WEB_SEARCH_MODE',
  proofRunner: 'CIRCUIT_MCP_PROOF_RUNNER',
  gitStateHelper: 'CIRCUIT_MCP_GIT_STATE_HELPER',
  cancelFile: 'CIRCUIT_MCP_CANCEL_FILE',
};

export const SEALED_RUNTIME_CAPABILITIES = [
  'separate_project_root_from_config_discovery',
  'disable_user_and_project_config',
  'disable_history_recall_and_writes',
  'disable_host_and_skill_hooks',
  'force_builtin_codex',
  'force_codex_web_search_mode',
  'verify_packaged_assets_before_launch',
];

const MAX_PACKAGED_FILES = 256;
const MAX_PACKAGED_BYTES = 32 * 1024 * 1024;
const MAX_MCP_FILES = 256;
const MAX_MCP_BYTES = 32 * 1024 * 1024;

function pathIsInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertFlowName(flow) {
  if (typeof flow !== 'string' || !SEALED_PUBLIC_FLOWS.includes(flow)) {
    throw new Error(`Sealed MCP flow must be one of ${SEALED_PUBLIC_FLOWS.join(', ')}.`);
  }
  return flow;
}

async function assertPlainFile(candidate, label) {
  const fileStat = await lstat(candidate);
  if (fileStat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link.`);
  if (!fileStat.isFile()) throw new Error(`${label} must be a regular file.`);
  return fileStat;
}

async function collectPlainFiles(root, current = root, found = []) {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute);
    const entryStat = await lstat(absolute);
    if (entryStat.isSymbolicLink()) {
      throw new Error(`Packaged flow asset must not be a symbolic link: ${relative}`);
    }
    if (entryStat.isDirectory()) {
      await collectPlainFiles(root, absolute, found);
      continue;
    }
    if (!entryStat.isFile()) {
      throw new Error(`Packaged flow asset must be a regular file: ${relative}`);
    }
    found.push({ absolute, relative, size: entryStat.size });
    if (found.length > MAX_PACKAGED_FILES) {
      throw new Error(`Packaged flow root exceeds ${MAX_PACKAGED_FILES} files.`);
    }
  }
  return found;
}

async function collectMcpFiles(root, current = root, found = []) {
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute);
    const entryStat = await lstat(absolute);
    if (entryStat.isSymbolicLink()) {
      throw new Error(`MCP asset must not be a symbolic link: ${relative}`);
    }
    if (entryStat.isDirectory()) {
      await collectMcpFiles(root, absolute, found);
      continue;
    }
    if (!entryStat.isFile()) throw new Error(`MCP asset must be a regular file: ${relative}`);
    found.push({ absolute, relative, size: entryStat.size });
    if (found.length > MAX_MCP_FILES) {
      throw new Error(`MCP asset root exceeds ${MAX_MCP_FILES} files.`);
    }
  }
  return found;
}

function addDigestPart(hash, label, bytes) {
  const labelBytes = Buffer.from(label, 'utf8');
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(labelBytes.length));
  hash.update(length);
  hash.update(labelBytes);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
}

/** Snapshot only a plugin's fixed runtime/ and flows/ children. */
export async function snapshotPackagedAssets(input) {
  const pluginRoot = await realpath(input.pluginRoot);
  const lexicalRuntime = path.resolve(input.pluginRoot, 'runtime', 'circuit.js');
  const lexicalGitState = path.resolve(input.pluginRoot, 'runtime', 'git-state.js');
  const lexicalFlowRoot = path.resolve(input.pluginRoot, 'flows');
  if (path.resolve(input.runtimePath) !== lexicalRuntime) {
    throw new Error('The sealed runtime must be the plugin-owned runtime/circuit.js.');
  }
  if (path.resolve(input.flowRoot) !== lexicalFlowRoot) {
    throw new Error('The sealed flow root must be the plugin-owned flows directory.');
  }

  const runtimeStat = await assertPlainFile(lexicalRuntime, 'Packaged Circuit runtime');
  const gitStateStat = await assertPlainFile(lexicalGitState, 'Packaged git-state helper');
  const flowRootStat = await lstat(lexicalFlowRoot);
  if (flowRootStat.isSymbolicLink())
    throw new Error('Packaged flow root must not be a symbolic link.');
  if (!flowRootStat.isDirectory()) throw new Error('Packaged flow root must be a directory.');
  const expectedRuntime = await realpath(lexicalRuntime);
  const expectedGitState = await realpath(lexicalGitState);
  const canonicalFlowRoot = await realpath(lexicalFlowRoot);
  if (!pathIsInside(pluginRoot, expectedRuntime)) {
    throw new Error('Packaged Circuit runtime resolves outside the plugin.');
  }
  if (!pathIsInside(pluginRoot, canonicalFlowRoot)) {
    throw new Error('Packaged flow root resolves outside the plugin.');
  }
  if (!pathIsInside(pluginRoot, expectedGitState)) {
    throw new Error('Packaged git-state helper resolves outside the plugin.');
  }

  const files = await collectPlainFiles(canonicalFlowRoot);
  const totalBytes = files.reduce(
    (sum, file) => sum + file.size,
    runtimeStat.size + gitStateStat.size,
  );
  if (totalBytes > MAX_PACKAGED_BYTES) {
    throw new Error(`Packaged runtime and flows exceed ${MAX_PACKAGED_BYTES} bytes.`);
  }

  const flowIds = [];
  for (const flow of SEALED_PUBLIC_FLOWS) {
    const compiledPath = path.join(canonicalFlowRoot, flow, 'circuit.json');
    await assertPlainFile(compiledPath, `Packaged ${flow} flow`);
    const compiled = JSON.parse(await readFile(compiledPath, 'utf8'));
    if (compiled?.id !== flow) {
      throw new Error(`Packaged ${flow} flow declares a different id.`);
    }
    flowIds.push(flow);
  }

  const hash = createHash('sha256');
  addDigestPart(hash, 'runtime/circuit.js', await readFile(expectedRuntime));
  addDigestPart(hash, 'runtime/git-state.js', await readFile(expectedGitState));
  for (const file of files) {
    addDigestPart(hash, `flows/${file.relative}`, await readFile(file.absolute));
  }
  return {
    plugin_root: pluginRoot,
    runtime_path: expectedRuntime,
    git_state_path: expectedGitState,
    flow_root: canonicalFlowRoot,
    flow_ids: flowIds,
    file_count: files.length + 2,
    total_bytes: totalBytes,
    sha256: hash.digest('hex'),
  };
}

export async function assertPackagedAssetsUnchanged(snapshot) {
  const current = await snapshotPackagedAssets({
    pluginRoot: snapshot.plugin_root,
    runtimePath: snapshot.runtime_path,
    flowRoot: snapshot.flow_root,
  });
  if (current.sha256 !== snapshot.sha256) {
    throw new Error('Packaged Circuit runtime or flows changed after they were pinned.');
  }
}

export async function snapshotMcpAssets(rootInput) {
  if (typeof rootInput !== 'string' || !path.isAbsolute(rootInput)) {
    throw new Error('MCP asset root must be absolute.');
  }
  const lexicalRoot = path.resolve(rootInput);
  const rootStat = await lstat(lexicalRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('MCP asset root must be a real directory.');
  }
  const root = await realpath(lexicalRoot);
  if (root !== lexicalRoot) throw new Error('MCP asset root must already be canonical.');
  const files = await collectMcpFiles(root);
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > MAX_MCP_BYTES) {
    throw new Error(`MCP assets exceed ${MAX_MCP_BYTES} bytes.`);
  }
  const hash = createHash('sha256');
  for (const file of files) addDigestPart(hash, file.relative, await readFile(file.absolute));
  return {
    root,
    file_count: files.length,
    total_bytes: totalBytes,
    sha256: hash.digest('hex'),
  };
}

export async function assertMcpAssetsUnchanged(snapshot) {
  const current = await snapshotMcpAssets(snapshot.root);
  if (current.sha256 !== snapshot.sha256) {
    throw new Error('Circuit MCP files changed after they were pinned.');
  }
}

function overlaps(left, right) {
  return pathIsInside(left, right) || pathIsInside(right, left);
}

export async function assertMcpResourcesOutsideWorkspace(input) {
  const workspace = await realpath(input.workspace);
  const stateRoot = await realpath(input.stateRoot);
  const pluginRoot = await realpath(input.pluginRoot);
  const mcpRoot = await realpath(input.mcpRoot);
  const codexHome = await realpath(input.codexHome);
  const files = await Promise.all(
    input.files.map(async ({ path: candidate, label }) => ({
      label,
      path: await realpath(candidate),
    })),
  );

  for (const [label, root] of [
    ['Circuit MCP state', stateRoot],
    ['Circuit plugin', pluginRoot],
    ['Circuit MCP code', mcpRoot],
  ]) {
    if (overlaps(workspace, root)) {
      throw new Error(`${label} must not overlap the writable workspace.`);
    }
  }
  if (pathIsInside(workspace, codexHome)) {
    throw new Error('Codex home must not be inside the writable workspace.');
  }
  for (const file of files) {
    if (pathIsInside(workspace, file.path)) {
      throw new Error(`${file.label} must not be inside the writable workspace.`);
    }
  }
  return { workspace, stateRoot, pluginRoot, mcpRoot, codexHome };
}

export function resolveWebSearchPolicy(value) {
  const choice = value ?? 'off';
  if (!WEB_SEARCH_CHOICES.includes(choice)) {
    throw new Error(`web_search must be one of ${WEB_SEARCH_CHOICES.join(', ')}.`);
  }
  if (choice === 'cached') {
    return {
      choice,
      consent: 'explicit',
      sends_queries_off_machine: true,
      codex_mode: 'cached',
      codex_config: 'web_search="cached"',
    };
  }
  return {
    choice: 'off',
    consent: 'not-granted',
    sends_queries_off_machine: false,
    codex_mode: 'disabled',
    codex_config: 'web_search="disabled"',
  };
}

export async function prepareSealedStateRoot(stateRoot) {
  if (typeof stateRoot !== 'string' || !path.isAbsolute(stateRoot)) {
    throw new Error('Sealed MCP state root must be absolute.');
  }
  const home = path.join(stateRoot, 'sealed-home');
  const xdgConfigHome = path.join(stateRoot, 'sealed-xdg-config');
  const runs = path.join(stateRoot, 'runs');
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(xdgConfigHome, { recursive: true }),
    mkdir(runs, { recursive: true }),
  ]);
  return { home, xdg_config_home: xdgConfigHome, runs };
}

export function assertSealedRuntimeCapabilities(capabilities) {
  const missing = SEALED_RUNTIME_CAPABILITIES.filter((key) => capabilities?.[key] !== true);
  if (missing.length > 0) {
    throw new Error(`Circuit runtime cannot enforce sealed MCP policy yet: ${missing.join(', ')}.`);
  }
}

function requiredAbsolutePath(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path.`);
  }
  return path.resolve(value);
}

/**
 * The exact environment owned by the sealed runtime adapter. Callers merge it
 * over the lifecycle's small host allowlist; this helper never copies ambient
 * environment variables itself.
 */
export function createSealedEnvironment(input) {
  if (input.policy?.schema !== SEALED_POLICY_SCHEMA) {
    throw new Error(`Sealed environment requires ${SEALED_POLICY_SCHEMA}.`);
  }
  const home = requiredAbsolutePath(input.state?.home, 'Sealed HOME');
  const xdgConfigHome = requiredAbsolutePath(
    input.state?.xdg_config_home,
    'Sealed XDG_CONFIG_HOME',
  );
  const runs = requiredAbsolutePath(input.state?.runs, 'Sealed runs root');
  const proofRunner = requiredAbsolutePath(input.proofRunner, 'MCP proof runner');
  const gitStateHelper = requiredAbsolutePath(input.gitStateHelper, 'Packaged git-state helper');
  const cancelFile = requiredAbsolutePath(input.cancelFile, 'MCP cancel file');
  if (!pathIsInside(runs, cancelFile)) {
    throw new Error('MCP cancel file must be inside the sealed runs root.');
  }
  return {
    HOME: home,
    XDG_CONFIG_HOME: xdgConfigHome,
    CODEX_HOME: input.policy.connector.codex_home,
    CIRCUIT_HOST_KIND: 'codex',
    [SEALED_ENV_KEYS.enabled]: '1',
    [SEALED_ENV_KEYS.projectRoot]: input.policy.workspace,
    [SEALED_ENV_KEYS.codexExecutable]: input.policy.connector.executable,
    [SEALED_ENV_KEYS.webSearchMode]: input.policy.web_search.codex_mode,
    [SEALED_ENV_KEYS.proofRunner]: proofRunner,
    [SEALED_ENV_KEYS.gitStateHelper]: gitStateHelper,
    [SEALED_ENV_KEYS.cancelFile]: cancelFile,
  };
}

export function createSealedRunPolicy(input) {
  const flow = assertFlowName(input.flow);
  if (!input.assets.flow_ids.includes(flow)) {
    throw new Error(`Flow ${flow} is not present in the pinned packaged assets.`);
  }
  if (typeof input.workspace !== 'string' || !path.isAbsolute(input.workspace)) {
    throw new Error('Sealed MCP workspace must be absolute.');
  }
  const webSearch = resolveWebSearchPolicy(input.webSearch);
  return {
    schema: SEALED_POLICY_SCHEMA,
    workspace: path.resolve(input.workspace),
    flow: {
      id: flow,
      source: 'packaged',
      root: input.assets.flow_root,
      package_sha256: input.assets.sha256,
    },
    connector: {
      kind: 'builtin',
      name: 'codex',
      executable: input.host.codex.executable,
      executable_version: input.host.codex.version,
      executable_identity: input.host.codex.identity,
      codex_home: input.host.codexHome.path,
    },
    config: { user: 'ignored', project: 'ignored', invocation: 'sealed-only' },
    history: { recall: 'disabled', project_reads: 'disabled', project_writes: 'disabled' },
    hooks: { host: 'disabled', skill: 'disabled', install_assurance: 'disabled' },
    web_search: webSearch,
    required_runtime_capabilities: [...SEALED_RUNTIME_CAPABILITIES],
  };
}
