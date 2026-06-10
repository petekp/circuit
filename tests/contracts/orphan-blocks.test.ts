// Exerciser schematics for the five scalars in the catalog that no
// active schematic currently uses: queue, batch, risk-rollback-check,
// human-decision, handoff. The unexercised scalars' contracts are
// unfalsified claims — they say "this scalar accepts these inputs
// and produces this output", but no schematic has ever tried to wire them
// up. This test forces each one through the validation + compile +
// runtime execution path and records what's actually missing.
//
// Each test is a tight contract probe: build the smallest possible
// schematic that uses one orphan scalar and assert what happens at
// each layer (schematic parse → catalog compatibility → schematic compile →
// runtime execution). When a layer rejects, the assertion captures
// the message so the test documents the contract gap as observed
// behavior. As gaps are closed, the assertions tighten.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type CompileResult,
  compileSchematicToCompiledFlow,
} from '../../src/flows/compile-schematic-to-flow.js';
import type { ExecutorRegistry } from '../../src/runtime/executors/index.js';
import type { ExecutableStep } from '../../src/runtime/manifest/executable-flow.js';
import type { RunContext } from '../../src/runtime/run/run-context.js';
import type { CompiledFlow } from '../../src/schemas/compiled-flow.js';
import { FlowBlockCatalog } from '../../src/schemas/flow-blocks.js';
import {
  FlowSchematic,
  validateFlowSchematicCatalogCompatibility,
} from '../../src/schemas/flow-schematic.js';
import { runSimpleCompiledFlow } from '../helpers/runtime-flow.js';

function singleCompiledFlow(result: CompileResult): CompiledFlow {
  if (result.kind === 'single') return result.flow;
  const first = [...result.flows.values()][0];
  if (first === undefined) throw new Error('compile produced zero flows');
  return first;
}

function declaredRouteByStepId(flow: CompiledFlow): Record<string, string> {
  return Object.fromEntries(
    flow.steps.map((step) => {
      const route =
        step.routes.continue === undefined ? (Object.keys(step.routes)[0] ?? 'pass') : 'continue';
      return [step.id, route];
    }),
  );
}

async function writeSyntheticReport(step: ExecutableStep, context: RunContext): Promise<void> {
  const report = step.writes?.report;
  if (report === undefined) return;
  const path = context.files.resolve(report);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({
      scope: 'synthetic orphan scalar exerciser',
      items: [],
      decision: 'continue',
      continuity_record_path: 'reports/handoff.json',
    })}\n`,
    'utf8',
  );
}

function syntheticOrphanExecutors(flow: CompiledFlow): Partial<ExecutorRegistry> {
  const routeByStepId = declaredRouteByStepId(flow);
  return {
    compose: async (step, context) => {
      if (step.kind !== 'compose') throw new Error('expected compose step');
      await writeSyntheticReport(step, context);
      return {
        route: routeByStepId[step.id] ?? 'pass',
        details: { report: step.writes?.report?.path },
      };
    },
    checkpoint: async (step, context) => {
      if (step.kind !== 'checkpoint') throw new Error('expected checkpoint step');
      const choice = routeByStepId[step.id] ?? step.choices[0] ?? 'continue';
      if (step.writes?.request !== undefined) {
        await context.files.writeJson(step.writes.request, {
          step_id: step.id,
          choices: step.choices,
        });
      }
      if (step.writes?.response !== undefined) {
        await context.files.writeJson(step.writes.response, {
          step_id: step.id,
          selected_choice: choice,
        });
      }
      return { route: choice, details: { selected_choice: choice } };
    },
  };
}

function loadCatalog() {
  const raw = JSON.parse(readFileSync('docs/flows/block-catalog.json', 'utf8')) as unknown;
  return FlowBlockCatalog.parse(raw);
}

// Minimal schematic shell. Per-test customizes the items and contract aliases.
// Default stages include frame + close so an orphan scalar that wants
// a different stage can be added by the test.
function schematicShell(overrides: {
  id: string;
  starts_at: string;
  initial_contracts?: readonly string[];
  contract_aliases?: ReadonlyArray<{ generic: string; actual: string }>;
  items: ReadonlyArray<unknown>;
  stages: ReadonlyArray<{ canonical: string; id: string; title: string }>;
  stage_path_omits: readonly string[];
  stage_path_rationale?: string;
}): unknown {
  return {
    schema_version: '1',
    id: overrides.id,
    title: `Orphan scalar exerciser: ${overrides.id}`,
    purpose: `Synthetic schematic that exercises a single orphan scalar (${overrides.id}) so its contract is forced through validate → compile → run.`,
    status: 'candidate',
    starts_at: overrides.starts_at,
    initial_contracts: overrides.initial_contracts ?? [],
    contract_aliases: overrides.contract_aliases ?? [],
    items: overrides.items,
    version: '0.0.1',
    axes: {
      allowed_rigors: ['standard'],
      supports_tournament: false,
      supports_autonomous: false,
    },
    stage_path_policy: {
      mode: 'partial',
      omits: overrides.stage_path_omits,
      rationale:
        overrides.stage_path_rationale ??
        'Synthetic exerciser for orphan scalar — non-exercised canonical stages are deliberately omitted.',
    },
    stages: overrides.stages,
  };
}

let runFolder: string;

beforeEach(() => {
  runFolder = mkdtempSync(join(tmpdir(), 'circuit-orphan-'));
});

afterEach(() => {
  rmSync(runFolder, { recursive: true, force: true });
});

// =====================================================================
// handoff: inputs flow.state + flow.brief → output continuity.record
// surface: orchestrator, allowed kinds: compose | checkpoint
// allowed routes: continue | handoff | escalate
// stage: close
// =====================================================================
describe('orphan scalar: handoff', () => {
  const schematicRaw = schematicShell({
    id: 'orphan-handoff',
    starts_at: 'frame-step',
    initial_contracts: ['flow.state@v1', 'task.intake@v1', 'route.decision@v1'],
    items: [
      {
        id: 'frame-step',
        block: 'frame',
        title: 'Frame',
        stage: 'frame',
        input: { intake: 'task.intake@v1', route: 'route.decision@v1' },
        output: 'flow.brief@v1',
        evidence_requirements: ['scope boundary', 'constraints', 'proof plan'],
        execution: { kind: 'compose' },
        protocol: 'orphan-frame@v1',
        writes: { report_path: 'reports/brief.json' },
        check: { required: ['scope'] },
        routes: { continue: 'handoff-step' },
      },
      {
        id: 'handoff-step',
        block: 'handoff',
        title: 'Handoff',
        stage: 'close',
        input: { state: 'flow.state@v1', brief: 'flow.brief@v1' },
        output: 'continuity.record@v1',
        evidence_requirements: [
          'goal',
          'completed moves',
          'pending evidence',
          'next action',
          'known debt',
        ],
        execution: { kind: 'compose' },
        protocol: 'orphan-handoff@v1',
        writes: { report_path: 'reports/handoff.json' },
        check: { required: ['continuity_record_path'] },
        routes: { complete: '@complete' },
      },
    ],
    stages: [
      { canonical: 'frame', id: 'frame-stage', title: 'Frame' },
      { canonical: 'close', id: 'close-stage', title: 'Close' },
    ],
    stage_path_omits: ['analyze', 'plan', 'act', 'verify', 'review'],
  });

  it('parses through FlowSchematic', () => {
    expect(() => FlowSchematic.parse(schematicRaw)).not.toThrow();
  });

  it('passes catalog compatibility validation', () => {
    const schematic = FlowSchematic.parse(schematicRaw);
    const issues = validateFlowSchematicCatalogCompatibility(schematic, loadCatalog());
    expect(issues, JSON.stringify(issues, null, 2)).toEqual([]);
  });

  it('compiles to a CompiledFlow', () => {
    const schematic = FlowSchematic.parse(schematicRaw);
    expect(() => compileSchematicToCompiledFlow(schematic)).not.toThrow();
  });

  it('runs end-to-end via the runtime simple executors', async () => {
    const schematic = FlowSchematic.parse(schematicRaw);
    const flow = singleCompiledFlow(compileSchematicToCompiledFlow(schematic));
    const outcome = await runSimpleCompiledFlow({
      runDir: join(runFolder, 'handoff-run'),
      flowBytes: Buffer.from(JSON.stringify(flow)),
      runId: '00000000-0000-0000-0000-00000000aaaa',
      goal: 'orphan-handoff exerciser',
      executors: syntheticOrphanExecutors(flow),
    });
    expect(outcome.outcome).toBe('complete');
  });
});

// =====================================================================
// human-decision: inputs flow.question + flow.evidence → output decision.answer
// surface: host, allowed kinds: checkpoint
// allowed routes: continue | retry | revise | ask | stop | handoff | escalate
// stage: any canonical stage
// =====================================================================
describe('orphan scalar: human-decision', () => {
  const schematicRaw = schematicShell({
    id: 'orphan-human-decision',
    starts_at: 'frame-step',
    initial_contracts: [
      'task.intake@v1',
      'route.decision@v1',
      'flow.question@v1',
      'flow.evidence@v1',
    ],
    items: [
      {
        id: 'frame-step',
        block: 'frame',
        title: 'Frame',
        stage: 'frame',
        input: { intake: 'task.intake@v1', route: 'route.decision@v1' },
        output: 'flow.brief@v1',
        evidence_requirements: ['scope boundary', 'constraints', 'proof plan'],
        execution: { kind: 'compose' },
        protocol: 'orphan-frame@v1',
        writes: { report_path: 'reports/brief.json' },
        check: { required: ['scope'] },
        routes: { continue: 'decision-step' },
      },
      {
        id: 'decision-step',
        block: 'human-decision',
        title: 'Human Decision',
        stage: 'analyze',
        input: { question: 'flow.question@v1', evidence: 'flow.evidence@v1' },
        output: 'decision.answer@v1',
        evidence_requirements: [
          'question',
          'available options',
          'selected option',
          'answer source',
        ],
        execution: { kind: 'checkpoint' },
        protocol: 'orphan-decision@v1',
        writes: {
          checkpoint_request_path: 'reports/checkpoints/decision.request.json',
          checkpoint_response_path: 'reports/checkpoints/decision.response.json',
        },
        check: { allow: ['continue'] },
        routes: { continue: '@complete' },
        checkpoint_policy: {
          prompt: 'Should the run continue past this human-decision exerciser?',
          choices: [
            {
              id: 'continue',
              label: 'Continue',
              description: 'Proceed past the human decision.',
            },
          ],
          safe_default_choice: 'continue',
        },
      },
    ],
    stages: [
      { canonical: 'frame', id: 'frame-stage', title: 'Frame' },
      { canonical: 'analyze', id: 'analyze-stage', title: 'Analyze' },
    ],
    stage_path_omits: ['plan', 'act', 'verify', 'review', 'close'],
  });

  it('parses through FlowSchematic', () => {
    expect(() => FlowSchematic.parse(schematicRaw)).not.toThrow();
  });

  it('passes catalog compatibility validation', () => {
    const schematic = FlowSchematic.parse(schematicRaw);
    const issues = validateFlowSchematicCatalogCompatibility(schematic, loadCatalog());
    expect(issues, JSON.stringify(issues, null, 2)).toEqual([]);
  });

  it('compiles to a CompiledFlow', () => {
    const schematic = FlowSchematic.parse(schematicRaw);
    expect(() => compileSchematicToCompiledFlow(schematic)).not.toThrow();
  });

  it('resolves the checkpoint via declared default choice and runs to complete', async () => {
    // The host scalar's runtime contract is "pause for the operator and
    // record the answer". When no operator is present and the entry asks for
    // autonomous execution, the runner takes the declared default choice. To
    // observe an actual pause we'd need a checkpoint policy that omits that
    // default; the contract probe here just confirms the scalar is wireable
    // end-to-end.
    const schematic = FlowSchematic.parse(schematicRaw);
    const flow = singleCompiledFlow(compileSchematicToCompiledFlow(schematic));
    const outcome = await runSimpleCompiledFlow({
      runDir: join(runFolder, 'human-decision-run'),
      flowBytes: Buffer.from(JSON.stringify(flow)),
      runId: '00000000-0000-0000-0000-00000000eeee',
      goal: 'orphan-human-decision exerciser',
      executors: syntheticOrphanExecutors(flow),
    });
    expect(outcome.outcome).toBe('complete');
  });
});

// =====================================================================
// queue: inputs flow.brief + context.packet → output work.queue
// surface: orchestrator, allowed kinds: compose | checkpoint
// stage: plan
// =====================================================================
describe('orphan scalar: queue', () => {
  const schematicRaw = schematicShell({
    id: 'orphan-queue',
    starts_at: 'frame-step',
    initial_contracts: ['task.intake@v1', 'route.decision@v1', 'context.packet@v1'],
    items: [
      {
        id: 'frame-step',
        block: 'frame',
        title: 'Frame',
        stage: 'frame',
        input: { intake: 'task.intake@v1', route: 'route.decision@v1' },
        output: 'flow.brief@v1',
        evidence_requirements: ['scope boundary', 'constraints', 'proof plan'],
        execution: { kind: 'compose' },
        protocol: 'orphan-frame@v1',
        writes: { report_path: 'reports/brief.json' },
        check: { required: ['scope'] },
        routes: { continue: 'queue-step' },
      },
      {
        id: 'queue-step',
        block: 'queue',
        title: 'Queue',
        stage: 'plan',
        input: { brief: 'flow.brief@v1', context: 'context.packet@v1' },
        output: 'work.queue@v1',
        evidence_requirements: ['ordered items', 'item state', 'risk class', 'selection rule'],
        execution: { kind: 'compose' },
        protocol: 'orphan-queue@v1',
        writes: { report_path: 'reports/queue.json' },
        check: { required: ['items'] },
        routes: { continue: '@complete' },
      },
    ],
    stages: [
      { canonical: 'frame', id: 'frame-stage', title: 'Frame' },
      { canonical: 'plan', id: 'plan-stage', title: 'Plan' },
    ],
    stage_path_omits: ['analyze', 'act', 'verify', 'review', 'close'],
  });

  it('parses through FlowSchematic', () => {
    expect(() => FlowSchematic.parse(schematicRaw)).not.toThrow();
  });

  it('passes catalog compatibility validation', () => {
    const schematic = FlowSchematic.parse(schematicRaw);
    const issues = validateFlowSchematicCatalogCompatibility(schematic, loadCatalog());
    expect(issues, JSON.stringify(issues, null, 2)).toEqual([]);
  });

  it('compiles to a CompiledFlow', () => {
    const schematic = FlowSchematic.parse(schematicRaw);
    expect(() => compileSchematicToCompiledFlow(schematic)).not.toThrow();
  });

  it('runs end-to-end via the runtime simple executors', async () => {
    const schematic = FlowSchematic.parse(schematicRaw);
    const flow = singleCompiledFlow(compileSchematicToCompiledFlow(schematic));
    const outcome = await runSimpleCompiledFlow({
      runDir: join(runFolder, 'queue-run'),
      flowBytes: Buffer.from(JSON.stringify(flow)),
      runId: '00000000-0000-0000-0000-00000000bbbb',
      goal: 'orphan-queue exerciser',
      executors: syntheticOrphanExecutors(flow),
    });
    expect(outcome.outcome).toBe('complete');
  });
});

// =====================================================================
// batch: inputs work.queue + flow.brief → output batch.result
// surface: mixed, allowed kinds: compose | relay | verification | checkpoint
// stage: act
// =====================================================================
describe('orphan scalar: batch', () => {
  const schematicRaw = schematicShell({
    id: 'orphan-batch',
    starts_at: 'frame-step',
    initial_contracts: ['task.intake@v1', 'route.decision@v1', 'work.queue@v1'],
    items: [
      {
        id: 'frame-step',
        block: 'frame',
        title: 'Frame',
        stage: 'frame',
        input: { intake: 'task.intake@v1', route: 'route.decision@v1' },
        output: 'flow.brief@v1',
        evidence_requirements: ['scope boundary', 'constraints', 'proof plan'],
        execution: { kind: 'compose' },
        protocol: 'orphan-frame@v1',
        writes: { report_path: 'reports/brief.json' },
        check: { required: ['scope'] },
        routes: { continue: 'batch-step' },
      },
      {
        id: 'batch-step',
        block: 'batch',
        title: 'Batch',
        stage: 'act',
        input: { queue: 'work.queue@v1', brief: 'flow.brief@v1' },
        output: 'batch.result@v1',
        evidence_requirements: [
          'completed items',
          'skipped items',
          'blocked items',
          'failed items',
        ],
        execution: { kind: 'compose' },
        protocol: 'orphan-batch@v1',
        writes: { report_path: 'reports/batch.json' },
        check: { required: ['items'] },
        routes: { continue: '@complete' },
      },
    ],
    stages: [
      { canonical: 'frame', id: 'frame-stage', title: 'Frame' },
      { canonical: 'act', id: 'act-stage', title: 'Act' },
    ],
    stage_path_omits: ['analyze', 'plan', 'verify', 'review', 'close'],
  });

  it('parses through FlowSchematic', () => {
    expect(() => FlowSchematic.parse(schematicRaw)).not.toThrow();
  });

  it('passes catalog compatibility validation', () => {
    const schematic = FlowSchematic.parse(schematicRaw);
    const issues = validateFlowSchematicCatalogCompatibility(schematic, loadCatalog());
    expect(issues, JSON.stringify(issues, null, 2)).toEqual([]);
  });

  it('compiles to a CompiledFlow', () => {
    const schematic = FlowSchematic.parse(schematicRaw);
    expect(() => compileSchematicToCompiledFlow(schematic)).not.toThrow();
  });

  it('runs end-to-end via the runtime simple executors', async () => {
    const schematic = FlowSchematic.parse(schematicRaw);
    const flow = singleCompiledFlow(compileSchematicToCompiledFlow(schematic));
    const outcome = await runSimpleCompiledFlow({
      runDir: join(runFolder, 'batch-run'),
      flowBytes: Buffer.from(JSON.stringify(flow)),
      runId: '00000000-0000-0000-0000-00000000cccc',
      goal: 'orphan-batch exerciser',
      executors: syntheticOrphanExecutors(flow),
    });
    expect(outcome.outcome).toBe('complete');
  });
});

// =====================================================================
// risk-rollback-check: inputs change.evidence + verification.result + flow.brief
// → output risk.decision
// surface: orchestrator, allowed kinds: compose | checkpoint
// stage: verify or close
// =====================================================================
describe('orphan scalar: risk-rollback-check', () => {
  const schematicRaw = schematicShell({
    id: 'orphan-risk-rollback-check',
    starts_at: 'frame-step',
    initial_contracts: [
      'task.intake@v1',
      'route.decision@v1',
      'change.evidence@v1',
      'verification.result@v1',
    ],
    items: [
      {
        id: 'frame-step',
        block: 'frame',
        title: 'Frame',
        stage: 'frame',
        input: { intake: 'task.intake@v1', route: 'route.decision@v1' },
        output: 'flow.brief@v1',
        evidence_requirements: ['scope boundary', 'constraints', 'proof plan'],
        execution: { kind: 'compose' },
        protocol: 'orphan-frame@v1',
        writes: { report_path: 'reports/brief.json' },
        check: { required: ['scope'] },
        routes: { continue: 'risk-step' },
      },
      {
        id: 'risk-step',
        block: 'risk-rollback-check',
        title: 'Risk and Rollback',
        stage: 'close',
        input: {
          change: 'change.evidence@v1',
          verification: 'verification.result@v1',
          brief: 'flow.brief@v1',
        },
        output: 'risk.decision@v1',
        evidence_requirements: ['risk class', 'allowed next action', 'recovery option'],
        execution: { kind: 'compose' },
        protocol: 'orphan-risk@v1',
        writes: { report_path: 'reports/risk.json' },
        check: { required: ['decision'] },
        routes: { continue: '@complete' },
      },
    ],
    stages: [
      { canonical: 'frame', id: 'frame-stage', title: 'Frame' },
      { canonical: 'close', id: 'close-stage', title: 'Close' },
    ],
    stage_path_omits: ['analyze', 'plan', 'act', 'verify', 'review'],
  });

  it('parses through FlowSchematic', () => {
    expect(() => FlowSchematic.parse(schematicRaw)).not.toThrow();
  });

  it('passes catalog compatibility validation', () => {
    const schematic = FlowSchematic.parse(schematicRaw);
    const issues = validateFlowSchematicCatalogCompatibility(schematic, loadCatalog());
    expect(issues, JSON.stringify(issues, null, 2)).toEqual([]);
  });

  it('compiles to a CompiledFlow', () => {
    const schematic = FlowSchematic.parse(schematicRaw);
    expect(() => compileSchematicToCompiledFlow(schematic)).not.toThrow();
  });

  it('runs end-to-end via the runtime simple executors', async () => {
    const schematic = FlowSchematic.parse(schematicRaw);
    const flow = singleCompiledFlow(compileSchematicToCompiledFlow(schematic));
    const outcome = await runSimpleCompiledFlow({
      runDir: join(runFolder, 'risk-run'),
      flowBytes: Buffer.from(JSON.stringify(flow)),
      runId: '00000000-0000-0000-0000-00000000dddd',
      goal: 'orphan-risk exerciser',
      executors: syntheticOrphanExecutors(flow),
    });
    expect(outcome.outcome).toBe('complete');
  });
});
