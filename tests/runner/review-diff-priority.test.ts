// What a review of a commit range actually reads.
//
// The range diff is one string, and it used to meet its budget with a head
// slice. Git emits file sections in path order, so the slice decided the
// review's subject by the alphabet. Reviewing this repository's own six
// hardening commits, the budget went to `docs/` and to the two compiled plugin
// bundles under `plugins/`, and the cut landed before every `src/` and
// `tests/` hunk in the diffstat. The run reported a verdict anyway, and only
// said so because the relay noticed on its own.
//
// Same remedy as the snapshot path: rank the file sections, spend the budget in
// that order, and say what was left out. These run it through the real intake
// writer against a real repository, because the budget is spent there.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { ComposeBuildContext } from '../../src/flows/registries/compose-writers/types.js';
import { ReviewIntake } from '../../src/flows/review/reports.js';
import { reviewIntakeComposeBuilder } from '../../src/flows/review/writers/intake.js';
import { reviewRunFolderBase, useReviewRunFolders } from './review-wiring-harness.js';

// Comfortably past the 120k diff budget on its own, so the source hunks after
// it are unreachable by any head slice.
const BUNDLE_LINE_COUNT = 4_000;

function bundleBody(marker: string): string {
  return `${Array.from(
    { length: BUNDLE_LINE_COUNT },
    (_, index) => `var __chunk${index} = ${JSON.stringify(`${marker}-${index}`)};`,
  ).join('\n')}\n`;
}

function commitRangeRepo(
  label: string,
  options: { readonly declareBundleGenerated: boolean },
): string {
  const projectRoot = join(reviewRunFolderBase(), label);
  mkdirSync(projectRoot, { recursive: true });
  execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], {
    cwd: projectRoot,
    stdio: 'pipe',
  });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: projectRoot, stdio: 'pipe' });

  const write = (path: string, body: string): void => {
    const absolute = join(projectRoot, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, body);
  };
  const commit = (message: string): void => {
    execFileSync('git', ['add', '-A'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', message], { cwd: projectRoot, stdio: 'pipe' });
  };

  if (options.declareBundleGenerated) {
    // Exactly the shape this repository uses: a compiled bundle at a path with
    // no generated-looking segment and a plain `.js` extension, declared in
    // `.gitattributes` so GitHub collapses it in a diff.
    write('.gitattributes', 'plugins/host/runtime/circuit.js linguist-generated=true\n');
  }
  write('docs/aaa-guide.md', '# Guide\n\nBefore.\n');
  write('plugins/host/runtime/circuit.js', bundleBody('BEFORE'));
  write('src/auth/login.ts', "export const login = () => 'before';\n");
  write('src/auth/session.ts', "export const session = () => 'before';\n");
  commit('baseline');

  write('docs/aaa-guide.md', '# Guide\n\nMARKER-PROSE-CHANGED.\n');
  write('plugins/host/runtime/circuit.js', bundleBody('MARKER-BUNDLE-CHANGED'));
  write('src/auth/login.ts', "export const login = () => 'MARKER-SOURCE-LOGIN';\n");
  write('src/auth/session.ts', "export const session = () => 'MARKER-SOURCE-SESSION';\n");
  commit('the change under review');

  return projectRoot;
}

async function rangeIntake(projectRoot: string): Promise<ReviewIntake> {
  const context = {
    goal: 'review the last commit',
    target: 'HEAD~1...HEAD',
    projectRoot,
    inputs: {},
  } as unknown as ComposeBuildContext;
  return ReviewIntake.parse(await reviewIntakeComposeBuilder.build(context));
}

function targetDiff(intake: ReviewIntake) {
  const evidence = intake.evidence;
  if (evidence.kind !== 'git-target') {
    throw new Error(`expected a git target, got ${evidence.kind}`);
  }
  return evidence.target_diff;
}

describe('a range review spends its diff budget on source first', () => {
  useReviewRunFolders();

  it('reads the source hunks even when an earlier file overflows the budget', async () => {
    const projectRoot = commitRangeRepo('diff-priority-source', {
      declareBundleGenerated: true,
    });
    const diff = targetDiff(await rangeIntake(projectRoot));

    expect(diff.text).toContain('MARKER-SOURCE-LOGIN');
    expect(diff.text).toContain('MARKER-SOURCE-SESSION');
    expect(diff.truncated).toBe(true);
  });

  it('leaves the declared-generated bundle out rather than the code', async () => {
    const projectRoot = commitRangeRepo('diff-priority-generated', {
      declareBundleGenerated: true,
    });
    const diff = targetDiff(await rangeIntake(projectRoot));

    expect(diff.text).not.toContain('MARKER-BUNDLE-CHANGED');
    expect(diff.text).toContain('Not inspected: plugins/host/runtime/circuit.js');
  });

  // The bundle is not declared here, so it ranks as source by extension. It is
  // still passed over, because a section larger than the whole budget can never
  // fit, and passing over it is what lets the small files through.
  it('passes over a section too large for the budget even when it ranks high', async () => {
    const projectRoot = commitRangeRepo('diff-priority-undeclared', {
      declareBundleGenerated: false,
    });
    const diff = targetDiff(await rangeIntake(projectRoot));

    expect(diff.text).toContain('MARKER-SOURCE-LOGIN');
    expect(diff.text).not.toContain('MARKER-BUNDLE-CHANGED');
  });

  it('counts what the diff changed against what it read', async () => {
    const projectRoot = commitRangeRepo('diff-priority-counts', {
      declareBundleGenerated: true,
    });
    const diff = targetDiff(await rangeIntake(projectRoot));

    expect(diff.matched_file_count).toBe(4);
    expect(diff.included_file_count).toBe(3);
  });

  it('says in the warning how many files it did not inspect', async () => {
    const projectRoot = commitRangeRepo('diff-priority-warning', {
      declareBundleGenerated: true,
    });
    const intake = await rangeIntake(projectRoot);

    const truncated = intake.evidence_warnings.find((warning) => warning.kind === 'diff_truncated');
    expect(truncated?.message).toContain('changes 4 files');
    expect(truncated?.message).toContain('read 3 of them');
    // A reader who sees source and no bundle must be able to tell the selection
    // was ranked, not that the range left the bundle alone.
    expect(truncated?.message).toMatch(/review value/u);
  });

  it('leaves a diff that fits the budget exactly as Git wrote it', async () => {
    const projectRoot = join(reviewRunFolderBase(), 'diff-priority-small');
    mkdirSync(projectRoot, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: projectRoot,
      stdio: 'pipe',
    });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'a.ts'), 'export const a = 1;\n');
    execFileSync('git', ['add', '-A'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'one'], { cwd: projectRoot, stdio: 'pipe' });
    writeFileSync(join(projectRoot, 'a.ts'), 'export const a = 2;\n');
    execFileSync('git', ['add', '-A'], { cwd: projectRoot, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'two'], { cwd: projectRoot, stdio: 'pipe' });

    const diff = targetDiff(await rangeIntake(projectRoot));
    expect(diff.truncated).toBe(false);
    expect(diff.text).not.toContain('review coverage');
    expect(diff.text).toContain('+export const a = 2;');
  });
});
