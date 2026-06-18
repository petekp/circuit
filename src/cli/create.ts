import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Command } from 'commander';
import { parse as parseYaml } from 'yaml';
import { validateCompiledFlowKindPolicy } from '../flows/canonical-stage-policy.js';
import { catalogFlowIds } from '../flows/catalog.js';
import { compileSchematicToCompiledFlow } from '../flows/compile-schematic-to-flow.js';
import { type CompiledFlowFile, planCompiledFlowFiles } from '../flows/compiled-flow-file-plan.js';
import {
  type ArchetypeResolution,
  describeArchetypeFamily,
  resolveArchetype,
} from '../flows/resolvers/archetype.js';
import { extractAssemblySignals } from '../flows/resolvers/signals.js';
import { CompiledFlow } from '../schemas/compiled-flow.js';
import { CustomFlowPackageDescriptor } from '../schemas/custom-flow-descriptor.js';
import { progressPresentation } from '../shared/progress-output.js';
import { CLI_COMMAND_NAMES } from './command-vocabulary.js';
import { parseCommanderOrThrow } from './commander-support.js';
import { CUSTOM_FLOW_ROOT_RUNTIME_POLICY } from './runtime-routing-policy.js';
import { utilityProgress } from './utility-progress.js';

interface CreateArgs {
  readonly name?: string;
  readonly description?: string;
  readonly home?: string;
  readonly publish: boolean;
  readonly yes: boolean;
  readonly createdAt?: string;
  readonly progress: boolean;
  // Explicit request for the full decomposed spine. Absent → the structure
  // chooser leans to the thin-conservative whole grain (see assembleCustomFlow).
  readonly decompose: boolean;
}

interface CreateMainOptions {
  readonly now?: () => Date;
}

// Custom flow slugs may not collide with any id the engine already owns.
// The reserved set is the union of every catalog flow id and every
// top-level CLI command word, derived at module load so a new flow or
// command is reserved automatically. This is a superset of the historical
// literal {build, explore, fix, handoff, review, run}: catalog ids supply
// build/explore/fix/review (plus goal/prototype/pursue/runtime-proof),
// and the command vocabulary supplies handoff/run (plus resume/history/
// create/runs/version).
const RESERVED_FLOW_IDS = new Set<string>([...catalogFlowIds, ...CLI_COMMAND_NAMES]);

function parseArgs(argv: readonly string[]): CreateArgs {
  const program = new Command('circuit create')
    .option('--name <slug>')
    .option('--description <flow idea>')
    .option('--home <path>')
    .option('--created-at <iso>')
    .option('--publish')
    .option('--yes')
    .option('--decompose')
    .option('--progress <format>');
  parseCommanderOrThrow(program, argv);
  if (program.args.length > 0) throw new Error(`unexpected argument: ${program.args[0]}`);

  const opts = program.opts<{
    name?: string;
    description?: string;
    home?: string;
    createdAt?: string;
    publish?: boolean;
    yes?: boolean;
    decompose?: boolean;
    progress?: string;
  }>();
  if (opts.progress !== undefined && opts.progress !== 'jsonl') {
    throw new Error("--progress only supports 'jsonl'");
  }

  return {
    publish: opts.publish === true,
    yes: opts.yes === true,
    decompose: opts.decompose === true,
    progress: opts.progress === 'jsonl',
    ...(opts.name === undefined ? {} : { name: opts.name }),
    ...(opts.description === undefined ? {} : { description: opts.description }),
    ...(opts.home === undefined ? {} : { home: opts.home }),
    ...(opts.createdAt === undefined ? {} : { createdAt: opts.createdAt }),
  };
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug.length > 0 ? slug : `custom-${randomUUID().slice(0, 8)}`;
}

function assertValidSlug(slug: string): void {
  if (!/^[a-z][a-z0-9-]*$/.test(slug)) {
    throw new Error(`custom flow name must be lowercase kebab-case: ${slug}`);
  }
  if (RESERVED_FLOW_IDS.has(slug)) {
    throw new Error(`custom flow name '${slug}' is reserved by Circuit`);
  }
}

function customHome(args: CreateArgs): string {
  return resolve(args.home ?? join(homedir(), '.config', 'circuit', 'custom'));
}

function draftRoot(home: string, slug: string): string {
  return join(home, 'drafts', slug);
}

function publishedRoot(home: string, slug: string): string {
  return join(home, 'skills', slug);
}

function flowRoot(home: string): string {
  return join(home, 'flows');
}

function customFlowInvocation(slug: string, home: string): string {
  return `circuit run ${slug} --flow-root '${flowRoot(home)}' --goal '<task>' --progress jsonl`;
}

function commandRoot(home: string): string {
  return join(home, 'commands');
}

function reportsRoot(home: string): string {
  return join(home, 'reports');
}

function manifestPath(home: string): string {
  return join(home, 'manifest.json');
}

function resultPath(home: string, slug: string): string {
  return join(reportsRoot(home), `${slug}-create-result.json`);
}

function summaryPath(home: string, slug: string): string {
  return join(reportsRoot(home), `${slug}-operator-summary.md`);
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text.endsWith('\n') ? text : `${text}\n`);
}

function writeJson(path: string, value: unknown): void {
  writeText(path, JSON.stringify(value, null, 2));
}

function validateCustomFlow(slug: string, flow: CompiledFlow, source: string): void {
  if (flow.id !== slug) {
    throw new Error(`custom flow draft id '${flow.id}' does not match expected name '${slug}'`);
  }
  const policy = validateCompiledFlowKindPolicy(flow);
  if (!policy.ok) {
    throw new Error(`${source} validation failed: ${policy.reason}`);
  }
}

// The task-aware assembler. The old seam was task-BLIND: it discarded the
// description and always seeded build's spine, so the only shape it could emit
// was build (folded or full). Now create READS the description into signals
// (extractAssemblySignals), picks an archetype FAMILY from them, and instantiates
// a task-appropriate shape (resolveArchetype) — editorial, fix, review, research,
// prototype, or build. The `--decompose` flag still forces the build family's
// full decomposed spine when the task lands on build.
//
// Every family reuses a registered contract family (build.*, fix.*, explore.*,
// review.*, prototype.*, explainer.*) whose bodies are registered globally by
// namespace, and single-producer is checked PER-GRAPH — so a custom-slug flow
// that reuses a proven family passes the fail-closed catalog + kind gates exactly
// as the built-in does. See src/flows/resolvers/archetype.ts and the proof in
// tests/runner/task-aware-assembler.test.ts.
//
// A schematic with route_overrides (fix, research, prototype) compiles to a
// per-mode package — one graph per runtime mode. planCompiledFlowFiles lays those
// out the way the runtime loader expects: the largest graph to circuit.json,
// remaining modes to <mode>.json siblings. The DEFAULT mode (circuit.json) runs
// live today; non-default-mode runtime trust is a recorded follow-up (the trust
// gate matches the manifest's single circuit.json flow_path).
export interface AssembledCustomFlow {
  // [circuit.json, <mode>.json...] — every compiled graph this flow needs.
  readonly files: readonly CompiledFlowFile[];
  readonly resolution: ArchetypeResolution;
}

function mainFlowOf(files: readonly CompiledFlowFile[]): CompiledFlow {
  const main = files.find((file) => file.filename === 'circuit.json');
  if (main === undefined) throw new Error('custom flow package has no circuit.json');
  return main.flow;
}

function assembleCustomFlow(input: {
  readonly slug: string;
  readonly description: string;
  readonly decompose: boolean;
}): AssembledCustomFlow {
  const signals = extractAssemblySignals(input.description, {
    explicit_decompose: input.decompose,
  });
  const resolution = resolveArchetype(input.slug, signals);
  const compiled = compileSchematicToCompiledFlow(resolution.schematic);
  const files = planCompiledFlowFiles(compiled).map(
    (file): CompiledFlowFile => ({
      filename: file.filename,
      flow: CompiledFlow.parse(file.flow),
    }),
  );
  for (const { filename, flow } of files) {
    validateCustomFlow(input.slug, flow, `custom flow (${filename})`);
  }
  return { files, resolution };
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
interface CustomFlowArchetype {
  readonly family: string;
  readonly composition: string;
  readonly signals_used: readonly string[];
}

function publishManifest(input: {
  readonly home: string;
  readonly slug: string;
  readonly description: string;
  readonly createdAt: string;
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
  // M9-C: the manifest entry records IDENTITY, not "what shape this is". The
  // chosen archetype family is legibility metadata, so it lives in the draft's
  // validation-result.json + the operator summary — never on the descriptor the
  // runtime trusts. The runtime resolves by slug → flow_path and loads per-mode
  // siblings by disk presence; it never needs the family here.
  writeJson(manifestPath(input.home), {
    schema_version: 1,
    custom_flows: [
      ...withoutSlug,
      {
        id: input.slug,
        description: input.description,
        flow_path: join(flowRoot(input.home), input.slug, 'circuit.json'),
        skill_path: join(publishedRoot(input.home, input.slug), 'SKILL.md'),
        command_path: join(commandRoot(input.home), `${input.slug}.md`),
        published_at: input.createdAt,
      },
    ],
  });
}

function writeValidationResult(input: {
  readonly home: string;
  readonly slug: string;
  readonly flow: CompiledFlow;
  readonly source: 'template' | 'draft';
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
function readDraftMetadata(
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

function writeDraft(input: {
  readonly home: string;
  readonly slug: string;
  readonly description: string;
  readonly files: readonly CompiledFlowFile[];
  readonly archetype: CustomFlowArchetype;
}): void {
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
    source: 'template',
    files: input.files,
    archetype: input.archetype,
  });
}

// Load + re-validate every compiled-flow file a draft owns. Returns the file
// list (so publish can copy exactly them) and the main (circuit.json) flow.
function loadDraftFlow(
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

function publishDraft(input: {
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
  publishManifest(input);
}

function summaryMarkdown(input: {
  readonly slug: string;
  readonly description: string;
  readonly status: 'draft_created' | 'published';
  readonly home: string;
  readonly archetype: CustomFlowArchetype;
}): string {
  const invocation = customFlowInvocation(input.slug, input.home);
  const signalsLine =
    input.archetype.signals_used.length > 0
      ? input.archetype.signals_used.map((s) => `- ${s}`)
      : ['- No specific cue fired; used the conservative build default.'];
  return [
    '# Circuit Create',
    '',
    `Status: ${input.status}`,
    `Custom flow: ${input.slug}`,
    '',
    '## Purpose',
    input.description,
    '',
    '## Shape',
    `This flow was generated with the **${input.archetype.family}** shape (${input.archetype.composition}).`,
    describeArchetypeFamily(
      input.archetype.family as Parameters<typeof describeArchetypeFamily>[0],
    ),
    '',
    'Signals read from the task:',
    ...signalsLine,
    '',
    '## Validation',
    'The generated compiled flow parsed successfully and passed flow-kind policy validation.',
    '',
    '## Runtime Policy',
    CUSTOM_FLOW_ROOT_RUNTIME_POLICY,
    '',
    '## Usage',
    `\`${invocation}\``,
    '',
    '## Next Action',
    input.status === 'published'
      ? 'Run the usage command above, or reload the host command surface if your host caches slash commands.'
      : 'Review the draft, then rerun create with `--publish --yes` when ready.',
  ].join('\n');
}

export async function runCreateCommand(
  argv: readonly string[],
  options: CreateMainOptions = {},
): Promise<number> {
  let args: CreateArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 2;
  }
  const now = options.now ?? (() => new Date());
  const progress = utilityProgress({ enabled: args.progress, flowId: 'create', now });
  if (progress !== undefined) {
    progress.emit({
      type: 'route.selected',
      recorded_at: now().toISOString(),
      label: 'Selected Create',
      display: {
        text: 'Circuit selected create.',
        importance: 'major',
        tone: 'info',
      },
      presentation: progressPresentation({ blockId: progress.runId, statusText: 'Chose create.' }),
      selected_flow: 'create' as never,
      routed_by: 'explicit',
      router_reason: 'explicit create utility command',
    });
  }

  try {
    if (args.description === undefined || args.description.length === 0) {
      throw new Error('--description is required');
    }
    if (args.publish && !args.yes) {
      throw new Error('--publish requires --yes so publish confirmation is explicit');
    }
    const slug = slugify(args.name ?? args.description);
    assertValidSlug(slug);
    const home = customHome(args);
    if (args.publish && existsSync(join(flowRoot(home), slug, 'circuit.json'))) {
      throw new Error(`custom flow already published: ${slug}`);
    }
    const createdAt = args.createdAt ?? now().toISOString();
    const draftExists = existsSync(join(draftRoot(home, slug), 'circuit.json'));

    // Two paths to the compiled-flow files + archetype facts: publish a
    // pre-existing draft (recover both from disk), or assemble fresh from the
    // task description (the task-aware assembler).
    let files: readonly CompiledFlowFile[];
    let mainFlow: CompiledFlow;
    let archetype: CustomFlowArchetype;
    if (args.publish && draftExists) {
      const loaded = loadDraftFlow(home, slug);
      files = loaded.files;
      mainFlow = loaded.mainFlow;
      archetype = readDraftMetadata(home, slug).archetype;
    } else {
      const assembled = assembleCustomFlow({
        slug,
        description: args.description,
        decompose: args.decompose,
      });
      files = assembled.files;
      mainFlow = mainFlowOf(assembled.files);
      archetype = {
        family: assembled.resolution.family,
        composition: assembled.resolution.composition,
        signals_used: assembled.resolution.signals_used,
      };
    }

    const outputDescription = args.publish && draftExists ? mainFlow.purpose : args.description;
    if (args.publish && draftExists) {
      writeValidationResult({ home, slug, flow: mainFlow, source: 'draft', files, archetype });
    } else {
      writeDraft({ home, slug, description: outputDescription, files, archetype });
    }
    const status = args.publish ? 'published' : 'draft_created';
    if (args.publish) {
      publishDraft({ home, slug, description: outputDescription, createdAt });
    }
    const summary = summaryMarkdown({
      slug,
      description: outputDescription,
      status,
      home,
      archetype,
    });
    writeText(summaryPath(home, slug), summary);
    const result = {
      schema_version: 1,
      action: 'create',
      status,
      slug,
      draft_path: draftRoot(home, slug),
      validation_path: join(draftRoot(home, slug), 'validation-result.json'),
      ...(args.publish
        ? {
            published_path: publishedRoot(home, slug),
            flow_path: join(flowRoot(home), slug, 'circuit.json'),
            command_path: join(commandRoot(home), `${slug}.md`),
            manifest_path: manifestPath(home),
          }
        : {}),
      operator_summary_markdown_path: summaryPath(home, slug),
    };
    const outPath = resultPath(home, slug);
    writeJson(outPath, result);
    const finalResult = { ...result, result_path: outPath };
    if (progress !== undefined) {
      progress.emit({
        type: 'run.completed',
        recorded_at: now().toISOString(),
        label: 'Create completed',
        display: {
          text: `Circuit create ${status === 'published' ? 'published' : 'drafted'} ${slug}.`,
          importance: 'major',
          tone: 'success',
        },
        presentation: progressPresentation({
          blockId: progress.runId,
          statusText: `Create ${status === 'published' ? 'published' : 'drafted'} ${slug}.`,
        }),
        outcome: 'complete',
        result_path: outPath,
      });
    }
    process.stdout.write(`${JSON.stringify(finalResult, null, 2)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}
