import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { isGenericallyLegitRoute } from '../../src/policy/recovery-route-policy.js';
import { FlowBlockCatalog } from '../../src/schemas/flow-blocks.js';
import {
  FlowSchematic,
  validateFlowSchematicCatalogCompatibility,
} from '../../src/schemas/flow-schematic.js';
import { StepId } from '../../src/schemas/ids.js';

const blockCatalogPath = 'docs/flows/block-catalog.json';
const fixSchematicPath = 'src/flows/fix/schematic.json';

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function parseBlockCatalog() {
  return FlowBlockCatalog.parse(readJson(blockCatalogPath));
}

function parseFixSchematic() {
  return FlowSchematic.parse(readJson(fixSchematicPath));
}

describe('flow schematic schema — active Fix schematic', () => {
  it('parses the active Fix schematic', () => {
    const schematic = parseFixSchematic();
    expect(schematic.schema_version).toBe('2');
    expect(schematic.id as unknown as string).toBe('fix');
    expect(schematic.status).toBe('active');
    expect(schematic.starts_at as unknown as string).toBe('fix-frame');
  });

  it('keeps the Fix schematic compatible with the block catalog', () => {
    const issues = validateFlowSchematicCatalogCompatibility(
      parseFixSchematic(),
      parseBlockCatalog(),
    );
    expect(issues).toEqual([]);
  });

  it('keeps Fix human-decision evidence bound through a generic evidence alias', () => {
    const schematic = parseFixSchematic();
    expect(schematic.contract_aliases).toContainEqual({
      generic: 'flow.evidence@v1',
      actual: 'fix.diagnosis@v1',
    });
  });

  it('uses the expected Fix block sequence', () => {
    const schematic = parseFixSchematic();
    expect(schematic.items.map((item) => item.block)).toEqual([
      'frame',
      'gather-context',
      'diagnose',
      'human-decision',
      'run-verification',
      'run-verification',
      'act',
      'run-verification',
      'run-verification',
      'run-verification',
      'review',
      'close-with-evidence',
      'close-with-evidence',
      'handoff',
    ]);
  });

  it('keeps Fix stage bindings aligned with the intended flow shape', () => {
    const schematic = parseFixSchematic();
    expect(schematic.items.map((item) => [item.id as unknown as string, item.stage])).toEqual([
      ['fix-frame', 'frame'],
      ['fix-gather-context', 'analyze'],
      ['fix-diagnose', 'analyze'],
      ['fix-no-repro-decision', 'analyze'],
      ['fix-regression-baseline', 'verify'],
      ['fix-baseline-snapshot', 'verify'],
      ['fix-act', 'act'],
      ['fix-verify', 'verify'],
      ['fix-change-set', 'verify'],
      ['fix-regression-rerun', 'verify'],
      ['fix-review', 'review'],
      ['fix-close-low', 'close'],
      ['fix-close', 'close'],
      ['fix-handoff', 'close'],
    ]);
  });

  it('keeps Fix execution bindings aligned with the intended compiler shape', () => {
    const schematic = parseFixSchematic();
    expect(schematic.items.map((item) => [item.id as unknown as string, item.execution])).toEqual([
      ['fix-frame', { kind: 'compose' }],
      ['fix-gather-context', { kind: 'relay', role: 'researcher' }],
      ['fix-diagnose', { kind: 'relay', role: 'researcher' }],
      ['fix-no-repro-decision', { kind: 'checkpoint' }],
      ['fix-regression-baseline', { kind: 'verification' }],
      ['fix-baseline-snapshot', { kind: 'verification' }],
      ['fix-act', { kind: 'relay', role: 'implementer' }],
      ['fix-verify', { kind: 'verification' }],
      ['fix-change-set', { kind: 'verification' }],
      ['fix-regression-rerun', { kind: 'verification' }],
      ['fix-review', { kind: 'relay', role: 'reviewer' }],
      ['fix-close-low', { kind: 'compose' }],
      ['fix-close', { kind: 'compose' }],
      ['fix-handoff', { kind: 'compose' }],
    ]);
  });

  it('keeps Fix act acceptance criteria on the relay item only', () => {
    const schematic = parseFixSchematic();
    const act = schematic.items.find((item) => (item.id as unknown as string) === 'fix-act');
    if (act === undefined) throw new Error('fix-act missing');

    expect(act.acceptance_criteria).toEqual({
      checks: [
        {
          kind: 'report_field',
          id: 'changed-files-present',
          path: ['changed_files'],
          predicate: 'present',
        },
        {
          kind: 'report_field',
          id: 'evidence-non-empty',
          path: ['evidence'],
          predicate: 'non_empty',
        },
      ],
      on_failure: { mode: 'retry-with-feedback' },
    });
  });

  it('rejects acceptance criteria on non-relay schematic items', () => {
    const raw = readJson(fixSchematicPath);
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('expected fix schematic object');
    }
    const mutated = structuredClone(raw) as {
      readonly items: Array<Record<string, unknown>>;
    };
    mutated.items[0] = {
      ...mutated.items[0],
      acceptance_criteria: {
        checks: [
          {
            kind: 'report_field',
            id: 'not-for-compose',
            path: ['evidence'],
            predicate: 'present',
          },
        ],
      },
    };

    const parsed = FlowSchematic.safeParse(mutated);
    expect(parsed.success).toBe(false);
  });

  it('keeps Fix close inputs aligned with the evidence path (low skips review)', () => {
    const schematic = parseFixSchematic();
    const closeLow = schematic.items.find(
      (item) => (item.id as unknown as string) === 'fix-close-low',
    );
    const close = schematic.items.find((item) => (item.id as unknown as string) === 'fix-close');
    if (closeLow === undefined) throw new Error('fix-close-low missing');
    if (close === undefined) throw new Error('fix-close missing');

    expect(closeLow.input).toMatchObject({
      brief: 'fix.brief@v1',
      context: 'fix.context@v1',
      diagnosis: 'fix.diagnosis@v1',
      regression: 'fix.regression-proof@v1',
      baseline_snapshot: 'fix.baseline-snapshot@v1',
      change: 'fix.change@v1',
      verification: 'fix.verification@v1',
      regression_rerun: 'fix.regression-rerun@v1',
      change_set: 'fix.change-set@v1',
    });
    expect(closeLow.input).not.toHaveProperty('review');
    expect(close.input).toMatchObject({
      brief: 'fix.brief@v1',
      context: 'fix.context@v1',
      diagnosis: 'fix.diagnosis@v1',
      regression: 'fix.regression-proof@v1',
      baseline_snapshot: 'fix.baseline-snapshot@v1',
      change: 'fix.change@v1',
      verification: 'fix.verification@v1',
      regression_rerun: 'fix.regression-rerun@v1',
      change_set: 'fix.change-set@v1',
      review: 'fix.review@v1',
    });
  });

  it('routes low-depth regression-rerun directly to a no-review close item via route_overrides', () => {
    // Slice 2 v2: regression-rerun is the last verification step before
    // close, so the low override sits there (not on change-set as in v1).
    const schematic = parseFixSchematic();
    const verify = schematic.items.find((item) => (item.id as unknown as string) === 'fix-verify');
    if (verify === undefined) throw new Error('fix-verify missing');
    const changeSet = schematic.items.find(
      (item) => (item.id as unknown as string) === 'fix-change-set',
    );
    if (changeSet === undefined) throw new Error('fix-change-set missing');
    const regressionRerun = schematic.items.find(
      (item) => (item.id as unknown as string) === 'fix-regression-rerun',
    );
    if (regressionRerun === undefined) throw new Error('fix-regression-rerun missing');

    expect(verify.routes.continue).toBe('fix-change-set');
    expect(changeSet.routes.continue).toBe('fix-regression-rerun');
    expect(regressionRerun.routes.continue).toBe('fix-review');
    const review = schematic.items.find((item) => (item.id as unknown as string) === 'fix-review');
    if (review === undefined) throw new Error('fix-review missing');
    expect(review.routes['connector-failed']).toBe('fix-close');
    expect(regressionRerun.route_overrides).toEqual({
      continue: {
        low: 'fix-close-low',
      },
    });
  });

  it('captures the pre-fix proof before any specialist relay can edit the checkout', () => {
    const schematic = parseFixSchematic();
    const byId = new Map(schematic.items.map((item) => [item.id as unknown as string, item]));

    expect(byId.get('fix-frame')?.routes.continue).toBe('fix-regression-baseline');
    expect(byId.get('fix-regression-baseline')?.routes.continue).toBe('fix-baseline-snapshot');
    expect(byId.get('fix-baseline-snapshot')?.routes.continue).toBe('fix-gather-context');
    expect(byId.get('fix-diagnose')?.routes.continue).toBe('fix-act');
    expect(byId.get('fix-no-repro-decision')?.routes.continue).toBe('fix-act');
  });

  it('keeps fix-no-repro-decision and fix-handoff off every default route (compiled, not runtime-reachable)', () => {
    // The Fix purpose string (src/flows/fix/data.ts) and contract.md describe
    // fix.no-repro-decision and the handoff step as future ask/handoff routing
    // intent: compiled into the flow but never selected at runtime. The
    // mechanism is that they are reached only through `ask`/`handoff` route
    // outcomes, and the engine emits no failure cause those recovery bindings
    // accept. Pin the schematic half here: if a future change adds a default
    // route (e.g. `continue`/`complete`, or a route override) into either step,
    // this fails and the contract caveat must change with it.
    const schematic = parseFixSchematic();
    const incomingOutcomes = (targetId: string): Set<string> => {
      const outcomes = new Set<string>();
      for (const item of schematic.items) {
        for (const [outcome, target] of Object.entries(item.routes)) {
          if ((target as unknown as string) === targetId) outcomes.add(outcome);
        }
        for (const perOutcome of Object.values(item.route_overrides ?? {})) {
          for (const target of Object.values(perOutcome)) {
            if ((target as unknown as string) === targetId) outcomes.add('override');
          }
        }
      }
      return outcomes;
    };

    expect(incomingOutcomes('fix-no-repro-decision')).toEqual(new Set(['ask']));
    expect(incomingOutcomes('fix-handoff')).toEqual(new Set(['handoff']));
  });

  it('rejects an unknown route target at parse time', () => {
    const raw = readJson(fixSchematicPath) as Record<string, unknown>;
    const items = raw.items as Array<Record<string, unknown>>;
    const first = items[0];
    if (first === undefined) throw new Error('fixture missing first item');
    first.routes = { continue: 'missing-item' };
    const result = FlowSchematic.safeParse(raw);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(/unknown schematic item id/);
    }
  });

  it('rejects an unknown route override target at parse time', () => {
    const raw = readJson(fixSchematicPath) as Record<string, unknown>;
    const items = raw.items as Array<Record<string, unknown>>;
    const verify = items.find((item) => item.id === 'fix-verify');
    if (verify === undefined) throw new Error('fixture missing verify item');
    verify.route_overrides = { continue: { low: 'missing-item' } };
    const result = FlowSchematic.safeParse(raw);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(
        /route override target references unknown schematic item/,
      );
    }
  });

  it('rejects route overrides for undeclared route outcomes', () => {
    const raw = readJson(fixSchematicPath) as Record<string, unknown>;
    const items = raw.items as Array<Record<string, unknown>>;
    const verify = items.find((item) => item.id === 'fix-verify');
    if (verify === undefined) throw new Error('fixture missing verify item');
    verify.route_overrides = { split: { low: 'fix-close-low' } };
    const result = FlowSchematic.safeParse(raw);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(/route override must target a declared route outcome/);
    }
  });

  it('rejects duplicate evidence requirements at parse time', () => {
    const raw = readJson(fixSchematicPath) as Record<string, unknown>;
    const items = raw.items as Array<Record<string, unknown>>;
    const diagnose = items.find((item) => item.id === 'fix-diagnose');
    if (diagnose === undefined) throw new Error('fixture missing diagnose item');
    diagnose.evidence_requirements = ['confidence', 'confidence'];

    const result = FlowSchematic.safeParse(raw);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(/duplicate evidence requirement/);
    }
  });

  it('rejects relay execution without a role at parse time', () => {
    const raw = readJson(fixSchematicPath) as Record<string, unknown>;
    const items = raw.items as Array<Record<string, unknown>>;
    const act = items.find((item) => item.id === 'fix-act');
    if (act === undefined) throw new Error('fixture missing act item');
    act.execution = { kind: 'relay' };

    const result = FlowSchematic.safeParse(raw);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          code: 'invalid_value',
          path: ['items', 6, 'execution', 'role'],
        }),
      );
    }
  });

  it('rejects relay roles on non-relay execution at parse time', () => {
    const raw = readJson(fixSchematicPath) as Record<string, unknown>;
    const items = raw.items as Array<Record<string, unknown>>;
    const frame = items.find((item) => item.id === 'fix-frame');
    if (frame === undefined) throw new Error('fixture missing frame item');
    frame.execution = { kind: 'compose', role: 'researcher' };

    const result = FlowSchematic.safeParse(raw);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          code: 'unrecognized_keys',
          keys: ['role'],
          path: ['items', 0, 'execution'],
        }),
      );
    }
  });

  it('reports route outcomes that the selected block does not allow', () => {
    const schematic = parseFixSchematic();
    const frame = schematic.items.find((item) => (item.id as unknown as string) === 'fix-frame');
    if (frame === undefined) throw new Error('fix-frame missing');
    // `diagnose` is a flow-specific route — not NORMAL, not recovery-bound — so
    // the per-block list is the only thing that can authorize it. frame does not
    // list it, so it must be flagged.
    frame.routes = { ...frame.routes, diagnose: '@stop' };
    const issues = validateFlowSchematicCatalogCompatibility(schematic, parseBlockCatalog());
    expect(issues).toContainEqual({
      item_id: 'fix-frame',
      message: 'route "diagnose" is not allowed by block "frame"',
    });
  });

  it('accepts NORMAL and recovery-bound routes the block does not list (gate recognition)', () => {
    const schematic = parseFixSchematic();
    const frame = schematic.items.find((item) => (item.id as unknown as string) === 'fix-frame');
    if (frame === undefined) throw new Error('fix-frame missing');
    // frame.allowed_routes is ['continue', 'revise', 'ask', 'stop']. `complete` is
    // a NORMAL forward route and `retry` is recovery-bound; both are first-class
    // across every flow, so with the policy recognizer injected the validator must
    // NOT flag them even though frame's block list omits them.
    frame.routes = {
      ...frame.routes,
      complete: '@complete',
      retry: 'fix-frame' as unknown as StepId,
    };
    const issues = validateFlowSchematicCatalogCompatibility(schematic, parseBlockCatalog(), {
      recognizeRoute: isGenericallyLegitRoute,
    });
    const routeIssues = issues.filter((issue) => issue.message.includes('is not allowed by block'));
    expect(routeIssues).toEqual([]);
  });

  it('reports schematic items that omit block evidence requirements', () => {
    const schematic = parseFixSchematic();
    const diagnose = schematic.items.find(
      (item) => (item.id as unknown as string) === 'fix-diagnose',
    );
    if (diagnose === undefined) throw new Error('fix-diagnose missing');
    diagnose.evidence_requirements = ['cause hypothesis'];

    const issues = validateFlowSchematicCatalogCompatibility(schematic, parseBlockCatalog());
    expect(issues).toContainEqual({
      item_id: 'fix-diagnose',
      message:
        'evidence requirement "confidence" from block "diagnose" is not declared by schematic item',
    });
  });

  it('reports execution kinds that do not match the selected block surface', () => {
    const schematic = parseFixSchematic();
    const act = schematic.items.find((item) => (item.id as unknown as string) === 'fix-act');
    if (act === undefined) throw new Error('fix-act missing');
    act.execution = { kind: 'checkpoint' };

    const issues = validateFlowSchematicCatalogCompatibility(schematic, parseBlockCatalog());
    expect(issues).toContainEqual({
      item_id: 'fix-act',
      message:
        'execution kind "checkpoint" is not compatible with block "act"; expected one of relay, compose, fanout',
    });
  });

  it('reports stage bindings that do not match the selected block', () => {
    const schematic = parseFixSchematic();
    const act = schematic.items.find((item) => (item.id as unknown as string) === 'fix-act');
    if (act === undefined) throw new Error('fix-act missing');
    act.stage = 'analyze';

    const issues = validateFlowSchematicCatalogCompatibility(schematic, parseBlockCatalog());
    expect(issues).toContainEqual({
      item_id: 'fix-act',
      message: 'stage "analyze" is not compatible with block "act"; expected one of act',
    });
  });

  it('reports run-verification items that do not bind to verification execution', () => {
    const schematic = parseFixSchematic();
    const verify = schematic.items.find((item) => (item.id as unknown as string) === 'fix-verify');
    if (verify === undefined) throw new Error('fix-verify missing');
    verify.execution = { kind: 'compose' };

    const issues = validateFlowSchematicCatalogCompatibility(schematic, parseBlockCatalog());
    expect(issues).toContainEqual({
      item_id: 'fix-verify',
      message:
        'execution kind "compose" is not compatible with block "run-verification"; expected one of verification',
    });
  });

  it('reports unavailable input contracts in schematic order', () => {
    const schematic = parseFixSchematic();
    const diagnose = schematic.items.find(
      (item) => (item.id as unknown as string) === 'fix-diagnose',
    );
    if (diagnose === undefined) throw new Error('fix-diagnose missing');
    diagnose.input.context = 'missing.context@v1';
    const issues = validateFlowSchematicCatalogCompatibility(schematic, parseBlockCatalog());
    expect(issues).toContainEqual({
      item_id: 'fix-diagnose',
      message:
        'input "context" references unavailable contract "missing.context@v1" on at least one reachable route',
    });
    expect(issues).toContainEqual({
      item_id: 'fix-diagnose',
      message:
        'inputs do not satisfy block "diagnose"; expected one of [flow.brief@v1, context.packet@v1]',
    });
  });

  it('reports schematic items that omit every accepted block input set', () => {
    const schematic = parseFixSchematic();
    const act = schematic.items.find((item) => (item.id as unknown as string) === 'fix-act');
    if (act === undefined) throw new Error('fix-act missing');
    act.input = { brief: 'fix.brief@v1' };

    const issues = validateFlowSchematicCatalogCompatibility(schematic, parseBlockCatalog());
    expect(issues).toContainEqual({
      item_id: 'fix-act',
      message:
        'inputs do not satisfy block "act"; expected one of [flow.brief@v1, diagnosis.result@v1] or [flow.brief@v1, plan.strategy@v1] or [flow.brief@v1, plan.strategy@v1, diagnosis.result@v1]',
    });
  });

  it('reports inputs that are skipped by a reachable route', () => {
    const schematic = parseFixSchematic();
    const verify = schematic.items.find((item) => (item.id as unknown as string) === 'fix-verify');
    if (verify === undefined) throw new Error('fix-verify missing');
    verify.routes.continue = StepId.parse('fix-close');

    const issues = validateFlowSchematicCatalogCompatibility(schematic, parseBlockCatalog());
    expect(issues).toContainEqual({
      item_id: 'fix-close',
      message:
        'input "review" references unavailable contract "fix.review@v1" on at least one reachable route',
    });
  });

  it('treats an optional input as available when it arrives on at least one reachable route', () => {
    // Same route-disjoint setup as above: redirect fix-verify so fix-close is also
    // reached by a path that skips fix-review, leaving `review` present on one route
    // and absent on the other. A REQUIRED read of that input is an error (test
    // above); an OPTIONAL read is legitimate — the close builder already reads
    // review with required:false and tolerates its absence. M1 lifts that truth
    // into the schematic via optional_inputs and checks optional inputs by union
    // (available on at least one route) rather than intersection.
    const schematic = parseFixSchematic();
    const verify = schematic.items.find((item) => (item.id as unknown as string) === 'fix-verify');
    if (verify === undefined) throw new Error('fix-verify missing');
    verify.routes.continue = StepId.parse('fix-close');
    const close = schematic.items.find((item) => (item.id as unknown as string) === 'fix-close');
    if (close === undefined) throw new Error('fix-close missing');
    (close as { optional_inputs?: string[] }).optional_inputs = ['review'];

    const issues = validateFlowSchematicCatalogCompatibility(schematic, parseBlockCatalog());
    expect(
      issues.some(
        (issue) =>
          issue.item_id === 'fix-close' &&
          issue.message.includes('unavailable contract "fix.review@v1"'),
      ),
    ).toBe(false);
  });

  it('still flags an optional input whose contract no reachable route produces', () => {
    // Optional relaxes "must be on every route" to "must be on at least one
    // route" — it does NOT excuse a contract that nothing produces anywhere.
    const schematic = parseFixSchematic();
    const close = schematic.items.find((item) => (item.id as unknown as string) === 'fix-close');
    if (close === undefined) throw new Error('fix-close missing');
    close.input.review = 'never.produced@v1' as unknown as (typeof close.input)['review'];
    (close as { optional_inputs?: string[] }).optional_inputs = ['review'];

    const issues = validateFlowSchematicCatalogCompatibility(schematic, parseBlockCatalog());
    expect(
      issues.some(
        (issue) =>
          issue.item_id === 'fix-close' &&
          issue.message.includes('never.produced@v1') &&
          issue.message.includes('no reachable route produces'),
      ),
    ).toBe(true);
  });

  it('reports schematic items that cannot be reached from starts_at', () => {
    const schematic = parseFixSchematic();
    const frame = schematic.items.find((item) => (item.id as unknown as string) === 'fix-frame');
    if (frame === undefined) throw new Error('fix-frame missing');
    frame.routes = { stop: '@stop' };

    const issues = validateFlowSchematicCatalogCompatibility(schematic, parseBlockCatalog());
    expect(issues).toContainEqual({
      item_id: 'fix-gather-context',
      message: 'schematic item is unreachable from starts_at',
    });
  });

  it('reports outputs that are not block outputs or declared aliases', () => {
    const schematic = parseFixSchematic();
    const close = schematic.items.find((item) => (item.id as unknown as string) === 'fix-close');
    if (close === undefined) throw new Error('fix-close missing');
    close.output = 'wrong.result@v1';
    const issues = validateFlowSchematicCatalogCompatibility(schematic, parseBlockCatalog());
    expect(issues).toEqual([
      {
        item_id: 'fix-close',
        message: 'output "wrong.result@v1" is not compatible with block output "flow.result@v1"',
      },
    ]);
  });
});

// Compiler-required metadata. These fields are optional at parse time to
// avoid breaking candidate schematics mid-upgrade, but their cross-field
// shape (kind ↔ writes, kind ↔ check, checkpoint_policy ↔ checkpoint kind)
// is enforced when present so authors get clear feedback.
describe('flow schematic compiler-required metadata', () => {
  function frameItemWithExtras(extras: Record<string, unknown>): Record<string, unknown> {
    return {
      id: 'a-frame',
      block: 'frame',
      title: 'Frame',
      stage: 'frame',
      input: {},
      output: 'flow.brief@v1',
      evidence_requirements: ['scope boundary', 'constraints', 'proof plan'],
      execution: { kind: 'compose' },
      routes: { continue: '@complete' },
      ...extras,
    };
  }

  function actItemWithExtras(extras: Record<string, unknown>): Record<string, unknown> {
    return {
      id: 'a-act',
      block: 'act',
      title: 'Act',
      stage: 'act',
      input: { brief: 'flow.brief@v1', plan: 'plan.strategy@v1' },
      output: 'change.evidence@v1',
      evidence_requirements: ['changed files', 'change rationale', 'declared follow-up proof'],
      execution: { kind: 'relay', role: 'implementer' },
      routes: { continue: '@complete' },
      ...extras,
    };
  }

  function baseSchematic(items: Array<Record<string, unknown>>): Record<string, unknown> {
    return {
      schema_version: '2',
      id: 'demo',
      title: 'Demo',
      purpose: 'demo',
      status: 'candidate',
      starts_at: items[0]?.id,
      initial_contracts: [],
      contract_aliases: [],
      items,
    };
  }

  function activeSchematic(items: Array<Record<string, unknown>>): Record<string, unknown> {
    return {
      ...baseSchematic(items),
      status: 'active',
      version: '0.1.0',
      axes: {
        allowed_depths: ['medium'],
        supports_tournament: false,
        supports_autonomous: false,
      },
      stage_path_policy: {
        mode: 'partial',
        omits: ['analyze', 'plan', 'act', 'verify', 'review', 'close'],
        rationale: 'demo schematic with only a frame stage for testing',
      },
      stages: [{ canonical: 'frame', id: 'frame-stage', title: 'Frame' }],
    };
  }

  function tournamentFanoutItemWith(fanout: Record<string, unknown>): Record<string, unknown> {
    return {
      id: 'a-fanout',
      block: 'act',
      title: 'Fanout',
      stage: 'act',
      input: { brief: 'flow.brief@v1' },
      output: 'change.evidence@v1',
      evidence_requirements: ['changed files', 'change rationale', 'declared follow-up proof'],
      execution: { kind: 'fanout' },
      routes: { continue: '@complete' },
      protocol: 'demo-fanout@v1',
      writes: {
        report_path: 'reports/aggregate.json',
        branches_dir_path: 'reports/branches',
      },
      check: { pass: ['accept'] },
      fanout,
    };
  }

  function activeTournamentSchematic(fanout: Record<string, unknown>): Record<string, unknown> {
    const frame = frameItemWithExtras({
      protocol: 'demo-frame@v1',
      writes: { report_path: 'reports/brief.json' },
      check: { required: ['scope'] },
      routes: { continue: 'a-fanout' },
    });
    return {
      ...activeSchematic([frame, tournamentFanoutItemWith(fanout)]),
      axes: {
        allowed_depths: ['medium'],
        supports_tournament: true,
        supports_autonomous: false,
        tournament_fan_out_stage: 'act-stage',
      },
      stage_path_policy: {
        mode: 'partial',
        omits: ['analyze', 'plan', 'verify', 'review', 'close'],
        rationale: 'demo tournament schematic for fanout policy validation',
      },
      stages: [
        { canonical: 'frame', id: 'frame-stage', title: 'Frame' },
        { canonical: 'act', id: 'act-stage', title: 'Act' },
      ],
    };
  }

  function validTournamentFanout(): Record<string, unknown> {
    return {
      branches: {
        kind: 'dynamic',
        source_report: 'reports/options.json',
        items_path: 'options',
        template: {
          branch_id: '$item.id',
          execution: {
            kind: 'relay',
            role: 'researcher',
            goal: '$item.prompt',
            report_schema: 'runtime-proof-canonical@v1',
          },
        },
        max_branches: { kind: 'axis', axis: 'tournament_n' },
        required_count: { kind: 'axis', axis: 'tournament_n' },
      },
      concurrency: { kind: 'bounded', max: 2 },
      on_child_failure: 'continue-others',
      join: { policy: 'aggregate-survivors' },
    };
  }

  it('keeps candidate draft schematics parseable without compiler metadata', () => {
    const result = FlowSchematic.safeParse(baseSchematic([frameItemWithExtras({})]));
    expect(result.success).toBe(true);
  });

  it('rejects active schematics missing compile-required top-level metadata', () => {
    const schematic = {
      ...baseSchematic([
        frameItemWithExtras({
          protocol: 'demo-frame@v1',
          writes: { report_path: 'reports/brief.json' },
          check: { required: ['scope', 'constraints'] },
        }),
      ]),
      status: 'active',
    };
    const result = FlowSchematic.safeParse(schematic);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(/active schematic requires version/);
      expect(result.error.message).toMatch(/active schematic requires axes/);
      expect(result.error.message).toMatch(/active schematic requires stage_path_policy/);
      expect(result.error.message).toMatch(/active schematic requires stages/);
    }
  });

  it('rejects active schematic items missing compile-required execution metadata', () => {
    const result = FlowSchematic.safeParse(activeSchematic([frameItemWithExtras({})]));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(/active schematic item requires protocol/);
      expect(result.error.message).toMatch(/active schematic item requires writes/);
      expect(result.error.message).toMatch(/active schematic item requires check/);
    }
  });

  it('accepts a compose item with required check, schema-sections writes, and protocol', () => {
    const schematic = baseSchematic([
      frameItemWithExtras({
        protocol: 'demo-frame@v1',
        writes: { report_path: 'reports/brief.json' },
        check: { required: ['scope', 'constraints'] },
      }),
    ]);
    const result = FlowSchematic.safeParse(schematic);
    expect(result.success).toBe(true);
  });

  it('rejects compose item missing writes.report_path', () => {
    const schematic = baseSchematic([
      frameItemWithExtras({
        writes: {},
        check: { required: ['scope'] },
      }),
    ]);
    const result = FlowSchematic.safeParse(schematic);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(/compose execution requires writes\.report_path/);
    }
  });

  it('rejects compose item with check.allow (checkpoint-only field)', () => {
    const schematic = baseSchematic([
      frameItemWithExtras({
        writes: { report_path: 'reports/brief.json' },
        check: { required: ['scope'], allow: ['continue'] },
      }),
    ]);
    const result = FlowSchematic.safeParse(schematic);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(/check\.allow is only allowed for checkpoint execution/);
    }
  });

  it('accepts a relay item with full path slots and check.pass', () => {
    const schematic = baseSchematic([
      actItemWithExtras({
        protocol: 'demo-act@v1',
        writes: {
          report_path: 'reports/change.json',
          request_path: 'reports/relay/act.request.json',
          receipt_path: 'reports/relay/act.receipt.txt',
          result_path: 'reports/relay/act.result.json',
        },
        check: { pass: ['accept'] },
      }),
    ]);
    const result = FlowSchematic.safeParse(schematic);
    expect(result.success).toBe(true);
  });

  it('accepts relay skill slots with kebab-case ids', () => {
    const schematic = baseSchematic([
      actItemWithExtras({
        protocol: 'demo-act@v1',
        skill_slots: [
          {
            id: 'review-assistant',
            description: 'Optional local skill for reviewing this step.',
          },
        ],
        writes: {
          report_path: 'reports/change.json',
          request_path: 'reports/relay/act.request.json',
          receipt_path: 'reports/relay/act.receipt.txt',
          result_path: 'reports/relay/act.result.json',
        },
        check: { pass: ['accept'] },
      }),
    ]);
    const result = FlowSchematic.safeParse(schematic);
    expect(result.success).toBe(true);
  });

  it('rejects relay skill slots with underscore ids', () => {
    const schematic = baseSchematic([
      actItemWithExtras({
        protocol: 'demo-act@v1',
        skill_slots: [
          {
            id: 'review_assistant',
            description: 'Optional local skill for reviewing this step.',
          },
        ],
        writes: {
          report_path: 'reports/change.json',
          request_path: 'reports/relay/act.request.json',
          receipt_path: 'reports/relay/act.receipt.txt',
          result_path: 'reports/relay/act.result.json',
        },
        check: { pass: ['accept'] },
      }),
    ]);
    const result = FlowSchematic.safeParse(schematic);
    expect(result.success).toBe(false);
  });

  it('rejects relay item missing receipt_path', () => {
    const schematic = baseSchematic([
      actItemWithExtras({
        writes: {
          request_path: 'reports/relay/act.request.json',
          result_path: 'reports/relay/act.result.json',
        },
        check: { pass: ['accept'] },
      }),
    ]);
    const result = FlowSchematic.safeParse(schematic);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(/relay execution requires writes\.receipt_path/);
    }
  });

  it('rejects relay item with check.required (compose-only field)', () => {
    const schematic = baseSchematic([
      actItemWithExtras({
        writes: {
          request_path: 'reports/relay/act.request.json',
          receipt_path: 'reports/relay/act.receipt.txt',
          result_path: 'reports/relay/act.result.json',
        },
        check: { pass: ['accept'], required: ['summary'] },
      }),
    ]);
    const result = FlowSchematic.safeParse(schematic);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(
        /check\.required is only allowed for compose\|verification execution/,
      );
    }
  });

  it('rejects checkpoint_policy on non-checkpoint execution', () => {
    const schematic = baseSchematic([
      frameItemWithExtras({
        writes: { report_path: 'reports/brief.json' },
        check: { required: ['scope'] },
        checkpoint_policy: {
          prompt: 'go?',
          choices: [{ id: 'continue' }],
        },
      }),
    ]);
    const result = FlowSchematic.safeParse(schematic);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(
        /checkpoint_policy is only allowed for checkpoint execution/,
      );
    }
  });

  it('accepts schematic-level entry, axes, stage_path_policy, stages', () => {
    const schematic = {
      ...baseSchematic([
        frameItemWithExtras({
          writes: { report_path: 'reports/brief.json' },
          check: { required: ['scope'] },
        }),
      ]),
      version: '0.1.0',
      axes: {
        allowed_depths: ['medium'],
        supports_tournament: false,
        supports_autonomous: false,
      },
      stage_path_policy: {
        mode: 'partial',
        omits: ['analyze', 'plan', 'act', 'verify', 'review', 'close'],
        rationale: 'demo schematic with only a frame stage for testing',
      },
      stages: [{ canonical: 'frame', id: 'frame-stage', title: 'Frame' }],
    };
    const result = FlowSchematic.safeParse(schematic);
    expect(result.success).toBe(true);
  });

  it('rejects a tournament fan-out stage that is not declared by the schematic', () => {
    const schematic = {
      ...activeSchematic([
        frameItemWithExtras({
          writes: { report_path: 'reports/brief.json' },
          check: { required: ['scope'] },
        }),
      ]),
      axes: {
        allowed_depths: ['medium'],
        supports_tournament: true,
        supports_autonomous: false,
        tournament_fan_out_stage: 'missing-stage',
      },
    };
    const result = FlowSchematic.safeParse(schematic);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(
        /tournament_fan_out_stage references unknown stage id: missing-stage/,
      );
    }
  });

  it('rejects tournament fanout metadata without continue-others plus aggregate-survivors', () => {
    for (const invalid of ['abort-all', 'aggregate-only'] as const) {
      const fanout = validTournamentFanout();
      if (invalid === 'abort-all') {
        fanout.on_child_failure = 'abort-all';
      } else {
        fanout.join = { policy: 'aggregate-only' };
      }

      const result = FlowSchematic.safeParse(activeTournamentSchematic(fanout));

      expect(result.success, invalid).toBe(false);
      if (!result.success) {
        expect(result.error.message, invalid).toMatch(
          /tournament fanout requires on_child_failure: continue-others and join.policy: aggregate-survivors/,
        );
      }
    }
  });

  it('rejects legacy entry_modes', () => {
    const schematic = {
      ...baseSchematic([
        frameItemWithExtras({
          writes: { report_path: 'reports/brief.json' },
          check: { required: ['scope'] },
        }),
      ]),
      entry_modes: [{ name: 'default', depth: 'medium', description: 'a' }],
    };
    const result = FlowSchematic.safeParse(schematic);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          code: 'unrecognized_keys',
          keys: ['entry_modes'],
          path: [],
        }),
      );
    }
  });

  it('rejects stages entry mismatch with item stage usage', () => {
    const schematic = {
      ...baseSchematic([
        frameItemWithExtras({
          writes: { report_path: 'reports/brief.json' },
          check: { required: ['scope'] },
        }),
      ]),
      stages: [{ canonical: 'analyze', id: 'analyze-stage', title: 'Analyze' }],
    };
    const result = FlowSchematic.safeParse(schematic);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(
        /stages is missing an entry for canonical stage 'frame'/,
      );
    }
  });

  it('rejects stage_path_policy.omits that includes a used canonical stage', () => {
    const schematic = {
      ...baseSchematic([
        frameItemWithExtras({
          writes: { report_path: 'reports/brief.json' },
          check: { required: ['scope'] },
        }),
      ]),
      stage_path_policy: {
        mode: 'partial',
        omits: ['frame'],
        rationale: 'invalid omit because frame is used by an item',
      },
    };
    const result = FlowSchematic.safeParse(schematic);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toMatch(
        /canonical stage 'frame' is omitted but used by at least one item/,
      );
    }
  });
});
