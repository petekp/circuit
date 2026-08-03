import { describe, expect, it } from 'vitest';

import {
  type GroundednessResolvers,
  auditComposeGroundedness,
  classifyRef,
} from '../../evals/verdict-correctness/control-groundedness.ts';
import type { ComposeJsonShape } from '../../evals/verdict-correctness/types.ts';

// A resolver backed by explicit allow-sets, so the test fully controls which
// paths "exist" without touching the filesystem.
function resolvers(repoFiles: Set<string>, runReports: Set<string>): GroundednessResolvers {
  return {
    repoFileExists: (p) => repoFiles.has(p),
    runReportExists: (p) => runReports.has(p),
  };
}

const NONE: GroundednessResolvers = resolvers(new Set(), new Set());

function compose(refsByAspect: string[][]): ComposeJsonShape {
  return {
    verdict: 'accept',
    subject: 's',
    recommendation: 'r',
    success_condition_alignment: 'a',
    supporting_aspects: refsByAspect.map((evidence_refs, i) => ({
      aspect: `aspect-${i}`,
      contribution: 'c',
      evidence_refs,
    })),
  };
}

describe('classifyRef', () => {
  it('strips a trailing line range before resolving a repo-file ref', () => {
    const r = classifyRef(
      'src/history/query.ts:48-99',
      resolvers(new Set(['src/history/query.ts']), new Set()),
    );
    expect(r.kind).toBe('repo-file');
    expect(r.path).toBe('src/history/query.ts');
    expect(r.resolved).toBe(true);
  });

  it('marks a repo-file ref unresolved when the path is absent', () => {
    const r = classifyRef('src/gone.ts', NONE);
    expect(r.kind).toBe('repo-file');
    expect(r.resolved).toBe(false);
  });

  it('routes a reports/ path to the run-report resolver', () => {
    const r = classifyRef(
      'reports/brief.json',
      resolvers(new Set(), new Set(['reports/brief.json'])),
    );
    expect(r.kind).toBe('run-report');
    expect(r.resolved).toBe(true);
  });

  it('treats a "<sha>:path" git ref as unverifiable, never as a broken file', () => {
    const r = classifyRef('944dbd17:docs/ideas/pivot.md', NONE);
    expect(r.kind).toBe('unverifiable');
    expect(r.resolved).toBeNull();
  });

  it('treats a bare commit sha as unverifiable', () => {
    const r = classifyRef('b6e1f90f', NONE);
    expect(r.kind).toBe('unverifiable');
  });

  it('treats prose / a shell command as unverifiable', () => {
    expect(classifyRef('git log --oneline --grep=pivot', NONE).kind).toBe('unverifiable');
    expect(classifyRef('src/flows (directory listing showed router.ts)', NONE).kind).toBe(
      'unverifiable',
    );
  });
});

describe('auditComposeGroundedness', () => {
  it('dedupes refs across aspects and tallies by kind and resolution', () => {
    const c = compose([
      ['README.md:1-5', 'reports/brief.json'],
      ['README.md:1-5', 'src/gone.ts', 'git log --grep=x'],
    ]);
    const g = auditComposeGroundedness(
      c,
      resolvers(new Set(['README.md']), new Set(['reports/brief.json'])),
    );
    // README.md:1-5 appears twice but is counted once.
    expect(g.refs).toHaveLength(4);
    expect(g.counts).toEqual({
      repo_file_resolved: 1, // README.md
      repo_file_unresolved: 1, // src/gone.ts
      run_report_resolved: 1, // reports/brief.json
      run_report_unresolved: 0,
      unverifiable: 1, // the git command
    });
    expect(g.unresolved_paths).toEqual(['src/gone.ts']);
    expect(g.fully_grounded).toBe(false);
  });

  it('is fully grounded when every file-path ref resolves, ignoring unverifiable refs', () => {
    const c = compose([['README.md', 'reports/analysis.json', 'b6e1f90f']]);
    const g = auditComposeGroundedness(
      c,
      resolvers(new Set(['README.md']), new Set(['reports/analysis.json'])),
    );
    expect(g.fully_grounded).toBe(true);
    expect(g.counts.unverifiable).toBe(1);
    expect(g.unresolved_paths).toEqual([]);
  });

  it('is vacuously grounded for a compose whose only citations are unverifiable', () => {
    const g = auditComposeGroundedness(compose([['git status', 'a1b2c3d']]), NONE);
    expect(g.fully_grounded).toBe(true);
    expect(g.counts).toMatchObject({
      repo_file_resolved: 0,
      run_report_resolved: 0,
      unverifiable: 2,
    });
  });
});
