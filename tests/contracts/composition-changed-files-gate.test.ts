// Flow-shape composition (experimental, default-OFF): the GATE-REACH bridge.
//
// The `changed_on_disk` honesty gate (and its sibling present/non_empty checks)
// was hand-authored onto the BUILT-IN fix/build `act` steps only. A genuinely
// composed flow emits its `act` relay step with NO acceptance_criteria, so the
// honesty guarantee never reached the north-star generate path: a generated flow
// was fitted-but-unguarded while a built-in was guarded-but-not-fitted.
//
// This locks the bridge. When the composer binds an implementer `act` relay to a
// changed-files-bearing contract (fix.change@v1 or build.implementation@v1) it
// must attach the SAME three-check criterion the hand-authored steps carry —
// present + changed_on_disk + evidence-non-empty, retry-with-feedback on failure.
// The runtime relay executor already fires evaluateAcceptanceCriteria for ANY
// relay step carrying the field (relay.ts: `if (step.acceptanceCriteria !== ...)`,
// no family branch), so emitting the criterion is the whole fix — no engine or
// run-path change. These tests pin the structure (it reaches the compiled
// circuit.json shape), its narrowness (researcher relays are untouched), and the
// behavior (the composed criterion actually catches an overclaiming worker).

import { describe, expect, it } from 'vitest';
import { flowDefinitions } from '../../src/flows/catalog.js';
import { compileSchematicToCompiledFlow } from '../../src/flows/compile-schematic-to-flow.js';
import {
  type CompositionRoleSet,
  RESEARCH_THEN_BUILD,
  composeFlow,
  evaluateValidity,
} from '../../src/flows/composition/index.js';
import { evaluateAcceptanceCriteria } from '../../src/runtime/acceptance-criteria.js';
import type { AcceptanceCriteria } from '../../src/schemas/acceptance-criteria.js';

// A full fix arc as a genuine block-level composition: frame -> gather -> diagnose
// -> act(implementer) -> verify -> close. The act step binds fix.change@v1. Mirrors
// FIX_FULL_ARC in composition-verification-reads.test.ts, declared inline so this
// test owns its fixture.
const FIX_FULL_ARC: CompositionRoleSet = {
  id: 'fix-full-arc-gate',
  title: 'Genuine fix arc (block-level)',
  purpose:
    'Frame the defect, gather context, diagnose the cause, make the change, verify it, and close with evidence — assembled block by block.',
  roles: [
    { stage: 'frame', block: 'frame', executionKind: 'compose' },
    { stage: 'analyze', block: 'gather-context', executionKind: 'relay', relayRole: 'researcher' },
    { stage: 'analyze', block: 'diagnose', executionKind: 'relay', relayRole: 'researcher' },
    { stage: 'act', block: 'act', executionKind: 'relay', relayRole: 'implementer' },
    { stage: 'verify', block: 'run-verification', executionKind: 'verification' },
    { stage: 'close', block: 'close-with-evidence', executionKind: 'compose', terminal: true },
  ],
};

// writes shape varies across the compiled step union (a fanout writes an
// aggregate, not a report). Take the step broadly and narrow to the object form
// that carries a report schema.
function reportSchemaOf(step: { writes: unknown }): string | undefined {
  const report = (step.writes as { report?: unknown }).report;
  if (typeof report !== 'object' || report === null) return undefined;
  return (report as { schema?: string }).schema;
}

function acceptanceOf(step: unknown): AcceptanceCriteria | undefined {
  return (step as { acceptance_criteria?: AcceptanceCriteria }).acceptance_criteria;
}

// Compose -> validate -> compile, returning both the spec and the single compiled
// flow so a test can inspect the act step at either altitude.
function composeAndCompile(roleSet: CompositionRoleSet) {
  const outcome = composeFlow(roleSet, { definitions: flowDefinitions });
  if (!outcome.ok) {
    throw new Error(
      `compose failed: ${outcome.walls.map((w) => `${w.block}: ${w.reason}`).join(' | ')}`,
    );
  }
  const validity = evaluateValidity(outcome.spec);
  if (validity.schematic === undefined) {
    throw new Error(
      `not valid: error=${validity.error ?? 'none'} issues=${validity.catalogIssues.join(' ; ')}`,
    );
  }
  const compiled = compileSchematicToCompiledFlow(validity.schematic);
  const flow = compiled.kind === 'single' ? compiled.flow : [...compiled.flows.values()][0];
  if (flow === undefined) throw new Error('no compiled flow');
  return { spec: outcome.spec, flow };
}

// The criterion the hand-authored fix/build act steps carry, restated here as the
// fixed target this bridge must reproduce. Read against the composed criterion so
// a drift in either is caught.
const EXPECTED_CHECK_IDS = ['changed-files-present', 'changed-files-on-disk', 'evidence-non-empty'];

describe('flow-shape composition — changed-files honesty gate reaches composed act', () => {
  it('attaches the three-check criterion to a composed fix implementer act (spec level)', () => {
    const { spec } = composeAndCompile(FIX_FULL_ARC);
    const act = spec.items.find((it) => String(it.block) === 'act');
    if (act === undefined) throw new Error('no act step in composed spec');

    const criteria = act.acceptanceCriteria;
    expect(criteria).toBeDefined();
    if (criteria === undefined) return;
    expect(criteria.checks.map((c) => c.id)).toEqual(EXPECTED_CHECK_IDS);

    const onDisk = criteria.checks.find((c) => c.id === 'changed-files-on-disk');
    expect(onDisk).toBeDefined();
    expect(onDisk).toMatchObject({
      kind: 'report_field',
      path: ['changed_files'],
      predicate: 'changed_on_disk',
    });
    // A failing gate must loop the worker back with feedback, not hard-abort the
    // run — same policy the built-in fix act carries.
    expect(criteria.on_failure).toEqual({ mode: 'retry-with-feedback' });
  });

  it('the criterion reaches the compiled relay step beside writes.report.schema=fix.change@v1', () => {
    const { spec, flow } = composeAndCompile(FIX_FULL_ARC);
    const specAct = spec.items.find((it) => String(it.block) === 'act');
    if (specAct === undefined) throw new Error('no act step');
    const compiledAct = flow.steps.find((s) => s.id === String(specAct.id));
    if (compiledAct === undefined) throw new Error('no compiled act step');

    // Precondition: this composed act really does bind the changed-files-bearing
    // fix contract — the gate is meaningless if the worker is not asked to report.
    expect(reportSchemaOf(compiledAct)).toBe('fix.change@v1');

    const criteria = acceptanceOf(compiledAct);
    expect(criteria).toBeDefined();
    expect(criteria?.checks.map((c) => c.id)).toEqual(EXPECTED_CHECK_IDS);
  });

  it('also attaches to a composed build implementer act (build.implementation@v1)', () => {
    const { spec, flow } = composeAndCompile(RESEARCH_THEN_BUILD);
    const specAct = spec.items.find((it) => String(it.block) === 'act');
    if (specAct === undefined) throw new Error('no act step');
    const compiledAct = flow.steps.find((s) => s.id === String(specAct.id));
    if (compiledAct === undefined) throw new Error('no compiled act step');

    expect(reportSchemaOf(compiledAct)).toBe('build.implementation@v1');
    expect(acceptanceOf(compiledAct)?.checks.map((c) => c.id)).toEqual(EXPECTED_CHECK_IDS);
  });

  it('does NOT attach to non-implementer relay steps (researcher gather/diagnose)', () => {
    // Default-safety / blast-radius guard: the gate is for the edit step only.
    // A researcher relay self-reports findings, not changed files, and binding a
    // changed_on_disk check to it would fail every honest run.
    const { spec } = composeAndCompile(FIX_FULL_ARC);
    const researcherSteps = spec.items.filter(
      (it) => String(it.block) === 'gather-context' || String(it.block) === 'diagnose',
    );
    expect(researcherSteps.length).toBeGreaterThan(0);
    for (const step of researcherSteps) {
      expect(step.acceptanceCriteria).toBeUndefined();
    }
  });

  it('the composed criterion FIRES: it catches a worker that overclaims an untouched path', async () => {
    const { spec, flow } = composeAndCompile(FIX_FULL_ARC);
    const specAct = spec.items.find((it) => String(it.block) === 'act');
    const compiledAct = flow.steps.find((s) => s.id === String(specAct?.id));
    const criteria = acceptanceOf(compiledAct);
    if (criteria === undefined) throw new Error('composed act carries no criterion to fire');

    const result = await evaluateAcceptanceCriteria({
      stepId: 'act',
      criteria,
      resultBody: JSON.stringify({
        changed_files: ['src/touched.ts', 'src/phantom.ts'],
        evidence: ['ran the suite'],
      }),
      projectRoot: '/repo',
      // Only src/touched.ts is actually dirty; src/phantom.ts is an overclaim.
      captureChangedPaths: () => new Set(['src/touched.ts']),
    });

    expect(result.kind).toBe('fail');
    if (result.kind === 'fail') {
      expect(result.reason).toContain('src/phantom.ts');
      expect(result.feedback.criterion_id).toBe('changed-files-on-disk');
    }
  });

  it('the composed criterion PASSES a truthful changed_files claim', async () => {
    const { spec, flow } = composeAndCompile(FIX_FULL_ARC);
    const specAct = spec.items.find((it) => String(it.block) === 'act');
    const compiledAct = flow.steps.find((s) => s.id === String(specAct?.id));
    const criteria = acceptanceOf(compiledAct);
    if (criteria === undefined) throw new Error('composed act carries no criterion');

    const result = await evaluateAcceptanceCriteria({
      stepId: 'act',
      criteria,
      resultBody: JSON.stringify({
        changed_files: ['src/touched.ts'],
        evidence: ['ran the suite'],
      }),
      projectRoot: '/repo',
      captureChangedPaths: () => new Set(['src/touched.ts']),
    });

    expect(result.kind).toBe('pass');
  });
});
