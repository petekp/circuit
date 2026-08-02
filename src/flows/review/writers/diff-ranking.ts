// The order a target diff spends its budget in.
//
// A `git diff` for a range is one string, and it used to meet its budget with a
// head slice: keep the first N characters, drop the rest. Git emits file
// sections in path order, so which files a review actually read was decided by
// the alphabet. Reviewing this repository's own six-commit range, the budget
// went entirely to `docs/` and to the two multi-megabyte compiled plugin
// bundles under `plugins/`, and the cut landed before every `src/` and `tests/`
// hunk in the diffstat. The run still returned a verdict.
//
// This splits the diff into its file sections, spends the budget on them in
// review-value order, and reassembles what fit in the diff's own order so the
// result still reads like a diff. Nothing is silently dropped: the returned
// counts and the footer say how many files the diff had, how many were read,
// and which ones were not.
//
// Ordering reuses `snapshotRank`, so a diff and a snapshot agree about what a
// review is for.

import { type SnapshotRank, snapshotRank } from './snapshot-ranking.js';

const RANK_ORDER: Readonly<Record<SnapshotRank, number>> = {
  source: 0,
  test: 1,
  config: 2,
  prose: 3,
  other: 4,
  generated: 5,
};

// How many omitted paths the footer names before it summarizes the remainder.
// Naming them is the difference between "some of the diff is missing" and a
// reader knowing whether the missing part matters, so the list is worth its
// characters. The cap keeps a thousand-file diff from spending its whole
// budget on a table of contents.
const MAX_NAMED_OMISSIONS = 40;

const SECTION_HEADER = /^diff --git /u;

export interface DiffFileSection {
  readonly path: string;
  readonly text: string;
}

export interface RankedDiffText {
  readonly text: string;
  readonly truncated: boolean;
  // How many file sections the diff had, and how many survived the budget.
  // Both are needed to state coverage: `truncated` alone says something was
  // cut without saying what a verdict does not cover.
  readonly matchedFileCount: number;
  readonly includedFileCount: number;
}

// The path a diff section is about.
//
// The `diff --git a/x b/x` header is ambiguous when a path contains a space,
// because nothing marks where the a-side ends. The `+++`/`---` lines inside the
// section carry one path each and are unambiguous, so they are preferred and
// the header is the fallback. A pure deletion has `+++ /dev/null`, which is why
// both sides are tried.
function sectionPath(section: string): string {
  const lines = section.split('\n');
  for (const line of lines) {
    if (line.startsWith('+++ b/')) return line.slice('+++ b/'.length).trim();
    if (line.startsWith('--- a/')) return line.slice('--- a/'.length).trim();
    // Both marker lines appear before the first hunk. Reading past it would
    // match added content that happens to start with `+++ `.
    if (line.startsWith('@@ ')) break;
  }
  const header = lines[0] ?? '';
  const bSide = header.indexOf(' b/');
  if (bSide !== -1) return header.slice(bSide + ' b/'.length).trim();
  return header.slice('diff --git '.length).trim();
}

/**
 * Split a unified diff into its per-file sections.
 *
 * Anything before the first `diff --git` line is preamble (a `git log -p` style
 * header, or a plain error string that reached here instead of a diff). It is
 * returned as a section with an empty path so a caller can keep it verbatim
 * rather than lose it to ranking.
 */
export function splitDiffSections(diff: string): readonly DiffFileSection[] {
  const lines = diff.split('\n');
  const starts: number[] = [];
  for (const [index, line] of lines.entries()) {
    if (SECTION_HEADER.test(line)) starts.push(index);
  }
  if (starts.length === 0) return diff.length === 0 ? [] : [{ path: '', text: diff }];
  const sections: DiffFileSection[] = [];
  const firstStart = starts[0] as number;
  if (firstStart > 0) {
    sections.push({ path: '', text: `${lines.slice(0, firstStart).join('\n')}\n` });
  }
  for (const [position, start] of starts.entries()) {
    const end = starts[position + 1] ?? lines.length;
    const text = lines.slice(start, end).join('\n');
    sections.push({ path: sectionPath(text), text });
  }
  return sections;
}

function omissionFooter(omitted: readonly string[], matched: number, included: number): string {
  const named = omitted.slice(0, MAX_NAMED_OMISSIONS);
  const rest = omitted.length - named.length;
  const list = rest > 0 ? [...named, `and ${rest} more`] : named;
  return [
    '',
    `[review coverage: this diff changes ${matched} files. Review read ${included} of them,`,
    'ordered by review value so source comes before prose and before generated output.',
    `Not inspected: ${list.join(', ')}]`,
    '',
  ].join('\n');
}

/**
 * Reduce a diff to what fits `maxChars`, spending the budget on the files a
 * review is for.
 *
 * A diff that already fits is returned verbatim, so the common case is
 * unchanged and no footer appears. Over budget, sections are taken in rank
 * order; one that does not fit the remaining budget is passed over rather than
 * ending the walk, so a small source file is not lost behind a large one. If
 * nothing fits at all the highest-ranked section is included head-sliced,
 * because returning an empty diff would be worse than returning a partial one.
 */
export function rankDiffText(
  diff: string,
  maxChars: number,
  options?: { readonly isDeclaredGenerated?: (path: string) => boolean },
): RankedDiffText {
  const sections = splitDiffSections(diff);
  const fileSections = sections.filter((section) => section.path !== '');
  if (diff.length <= maxChars) {
    return {
      text: diff,
      truncated: false,
      matchedFileCount: fileSections.length,
      includedFileCount: fileSections.length,
    };
  }
  const isDeclaredGenerated = options?.isDeclaredGenerated;
  const ordered = sections
    .map((section, index) => ({
      section,
      index,
      // Preamble sorts first and is never dropped: it is not a file, and it is
      // where a reader looks for what the diff even is.
      order:
        section.path === ''
          ? -1
          : isDeclaredGenerated?.(section.path) === true
            ? RANK_ORDER.generated
            : RANK_ORDER[snapshotRank(section.path)],
    }))
    .sort((left, right) => left.order - right.order || left.index - right.index);

  // The footer is charged against the budget before anything is selected, so
  // the coverage note cannot be the thing that pushes the result over.
  const reserve = Math.min(Math.floor(maxChars / 4), 4_000);
  let remaining = Math.max(maxChars - reserve, 0);
  const selected = new Set<number>();
  for (const entry of ordered) {
    if (entry.section.text.length > remaining) continue;
    selected.add(entry.index);
    remaining -= entry.section.text.length;
  }
  if (selected.size === 0) {
    const first = ordered[0];
    if (first === undefined) {
      return {
        text: diff.slice(0, maxChars),
        truncated: true,
        matchedFileCount: 0,
        includedFileCount: 0,
      };
    }
    const head = first.section.text.slice(0, Math.max(maxChars - reserve, 0));
    const included = first.section.path === '' ? 0 : 1;
    const omitted = fileSections
      .filter((section) => section.path !== first.section.path || included === 0)
      .map((section) => section.path);
    return {
      text: `${head}\n[truncated: first ${head.length} characters of this file's diff]${omissionFooter(
        omitted,
        fileSections.length,
        included,
      )}`,
      truncated: true,
      matchedFileCount: fileSections.length,
      includedFileCount: included,
    };
  }
  const kept = sections.filter((_, index) => selected.has(index));
  const omitted = sections
    .filter((section, index) => section.path !== '' && !selected.has(index))
    .map((section) => section.path);
  const includedFileCount = kept.filter((section) => section.path !== '').length;
  return {
    text: `${kept.map((section) => section.text).join('')}${omissionFooter(
      omitted,
      fileSections.length,
      includedFileCount,
    )}`,
    truncated: true,
    matchedFileCount: fileSections.length,
    includedFileCount,
  };
}
