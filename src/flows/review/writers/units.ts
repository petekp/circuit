/**
 * Splitting a codebase into reviewable units.
 *
 * "Review this codebase" names more code than one relay can hold, and no bound
 * makes it fit. The answer is fan-out: split the tree into units, review each
 * one, merge the findings. This module owns the split.
 *
 * The rule is greedy packing under a size budget, with files from the same
 * directory kept together where they fit. It is deliberately a plain function
 * over a file list rather than a model call: the split is something the report
 * has to stand behind, and a deterministic rule can be described in one
 * sentence and reproduced by anyone reading the run. The cost is that a
 * subsystem straddling two directories gets split; the merge step is what
 * makes that survivable, because findings from every unit land in one verdict.
 */

const REPOSITORY_ROOT_LABEL = 'the repository root';

export interface ReviewUnitFile {
  /** Repository-relative path, exactly as Git listed it. */
  readonly path: string;
  /**
   * Size in bytes, used as the character proxy for packing. A proxy is honest
   * here because the budget is an upper bound: the per-file read applies its
   * own truncation, so a unit's real content can be smaller than its estimate
   * but never larger.
   */
  readonly size: number;
}

export interface ReviewUnit {
  /** Stable, one-based id. Branch ids and per-unit reports are named from it. */
  readonly unit_id: string;
  /** What a person would call this unit, for the report. */
  readonly label: string;
  readonly paths: readonly string[];
  readonly estimated_chars: number;
}

export interface ReviewUnitBudget {
  readonly maxFilesPerUnit: number;
  readonly maxCharsPerUnit: number;
}

function directoryOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}

function directoryLabel(directory: string): string {
  return directory === '' ? REPOSITORY_ROOT_LABEL : directory;
}

interface DirectoryGroup {
  readonly directory: string;
  readonly files: readonly ReviewUnitFile[];
  readonly chars: number;
}

/**
 * Group by directory, then sort both the groups and the files inside them by
 * path. Sorting is what makes the split reproducible: Git's listing order is
 * stable in practice but is not something the report should depend on, and two
 * runs over the same tree must produce the same units or the unit ids in a
 * report mean nothing.
 */
function groupByDirectory(files: readonly ReviewUnitFile[]): readonly DirectoryGroup[] {
  const byDirectory = new Map<string, ReviewUnitFile[]>();
  for (const file of files) {
    const directory = directoryOf(file.path);
    const existing = byDirectory.get(directory);
    if (existing === undefined) byDirectory.set(directory, [file]);
    else existing.push(file);
  }
  return [...byDirectory.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([directory, groupFiles]) => {
      const sorted = [...groupFiles].sort((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
      );
      return {
        directory,
        files: sorted,
        chars: sorted.reduce((total, file) => total + file.size, 0),
      };
    });
}

// A unit under construction. `directories` is ordered by first appearance so
// the finished label reads in the same order the paths do.
interface OpenUnit {
  files: ReviewUnitFile[];
  chars: number;
  directories: string[];
}

function emptyUnit(): OpenUnit {
  return { files: [], chars: 0, directories: [] };
}

function labelFor(unit: OpenUnit): string {
  const labels = unit.directories.map(directoryLabel);
  if (labels.length === 0) return REPOSITORY_ROOT_LABEL;
  if (labels.length === 1) return labels[0] as string;
  if (labels.length === 2) return `${labels[0]} + ${labels[1]}`;
  return `${labels[0]} + ${labels.length - 1} more`;
}

function closeUnit(unit: OpenUnit, index: number, overrideLabel?: string): ReviewUnit {
  return {
    unit_id: `unit-${index}`,
    label: overrideLabel ?? labelFor(unit),
    paths: unit.files.map((file) => file.path),
    estimated_chars: unit.chars,
  };
}

/**
 * Pack a file list into units under a budget.
 *
 * Two passes over each directory group:
 *
 *   - A group that fits in an empty unit is placed whole, into the open unit if
 *     there is room and a fresh one otherwise. This is what keeps a directory
 *     together.
 *   - A group too big for any single unit is split file by file, and every
 *     piece is labelled `<dir> (part N)` so a reader can never mistake a
 *     fragment for the whole directory.
 *
 * A single file larger than the whole budget still gets a unit of its own
 * rather than being dropped. Dropping it would be the one outcome the report
 * could not honestly describe.
 */
export function packReviewUnits(
  files: readonly ReviewUnitFile[],
  budget: ReviewUnitBudget,
): readonly ReviewUnit[] {
  const groups = groupByDirectory(files);
  const units: ReviewUnit[] = [];
  let open = emptyUnit();

  const flush = (label?: string): void => {
    if (open.files.length === 0) return;
    units.push(closeUnit(open, units.length + 1, label));
    open = emptyUnit();
  };

  const fitsInOpen = (fileCount: number, chars: number): boolean =>
    open.files.length + fileCount <= budget.maxFilesPerUnit &&
    open.chars + chars <= budget.maxCharsPerUnit;

  for (const group of groups) {
    const groupFitsAlone =
      group.files.length <= budget.maxFilesPerUnit && group.chars <= budget.maxCharsPerUnit;

    if (groupFitsAlone) {
      if (!fitsInOpen(group.files.length, group.chars)) flush();
      open.files.push(...group.files);
      open.chars += group.chars;
      open.directories.push(group.directory);
      continue;
    }

    // The group outgrows a unit. Close whatever is open so the parts of a split
    // directory are not mixed in with unrelated files, then walk it file by
    // file. Part numbering is per-directory, so it reads as "part 2 of this
    // directory" rather than as a position in the whole run.
    flush();
    let part = 1;
    for (const file of group.files) {
      if (open.files.length > 0 && !fitsInOpen(1, file.size)) {
        flush(`${directoryLabel(group.directory)} (part ${part})`);
        part += 1;
      }
      open.files.push(file);
      open.chars += file.size;
      if (open.directories.length === 0) open.directories.push(group.directory);
    }
    flush(`${directoryLabel(group.directory)} (part ${part})`);
  }

  flush();
  return units;
}
