// `circuit generate` — the PROPOSE half of the north star, as a product command.
//
// create vs generate. Both turn a task into a custom flow and publish it through
// the SAME tail (custom-flow-package.ts). They differ in the PRODUCER:
//   - create   INSTANTIATES a proven family template, offline and deterministic.
//   - generate genuinely COMPOSES a flow block by block: it asks a model to
//     PROPOSE a flow shape, runs the offline floor (compose -> validity ->
//     runnability), and on a wall feeds the verifier's exact errors back for a
//     bounded number of repair rounds. Output is a runnable composed flow OR an
//     honest parse/relay/wall failure.
//
// This is the first product surface over proposeFlow. It is selection-agnostic at
// the core (proposeFlow takes a ResolvedSelection); the command pins the proposer
// to the model the live runs validated (claude-haiku-4-5 / low). Wiring the
// session power dial here is a recorded follow-up — see the comment on
// PROPOSER_SELECTION.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { relayClaudeCode } from '../connectors/claude-code.js';
import { assembleFlowSchematic } from '../flows/assemble-flow-schematic.js';
import { compileSchematicToCompiledFlow } from '../flows/compile-schematic-to-flow.js';
import { type CompiledFlowFile, planCompiledFlowFiles } from '../flows/compiled-flow-file-plan.js';
import { type CompositionRoleSet, proposeFlow } from '../flows/composition/index.js';
import { CompiledFlow } from '../schemas/compiled-flow.js';
import type { ResolvedSelection } from '../schemas/selection-policy.js';
import { progressPresentation } from '../shared/progress-output.js';
import type { RelayFn, RelayInput } from '../shared/relay-runtime-types.js';
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
} from './custom-flow-package.js';
import { CUSTOM_FLOW_ROOT_RUNTIME_POLICY } from './runtime-routing-policy.js';
import { utilityProgress } from './utility-progress.js';

// The proposer is pinned to the model the live proposeFlow runs validated
// (claude-haiku-4-5 / low): 4/4 of the validation tasks composed runnable on it.
// proposeFlow is selection-agnostic, so honoring the session power dial here is a
// one-line swap (materializePowerSelection, role 'researcher') once the dial is
// loaded at this boundary. v1 pins the proven model and reports it transparently
// in the result so the choice is visible.
const PROPOSER_SELECTION: ResolvedSelection = {
  model: { provider: 'anthropic', model: 'claude-haiku-4-5' },
  effort: 'low',
  skills: [],
  invocation_options: {},
};
const PROPOSER_MODEL_LABEL = 'claude-haiku-4-5';

// The real model channel: wrap the connector relay as a RelayFn. Used when the
// caller injects no relay (the bin/circuit path). Tests inject a stub instead.
const productionRelay: RelayFn = {
  connectorName: 'claude-code',
  relay: (input: RelayInput) => relayClaudeCode(input),
};

interface GenerateArgs {
  readonly description: string;
  readonly name?: string;
  readonly home?: string;
  readonly publish: boolean;
  readonly yes: boolean;
  readonly createdAt?: string;
  readonly progress: boolean;
  readonly maxRepair: number;
  readonly timeoutMs: number;
}

interface GenerateMainOptions {
  readonly now?: () => Date;
  // The model channel. Absent → the real connector relay. Injected by tests.
  readonly relayer?: RelayFn;
}

function parseArgs(argv: readonly string[]): GenerateArgs {
  const program = new Command('circuit generate')
    .option('--description <task>')
    .option('--name <slug>')
    .option('--home <path>')
    .option('--created-at <iso>')
    .option('--publish')
    .option('--yes')
    .option('--max-repair <n>')
    .option('--timeout-ms <ms>')
    .option('--progress <format>');
  parseCommanderOrThrow(program, argv);
  if (program.args.length > 0) throw new Error(`unexpected argument: ${program.args[0]}`);

  const opts = program.opts<{
    description?: string;
    name?: string;
    home?: string;
    createdAt?: string;
    publish?: boolean;
    yes?: boolean;
    maxRepair?: string;
    timeoutMs?: string;
    progress?: string;
  }>();
  if (opts.progress !== undefined && opts.progress !== 'jsonl') {
    throw new Error("--progress only supports 'jsonl'");
  }
  const maxRepair = opts.maxRepair === undefined ? 4 : Number(opts.maxRepair);
  if (!Number.isInteger(maxRepair) || maxRepair < 0) {
    throw new Error('--max-repair must be a non-negative integer');
  }
  const timeoutMs = opts.timeoutMs === undefined ? 90_000 : Number(opts.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive integer');
  }
  // Flag misuse is a usage error and exits 2 through the parse-error path,
  // like every other command; the operational try/catch below keeps exit 1
  // for real failures (B4).
  if (opts.description === undefined || opts.description.length === 0) {
    throw new Error('--description is required');
  }
  if (opts.publish === true && opts.yes !== true) {
    throw new Error('--publish requires --yes so publish confirmation is explicit');
  }

  return {
    publish: opts.publish === true,
    yes: opts.yes === true,
    progress: opts.progress === 'jsonl',
    maxRepair,
    timeoutMs,
    description: opts.description,
    ...(opts.name === undefined ? {} : { name: opts.name }),
    ...(opts.home === undefined ? {} : { home: opts.home }),
    ...(opts.createdAt === undefined ? {} : { createdAt: opts.createdAt }),
  };
}

// Name the topology the model proposed, for the operator summary + result.
function shapeOf(roleSet: CompositionRoleSet): string {
  const roles = roleSet.roles ?? [];
  if (roles.some((r) => r.executionKind === 'fanout')) return 'fanout';
  if (roles.some((r) => r.executionKind === 'sub-run')) return 'sub-run';
  if (roles.some((r) => r.loopBackTo !== undefined)) return 'loop';
  const hasAct = roles.some((r) => r.stage === 'act');
  if (roles.some((r) => r.block === 'review-intake') && !hasAct) return 'review-only';
  if (!hasAct) return 'no-act';
  return 'linear';
}

type ComposeResult =
  | {
      readonly ok: true;
      readonly slug: string;
      readonly files: readonly CompiledFlowFile[];
      readonly archetype: CustomFlowArchetype;
      readonly shape: string;
      readonly convergedRound: number;
      readonly repairRounds: number;
    }
  | {
      readonly ok: false;
      readonly reason: 'parse' | 'relay' | 'wall';
      readonly errors: readonly string[];
      readonly repairRounds: number;
    };

// Recover a reviewed draft as if it had just been composed, so the publish tail
// is identical either way. The shape round-trips through the archetype's
// composition string ("block-level (<shape>)"), which the draft already records,
// so reuse costs no schema change. The round counters describe a composition
// that did not happen on this run and are never reported on this path.
function composedFromDraft(home: string, slug: string): ComposeResult {
  const { files } = loadDraftFlow(home, slug);
  const { archetype } = readDraftMetadata(home, slug);
  return {
    ok: true,
    slug,
    files,
    archetype,
    shape: /^block-level \((.+)\)$/.exec(archetype.composition)?.[1] ?? archetype.composition,
    convergedRound: 0,
    repairRounds: 0,
  };
}

// The generate producer: PROPOSE a flow shape, run the floor, then compile the
// runnable spec into the same CompiledFlowFile[] the publish tail consumes.
async function composeCustomFlow(input: {
  readonly description: string;
  readonly name: string | undefined;
  readonly relay: RelayFn;
  readonly maxRepair: number;
  readonly timeoutMs: number;
}): Promise<ComposeResult> {
  const outcome = await proposeFlow({
    task: input.description,
    relay: input.relay,
    resolvedSelection: PROPOSER_SELECTION,
    maxRepair: input.maxRepair,
    timeoutMs: input.timeoutMs,
  });
  if (!outcome.ok) {
    return {
      ok: false,
      reason: outcome.reason,
      errors: outcome.errors,
      repairRounds: Math.max(0, outcome.rounds.length - 1),
    };
  }

  // The slug: --name wins; otherwise the model's proposed id. slugify normalizes,
  // assertValidSlug rejects a reserved or malformed slug. Forcing spec.id = slug
  // makes the compiled flow's id equal the slug (validateCustomFlow's invariant).
  const slug = slugify(input.name ?? outcome.roleSet.id);
  assertValidSlug(slug);
  const schematic = assembleFlowSchematic({ ...outcome.spec, id: slug });
  const compiled = compileSchematicToCompiledFlow(schematic);
  const files = planCompiledFlowFiles(compiled).map(
    (file): CompiledFlowFile => ({
      filename: file.filename,
      flow: CompiledFlow.parse(file.flow),
    }),
  );
  for (const { filename, flow } of files) {
    validateCustomFlow(slug, flow, `composed flow (${filename})`);
  }
  const shape = shapeOf(outcome.roleSet);
  return {
    ok: true,
    slug,
    files,
    archetype: { family: 'composed', composition: `block-level (${shape})`, signals_used: [] },
    shape,
    convergedRound: outcome.convergedRound,
    repairRounds: Math.max(0, outcome.rounds.length - 1),
  };
}

function summaryMarkdown(input: {
  readonly slug: string;
  readonly description: string;
  readonly status: 'draft_created' | 'published';
  readonly home: string;
  readonly shape: string;
  readonly convergedRound: number;
  readonly reusedDraft: boolean;
}): string {
  const invocation = customFlowInvocation(input.slug, input.home);
  const convergence = input.reusedDraft
    ? 'Circuit published the draft as reviewed. It composed nothing on this run.'
    : input.convergedRound === 0
      ? 'The first proposal was runnable as composed.'
      : `It converged after ${input.convergedRound} verifier-guided repair round(s).`;
  return [
    '# Circuit Generate',
    '',
    `Status: ${input.status}`,
    `Custom flow: ${input.slug}`,
    '',
    '## Purpose',
    input.description,
    '',
    '## Shape',
    `This flow was composed block by block to fit the task (a ${input.shape} shape).`,
    convergence,
    `Proposer model: ${PROPOSER_MODEL_LABEL}.`,
    '',
    '## Validation',
    "The composed flow passed the offline floor: it composes, is catalog-valid, and every writer's required upstream reads have a producer (runnable).",
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
      : // Name the slug. Without `--name` a rerun composes a NEW flow and
        // publishes that instead, because the model picks the slug and nothing
        // ties the rerun back to the draft under review.
        `Review the draft, then publish exactly it with \`circuit generate --description '${input.description}' --name ${input.slug} --publish --yes\`.`,
  ].join('\n');
}

export async function runGenerateCommand(
  argv: readonly string[],
  options: GenerateMainOptions = {},
): Promise<number> {
  let args: GenerateArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 2;
  }
  const now = options.now ?? (() => new Date());
  const progress = utilityProgress({ enabled: args.progress, flowId: 'generate', now });
  if (progress !== undefined) {
    progress.emit({
      type: 'route.selected',
      recorded_at: now().toISOString(),
      label: 'Selected Generate',
      display: { text: 'Circuit selected generate.', importance: 'major', tone: 'info' },
      presentation: progressPresentation({
        blockId: progress.runId,
        statusText: 'Chose generate.',
      }),
      selected_flow: 'generate' as never,
      routed_by: 'explicit',
      router_reason: 'explicit generate utility command',
    });
  }

  try {
    const home = customHome(args.home);
    const relay = options.relayer ?? productionRelay;

    // Pre-flight on an explicit --name: when the operator names the slug it is
    // fully known before any work, so reject a reserved/malformed/already-published
    // slug here rather than after a full propose+repair spend (create validates up
    // front the same way). The model-chosen-id path is validated post-compose, where
    // the slug genuinely cannot be known earlier.
    const namedSlug = args.name === undefined ? undefined : slugify(args.name);
    if (namedSlug !== undefined) {
      assertValidSlug(namedSlug);
      if (args.publish && existsSync(join(flowRoot(home), namedSlug, 'circuit.json'))) {
        throw new Error(`custom flow already published: ${namedSlug}`);
      }
    }

    // Publishing a named draft that already exists ships EXACTLY what the
    // operator reviewed. Composing again would ask the model a second time and
    // publish that second answer, and writeDraft rmSyncs the draft root first,
    // so the approved flow would be deleted on the way. create.ts resolves the
    // same fork the same way.
    const reusedDraft =
      args.publish &&
      namedSlug !== undefined &&
      existsSync(join(draftRoot(home, namedSlug), 'circuit.json'));

    const composed = reusedDraft
      ? composedFromDraft(home, namedSlug as string)
      : await composeCustomFlow({
          description: args.description,
          name: args.name,
          relay,
          maxRepair: args.maxRepair,
          timeoutMs: args.timeoutMs,
        });

    if (!composed.ok) {
      // Honest fail-closed: the model never produced a runnable flow. Report the
      // reason + the verifier's last errors so the operator can retry or fall back.
      const failure = {
        schema_version: 1,
        action: 'generate',
        status: 'failed',
        reason: composed.reason,
        proposer_model: PROPOSER_MODEL_LABEL,
        repair_rounds: composed.repairRounds,
        errors: composed.errors.slice(0, 5),
      };
      if (progress !== undefined) {
        progress.emit({
          type: 'run.completed',
          recorded_at: now().toISOString(),
          label: 'Generate failed',
          display: {
            text: `Circuit generate could not compose a runnable flow (${composed.reason}).`,
            importance: 'error',
            tone: 'error',
          },
          presentation: progressPresentation({
            blockId: progress.runId,
            statusText: `Generate failed (${composed.reason}).`,
          }),
          outcome: 'error',
        });
      }
      process.stdout.write(`${JSON.stringify(failure, null, 2)}\n`);
      return 1;
    }

    const slug = composed.slug;
    if (args.publish && existsSync(join(flowRoot(home), slug, 'circuit.json'))) {
      throw new Error(`custom flow already published: ${slug}`);
    }
    const createdAt = args.createdAt ?? now().toISOString();

    // Never rewrite a draft we are only here to publish: writeDraft rmSyncs the
    // root, and this is the flow the operator already approved.
    if (!reusedDraft) {
      writeDraft({
        home,
        slug,
        description: args.description,
        files: composed.files,
        archetype: composed.archetype,
        source: 'composed',
      });
    }
    const status = args.publish ? 'published' : 'draft_created';
    if (args.publish) {
      publishDraft({ home, slug, description: args.description, createdAt });
    }
    const summary = summaryMarkdown({
      slug,
      description: args.description,
      status,
      home,
      shape: composed.shape,
      convergedRound: composed.convergedRound,
      reusedDraft,
    });
    writeText(summaryPath(home, slug), summary);

    const result = {
      schema_version: 1,
      action: 'generate',
      status,
      slug,
      shape: composed.shape,
      proposer_model: PROPOSER_MODEL_LABEL,
      // The round counters describe a composition. A reuse publish did not run
      // one, so it reports that it reused instead of reporting zero rounds.
      ...(reusedDraft
        ? { reused_draft: true }
        : { converged_round: composed.convergedRound, repair_rounds: composed.repairRounds }),
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
    const outPath = resultPath(home, slug, 'generate');
    writeJson(outPath, result);
    const finalResult = { ...result, result_path: outPath };
    if (progress !== undefined) {
      progress.emit({
        type: 'run.completed',
        recorded_at: now().toISOString(),
        label: 'Generate completed',
        display: {
          text: `Circuit generate ${status === 'published' ? 'published' : 'drafted'} ${slug}.`,
          importance: 'major',
          tone: 'success',
        },
        presentation: progressPresentation({
          blockId: progress.runId,
          statusText: `Generate ${status === 'published' ? 'published' : 'drafted'} ${slug}.`,
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
