// Coverage gate for the design-system @source globs.
//
// theme.css compiles Tailwind against an explicit, narrow @source set. The
// flow-facing glob is scoped to the projector convention
// (src/flows/<id>/writers/<name>-html.tsx) so Tailwind's content-agnostic
// extractor never reads utility-shaped words out of flow logic or contract
// prose and bakes them in as dead CSS.
//
// That narrowing has one failure mode, and this test closes it: if a future
// flow emits Tailwind classes from a file OUTSIDE the glob, those classes are
// silently dropped from css.generated.ts and the shipped operator-summary page
// renders unstyled. The drift gate cannot catch it — a fresh compile of a file
// the scanner never sees is, correctly from its view, empty, so committed and
// regenerated still match. This test fails loudly at authoring time instead and
// points the author back at theme.css.

import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(__dirname, '../..');
const themePath = resolve(projectRoot, 'src/shared/html/ui/theme.css');
const flowsRoot = resolve(projectRoot, 'src/flows');

// A file emits Tailwind classes if it carries a literal class attribute:
// `className=` (JSX projectors) or `class="` / `class='` (any HTML-string
// writer). A file with no literal class token contributes nothing to scan —
// its rendered classes come from the shared components it composes, which
// theme.css already covers via `@source '../'`.
const CLASS_EMISSION = /className=|class=["']/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

// Convert a simple glob (** across path segments, * within one segment) to an
// anchored RegExp over POSIX-style repo-relative paths.
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === undefined) continue;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:[^/]+/)*';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if ('.+^${}()|[]\\/'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

// Positive @source globs from theme.css that resolve under src/flows, as
// repo-relative POSIX paths. Negated (`@source not ...`) and inline
// (`@source inline(...)`) sources have their keyword before the quote, so the
// quote no longer immediately follows `@source` and this pattern skips them.
function flowSourceGlobs(): string[] {
  const css = readFileSync(themePath, 'utf8');
  const themeDir = resolve(projectRoot, 'src/shared/html/ui');
  const globs: string[] = [];
  for (const m of css.matchAll(/@source\s+'([^']+)'/g)) {
    const raw = m[1];
    if (raw === undefined) continue;
    const rel = relative(projectRoot, resolve(themeDir, raw)).split('\\').join('/');
    if (rel === 'src/flows' || rel.startsWith('src/flows/')) globs.push(rel);
  }
  return globs;
}

describe('design-system @source coverage', () => {
  const globs = flowSourceGlobs();

  it('scopes the flows @source to the projector convention, not the whole tree', () => {
    expect(globs.length, 'expected a flows-directed @source in theme.css').toBeGreaterThan(0);
    // A bare directory (no glob metacharacter) re-scans all of src/flows and
    // reintroduces the logic/prose false positives this narrowing removed.
    for (const glob of globs) {
      expect(glob, `flows @source '${glob}' must be scoped to files, not the whole tree`).toMatch(
        /\*/,
      );
    }
  });

  it('covers every class-emitting flow file', () => {
    const matchers = globs.map(globToRegExp);
    const emitters = walk(flowsRoot)
      .filter((abs) => CLASS_EMISSION.test(readFileSync(abs, 'utf8')))
      .map((abs) => relative(projectRoot, abs).split('\\').join('/'));

    expect(emitters.length, 'expected at least one projector to be detected').toBeGreaterThan(0);

    const uncovered = emitters.filter((rel) => !matchers.some((re) => re.test(rel)));
    expect(
      uncovered,
      `these flow files emit Tailwind classes but sit outside the theme.css @source globs, so their classes are dropped from css.generated.ts and the page ships unstyled. Move them under the projector convention (src/flows/<id>/writers/<name>-html.tsx) or widen the @source glob in src/shared/html/ui/theme.css:\n${uncovered.join('\n')}`,
    ).toEqual([]);
  });
});
