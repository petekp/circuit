// Carried notes: an until-loop's across-iteration memory.
//
// Each iteration the engine appends one note — the judge's lesson, plus any
// budget or no-progress steer — to a run-folder file. The loop's head step
// declares that file in its reads, so the prompt composer re-inlines the
// accumulated notes fresh on the next pass, framed as data the next iteration
// can learn from. This is what turns a loop that merely REPEATS into one that
// LEARNS: the on-thesis codify-and-compound lever for the until loop.
//
// It reuses the run-file store's read-existing / append / atomic-write path; no
// new durability machinery. The notes are opaque data to the engine — it reads
// the judge's lesson string and writes it back verbatim, never interpreting it.

import type { RunFileStore } from '../run-files/run-file-store.js';

// One iteration's entry in the carried-notes file. `lesson` is the judge's own
// words; `steer` is the engine's bounded nudge (a budget warning or a
// no-progress prompt), present only when the engine had something to add.
export interface CarriedNote {
  readonly iteration: number;
  readonly lesson: string;
  readonly steer?: string;
}

// Keep the carried context bounded: a long-running loop must not grow an
// unbounded prompt. Default retains the most recent 20 notes; each text field
// is truncated so one verbose lesson cannot blow the budget on its own.
const DEFAULT_MAX_ENTRIES = 20;
const MAX_NOTE_CHARS = 600;

function capText(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  // Reserve one char for the ellipsis so the capped string never exceeds max.
  return `${trimmed.slice(0, max - 1)}…`;
}

// Append one iteration's note to the carried-notes file, keeping the most recent
// `maxEntries`. Reads the existing file (absent or unparseable => start empty),
// appends the capped note, trims to the cap, and writes atomically through the
// run-file store (the same staged-write-then-rename path every run artifact
// uses, so a crash mid-loop never leaves a torn notes file). Returns the notes
// as written, so the caller can assert or log them.
export async function appendCarriedNote(input: {
  readonly files: RunFileStore;
  readonly report: string;
  readonly note: CarriedNote;
  readonly maxEntries?: number;
}): Promise<readonly CarriedNote[]> {
  const max = input.maxEntries ?? DEFAULT_MAX_ENTRIES;
  let existing: CarriedNote[] = [];
  try {
    const raw = await input.files.readJson(input.report);
    if (Array.isArray(raw)) existing = raw as CarriedNote[];
  } catch {
    // First iteration (no file yet) or an unreadable file: a fresh log is the
    // safe, non-throwing default — carried notes are an aid, never a gate.
    existing = [];
  }
  const capped: CarriedNote = {
    iteration: input.note.iteration,
    lesson: capText(input.note.lesson, MAX_NOTE_CHARS),
    ...(input.note.steer === undefined ? {} : { steer: capText(input.note.steer, MAX_NOTE_CHARS) }),
  };
  const next = [...existing, capped].slice(-max);
  await input.files.writeJson(input.report, next);
  return next;
}
