import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

const MAX_ASSET_BYTES = 512 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const FLOW_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type McpRuntimeAssetRole =
  | 'node'
  | 'codex'
  | 'plugin_runtime'
  | 'git_helper'
  | 'packaged_flow';

export interface McpRuntimeAssetPin {
  readonly id: string;
  readonly role: McpRuntimeAssetRole;
  readonly source_path: string;
  readonly real_path: string;
  readonly device: string;
  readonly inode: string;
  readonly mode: number;
  readonly byte_length: number;
  readonly sha256: string;
}

export interface McpRuntimeAssetPins {
  readonly schema_version: 1;
  readonly digest_sha256: string;
  readonly assets: readonly McpRuntimeAssetPin[];
}

export interface McpRuntimeAssetPaths {
  readonly node: string;
  readonly codex: string;
  readonly plugin_runtime: string;
  readonly git_helper: string;
  readonly packaged_flows: readonly { readonly id: string; readonly path: string }[];
}

export class AssetDriftError extends Error {
  readonly code = 'runtime_asset_changed' as const;
  readonly nextAction = 'Reinstall the Circuit plugin, then start a new run.';

  constructor(message: string) {
    super(message);
    this.name = 'AssetDriftError';
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function pinDigest(assets: readonly McpRuntimeAssetPin[]): string {
  const projection = assets.map((asset) => ({
    id: asset.id,
    role: asset.role,
    source_path: asset.source_path,
    real_path: asset.real_path,
    device: asset.device,
    inode: asset.inode,
    mode: asset.mode,
    byte_length: asset.byte_length,
    sha256: asset.sha256,
  }));
  return createHash('sha256').update(JSON.stringify(projection)).digest('hex');
}

async function pinOne(input: {
  readonly id: string;
  readonly role: McpRuntimeAssetRole;
  readonly path: string;
  readonly executable: boolean;
}): Promise<McpRuntimeAssetPin> {
  if (!isAbsolute(input.path)) throw new Error(`${input.id} asset path must be absolute`);

  let resolved: string;
  try {
    resolved = await realpath(input.path);
  } catch (error) {
    throw new Error(`${input.id} asset could not be resolved: ${describeError(error)}`);
  }

  const before = await stat(resolved);
  if (!before.isFile()) throw new Error(`${input.id} asset must be a regular file`);
  if (before.size > MAX_ASSET_BYTES) {
    throw new Error(`${input.id} asset exceeds the ${MAX_ASSET_BYTES}-byte limit`);
  }
  if (input.executable && (before.mode & 0o111) === 0) {
    throw new Error(`${input.id} asset must be executable`);
  }

  const sha256 = await sha256File(resolved);
  const after = await stat(resolved);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mode !== after.mode ||
    before.mtimeMs !== after.mtimeMs ||
    before.ctimeMs !== after.ctimeMs
  ) {
    throw new AssetDriftError(`${input.id} asset changed while Circuit was hashing it`);
  }

  return Object.freeze({
    id: input.id,
    role: input.role,
    source_path: input.path,
    real_path: resolved,
    device: String(after.dev),
    inode: String(after.ino),
    mode: after.mode,
    byte_length: after.size,
    sha256,
  });
}

export async function pinMcpRuntimeAssets(
  paths: McpRuntimeAssetPaths,
): Promise<McpRuntimeAssetPins> {
  if (paths.packaged_flows.length === 0) throw new Error('at least one packaged flow is required');
  const flowIds = new Set<string>();
  for (const flow of paths.packaged_flows) {
    if (!FLOW_ID_PATTERN.test(flow.id)) throw new Error(`invalid packaged flow id '${flow.id}'`);
    if (flowIds.has(flow.id)) throw new Error(`duplicate packaged flow id '${flow.id}'`);
    flowIds.add(flow.id);
  }

  const specifications = [
    { id: 'node', role: 'node' as const, path: paths.node, executable: true },
    { id: 'codex', role: 'codex' as const, path: paths.codex, executable: true },
    {
      id: 'plugin_runtime',
      role: 'plugin_runtime' as const,
      path: paths.plugin_runtime,
      executable: false,
    },
    {
      id: 'git_helper',
      role: 'git_helper' as const,
      path: paths.git_helper,
      executable: false,
    },
    ...[...paths.packaged_flows]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((flow) => ({
        id: `flow:${flow.id}`,
        role: 'packaged_flow' as const,
        path: flow.path,
        executable: false,
      })),
  ];

  const assets = await Promise.all(specifications.map(pinOne));
  const realPaths = new Set<string>();
  for (const asset of assets) {
    if (realPaths.has(asset.real_path)) {
      throw new Error(`runtime assets must resolve to distinct files: ${asset.real_path}`);
    }
    realPaths.add(asset.real_path);
  }

  const frozenAssets = Object.freeze(assets);
  return Object.freeze({
    schema_version: 1,
    digest_sha256: pinDigest(frozenAssets),
    assets: frozenAssets,
  });
}

function samePin(left: McpRuntimeAssetPin, right: McpRuntimeAssetPin): boolean {
  return (
    left.id === right.id &&
    left.role === right.role &&
    left.source_path === right.source_path &&
    left.real_path === right.real_path &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.byte_length === right.byte_length &&
    left.sha256 === right.sha256
  );
}

export async function verifyMcpRuntimeAssets(pins: McpRuntimeAssetPins): Promise<void> {
  if (
    pins.schema_version !== 1 ||
    !SHA256_PATTERN.test(pins.digest_sha256) ||
    pinDigest(pins.assets) !== pins.digest_sha256
  ) {
    throw new AssetDriftError('Circuit runtime asset pins are invalid or changed');
  }

  for (const expected of pins.assets) {
    let observed: McpRuntimeAssetPin;
    try {
      observed = await pinOne({
        id: expected.id,
        role: expected.role,
        path: expected.source_path,
        executable: expected.role === 'node' || expected.role === 'codex',
      });
    } catch (error) {
      if (error instanceof AssetDriftError) throw error;
      throw new AssetDriftError(`${expected.id} asset changed: ${describeError(error)}`);
    }
    if (!samePin(expected, observed)) {
      throw new AssetDriftError(`${expected.id} asset changed after Circuit pinned it`);
    }
  }
}
