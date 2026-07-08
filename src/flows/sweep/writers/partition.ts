// Sweep partition compose writer.
//
// The loop head. Each wave it re-scans the tree, so it sees only the findings
// the previous waves' workers have NOT yet cleared — the survivor set narrows
// itself with no bookkeeping. It groups the survivors into file-disjoint units
// (one worker per file), so the fanout can run them concurrently without two
// workers racing the same file. When a carried lesson from an earlier judge is
// present, it is folded into every unit's fix prompt — the compounding path,
// since a compose head has no relay prompt for the engine to re-inline notes
// into, so the writer reads the notes file itself.
//
// A re-scan that finds nothing is a contract violation, not a clean stop: the
// loop must already have completed at the judge on a green rescan, so an empty
// backlog here means the judge misjudged. The writer throws rather than emit a
// zero-unit partition (which the fanout would reject anyway), turning a would-be
// crash into a legible failure.

import { existsSync, readFileSync } from 'node:fs';
import { resolveRunRelative } from '../../../shared/run-relative-path.js';
import type {
  ComposeBuildContext,
  ComposeBuilder,
} from '../../registries/compose-writers/types.js';
import { SWEEP_CARRIED_NOTES_PATH } from '../paths.js';
import { type SweepFinding, SweepPartition, type SweepUnit } from '../reports.js';
import { runScannerFindings } from './scan.js';

// Turn a file path into a fanout-safe branch id fragment. Unit ids become
// fanout branch ids, which the step schema validates as strict kebab-case slugs
// (`/^[a-z0-9][a-z0-9-]*$/`) AND which appear in directory names — so this folds
// EVERYTHING outside [a-z0-9] to a single dash, lowercases, and trims. A path
// like `src/Alpha.ts` becomes `src-alpha-ts`; the dot or underscore a looser
// sanitizer would keep is exactly what the branch-id regex rejects, which would
// abort the fanout the first wave.
function sanitizeForBranchId(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.length === 0 ? 'unit' : cleaned;
}

// The shape this writer reads out of the engine-written carried-notes file: one
// field, the judge's lesson. Declared locally on purpose — a flow package must
// not import the runtime engine (the CarriedNote type lives in
// runtime/run/carried-notes.ts), so we couple only to the one field we read, not
// to the engine module. `lesson` is optional here because we are parsing opaque
// on-disk JSON defensively, not constructing the engine's own type.
interface CarriedNoteRead {
  readonly lesson?: string;
}

// The most recent judge lesson, if the carried-notes file exists and holds one.
// Absent on wave 0 (no notes yet) and whenever the lesson is "none" (the judge's
// signal that there is nothing to carry). Never throws — notes are an aid.
function latestLesson(runFolder: string): string | undefined {
  const notesPath = resolveRunRelative(runFolder, SWEEP_CARRIED_NOTES_PATH);
  if (!existsSync(notesPath)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(notesPath, 'utf8'));
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  for (let index = parsed.length - 1; index >= 0; index -= 1) {
    const lesson = (parsed[index] as CarriedNoteRead | undefined)?.lesson?.trim();
    if (lesson !== undefined && lesson.length > 0 && lesson.toLowerCase() !== 'none') {
      return lesson;
    }
  }
  return undefined;
}

function fixPrompt(
  file: string,
  findings: readonly SweepFinding[],
  lesson: string | undefined,
): string {
  const rules = [...new Set(findings.map((finding) => finding.rule))].join(', ');
  const lines = findings.map((finding) => `- ${finding.rule}: ${finding.message}`);
  const base = [
    `Fix every finding in ${file}. Change only this file.`,
    `Rules to clear: ${rules}.`,
    'Findings:',
    ...lines,
    'Fix the underlying cause. Do not add suppression directives and do not edit the project config to hide the finding — both are audited and will keep the run red.',
  ];
  if (lesson !== undefined) {
    base.push(`Lesson carried from an earlier attempt: ${lesson}`);
  }
  return base.join('\n');
}

function partitionByFile(
  findings: readonly SweepFinding[],
  lesson: string | undefined,
): SweepUnit[] {
  const byFile = new Map<string, SweepFinding[]>();
  for (const finding of findings) {
    if (finding.file === null) {
      throw new Error(
        `sweep partition: finding '${finding.finding_id}' has no file; project-level findings are not yet partitionable (every finding must be file-scoped)`,
      );
    }
    const group = byFile.get(finding.file);
    if (group === undefined) byFile.set(finding.file, [finding]);
    else group.push(finding);
  }

  const usedIds = new Set<string>();
  const units: SweepUnit[] = [];
  // Named unitIndex, not after the Latin word for position-in-a-sequence: the
  // design-system CSS build scans this tree (theme.css `@source
  // '../../../flows'`), and Tailwind's text extractor reads any bare token that
  // matches a utility class name as a used class. That word is the
  // font-variant-numeric utility, so a variable named it would bloat the
  // committed stylesheet with numeric-variant custom properties. Keep
  // flow-writer identifiers (and this comment) off the Tailwind utility names.
  let unitIndex = 0;
  for (const [file, group] of byFile) {
    unitIndex += 1;
    let unitId = `unit-${unitIndex}-${sanitizeForBranchId(file)}`;
    while (usedIds.has(unitId)) unitId = `${unitId}-x`;
    usedIds.add(unitId);
    units.push({
      unit_id: unitId,
      files: [file],
      finding_ids: group.map((finding) => finding.finding_id),
      // One file per unit, so a unit's fix never touches another unit's file:
      // the isolation that makes the wave safe to fan out concurrently.
      independence: 'isolated',
      fix_prompt: fixPrompt(file, group, lesson),
    });
  }
  return units;
}

export const sweepPartitionComposeBuilder: ComposeBuilder = {
  resultSchemaName: 'sweep.partition@v1',
  build(context: ComposeBuildContext): unknown {
    const projectRoot = context.projectRoot;
    if (projectRoot === undefined) {
      throw new Error(
        'sweep partition requires projectRoot to re-scan the tree; none was provided by the invocation',
      );
    }
    const findings = runScannerFindings(projectRoot);
    if (findings.length === 0) {
      throw new Error(
        'sweep partition: re-scan found no findings, so there is nothing to fan out. The loop should have completed at the judge on a green rescan; reaching partition with an empty backlog means the judge advanced when it should have stopped.',
      );
    }
    const units = partitionByFile(findings, latestLesson(context.runFolder));
    return SweepPartition.parse({ units, covers_all_findings: true });
  },
};
