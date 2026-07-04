import { join, resolve } from 'node:path';

import type { WaitingCheckpointStatus } from '../schemas/run-status.js';
import { runsRoot } from '../shared/control-plane-paths.js';

// Operator-forgiveness helpers for `circuit resume`. The engine's checkpoint
// allow-list stays strict (annotations cannot lie about what was chosen); the
// CLI boundary maps what a person plausibly types — a choice label, a
// different case, stray whitespace, a bare run id instead of the folder —
// onto the canonical form before the engine sees it. A real miss is answered
// with the actual choices, never a generic shrug.

export type CheckpointChoiceMatch =
  | { readonly kind: 'exact'; readonly id: string }
  | { readonly kind: 'normalized'; readonly id: string }
  | { readonly kind: 'no_match' };

interface ChoiceLike {
  readonly id: string;
  readonly label: string;
}

export function matchCheckpointChoice(
  raw: string,
  choices: readonly ChoiceLike[],
): CheckpointChoiceMatch {
  for (const choice of choices) {
    if (choice.id === raw) return { kind: 'exact', id: choice.id };
  }
  const wanted = raw.trim().toLowerCase();
  if (wanted.length === 0) return { kind: 'no_match' };
  const idMatches = choices.filter((choice) => choice.id.toLowerCase() === wanted);
  if (idMatches.length === 1 && idMatches[0] !== undefined) {
    return { kind: 'normalized', id: idMatches[0].id };
  }
  // Ids stay authoritative: the label rung only runs when no id claimed the
  // value, and an ambiguous label refuses rather than guesses.
  if (idMatches.length === 0) {
    const labelMatches = choices.filter((choice) => choice.label.trim().toLowerCase() === wanted);
    if (labelMatches.length === 1 && labelMatches[0] !== undefined) {
      return { kind: 'normalized', id: labelMatches[0].id };
    }
  }
  return { kind: 'no_match' };
}

export function invalidCheckpointChoiceMessage(input: {
  readonly attempted: string;
  readonly runFolder: string;
  readonly checkpoint: Pick<WaitingCheckpointStatus, 'choices'>;
}): string {
  const lines = [
    `error: '${input.attempted}' is not one of this checkpoint's choices.`,
    'The run is waiting with these choices:',
  ];
  for (const choice of input.checkpoint.choices) {
    lines.push(choice.label === choice.id ? `  ${choice.id}` : `  ${choice.id} (${choice.label})`);
  }
  lines.push(
    `Resume with: circuit resume --run-folder ${input.runFolder} --checkpoint-choice <one of the choices above>`,
  );
  return lines.join('\n');
}

// Operators paste the run id from the JSON envelope or the inbox at least as
// often as the full folder path. A bare name (no path separator) also gets a
// try under the project's runs root before we give up.
export function runFolderCandidates(argument: string, cwd: string): string[] {
  const direct = resolve(cwd, argument);
  const isBareName =
    !argument.includes('/') && !argument.includes('\\') && argument !== '.' && argument !== '..';
  if (!isBareName) return [direct];
  return [direct, join(runsRoot(cwd), argument)];
}

// Two honest shapes: a path that is not on disk was "not found"; a path that
// exists but holds no readable run trace must never be described that way.
export function missingRunFolderMessage(input: {
  readonly resolved: string;
  readonly exists: boolean;
}): string {
  const lead = input.exists
    ? `error: ${input.resolved} is not a resumable Circuit run folder (it has no readable run trace).`
    : `error: no Circuit run folder found at ${input.resolved}.`;
  return [
    lead,
    "A run's folder is .circuit/runs/<run id> inside the project that started it.",
    'List runs that are waiting for a decision with: circuit inbox',
  ].join('\n');
}
