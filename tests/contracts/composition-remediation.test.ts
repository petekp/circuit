// Composition remediation — locks the two defects the adversarial review found
// before the run was committed (docs/ideas/flow-composition-run-report.md §
// "Adversarial review"). Both defects let the composer claim a fidelity it did
// not have:
//
//   Finding 2 (laundering): the composer hand-kept an ambient-generics table
//   that included flow.evidence@v1 — a contract NO flow declares as an initial
//   (every flow that needs it aliases a registered body to it). Routing it
//   through a composed flow's initial_contracts dodged the unregistered-body
//   gate, so a topology that reads raw flow.evidence@v1 with no producer passed
//   VALID when a hand-authored flow would be forced to alias a body. The fix
//   derives the ambient set from the catalog, so a non-initial contract can no
//   longer be laundered, and the composer rides catalog data (its stated rail).
//
//   Finding 1 (checkpoint over-exclusion): the soak/orphan logic keyed on
//   execution.kind === 'checkpoint' with the false justification that a
//   checkpoint "writes only request/response paths". A checkpoint CAN write a
//   report_path (the shipping build flow's frame-step does), and then its output
//   IS a readable contract. The fix keys on whether the step writes a readable
//   contract (report_path/result_path), matching the engine's read-path
//   resolution.

import { describe, expect, it } from 'vitest';
import { flowDefinitions } from '../../src/flows/catalog.js';
import {
  type CompositionRoleSet,
  composeFlow,
  outputIsReadableContract,
} from '../../src/flows/composition/index.js';

// The only contracts a composed flow may legitimately route through
// initial_contracts: those the catalog itself declares as initial (the runtime
// injects them). Derived from the catalog, never hand-kept.
const catalogInitials = new Set(
  flowDefinitions.flatMap((definition) =>
    definition.schematic.initial_contracts.map((contract) => contract as unknown as string),
  ),
);

const ALL_TOPOLOGIES: readonly CompositionRoleSet[] = [
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

describe('composition remediation — no contract laundering (Finding 2)', () => {
  it('flow.evidence@v1 is not a catalog initial — it is always aliased to a body', () => {
    expect(catalogInitials.has('flow.evidence@v1')).toBe(false);
  });

  it('never routes a non-initial contract through a composed flow initial_contracts', () => {
    for (const topology of ALL_TOPOLOGIES) {
      const outcome = composeFlow(topology, { definitions: flowDefinitions });
      if (!outcome.ok) continue;
      for (const contract of outcome.spec.initial_contracts ?? []) {
        expect(catalogInitials.has(contract as unknown as string)).toBe(true);
      }
    }
  });

  it('walls diagnose-plan-checkpoint: human-decision needs flow.evidence@v1 with no legitimate producer', () => {
    // diagnose produces diagnosis.result@v1, not flow.evidence@v1; the catalog
    // does not inject flow.evidence@v1. A hand-authored flow would alias an
    // upstream body to flow.evidence@v1; the composer does not synthesize
    // multi-generic aliases, so it walls honestly rather than laundering.
    const outcome = composeFlow(DIAGNOSE_PLAN_CHECKPOINT, { definitions: flowDefinitions });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.walls.some((wall) => wall.block === 'human-decision')).toBe(true);
    }
  });
});

describe('composition remediation — readable-output predicate (Finding 1)', () => {
  it('keys readability on report_path/result_path, not execution kind', () => {
    // compose / verification: one report write -> readable.
    expect(outputIsReadableContract({ report_path: 'reports/x.json' })).toBe(true);
    // relay: writes a worker result + report -> readable.
    expect(
      outputIsReadableContract({
        report_path: 'reports/x.json',
        request_path: 'reports/relay/x.request.json',
        receipt_path: 'reports/relay/x.receipt.txt',
        result_path: 'reports/relay/x.result.json',
      }),
    ).toBe(true);
    // checkpoint that writes only its routing paths -> NOT readable.
    expect(
      outputIsReadableContract({
        checkpoint_request_path: 'reports/checkpoints/x-request.json',
        checkpoint_response_path: 'reports/checkpoints/x-response.json',
      }),
    ).toBe(false);
    // checkpoint that ALSO writes a report (build's frame-step) -> readable.
    expect(
      outputIsReadableContract({
        checkpoint_request_path: 'reports/checkpoints/x-request.json',
        checkpoint_response_path: 'reports/checkpoints/x-response.json',
        report_path: 'reports/build/brief.json',
      }),
    ).toBe(true);
    // absent writes -> not readable.
    expect(outputIsReadableContract(undefined)).toBe(false);
  });
});
