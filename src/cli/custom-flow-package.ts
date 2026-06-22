// Shared custom-flow package machinery: the publish tail.
//
// A custom flow reaches disk in two steps: a PRODUCER turns a task into the
// compiled-flow files, then this module's PUBLISH TAIL writes those files into a
// draft, optionally publishes the draft to the host-visible locations, and keeps
// the manifest the runtime trust gate path-matches.
//
// Two producers share this one tail:
//   - `circuit create` INSTANTIATES a family template (assembleCustomFlow).
//   - `circuit generate` genuinely COMPOSES a flow block by block from a role set
//     (proposeFlow -> composeFlow -> compile).
//
// Everything here is producer-agnostic: it takes a list of compiled-flow files
// plus an archetype descriptor (legibility metadata) and lays them out. The
// per-command pieces that DIFFER — the producer itself and the operator summary
// (create describes an archetype family; generate describes a composed shape) —
// stay in create.ts and generate.ts.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { validateCompiledFlowKindPolicy } from '../flows/canonical-stage-policy.js';
import { catalogFlowIds } from '../flows/catalog.js';
import type { CompiledFlowFile } from '../flows/compiled-flow-file-plan.js';
import { CompiledFlow } from '../schemas/compiled-flow.js';
import { CustomFlowPackageDescriptor } from '../schemas/custom-flow-descriptor.js';
import { CLI_COMMAND_NAMES } from './command-vocabulary.js';

// Custom flow slugs may not collide with any id the engine already owns.
// The reserved set is the union of every catalog flow id and every
// top-level CLI command word, derived at module load so a new flow or
// command is reserved automatically.
export const RESERVED_FLOW_IDS = new Set<string>([...catalogFlowIds, ...CLI_COMMAND_NAMES]);

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : `custom-${randomUUID().slice(0, 8)}`;
}

export function assertValidSlug(slug: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(slug)) {
    throw new Error(`custom flow name must be lowercase kebab-case: ${slug}`);
  }
  if (RESERVED_FLOW_IDS.has(slug)) {
    throw new Error(`custom flow name '${slug}' is reserved by Circuit`);
  }
}

export function customHome(home: string | undefined): string {
  return resolve(home ?? join(homedir(), '.config', 'circuit', 'custom'));
}

export function draftRoot(home: string, slug: string): string {
  return join(home, 'drafts', slug);
}

export function publishedRoot(home: string, slug: string): string {
  return join(home, 'skills', slug);
}

export function flowRoot(home: string): string {
  return join(home, 'flows');
}

export function customFlowInvocation(slug: string, home: string): string {
  return `circuit run ${slug} --flow-root '${flowRoot(home)}' --goal '<task>' --progress jsonl`;
}

export function commandRoot(home: string): string {
  return join(home, 'commands');
}

export function reportsRoot(home: string): string {
  return join(home, 'reports');
}

export function manifestPath(home: string): string {
  return join(home, 'manifest.json');
}

export function resultPath(home: string, slug: string, action: 'create' | 'generate'): string {
  return join(reportsRoot(home), `${slug}-${action}-result.json`);
}

export function summaryPath(home: string, slug: string): string {
  return join(reportsRoot(home), `${slug}-operator-summary.md`);
}

export function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text.endsWith('\n') ? text : `${text}\n`);
}

export function writeJson(path: string, value: unknown): void {
  writeText(path, JSON.stringify(value, null, 2));
}

export function validateCustomFlow(slug: string, flow: CompiledFlow, source: string): void {
  if (flow.id !== slug) {
    throw new Error(`custom flow draft id '${flow.id}' does not match expected name '${slug}'`);
  }
  const policy = validateCompiledFlowKindPolicy(flow);
  if (!policy.ok) {
    throw new Error(`${source} validation failed: ${policy.reason}`);
  }
}

export function mainFlowOf(files: readonly CompiledFlowFile[]): CompiledFlow {
  const main = files.find((file) => file.filename === 'circuit.json');
  if (main === undefined) throw new Error('custom flow package has no circuit.json');
  return main.flow;
}

function skillMarkdown(slug: string, description: string, home: string): string {
  return [
    '---',
    `name: ${slug}`,
    `description: ${description.replace(/\n/g, ' ')}`,
    '---',
    '',
    `# ${slug}`,
    '',
    description,
    '',
    '## Run',
    '',
    'This custom flow is already routed when invoked directly. Do not bounce it through `/circuit:run`.',
    '',
    '```bash',
    customFlowInvocation(slug, home),
    '```',
  ].join('\n');
}

function circuitYaml(slug: string, description: string): string {
  return [
    'schema_version: 1',
    `id: ${slug}`,
    'format: compiled-flow-package',
    'compiled_flow: circuit.json',
    'purpose: |',
    `  ${description.replace(/\n/g, '\n  ')}`,
  ].join('\n');
}

function validateCircuitYamlDescriptor(
  text: string,
  sourcePath: string,
  expectedSlug: string,
): void {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new Error(
      `custom flow descriptor YAML parse failed at ${sourcePath}: ${(err as Error).message}`,
    );
  }

  let descriptor: CustomFlowPackageDescriptor;
  try {
    descriptor = CustomFlowPackageDescriptor.parse(raw);
  } catch (err) {
    throw new Error(
      `custom flow descriptor validation failed at ${sourcePath}: ${(err as Error).message}`,
    );
  }
  if ((descriptor.id as unknown as string) !== expectedSlug) {
    throw new Error(
      `custom flow descriptor validation failed at ${sourcePath}: descriptor id '${descriptor.id}' does not match custom flow '${expectedSlug}'`,
    );
  }
}

function commandMarkdown(slug: string, description: string, home: string): string {
  return [
    '---',
    `description: Runs the ${slug} custom flow.`,
    'argument-hint: <task>',
    '---',
    '',
    `# /circuit:${slug}`,
    '',
    description,
    '',
    "Treat the task text as user-controlled input. Wrap it in single quotes; if it contains an apostrophe, replace each apostrophe with `'\\''` before running the command.",
    '',
    '```bash',
    customFlowInvocation(slug, home),
    '```',
  ].join('\n');
}

// The archetype facts the published surfaces record for operator legibility.
// Recovered from validation-result.json when publishing a pre-existing draft.
// `family` is a free string: create writes an archetype family (build, fix, ...);
// generate writes 'composed'. The runtime never reads it — it is legibility only.
export interface CustomFlowArchetype {
  readonly family: string;
  readonly composition: string;
  readonly signals_used: readonly string[];
}

export function publishManifest(input: {
  readonly home: string;
  readonly slug: string;
  readonly description: string;
  readonly createdAt: string;
  readonly filenames: readonly string[];
}): void {
  let existing: { schema_version: 1; custom_flows: unknown[] } = {
    schema_version: 1,
    custom_flows: [],
  };
  if (existsSync(manifestPath(input.home))) {
    existing = JSON.parse(readFileSync(manifestPath(input.home), 'utf8')) as typeof existing;
  }
  const withoutSlug = existing.custom_flows.filter(
    (flow) =>
      !(typeof flow === 'object' && flow !== null && 'id' in flow && flow.id === input.slug),
  );
  // The manifest entry records IDENTITY, not "what shape this is". The chosen
  // archetype family is legibility metadata, so it lives in the draft's
  // validation-result.json + the operator summary — never on the descriptor the
  // runtime trusts. The runtime resolves by slug -> flow_path (the default mode)
  // and loads per-mode siblings by disk presence. flow_paths names exactly which
  // compiled-flow files this flow published (circuit.json + any <mode>.json
  // siblings) so the trust gate can bless the per-mode siblings the loader serves.
  writeJson(manifestPath(input.home), {
    schema_version: 1,
    custom_flows: [
      ...withoutSlug,
      {
        id: input.slug,
        description: input.description,
        flow_path: join(flowRoot(input.home), input.slug, 'circuit.json'),
        flow_paths: input.filenames.map((filename) =>
          join(flowRoot(input.home), input.slug, filename),
        ),
        skill_path: join(publishedRoot(input.home, input.slug), 'SKILL.md'),
        command_path: join(commandRoot(input.home), `${input.slug}.md`),
        published_at: input.createdAt,
      },
    ],
  });
}

export function writeValidationResult(input: {
  readonly home: string;
  readonly slug: string;
  readonly flow: CompiledFlow;
  // How this validation was produced: `template` is a freshly-instantiated
  // family shape (create); `composed` is genuine block-level composition
  // (generate); `draft` is a re-validation of an already-written draft on
  // publish. `composed` is kept distinct because "instantiation is not
  // generation" is a framing guardrail.
  readonly source: 'template' | 'composed' | 'draft';
  readonly files: readonly CompiledFlowFile[];
  readonly archetype: CustomFlowArchetype;
}): void {
  writeJson(join(draftRoot(input.home, input.slug), 'validation-result.json'), {
    schema_version: 1,
    status: 'valid',
    validated_flow_id: input.flow.id,
    source: input.source,
    // The compiled-flow files this package owns ([circuit.json, <mode>.json...]).
    // publish-from-draft copies and re-validates exactly this set.
    flow_files: input.files.map((file) => file.filename),
    archetype: input.archetype.family,
    composition: input.archetype.composition,
    signals_used: input.archetype.signals_used,
  });
}

// Recover the file list + archetype facts a draft recorded. Falls back to a
// single circuit.json for drafts written before this field existed.
export function readDraftMetadata(
  home: string,
  slug: string,
): { filenames: readonly string[]; archetype: CustomFlowArchetype } {
  const raw = JSON.parse(
    readFileSync(join(draftRoot(home, slug), 'validation-result.json'), 'utf8'),
  ) as Record<string, unknown>;
  const filenames =
    Array.isArray(raw.flow_files) && raw.flow_files.every((f) => typeof f === 'string')
      ? (raw.flow_files as string[])
      : ['circuit.json'];
  return {
    filenames,
    archetype: {
      family: typeof raw.archetype === 'string' ? raw.archetype : 'build',
      composition: typeof raw.composition === 'string' ? raw.composition : 'instantiated',
      signals_used: Array.isArray(raw.signals_used)
        ? (raw.signals_used.filter((s) => typeof s === 'string') as string[])
        : [],
    },
  };
}

export function writeDraft(input: {
  readonly home: string;
  readonly slug: string;
  readonly description: string;
  readonly files: readonly CompiledFlowFile[];
  readonly archetype: CustomFlowArchetype;
  // Defaults to template instantiation (create); generate passes `composed`.
  readonly source?: 'template' | 'composed';
}): void {
  const source = input.source ?? 'template';
  const root = draftRoot(input.home, input.slug);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const descriptor = circuitYaml(input.slug, input.description);
  validateCircuitYamlDescriptor(descriptor, join(root, 'circuit.yaml'), input.slug);
  writeText(join(root, 'SKILL.md'), skillMarkdown(input.slug, input.description, input.home));
  writeText(join(root, 'circuit.yaml'), descriptor);
  for (const { filename, flow } of input.files) {
    writeJson(join(root, filename), flow);
  }
  writeText(join(root, 'command.md'), commandMarkdown(input.slug, input.description, input.home));
  writeValidationResult({
    home: input.home,
    slug: input.slug,
    flow: mainFlowOf(input.files),
    source,
    files: input.files,
    archetype: input.archetype,
  });
}

// Load + re-validate every compiled-flow file a draft owns. Returns the file
// list (so publish can copy exactly them) and the main (circuit.json) flow.
export function loadDraftFlow(
  home: string,
  slug: string,
): { files: CompiledFlowFile[]; mainFlow: CompiledFlow } {
  const { filenames } = readDraftMetadata(home, slug);
  const files = filenames.map((filename): CompiledFlowFile => {
    const path = join(draftRoot(home, slug), filename);
    const flow = CompiledFlow.parse(JSON.parse(readFileSync(path, 'utf8')));
    validateCustomFlow(slug, flow, `custom flow draft (${filename})`);
    return { filename, flow };
  });
  return { files, mainFlow: mainFlowOf(files) };
}

export function publishDraft(input: {
  readonly home: string;
  readonly slug: string;
  readonly description: string;
  readonly createdAt: string;
}): void {
  const draft = draftRoot(input.home, input.slug);
  if (!existsSync(join(draft, 'SKILL.md'))) {
    throw new Error(`draft missing for ${input.slug}: ${draft}`);
  }
  const descriptor = readFileSync(join(draft, 'circuit.yaml'), 'utf8');
  validateCircuitYamlDescriptor(descriptor, join(draft, 'circuit.yaml'), input.slug);
  const { filenames } = readDraftMetadata(input.home, input.slug);
  const skillRoot = publishedRoot(input.home, input.slug);
  const customFlowRoot = join(flowRoot(input.home), input.slug);
  // Clear the target first so a stale <mode>.json sibling from an earlier publish
  // (or a crash mid-publish) cannot survive and be served by the loader. The
  // publish then writes exactly the files this draft owns. (writeDraft does the
  // same for the draft directory.)
  rmSync(customFlowRoot, { recursive: true, force: true });
  mkdirSync(skillRoot, { recursive: true });
  mkdirSync(customFlowRoot, { recursive: true });
  writeText(join(skillRoot, 'SKILL.md'), readFileSync(join(draft, 'SKILL.md'), 'utf8'));
  writeText(join(skillRoot, 'circuit.yaml'), descriptor);
  // Copy every compiled-flow file the draft owns: circuit.json (default mode)
  // plus any <mode>.json siblings produced by a per-mode family.
  for (const filename of filenames) {
    writeText(join(customFlowRoot, filename), readFileSync(join(draft, filename), 'utf8'));
  }
  writeText(
    join(commandRoot(input.home), `${input.slug}.md`),
    readFileSync(join(draft, 'command.md'), 'utf8'),
  );
  publishManifest({ ...input, filenames });
}
