// Phase 1 breadth — the composer must keep flows SENSIBLE across topologies that
// terminate without a full verify+review back. A triage flow (frame → gather →
// diagnose → close) produces a diagnosis that the close step must report, not
// drop: close-with-evidence's smallest satisfiable input set is [brief], so a
// naive composer would read only the brief and orphan the diagnosis. The
// composer must soak otherwise-unconsumed upstream evidence into the terminal
// close — exactly what the hand-authored fix family does (its close reads brief,
// context, diagnosis, change, verification). This locks that behavior.
//
// The §5.2 decision rule turns on this: a flow that is VALID but not SENSIBLE
// downgrades the whole run to INTRACTABLE. Evidence-soaking is what keeps the
// short-tail topologies sensible.

import { describe, expect, it } from 'vitest';
import { flowDefinitions } from '../../src/flows/catalog.js';
import {
  type CompositionRoleSet,
  GOAL_THEN_FIX,
  composeFlow,
  evaluateSensibility,
  evaluateValidity,
} from '../../src/flows/composition/index.js';

const TRIAGE_ONLY: CompositionRoleSet = {
  id: 'triage-only',
  title: 'Triage Only',
  purpose:
    'Investigate why a defect happens and report findings without fixing it. A diagnose-and-close flow with no act or verify back.',
  roles: [
    { stage: 'frame', block: 'frame', executionKind: 'compose' },
    { stage: 'analyze', block: 'gather-context', executionKind: 'relay', relayRole: 'researcher' },
    { stage: 'analyze', block: 'diagnose', executionKind: 'relay', relayRole: 'researcher' },
    { stage: 'close', block: 'close-with-evidence', executionKind: 'compose', terminal: true },
  ],
};

const GATHER_VERIFY_CLOSE: CompositionRoleSet = {
  id: 'gather-verify-close',
  title: 'Gather, Verify, Close',
  purpose: 'Collect the current test/coverage state and verify the suite, then report.',
  roles: [
    { stage: 'frame', block: 'frame', executionKind: 'compose' },
    { stage: 'analyze', block: 'gather-context', executionKind: 'relay', relayRole: 'researcher' },
    { stage: 'verify', block: 'run-verification', executionKind: 'verification' },
    { stage: 'close', block: 'close-with-evidence', executionKind: 'compose', terminal: true },
  ],
};

const DIAGNOSE_PLAN_CHECKPOINT: CompositionRoleSet = {
  id: 'diagnose-plan-checkpoint',
  title: 'Diagnose, Plan, Checkpoint',
  purpose: 'Diagnose the regression, plan a fix, and pause for operator go/no-go.',
  roles: [
    { stage: 'frame', block: 'frame', executionKind: 'compose' },
    { stage: 'analyze', block: 'gather-context', executionKind: 'relay', relayRole: 'researcher' },
    { stage: 'analyze', block: 'diagnose', executionKind: 'relay', relayRole: 'researcher' },
    { stage: 'plan', block: 'plan', executionKind: 'compose' },
    { stage: 'review', block: 'human-decision', executionKind: 'checkpoint' },
    { stage: 'close', block: 'close-with-evidence', executionKind: 'compose', terminal: true },
  ],
};

describe('Phase 1 — short-tail topologies stay sensible', () => {
  const outcome = composeFlow(TRIAGE_ONLY, { definitions: flowDefinitions });

  it('composes triage-only without a wall', () => {
    if (!outcome.ok) {
      throw new Error(
        `composer hit walls: ${outcome.walls.map((w) => `${w.block}: ${w.reason}`).join(' | ')}`,
      );
    }
    expect(outcome.ok).toBe(true);
  });

  it('is VALID and SENSIBLE — the diagnosis is reported by close, not orphaned', () => {
    if (!outcome.ok) throw new Error('compose failed');
    const validity = evaluateValidity(outcome.spec);
    if (!validity.valid) {
      throw new Error(
        `not valid: compiles=${validity.compiles} catalogIssues=${validity.catalogIssueCount} primary=${validity.boundPrimaryResult} error=${validity.error ?? 'none'} issues=${validity.catalogIssues.join(' ; ')}`,
      );
    }
    if (!validity.schematic) throw new Error('valid spec produced no schematic');
    const sensibility = evaluateSensibility(validity.schematic, {
      boundPrimaryResult: validity.boundPrimaryResult,
    });
    if (!sensibility.sensible) {
      throw new Error(`not sensible: ${sensibility.failures.join(' | ')}`);
    }
    expect(sensibility.noOrphan).toBe(true);

    // The close step must actually read the diagnosis it is reporting.
    const closeStep = validity.schematic.items[validity.schematic.items.length - 1];
    if (closeStep === undefined) throw new Error('schematic has no items');
    const closeReads = Object.values(closeStep.input).map(String);
    expect(closeReads.some((c) => c.includes('diagnosis') || c.endsWith('.diagnosis@v1'))).toBe(
      true,
    );
  });
});

describe('Phase 1 — verification of existing state is sensible (intent not over-constrained)', () => {
  it('gather-verify-close is VALID and SENSIBLE with no change upstream', () => {
    // run-verification here checks the existing suite — there is no act/change.
    // The intent model must NOT require change-made (the catalog runs
    // verification pre-change too, e.g. build-baseline), or this is wrongly
    // flagged insensible and the whole run downgrades to INTRACTABLE.
    const outcome = composeFlow(GATHER_VERIFY_CLOSE, { definitions: flowDefinitions });
    if (!outcome.ok) {
      throw new Error(`walls: ${outcome.walls.map((w) => `${w.block}: ${w.reason}`).join(' | ')}`);
    }
    const validity = evaluateValidity(outcome.spec);
    if (!validity.valid || !validity.schematic) {
      throw new Error(`not valid: ${validity.error ?? validity.catalogIssues.join('; ')}`);
    }
    const sensibility = evaluateSensibility(validity.schematic, {
      boundPrimaryResult: validity.boundPrimaryResult,
    });
    if (!sensibility.sensible) throw new Error(`not sensible: ${sensibility.failures.join(' | ')}`);
    expect(sensibility.intentClosure).toBe(true);
  });
});

describe('Phase 1 — a composed sub-run is SENSIBLE, not just VALID', () => {
  // The sub-run shape (PR #124) was locked VALID + LIVE + BOUNDED, but its test
  // deliberately never asserted SENSIBLE: the `goal` and `goal-child-run` blocks
  // had no BLOCK_INTENT entry, so intent closure failed and the flow scored
  // VALID-ONLY. That gap matters now — the §5.2 rule downgrades a VALID-but-not-
  // SENSIBLE flow to INTRACTABLE, so a delegate-to-child flow could never be
  // judged a sensible process. The goal family's intents are additive metadata
  // (the eight built-ins and the catalog are untouched): `goal` establishes the
  // same 'task-framed' state `frame` does, and `goal-child-run` requires it. With
  // those two entries, a frame-then-delegate-then-close flow closes its intent.
  it('goal-then-fix closes intent: goal frames the task, delegate needs it, close reports it', () => {
    const outcome = composeFlow(GOAL_THEN_FIX, { definitions: flowDefinitions });
    if (!outcome.ok) {
      throw new Error(`walls: ${outcome.walls.map((w) => `${w.block}: ${w.reason}`).join(' | ')}`);
    }
    const validity = evaluateValidity(outcome.spec);
    if (!validity.valid || !validity.schematic) {
      throw new Error(`not valid: ${validity.error ?? validity.catalogIssues.join('; ')}`);
    }
    const sensibility = evaluateSensibility(validity.schematic, {
      boundPrimaryResult: validity.boundPrimaryResult,
    });
    if (!sensibility.sensible) throw new Error(`not sensible: ${sensibility.failures.join(' | ')}`);
    expect(sensibility.intentClosure).toBe(true);
    expect(sensibility.sensible).toBe(true);
  });
});

describe('Phase 2 — a clarify-opened flow is SENSIBLE, not just VALID', () => {
  // The Phase 2 model proposer, told that `clarify` is a frame-stage block, opens
  // an ambiguous-bug flow with clarify instead of frame: clarify turns a rough
  // request into a precise task, which is exactly a framing act. But `clarify` had
  // no BLOCK_INTENT entry, so it established no 'task-framed' state and every
  // downstream step's precondition went unmet — the flow scored VALID but
  // INSENSIBLE (the §5.2 rule then downgrades the run to INTRACTABLE). The fix is
  // the same additive move the goal family got in PR #127: declare clarify's
  // intent. clarify reads the raw operator intake (catalog input task.intake@v1,
  // no prior brief), so its precondition is empty and it establishes 'task-framed'
  // — the frame analog. This locks that a clarify-opened flow closes its intent.
  //
  // The arc deliberately omits run-verification: the fix verification writer
  // sources its command list from the frame brief (fix.brief@v1), and a
  // clarify opener produces clarified.task@v1, not that brief. A clarify-opened
  // fix flow therefore cannot feed the fix verification writer, and the composer
  // now correctly WALLS that combination (composition-verification-reads.test.ts
  // locks both the wall and the frame-opened pass). Intent closure here turns on
  // clarify establishing task-framed for every downstream precondition, which
  // run-verification is not needed to exercise — gather/diagnose/act/review/close
  // all require task-framed and clarify satisfies it.
  const CLARIFY_OPENS: CompositionRoleSet = {
    id: 'clarify-opened-fix',
    title: 'Clarify Then Fix',
    purpose:
      'Clarify a vague bug report into a precise task, then gather context, diagnose, fix, review, and close.',
    roles: [
      { stage: 'frame', block: 'clarify', executionKind: 'relay', relayRole: 'researcher' },
      {
        stage: 'analyze',
        block: 'gather-context',
        executionKind: 'relay',
        relayRole: 'researcher',
      },
      { stage: 'analyze', block: 'diagnose', executionKind: 'relay', relayRole: 'researcher' },
      { stage: 'act', block: 'act', executionKind: 'relay', relayRole: 'implementer' },
      { stage: 'review', block: 'review', executionKind: 'relay', relayRole: 'reviewer' },
      { stage: 'close', block: 'close-with-evidence', executionKind: 'compose', terminal: true },
    ],
  };

  it('clarify frames the task: it establishes task-framed so downstream preconditions close', () => {
    const outcome = composeFlow(CLARIFY_OPENS, { definitions: flowDefinitions });
    if (!outcome.ok) {
      throw new Error(`walls: ${outcome.walls.map((w) => `${w.block}: ${w.reason}`).join(' | ')}`);
    }
    const validity = evaluateValidity(outcome.spec);
    if (!validity.valid || !validity.schematic) {
      throw new Error(`not valid: ${validity.error ?? validity.catalogIssues.join('; ')}`);
    }
    const sensibility = evaluateSensibility(validity.schematic, {
      boundPrimaryResult: validity.boundPrimaryResult,
    });
    if (!sensibility.sensible) throw new Error(`not sensible: ${sensibility.failures.join(' | ')}`);
    expect(sensibility.intentClosure).toBe(true);
    expect(sensibility.sensible).toBe(true);
  });
});

describe('Phase 1 — a mid-flow operator checkpoint walls honestly', () => {
  it('diagnose-plan-checkpoint WALLS: human-decision needs flow.evidence@v1 with no legitimate producer', () => {
    // human-decision reads flow.evidence@v1, but diagnose produces
    // diagnosis.result@v1 (its block output), and the catalog does not inject
    // flow.evidence@v1 (no flow declares it initial — every flow that needs it
    // aliases a registered body to it). A hand-authored flow would alias an
    // upstream body to flow.evidence@v1; the composer does not synthesize
    // multi-generic aliases, so it walls rather than laundering the raw generic
    // through initial_contracts. The adversarial review caught the earlier
    // laundering shortcut; this locks the honest wall.
    const outcome = composeFlow(DIAGNOSE_PLAN_CHECKPOINT, { definitions: flowDefinitions });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.walls.some((wall) => wall.block === 'human-decision')).toBe(true);
    }
  });
});
