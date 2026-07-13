import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Command } from 'commander';
import { Document, parseDocument, parse as parseYaml } from 'yaml';
import { Config } from '../schemas/config.js';
import {
  discoverRuntimeConfigLayers,
  projectConfigPath,
  userGlobalConfigPath,
} from '../shared/config-loader.js';
import { commanderErrorMessage, configureCommanderProgram } from './commander-support.js';
import { colorEnabled, terminalPalette } from './terminal-style.js';

// `circuit config` — read and edit the layered selection config
// (~/.config/circuit/config.yaml and ./.circuit/config.yaml) from the command
// line. This is the programmatic half of the configuration surface: the
// interactive shell dispatches through these same functions, so anything the
// menus can do an agent can do with flags.
//
// Writes go through the YAML Document API so operator comments and formatting
// survive, and the whole mutated document must re-validate against the strict
// Config schema before a byte lands on disk — an invalid edit cannot corrupt
// a working config.

export interface ConfigCommandOptions {
  readonly homeDir?: string;
  readonly cwd?: string;
}

type Target = 'project' | 'global';

interface TargetPaths {
  readonly filePath: string;
  readonly layerName: 'project' | 'user-global';
}

function invalid(message: string): number {
  process.stderr.write(`error: ${message}\n`);
  return 2;
}

function targetPaths(target: Target, options: ConfigCommandOptions): TargetPaths {
  return target === 'global'
    ? { filePath: userGlobalConfigPath(options.homeDir), layerName: 'user-global' }
    : { filePath: projectConfigPath(options.cwd), layerName: 'project' };
}

function resolveTarget(opts: { project?: boolean; global?: boolean }): Target | string {
  if (opts.project === true && opts.global === true) {
    return 'pass either --project or --global, not both';
  }
  return opts.global === true ? 'global' : 'project';
}

// The policy envelope (schema_version 2) shares the same file paths but is a
// different document with its own schema; editing it through the selection
// vocabulary would corrupt it.
function isPolicyEnvelope(doc: Document): boolean {
  return doc.getIn(['schema_version']) === 2;
}

function loadDocument(filePath: string): Document | string {
  if (!existsSync(filePath)) {
    const doc = new Document({ schema_version: 1 });
    return doc;
  }
  const doc = parseDocument(readFileSync(filePath, 'utf8'));
  if (isPolicyEnvelope(doc)) {
    return `${filePath} is a policy envelope (schema_version 2); circuit config edits selection config (schema_version 1)`;
  }
  return doc;
}

// Operator-facing rendering of schema rejections. The raw zod issue list is
// precise but speaks parser — `(root): Unrecognized key` or `Invalid input:
// expected object, received string` — and the constitution says every failure
// names a remedy in plain English. Two cases get bespoke wording: unknown
// keys (name the valid keys) and object-typed keys handed a bare scalar
// (name the inline-YAML form that works). Everything else keeps the
// path-prefixed schema message.
const CONNECTOR_REFERENCE_EXAMPLE = "'{kind: builtin, name: codex}'";

// Derived from the schema so the list cannot rot as keys are added.
function topLevelConfigKeys(): string {
  return Object.keys(Config.shape)
    .filter((key) => key !== 'schema_version')
    .join(', ');
}

interface SchemaIssue {
  readonly code?: string;
  readonly path: PropertyKey[];
  readonly message: string;
  readonly keys?: readonly string[];
  readonly expected?: string;
}

function describeIssue(issue: SchemaIssue): string {
  const path = issue.path.map(String).join('.');
  if (issue.code === 'unrecognized_keys') {
    const keys = issue.keys ?? [];
    const named = keys.map((key) => `'${key}'`).join(', ');
    if (issue.path.length === 0) {
      const noun = keys.length === 1 ? 'is not a config key' : 'are not config keys';
      return `${named} ${noun}. Valid top-level keys: ${topLevelConfigKeys()}`;
    }
    const noun = keys.length === 1 ? 'is not a key' : 'are not keys';
    return `${named} ${noun} under ${path}. Check the spelling`;
  }
  const wantsObject = issue.expected === 'object' || issue.message.includes('expected object');
  if (wantsObject && path.length > 0) {
    if (path.startsWith('relay.roles.') || path.startsWith('relay.flows.')) {
      return `${path} takes a connector reference object, not a bare name. Set it with inline YAML: circuit config set ${path} ${CONNECTOR_REFERENCE_EXAMPLE}`;
    }
    return `${path} takes an object value. Pass it as inline YAML, like ${CONNECTOR_REFERENCE_EXAMPLE}`;
  }
  return `${path || '(root)'}: ${issue.message}`;
}

function formatSchemaIssues(err: unknown): string {
  if (err && typeof err === 'object' && 'issues' in err) {
    const issues = (err as { issues: SchemaIssue[] }).issues;
    return issues.map(describeIssue).join('; ');
  }
  return err instanceof Error ? err.message : String(err);
}

function validateDocument(doc: Document): string | undefined {
  const parsed = Config.safeParse(doc.toJS() ?? {});
  return parsed.success ? undefined : formatSchemaIssues(parsed.error);
}

function writeDocument(filePath: string, doc: Document): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, doc.toString());
}

// The write cores are exported for the interactive shell: the menus dispatch
// through these exact functions, so both frontends share one contract (and
// one test surface). They return a result instead of printing so the shell
// can render receipts its own way.
export type ConfigWriteResult =
  | {
      readonly ok: true;
      readonly filePath: string;
      readonly layerName: 'project' | 'user-global';
      // Set when an unset emptied the file of user content and removed it
      // (healthy defaults write no config).
      readonly removedFile?: boolean;
    }
  | { readonly ok: true; readonly noop: 'already-unset'; readonly layerName: string }
  | { readonly ok: false; readonly message: string };

export function applyConfigSet(
  key: string,
  rawValue: string,
  target: Target,
  options: ConfigCommandOptions = {},
): ConfigWriteResult {
  const { filePath, layerName } = targetPaths(target, options);

  const doc = loadDocument(filePath);
  if (typeof doc === 'string') return { ok: false, message: doc };

  let parsedValue: unknown;
  try {
    parsedValue = parseYaml(rawValue);
  } catch {
    return { ok: false, message: `value is not valid YAML: ${rawValue}` };
  }

  try {
    doc.setIn(key.split('.'), parsedValue);
  } catch (err) {
    return {
      ok: false,
      message: `cannot set ${key}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const problem = validateDocument(doc);
  if (problem !== undefined) return { ok: false, message: problem };

  writeDocument(filePath, doc);
  return { ok: true, filePath, layerName };
}

// Healthy defaults write no config (product rule 7). After an unset, a file
// holding nothing but `schema_version` and empty containers is residue, not
// configuration — but only when it is truly empty of user content. Operator
// comments are user content and keep the file. The '#' scan is sound here:
// an empty-of-content document has no string scalars left, so a '#' can only
// be a comment.
function documentIsEmptyOfUserContent(doc: Document): boolean {
  const js = doc.toJS() ?? {};
  if (typeof js !== 'object' || js === null || Array.isArray(js)) return false;
  const hasContent = (value: unknown): boolean => {
    if (value === null || value === undefined) return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.values(value).some(hasContent);
    return true;
  };
  const entries = Object.entries(js as Record<string, unknown>).filter(
    ([key]) => key !== 'schema_version',
  );
  if (entries.some(([, value]) => hasContent(value))) return false;
  return !doc.toString().includes('#');
}

export function applyConfigUnset(
  key: string,
  target: Target,
  options: ConfigCommandOptions = {},
): ConfigWriteResult {
  const { filePath, layerName } = targetPaths(target, options);

  if (!existsSync(filePath)) return { ok: true, noop: 'already-unset', layerName };
  const doc = loadDocument(filePath);
  if (typeof doc === 'string') return { ok: false, message: doc };
  const path = key.split('.');
  if (doc.getIn(path) === undefined) return { ok: true, noop: 'already-unset', layerName };

  doc.deleteIn(path);
  const problem = validateDocument(doc);
  if (problem !== undefined) return { ok: false, message: problem };

  if (documentIsEmptyOfUserContent(doc)) {
    rmSync(filePath);
    return { ok: true, filePath, layerName, removedFile: true };
  }

  writeDocument(filePath, doc);
  return { ok: true, filePath, layerName };
}

function runSet(argv: readonly string[], options: ConfigCommandOptions): number {
  let key: string | undefined;
  let value: string | undefined;
  let flags: { project?: boolean; global?: boolean } = {};
  const program = configureCommanderProgram(new Command('circuit config set'))
    .argument('<key>', 'dotted path into the config, e.g. defaults.power')
    .argument('<value>', 'YAML scalar value, e.g. high')
    .option('--project', 'write ./.circuit/config.yaml (default)')
    .option('--global', 'write ~/.config/circuit/config.yaml')
    .action((k: string, v: string, o: typeof flags) => {
      key = k;
      value = v;
      flags = o;
    });
  try {
    program.parse(argv, { from: 'user' });
  } catch (err) {
    return invalid(commanderErrorMessage(err));
  }
  if (key === undefined || value === undefined) return invalid('set needs a key and a value');

  const target = resolveTarget(flags);
  if (target !== 'project' && target !== 'global') return invalid(target);

  const result = applyConfigSet(key, value, target, options);
  if (!result.ok) return invalid(result.message);
  if ('noop' in result) return 0;

  const palette = terminalPalette(colorEnabled());
  process.stdout.write(
    `${palette.accent('✓')} ${key} ${palette.dim('=')} ${palette.bold(value)} ${palette.dim(`(${result.layerName}: ${result.filePath})`)}\n`,
  );
  return 0;
}

function runUnset(argv: readonly string[], options: ConfigCommandOptions): number {
  let key: string | undefined;
  let flags: { project?: boolean; global?: boolean } = {};
  const program = configureCommanderProgram(new Command('circuit config unset'))
    .argument('<key>', 'dotted path into the config, e.g. defaults.power')
    .option('--project', 'edit ./.circuit/config.yaml (default)')
    .option('--global', 'edit ~/.config/circuit/config.yaml')
    .action((k: string, o: typeof flags) => {
      key = k;
      flags = o;
    });
  try {
    program.parse(argv, { from: 'user' });
  } catch (err) {
    return invalid(commanderErrorMessage(err));
  }
  if (key === undefined) return invalid('unset needs a key');

  const target = resolveTarget(flags);
  if (target !== 'project' && target !== 'global') return invalid(target);

  const result = applyConfigUnset(key, target, options);
  if (!result.ok) return invalid(result.message);

  const palette = terminalPalette(colorEnabled());
  if ('noop' in result) {
    process.stdout.write(`${key} already unset ${palette.dim(`(${result.layerName})`)}\n`);
    return 0;
  }
  process.stdout.write(
    `${palette.accent('✓')} ${key} ${palette.dim(`unset (${result.layerName}: ${result.filePath})`)}\n`,
  );
  if (result.removedFile === true) {
    process.stdout.write(
      `${palette.dim(`removed ${result.filePath}: nothing was set anymore, and defaults need no file`)}\n`,
    );
  }
  return 0;
}

// The curated keys `show` summarizes. set/unset accept any schema-valid path;
// this list is only the at-a-glance view. Defaults mirror engine contracts:
// an absent dial reads as medium (flow-selection-preview: "default-on medium
// when they say nothing") and relay.default's schema default is 'auto'.
const SHOW_KEYS: ReadonlyArray<{ readonly key: string; readonly fallback: string }> = [
  { key: 'defaults.power', fallback: 'medium' },
  { key: 'relay.default', fallback: 'auto' },
];

function valueAtPath(config: unknown, path: readonly string[]): unknown {
  let node: unknown = config;
  for (const segment of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

export interface EffectiveEntry {
  readonly value: unknown;
  readonly source: 'project' | 'user-global' | 'default';
}

export interface ConfigSummary {
  readonly layers: ReturnType<typeof discoverRuntimeConfigLayers>['selectionConfigLayers'];
  readonly effective: Record<string, EffectiveEntry>;
}

// Provenance must come from the raw layer document, pre-defaulting: the
// Config parse materializes schema defaults (relay.default becomes 'auto' in
// every parsed layer), so the parsed layer.config cannot answer "who set
// this?". Re-read the file raw; a value counts for a layer only when its
// document actually carries it. Discovery already parsed the file, so a
// failed raw read is unexpected — fall back to claiming nothing rather than
// inventing provenance.
function rawLayerDocument(sourcePath: string | undefined): unknown {
  if (sourcePath === undefined) return undefined;
  try {
    return parseYaml(readFileSync(sourcePath, 'utf8'));
  } catch {
    return undefined;
  }
}

// Layers plus effective values with provenance for the curated key set —
// shared by `config show` and the interactive configure screen.
export function summarizeConfig(options: ConfigCommandOptions = {}): ConfigSummary {
  const layers = discoverRuntimeConfigLayers({
    ...(options.homeDir === undefined ? {} : { homeDir: options.homeDir }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  }).selectionConfigLayers;

  const rawByLayer = new Map<'project' | 'user-global', unknown>();
  for (const layer of layers) {
    if (layer.layer === 'project' || layer.layer === 'user-global') {
      rawByLayer.set(layer.layer, rawLayerDocument(layer.source_path));
    }
  }

  const effective: Record<string, EffectiveEntry> = {};
  for (const { key, fallback } of SHOW_KEYS) {
    const path = key.split('.');
    let entry: EffectiveEntry = { value: fallback, source: 'default' };
    // Later layers win: user-global then project, so walk in order and let
    // the last defined value stand.
    for (const layer of layers) {
      if (layer.layer !== 'project' && layer.layer !== 'user-global') continue;
      const value = valueAtPath(rawByLayer.get(layer.layer), path);
      if (value !== undefined) {
        entry = { value, source: layer.layer };
      }
    }
    effective[key] = entry;
  }
  return { layers, effective };
}

function runShow(argv: readonly string[], options: ConfigCommandOptions): number {
  let flags: { json?: boolean } = {};
  const program = configureCommanderProgram(new Command('circuit config show'))
    .option('--json')
    .action((o: typeof flags) => {
      flags = o;
    });
  try {
    program.parse(argv, { from: 'user' });
  } catch (err) {
    return invalid(commanderErrorMessage(err));
  }

  let summary: ConfigSummary;
  try {
    summary = summarizeConfig(options);
  } catch (err) {
    return invalid(err instanceof Error ? err.message : String(err));
  }
  const { layers, effective } = summary;

  if (flags.json === true) {
    // Machine surface versioning (matches doctor's top-level schema_version).
    process.stdout.write(`${JSON.stringify({ schema_version: 1, layers, effective }, null, 2)}\n`);
    return 0;
  }

  const palette = terminalPalette(colorEnabled());
  const sep = palette.dim('·');
  const lines: string[] = [
    `${palette.accent('◆')} ${palette.bold('circuit config')} ${sep} layered selection config`,
    '',
  ];
  for (const [layerName, filePath] of [
    ['user-global', userGlobalConfigPath(options.homeDir)],
    ['project', projectConfigPath(options.cwd)],
  ] as const) {
    const present = existsSync(filePath);
    const status = present ? 'present' : palette.dim('absent');
    lines.push(`${layerName.padEnd(12)} ${filePath}  ${status}`);
  }
  lines.push('');
  for (const { key } of SHOW_KEYS) {
    const entry = effective[key];
    if (entry === undefined) continue;
    const isDefault = entry.source === 'default';
    // Pad the raw text before painting: ANSI sequences have no visible width.
    const valueText = String(entry.value).padEnd(8);
    const value = isDefault ? palette.dim(valueText) : palette.bold(valueText);
    const source = palette.dim(isDefault ? 'default' : `set (${entry.source})`);
    lines.push(`${key.padEnd(16)} ${value}  ${source}`);
  }
  lines.push('');
  lines.push(palette.dim('edit: circuit config set <key> <value> [--project|--global]'));
  lines.push(palette.dim('full merged layers: circuit config show --json'));
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

export function runConfigCommand(
  argv: readonly string[],
  options: ConfigCommandOptions = {},
): number {
  const action = argv[0] ?? 'show';
  const rest = argv.slice(1);
  if (action === 'show') return runShow(rest, options);
  if (action === 'set') return runSet(rest, options);
  if (action === 'unset') return runUnset(rest, options);
  return invalid(`unknown config action '${action}': use show, set, or unset`);
}
