#!/usr/bin/env node
// Path-existence gate for living docs. Extracts repo-path-looking tokens
// and relative markdown links from every class=living doc in
// docs/doc-classes.json and asserts each referenced path exists on disk.
//
// Skip rules (calibrated on the 2026-06 pristine sweep):
// - tokens containing placeholder characters (* < > { } $) are templates;
// - tokens immediately followed by a placeholder opener continue into a
//   template (for example `results/<timestamp>`), so the doc is not
//   claiming the literal prefix path exists;
// - tokens immediately followed by a backslash sit inside an escaped
//   regex (for example an `rg "docs/foo\.md"` reference probe), not a
//   literal path claim;
// - a token also passes when it resolves relative to the doc directory,
//   so package READMEs may name their own files package-relatively;
// - a line containing `<!-- path-ok -->` is skipped entirely, and a
//   region between `<!-- path-ok:begin -->` and `<!-- path-ok:end -->`
//   is skipped wholesale — the escape hatches for genuinely
//   illustrative paths and embedded historical records.
//
// Loud-on-empty: the gate fails when extraction yields fewer than
// MIN_REFS refs across all living docs, so a broken regex or an emptied
// manifest cannot pass silently.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { REPO_ROOT, livingDocs } from './doc-classes.ts';

const PATH_TOKEN =
  /(?:^|[\s`("'[])((?:src|docs|tests|scripts|plugins|bin|evals|templates|hosts)\/[A-Za-z0-9_@./-]+)/g;
const TRAILING_PUNCTUATION = /[).,:;'"`\]]+$/;
const PLACEHOLDER = /[*<>{}$]/;
const TAIL_CONTINUATION = /[*<>{}$\\]/;
const MARKDOWN_LINK = /\]\((?!https?:|mailto:|#)([^)\s]+)\)/g;
const PATH_OK_MARKER = '<!-- path-ok -->';
const PATH_OK_BEGIN = '<!-- path-ok:begin';
const PATH_OK_END = '<!-- path-ok:end';
const MIN_REFS = 50;

type Violation = {
  doc: string;
  line: number;
  ref: string;
};

function main() {
  const docs = livingDocs();
  const violations: Violation[] = [];
  let refsChecked = 0;

  for (const doc of docs) {
    const lines = readFileSync(join(REPO_ROOT, doc), 'utf8').split('\n');
    let insidePathOkBlock = false;
    lines.forEach((line, index) => {
      if (line.includes(PATH_OK_BEGIN)) {
        if (insidePathOkBlock) {
          throw new Error(`${doc}:${index + 1} — nested ${PATH_OK_BEGIN} --> marker`);
        }
        insidePathOkBlock = true;
        return;
      }
      if (line.includes(PATH_OK_END)) {
        if (!insidePathOkBlock) {
          throw new Error(`${doc}:${index + 1} — ${PATH_OK_END} --> marker without a begin`);
        }
        insidePathOkBlock = false;
        return;
      }
      if (insidePathOkBlock) return;
      if (line.includes(PATH_OK_MARKER)) return;
      const seen = new Set<string>();

      for (const match of line.matchAll(PATH_TOKEN)) {
        const token = match[1];
        if (token === undefined) continue;
        if (PLACEHOLDER.test(token)) continue;
        const tail = line.charAt((match.index ?? 0) + match[0].length);
        if (tail !== '' && TAIL_CONTINUATION.test(tail)) continue;

        let ref = token.replace(TRAILING_PUNCTUATION, '');
        if (ref.endsWith('/')) ref = ref.slice(0, -1);
        if (ref === '' || seen.has(ref)) continue;
        seen.add(ref);

        refsChecked += 1;
        const existsFromRoot = existsSync(join(REPO_ROOT, ref));
        const existsFromDoc = existsSync(resolve(REPO_ROOT, dirname(doc), ref));
        if (!existsFromRoot && !existsFromDoc) {
          violations.push({ doc, line: index + 1, ref });
        }
      }

      for (const match of line.matchAll(MARKDOWN_LINK)) {
        const target = match[1];
        if (target === undefined) continue;
        const withoutFragment = target.split('#')[0] ?? '';
        if (withoutFragment === '' || withoutFragment.startsWith('/')) continue;
        if (PLACEHOLDER.test(withoutFragment)) continue;
        const key = `link:${withoutFragment}`;
        if (seen.has(key)) continue;
        seen.add(key);

        refsChecked += 1;
        const resolved = resolve(REPO_ROOT, dirname(doc), withoutFragment);
        if (!existsSync(resolved)) {
          violations.push({ doc, line: index + 1, ref: withoutFragment });
        }
      }
    });

    if (insidePathOkBlock) {
      throw new Error(`${doc} — unterminated ${PATH_OK_BEGIN} --> marker`);
    }
  }

  if (violations.length > 0) {
    for (const violation of violations) {
      process.stderr.write(
        `- ${violation.doc}:${violation.line} — referenced path does not exist: ${violation.ref}\n`,
      );
    }
    process.stderr.write(`\ncheck-doc-paths failed with ${violations.length} issue(s)\n`);
    process.exit(1);
  }

  if (refsChecked < MIN_REFS) {
    process.stderr.write(
      `check-doc-paths extracted only ${refsChecked} path refs across ${docs.length} living docs (minimum ${MIN_REFS}) — extraction looks broken\n`,
    );
    process.exit(1);
  }

  process.stdout.write(
    `Doc paths OK: ${refsChecked} refs checked across ${docs.length} living docs\n`,
  );
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`check-doc-paths failed: ${message}\n`);
  process.exit(1);
}
