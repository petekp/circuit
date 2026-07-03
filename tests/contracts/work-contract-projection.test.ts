import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { flowDefinitions, flowPackages } from '../../src/flows/catalog.js';
import { compileSchematicToCompiledFlow } from '../../src/flows/compile-schematic-to-flow.js';
import { schematicForFlowDefinition } from '../../src/flows/flow-definition.js';
import {
  CompiledFlow,
  RecoveryFailureCause,
  RecoveryRouteBindingV0,
  RecoveryRouteKind,
} from '../../src/index.js';
import type { CompiledFlow as CompiledFlowValue } from '../../src/index.js';
import {
  WorkContractProjectionV0,
  projectWorkContractProjectionV0,
  workContractProjectionPathForCompiledFlowPath,
} from '../../src/shared/work-contract-projection.js';

const REPO_ROOT = resolve('.');

function compiledBuiltInFlows(): readonly CompiledFlowValue[] {
  const flows: CompiledFlowValue[] = [];
  for (const definition of flowDefinitions) {
    const compiled = compileSchematicToCompiledFlow(schematicForFlowDefinition(definition));
    if (compiled.kind === 'single') {
      flows.push(compiled.flow);
      continue;
    }
    flows.push(...compiled.flows.values());
  }
  return flows;
}

function buildProjection(flow: CompiledFlowValue) {
  return projectWorkContractProjectionV0({ flow });
}

function collectGeneratedCompiledFlowFiles(): string[] {
  const rels: string[] = [];
  for (const pkg of flowPackages) {
    const dir = resolve(REPO_ROOT, 'generated/flows', pkg.id);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith('.json')) continue;
      if (name.endsWith('.work-contract.v0.json')) continue;
      rels.push(`generated/flows/${pkg.id}/${name}`);
    }
  }
  return rels;
}

function walkKeys(value: unknown, visit: (key: string) => void): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) walkKeys(item, visit);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    visit(key);
    walkKeys(child, visit);
  }
}

describe('WorkContractProjectionV0', () => {
  it('projects every built-in compiled flow into the three authority buckets', () => {
    for (const flow of compiledBuiltInFlows()) {
      const projection = buildProjection(flow);
      expect(WorkContractProjectionV0.safeParse(projection).success, flow.id).toBe(true);
      expect(projection.work_contract.flow.id).toBe(flow.id);
      expect(projection.work_contract.topology.stages).toHaveLength(flow.stages.length);
      expect(projection.work_contract.blocks).toHaveLength(flow.steps.length);
      // Every shipped flow produces at least one typed report. converge-proof —
      // once the all-bare exception — now types exactly one: its stop-judge is
      // bound to the strict converge.judgment@v1 report, so the goal_met the
      // evidence floor disposes is schema-checked, never free-riding on an
      // unvalidated result (the F13 finding from the live surface test). The
      // plan/act body relays stay bare; the loop behavior itself is asserted in
      // tests/runner/converge-proof-until-loop.test.ts.
      expect(projection.work_contract.proof.reports.length).toBeGreaterThan(0);
      expect(projection.guidance_seed.selection_hints).toBeDefined();
      expect(projection.rejected_authority).toBeDefined();
    }
  });

  it('keeps old execution-choice fields out of work_contract authority', () => {
    for (const flow of compiledBuiltInFlows()) {
      const projection = buildProjection(flow);
      const forbidden = new Set([
        'selection',
        'default_selection',
        'connector',
        'safe_autonomous_choice',
        'auto_resolution',
      ]);
      const offenders: string[] = [];
      walkKeys(projection.work_contract, (key) => {
        if (forbidden.has(key)) offenders.push(key);
      });
      expect(offenders, flow.id).toEqual([]);
    }
  });

  it('classifies relay connectors, selections, and concrete skill choices as guidance seed', () => {
    const [flow] = compiledBuiltInFlows();
    if (flow === undefined) throw new Error('expected at least one compiled flow');
    const mutated = {
      ...flow,
      default_selection: {
        effort: 'high',
        skills: { mode: 'replace', skills: ['adversarial-review'] },
        invocation_options: {},
      },
      stages: flow.stages.map((stage, index) =>
        index === 0
          ? {
              ...stage,
              selection: { effort: 'medium', skills: { mode: 'inherit' }, invocation_options: {} },
            }
          : stage,
      ),
      steps: flow.steps.map((step, index) =>
        index === 0
          ? {
              ...step,
              selection: { effort: 'low', skills: { mode: 'inherit' }, invocation_options: {} },
              ...(step.kind === 'relay' ? { connector: 'codex' } : {}),
            }
          : step,
      ),
    } as unknown as CompiledFlowValue;

    const projection = buildProjection(mutated);

    expect(projection.guidance_seed.selection_hints.map((ref) => ref.ref)).toEqual(
      expect.arrayContaining([
        'compiled-flow/default_selection',
        `compiled-flow/stages/${mutated.stages[0]?.id}/selection`,
        `compiled-flow/steps/${mutated.steps[0]?.id}/selection`,
      ]),
    );
    expect(JSON.stringify(projection.work_contract)).not.toContain('adversarial-review');
  });

  it('classifies skill slots as contract capability slots', () => {
    const [flow] = compiledBuiltInFlows();
    if (flow === undefined) throw new Error('expected at least one compiled flow');
    const firstStep = flow.steps[0];
    if (firstStep === undefined) throw new Error('expected at least one step');
    const mutated = {
      ...flow,
      steps: [
        {
          ...firstStep,
          skill_slots: [
            {
              id: 'review-assistant',
              description: 'Optional local skill for reviewing relay output.',
            },
          ],
        },
        ...flow.steps.slice(1),
      ],
    } as unknown as CompiledFlowValue;

    const projection = buildProjection(mutated);

    // The shipped flows now declare house-style skill slots on their work relays,
    // so the projection carries those too; assert the mutated slot is classified
    // into the capability bucket rather than asserting it is the only one.
    expect(projection.work_contract.authority.skill_slots).toEqual(
      expect.arrayContaining([
        {
          step_id: firstStep.id,
          slot_id: 'review-assistant',
          description: 'Optional local skill for reviewing relay output.',
        },
      ]),
    );
  });

  it('rejects hidden checkpoint autonomy before projection', () => {
    const flow = compiledBuiltInFlows().find((candidate) =>
      candidate.steps.some((step) => step.kind === 'checkpoint'),
    );
    if (flow === undefined) throw new Error('expected at least one checkpoint flow');
    const checkpointIndex = flow.steps.findIndex((step) => step.kind === 'checkpoint');
    const checkpoint = flow.steps[checkpointIndex];
    if (checkpoint === undefined) throw new Error('expected checkpoint step');

    const mutated = {
      ...flow,
      steps: flow.steps.map((step, index) =>
        index === checkpointIndex
          ? {
              ...checkpoint,
              policy: {
                ...(checkpoint as { readonly policy: Record<string, unknown> }).policy,
                safe_autonomous_choice: 'continue',
              },
            }
          : step,
      ),
    } as unknown as CompiledFlowValue;

    expect(CompiledFlow.safeParse(mutated).success).toBe(false);
  });

  it('requires checkpoint choices to name static ids or a dynamic source', () => {
    const projection = compiledBuiltInFlows()
      .map(buildProjection)
      .find((candidate) => {
        return candidate.work_contract.authority.checkpoints.length > 0;
      });
    if (projection === undefined) throw new Error('expected at least one checkpoint');

    const checkpoint = projection.work_contract.authority.checkpoints[0];
    if (checkpoint === undefined) throw new Error('expected at least one checkpoint');

    expect(
      WorkContractProjectionV0.safeParse({
        ...projection,
        work_contract: {
          ...projection.work_contract,
          authority: {
            ...projection.work_contract.authority,
            checkpoints: [{ ...checkpoint, choices: { kind: 'static' } }],
          },
        },
      }).success,
    ).toBe(false);

    expect(
      WorkContractProjectionV0.safeParse({
        ...projection,
        work_contract: {
          ...projection.work_contract,
          authority: {
            ...projection.work_contract.authority,
            checkpoints: [{ ...checkpoint, choices: { kind: 'dynamic' } }],
          },
        },
      }).success,
    ).toBe(false);
  });

  it('projects acceptance criteria as proof inputs, not close authority', () => {
    const projections = compiledBuiltInFlows().map(buildProjection);
    const acceptanceInputs = projections.flatMap(
      (projection) => projection.work_contract.proof.acceptance_criteria,
    );

    expect(acceptanceInputs.length).toBeGreaterThan(0);
    expect(acceptanceInputs.every((input) => input.kind === 'acceptance_criteria_input')).toBe(
      true,
    );
  });

  it('binds non-normal routes to typed recovery meaning', () => {
    for (const flow of compiledBuiltInFlows()) {
      const projection = buildProjection(flow);
      for (const route of projection.work_contract.recovery) {
        expect(route.schema_version).toBe(0);
        expect(route.route_id).toBeTruthy();
        expect(route.kind).toBeTruthy();
        expect(route.allowed_failure_causes.length).toBeGreaterThan(0);
        expect(route.required_refs.length).toBeGreaterThan(0);
        expect(route.operator_authority).toBeTruthy();
        expect(route.guidance).toEqual({
          subject: 'recovery_route',
          must_match_step_completed: true,
        });
      }
    }
  });

  it('keeps built-in recovery kind reachability intentional', () => {
    const intentionallyUnreachableRecoveryKinds = new Set<RecoveryRouteKind>([
      'run_verification',
      'safe_apply_reject',
    ]);
    const projectedKinds = new Set(
      compiledBuiltInFlows()
        .flatMap((flow) => buildProjection(flow).work_contract.recovery)
        .map((route) => route.kind),
    );
    const expectedReachable = RecoveryRouteKind.options
      .filter((kind) => !intentionallyUnreachableRecoveryKinds.has(kind))
      .sort();

    expect([...projectedKinds].sort()).toEqual(expectedReachable);
    for (const kind of intentionallyUnreachableRecoveryKinds) {
      expect(projectedKinds.has(kind), `${kind} is allow-listed but now projected`).toBe(false);
    }
  });

  it('does not treat normal review routes as recovery routes', () => {
    const goal = compiledBuiltInFlows().find((flow) => flow.id === 'goal');
    if (goal === undefined) throw new Error('Goal flow must be compiled');

    const projection = buildProjection(goal);

    expect(projection.work_contract.topology.routes).toContainEqual({
      step_id: 'goal-contract',
      route_id: 'review',
      target: 'goal-run-review',
    });
    expect(
      projection.work_contract.recovery.some(
        (route) => route.step_id === 'goal-contract' && route.route_id === 'review',
      ),
    ).toBe(false);
  });

  it('does not treat route ids as recovery kinds', () => {
    expect(RecoveryRouteKind.safeParse('retry').success).toBe(false);
    expect(RecoveryRouteKind.safeParse('revise').success).toBe(false);
    expect(RecoveryRouteKind.safeParse('connector-failed').success).toBe(false);
    expect(RecoveryRouteKind.safeParse('retry_same_step_with_feedback').success).toBe(true);
  });

  it('treats base mismatch as a typed SafeApply failure cause', () => {
    expect(RecoveryFailureCause.safeParse('base_mismatch').success).toBe(true);
    expect(RecoveryFailureCause.safeParse('apply_conflict').success).toBe(true);
  });

  it('requires same-step retry bindings to target the same step with feedback and budget refs', () => {
    const sameStepRetry = compiledBuiltInFlows()
      .flatMap((flow) => buildProjection(flow).work_contract.recovery)
      .find((route) => route.kind === 'retry_same_step_with_feedback');
    if (sameStepRetry === undefined) throw new Error('expected a same-step retry route');

    expect(sameStepRetry.route_target).toBe(sameStepRetry.step_id);
    expect(sameStepRetry.required_refs).toContain('acceptance_feedback');
    expect(sameStepRetry.attempt_budget).toMatchObject({
      consumes_step_attempt: true,
      must_respect_max_attempts: true,
      retry_target: 'same_step',
    });

    expect(
      RecoveryRouteBindingV0.safeParse({
        ...sameStepRetry,
        route_target: 'different-step',
      }).success,
    ).toBe(false);

    expect(
      RecoveryRouteBindingV0.safeParse({
        ...sameStepRetry,
        source_ref: {
          kind: 'policy',
          ref: 'policy.runtime.config_v1',
        },
      }).success,
    ).toBe(false);
  });

  it('does not project broad retry routes as same-step retry bindings', () => {
    const broadRetry = compiledBuiltInFlows()
      .flatMap((flow) => buildProjection(flow).work_contract.recovery)
      .find((route) => route.route_id === 'retry' && route.route_target !== route.step_id);
    if (broadRetry === undefined) throw new Error('expected a broad retry route');

    expect(broadRetry.kind).not.toBe('retry_same_step_with_feedback');
    expect(broadRetry.kind).toBe('narrow_scope');
  });

  it('rejects recovery bindings that are duplicated or not backed by declared routes', () => {
    const projection = compiledBuiltInFlows()
      .map(buildProjection)
      .find((candidate) => candidate.work_contract.recovery.length > 0);
    if (projection === undefined) throw new Error('expected recovery bindings');
    const [binding] = projection.work_contract.recovery;
    if (binding === undefined) throw new Error('expected first recovery binding');

    expect(
      WorkContractProjectionV0.safeParse({
        ...projection,
        work_contract: {
          ...projection.work_contract,
          recovery: [...projection.work_contract.recovery, binding],
        },
      }).success,
    ).toBe(false);

    expect(
      WorkContractProjectionV0.safeParse({
        ...projection,
        work_contract: {
          ...projection.work_contract,
          recovery: [
            {
              ...binding,
              route_id: 'undeclared-recovery-route',
            },
            ...projection.work_contract.recovery.slice(1),
          ],
        },
      }).success,
    ).toBe(false);
  });

  it('fails when a compiled flow field has no projection bucket', () => {
    const [flow] = compiledBuiltInFlows();
    if (flow === undefined) throw new Error('expected at least one compiled flow');
    const firstStep = flow.steps[0];
    if (firstStep === undefined) throw new Error('expected at least one step');
    const mutated = {
      ...flow,
      steps: [{ ...firstStep, mystery_authority: true }, ...flow.steps.slice(1)],
    } as unknown as CompiledFlowValue;

    expect(() => buildProjection(mutated)).toThrow(/unclassified step fields/);
  });

  it('emits a drift-checked WorkContract projection beside every generated compiled flow', () => {
    const generated = collectGeneratedCompiledFlowFiles();
    expect(generated.length).toBeGreaterThan(0);

    for (const compiledRel of generated) {
      const compiledFlow = CompiledFlow.parse(
        JSON.parse(readFileSync(resolve(REPO_ROOT, compiledRel), 'utf8')),
      );
      const contractRel = workContractProjectionPathForCompiledFlowPath(compiledRel);
      const contractAbs = resolve(REPO_ROOT, contractRel);
      expect(existsSync(contractAbs), `${contractRel} should exist`).toBe(true);

      const diskProjection = WorkContractProjectionV0.parse(
        JSON.parse(readFileSync(contractAbs, 'utf8')),
      );
      expect(diskProjection).toEqual(
        projectWorkContractProjectionV0({ flow: compiledFlow, contractRefPath: contractRel }),
      );
      expect(diskProjection.contract_ref.ref).toBe(contractRel);
      expect(diskProjection.work_contract.flow.id).toBe(compiledFlow.id);
    }
  });
});
