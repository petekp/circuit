import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Command } from 'commander';
import { parse as parseYaml } from 'yaml';
import { validateCompiledFlowKindPolicy } from '../flows/canonical-stage-policy.js';
import { catalogFlowIds } from '../flows/catalog.js';
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
  readonly templateFlowRoot?: string;
  readonly publish: boolean;
  readonly yes: boolean;
  readonly createdAt?: string;
  readonly progress: boolean;
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
    .option('--template-flow-root <path>')
    .option('--created-at <iso>')
    .option('--publish')
    .option('--yes')
    .option('--progress <format>');
  parseCommanderOrThrow(program, argv);
  if (program.args.length > 0) throw new Error(`unexpected argument: ${program.args[0]}`);

  const opts = program.opts<{
    name?: string;
    description?: string;
    home?: string;
    templateFlowRoot?: string;
    createdAt?: string;
    publish?: boolean;
    yes?: boolean;
    progress?: string;
  }>();
  if (opts.progress !== undefined && opts.progress !== 'jsonl') {
    throw new Error("--progress only supports 'jsonl'");
  }

  return {
    publish: opts.publish === true,
    yes: opts.yes === true,
    progress: opts.progress === 'jsonl',
    ...(opts.name === undefined ? {} : { name: opts.name }),
    ...(opts.description === undefined ? {} : { description: opts.description }),
    ...(opts.home === undefined ? {} : { home: opts.home }),
    ...(opts.templateFlowRoot === undefined ? {} : { templateFlowRoot: opts.templateFlowRoot }),
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

function candidateTemplatePaths(args: CreateArgs): string[] {
  const roots = [args.templateFlowRoot, 'generated/flows', 'plugins/codex/flows'].filter(
    (root): root is string => root !== undefined,
  );
  return roots.map((root) => resolve(root, 'build', 'circuit.json'));
}

function loadTemplateFlow(args: CreateArgs): CompiledFlow {
  for (const candidate of candidateTemplatePaths(args)) {
    if (!existsSync(candidate)) continue;
    return CompiledFlow.parse(JSON.parse(readFileSync(candidate, 'utf8')));
  }
  throw new Error(
    'could not find the Build template flow; pass --template-flow-root with a root containing build/circuit.json',
  );
}

function customizeTemplateFlow(input: {
  readonly slug: string;
  readonly description: string;
  readonly template: CompiledFlow;
}): CompiledFlow {
  const candidate = {
    ...input.template,
    id: input.slug,
    purpose: input.description,
  };
  const parsed = CompiledFlow.parse(candidate);
  validateCustomFlow(input.slug, parsed, 'custom flow');
  return parsed;
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
    'archetype: build',
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
  writeJson(manifestPath(input.home), {
    schema_version: 1,
    custom_flows: [
      ...withoutSlug,
      {
        id: input.slug,
        description: input.description,
        archetype: 'build',
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
}): void {
  writeJson(join(draftRoot(input.home, input.slug), 'validation-result.json'), {
    schema_version: 1,
    status: 'valid',
    validated_flow_id: input.flow.id,
    source: input.source,
  });
}

function writeDraft(input: {
  readonly home: string;
  readonly slug: string;
  readonly description: string;
  readonly flow: CompiledFlow;
}): void {
  const root = draftRoot(input.home, input.slug);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const descriptor = circuitYaml(input.slug, input.description);
  validateCircuitYamlDescriptor(descriptor, join(root, 'circuit.yaml'), input.slug);
  writeText(join(root, 'SKILL.md'), skillMarkdown(input.slug, input.description, input.home));
  writeText(join(root, 'circuit.yaml'), descriptor);
  writeJson(join(root, 'circuit.json'), input.flow);
  writeText(join(root, 'command.md'), commandMarkdown(input.slug, input.description, input.home));
  writeValidationResult({
    home: input.home,
    slug: input.slug,
    flow: input.flow,
    source: 'template',
  });
}

function loadDraftFlow(home: string, slug: string): CompiledFlow {
  const path = join(draftRoot(home, slug), 'circuit.json');
  const flow = CompiledFlow.parse(JSON.parse(readFileSync(path, 'utf8')));
  validateCustomFlow(slug, flow, 'custom flow draft');
  return flow;
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
  const skillRoot = publishedRoot(input.home, input.slug);
  const customFlowRoot = join(flowRoot(input.home), input.slug);
  mkdirSync(skillRoot, { recursive: true });
  mkdirSync(customFlowRoot, { recursive: true });
  writeText(join(skillRoot, 'SKILL.md'), readFileSync(join(draft, 'SKILL.md'), 'utf8'));
  writeText(join(skillRoot, 'circuit.yaml'), descriptor);
  writeText(
    join(customFlowRoot, 'circuit.json'),
    readFileSync(join(draft, 'circuit.json'), 'utf8'),
  );
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
}): string {
  const invocation = customFlowInvocation(input.slug, input.home);
  return [
    '# Circuit Create',
    '',
    `Status: ${input.status}`,
    `Custom flow: ${input.slug}`,
    '',
    '## Purpose',
    input.description,
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
    const flow =
      args.publish && draftExists
        ? loadDraftFlow(home, slug)
        : customizeTemplateFlow({
            slug,
            description: args.description,
            template: loadTemplateFlow(args),
          });
    const outputDescription = args.publish && draftExists ? flow.purpose : args.description;
    if (args.publish && draftExists) {
      writeValidationResult({ home, slug, flow, source: 'draft' });
    } else {
      writeDraft({ home, slug, description: outputDescription, flow });
    }
    const status = args.publish ? 'published' : 'draft_created';
    if (args.publish) {
      publishDraft({ home, slug, description: outputDescription, createdAt });
    }
    const summary = summaryMarkdown({ slug, description: outputDescription, status, home });
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
