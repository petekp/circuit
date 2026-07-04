import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  invalidCheckpointChoiceMessage,
  matchCheckpointChoice,
  missingRunFolderMessage,
  runFolderCandidates,
} from '../../src/cli/resume-input.js';

// Operator-forgiveness helpers for `circuit resume` (checkpoint UX audit,
// finding 1 + 2 + 3). The engine's allow-list stays strict; the CLI boundary
// maps what a person plausibly types (a label, a different case, stray
// whitespace, a bare run id) onto the canonical form before the engine sees
// it, and answers a miss with the actual choices instead of a generic shrug.

const CHOICES = [
  { id: 'keep-prototype', label: 'Keep the prototype', value: 'keep-prototype' },
  { id: 'discard-prototype', label: 'Discard the prototype', value: 'discard-prototype' },
] as const;

describe('matchCheckpointChoice', () => {
  it('passes an exact id through untouched', () => {
    expect(matchCheckpointChoice('keep-prototype', CHOICES)).toEqual({
      kind: 'exact',
      id: 'keep-prototype',
    });
  });

  it('maps a differently-cased id onto the canonical id', () => {
    expect(matchCheckpointChoice('KEEP-PROTOTYPE', CHOICES)).toEqual({
      kind: 'normalized',
      id: 'keep-prototype',
    });
  });

  it('forgives surrounding whitespace', () => {
    expect(matchCheckpointChoice('  keep-prototype ', CHOICES)).toEqual({
      kind: 'normalized',
      id: 'keep-prototype',
    });
  });

  it('maps a choice label onto its id, case-insensitively', () => {
    expect(matchCheckpointChoice('Keep the prototype', CHOICES)).toEqual({
      kind: 'normalized',
      id: 'keep-prototype',
    });
    expect(matchCheckpointChoice('keep the prototype', CHOICES)).toEqual({
      kind: 'normalized',
      id: 'keep-prototype',
    });
  });

  it('reports no match for an unknown value or an empty value', () => {
    expect(matchCheckpointChoice('keepit', CHOICES)).toEqual({ kind: 'no_match' });
    expect(matchCheckpointChoice('', CHOICES)).toEqual({ kind: 'no_match' });
    expect(matchCheckpointChoice('   ', CHOICES)).toEqual({ kind: 'no_match' });
  });

  it('prefers an id match over a label match when both could apply', () => {
    const choices = [
      { id: 'stop', label: 'Halt the run', value: 'stop' },
      { id: 'halt-the-run', label: 'Stop', value: 'halt-the-run' },
    ] as const;
    // 'stop' hits choice one by id before choice two's label is considered.
    expect(matchCheckpointChoice('stop', choices)).toEqual({ kind: 'exact', id: 'stop' });
    expect(matchCheckpointChoice('STOP', choices)).toEqual({ kind: 'normalized', id: 'stop' });
  });

  it('refuses an ambiguous label instead of guessing', () => {
    const choices = [
      { id: 'a', label: 'Same label', value: 'a' },
      { id: 'b', label: 'same label', value: 'b' },
    ] as const;
    expect(matchCheckpointChoice('SAME LABEL', choices)).toEqual({ kind: 'no_match' });
  });
});

describe('invalidCheckpointChoiceMessage', () => {
  const checkpoint = {
    checkpoint_id: 'decide:1',
    step_id: 'decide',
    attempt: 1,
    prompt: 'Choose what happens to the prototype.',
    choices: [...CHOICES],
  };

  it('names the attempted value, lists ids with labels, and shows the resume command', () => {
    const message = invalidCheckpointChoiceMessage({
      attempted: 'keepit',
      runFolder: '/tmp/run-folder',
      checkpoint,
    });
    expect(message).toContain("'keepit'");
    expect(message).toContain('keep-prototype (Keep the prototype)');
    expect(message).toContain('discard-prototype (Discard the prototype)');
    expect(message).toContain('circuit resume --run-folder /tmp/run-folder --checkpoint-choice');
    expect(message.startsWith('error:')).toBe(true);
  });

  it('does not repeat the label when it matches the id', () => {
    const message = invalidCheckpointChoiceMessage({
      attempted: 'nope',
      runFolder: '/tmp/run-folder',
      checkpoint: {
        ...checkpoint,
        choices: [{ id: 'continue', label: 'continue', value: 'continue' }],
      },
    });
    expect(message).toContain('continue');
    expect(message).not.toContain('continue (continue)');
  });
});

describe('runFolderCandidates', () => {
  const cwd = '/work/project';

  it('resolves a path argument against the working directory only', () => {
    expect(runFolderCandidates('runs/abc', cwd)).toEqual([resolve(cwd, 'runs/abc')]);
    expect(runFolderCandidates('/abs/run', cwd)).toEqual([resolve('/abs/run')]);
    expect(runFolderCandidates('.', cwd)).toEqual([resolve(cwd)]);
    expect(runFolderCandidates('..', cwd)).toEqual([resolve(cwd, '..')]);
  });

  it('also tries .circuit/runs/<name> for a bare name such as a pasted run id', () => {
    expect(runFolderCandidates('515503b2-9517-4e64-b15d-dc5cb1fbff1b', cwd)).toEqual([
      resolve(cwd, '515503b2-9517-4e64-b15d-dc5cb1fbff1b'),
      join(resolve(cwd, '.circuit', 'runs'), '515503b2-9517-4e64-b15d-dc5cb1fbff1b'),
    ]);
  });
});

describe('missingRunFolderMessage', () => {
  it('names the missing path, the run-id folder convention, and the inbox', () => {
    const message = missingRunFolderMessage({ resolved: '/work/project/nope', exists: false });
    expect(message).toContain('no Circuit run folder found at /work/project/nope');
    expect(message).toContain('.circuit/runs/');
    expect(message).toContain('circuit inbox');
    expect(message.startsWith('error:')).toBe(true);
  });

  it('stays honest when the path exists but is not a run folder', () => {
    const message = missingRunFolderMessage({ resolved: '/work/project/docs', exists: true });
    // The folder was found, so the message must not claim otherwise.
    expect(message).not.toContain('no Circuit run folder found');
    expect(message).toContain('/work/project/docs is not a resumable Circuit run folder');
    expect(message).toContain('.circuit/runs/');
    expect(message).toContain('circuit inbox');
    expect(message.startsWith('error:')).toBe(true);
  });
});
