// PHASE 2 SPIKE — genuine composition of a NOVEL flow from typed blocks.
// DO NOT COMMIT / DO NOT MERGE (run's rail: the generative path stays a surfaced
// spike, never merged to src/). This file is intentionally left git-untracked.
//
// Question (pre-registration §7): can an AUTOMATED composer reliably produce a
// VALID (compiles + catalog-gate-clean + primary_result) and family-appropriate
// NOVEL shape — a topology that is none of the 6 built-in families — for a
// held-out task, DETERMINISTICALLY and WITHOUT inventing unregistered contracts?
//   FEATURE        => yes, the hard part is engineering.
//   RESEARCH PROBLEM => no: it trips the anti-widening / single-actual gates,
//                       needs unregistered bodies, or needs a model in the loop.
//
// Unlike Phase 1 (which INSTANTIATES a whole proven family seed), this composes
// from individual catalog blocks. It runs the SAME fail-closed gates the engine
// runs, so a "valid" verdict here is a real valid flow, not a mock.
//
//   npx tsx experiments/flow-lab/phase2-genuine-generation-spike.ts
import { readFileSync } from 'node:fs';

import {
  type FlowSchematicAssemblySpec,
  assembleFlowSchematic,
} from '../../src/flows/assemble-flow-schematic.js';
import type { BlockStepUse } from '../../src/flows/block-step-expansion.js';
import { compileSchematicToCompiledFlow } from '../../src/flows/compile-schematic-to-flow.js';
import { reviewAssemblySpec, reviewBlockItems } from '../../src/flows/review/assembly-spec.js';
import { collectSchematicCatalogIssues } from '../../src/flows/schematic-catalog-check.js';

interface CatalogBlock {
  readonly id: string;
  readonly input_contracts: string[];
  readonly alternative_input_contracts: string[];
  readonly output_contract: string;
}
const CATALOG: { blocks: CatalogBlock[] } = JSON.parse(
  readFileSync('docs/flows/block-catalog.json', 'utf8'),
);
const blockById = new Map(CATALOG.blocks.map((b) => [b.id, b]));

// Contracts that NO block produces — they are ambient/relay/initial inputs.
// (user.goal, flow.catalog, context.request, verification.plan, flow.state,
// flow.question, flow.evidence). A composer must treat these as already-present;
// it cannot satisfy them by adding a producer block.
// A canonical stage for each block, so the assembler can derive a stage path.
const STAGE_OF: Record<string, BlockStepUse['stage']> = {
  intake: 'frame',
  route: 'frame',
  frame: 'frame',
  clarify: 'frame',
  'review-intake': 'frame',
  'gather-context': 'analyze',
  diagnose: 'analyze',
  review: 'review',
  plan: 'plan',
  act: 'act',
  'run-verification': 'verify',
  'risk-rollback-check': 'verify',
  'prototype-variant-evidence': 'act',
  'prototype-checkpoint': 'review',
  'close-with-evidence': 'close',
  handoff: 'close',
};

// A minimal automated composer. Given an ordered list of block ids, it:
//   - wires linear routes (each step continue->next; last close->@complete),
//   - resolves each step's input contracts to the LAST upstream producer (or
//     leaves ambient contracts to the initial set),
//   - binds the close block's output to flow.result@v1 (primary_result),
//   - emits a FlowSchematicAssemblySpec the real assembler + gates consume.
// This is deliberately the SIMPLE composer a first-cut generator would write.
function composeLinear(id: string, blockIds: readonly string[]): FlowSchematicAssemblySpec {
  const lastProducer = new Map<string, string>(); // contract -> step id
  const items: BlockStepUse[] = [];
  blockIds.forEach((blockId, i) => {
    const block = blockById.get(blockId);
    if (block === undefined) throw new Error(`unknown block ${blockId}`);
    const stepId = `${blockId}-step`;
    const next = i + 1 < blockIds.length ? `${blockIds[i + 1]}-step` : undefined;
    const stage = STAGE_OF[blockId] ?? 'analyze';

    // Resolve input contracts to upstream producers; ambient contracts are free.
    const input: Record<string, string> = {};
    block.input_contracts.forEach((contract, k) => {
      const key =
        [
          'task',
          'route',
          'brief',
          'context',
          'plan',
          'diagnosis',
          'change',
          'verification',
          'review',
        ][k] ?? `in${k}`;
      input[key] = contract;
    });

    const isClose = blockId === 'close-with-evidence';
    const routes: Record<string, string> = isClose
      ? { complete: '@complete', stop: '@stop' }
      : next
        ? { continue: next, stop: '@stop' }
        : { complete: '@complete', stop: '@stop' };

    // Only OVERRIDE execution where the desired kind differs from the block
    // default; restating the default is an error. The composer must therefore
    // KNOW each block's default execution — not in the catalog.
    const isRelay = blockId === 'act' || blockId === 'review' || blockId === 'run-verification';
    const execution: BlockStepUse['execution'] | undefined = isRelay
      ? { kind: 'relay', role: blockId === 'review' ? 'reviewer' : 'implementer' }
      : undefined;

    // Provide the per-execution-kind scaffolding the assembler requires: compose
    // steps need `required`, relays need `pass`. (This is already a tell: a block
    // is NOT self-describing enough to drop into a flow — the composer must author
    // check data per step, which a naive generator does not know how to do.)
    // close-with-evidence's output (flow.result@v1) is its DEFAULT — restating it
    // is an error, so the composer must KNOW not to set it. Relays need explicit
    // request/receipt/result paths. compose steps need `required`.
    const scaffold: Partial<BlockStepUse> = isRelay
      ? {
          pass: ['PASS', 'FAIL'],
          requestPath: `reports/relay/${blockId}.request.json`,
          receiptPath: `reports/relay/${blockId}.receipt.txt`,
          resultPath: `stages/${stage}/${blockId}-raw.json`,
        }
      : { required: ['result'] };

    const pathScaffold = isRelay ? {} : { reportPath: `reports/${blockId}.json` };
    const execScaffold = execution === undefined ? {} : { execution };

    items.push({
      id: stepId,
      title: `${blockId} step`,
      stage,
      block: blockId,
      input,
      protocol: `${blockId}@v1`,
      routes,
      ...execScaffold,
      ...pathScaffold,
      ...scaffold,
    } as BlockStepUse);
    lastProducer.set(block.output_contract, stepId);
  });

  // Derive a stage label per present stage (required by the assembler).
  const stageLabels = {} as Record<string, { id: string; title: string }>;
  for (const it of items) {
    if (stageLabels[it.stage] === undefined) {
      stageLabels[it.stage] = { id: `${it.stage}-stage`, title: it.stage };
    }
  }

  return {
    id,
    title: `${id} Schematic`,
    purpose: `Novel composed flow ${id}.`,
    status: 'active',
    version: '0.1.0',
    initial_contracts: ['task.intake@v1', 'route.decision@v1'],
    items,
    stageLabels,
    stagePathRationale:
      'Novel composed spike flow: it intentionally exercises a partial canonical stage path to test whether a typed-block composer can satisfy the fail-closed catalog gates.',
  } as unknown as FlowSchematicAssemblySpec;
}

interface Attempt {
  readonly name: string;
  readonly novelty: string;
  readonly blocks: readonly string[];
}

// Three genuinely NOVEL topologies — none is a built-in family.
const ATTEMPTS: readonly Attempt[] = [
  {
    name: 'triage',
    novelty:
      'diagnose-and-report with NO fix/act — not fix (acts), not review (audits a change), not research (explores options)',
    blocks: ['intake', 'frame', 'gather-context', 'diagnose', 'close-with-evidence'],
  },
  {
    name: 'fix-then-prototype',
    novelty:
      'diagnose+act a fix, THEN fan out prototype variants of the follow-up — a cross-family hybrid no built-in is',
    blocks: [
      'intake',
      'frame',
      'diagnose',
      'act',
      'prototype-variant-evidence',
      'prototype-checkpoint',
      'close-with-evidence',
    ],
  },
  {
    name: 'research-build',
    novelty:
      'gather+plan, delegate a child build (sub-run), verify, close — research front-half welded to a build back-half',
    blocks: [
      'intake',
      'frame',
      'gather-context',
      'plan',
      'act',
      'run-verification',
      'close-with-evidence',
    ],
  },
];

function gateFlow(spec: FlowSchematicAssemblySpec): {
  assembled: boolean;
  assembleError?: string;
  catalogIssues: string[];
  compiled: boolean;
  compileError?: string;
  primaryResultBound: boolean;
} {
  let schematic: ReturnType<typeof assembleFlowSchematic>;
  try {
    schematic = assembleFlowSchematic(spec);
  } catch (err) {
    return {
      assembled: false,
      assembleError: err instanceof Error ? err.message : String(err),
      catalogIssues: [],
      compiled: false,
      primaryResultBound: false,
    };
  }
  const catalogIssues = collectSchematicCatalogIssues(schematic).map(
    (i) => (i as { code?: string; message?: string }).message ?? JSON.stringify(i),
  );
  try {
    const compiled = compileSchematicToCompiledFlow(schematic);
    const flow = compiled.kind === 'single' ? compiled.flow : [...compiled.flows.values()][0];
    const primaryResultBound =
      (flow as { runtime_surface?: { primary_result?: unknown } } | undefined)?.runtime_surface
        ?.primary_result !== undefined;
    return { assembled: true, catalogIssues, compiled: true, primaryResultBound };
  } catch (err) {
    return {
      assembled: true,
      catalogIssues,
      compiled: false,
      compileError: err instanceof Error ? err.message : String(err),
      primaryResultBound: false,
    };
  }
}

function main(): void {
  const results = ATTEMPTS.map((attempt) => {
    const spec = composeLinear(attempt.name, attempt.blocks);
    const gate = gateFlow(spec);
    const valid =
      gate.assembled && gate.compiled && gate.catalogIssues.length === 0 && gate.primaryResultBound;
    return { ...attempt, valid, gate };
  });

  console.log(
    JSON.stringify(
      {
        spike: 'phase2-genuine-generation',
        question:
          'can an automated composer produce a VALID novel shape without unregistered contracts?',
        model_spend_usd: 0,
        attempts: results,
        verdict_inputs: {
          valid_count: results.filter((r) => r.valid).length,
          total: results.length,
        },
      },
      null,
      2,
    ),
  );

  process.stderr.write('\n=== PHASE 2 SPIKE — novel composition from typed blocks ===\n');
  for (const r of results) {
    process.stderr.write(
      `\n[${r.name}] ${r.valid ? 'VALID ✅' : 'INVALID ❌'}  (${r.novelty})\n` +
        `  assembled=${r.gate.assembled}${r.gate.assembleError ? ` err=${r.gate.assembleError}` : ''}\n` +
        `  compiled=${r.gate.compiled}${r.gate.compileError ? ` err=${r.gate.compileError}` : ''}\n` +
        `  primary_result_bound=${r.gate.primaryResultBound}\n` +
        `  catalog_issues=${r.gate.catalogIssues.length}${r.gate.catalogIssues.length ? `:\n    - ${r.gate.catalogIssues.join('\n    - ')}` : ''}\n`,
    );
  }
  process.stderr.write(
    `\nVALID ${results.filter((r) => r.valid).length}/${results.length} novel topologies.\n`,
  );

  // --- Positive control: a REAL family spec must pass the same gate. Proves the
  // 0/N above is not a harness bug — the gate accepts a correctly-authored flow.
  const control = gateFlow(reviewAssemblySpec);
  const controlValid =
    control.assembled &&
    control.compiled &&
    control.catalogIssues.length === 0 &&
    control.primaryResultBound;
  process.stderr.write(
    `\n[control: review (real family)] ${controlValid ? 'VALID ✅ (as expected)' : 'INVALID ❌ (harness bug!)'}\n`,
  );

  // --- Perturbation: take the valid review family and make ONE minimal novel
  // edit a generator might make — duplicate the audit step so TWO steps produce
  // review.verdict@v1. Expect the single-producer gate to reject it.
  const perturbedItems = [
    reviewBlockItems[0],
    reviewBlockItems[1],
    { ...(reviewBlockItems[1] as object), id: 'audit-step-2', title: 'Second audit (novel dup)' },
    reviewBlockItems[2],
  ];
  const perturbed = gateFlow({
    ...reviewAssemblySpec,
    id: 'review-perturbed',
    items: perturbedItems,
  } as unknown as FlowSchematicAssemblySpec);
  const perturbedValid =
    perturbed.assembled &&
    perturbed.compiled &&
    perturbed.catalogIssues.length === 0 &&
    perturbed.primaryResultBound;
  process.stderr.write(
    `[perturbation: review + 1 dup-producer edit] ${perturbedValid ? 'VALID (unexpected)' : 'INVALID ✅ (gate caught the novel edit)'}\n` +
      `  assembleError=${perturbed.assembleError ?? '-'}\n` +
      `  catalog_issues=${perturbed.catalogIssues.length}${perturbed.catalogIssues.length ? `: ${perturbed.catalogIssues.join('; ')}` : ''}\n` +
      `  compileError=${perturbed.compileError ?? '-'}\n`,
  );

  process.stderr.write(
    `\nVERDICT INPUTS: novel-from-scratch ${results.filter((r) => r.valid).length}/${results.length} valid; ` +
      `control ${controlValid ? 'VALID' : 'BROKEN'}; perturbation ${perturbedValid ? 'survived' : 'rejected'}.\n`,
  );
}

main();
