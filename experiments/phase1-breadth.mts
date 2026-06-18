// Phase 1 breadth harness (offline, $0). Runs the locked C1-C8 topologies from
// the pre-registration (docs/ideas/flow-composition-preregistration.md §3.2)
// through the composer and the REAL engine gates, scores the five rubric axes
// (§4), and applies the §5.2 numeric decision rule. No fitting: the topologies
// and thresholds are fixed in the committed pre-reg; this only measures.
//
// Walls are REPORTED, not swapped (§3.2, §7). A topology that cannot be composed
// for a principled catalog/intent reason is recorded with its wall reason and
// counts as not-valid in the §5.2 tally.

import { flowDefinitions } from '../src/flows/catalog.js';
import {
  type CompositionRoleSet,
  composeFlow,
  evaluateNovelty,
  evaluateSensibility,
  evaluateValidity,
} from '../src/flows/composition/index.js';
import type { FlowSchematic } from '../src/schemas/flow-schematic.js';

const asString = (v: unknown): string => v as unknown as string;

// ---- The locked breadth set (C1-C8) ---------------------------------------
const TOPOLOGIES: readonly CompositionRoleSet[] = [
  {
    id: 'research-then-build',
    title: 'Research then Build',
    purpose: 'Research options, plan, build the chosen one, verify, review, close.',
    roles: [
      { stage: 'frame', block: 'frame', executionKind: 'compose' },
      {
        stage: 'analyze',
        block: 'gather-context',
        executionKind: 'relay',
        relayRole: 'researcher',
      },
      { stage: 'plan', block: 'plan', executionKind: 'compose' },
      { stage: 'act', block: 'act', executionKind: 'relay', relayRole: 'implementer' },
      { stage: 'verify', block: 'run-verification', executionKind: 'verification' },
      { stage: 'review', block: 'review', executionKind: 'relay', relayRole: 'reviewer' },
      { stage: 'close', block: 'close-with-evidence', executionKind: 'compose', terminal: true },
    ],
  },
  {
    id: 'triage-only',
    title: 'Triage Only',
    purpose: 'Investigate why a defect happens and report findings without fixing it.',
    roles: [
      { stage: 'frame', block: 'frame', executionKind: 'compose' },
      {
        stage: 'analyze',
        block: 'gather-context',
        executionKind: 'relay',
        relayRole: 'researcher',
      },
      { stage: 'analyze', block: 'diagnose', executionKind: 'relay', relayRole: 'researcher' },
      { stage: 'close', block: 'close-with-evidence', executionKind: 'compose', terminal: true },
    ],
  },
  {
    id: 'fix-then-prototype',
    title: 'Fix then Prototype',
    purpose: 'Fix the bug, then prototype variants of the new component.',
    roles: [
      { stage: 'frame', block: 'frame', executionKind: 'compose' },
      { stage: 'analyze', block: 'diagnose', executionKind: 'relay', relayRole: 'researcher' },
      { stage: 'act', block: 'act', executionKind: 'relay', relayRole: 'implementer' },
      { stage: 'verify', block: 'run-verification', executionKind: 'verification' },
      { stage: 'verify', block: 'prototype-variant-evidence', executionKind: 'compose' },
      { stage: 'review', block: 'prototype-checkpoint', executionKind: 'checkpoint' },
      { stage: 'close', block: 'close-with-evidence', executionKind: 'compose', terminal: true },
    ],
  },
  {
    id: 'audit-then-fix',
    title: 'Audit then Fix',
    purpose: 'Review the module, then fix the issues it finds and verify.',
    roles: [
      { stage: 'frame', block: 'frame', executionKind: 'compose' },
      { stage: 'analyze', block: 'review', executionKind: 'relay', relayRole: 'reviewer' },
      { stage: 'act', block: 'act', executionKind: 'relay', relayRole: 'implementer' },
      { stage: 'verify', block: 'run-verification', executionKind: 'verification' },
      { stage: 'close', block: 'close-with-evidence', executionKind: 'compose', terminal: true },
    ],
  },
  {
    id: 'research-then-handoff',
    title: 'Research then Handoff',
    purpose: 'Research the approach and hand off a plan for a later session.',
    roles: [
      { stage: 'frame', block: 'frame', executionKind: 'compose' },
      {
        stage: 'analyze',
        block: 'gather-context',
        executionKind: 'relay',
        relayRole: 'researcher',
      },
      { stage: 'plan', block: 'plan', executionKind: 'compose' },
      { stage: 'close', block: 'handoff', executionKind: 'compose', terminal: true },
    ],
  },
  {
    id: 'build-then-review-loop',
    title: 'Build then Review',
    purpose: 'Implement, verify, and independently audit before closing.',
    roles: [
      { stage: 'frame', block: 'frame', executionKind: 'compose' },
      { stage: 'plan', block: 'plan', executionKind: 'compose' },
      { stage: 'act', block: 'act', executionKind: 'relay', relayRole: 'implementer' },
      { stage: 'verify', block: 'run-verification', executionKind: 'verification' },
      { stage: 'review', block: 'review', executionKind: 'relay', relayRole: 'reviewer' },
      { stage: 'close', block: 'close-with-evidence', executionKind: 'compose', terminal: true },
    ],
  },
  {
    id: 'diagnose-plan-checkpoint',
    title: 'Diagnose, Plan, Checkpoint',
    purpose: 'Diagnose the regression, plan a fix, and pause for operator go/no-go.',
    roles: [
      { stage: 'frame', block: 'frame', executionKind: 'compose' },
      {
        stage: 'analyze',
        block: 'gather-context',
        executionKind: 'relay',
        relayRole: 'researcher',
      },
      { stage: 'analyze', block: 'diagnose', executionKind: 'relay', relayRole: 'researcher' },
      { stage: 'plan', block: 'plan', executionKind: 'compose' },
      { stage: 'review', block: 'human-decision', executionKind: 'checkpoint' },
      { stage: 'close', block: 'close-with-evidence', executionKind: 'compose', terminal: true },
    ],
  },
  {
    id: 'gather-verify-close',
    title: 'Gather, Verify, Close',
    purpose: 'Collect the current test/coverage state and verify the suite, then report.',
    roles: [
      { stage: 'frame', block: 'frame', executionKind: 'compose' },
      {
        stage: 'analyze',
        block: 'gather-context',
        executionKind: 'relay',
        relayRole: 'researcher',
      },
      { stage: 'verify', block: 'run-verification', executionKind: 'verification' },
      { stage: 'close', block: 'close-with-evidence', executionKind: 'compose', terminal: true },
    ],
  },
];

// ---- Task-appropriate checklists (structural; stage + kind, never step id) --
interface Feature {
  readonly stage: string;
  readonly kind: string;
  readonly label: string;
}
interface Checklist {
  readonly required: readonly Feature[];
  readonly forbidden: readonly Feature[];
}
const f = (stage: string, kind: string, label: string): Feature => ({ stage, kind, label });

const CHECKLISTS: Readonly<Record<string, Checklist>> = {
  'research-then-build': {
    required: [
      f('analyze', 'relay', 'gather'),
      f('plan', 'compose', 'plan'),
      f('act', 'relay', 'act'),
      f('verify', 'verification', 'verify'),
      f('review', 'relay', 'review'),
      f('close', 'compose', 'close'),
    ],
    forbidden: [],
  },
  'triage-only': {
    required: [f('analyze', 'relay', 'investigate'), f('close', 'compose', 'report')],
    forbidden: [f('act', 'relay', 'no-fix'), f('verify', 'verification', 'no-verify')],
  },
  'fix-then-prototype': {
    required: [
      f('analyze', 'relay', 'diagnose'),
      f('act', 'relay', 'fix'),
      f('verify', 'verification', 'verify'),
      f('verify', 'compose', 'variant-evidence'),
      f('review', 'checkpoint', 'prototype-checkpoint'),
      f('close', 'compose', 'close'),
    ],
    forbidden: [],
  },
  'audit-then-fix': {
    required: [
      f('analyze', 'relay', 'audit'),
      f('act', 'relay', 'fix'),
      f('verify', 'verification', 'verify'),
      f('close', 'compose', 'close'),
    ],
    forbidden: [],
  },
  'research-then-handoff': {
    required: [
      f('analyze', 'relay', 'gather'),
      f('plan', 'compose', 'plan'),
      f('close', 'compose', 'handoff'),
    ],
    forbidden: [f('act', 'relay', 'no-fix'), f('verify', 'verification', 'no-verify')],
  },
  'build-then-review-loop': {
    required: [
      f('plan', 'compose', 'plan'),
      f('act', 'relay', 'act'),
      f('verify', 'verification', 'verify'),
      f('review', 'relay', 'review'),
      f('close', 'compose', 'close'),
    ],
    forbidden: [],
  },
  'diagnose-plan-checkpoint': {
    required: [
      f('analyze', 'relay', 'diagnose'),
      f('plan', 'compose', 'plan'),
      f('review', 'checkpoint', 'operator-decision'),
      f('close', 'compose', 'close'),
    ],
    forbidden: [f('act', 'relay', 'no-fix')],
  },
  'gather-verify-close': {
    required: [
      f('analyze', 'relay', 'gather'),
      f('verify', 'verification', 'verify'),
      f('close', 'compose', 'close'),
    ],
    forbidden: [f('act', 'relay', 'no-fix'), f('review', 'relay', 'no-review')],
  },
};

function hasFeature(schematic: FlowSchematic, feature: Feature): boolean {
  return schematic.items.some(
    (item) => asString(item.stage) === feature.stage && item.execution.kind === feature.kind,
  );
}

function scoreTaskAppropriate(
  schematic: FlowSchematic,
  checklist: Checklist,
): { fraction: number; forbiddenPresent: number; pass: boolean } {
  const present = checklist.required.filter((feat) => hasFeature(schematic, feat)).length;
  const fraction = checklist.required.length === 0 ? 1 : present / checklist.required.length;
  const forbiddenPresent = checklist.forbidden.filter((feat) => hasFeature(schematic, feat)).length;
  return { fraction, forbiddenPresent, pass: fraction >= 0.75 && forbiddenPresent === 0 };
}

// ---- Run -------------------------------------------------------------------
interface Row {
  readonly id: string;
  readonly walled: boolean;
  readonly wall?: string;
  readonly valid: boolean;
  readonly novel: boolean;
  readonly sensible: boolean;
  readonly appFraction: number;
  readonly forbidden: number;
  readonly appPass: boolean;
  readonly consistent: boolean;
  readonly pass: boolean;
  readonly sequence?: string;
  readonly closest?: string;
}

const rows: Row[] = [];
for (const topo of TOPOLOGIES) {
  const outcome = composeFlow(topo, { definitions: flowDefinitions });
  if (!outcome.ok) {
    rows.push({
      id: topo.id,
      walled: true,
      wall: outcome.walls.map((w) => `${w.block}: ${w.reason}`).join(' | '),
      valid: false,
      novel: false,
      sensible: false,
      appFraction: 0,
      forbidden: 0,
      appPass: false,
      consistent: true,
      pass: false,
    });
    continue;
  }

  const validity = evaluateValidity(outcome.spec);
  const schematic = validity.schematic;
  let novel = false;
  let sensible = false;
  let app = { fraction: 0, forbiddenPresent: 0, pass: false };
  let sequence: string | undefined;
  let closest: string | undefined;
  if (schematic) {
    const n = evaluateNovelty(schematic, flowDefinitions);
    novel = n.novel;
    sequence = n.sequence;
    closest = n.closest ? `${n.closest.flowId}@${n.closest.jaccard.toFixed(2)}` : undefined;
    sensible = evaluateSensibility(schematic, {
      boundPrimaryResult: validity.boundPrimaryResult,
    }).sensible;
    const checklist = CHECKLISTS[topo.id];
    if (checklist) app = scoreTaskAppropriate(schematic, checklist);
  }

  // Determinism: K=10 draws collapse to one spec.
  const draws = Array.from({ length: 10 }, () =>
    composeFlow(topo, { definitions: flowDefinitions }),
  );
  const serialized = new Set(
    draws.map((d) => (d.ok ? JSON.stringify(d.spec) : `wall:${JSON.stringify(d.walls)}`)),
  );
  const consistent = serialized.size === 1;

  const pass = validity.valid && novel && sensible && app.pass && consistent;
  rows.push({
    id: topo.id,
    walled: false,
    valid: validity.valid,
    novel,
    sensible,
    appFraction: app.fraction,
    forbidden: app.forbiddenPresent,
    appPass: app.pass,
    consistent,
    pass,
    sequence,
    closest,
  });
}

// ---- Report ----------------------------------------------------------------
const yn = (b: boolean) => (b ? 'Y' : '.');
console.log('\n=== Phase 1 breadth (C1-C8) — offline, real gates ===\n');
console.log('id                        Val Nov Sen App  Frac  Fbd Con Pass  closest');
for (const r of rows) {
  if (r.walled) {
    console.log(`${r.id.padEnd(25)} WALL  ${r.wall}`);
    continue;
  }
  console.log(
    `${r.id.padEnd(25)} ${yn(r.valid)}   ${yn(r.novel)}   ${yn(r.sensible)}   ${yn(r.appPass)}   ${r.appFraction.toFixed(2)}  ${r.forbidden}   ${yn(r.consistent)}   ${yn(r.pass)}    ${r.closest ?? ''}`,
  );
}

const Val = rows.filter((r) => r.valid).length;
const Nov = rows.filter((r) => r.novel).length;
const Sen = rows.filter((r) => r.sensible).length;
const App = rows.filter((r) => r.appPass).length;
const Pass = rows.filter((r) => r.pass).length;
const Con = rows.every((r) => r.consistent);
const validAllNovelSensible = rows.filter((r) => r.valid).every((r) => r.novel && r.sensible);

console.log(`\nVal=${Val}/8  Nov=${Nov}/8  Sen=${Sen}/8  App=${App}/8  Pass=${Pass}/8  Con=${Con}`);
console.log(`every valid flow also novel∧sensible: ${validAllNovelSensible}`);

// §5.2 decision rule (locked)
let verdict: string;
if (Val === 8 && Nov >= 7 && Sen === 8 && Pass >= 6 && Con) {
  verdict = 'WORKS';
} else if (Val >= 5 && validAllNovelSensible && Con) {
  verdict = 'PARTIAL';
} else {
  verdict = 'INTRACTABLE';
}
console.log(`\n§5.2 VERDICT: ${verdict}\n`);

for (const r of rows) {
  if (!r.walled && r.sequence) console.log(`  ${r.id}: ${r.sequence}`);
}
