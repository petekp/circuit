import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { compileSchematicToCompiledFlow } from '../flows/compile-schematic-to-flow.js';
import { type CompiledFlowFile, planCompiledFlowFiles } from '../flows/compiled-flow-file-plan.js';
import {
  type ArchetypeResolution,
  describeArchetypeFamily,
  resolveArchetype,
} from '../flows/resolvers/archetype.js';
import { extractAssemblySignals } from '../flows/resolvers/signals.js';
import { CompiledFlow } from '../schemas/compiled-flow.js';
import { progressPresentation } from '../shared/progress-output.js';
import { parseCommanderOrThrow } from './commander-support.js';
import {
  type CustomFlowArchetype,
  assertValidSlug,
  commandRoot,
  customFlowInvocation,
  customHome,
  draftRoot,
  flowRoot,
  loadDraftFlow,
  mainFlowOf,
  manifestPath,
  publishDraft,
  publishedRoot,
  readDraftMetadata,
  resultPath,
  slugify,
  summaryPath,
  validateCustomFlow,
  writeDraft,
  writeJson,
  writeText,
  writeValidationResult,
} from './custom-flow-package.js';
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
    const home = customHome(args.home);
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
    const outPath = resultPath(home, slug, 'create');
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
