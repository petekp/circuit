import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { CLI_COMMAND_NAMES } from '../../src/cli/command-vocabulary.ts';
import {
  type CurrentSurfaceInventory,
  SurfaceKindSchema,
  type SurfaceReach,
  type SurfaceRecord,
} from './model.ts';

const FlowCatalogSchema = z
  .object({
    flows: z.array(z.object({ id: z.string().min(1) }).passthrough()),
  })
  .passthrough();

const BlockCatalogSchema = z
  .object({
    blocks: z.array(z.object({ id: z.string().min(1) }).passthrough()),
  })
  .passthrough();

const FlowSchematicSchema = z
  .object({
    items: z.array(z.object({ block: z.string().min(1) }).passthrough()),
  })
  .passthrough();

const ReleaseInventorySchema = z
  .object({
    capabilities: z.array(
      z
        .object({
          id: z.string().min(1),
          status: z.string().min(1),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const PublicClaimsSchema = z
  .object({
    claims: z.array(z.object({ id: z.string().min(1) }).passthrough()),
  })
  .passthrough();

const ReleaseProofsSchema = z
  .object({
    scenarios: z.array(
      z
        .object({
          id: z.string().min(1),
          status: z.string().min(1),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const ClaudeHooksSchema = z
  .object({
    hooks: z.record(z.string(), z.unknown()),
  })
  .passthrough();

const CLI_REACH: SurfaceReach[] = [{ channel: 'cli', access: 'direct' }];
const CLAUDE_REACH: SurfaceReach[] = [
  { channel: 'host-command', host: 'claude', access: 'install-gated' },
];
const CODEX_SKILL_REACH: SurfaceReach[] = [
  { channel: 'host-skill', host: 'codex', access: 'install-gated' },
];
const CODEX_MCP_REACH: SurfaceReach[] = [
  { channel: 'mcp', host: 'codex', access: 'install-gated' },
];
const DOCS_REACH: SurfaceReach[] = [{ channel: 'docs', access: 'direct' }];
const INTERNAL_REACH: SurfaceReach[] = [{ channel: 'internal', access: 'direct' }];
const PUBLIC_RUN_REACH: SurfaceReach[] = [...CLI_REACH, ...CLAUDE_REACH, ...CODEX_MCP_REACH];

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readYaml(path: string): unknown {
  return parseYaml(readFileSync(path, 'utf8'));
}

function repositoryPath(repositoryRoot: string, ...parts: string[]): string {
  return join(repositoryRoot, ...parts);
}

function surfacePath(repositoryRoot: string, absolutePath: string): string {
  return relative(repositoryRoot, absolutePath).replaceAll('\\', '/');
}

function uniqueInOrder(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function listFilesRecursively(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...listFilesRecursively(path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

function stringArrayExport(source: string, exportName: string): string[] {
  const marker = `export const ${exportName}`;
  const markerIndex = source.indexOf(marker);
  if (markerIndex === -1) throw new Error(`missing source export ${exportName}`);
  const start = source.indexOf('[', markerIndex);
  const end = source.indexOf(']', start);
  if (start === -1 || end === -1) throw new Error(`cannot read source export ${exportName}`);
  return [...source.slice(start + 1, end).matchAll(/'([^']+)'/g)].map(
    (match) => match[1] as string,
  );
}

function emittedFlowIds(repositoryRoot: string): string[] {
  const generatedFlowsRoot = repositoryPath(repositoryRoot, 'generated', 'flows');
  return readdirSync(generatedFlowsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => existsSync(join(generatedFlowsRoot, entry.name, 'circuit.json')))
    .map((entry) => entry.name)
    .sort();
}

function publicFlowIds(repositoryRoot: string): Set<string> {
  const path = repositoryPath(repositoryRoot, 'generated', 'flows', 'catalog.json');
  const catalog = FlowCatalogSchema.parse(readJson(path));
  return new Set(catalog.flows.map((flow) => flow.id));
}

function activeBlockIds(repositoryRoot: string): Set<string> {
  const flowsRoot = repositoryPath(repositoryRoot, 'src', 'flows');
  const active = new Set<string>();
  for (const entry of readdirSync(flowsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const schematicPath = join(flowsRoot, entry.name, 'schematic.json');
    if (!existsSync(schematicPath)) continue;
    const schematic = FlowSchematicSchema.parse(readJson(schematicPath));
    for (const item of schematic.items) active.add(item.block);
  }
  return active;
}

function publicBlockIds(repositoryRoot: string): Set<string> {
  const publicFlows = publicFlowIds(repositoryRoot);
  const blocks = new Set<string>();
  for (const flow of publicFlows) {
    const schematicPath = repositoryPath(repositoryRoot, 'src', 'flows', flow, 'schematic.json');
    if (!existsSync(schematicPath)) continue;
    const schematic = FlowSchematicSchema.parse(readJson(schematicPath));
    for (const item of schematic.items) blocks.add(item.block);
  }
  return blocks;
}

function frontDoorSurfaces(): SurfaceRecord[] {
  return [
    {
      id: 'front-door:cli:bare',
      kind: 'cli-front-door',
      state: 'active',
      origin: 'declared',
      reach: CLI_REACH,
      source_paths: ['src/cli/circuit.ts', 'src/cli/front-door.ts', 'src/cli/interactive/index.ts'],
    },
    {
      id: 'front-door:cli:help',
      kind: 'cli-front-door',
      state: 'active',
      origin: 'declared',
      reach: CLI_REACH,
      source_paths: ['src/cli/circuit.ts', 'src/cli/help.ts'],
    },
  ];
}

function installPathSurfaces(): SurfaceRecord[] {
  return [
    {
      id: 'install:claude-plugin',
      kind: 'install-path',
      state: 'active',
      origin: 'declared',
      reach: [{ channel: 'install', host: 'claude', access: 'direct' }],
      source_paths: ['README.md', 'plugins/claude/.claude-plugin/plugin.json'],
    },
    {
      id: 'install:codex-plugin',
      kind: 'install-path',
      state: 'active',
      origin: 'declared',
      reach: [{ channel: 'install', host: 'codex', access: 'direct' }],
      source_paths: ['README.md', 'plugins/codex/.codex-plugin/plugin.json'],
    },
    {
      id: 'install:local-cli',
      kind: 'install-path',
      state: 'active',
      origin: 'declared',
      reach: [{ channel: 'install', access: 'direct' }],
      source_paths: ['README.md', 'package.json'],
    },
  ];
}

function applicationSurfaces(): SurfaceRecord[] {
  return [
    {
      id: 'app:designer',
      kind: 'app',
      state: 'active',
      origin: 'declared',
      reach: INTERNAL_REACH,
      source_paths: ['apps/designer/package.json', 'apps/designer/src/App.tsx'],
    },
  ];
}

function cliCommandSurfaces(): SurfaceRecord[] {
  return CLI_COMMAND_NAMES.map((command) => ({
    id: `command:${command}`,
    kind: 'cli-command',
    state: 'active',
    origin: 'derived',
    reach: CLI_REACH,
    source_paths: ['src/cli/command-vocabulary.ts'],
  }));
}

function subcommandSurfaces(repositoryRoot: string): SurfaceRecord[] {
  const handoffPath = 'src/cli/handoff.ts';
  const handoffSource = readFileSync(repositoryPath(repositoryRoot, handoffPath), 'utf8');
  const handoffLeaves = [...handoffSource.matchAll(/addAction\('([^']+)'\)/g)].map(
    (match) => match[1] as string,
  );
  const handoffHookLeaves = [...handoffSource.matchAll(/addHooksAction\('([^']+)'\)/g)].map(
    (match) => `hooks:${match[1] as string}`,
  );

  const commandLeaves = (path: string): string[] => {
    const source = readFileSync(repositoryPath(repositoryRoot, path), 'utf8');
    return uniqueInOrder(
      [...source.matchAll(/\.command\('([^']+)'\)/g)].map((match) => match[1] as string),
    );
  };

  const configPath = 'src/cli/config-command.ts';
  const configSource = readFileSync(repositoryPath(repositoryRoot, configPath), 'utf8');
  const configLeaves = uniqueInOrder(
    [...configSource.matchAll(/action === '([^']+)'/g)].map((match) => match[1] as string),
  );

  const descriptors = [
    ...uniqueInOrder([...handoffLeaves, ...handoffHookLeaves]).map((leaf) => ({
      parent: 'handoff',
      leaf,
      path: handoffPath,
      internal: ['brief', 'hook', 'harvest'].includes(leaf),
    })),
    ...commandLeaves('src/cli/history.ts').map((leaf) => ({
      parent: 'history',
      leaf,
      path: 'src/cli/history.ts',
      internal: false,
    })),
    ...commandLeaves('src/cli/memory.ts').map((leaf) => ({
      parent: 'memory',
      leaf,
      path: 'src/cli/memory.ts',
      internal: false,
    })),
    ...configLeaves.map((leaf) => ({
      parent: 'config',
      leaf,
      path: configPath,
      internal: false,
    })),
    ...commandLeaves('src/cli/runs.ts').map((leaf) => ({
      parent: 'runs',
      leaf,
      path: 'src/cli/runs.ts',
      internal: false,
    })),
  ];

  return descriptors.map(({ parent, leaf, path, internal }) => ({
    id: `subcommand:${parent}:${leaf}`,
    kind: 'cli-subcommand',
    state: 'active',
    origin: 'derived',
    reach: internal ? INTERNAL_REACH : CLI_REACH,
    source_paths: [path],
  }));
}

function cliFlagSurfaces(repositoryRoot: string): SurfaceRecord[] {
  const sourcePath = 'src/cli/run-flag-vocabulary.ts';
  const source = readFileSync(repositoryPath(repositoryRoot, sourcePath), 'utf8');
  const rows = [
    ...source.matchAll(/^\s*\{\s*flag:\s*'([^']+)'.*docValid:\s*(true|false)\s*\},?\s*$/gm),
  ];
  if (rows.length === 0) throw new Error('run flag vocabulary could not be read');
  return rows.map((match) => {
    const flag = match[1] as string;
    const active = match[2] === 'true';
    return {
      id: `flag:${flag}`,
      kind: 'cli-flag',
      state: active ? 'active' : 'dormant',
      origin: 'derived',
      reach: active ? CLI_REACH : INTERNAL_REACH,
      source_paths: [sourcePath],
    };
  });
}

function flowSurfaces(repositoryRoot: string): SurfaceRecord[] {
  const publicIds = publicFlowIds(repositoryRoot);
  return emittedFlowIds(repositoryRoot).map((flow) => {
    const isPublic = publicIds.has(flow);
    return {
      id: `flow:${flow}`,
      kind: 'flow',
      state: 'active',
      origin: 'derived',
      reach: isPublic ? PUBLIC_RUN_REACH : INTERNAL_REACH,
      source_paths: [`generated/flows/${flow}/circuit.json`, `src/flows/${flow}/data.ts`],
    };
  });
}

function blockSurfaces(repositoryRoot: string): SurfaceRecord[] {
  const sourcePath = 'docs/flows/block-catalog.json';
  const catalog = BlockCatalogSchema.parse(readJson(repositoryPath(repositoryRoot, sourcePath)));
  const active = activeBlockIds(repositoryRoot);
  const publicBlocks = publicBlockIds(repositoryRoot);
  return catalog.blocks.map((block) => ({
    id: `block:${block.id}`,
    kind: 'block',
    state: active.has(block.id) ? 'active' : 'dormant',
    origin: 'derived',
    reach: publicBlocks.has(block.id) ? PUBLIC_RUN_REACH : INTERNAL_REACH,
    source_paths: [sourcePath, 'src/schemas/flow-block-definitions.ts'],
  }));
}

function hostKindSurfaces(repositoryRoot: string): SurfaceRecord[] {
  const sourcePath = 'src/schemas/host.ts';
  const source = readFileSync(repositoryPath(repositoryRoot, sourcePath), 'utf8');
  return stringArrayExport(source, 'HostKind').map((host) => ({
    id: `host:${host}`,
    kind: 'host-kind',
    state: 'active',
    origin: 'derived',
    reach:
      host === 'generic-shell'
        ? CLI_REACH
        : host === 'claude-code'
          ? CLAUDE_REACH
          : CODEX_MCP_REACH,
    source_paths: [sourcePath],
  }));
}

function hostCommandSurfaces(repositoryRoot: string): SurfaceRecord[] {
  return (['claude', 'codex'] as const).flatMap((host) => {
    const root = repositoryPath(repositoryRoot, 'plugins', host, 'commands');
    return readdirSync(root)
      .filter((name) => name.endsWith('.md'))
      .sort()
      .map((name) => ({
        id: `host-command:${host}:${name.slice(0, -3)}`,
        kind: 'host-command' as const,
        state: 'active' as const,
        origin: 'derived' as const,
        // Codex activates SKILL.md. Its command files are current authority/reference mirrors.
        reach: host === 'claude' ? CLAUDE_REACH : INTERNAL_REACH,
        source_paths: [`plugins/${host}/commands/${name}`],
      }));
  });
}

function hostSkillSurfaces(repositoryRoot: string): SurfaceRecord[] {
  const root = repositoryPath(repositoryRoot, 'plugins', 'codex', 'skills');
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => existsSync(join(root, entry.name, 'SKILL.md')))
    .map((entry) => ({
      id: `host-skill:codex:${entry.name}`,
      kind: 'host-skill',
      state: 'active',
      origin: 'derived',
      reach: CODEX_SKILL_REACH,
      source_paths: [`plugins/codex/skills/${entry.name}/SKILL.md`],
    }));
}

function hostFlowSurfaces(repositoryRoot: string): SurfaceRecord[] {
  const roots = [
    {
      host: 'claude' as const,
      path: repositoryPath(repositoryRoot, 'plugins', 'claude', 'skills'),
    },
    { host: 'codex' as const, path: repositoryPath(repositoryRoot, 'plugins', 'codex', 'flows') },
  ];
  return roots.flatMap(({ host, path }) =>
    listFilesRecursively(path)
      .filter((file) => file.endsWith('.json'))
      .filter((file) => !(host === 'codex' && surfacePath(path, file) === 'catalog.json'))
      .map((file) => {
        const variant = surfacePath(path, file).slice(0, -'.json'.length);
        return {
          id: `host-flow:${host}:${variant}`,
          kind: 'host-flow' as const,
          state: 'active' as const,
          origin: 'derived' as const,
          reach: host === 'claude' ? CLAUDE_REACH : CODEX_MCP_REACH,
          source_paths: [surfacePath(repositoryRoot, file)],
        };
      }),
  );
}

function hostCatalogSurfaces(): SurfaceRecord[] {
  return [
    {
      id: 'host-catalog:codex:flows',
      kind: 'host-catalog',
      state: 'active',
      origin: 'derived',
      reach: CODEX_SKILL_REACH,
      source_paths: ['plugins/codex/flows/catalog.json'],
    },
  ];
}

function hostHookSurfaces(repositoryRoot: string): SurfaceRecord[] {
  const claudePath = 'plugins/claude/hooks/hooks.json';
  const claudeHooks = ClaudeHooksSchema.parse(readJson(repositoryPath(repositoryRoot, claudePath)));
  const surfaces: SurfaceRecord[] = Object.keys(claudeHooks.hooks)
    .sort()
    .map((event) => ({
      id: `host-hook:claude:${event}`,
      kind: 'host-hook',
      state: 'active',
      origin: 'derived',
      reach: [{ channel: 'host-hook', host: 'claude', access: 'automatic' }],
      source_paths: [claudePath],
    }));

  const codexPath = 'plugins/codex/hooks/session-start.ts';
  if (existsSync(repositoryPath(repositoryRoot, codexPath))) {
    surfaces.push({
      id: 'host-hook:codex:session-start',
      kind: 'host-hook',
      state: 'active',
      origin: 'derived',
      reach: [{ channel: 'host-hook', host: 'codex', access: 'install-gated' }],
      source_paths: [codexPath, 'src/cli/handoff-codex-hooks.ts'],
    });
  }
  return surfaces;
}

function mcpToolSurfaces(repositoryRoot: string): SurfaceRecord[] {
  const sourcePath = 'src/hosts/codex-mcp/contracts.ts';
  const source = readFileSync(repositoryPath(repositoryRoot, sourcePath), 'utf8');
  return stringArrayExport(source, 'MCP_TOOL_NAMES').map((tool) => ({
    id: `mcp-tool:${tool}`,
    kind: 'mcp-tool',
    state: 'active',
    origin: 'derived',
    reach: CODEX_MCP_REACH,
    source_paths: [sourcePath, 'plugins/codex/.mcp.json'],
  }));
}

function connectorSurfaces(repositoryRoot: string): SurfaceRecord[] {
  const sourcePath = 'src/schemas/connector.ts';
  const source = readFileSync(repositoryPath(repositoryRoot, sourcePath), 'utf8');
  const connectorIds = stringArrayExport(source, 'EnabledConnector');
  if (!source.includes('export const CustomConnectorDescriptor')) {
    throw new Error('custom connector descriptor is missing');
  }
  return [...connectorIds, 'custom'].map((connector) => ({
    id: `connector:${connector}`,
    kind: 'connector',
    state: 'active',
    origin: 'derived',
    reach: PUBLIC_RUN_REACH,
    source_paths: [sourcePath],
  }));
}

function configKeySurfaces(repositoryRoot: string): SurfaceRecord[] {
  const sourcePath = 'src/schemas/config.ts';
  const source = readFileSync(repositoryPath(repositoryRoot, sourcePath), 'utf8');
  const start = source.indexOf('export const Config = z');
  const end = source.indexOf('export type Config =', start);
  if (start === -1 || end === -1) throw new Error('Config schema could not be read');
  const keys = uniqueInOrder(
    [...source.slice(start, end).matchAll(/^ {4}([a-z][a-z0-9_]*):/gm)].map(
      (match) => match[1] as string,
    ),
  );
  return keys.map((key) => ({
    id: `config-key:${key}`,
    kind: 'config-key',
    state: 'active',
    origin: 'derived',
    reach: key === 'schema_version' ? INTERNAL_REACH : CLI_REACH,
    source_paths: [sourcePath],
  }));
}

function skillHookSurfaces(repositoryRoot: string): SurfaceRecord[] {
  const sourcePath = 'src/schemas/skill-hook.ts';
  const source = readFileSync(repositoryPath(repositoryRoot, sourcePath), 'utf8');
  const start = source.indexOf('export const SKILL_HOOK_VOCABULARY');
  const end = source.indexOf('] as const;', start);
  if (start === -1 || end === -1) throw new Error('Skill Hook vocabulary could not be read');
  const hooks = [...source.slice(start, end).matchAll(/^ {4}hook: '([^']+)'/gm)].map(
    (match) => match[1] as string,
  );
  const activeHooks = new Set([
    'before:edit-files',
    'after:edit-files',
    'after:verification-failed',
    'after:evidence-gap',
  ]);
  return hooks.map((hook) => {
    const active = activeHooks.has(hook);
    return {
      id: `skill-hook:${hook}`,
      kind: 'skill-hook',
      state: active ? 'active' : 'dormant',
      origin: 'derived',
      reach: active ? PUBLIC_RUN_REACH : INTERNAL_REACH,
      source_paths: [sourcePath, 'src/skill-hooks/dispatch.ts'],
    };
  });
}

function publicClaimSurfaces(repositoryRoot: string): {
  surfaces: SurfaceRecord[];
  ids: string[];
} {
  const sourcePath = 'docs/release/claims/public-claims.yaml';
  const ledger = PublicClaimsSchema.parse(readYaml(repositoryPath(repositoryRoot, sourcePath)));
  const ids = ledger.claims.map((claim) => claim.id);
  return {
    ids,
    surfaces: ids.map((id) => ({
      id: `public-claim:${id}`,
      kind: 'public-claim',
      state: 'active',
      origin: 'derived',
      reach: DOCS_REACH,
      source_paths: [sourcePath],
    })),
  };
}

function positioningClaimSurfaces(repositoryRoot: string): SurfaceRecord[] {
  const sourcePath = 'docs/positioning.md';
  const source = readFileSync(repositoryPath(repositoryRoot, sourcePath), 'utf8');
  const claims = [
    { id: 'positioning:mechanical-check', heading: '### 1. The check is mechanical, not textual' },
    {
      id: 'positioning:isolated-step',
      heading: '### 2. Each step is isolated: its own role, its own tools, its own clean context',
    },
    {
      id: 'positioning:per-step-power-allocation',
      heading: '### 3. One dial allocates models by archetype, per step',
    },
    {
      id: 'positioning:until-proven',
      heading: '### 4. A flow can loop until the goal is proven met',
    },
  ];
  for (const claim of claims) {
    if (!source.includes(claim.heading)) throw new Error(`missing positioning claim ${claim.id}`);
  }
  return claims.map((claim) => ({
    id: claim.id,
    kind: 'positioning-claim',
    state: 'active',
    origin: 'declared',
    reach:
      claim.id === 'positioning:until-proven' ? [...DOCS_REACH, ...INTERNAL_REACH] : DOCS_REACH,
    source_paths: [sourcePath],
  }));
}

function releaseRecordSurfaces(repositoryRoot: string): {
  surfaces: SurfaceRecord[];
  proofIds: string[];
} {
  const capabilityPath = 'generated/release/current-capabilities.json';
  const release = ReleaseInventorySchema.parse(
    readJson(repositoryPath(repositoryRoot, capabilityPath)),
  );
  const proofPath = 'docs/release/proofs/index.yaml';
  const proofs = ReleaseProofsSchema.parse(readYaml(repositoryPath(repositoryRoot, proofPath)));
  const proofIds = proofs.scenarios
    .filter((proof) => proof.status === 'verified_current')
    .map((proof) => proof.id);
  return {
    proofIds,
    surfaces: [
      ...release.capabilities.map((capability) => ({
        id: `release-record:capability:${capability.id}`,
        kind: 'release-record' as const,
        state: ['implemented', 'partial'].includes(capability.status)
          ? ('active' as const)
          : ('dormant' as const),
        origin: 'derived' as const,
        reach: DOCS_REACH,
        source_paths: [capabilityPath],
      })),
      ...proofs.scenarios.map((proof) => ({
        id: `release-record:proof:${proof.id.replace(/^proof:/, '')}`,
        kind: 'release-record' as const,
        state: 'active' as const,
        origin: 'derived' as const,
        reach: DOCS_REACH,
        source_paths: [proofPath],
      })),
    ],
  };
}

function runOutputSurfaces(): SurfaceRecord[] {
  const outputs = [
    { id: 'progress-jsonl', paths: ['src/shared/progress-output.ts', 'src/cli/run.ts'] },
    { id: 'final-json', paths: ['src/cli/run-stdout-envelope.ts'] },
    { id: 'trace-ndjson', paths: ['src/schemas/trace-entry.ts'] },
    { id: 'result-json', paths: ['src/schemas/result.ts'] },
    { id: 'operator-summary-json', paths: ['src/app/operator-summary/writer.ts'] },
    { id: 'operator-summary-markdown', paths: ['src/app/operator-summary/writer.ts'] },
    { id: 'operator-summary-html', paths: ['src/app/operator-summary/writer.ts'] },
    { id: 'run-envelope-json', paths: ['src/app/run-envelope/source-record.ts'] },
    { id: 'process-evidence-json', paths: ['src/app/run-envelope/source-record.ts'] },
    { id: 'run-surface-markdown', paths: ['src/app/run-envelope/source-record.ts'] },
    { id: 'decision-packets', paths: ['src/app/run-envelope/source-record.ts'] },
    { id: 'autonomous-loop-json', paths: ['src/cli/run.ts', 'src/cli/run-stdout-envelope.ts'] },
    { id: 'manifest-snapshot-json', paths: ['src/runtime/run/graph-runner.ts'] },
    {
      id: 'run-envelope-shadow-json',
      paths: ['src/app/run-envelope/shadow-record.ts'],
    },
    { id: 'history-recall-json', paths: ['src/app/history/run-start-recall.ts'] },
    {
      id: 'history-recall-precision-json',
      paths: ['src/app/history/run-start-recall.ts'],
    },
  ];
  return outputs.map((output) => ({
    id: `run-output:${output.id}`,
    kind: 'run-output',
    state: 'active',
    origin: 'declared',
    reach: PUBLIC_RUN_REACH,
    source_paths: output.paths,
  }));
}

export function loadCurrentSurfaceInventory(repositoryRoot: string): CurrentSurfaceInventory {
  const publicClaims = publicClaimSurfaces(repositoryRoot);
  const releaseRecords = releaseRecordSurfaces(repositoryRoot);
  const surfaces: SurfaceRecord[] = [
    ...frontDoorSurfaces(),
    ...installPathSurfaces(),
    ...applicationSurfaces(),
    ...cliCommandSurfaces(),
    ...subcommandSurfaces(repositoryRoot),
    ...cliFlagSurfaces(repositoryRoot),
    ...flowSurfaces(repositoryRoot),
    ...blockSurfaces(repositoryRoot),
    ...hostKindSurfaces(repositoryRoot),
    ...hostCommandSurfaces(repositoryRoot),
    ...hostSkillSurfaces(repositoryRoot),
    ...hostFlowSurfaces(repositoryRoot),
    ...hostCatalogSurfaces(),
    ...hostHookSurfaces(repositoryRoot),
    ...mcpToolSurfaces(repositoryRoot),
    ...connectorSurfaces(repositoryRoot),
    ...configKeySurfaces(repositoryRoot),
    ...skillHookSurfaces(repositoryRoot),
    ...publicClaims.surfaces,
    ...positioningClaimSurfaces(repositoryRoot),
    ...releaseRecords.surfaces,
    ...runOutputSurfaces(),
  ];

  const duplicateIds = surfaces
    .map((surface) => surface.id)
    .filter((id, index, ids) => ids.indexOf(id) !== index);
  if (duplicateIds.length > 0) {
    throw new Error(`duplicate current surface IDs: ${uniqueInOrder(duplicateIds).join(', ')}`);
  }

  return {
    surfaces,
    census_partitions: SurfaceKindSchema.options.map((kind) => ({
      kind,
      state: 'populated' as const,
    })),
    proof_ids: releaseRecords.proofIds,
    public_claim_ids: publicClaims.ids,
  };
}
