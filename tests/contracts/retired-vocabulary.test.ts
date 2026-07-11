import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT, livingDocs } from '../../scripts/docs/doc-classes.ts';

// The rename backstop. Scope is every class=living doc in
// docs/doc-classes.json — which includes .claude/skills/** — so retired
// product vocabulary cannot quietly survive a terminology migration.
//
// Process rule: every vocabulary-rename PR appends exactly one row here
// naming the migration it retires. That is the entire migration tax — no
// scope lists to update, no per-doc sweeps. Rows are context-restricted:
// bare English use of a word ("a deep dive", "standard practice",
// "rigorous review") must never match; only the retired vocabulary in
// flag, key, or value positions is banned.
type RetiredToken = {
  pattern: RegExp;
  replacement: string;
  // A heading in UBIQUITOUS_LANGUAGE.md that anchors the row to the
  // canonical glossary, so registry and glossary cannot drift apart.
  ulHeading: string;
  // The migration that retired the token.
  addedBy: string;
  // Living docs allowed to name the retired token (retired-terms
  // documentation, rejected-flag probes).
  allow?: string[];
};

const RETIRED_TOKENS: RetiredToken[] = [
  // Depth rename (PR #56): the `--rigor` CLI flag became `--depth`.
  {
    pattern: /--rigor\b/,
    replacement: '--process',
    ulHeading: 'Configuration Language',
    addedBy: 'depth rename (PR #56)',
    allow: [
      // The glossary documents the retirement itself.
      'UBIQUITOUS_LANGUAGE.md',
      // The surface-test skill deliberately documents `--rigor` as a
      // rejected flag and probes that the CLI still refuses it
      // (rejection is test-locked at tests/runner/cli-router.test.ts).
      '.claude/skills/circuit-surface-test/SKILL.md',
      '.claude/skills/circuit-surface-test/references/current-surface-inventory.md',
      '.claude/skills/circuit-surface-test/assets/report-template.md',
    ],
  },
  // Process rename (dial combination, 2026-07-10): the `--depth` CLI flag
  // became `--process`. Scoped to the flag position only — the internal
  // engine identifiers (`axes.depth`, `SelectionOverride.depth`,
  // `ResolvedSelection.depth`, `CompiledDepth`, `allowed_depths`) keep the
  // `depth` name by design (see docs/contracts/selection.md) and must not
  // false-match, so this pattern never matches the bare word `depth`.
  {
    pattern: /--depth\b/,
    replacement: '--process',
    ulHeading: 'Core Flow Language',
    addedBy: 'process rename (dial combination, 2026-07-10)',
    allow: [
      // The glossary documents the retirement itself.
      'UBIQUITOUS_LANGUAGE.md',
      // The decision sheet and punch list describe the retirement as a
      // historical/planning record naming the old flag by design.
      'docs/release/dial-and-inbox-decision-sheet.md',
      'docs/release/pre-release-punch-list.md',
      // The surface-test skill deliberately documents `--depth` as a
      // rejected flag and probes that the CLI still refuses it
      // (rejection is test-locked at tests/runner/cli-router.test.ts).
      '.claude/skills/circuit-surface-test/references/current-surface-inventory.md',
      '.claude/skills/circuit-surface-test/assets/report-template.md',
    ],
  },
  // Depth rename (PR #56): backticked or key-position `rigor` became `depth`.
  {
    pattern: /`rigor`|\brigor\s*[:=]/,
    replacement: '`depth`',
    ulHeading: 'Configuration Language',
    addedBy: 'depth rename (PR #56)',
    allow: ['UBIQUITOUS_LANGUAGE.md'],
  },
  // Depth value rename (PR #56): lite|standard|deep became low|medium|high.
  // Restricted to value positions directly after a depth key or flag so
  // plain prose ("deep dive", "standard practice") never matches.
  {
    pattern: /(?:\ballowed_depths|--depth|\bdepth\s*[:=])[\s[('"`,=:]*\b(?:lite|standard|deep)\b/,
    replacement: 'low|medium|high',
    ulHeading: 'Configuration Language',
    addedBy: 'depth rename (PR #56)',
  },
  // Depth value rename (PR #56): the pipe-joined value list itself.
  {
    pattern: /\blite\|standard\|deep\b/,
    replacement: 'low|medium|high',
    ulHeading: 'Configuration Language',
    addedBy: 'depth rename (PR #56)',
  },
  // Run-status contract (run-status-v1): the engine_state value is
  // `waiting_checkpoint` (src/schemas/run-status.ts). `checkpoint_waiting`
  // is NOT retired wholesale — it survives as the attempt outcome and
  // status reason — so only the engine_state position is banned.
  {
    pattern: /engine_state[^\n]{0,30}\bcheckpoint_waiting\b/,
    replacement: 'waiting_checkpoint',
    ulHeading: 'Runtime Language',
    addedBy: 'run-status engine_state contract (run-status-v1)',
  },
  // Compiled-flow loader rename: the production loader src/cli/flow-fixtures.ts
  // (resolveFixturePath / loadFixture / fixtureSelectionNameForAxes) became
  // src/cli/compiled-flow-loading.ts because it loads the product-facing
  // generated flow, not a test input. "Fixture" stays valid for test inputs and
  // the `--fixture` override flag, so only the retired module path and its two
  // uniquely-named exports are banned in docs (the bare `loadFixture` name is a
  // common test-helper and is intentionally not matched).
  {
    pattern: /\bflow-fixtures(?:\.[jt]s)?\b|\bresolveFixturePath\b|\bfixtureSelectionNameForAxes\b/,
    replacement:
      'src/cli/compiled-flow-loading.ts (resolveCompiledFlowPath / compiledFlowSelectionNameForAxes / loadCompiledFlow)',
    ulHeading: 'Flagged Ambiguities',
    addedBy: 'compiled-flow loader rename (fixture → compiled flow)',
  },
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('retired vocabulary stays out of living docs', () => {
  const docs = livingDocs();
  const ulText = readFileSync(join(REPO_ROOT, 'UBIQUITOUS_LANGUAGE.md'), 'utf8');

  it('scans a healthy living-doc corpus (loud on empty)', () => {
    expect(docs.length).toBeGreaterThanOrEqual(30);
  });

  it('anchors every registry row to a UBIQUITOUS_LANGUAGE.md heading', () => {
    for (const row of RETIRED_TOKENS) {
      const heading = new RegExp(`^#{1,4}\\s+.*${escapeRegExp(row.ulHeading)}`, 'm');
      expect(
        heading.test(ulText),
        `UBIQUITOUS_LANGUAGE.md has no heading matching "${row.ulHeading}" (row ${row.pattern})`,
      ).toBe(true);
    }
  });

  it('keeps allow-listed paths inside the living-doc corpus', () => {
    const living = new Set(docs);
    for (const row of RETIRED_TOKENS) {
      for (const allowed of row.allow ?? []) {
        expect(
          living.has(allowed),
          `${allowed} in allow list of ${row.pattern} is not a living doc`,
        ).toBe(true);
      }
    }
  });

  it('finds no retired tokens in living docs', () => {
    const violations: string[] = [];
    for (const doc of docs) {
      const lines = readFileSync(join(REPO_ROOT, doc), 'utf8').split('\n');
      for (const row of RETIRED_TOKENS) {
        if (row.allow?.includes(doc)) continue;
        lines.forEach((line, index) => {
          const match = line.match(row.pattern);
          if (match !== null) {
            violations.push(
              `${doc}:${index + 1} — retired token "${match[0]}" → use ${row.replacement} ` +
                `(UBIQUITOUS_LANGUAGE.md › ${row.ulHeading}; ${row.addedBy})`,
            );
          }
        });
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('retired-vocabulary calibration (false-positive regression net)', () => {
  // Known-legitimate strings verified during the 2026-06 pristine sweep
  // (.sweep/rejected.json). Future registry edits must keep these clean.
  const legitimate = [
    // Test-locked typo fixture: docs/contracts/config.md and
    // tests/contracts/config-schema.test.ts:353 deliberately use `rigr`.
    'a typo inside `SelectionOverride` (e.g. `defaults.selection.rigr`) is rejected',
    'a deep dive into the relay runtime',
    'standard practice for flow authors',
    'a rigorous review pass before merge',
    // Current vocabulary: checkpoint_waiting is the live attempt outcome
    // and status reason; only the engine_state position retired it.
    'the run closed with outcome `checkpoint_waiting` and checkpoint metadata',
    // English words within reach of a depth key must not match.
    'depth: medium routes the standard fix flow',
    // Internal engine identifiers keep the `depth` name by design and must
    // not false-match the `--depth` flag retirement.
    'axes.depth stays medium; SelectionOverride.depth, ResolvedSelection.depth, ' +
      'CompiledDepth, and allowed_depths are unaffected by the flag rename',
  ];

  it('never matches known-legitimate strings', () => {
    for (const row of RETIRED_TOKENS) {
      for (const sample of legitimate) {
        expect(row.pattern.test(sample), `${row.pattern} must not match: "${sample}"`).toBe(false);
      }
    }
  });

  it('still matches canonical retired usage', () => {
    // One canonical bad example per registry row, keyed by row index so a
    // registry edit that silently disarms a pattern fails here.
    const positives: Array<[number, string]> = [
      [0, 'run with `--rigor high` for a stricter pass'],
      [1, 'run with --depth high for extra care'],
      [2, 'set `rigor` in the project config'],
      [2, 'rigor: high'],
      [3, 'allowed_depths: [lite, standard, deep]'],
      [3, 'pass --depth lite for the quick loop'],
      [4, 'the dial accepts lite|standard|deep'],
      [5, 'engine_state: "checkpoint_waiting"'],
      [6, 'see resolveFixturePath in src/cli/flow-fixtures.ts'],
    ];
    const coveredRows = new Set(positives.map(([index]) => index));
    expect([...coveredRows].sort((a, b) => a - b)).toEqual(RETIRED_TOKENS.map((_, index) => index));

    for (const [index, sample] of positives) {
      const row = RETIRED_TOKENS[index];
      expect(row, `no RETIRED_TOKENS row at index ${index}`).toBeDefined();
      if (row === undefined) continue;
      expect(row.pattern.test(sample), `${row.pattern} should match: "${sample}"`).toBe(true);
    }
  });
});
