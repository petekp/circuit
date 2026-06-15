// E1 checkpoint detection — the pure half of the checkpoint-aware live lane.
//
// `build` opens with a single human checkpoint (`frame-step`). Run headless,
// `circuit run` does not error: it writes `reports/process-evidence.json` with
// `outcome: 'checkpoint_waiting'` and the checkpoint metadata, then exits 0
// WITHOUT a terminal `reports/result.json`. To reach a terminal outcome the
// harness must answer the checkpoint with
// `circuit resume --run-folder <RF> --checkpoint-choice <choice>`, which
// continues the SAME run in the SAME folder and re-emits the terminal artifacts.
//
// This module is the deterministic decision: given a run folder, is the run
// parked at a checkpoint, and if so which choice clears it? No clock, no
// network, no subprocess — so the fixture lane proves it without spending a cent.
// The runner (runner.ts) is the only place that actually shells out to resume.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The choice the harness prefers when it is offered: the documented continue
// path. `build`'s frame-step declares `allow: ['continue']` with
// `safe_default_choice: 'continue'`, so this is what a non-interactive operator
// confirming the brief would pick.
export const PREFERRED_CHECKPOINT_CHOICE = 'continue';

export interface CheckpointWaiting {
  readonly waiting: true;
  readonly stepId: string;
  readonly allowedChoices: readonly string[];
  // The choice the harness will send to `circuit resume --checkpoint-choice`.
  readonly choice: string;
}

export interface CheckpointCleared {
  readonly waiting: false;
}

export type CheckpointState = CheckpointWaiting | CheckpointCleared;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Pick the choice that clears a checkpoint. Prefer the documented `continue`
// path when it is allowed; otherwise fall back to the first allowed choice so a
// future checkpoint with a different vocabulary still advances rather than
// stalls. Empty input (which the schema forbids, so this is purely defensive)
// falls back to the preferred choice.
export function chooseCheckpointChoice(allowedChoices: readonly string[]): string {
  if (allowedChoices.includes(PREFERRED_CHECKPOINT_CHOICE)) {
    return PREFERRED_CHECKPOINT_CHOICE;
  }
  if (allowedChoices.length > 0) {
    return allowedChoices[0] as string;
  }
  return PREFERRED_CHECKPOINT_CHOICE;
}

// Read `reports/process-evidence.json` and decide whether the run is parked at a
// checkpoint. Defensive: a missing or malformed artifact reads as "not waiting"
// (the run either is not at a checkpoint or never produced the projection), so
// the caller treats the run folder as terminal and lets extraction report
// whatever it holds.
export function readCheckpointState(runFolder: string): CheckpointState {
  const path = join(runFolder, 'reports', 'process-evidence.json');
  if (!existsSync(path)) return { waiting: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { waiting: false };
  }

  if (!isRecord(parsed) || parsed.outcome !== 'checkpoint_waiting') {
    return { waiting: false };
  }

  const checkpoint = isRecord(parsed.checkpoint) ? parsed.checkpoint : undefined;
  const stepId = typeof checkpoint?.step_id === 'string' ? checkpoint.step_id : 'unknown';
  const allowedChoices = Array.isArray(checkpoint?.allowed_choices)
    ? checkpoint.allowed_choices.filter((choice): choice is string => typeof choice === 'string')
    : [];

  return {
    waiting: true,
    stepId,
    allowedChoices,
    choice: chooseCheckpointChoice(allowedChoices),
  };
}
