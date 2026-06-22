// SPIKE — does a MID-FLOW content checkpoint unlock "research, then build"?
//
// THROWAWAY SPIKE — captured in experiments/, NEVER promoted to src/. No model
// calls, no network. Uses only real src composition surfaces + LOCKED role sets,
// so there is no trial-and-error and the result cannot silently drift.
//
// WHY THIS EXISTS. Phase 2 (thin-then-thicken-demo) reported that the north-star
// "research, then build" thicken is blocked because you "cannot weld a build tail
// onto a compose-framed research head": RESEARCH_THEN_BUILD frames with a plain
// compose (which produces fix.brief@v1), the build-plan writer needs build.brief@v1,
// and only a CHECKPOINT writer produces build.brief@v1 — so `plan` aborts.
//
// That finding is true for RESEARCH_THEN_BUILD as written, but it overstated the
// blocker. BUILD_LINEAR_FULL already composes a runnable build arc by opening on a
// CONTENT CHECKPOINT frame that produces build.brief@v1. So build.brief@v1 IS
// producible from a composed role — via a checkpoint, not a compose. The composer's
// checkpointWritesReport path (composer.ts:447-463, 756-759) gives a non-terminal
// content checkpoint a readable report_path + report_template, and step ids dedupe
// (composer.ts:1056-1065), so the `frame` block can appear TWICE in one role set.
//
// THE SHARP QUESTION this probe answers, offline and for free: can a content
// checkpoint that mints build.brief@v1 be placed MID-FLOW — AFTER a research head —
// so that a build tail's `plan` reads it and the FULL floor (structure + catalog +
// RUNNABILITY) accepts the whole shape? If yes, the north-star "generate thin
// (research), then thicken into a real build tail" is reachable today as a single
// composed topology, and the precise mechanism is a mid-flow re-frame checkpoint —
// not an unsolved composer-coverage gap.
//
// METHOD. No model. Four locked role sets through the real floor:
//   1. RESEARCH_THEN_BUILD   (imported)  — the failing baseline: compose frame,
//      build tail. Expected: valid, NOT runnable (plan aborts on build.brief@v1).
//   2. BUILD_LINEAR_FULL     (imported)  — the known-good control: checkpoint frame
//      at position 0. Expected: valid AND runnable.
//   3. RESEARCH_REFRAME_BUILD (new here) — the HYPOTHESIS: a research head (compose
//      frame + gather + diagnose) THEN a mid-flow content-checkpoint re-frame that
//      mints build.brief@v1, THEN the build tail (plan + act + verify + close).
//      If valid AND runnable, the north-star thicken topology is reachable.
//   4. RESEARCH_REFRAME_BUILD_NO_CHECKPOINT (new here) — falsification control: the
//      same shape but the re-frame is a COMPOSE, not a checkpoint. Expected: NOT
//      runnable, proving the checkpoint (not merely the extra frame step) is what
//      unlocks it.
//
// Run: npx tsx experiments/flow-lab/build-brief-reframe-spike.ts
// Writes: experiments/flow-lab/_build-brief-reframe-results.json

import { writeFileSync } from 'node:fs';
import { flowDefinitions } from '../../src/flows/catalog.js';
import {
  BUILD_LINEAR_FULL,
  type CompositionRoleSet,
  RESEARCH_THEN_BUILD,
  composeFlow,
  evaluateRunnability,
  evaluateValidity,
} from '../../src/flows/composition/index.js';

// THE HYPOTHESIS SHAPE — research first, then re-frame into a build brief, then
// build. The frame block appears twice: once as the compose research framing
// (produces fix.brief@v1), once mid-flow as a content checkpoint (produces
// build.brief@v1, the brief the operator blesses once research has found what the
// work is). The build tail's `plan` reads build.brief@v1 — now produced upstream by
// the re-frame checkpoint, the exact wiring BUILD_LINEAR_FULL proves runnable.
const RESEARCH_REFRAME_BUILD: CompositionRoleSet = {
  id: 'research-reframe-build',
  title: 'Research the context, re-frame into a build brief, then build',
  purpose:
    'Investigate the task first, then checkpoint-frame what was learned into a build brief the operator blesses, form a plan from it, implement, verify, and close with evidence. The thin research head thickens into a real build tail through a mid-flow content-checkpoint re-frame.',
  roles: [
    { stage: 'frame', block: 'frame', executionKind: 'compose' },
    { stage: 'analyze', block: 'gather-context', executionKind: 'relay', relayRole: 'researcher' },
    { stage: 'analyze', block: 'diagnose', executionKind: 'relay', relayRole: 'researcher' },
    // The mid-flow re-frame: a content checkpoint that mints build.brief@v1.
    { stage: 'frame', block: 'frame', executionKind: 'checkpoint' },
    { stage: 'plan', block: 'plan', executionKind: 'compose' },
    { stage: 'act', block: 'act', executionKind: 'relay', relayRole: 'implementer' },
    { stage: 'verify', block: 'run-verification', executionKind: 'verification' },
    { stage: 'close', block: 'close-with-evidence', executionKind: 'compose', terminal: true },
  ],
};

// FALSIFICATION CONTROL — identical shape, but the re-frame is a COMPOSE, not a
// checkpoint. A compose `frame` produces fix.brief@v1, not build.brief@v1, so `plan`
// should STILL abort. If this is also runnable, the checkpoint is not what matters
// and the hypothesis is wrong. If only the checkpoint variant is runnable, the
// content checkpoint is precisely the unlock.
const RESEARCH_REFRAME_BUILD_NO_CHECKPOINT: CompositionRoleSet = {
  id: 'research-reframe-build-no-checkpoint',
  title: 'Research, re-frame with a plain compose, then build (control)',
  purpose:
    'Same shape as research-reframe-build but the re-frame is a plain compose, which produces fix.brief@v1 — not the build.brief@v1 the plan writer needs. Falsification control.',
  roles: [
    { stage: 'frame', block: 'frame', executionKind: 'compose' },
    { stage: 'analyze', block: 'gather-context', executionKind: 'relay', relayRole: 'researcher' },
    { stage: 'analyze', block: 'diagnose', executionKind: 'relay', relayRole: 'researcher' },
    // The would-be re-frame, but as a plain compose — produces fix.brief@v1.
    { stage: 'frame', block: 'frame', executionKind: 'compose' },
    { stage: 'plan', block: 'plan', executionKind: 'compose' },
    { stage: 'act', block: 'act', executionKind: 'relay', relayRole: 'implementer' },
    { stage: 'verify', block: 'run-verification', executionKind: 'verification' },
    { stage: 'close', block: 'close-with-evidence', executionKind: 'compose', terminal: true },
  ],
};

interface ShapeVerdict {
  readonly id: string;
  readonly label: string;
  readonly composed: boolean;
  readonly composeWalls: readonly string[];
  readonly topology: readonly string[];
  readonly stepCount: number;
  readonly valid: boolean;
  readonly seamGatesAccept: boolean;
  readonly runnable: boolean;
  readonly catalogIssues: readonly string[];
  readonly aborts: ReadonlyArray<{ stepId: string; schema: string; reason: string }>;
  // Which gate stopped this shape: 'none' (runnable), 'compose', 'catalog'
  // (structure/alias), or 'runnability' (a writer's required read has no producer).
  readonly blockedBy: 'none' | 'compose' | 'catalog' | 'runnability';
  readonly verdict: string;
}

function topologyOf(schematic: unknown): string[] {
  const items = (schematic as { items?: Array<Record<string, unknown>> } | undefined)?.items ?? [];
  return items.map((item) => {
    const id = String(item.id);
    const output = item.output === undefined ? '' : ` =>${String(item.output)}`;
    return `${id}${output}`;
  });
}

function runShape(roleSet: CompositionRoleSet, label: string): ShapeVerdict {
  const outcome = composeFlow(roleSet, { definitions: flowDefinitions });
  if (!outcome.ok) {
    return {
      id: roleSet.id,
      label,
      composed: false,
      composeWalls: outcome.walls.map((w) => `${w.block}: ${w.reason}`),
      topology: [],
      stepCount: 0,
      valid: false,
      seamGatesAccept: false,
      runnable: false,
      catalogIssues: [],
      aborts: [],
      blockedBy: 'compose',
      verdict: 'compose FAILED (role set could not be assembled)',
    };
  }
  const validity = evaluateValidity(outcome.spec);
  const runnability = evaluateRunnability(outcome.spec);
  const topology = validity.schematic ? topologyOf(validity.schematic) : [];
  const catalogIssues =
    (validity as unknown as { catalogIssues?: readonly string[] }).catalogIssues ?? [];
  const blockedBy: ShapeVerdict['blockedBy'] = !validity.valid
    ? 'catalog'
    : runnability.runnable
      ? 'none'
      : 'runnability';
  const verdict =
    blockedBy === 'none'
      ? 'ACCEPTED: valid AND runnable — a flow that runs to completion'
      : blockedBy === 'catalog'
        ? 'BLOCKED at the catalog gate (structure / contract-alias) — fails before runnability'
        : 'BLOCKED at runnability (a writer required-read has no producer) — passes seam gates';
  return {
    id: roleSet.id,
    label,
    composed: true,
    composeWalls: [],
    topology,
    stepCount: topology.length,
    valid: validity.valid,
    seamGatesAccept: validity.valid,
    runnable: runnability.runnable,
    catalogIssues,
    aborts: runnability.aborts,
    blockedBy,
    verdict,
  };
}

function main(): void {
  const baseline = runShape(
    RESEARCH_THEN_BUILD,
    'BASELINE — compose frame + build tail (Phase 2 failing shape)',
  );
  const control = runShape(
    BUILD_LINEAR_FULL,
    'CONTROL — checkpoint frame at position 0 (known runnable)',
  );
  const hypothesis = runShape(
    RESEARCH_REFRAME_BUILD,
    'HYPOTHESIS — research head + mid-flow checkpoint re-frame + build tail',
  );
  const falsifier = runShape(
    RESEARCH_REFRAME_BUILD_NO_CHECKPOINT,
    'FALSIFIER — same shape but re-frame is a plain compose',
  );

  // The mid-flow checkpoint DID mint build.brief@v1 (read the hypothesis topology:
  // frame-2 => build.brief@v1, and plan => build.plan@v1). So the Phase-2-stated
  // blocker — "build.brief@v1 is not producible from a composed role" — is FALSE.
  // The producer is there. But a NEW, deeper wall appears: the hypothesis shape is
  // rejected at the CATALOG gate, not runnability, because frame-1 (fix.brief@v1)
  // and frame-2 (build.brief@v1) are two specializations of the same generic
  // (flow.brief@v1), and the composer's contract-alias layer binds ONE actual per
  // generic (composer.ts:961, aliasByGeneric.set — the second .set overwrites the
  // first). So flow.brief@v1 resolves to build.brief@v1 and the research head's
  // fix.brief@v1 is orphaned ("output fix.brief@v1 is not compatible with block
  // output flow.brief@v1"; gather-context can no longer see its brief input).
  const hypothesisMintsBuildBrief = hypothesis.topology.some((s) => s.includes('build.brief@v1'));
  const hypothesisBlockedByCatalog = hypothesis.blockedBy === 'catalog';
  const aliasCollision = hypothesis.catalogIssues.some(
    (i) => i.includes('fix.brief@v1') && i.includes('flow.brief@v1'),
  );

  const headline = {
    baseline_runnable: baseline.runnable, // expected false
    control_runnable: control.runnable, // expected true (BUILD_LINEAR_FULL)
    hypothesis_runnable: hypothesis.runnable, // false — but for a NEW reason
    // The Phase-2 blocker is refuted: the mid-flow checkpoint produced build.brief@v1.
    hypothesis_mints_build_brief: hypothesisMintsBuildBrief,
    // The real wall is the catalog gate (contract-alias collision), not runnability.
    hypothesis_blocked_at_catalog_not_runnability: hypothesisBlockedByCatalog,
    contract_alias_collision_confirmed: aliasCollision,
    hypothesis_catalog_issues: hypothesis.catalogIssues,
    falsifier_runnable: falsifier.runnable, // expected false
  };

  const verdictLine =
    hypothesisMintsBuildBrief && hypothesisBlockedByCatalog && aliasCollision
      ? 'PHASE-2 BLOCKER REFUTED, DEEPER WALL FOUND. The mid-flow content checkpoint DID mint ' +
        'build.brief@v1 (so "build.brief@v1 is unproducible from compose" is false). The shape is ' +
        'instead blocked at the CATALOG gate by a contract-alias collision: two frame steps produce ' +
        'two brief families (fix.brief@v1, build.brief@v1) that share one generic (flow.brief@v1), ' +
        'and the composer binds one actual per generic (composer.ts:961), orphaning the first. The ' +
        'real unlock for cross-family "thin then thicken" is per-scope contract aliasing, not a new ' +
        'producer — an engine change to the composer alias model, separately trackable.'
      : 'INDETERMINATE — re-read the per-shape blockedBy + catalogIssues; the expected alias collision did not reproduce.';

  const results = {
    meta: {
      spike: 'build-brief-reframe-spike',
      question:
        'Can a mid-flow content checkpoint that mints build.brief@v1 make a research-head-then-build-tail shape runnable through the full floor?',
      method: 'four locked role sets through evaluateValidity + evaluateRunnability (no model)',
      builds_on:
        'composer.ts checkpointWritesReport (447-463, 756-759), aliasByGeneric (961), step-id dedupe (1056-1065), BUILD_LINEAR_FULL (1240-1258)',
    },
    headline,
    verdict: verdictLine,
    shapes: { baseline, control, hypothesis, falsifier },
  };

  writeFileSync(
    new URL('./_build-brief-reframe-results.json', import.meta.url),
    `${JSON.stringify(results, null, 2)}\n`,
  );

  const log = console.log;
  log('=== BUILD.BRIEF MID-FLOW RE-FRAME — offline floor probe ===');
  log('');
  for (const shape of [baseline, control, hypothesis, falsifier]) {
    log(`--- ${shape.label} ---`);
    if (!shape.composed) {
      log(`  COMPOSE FAILED: ${shape.composeWalls.join(' | ')}`);
      log('');
      continue;
    }
    log(`  topology (${shape.stepCount} steps): ${shape.topology.join('  ->  ')}`);
    log(`  passes seam gates (structure + catalog): ${shape.seamGatesAccept}`);
    log(`  runnable (full floor):                   ${shape.runnable}`);
    log(`  blocked by: ${shape.blockedBy}`);
    if (shape.catalogIssues.length > 0) {
      log('  catalog issues:');
      for (const issue of shape.catalogIssues) log(`    - ${issue}`);
    }
    if (shape.aborts.length > 0) {
      log(`  runtime abort: ${shape.aborts[0]?.stepId} needs ${shape.aborts[0]?.schema}`);
      log(`    reason: ${shape.aborts[0]?.reason}`);
    }
    log(`  => ${shape.verdict}`);
    log('');
  }
  log('--- HEADLINE ---');
  for (const [k, v] of Object.entries(headline)) log(`  ${k}: ${v}`);
  log('');
  log(`VERDICT: ${verdictLine}`);
  log('');
  log('wrote experiments/flow-lab/_build-brief-reframe-results.json');
}

main();
