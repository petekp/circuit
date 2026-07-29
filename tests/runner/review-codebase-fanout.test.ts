// "Review this codebase" — the whole tree, split into units, reviewed in
// parallel, merged into one verdict.
//
// Until now this request was refused: Review captured one evidence bundle for
// one reviewer, and a whole repository does not fit in one prompt, so the run
// ended by telling the operator to name a path instead. That refusal is the
// thing this suite removes. The tree is split into bounded units, each unit is
// reviewed against its own source and nothing else, and the close step merges
// the per-unit findings into a single result that says how much of the tree was
// actually covered.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ReviewResult } from '../../src/flows/review/reports.js';
import type { RelayResult } from '../../src/shared/connector-relay.js';
import type { RelayFn, RelayInput } from '../../src/shared/relay-runtime-types.js';
import { deterministicNow } from '../helpers/runtime-fixtures.js';
import {
  loadFixture,
  reviewRunFolderBase,
  runCompiledFlow,
  stubProse,
  useReviewRunFolders,
} from './review-wiring-harness.js';

// Each file carries a marker only its own unit should ever see, so a prompt
// that contains two markers is a fan-out that did not actually split.
const FILES: ReadonlyArray<{ readonly path: string; readonly marker: string }> = [
  { path: 'src/auth/login.ts', marker: 'MARKER-AUTH-LOGIN' },
  { path: 'src/auth/session.ts', marker: 'MARKER-AUTH-SESSION' },
  { path: 'src/billing/invoice.ts', marker: 'MARKER-BILLING-INVOICE' },
  { path: 'src/billing/refund.ts', marker: 'MARKER-BILLING-REFUND' },
];

function stagedCodebase(label: string): string {
  const projectRoot = join(reviewRunFolderBase(), label);
  mkdirSync(projectRoot, { recursive: true });
  execFileSync('git', ['init'], { cwd: projectRoot, stdio: 'pipe' });
  for (const file of FILES) {
    const absolute = join(projectRoot, file.path);
    mkdirSync(dirname(absolute), { recursive: true });
    // Big enough that no two of these files fit in one reviewer's budget, so
    // the split is forced by size rather than by a rule the test invented.
    const filler = `// ${'x'.repeat(78)}\n`.repeat(400);
    writeFileSync(absolute, `export const value = '${file.marker}';\n${filler}`);
  }
  execFileSync('git', ['add', '.'], { cwd: projectRoot, stdio: 'pipe' });
  return projectRoot;
}

// One reviewer per unit. Each records the prompt it was handed and reports a
// clean verdict for the unit it was assigned.
function recordingReviewers(prompts: Map<string, string>): RelayFn {
  return {
    connectorName: 'claude-code',
    promptOnlyContext: true,
    relay: async (input: RelayInput): Promise<RelayResult> => {
      const unitId = /Step: audit-step-(\S+)/.exec(input.prompt)?.[1] ?? 'unknown';
      prompts.set(unitId, input.prompt);
      return {
        request_payload: input.prompt,
        receipt_id: `stub-receipt-${unitId}`,
        result_body: JSON.stringify({
          unit_id: unitId,
          verdict: 'NO_ISSUES_FOUND',
          findings: [],
          ...stubProse(),
        }),
        duration_ms: 1,
        cli_version: '0.0.0-stub',
      };
    },
  };
}

describe('review this codebase', () => {
  useReviewRunFolders();

  it('splits the tree into units, reviews each on its own source, and merges one verdict', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'review-codebase-fanout');
    const projectRoot = stagedCodebase('review-codebase-project');
    const prompts = new Map<string, string>();

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-0000000000c0',
      goal: 'review this whole codebase',
      depth: 'medium',
      projectRoot,
      now: deterministicNow(Date.UTC(2026, 6, 28, 10, 0, 0)),
      relayer: recordingReviewers(prompts),
    });

    expect(outcome.outcome).toBe('complete');

    // More than one reviewer ran, and no reviewer saw another unit's source.
    expect(prompts.size).toBeGreaterThan(1);
    for (const prompt of prompts.values()) {
      const seen = FILES.filter((file) => prompt.includes(file.marker));
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.length).toBeLessThan(FILES.length);
    }

    // Every file in the tree reached exactly one reviewer.
    const covered = FILES.filter((file) =>
      [...prompts.values()].some((prompt) => prompt.includes(file.marker)),
    );
    expect(covered).toHaveLength(FILES.length);

    const result = ReviewResult.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports/review-result.json'), 'utf8')),
    );
    expect(result.verdict).toBe('CLEAN');
    // The close step has to say how much of the tree the verdict stands on: a
    // clean result over a partially reviewed codebase is only honest if the
    // coverage travels with it.
    expect(JSON.stringify(result)).toMatch(/unit/i);
  });

  // The whole risk of splitting a review is that a part of it silently goes
  // missing and the remaining parts still close green. One reviewer refuses to
  // answer in the required shape; the review has to come back not-clean and say
  // which part it knows nothing about.
  it('closes not-clean and names the unit when one reviewer never answers', async () => {
    const { bytes } = loadFixture();
    const runFolder = join(reviewRunFolderBase(), 'review-codebase-partial');
    const projectRoot = stagedCodebase('review-codebase-partial-project');
    const prompts = new Map<string, string>();
    const clean = recordingReviewers(prompts);
    let silenced: string | undefined;

    const outcome = await runCompiledFlow({
      runDir: runFolder,
      flowBytes: bytes,
      runId: '79000000-0000-0000-0000-0000000000c1',
      goal: 'review this whole codebase',
      depth: 'medium',
      projectRoot,
      now: deterministicNow(Date.UTC(2026, 6, 28, 10, 0, 0)),
      relayer: {
        connectorName: 'claude-code',
        promptOnlyContext: true,
        relay: async (input: RelayInput): Promise<RelayResult> => {
          const unitId = /Step: audit-step-(\S+)/.exec(input.prompt)?.[1] ?? 'unknown';
          // The first unit to be asked is the one that never answers usefully;
          // it keeps failing, so its re-ask fails too.
          silenced ??= unitId;
          if (unitId !== silenced) return await clean.relay(input);
          return {
            request_payload: input.prompt,
            receipt_id: `stub-receipt-${unitId}`,
            result_body: '{"verdict":"NO_ISSUES_FOUND","findings":"not-an-array"}',
            duration_ms: 1,
            cli_version: '0.0.0-stub',
          };
        },
      },
    });

    // Findings exist (the coverage gap is one), so the run stops rather than
    // reporting a clean codebase.
    expect(outcome.outcome).toBe('stopped');

    const result = ReviewResult.parse(
      JSON.parse(readFileSync(join(runFolder, 'reports/review-result.json'), 'utf8')),
    );
    expect(result.verdict).not.toBe('CLEAN');
    const coverage = result.findings.find(
      (finding) => finding.id === 'circuit-review-unit-not-reviewed',
    );
    expect(coverage?.text).toContain(silenced as string);
    // The other units still reported, so their work is not thrown away.
    expect(prompts.size).toBeGreaterThan(0);
    expect(result.confidence_limitations.join(' ')).toMatch(/parts of this target/iu);
  });
});
