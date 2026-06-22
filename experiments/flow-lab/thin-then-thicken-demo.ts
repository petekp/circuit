// PHASE 2 — "GENERATE THIN, THEN THICKEN" offline feasibility demonstrator.
//
// THROWAWAY SPIKE — captured in experiments/, NEVER promoted to src/. No model
// calls, no network. Uses only real src composition surfaces + LOCKED role sets, so
// there is no trial-and-error and the result cannot silently drift.
//
// THE IDEA (Pete's musing, the unifying north-star piece): a flow starts THIN — a
// research step that understands the context — and, once research has found what
// the work actually is, the flow THICKENS its remaining steps to fit. The thin
// shape might be "research + report"; the thick shape it grows into might be
// "research + diagnose + plan + implement + verify + close".
//
// THE QUESTION this demonstrator answers, offline and for free: when a flow
// thickens, does the engine's FULL floor (structure + catalog + RUNNABILITY) accept
// the thicker shape? Phase 3 (splice-safety-battery) already proved the splice
// MECHANISM and its safety envelope. This isolates the OTHER half — can the thicker
// shape actually run? — because that is what decides whether the north-star
// "research, then build" is reachable today or blocked on a known gap.
//
// METHOD. We do not invoke a model. We take two LOCKED composition role sets that
// the committed suite already pins (tests/contracts/composition-runnability.test.ts)
// and run them through the real floor:
//   - THIN  = a triage shape (frame -> gather -> diagnose -> close). Runnable.
//   - THICK = RESEARCH_THEN_BUILD (frame -> gather -> diagnose -> plan -> act ->
//     verify -> close). The make-or-break thicken: research, then BUILD.
// For each we print the composed topology and the floor's verdicts (valid /
// runnable). The gap the THICK shape hits is the precise blocker for the
// north-star thicken.
//
// Run: npx tsx experiments/flow-lab/thin-then-thicken-demo.ts
// Writes: experiments/flow-lab/_thin-then-thicken-results.json

import { writeFileSync } from 'node:fs';
import { flowDefinitions } from '../../src/flows/catalog.js';
import {
  type CompositionRoleSet,
  RESEARCH_THEN_BUILD,
  composeFlow,
  evaluateRunnability,
  evaluateValidity,
} from '../../src/flows/composition/index.js';

// THE THIN SHAPE — a runnable triage flow. Research the context, report findings,
// stop. Its close binds the generic flow.result@v1, whose engine close builder
// declares no required reads, so the floor passes it end to end. (This is the
// TRIAGE_ONLY control from composition-runnability.test.ts, inlined so the demo is
// self-contained; the test pins that it is valid + runnable.)
const THIN_TRIAGE: CompositionRoleSet = {
  id: 'thin-triage',
  title: 'Thin: research and report',
  purpose: 'Investigate why a defect happens and report findings without fixing it.',
  roles: [
    { stage: 'frame', block: 'frame', executionKind: 'compose' },
    { stage: 'analyze', block: 'gather-context', executionKind: 'relay', relayRole: 'researcher' },
    { stage: 'analyze', block: 'diagnose', executionKind: 'relay', relayRole: 'researcher' },
    { stage: 'close', block: 'close-with-evidence', executionKind: 'compose', terminal: true },
  ],
};

interface ShapeVerdict {
  readonly id: string;
  readonly title: string;
  readonly composed: boolean;
  readonly topology: readonly string[];
  readonly stepCount: number;
  readonly valid: boolean;
  readonly seamGatesAccept: boolean;
  readonly runnable: boolean;
  readonly aborts: ReadonlyArray<{ stepId: string; schema: string; reason: string }>;
  readonly verdict: string;
}

// Read the composed schematic's step sequence as "block(kind)" labels, for a
// human-legible topology line.
function topologyOf(schematic: unknown): string[] {
  const items = (schematic as { items?: Array<Record<string, unknown>> } | undefined)?.items ?? [];
  return items.map((item) => {
    const id = String(item.id);
    const block = item.block === undefined ? '' : `:${String(item.block)}`;
    return `${id}${block}`;
  });
}

function runShape(roleSet: CompositionRoleSet, label: string): ShapeVerdict {
  const outcome = composeFlow(roleSet, { definitions: flowDefinitions });
  if (!outcome.ok) {
    return {
      id: roleSet.id,
      title: label,
      composed: false,
      topology: [],
      stepCount: 0,
      valid: false,
      seamGatesAccept: false,
      runnable: false,
      aborts: [],
      verdict: 'compose failed (role set could not be assembled)',
    };
  }
  const validity = evaluateValidity(outcome.spec);
  const runnability = evaluateRunnability(outcome.spec);
  const topology = validity.schematic ? topologyOf(validity.schematic) : [];
  // The seam's gate set is schema + catalog, which evaluateValidity covers
  // (assemble + compile + catalog + bound primary result). So "valid" is what the
  // splice seam alone would accept; "runnable" is the fuller floor on top.
  const verdict = !validity.valid
    ? 'rejected by the seam gates (structure/catalog) — would not even splice'
    : runnability.runnable
      ? 'ACCEPTED: valid AND runnable — a flow that runs to completion'
      : 'BLOCKED: passes the seam gates but the full floor finds a runtime abort (fail-closed)';
  return {
    id: roleSet.id,
    title: label,
    composed: true,
    topology,
    stepCount: topology.length,
    valid: validity.valid,
    seamGatesAccept: validity.valid,
    runnable: runnability.runnable,
    aborts: runnability.aborts,
    verdict,
  };
}

function main(): void {
  const thin = runShape(THIN_TRIAGE, 'THIN — research and report');
  const thick = runShape(RESEARCH_THEN_BUILD, 'THICK — research, then build');

  const headline = {
    thin_is_runnable: thin.runnable,
    thick_passes_seam_gates: thick.seamGatesAccept,
    thick_is_runnable: thick.runnable,
    // The whole point: the thicken into a build tail is blocked NOT by the splice
    // mechanism (Phase 3 proved that safe) and NOT by the seam's gates (the thick
    // shape passes them), but by RUNNABILITY — a composer-coverage gap.
    thicken_blocked_by_runnability_not_seam: thick.seamGatesAccept && !thick.runnable,
    blocking_abort: thick.aborts[0]
      ? `${thick.aborts[0].stepId} (${thick.aborts[0].schema}): ${thick.aborts[0].reason}`
      : null,
  };

  const results = {
    meta: {
      spike: 'thin-then-thicken-demo',
      idea: 'a flow researches first, then thickens its remaining steps to fit the findings',
      method:
        'two locked role sets through the real floor (no model): THIN triage vs THICK research-then-build',
      seamGates: 'evaluateValidity (assemble + compile + catalog)',
      fullFloor: 'evaluateValidity + evaluateRunnability (writer-coupling producer chain)',
    },
    headline,
    shapes: { thin, thick },
    lesson:
      'The thicken mechanism and safety envelope are proven (Phase 3). The blocker for ' +
      'thickening into a real BUILD tail is composer COVERAGE: the welded build-plan writer ' +
      'needs build.brief@v1, which only a checkpoint writer produces, so no composed role can ' +
      'satisfy it. Closing build.brief@v1 producibility-from-compose is the unlock for the ' +
      'north-star "research, then build" thicken — a known, separately-tracked gap, not a new one.',
  };

  writeFileSync(
    new URL('./_thin-then-thicken-results.json', import.meta.url),
    `${JSON.stringify(results, null, 2)}\n`,
  );

  const log = console.log;
  log('=== GENERATE THIN, THEN THICKEN — offline feasibility ===');
  log('');
  for (const shape of [thin, thick]) {
    log(`--- ${shape.title} ---`);
    log(`  topology (${shape.stepCount} steps): ${shape.topology.join(' -> ')}`);
    log(`  passes seam gates (structure + catalog): ${shape.seamGatesAccept}`);
    log(`  runnable (full floor):                   ${shape.runnable}`);
    if (shape.aborts.length > 0) {
      log(
        `  runtime abort:                           ${shape.aborts[0]?.stepId} needs ${shape.aborts[0]?.schema}`,
      );
      log(`    reason: ${shape.aborts[0]?.reason}`);
    }
    log(`  => ${shape.verdict}`);
    log('');
  }
  log('--- HEADLINE ---');
  for (const [k, v] of Object.entries(headline)) log(`  ${k}: ${v}`);
  log('');
  log(`LESSON: ${results.lesson}`);
  log('');
  log('wrote experiments/flow-lab/_thin-then-thicken-results.json');
}

main();
