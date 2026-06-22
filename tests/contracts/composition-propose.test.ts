// Flow-shape composition (experimental, default-OFF): proposeFlow — the PROPOSE
// half of the north star wired into a callable unit.
//
// proposeFlow takes a task, asks an injected relay (a model) to design a flow
// (a CompositionRoleSet), runs the SAME offline floor the shipped composed arm
// passed (composeFlow -> evaluateValidity -> evaluateRunnability), and on a wall
// feeds the verifier's EXACT errors back for a bounded number of repair rounds.
//
// These tests use a scripted stub relay (no model, $0, deterministic). The role
// sets are grounded in real floor verdicts probed before the tests were written:
//   - RUNNABLE_RAW (frame -> gather-context -> diagnose -> close) is runnable.
//   - WALLING (frame -> act -> close) walls at compose: `act` is starved.
//   - REPAIRED (frame -> diagnose -> act -> verify -> close) is runnable.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type CompositionRoleSet,
  PROPOSER_PROMPT,
  REPAIR_GUIDANCE,
  proposeFlow,
} from '../../src/flows/composition/index.js';
import type { RelayResult } from '../../src/shared/connector-relay.js';
import type { RelayFn, RelayInput } from '../../src/shared/relay-runtime-types.js';

// --- grounded fixtures (verdicts probed against the real floor) -------------
const RUNNABLE_RAW: CompositionRoleSet = {
  id: 'triage',
  title: 'Triage',
  purpose: 'Investigate a defect and report findings without changing code.',
  roles: [
    { stage: 'frame', block: 'frame', executionKind: 'compose' },
    { stage: 'analyze', block: 'gather-context', executionKind: 'relay', relayRole: 'researcher' },
    { stage: 'analyze', block: 'diagnose', executionKind: 'relay', relayRole: 'researcher' },
    { stage: 'close', block: 'close-with-evidence', executionKind: 'compose', terminal: true },
  ],
};

const WALLING: CompositionRoleSet = {
  id: 'act-starved',
  title: 'Act Starved',
  purpose: 'An act step with nothing upstream to act on.',
  roles: [
    { stage: 'frame', block: 'frame', executionKind: 'compose' },
    { stage: 'act', block: 'act', executionKind: 'relay', relayRole: 'implementer' },
    { stage: 'close', block: 'close-with-evidence', executionKind: 'compose', terminal: true },
  ],
};

const REPAIRED: CompositionRoleSet = {
  id: 'repaired-linear',
  title: 'Repaired Linear',
  purpose: 'A diagnose step now feeds the act step, so it composes and runs.',
  roles: [
    { stage: 'frame', block: 'frame', executionKind: 'compose' },
    { stage: 'analyze', block: 'diagnose', executionKind: 'relay', relayRole: 'researcher' },
    { stage: 'act', block: 'act', executionKind: 'relay', relayRole: 'implementer' },
    { stage: 'verify', block: 'run-verification', executionKind: 'verification' },
    { stage: 'close', block: 'close-with-evidence', executionKind: 'compose', terminal: true },
  ],
};

// A VOCABULARY error (not a writer-coupling one): run-verification paired with the
// wrong execution kind. The block is real but `relay` is not a kind it produces an
// actual in, so the floor walls with "no registered actual for run-verification/relay".
// This is one of the two real live-run walls; the repair guidance must steer it back
// to the menu's `verification` kind rather than misdiagnosing it as a missing input.
const WRONG_VERIFY_KIND: CompositionRoleSet = {
  id: 'wrong-verify-kind',
  title: 'Wrong Verify Kind',
  purpose: 'run-verification paired with the wrong execution kind (relay, not verification).',
  roles: [
    { stage: 'frame', block: 'frame', executionKind: 'compose' },
    { stage: 'analyze', block: 'diagnose', executionKind: 'relay', relayRole: 'researcher' },
    { stage: 'act', block: 'act', executionKind: 'relay', relayRole: 'implementer' },
    { stage: 'verify', block: 'run-verification', executionKind: 'relay' },
    { stage: 'close', block: 'close-with-evidence', executionKind: 'compose', terminal: true },
  ],
};

// --- scripted stub relay: a queue of responses, one consumed per call -------
// A response is a role set (serialized to result_body), a raw string (to drive
// the parse path), or an Error (to drive the relay-failure path).
type ScriptedResponse = CompositionRoleSet | string | Error;
function scriptedRelay(responses: readonly ScriptedResponse[]): {
  relay: RelayFn;
  calls: { prompt: string }[];
} {
  const calls: { prompt: string }[] = [];
  let index = 0;
  const relay: RelayFn = {
    connectorName: 'stub',
    relay: async (input: RelayInput): Promise<RelayResult> => {
      calls.push({ prompt: input.prompt });
      const response = responses[index] ?? new Error('stub relay queue exhausted');
      index += 1;
      if (response instanceof Error) throw response;
      const body = typeof response === 'string' ? response : JSON.stringify(response);
      return {
        request_payload: input.prompt,
        receipt_id: 'stub',
        result_body: body,
        duration_ms: 1,
        cli_version: '0.0.0-stub',
      };
    },
  };
  return { relay, calls };
}

const TASK = 'Fix an off-by-one bug in the date helper so the unit tests pass.';

describe('proposeFlow — propose + verifier-driven repair', () => {
  it('RAW-RUNNABLE: a first proposal that passes the floor returns ok at round 0', async () => {
    const { relay, calls } = scriptedRelay([RUNNABLE_RAW]);
    // The relay is wired but must not have been called before proposeFlow runs.
    expect(calls).toHaveLength(0);

    const outcome = await proposeFlow({ task: TASK, relay });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.convergedRound).toBe(0);
    expect(outcome.roleSet.id).toBe('triage');
    expect(outcome.spec).toBeDefined();
    expect(outcome.rounds).toHaveLength(1);
    expect(outcome.rounds[0]).toMatchObject({ round: 0, stage: 'runnable', runnable: true });
    // Exactly one model call: the propose, no repair.
    expect(calls).toHaveLength(1);
    // The propose prompt is the proposer prompt followed by the task.
    expect(calls[0]?.prompt).toContain(PROPOSER_PROMPT);
    expect(calls[0]?.prompt).toContain(TASK);
  });

  it('REPAIR-CONVERGES: a wall, then a fix — the verifier error is fed back verbatim', async () => {
    const { relay, calls } = scriptedRelay([WALLING, REPAIRED]);

    const outcome = await proposeFlow({ task: TASK, relay, maxRepair: 2 });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.convergedRound).toBe(1);
    expect(outcome.roleSet.id).toBe('repaired-linear');
    expect(outcome.rounds).toHaveLength(2);
    expect(outcome.rounds[0]).toMatchObject({ round: 0, runnable: false });
    expect(outcome.rounds[0]?.stage).toBe('compose');
    expect(outcome.rounds[1]).toMatchObject({ round: 1, stage: 'runnable', runnable: true });
    // The round-1 repair carries the exact wall error from round 0.
    const fedBack = outcome.rounds[1]?.errorsFedBack ?? [];
    expect(fedBack.some((e) => e.includes('no input set satisfiable'))).toBe(true);
    // And that exact error reached the model: the repair prompt embeds the
    // repair guidance, the proposed flow, and the verifier's error verbatim.
    expect(calls).toHaveLength(2);
    const repairPrompt = calls[1]?.prompt ?? '';
    expect(repairPrompt).toContain(REPAIR_GUIDANCE);
    expect(repairPrompt).toContain('"act-starved"'); // the proposed flow JSON
    // The semicolon form ("...satisfiable; needs one of") is the composer's exact
    // wall text and appears ONLY in the fed-back error. The guidance prose uses an
    // ellipsis form ("...satisfiable ... needs one of"), so this discriminates: it
    // can only be present because the verifier error reached the repair prompt.
    expect(repairPrompt).toContain('no input set satisfiable; needs one of');
  });

  it('WALL: exhausting the repair budget returns a wall with the last proposal + errors', async () => {
    const { relay, calls } = scriptedRelay([WALLING, WALLING, WALLING]);

    const outcome = await proposeFlow({ task: TASK, relay, maxRepair: 2 });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('wall');
    expect(outcome.roleSet?.id).toBe('act-starved');
    expect(outcome.errors.some((e) => e.includes('no input set satisfiable'))).toBe(true);
    // round 0 + 2 repair rounds = 3 rounds, 3 model calls.
    expect(outcome.rounds).toHaveLength(3);
    expect(calls).toHaveLength(3);
    expect(outcome.rounds.every((r) => r.runnable === false)).toBe(true);
  });

  it('PARSE (round 0): an unparseable first emission fails closed with reason parse', async () => {
    const { relay, calls } = scriptedRelay(['I think a linear flow would be best here.']);

    const outcome = await proposeFlow({ task: TASK, relay, maxRepair: 2 });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('parse');
    expect(outcome.rounds).toHaveLength(1);
    expect(outcome.rounds[0]?.stage).toBe('parse');
    // No repair is attempted on a round-0 parse failure: there is no role set to
    // repair against, so only the single propose call was made.
    expect(calls).toHaveLength(1);
  });

  it('PARSE (during repair): junk in a repair round resets, and the loop still converges', async () => {
    const { relay, calls } = scriptedRelay([WALLING, 'oops not json', REPAIRED]);

    const outcome = await proposeFlow({ task: TASK, relay, maxRepair: 2 });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.convergedRound).toBe(2);
    expect(outcome.rounds).toHaveLength(3);
    expect(outcome.rounds[1]?.stage).toBe('parse');
    // The round-2 repair prompt carries the parse-reset instruction, not a floor error.
    expect(calls).toHaveLength(3);
    expect(calls[2]?.prompt).toContain('did not parse');
  });

  it('RELAY (round 0): a relay error fails closed with reason relay', async () => {
    const { relay } = scriptedRelay([new Error('connector timed out')]);

    const outcome = await proposeFlow({ task: TASK, relay });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('relay');
    expect(outcome.errors.some((e) => e.includes('connector timed out'))).toBe(true);
  });

  it('VOCAB-REPAIR: a wrong execution kind walls, and the guidance steers it back to the menu', async () => {
    const { relay, calls } = scriptedRelay([WRONG_VERIFY_KIND, REPAIRED]);

    const outcome = await proposeFlow({ task: TASK, relay, maxRepair: 2 });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.convergedRound).toBe(1);
    // The exact vocabulary wall from the floor is fed back into the repair round.
    const fedBack = outcome.rounds[1]?.errorsFedBack ?? [];
    expect(fedBack.some((e) => e.includes('no registered actual for run-verification/relay'))).toBe(
      true,
    );
    // Discriminating: the SPECIFIC floor wall (not just the always-present guidance
    // text) must reach the model in the repair prompt. This fails if the verbatim
    // error is not fed in — a check for the guidance text alone could not.
    const repairPrompt = calls[1]?.prompt ?? '';
    expect(repairPrompt).toContain('no registered actual for run-verification/relay');
    // And the guidance the model reads carries the rule that names the fix for this
    // class — asserted against the constant, so it fails if the rule is removed.
    expect(REPAIR_GUIDANCE).toContain('run-verification → verification (NOT relay)');
  });

  it('DEFAULT BUDGET: with no maxRepair, the default allows four repair rounds', async () => {
    // 1 propose + 4 repairs, every emission walling: proves the default budget is 4.
    const { relay, calls } = scriptedRelay([WALLING, WALLING, WALLING, WALLING, WALLING]);

    const outcome = await proposeFlow({ task: TASK, relay });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('wall');
    expect(outcome.rounds).toHaveLength(5);
    expect(calls).toHaveLength(5);
  });

  it('INERT + FIDELITY: the inlined prompts are byte-identical to the validated .md artifacts', () => {
    const promptMd = readFileSync(resolve('experiments/flow-lab/_proposer-prompt.md'), 'utf8');
    const repairMd = readFileSync(resolve('experiments/flow-lab/_repair-guidance.md'), 'utf8');
    expect(PROPOSER_PROMPT).toBe(promptMd);
    expect(REPAIR_GUIDANCE).toBe(repairMd);
  });
});
