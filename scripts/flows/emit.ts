// Build-time emit + CI drift check for generated flow package JSON files.
//
// Reads the active schematics declared by each flow package and
// compiles each to a CompileResult via
// src/flows/compile-schematic-to-flow.ts (consumed here through
// dist/), then writes canonical JSON files under generated/flows/<id>/.
// Every canonical compiled-flow JSON file also gets a matching
// *.work-contract.v0.json projection under generated/flows/<id>/.
// Public flows mirror only the compiled-flow JSON to the Claude Code package
// under plugins/claude/skills/<id>/ and Codex host output under
// plugins/codex/flows/<id>/. Internal flows stay under generated/flows
// and are not installed into host-visible plugin surfaces.
//
// File layout:
//   - kind:'single'   → generated/flows/<id>/circuit.json
//                        plus circuit.work-contract.v0.json
//   - kind:'per-mode' → group compiled flows by graph identity
//                       The largest group goes to circuit.json; remaining
//                       modes get one file each
//                       at generated/flows/<id>/<mode-name>.json.
//                       Each compiled flow file gets a matching
//                       <name>.work-contract.v0.json projection.
//                       The CLI loader prefers <mode>.json when an axis
//                       tuple needs a distinct graph and falls back to
//                       circuit.json.
//
// Modes:
//   node scripts/flows/emit.ts            → emit (write to disk)
//   node scripts/flows/emit.ts --check    → drift check (no write;
//                                               exit 1 if any output differs
//                                               from the committed file)
//
// Drift check pipeline mirrors emit exactly: compile → JSON.stringify(2) →
// biome format → compare bytes against committed file. Anything that makes
// emit output differ from committed bytes makes the check fail.

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';

import type * as CatalogModule from '../../src/flows/catalog.js';
import type * as CompilerModule from '../../src/flows/compile-schematic-to-flow.js';
import type * as FlowBlockDefinitionsModule from '../../src/schemas/flow-block-definitions.js';
import type * as FlowSchematicModule from '../../src/schemas/flow-schematic.js';
import type * as WorkContractProjectionModule from '../../src/shared/work-contract-projection.js';
import {
  renderClaudeHostCommand,
  renderCodexHostCommand,
  renderCodexHostSkill,
} from './host-renderers.ts';

type CompileResult = CompilerModule.CompileResult;
type CompiledFlow = Extract<CompileResult, { kind: 'single' }>['flow'];
type SchematicEntry = {
  id: string;
  visibility: 'public' | 'internal';
  schematicPath: string;
  definitionSourcePath: string;
  schematic: FlowSchematicModule.FlowSchematic;
  commandSourcePath: string | undefined;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Project root for every read, write, and sweep in this script.
// CIRCUIT_EMIT_PROJECT_ROOT overrides it so tests can run emit/check against
// a disposable copy of the artifact tree instead of planting fixtures in the
// real repo. The override root must provide dist/ and node_modules/
// (symlinks are fine) plus the generated artifact trees.
const projectRoot = process.env.CIRCUIT_EMIT_PROJECT_ROOT
  ? resolve(process.env.CIRCUIT_EMIT_PROJECT_ROOT)
  : resolve(__dirname, '../..');

// SCHEMATICS is loaded from src/flows/catalog.ts (compiled to dist/)
// so adding a flow doesn't require touching this script. The compiled
// catalog is read once at startup and snapshotted into the constant
// below for the rest of the script.
async function loadSchematicsFromCatalog(): Promise<SchematicEntry[]> {
  const catalogPath = resolve(projectRoot, 'dist/flows/catalog.js');
  try {
    const mod = (await import(catalogPath)) as typeof CatalogModule;
    const definitionsById = new Map(
      mod.flowDefinitions.map((definition) => [definition.id, definition]),
    );
    return mod.flowPackages.map((pkg) => ({
      id: pkg.id,
      visibility: pkg.visibility ?? 'public',
      schematicPath: pkg.paths.schematic,
      definitionSourcePath: `src/flows/${pkg.id}/data.ts`,
      schematic: definitionsById.get(pkg.id)?.schematic ?? failMissingDefinition(pkg.id),
      commandSourcePath: pkg.paths.command,
    }));
  } catch (err) {
    console.error(
      `\nCould not import flow catalog from dist/. Run \`npm run build\` first, then re-run this script.\n${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
}

function failMissingDefinition(flowId: string): never {
  throw new Error(`flow package '${flowId}' has no matching FlowDefinition export in catalog`);
}

const SCHEMATICS = await loadSchematicsFromCatalog();
const CLAUDE_PLUGIN_ROOT_REL = 'plugins/claude';
const CODEX_PLUGIN_ROOT_REL = 'plugins/codex';
const SOURCE_COMMAND_ROOT_REL = 'src/commands';
const GENERATED_SURFACE_MAP_REL = 'docs/generated-surfaces.md';
const BLOCK_CATALOG_REL = 'docs/flows/block-catalog.json';
const HOST_DIRECT_COMMANDS = ['handoff', 'run'];
const CLI_ONLY_COMMANDS = ['create', 'uninstall'];
const ROOT_CLAUDE_MARKETPLACE_REL = '.claude-plugin/marketplace.json';
const OBSOLETE_ROOT_HOST_SURFACES = ['commands', 'hooks'];

// Slash command source files either live next to their flow under
// src/flows/<id>/command.md or, for direct/router commands, under
// src/commands/<id>.md. Host packages receive generated command copies.

function markdownList(items: string[]): string {
  if (items.length === 0) return 'none';
  return items.map((item) => `\`${item}\``).join('<br>');
}

function markdownTableRow(cells: string[]): string {
  return `| ${cells.join(' | ')} |`;
}

function renderSurfaceInventory(): string {
  const rows = [
    [
      'Block catalog',
      '`src/schemas/flow-block-definitions.ts`',
      '`npm run build && node scripts/flows/emit.ts`',
      'no',
      '`docs/flows/block-catalog.json`',
      '`node scripts/flows/emit.ts --check`',
      'The JSON catalog is generated for docs; typed block definitions own current facts.',
    ],
    [
      'Flow-owned commands',
      '`src/flows/<id>/command.md`',
      '`scripts/flows/emit.ts`',
      'source yes; outputs no',
      '`plugins/claude/commands/<id>.md`<br>`plugins/codex/commands/<id>.md`<br>`plugins/codex/skills/<id>/SKILL.md`',
      '`node scripts/flows/emit.ts --check`',
      'Only public flows with `paths.command` emit these surfaces. Generated headers are omitted to preserve host command and skill parsing.',
    ],
    [
      'Host direct command sources',
      '`src/commands/<id>.md`',
      '`scripts/flows/emit.ts` mirrors to host plugin surfaces',
      'source yes; outputs no',
      '`plugins/claude/commands/<id>.md`<br>`plugins/codex/commands/<id>.md`<br>`plugins/codex/skills/<id>/SKILL.md`',
      '`node scripts/flows/emit.ts --check`',
      'Covers visible host utilities such as run and handoff.',
    ],
    [
      'CLI-only utility sources',
      '`src/commands/<id>.md`',
      'none',
      'source yes',
      'none',
      'normal CLI and docs tests',
      'Covers utilities such as create that remain available through `./bin/circuit` but are not published as host command or skill surfaces.',
    ],
    [
      'Generated schematic files',
      '`src/flows/<id>/data.ts` + `src/flows/<id>/flow.ts`',
      '`npm run build && node scripts/flows/emit.ts`',
      'no',
      '`src/flows/<id>/schematic.json`',
      '`node scripts/flows/emit.ts --check`',
      'JSON schematics are generated from typed FlowData plus the flow adapter.',
    ],
    [
      'Generated compiled flow manifests',
      '`src/flows/<id>/data.ts` + `src/flows/<id>/flow.ts`',
      '`npm run build && node scripts/flows/emit.ts`',
      'no',
      '`generated/flows/<id>/circuit.json`<br>`generated/flows/<id>/<mode>.json`',
      '`node scripts/flows/emit.ts --check`',
      'Canonical compiled-flow outputs. JSON cannot carry generated headers without changing host parsing.',
    ],
    [
      'Generated WorkContract projections',
      '`src/flows/<id>/data.ts` + `src/shared/work-contract-projection.ts`',
      '`npm run build && node scripts/flows/emit.ts`',
      'no',
      '`generated/flows/<id>/*.work-contract.v0.json`',
      '`node scripts/flows/emit.ts --check`',
      'Generated contract projections sit beside each compiled flow file. Runtime cutover is separate; these files make contract refs real and drift-checked.',
    ],
    [
      'Claude plugin flow mirrors',
      '`generated/flows/<id>/*.json`',
      '`scripts/flows/emit.ts`',
      'no',
      '`plugins/claude/skills/<id>/*.json`',
      '`node scripts/flows/emit.ts --check`',
      'Public flows only. Mirrors compiled-flow JSON. WorkContract projections remain canonical under generated/flows and are projected by runtime code from compiled flows. Internal flow mirrors are stale and fail drift checks.',
    ],
    [
      'Codex plugin flow mirrors',
      '`generated/flows/<id>/*.json`',
      '`scripts/flows/emit.ts`',
      'no',
      '`plugins/codex/flows/<id>/*.json`',
      '`node scripts/flows/emit.ts --check`',
      'Public flows only. Mirrors compiled-flow JSON. WorkContract projections remain canonical under generated/flows and are projected by runtime code from compiled flows. Internal flow mirrors are stale and fail drift checks.',
    ],
    [
      'Codex plugin command mirrors',
      'flow-owned command sources or direct command sources',
      '`scripts/flows/emit.ts`',
      'no',
      '`plugins/codex/commands/<id>.md`',
      '`node scripts/flows/emit.ts --check`',
      'Generated headers are omitted to preserve host command parsing and byte-for-byte mirror checks.',
    ],
    [
      'Codex plugin skill surfaces',
      'flow-owned command sources or direct command sources',
      '`scripts/flows/emit.ts`',
      'no',
      '`plugins/codex/skills/<id>/SKILL.md`',
      '`node scripts/flows/emit.ts --check`',
      'Skill metadata is generated from script-owned metadata plus command source body. The renderer removes slash-command placeholders and source-authority footers for Codex-native invocation.',
    ],
    [
      'Plugin runtime bundle',
      '`src/**` engine (bundled via `dist/cli/circuit.js`)',
      '`npm run build-plugin-runtime` (`node scripts/plugins/runtime-bundle.ts`)',
      'no',
      '`plugins/claude/runtime/circuit.js`<br>`plugins/codex/runtime/circuit.js`',
      '`npm run check-plugin-runtime` (runs under `npm run check-flow-drift`)',
      'esbuild bundle of the whole CLI engine that each host loads at runtime, plus the `runtime/git-state.ts` and `scripts/launcher-core.ts` sidecars. Editing any engine source under `src/` restales this bundle even when `node scripts/flows/emit.ts --check` reports clean; `npm run emit-flows` rebuilds it.',
    ],
    [
      'Command ownership note',
      '`src/commands/README.md`',
      'none',
      'yes',
      '`src/commands/README.md`',
      'normal docs review',
      'Documents direct command source ownership; host command files are generated mirrors.',
    ],
  ];
  return [
    '## Surface Inventory',
    '',
    markdownTableRow([
      'Surface',
      'Source of truth',
      'Generator',
      'Human-editable',
      'Expected destinations',
      'Validation / drift check',
      'Notes',
    ]),
    markdownTableRow(['---', '---', '---', '---', '---', '---', '---']),
    ...rows.map((row) => markdownTableRow(row)),
    '',
  ].join('\n');
}

function commandSurfacesForEntry(entry: SchematicEntry): string[] {
  if (entry.visibility !== 'public') return [];
  if (entry.commandSourcePath !== undefined) {
    return [
      `${CLAUDE_PLUGIN_ROOT_REL}/commands/${entry.id}.md`,
      `${CODEX_PLUGIN_ROOT_REL}/commands/${entry.id}.md`,
      `${CODEX_PLUGIN_ROOT_REL}/skills/${entry.id}/SKILL.md`,
    ];
  }
  if (HOST_DIRECT_COMMANDS.includes(entry.id)) {
    return [
      `${CLAUDE_PLUGIN_ROOT_REL}/commands/${entry.id}.md`,
      `${CODEX_PLUGIN_ROOT_REL}/commands/${entry.id}.md`,
      `${CODEX_PLUGIN_ROOT_REL}/skills/${entry.id}/SKILL.md`,
    ];
  }
  return [];
}

function commandSourceForEntry(entry: SchematicEntry): string {
  if (entry.visibility !== 'public') return 'none';
  if (entry.commandSourcePath !== undefined) return `\`${entry.commandSourcePath}\``;
  if (HOST_DIRECT_COMMANDS.includes(entry.id))
    return `\`${SOURCE_COMMAND_ROOT_REL}/${entry.id}.md\``;
  return 'none';
}

function editRuleForEntry(entry: SchematicEntry): string {
  if (entry.commandSourcePath !== undefined) {
    return 'Edit the flow package source; run `npm run emit-flows`.';
  }
  if (HOST_DIRECT_COMMANDS.includes(entry.id)) {
    return 'Edit the direct command source; run `npm run emit-flows`.';
  }
  if (entry.visibility === 'internal') {
    return 'Edit the flow package; host mirrors must not exist.';
  }
  return 'Edit the flow package; run `npm run emit-flows`.';
}

async function renderGeneratedSurfaceMap(): Promise<string> {
  const flowRows: string[] = [];
  for (const entry of SCHEMATICS) {
    const result = await compileOneSchematic(entry.schematic);
    const plan = planSchematicFiles(entry.id, result);
    const compiledOutputs = plan.flatMap((p) => [
      p.outRel,
      workContractRelForCompiledFlowRel(p.outRel),
    ]);
    const hostMirrors =
      entry.visibility === 'public'
        ? plan.flatMap((p) => [claudeHostRel(p.outRel), codexHostRel(p.outRel)])
        : [];
    flowRows.push(
      markdownTableRow([
        `\`${entry.id}\``,
        `\`${entry.visibility}\``,
        `\`${entry.definitionSourcePath}\`<br>\`src/flows/${entry.id}/flow.ts\`<br>generates \`${entry.schematicPath}\``,
        markdownList(compiledOutputs),
        entry.visibility === 'public' ? markdownList(hostMirrors) : 'none; internal flow',
        commandSourceForEntry(entry),
        markdownList(commandSurfacesForEntry(entry)),
        editRuleForEntry(entry),
      ]),
    );
  }

  const commandRows = HOST_DIRECT_COMMANDS.map((command) =>
    markdownTableRow([
      `\`${command}\``,
      `\`${SOURCE_COMMAND_ROOT_REL}/${command}.md\``,
      markdownList([
        `${CLAUDE_PLUGIN_ROOT_REL}/commands/${command}.md`,
        `${CODEX_PLUGIN_ROOT_REL}/commands/${command}.md`,
        `${CODEX_PLUGIN_ROOT_REL}/skills/${command}/SKILL.md`,
      ]),
      'Edit the direct command source; run `npm run emit-flows`.',
    ]),
  );
  const cliOnlyRows = CLI_ONLY_COMMANDS.map((command) =>
    markdownTableRow([
      `\`${command}\``,
      `\`${SOURCE_COMMAND_ROOT_REL}/${command}.md\``,
      'none',
      'Edit the CLI utility source and run focused CLI tests. No host mirrors should exist.',
    ]),
  );

  return `${[
    '# Generated Surface Source Map',
    '',
    '<!-- Generated by scripts/flows/emit.ts. Edit sources, not this output. -->',
    '',
    'Circuit command surfaces, compiled flow outputs, host mirrors, and edit rules.',
    '',
    '## Edit Rules',
    '',
    '- FlowData is authored in `src/flows/<id>/data.ts`; `src/flows/<id>/flow.ts` binds that plain value to the compiler.',
    '- Block definitions are authored in `src/schemas/flow-block-definitions.ts`.',
    '- Flow schematic JSON files under `src/flows/<id>/schematic.json` are generated outputs.',
    '- Flow-owned commands are authored in `src/flows/<id>/command.md`.',
    '- Direct commands are authored in `src/commands/<id>.md`.',
    '- Canonical compiled manifests under `generated/flows/**` are generated outputs.',
    '- Host mirrors under `plugins/claude/skills/**`, `plugins/claude/commands/**`, `plugins/codex/flows/**`, `plugins/codex/commands/**`, and `plugins/codex/skills/**` are generated outputs.',
    '- Internal flows emit only under `generated/flows/**`; host mirrors for internal flows are stale and fail the drift check.',
    '- After editing an authored source, run `npm run build && npm run emit-flows`, then verify.',
    '- Editing engine source under `src/` (runtime, CLI, schemas) restales the plugin runtime bundle; `npm run emit-flows` rebuilds it and `npm run check-flow-drift` is the gate that catches a stale bundle.',
    '',
    '## Host Package Map',
    '',
    'Use [plugins/README.md](../plugins/README.md) before reading host package trees. It separates hand-authored manifests, hooks, and scripts from generated commands, skills, flow mirrors, and runtime bundles.',
    '',
    '## Codex Host Surface Guidance',
    '',
    'The Codex plugin currently ships both `plugins/codex/commands/<id>.md` and `plugins/codex/skills/<id>/SKILL.md` generated outputs. The plugin manifest points Codex at `./skills/`, so skill files must stay runnable host instructions. Command files remain generated mirrors and authority/reference surfaces. Do not delete either surface without changing the Codex plugin contract, the emitter, and the drift checks together.',
    '',
    'Codex skill files intentionally translate slash-command wording into skill-safe wording. They must not contain `$ARGUMENTS`, `argument-hint`, `/circuit:`, or source-only `## Authority` footers. If the host gains a smaller native presentation wrapper, change `scripts/flows/host-renderers.ts`, regenerate, and run `npm run check-flow-drift`.',
    '',
    renderSurfaceInventory(),
    '## Flow Outputs',
    '',
    markdownTableRow([
      'Flow',
      'Visibility',
      'Definition source',
      'Generated flow package outputs',
      'Host flow mirrors',
      'Command source',
      'Command surfaces',
      'Edit rule',
    ]),
    markdownTableRow(['---', '---', '---', '---', '---', '---', '---', '---']),
    ...flowRows,
    '',
    '## Direct Commands',
    '',
    'Direct commands are source files under `src/commands/` that are mirrored into host packages.',
    '',
    markdownTableRow(['Command', 'Command source', 'Host mirrors', 'Edit rule']),
    markdownTableRow(['---', '---', '---', '---']),
    ...commandRows,
    '',
    '## CLI-only Utilities',
    '',
    'CLI-only utilities are source files under `src/commands/` that remain callable through `./bin/circuit` but are intentionally hidden from host command and skill surfaces.',
    '',
    markdownTableRow(['Utility', 'Source', 'Host mirrors', 'Edit rule']),
    markdownTableRow(['---', '---', '---', '---']),
    ...cliOnlyRows,
    '',
    '## Drift Check',
    '',
    '`npm run check-flow-drift` is the canonical gate for every generated surface in this map. It runs `node scripts/flows/emit.ts --check` (this file, the generated block catalog, generated schematics, generated manifests, command mirrors, host flow mirrors, stale per-mode siblings, stale internal host mirrors, stale host command files, and stale Codex skill directories) and then `npm run check-plugin-runtime` (the plugin runtime bundle and its sidecars). Running `node scripts/flows/emit.ts --check` on its own reports clean while the runtime bundle is stale, so any edit to engine source under `src/` must clear the full `check-flow-drift` gate.',
    '',
  ].join('\n')}\n`;
}

function expectedCodexSkillIds(): Set<string> {
  return new Set([
    ...SCHEMATICS.filter(
      (entry) => entry.visibility === 'public' && entry.commandSourcePath !== undefined,
    ).map((entry) => entry.id),
    ...HOST_DIRECT_COMMANDS,
  ]);
}

function expectedHostCommandIds(): Set<string> {
  return new Set([
    ...SCHEMATICS.filter(
      (entry) => entry.visibility === 'public' && entry.commandSourcePath !== undefined,
    ).map((entry) => entry.id),
    ...HOST_DIRECT_COMMANDS,
  ]);
}

function findStaleCodexSkillDirs(expected: Set<string>): string[] {
  const skillsRoot = resolve(projectRoot, `${CODEX_PLUGIN_ROOT_REL}/skills`);
  if (!existsSync(skillsRoot)) return [];
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !expected.has(entry.name))
    .map((entry) => `${CODEX_PLUGIN_ROOT_REL}/skills/${entry.name}`);
}

function findStaleHostCommandFiles(expected: Set<string>): string[] {
  const stale: string[] = [];
  for (const rootRel of [
    `${CLAUDE_PLUGIN_ROOT_REL}/commands`,
    `${CODEX_PLUGIN_ROOT_REL}/commands`,
  ]) {
    const rootAbs = resolve(projectRoot, rootRel);
    if (!existsSync(rootAbs)) continue;
    for (const entry of readdirSync(rootAbs, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const id = entry.name.slice(0, -'.md'.length);
      if (!expected.has(id)) stale.push(`${rootRel}/${entry.name}`);
    }
  }
  return stale;
}

async function loadCompilerModule(): Promise<typeof CompilerModule> {
  // dist/flows/compile-schematic-to-flow.js is produced by `npm run
  // build`. The emit script depends on a fresh dist/, so callers should
  // run `npm run build` first (the verify pipeline does this in order).
  const distPath = resolve(projectRoot, 'dist/flows/compile-schematic-to-flow.js');
  try {
    return (await import(distPath)) as typeof CompilerModule;
  } catch (err) {
    console.error(
      `\nCould not import compiler from dist/. Run \`npm run build\` first, then re-run this script.\n${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
}

async function loadFlowBlockDefinitionsModule(): Promise<typeof FlowBlockDefinitionsModule> {
  const distPath = resolve(projectRoot, 'dist/schemas/flow-block-definitions.js');
  try {
    return (await import(distPath)) as typeof FlowBlockDefinitionsModule;
  } catch (err) {
    console.error(
      `\nCould not import block definitions from dist/. Run \`npm run build\` first, then re-run this script.\n${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
}

async function loadWorkContractProjectionModule(): Promise<typeof WorkContractProjectionModule> {
  const distPath = resolve(projectRoot, 'dist/shared/work-contract-projection.js');
  try {
    return (await import(distPath)) as typeof WorkContractProjectionModule;
  } catch (err) {
    console.error(
      `\nCould not import WorkContract projection from dist/. Run \`npm run build\` first, then re-run this script.\n${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
}

async function compileOneSchematic(
  schematic: FlowSchematicModule.FlowSchematic,
): Promise<CompileResult> {
  const { compileSchematicToCompiledFlow } = await loadCompilerModule();
  return compileSchematicToCompiledFlow(schematic);
}

function stringifySchematic(schematic: FlowSchematicModule.FlowSchematic): string {
  return `${JSON.stringify(schematic, null, 2)}\n`;
}

function stringifyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function stringifyCompiledFlow(flow: CompiledFlow): string {
  return `${JSON.stringify(flow, null, 2)}\n`;
}

function biomeFormatInPlace(absolutePath: string): void {
  execFileSync('npx', ['biome', 'format', '--write', absolutePath], {
    cwd: projectRoot,
    stdio: 'pipe',
  });
}

// Run the same biome formatter the artifacts use, but resolve to a string
// instead of mutating a committed file in place. Writes raw bytes to a path
// inside the shared scratch dir, biome-formats it there, and reads the result
// back. Used so emit and check produce byte-identical formatted output through
// one code path. The scratch path's basename is derived from relPath so biome
// applies the same per-extension formatting it would for the real file.
function biomeFormatToString(relPath: string, rawBytes: string, scratchDir: string): string {
  const scratchFile = join(scratchDir, relPath.replace(/[/]/g, '_'));
  writeFileSync(scratchFile, rawBytes);
  biomeFormatInPlace(scratchFile);
  return readFileSync(scratchFile, 'utf8');
}

// One declarative generated artifact. computeBytes() returns the FINAL intended
// bytes (already biome-formatted for biome-managed kinds). The four message
// fields are the exact console strings each mode prints, captured per-artifact
// so emit and check stay byte-identical to the legacy per-kind functions.
type ArtifactDescriptor = {
  relPath: string;
  computeBytes: () => string;
  emitMessage: string;
  checkOkMessage: string;
  checkMissingMessage: string;
  checkDriftMessage: readonly string[];
  // Only the markdown mirrors have a meaningful source-missing path: their
  // bytes are derived from a source file that could be absent. When set and
  // computeBytes() throws, check reports this and counts as drift; emit
  // re-throws (matching the legacy copy, which would fail outright).
  sourceMissingMessage?: string;
};

// The single write-vs-compare primitive. Mirrors scripts/release/shared.ts's
// writeOrCheck, but message-driven (each descriptor owns its exact strings) and
// reporting drift via a boolean rather than throwing, because the drift check
// aggregates across many artifacts before exiting once.
//
// emit:  mkdir -p, write final bytes, log emitMessage.
// check: read committed bytes, compare to final bytes; log ok / missing /
//        drift; return true on any drift so the caller can set its flag.
function emitOrCheck(descriptor: ArtifactDescriptor, mode: 'emit' | 'check'): boolean {
  const abs = resolve(projectRoot, descriptor.relPath);
  let bytes: string;
  try {
    bytes = descriptor.computeBytes();
  } catch (err) {
    if (mode === 'check' && descriptor.sourceMissingMessage !== undefined) {
      console.error(descriptor.sourceMissingMessage);
      return true;
    }
    throw err;
  }
  if (mode === 'emit') {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, bytes);
    console.log(descriptor.emitMessage);
    return false;
  }
  let committedBytes: string;
  try {
    committedBytes = readFileSync(abs, 'utf8');
  } catch (_err) {
    console.error(descriptor.checkMissingMessage);
    return true;
  }
  if (bytes === committedBytes) {
    console.log(descriptor.checkOkMessage);
    return false;
  }
  for (const line of descriptor.checkDriftMessage) {
    console.error(line);
  }
  return true;
}

// Stable structural identity for grouping per-mode flows. Two compiled flows
// belong to the same group when their stringified form is byte-identical.
// JSON.stringify is deterministic for our object construction order.
function graphIdentityHash(flow: CompiledFlow): string {
  return JSON.stringify(flow);
}

type SchematicFilePlan = {
  outRel: string;
  flow: CompiledFlow;
};

// Decide the per-schematic file plan: what to write and where. Exposed so the
// emit and check paths share the same logic.
function planSchematicFiles(id: string, result: CompileResult): SchematicFilePlan[] {
  if (result.kind === 'single') {
    return [
      {
        outRel: `generated/flows/${id}/circuit.json`,
        flow: result.flow,
      },
    ];
  }
  // per-mode
  const groups = new Map<string, { modes: string[]; flow: CompiledFlow }>();
  for (const [modeName, flow] of result.flows) {
    const hash = graphIdentityHash(flow);
    const existing = groups.get(hash);
    if (existing === undefined) {
      groups.set(hash, { modes: [modeName], flow });
    } else {
      existing.modes.push(modeName);
    }
  }
  // Sort by group size descending, then by first mode name for deterministic
  // tie-breaking.
  const ordered = [...groups.values()].sort((a, b) => {
    if (b.modes.length !== a.modes.length) return b.modes.length - a.modes.length;
    const aFirst = a.modes[0] ?? '';
    const bFirst = b.modes[0] ?? '';
    return aFirst.localeCompare(bFirst);
  });
  const plan: SchematicFilePlan[] = [];
  // Largest group → circuit.json.
  const main = ordered[0];
  if (main === undefined) return plan;
  plan.push({
    outRel: `generated/flows/${id}/circuit.json`,
    flow: main.flow,
  });
  // Remaining groups → one file per mode in those groups.
  for (let i = 1; i < ordered.length; i++) {
    const group = ordered[i];
    if (group === undefined) continue;
    for (const modeName of group.modes) {
      const flow = result.flows.get(modeName);
      if (flow === undefined) {
        throw new Error(`compiler returned no flow for mode '${modeName}' in '${id}'`);
      }
      plan.push({
        outRel: `generated/flows/${id}/${modeName}.json`,
        flow,
      });
    }
  }
  return plan;
}

function claudeHostRel(canonicalRel: string): string {
  return canonicalRel.replace(/^generated\/flows\//, `${CLAUDE_PLUGIN_ROOT_REL}/skills/`);
}

function claudeHostPlan(plan: SchematicFilePlan[]): SchematicFilePlan[] {
  return plan.map((p) => ({ ...p, outRel: claudeHostRel(p.outRel) }));
}

function codexHostRel(canonicalRel: string): string {
  return canonicalRel.replace(/^generated\/flows\//, `${CODEX_PLUGIN_ROOT_REL}/flows/`);
}

function codexHostPlan(plan: SchematicFilePlan[]): SchematicFilePlan[] {
  return plan.map((p) => ({ ...p, outRel: codexHostRel(p.outRel) }));
}

function workContractRelForCompiledFlowRel(compiledFlowRel: string): string {
  if (!compiledFlowRel.endsWith('.json') || compiledFlowRel.endsWith('.work-contract.v0.json')) {
    throw new Error(`compiled flow path '${compiledFlowRel}' is not a compiled-flow JSON path`);
  }
  return compiledFlowRel.replace(/\.json$/, '.work-contract.v0.json');
}

function expectedJsonRelsForPlan(
  plan: SchematicFilePlan[],
  options: { includeWorkContracts?: boolean } = {},
): string[] {
  return plan.flatMap((p) =>
    options.includeWorkContracts === false
      ? [p.outRel]
      : [p.outRel, workContractRelForCompiledFlowRel(p.outRel)],
  );
}

// Returns the set of unexpected `*.json` files in a generated flow directory:
// anything on disk under `<rootRel>/<id>/` that ends in `.json`
// but isn't in the emit plan. These are stale per-mode siblings from a
// renamed/collapsed axis selection.
function findStaleSiblings(
  id: string,
  plan: SchematicFilePlan[],
  rootRel: string,
  options: { includeWorkContracts?: boolean } = {},
): string[] {
  const skillDirAbs = resolve(projectRoot, `${rootRel}/${id}`);
  if (!existsSync(skillDirAbs)) return [];
  const expected = new Set(expectedJsonRelsForPlan(plan, options).map((rel) => basename(rel)));
  return readdirSync(skillDirAbs)
    .filter((name) => name.endsWith('.json') && !expected.has(name))
    .map((name) => `${rootRel}/${id}/${name}`);
}

function internalHostMirrorDirs(entry: SchematicEntry): string[] {
  if (entry.visibility !== 'internal') return [];
  return [
    `${CLAUDE_PLUGIN_ROOT_REL}/skills/${entry.id}`,
    `${CODEX_PLUGIN_ROOT_REL}/flows/${entry.id}`,
  ];
}

function findExistingInternalHostMirrorDirs(entry: SchematicEntry): string[] {
  return internalHostMirrorDirs(entry).filter((rel) => existsSync(resolve(projectRoot, rel)));
}

function findObsoleteRootHostSurfaces(): string[] {
  const surfaces = OBSOLETE_ROOT_HOST_SURFACES.filter((rel) =>
    existsSync(resolve(projectRoot, rel)),
  );
  const rootClaudePluginRel = '.claude-plugin';
  const rootClaudePluginAbs = resolve(projectRoot, rootClaudePluginRel);
  if (!existsSync(rootClaudePluginAbs)) return surfaces;

  for (const entry of readdirSync(rootClaudePluginAbs)) {
    const rel = `${rootClaudePluginRel}/${entry}`;
    if (rel !== ROOT_CLAUDE_MARKETPLACE_REL) {
      surfaces.push(rel);
    }
  }
  return surfaces;
}

// ---------------------------------------------------------------------------
// Declarative artifact descriptors.
//
// Each generated artifact is described once as an ArtifactDescriptor; both emit
// and check iterate the same flat list through emitOrCheck. The descriptor list
// is the single source of truth for what gets generated and for the
// expected-paths set the stale/orphan sweep consumes. The genuinely asymmetric
// sweep (emit deletes, check reports) stays in the walkers, fed by these
// relPaths.
// ---------------------------------------------------------------------------

function blockCatalogDescriptor(catalog: unknown, scratchDir: string): ArtifactDescriptor {
  return {
    relPath: BLOCK_CATALOG_REL,
    computeBytes: () => biomeFormatToString(BLOCK_CATALOG_REL, stringifyJson(catalog), scratchDir),
    emitMessage: `emitted ${BLOCK_CATALOG_REL} from src/schemas/flow-block-definitions.ts`,
    checkOkMessage: `✓ ${BLOCK_CATALOG_REL} is in sync with src/schemas/flow-block-definitions.ts`,
    checkMissingMessage: `✗ ${BLOCK_CATALOG_REL} is missing on disk but src/schemas/flow-block-definitions.ts generates it. Run \`npm run emit-flows\` to regenerate, then commit.`,
    checkDriftMessage: [
      `✗ ${BLOCK_CATALOG_REL} drifted from src/schemas/flow-block-definitions.ts`,
      '  Run `npm run emit-flows` to regenerate, then commit the diff.',
    ],
  };
}

function schematicDescriptor(entry: SchematicEntry, scratchDir: string): ArtifactDescriptor {
  return {
    relPath: entry.schematicPath,
    computeBytes: () =>
      biomeFormatToString(entry.schematicPath, stringifySchematic(entry.schematic), scratchDir),
    emitMessage: `emitted ${entry.schematicPath} from ${entry.definitionSourcePath}`,
    checkOkMessage: `✓ ${entry.schematicPath} is in sync with ${entry.definitionSourcePath}`,
    checkMissingMessage: `✗ ${entry.schematicPath} is missing on disk but ${entry.definitionSourcePath} generates it. Run \`npm run emit-flows\` to regenerate, then commit.`,
    checkDriftMessage: [
      `✗ ${entry.schematicPath} drifted from ${entry.definitionSourcePath}`,
      '  Run `npm run emit-flows` to regenerate, then commit the diff.',
    ],
  };
}

// Per-flow compiled outputs, in the exact per-plan-item interleave the legacy
// walkers produced: for each plan item, the canonical compiled JSON, its
// WorkContract projection, then (public flows only) the Claude and Codex host
// mirrors. The compiled bytes are biome-formatted once per plan item and reused
// by the mirrors, matching the legacy emit (which copied the just-written
// canonical file) and check (which compared host bytes to the canonical
// compiled bytes).
function flowCompiledDescriptors(
  entry: SchematicEntry,
  plan: SchematicFilePlan[],
  projectWorkContractProjectionV0: typeof WorkContractProjectionModule.projectWorkContractProjectionV0,
  scratchDir: string,
): ArtifactDescriptor[] {
  const descriptors: ArtifactDescriptor[] = [];
  for (const { outRel, flow } of plan) {
    const compiledBytes = (): string =>
      biomeFormatToString(outRel, stringifyCompiledFlow(flow), scratchDir);
    descriptors.push({
      relPath: outRel,
      computeBytes: compiledBytes,
      emitMessage: `emitted ${outRel}`,
      checkOkMessage: `✓ ${outRel} is in sync with ${entry.schematicPath}`,
      checkMissingMessage: `✗ ${outRel} is missing on disk but the schematic compiles to it. Run \`npm run emit-flows\` to regenerate, then commit.`,
      checkDriftMessage: [
        `✗ ${outRel} drifted from compiled output of ${entry.schematicPath}`,
        '  Run `npm run emit-flows` to regenerate, then commit the diff.',
      ],
    });
    const contractRel = workContractRelForCompiledFlowRel(outRel);
    descriptors.push({
      relPath: contractRel,
      computeBytes: () =>
        biomeFormatToString(
          contractRel,
          stringifyJson(projectWorkContractProjectionV0({ flow, contractRefPath: contractRel })),
          scratchDir,
        ),
      emitMessage: `emitted ${contractRel}`,
      checkOkMessage: `✓ ${contractRel} is in sync with ${outRel}`,
      checkMissingMessage: `✗ ${contractRel} is missing on disk but ${outRel} projects to it. Run \`npm run emit-flows\` to regenerate, then commit.`,
      checkDriftMessage: [
        `✗ ${contractRel} drifted from WorkContract projection of ${outRel}`,
        '  Run `npm run emit-flows` to regenerate, then commit the diff.',
      ],
    });
    if (entry.visibility !== 'public') continue;
    const hostRel = claudeHostRel(outRel);
    descriptors.push({
      relPath: hostRel,
      computeBytes: compiledBytes,
      emitMessage: `emitted ${hostRel} (claude-code host output)`,
      checkOkMessage: `✓ ${hostRel} mirrors ${outRel}`,
      checkMissingMessage: `✗ ${hostRel} is missing on disk but the claude-code host compiles to it. Run \`npm run emit-flows\` to regenerate, then commit.`,
      checkDriftMessage: [
        `✗ ${hostRel} drifted from canonical ${outRel}`,
        '  Run `npm run emit-flows` to regenerate, then commit the diff.',
      ],
    });
    const codexRel = codexHostRel(outRel);
    descriptors.push({
      relPath: codexRel,
      computeBytes: compiledBytes,
      emitMessage: `emitted ${codexRel} (codex host output)`,
      checkOkMessage: `✓ ${codexRel} mirrors ${outRel}`,
      checkMissingMessage: `✗ ${codexRel} is missing on disk but the codex host compiles to it. Run \`npm run emit-flows\` to regenerate, then commit.`,
      checkDriftMessage: [
        `✗ ${codexRel} drifted from canonical ${outRel}`,
        '  Run `npm run emit-flows` to regenerate, then commit the diff.',
      ],
    });
  }
  return descriptors;
}

// A markdown mirror: copy a source markdown file (optionally transformed) to a
// host destination, without biome formatting. Reproduces copyMarkdownFile /
// checkMarkdownMirror byte-for-byte, including the distinct source-missing,
// dest-missing, and single-line drift messages.
function markdownMirrorDescriptor(
  sourceRel: string,
  destRel: string,
  label: string,
  transform: (content: string) => string = (content) => content,
): ArtifactDescriptor {
  return {
    relPath: destRel,
    computeBytes: () => transform(readFileSync(resolve(projectRoot, sourceRel), 'utf8')),
    emitMessage: `emitted ${destRel} (${label})`,
    checkOkMessage: `✓ ${destRel} is in sync with ${sourceRel}`,
    checkMissingMessage: `✗ ${destRel} is missing on disk; run \`npm run emit-flows\` to regenerate, then commit.`,
    checkDriftMessage: [`✗ ${destRel} drifted from ${sourceRel}; run \`npm run emit-flows\`.`],
    sourceMissingMessage: `✗ ${sourceRel} is missing on disk but ${label} references it.`,
  };
}

// Flow-owned command mirrors (public flows that declare a command source):
// Claude host command, Codex host command, Codex host skill.
function flowCommandDescriptors(entry: SchematicEntry): ArtifactDescriptor[] {
  if (entry.visibility !== 'public') return [];
  if (entry.commandSourcePath === undefined) return [];
  return [
    markdownMirrorDescriptor(
      entry.commandSourcePath,
      `${CLAUDE_PLUGIN_ROOT_REL}/commands/${entry.id}.md`,
      `claude-code host command from ${entry.commandSourcePath}`,
      renderClaudeHostCommand,
    ),
    markdownMirrorDescriptor(
      entry.commandSourcePath,
      `${CODEX_PLUGIN_ROOT_REL}/commands/${entry.id}.md`,
      `codex host command from ${entry.commandSourcePath}`,
      renderCodexHostCommand,
    ),
    markdownMirrorDescriptor(
      entry.commandSourcePath,
      `${CODEX_PLUGIN_ROOT_REL}/skills/${entry.id}/SKILL.md`,
      `codex host skill from ${entry.commandSourcePath}`,
      (content) => renderCodexHostSkill(entry.id, content),
    ),
  ];
}

// Direct host command mirrors (run, handoff): Claude host command, Codex host
// command, Codex host skill, for each direct command in order.
function hostDirectCommandDescriptors(): ArtifactDescriptor[] {
  return HOST_DIRECT_COMMANDS.flatMap((command) => [
    markdownMirrorDescriptor(
      `${SOURCE_COMMAND_ROOT_REL}/${command}.md`,
      `${CLAUDE_PLUGIN_ROOT_REL}/commands/${command}.md`,
      `claude-code host ${command} command`,
      renderClaudeHostCommand,
    ),
    markdownMirrorDescriptor(
      `${SOURCE_COMMAND_ROOT_REL}/${command}.md`,
      `${CODEX_PLUGIN_ROOT_REL}/commands/${command}.md`,
      `codex host ${command} command`,
      renderCodexHostCommand,
    ),
    markdownMirrorDescriptor(
      `${SOURCE_COMMAND_ROOT_REL}/${command}.md`,
      `${CODEX_PLUGIN_ROOT_REL}/skills/${command}/SKILL.md`,
      `codex host ${command} skill`,
      (content) => renderCodexHostSkill(command, content),
    ),
  ]);
}

// The generated surface map. Not biome-formatted; rendered directly to its
// final bytes. Its check ok/missing/drift messages reference the emit script
// rather than a source file.
function surfaceMapDescriptor(renderedBytes: string): ArtifactDescriptor {
  return {
    relPath: GENERATED_SURFACE_MAP_REL,
    computeBytes: () => renderedBytes,
    emitMessage: `emitted ${GENERATED_SURFACE_MAP_REL}`,
    checkOkMessage: `✓ ${GENERATED_SURFACE_MAP_REL} is in sync with scripts/flows/emit.ts`,
    checkMissingMessage: `✗ ${GENERATED_SURFACE_MAP_REL} is missing on disk. Run \`npm run emit-flows\` to regenerate, then commit.`,
    checkDriftMessage: [
      `✗ ${GENERATED_SURFACE_MAP_REL} drifted from scripts/flows/emit.ts. Run \`npm run emit-flows\`.`,
    ],
  };
}

// Build the full flat descriptor list in the exact order the legacy walkers
// produced messages: block catalog, then per flow [schematic, compiled outputs,
// flow command mirrors], then the direct host command mirrors, then the surface
// map. Also returns the per-flow plans so the stale/orphan sweep can consume the
// same expected-paths the descriptors define.
async function buildArtifactDescriptors(scratchDir: string): Promise<{
  descriptors: ArtifactDescriptor[];
  flowPlans: { entry: SchematicEntry; plan: SchematicFilePlan[] }[];
}> {
  const { FLOW_BLOCK_CATALOG } = await loadFlowBlockDefinitionsModule();
  const { projectWorkContractProjectionV0 } = await loadWorkContractProjectionModule();
  const descriptors: ArtifactDescriptor[] = [
    blockCatalogDescriptor(FLOW_BLOCK_CATALOG, scratchDir),
  ];
  const flowPlans: { entry: SchematicEntry; plan: SchematicFilePlan[] }[] = [];
  for (const entry of SCHEMATICS) {
    const result = await compileOneSchematic(entry.schematic);
    const plan = planSchematicFiles(entry.id, result);
    flowPlans.push({ entry, plan });
    descriptors.push(schematicDescriptor(entry, scratchDir));
    descriptors.push(
      ...flowCompiledDescriptors(entry, plan, projectWorkContractProjectionV0, scratchDir),
    );
    descriptors.push(...flowCommandDescriptors(entry));
  }
  descriptors.push(...hostDirectCommandDescriptors());
  descriptors.push(surfaceMapDescriptor(await renderGeneratedSurfaceMap()));
  return { descriptors, flowPlans };
}

// The asymmetric stale/orphan/obsolete sweep, expressed once. emit DELETES and
// logs `removed ...`; check REPORTS via stderr and returns true on any finding.
// Both modes consume the same expected-paths the descriptors define (via the
// per-flow plans and the expected skill/command id sets), so the sweep can never
// drift from what was generated. This stays separate from emitOrCheck on
// purpose: it is the one place where emit and check genuinely diverge.
type StaleSurfacePlan = {
  readonly staleSiblings: readonly string[];
  readonly internalHostMirrorDirs: readonly string[];
  readonly staleCodexSkillDirs: readonly string[];
  readonly staleHostCommandFiles: readonly string[];
  readonly obsoleteRootHostSurfaces: readonly string[];
};

function collectStaleSurfaces(
  flowPlans: { entry: SchematicEntry; plan: SchematicFilePlan[] }[],
): StaleSurfacePlan {
  const expectedSkills = expectedCodexSkillIds();
  const expectedHostCommands = expectedHostCommandIds();
  const staleSiblings: string[] = [];
  const internalHostMirrorDirsToRemove: string[] = [];
  for (const { entry, plan } of flowPlans) {
    staleSiblings.push(
      ...findStaleSiblings(entry.id, plan, 'generated/flows'),
      ...(entry.visibility === 'public'
        ? [
            ...findStaleSiblings(
              entry.id,
              claudeHostPlan(plan),
              `${CLAUDE_PLUGIN_ROOT_REL}/skills`,
              {
                includeWorkContracts: false,
              },
            ),
            ...findStaleSiblings(entry.id, codexHostPlan(plan), `${CODEX_PLUGIN_ROOT_REL}/flows`, {
              includeWorkContracts: false,
            }),
          ]
        : []),
    );
    internalHostMirrorDirsToRemove.push(...findExistingInternalHostMirrorDirs(entry));
  }
  return {
    staleSiblings,
    internalHostMirrorDirs: internalHostMirrorDirsToRemove,
    staleCodexSkillDirs: findStaleCodexSkillDirs(expectedSkills),
    staleHostCommandFiles: findStaleHostCommandFiles(expectedHostCommands),
    obsoleteRootHostSurfaces: findObsoleteRootHostSurfaces(),
  };
}

function removeFileIfPresent(relPath: string): void {
  const abs = resolve(projectRoot, relPath);
  if (existsSync(abs)) unlinkSync(abs);
}

function removeDirIfPresent(relPath: string): void {
  rmSync(resolve(projectRoot, relPath), { recursive: true, force: true });
}

function sweepStaleSurfaces(
  mode: 'emit' | 'check',
  flowPlans: { entry: SchematicEntry; plan: SchematicFilePlan[] }[],
  precomputed?: StaleSurfacePlan,
): boolean {
  let drifted = false;
  const stalePlan = precomputed ?? collectStaleSurfaces(flowPlans);
  for (const { entry } of flowPlans) {
    const staleSiblings = stalePlan.staleSiblings.filter(
      (stale) =>
        stale.startsWith(`generated/flows/${entry.id}/`) ||
        stale.startsWith(`${CLAUDE_PLUGIN_ROOT_REL}/skills/${entry.id}/`) ||
        stale.startsWith(`${CODEX_PLUGIN_ROOT_REL}/flows/${entry.id}/`),
    );
    for (const stale of staleSiblings) {
      if (mode === 'emit') {
        removeFileIfPresent(stale);
        console.log(`removed stale ${stale}`);
      } else {
        console.error(
          `✗ ${stale} is not in the emit plan for ${entry.schematicPath}. Run \`npm run emit-flows\` to clean up stale siblings, then commit the deletion.`,
        );
        drifted = true;
      }
    }
    for (const staleDir of stalePlan.internalHostMirrorDirs.filter((dir) =>
      dir.endsWith(`/${entry.id}`),
    )) {
      if (mode === 'emit') {
        removeDirIfPresent(staleDir);
        console.log(`removed internal host mirror ${staleDir}`);
      } else {
        console.error(
          `✗ ${staleDir} is a stale host mirror for internal flow '${entry.id}'. Run \`npm run emit-flows\` to remove it, then commit the deletion.`,
        );
        drifted = true;
      }
    }
  }
  for (const stale of stalePlan.staleCodexSkillDirs) {
    if (mode === 'emit') {
      removeDirIfPresent(stale);
      console.log(`removed stale ${stale}`);
    } else {
      console.error(
        `✗ ${stale} is not an expected Codex skill. Run \`npm run emit-flows\` to clean up stale skills, then commit the deletion.`,
      );
      drifted = true;
    }
  }
  for (const stale of stalePlan.staleHostCommandFiles) {
    if (mode === 'emit') {
      removeFileIfPresent(stale);
      console.log(`removed stale ${stale}`);
    } else {
      console.error(
        `✗ ${stale} is not an expected host command. Run \`npm run emit-flows\` to clean up stale commands, then commit the deletion.`,
      );
      drifted = true;
    }
  }
  for (const stale of stalePlan.obsoleteRootHostSurfaces) {
    if (mode === 'emit') {
      removeDirIfPresent(stale);
      console.log(`removed obsolete root host surface ${stale}`);
    } else {
      console.error(
        `✗ ${stale} is an obsolete root host surface. Run \`npm run emit-flows\` to remove it, then commit the deletion.`,
      );
      drifted = true;
    }
  }
  return drifted;
}

async function emitMode(): Promise<void> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'flow-emit-'));
  try {
    const { descriptors, flowPlans } = await buildArtifactDescriptors(tmpDir);
    const stalePlan = collectStaleSurfaces(flowPlans);
    for (const descriptor of descriptors) {
      emitOrCheck(descriptor, 'emit');
    }
    sweepStaleSurfaces('emit', flowPlans, stalePlan);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function checkMode(): Promise<void> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'flow-drift-'));
  let drifted = false;
  try {
    const { descriptors, flowPlans } = await buildArtifactDescriptors(tmpDir);
    const stalePlan = collectStaleSurfaces(flowPlans);
    for (const descriptor of descriptors) {
      if (emitOrCheck(descriptor, 'check')) {
        drifted = true;
      }
    }
    if (sweepStaleSurfaces('check', flowPlans, stalePlan)) {
      drifted = true;
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
  if (drifted) process.exit(1);
}

function parseArgs(argv: readonly string[]): { readonly check: boolean } {
  const program = new Command('emit-flows').option('--check');
  program.parse(argv, { from: 'user' });
  return { check: program.opts<{ check?: boolean }>().check === true };
}

const isCheck = parseArgs(process.argv.slice(2)).check;
if (isCheck) {
  await checkMode();
} else {
  await emitMode();
}
