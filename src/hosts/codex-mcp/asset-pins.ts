import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';

const MAX_ASSET_BYTES = 512 * 1024 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const FLOW_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const RUNTIME_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

export type McpRuntimeAssetRole =
  | 'node'
  | 'codex'
  | 'plugin_runtime'
  | 'git_helper'
  | 'packaged_flow';

const AbsolutePath = z.string().min(1).max(8_192).refine(isAbsolute, 'must be an absolute path');
const Sha256 = z.string().regex(SHA256_PATTERN);

export const McpRuntimeAssetPinV1 = z
  .object({
    id: z.string().min(1).max(128),
    role: z.enum(['node', 'codex', 'plugin_runtime', 'git_helper', 'packaged_flow']),
    source_path: AbsolutePath,
    real_path: AbsolutePath,
    device: z.string().min(1).max(64),
    inode: z.string().min(1).max(64),
    mode: z.number().int().nonnegative().max(0xffff_ffff),
    byte_length: z.number().int().nonnegative().max(MAX_ASSET_BYTES),
    sha256: Sha256,
  })
  .strict();
export type McpRuntimeAssetPin = z.infer<typeof McpRuntimeAssetPinV1>;

export const McpRuntimeAssetPinsV1 = z
  .object({
    schema_version: z.literal(1),
    digest_sha256: Sha256,
    assets: z.array(McpRuntimeAssetPinV1).min(1).max(512),
  })
  .strict();
export type McpRuntimeAssetPins = Readonly<
  Omit<z.infer<typeof McpRuntimeAssetPinsV1>, 'assets'> & {
    readonly assets: readonly McpRuntimeAssetPin[];
  }
>;

export interface McpRuntimeAssetPaths {
  readonly node: string;
  readonly codex: string;
  readonly plugin_runtimes: readonly { readonly id: string; readonly path: string }[];
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
  if (paths.plugin_runtimes.length === 0) {
    throw new Error('at least one plugin runtime is required');
  }
  const runtimeIds = new Set<string>();
  for (const runtime of paths.plugin_runtimes) {
    if (!RUNTIME_ID_PATTERN.test(runtime.id)) {
      throw new Error(`invalid plugin runtime id '${runtime.id}'`);
    }
    if (runtimeIds.has(runtime.id)) {
      throw new Error(`duplicate plugin runtime id '${runtime.id}'`);
    }
    runtimeIds.add(runtime.id);
  }
  const flowIds = new Set<string>();
  for (const flow of paths.packaged_flows) {
    if (!FLOW_ID_PATTERN.test(flow.id)) throw new Error(`invalid packaged flow id '${flow.id}'`);
    if (flowIds.has(flow.id)) throw new Error(`duplicate packaged flow id '${flow.id}'`);
    flowIds.add(flow.id);
  }

  const specifications = [
    { id: 'node', role: 'node' as const, path: paths.node, executable: true },
    { id: 'codex', role: 'codex' as const, path: paths.codex, executable: true },
    ...[...paths.plugin_runtimes]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((runtime) => ({
        id: `plugin_runtime:${runtime.id}`,
        role: 'plugin_runtime' as const,
        path: runtime.path,
        executable: false,
      })),
    {
      id: 'git_helper',
      role: 'git_helper' as const,
      path: paths.git_helper,
      executable: true,
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
  const parsed = McpRuntimeAssetPinsV1.safeParse(pins);
  if (!parsed.success || pinDigest(pins.assets) !== pins.digest_sha256) {
    throw new AssetDriftError('Circuit runtime asset pins are invalid or changed');
  }

  for (const expected of pins.assets) {
    await verifyMcpRuntimeAsset(expected);
  }
}

/**
 * Revalidates one sealed asset at the last responsible moment before use.
 *
 * This closes accidental drift between the worker's initial full verification
 * and a later subprocess launch. It is not a defense against a malicious
 * same-user process racing replacement after this check.
 */
export async function verifyMcpRuntimeAsset(expected: McpRuntimeAssetPin): Promise<void> {
  const parsed = McpRuntimeAssetPinV1.safeParse(expected);
  if (!parsed.success) {
    throw new AssetDriftError('Circuit runtime asset pin is invalid or changed');
  }

  let observed: McpRuntimeAssetPin;
  try {
    observed = await pinOne({
      id: expected.id,
      role: expected.role,
      path: expected.source_path,
      executable:
        expected.role === 'node' || expected.role === 'codex' || expected.role === 'git_helper',
    });
  } catch (error) {
    if (error instanceof AssetDriftError) throw error;
    throw new AssetDriftError(`${expected.id} asset changed: ${describeError(error)}`);
  }
  if (!samePin(expected, observed)) {
    throw new AssetDriftError(`${expected.id} asset changed after Circuit pinned it`);
  }
}
