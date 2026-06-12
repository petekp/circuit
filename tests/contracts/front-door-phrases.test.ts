import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT, livingDocs } from '../../scripts/docs/doc-classes.ts';

// Front-door single-source gate, cloned from retired-vocabulary.test.ts.
//
// The per-host run table and the root-`/circuit`-alias status are front-door
// facts that the README duplicated from the operator guide and that rot
// independently — the "routing is model-only" repo-wide sweep is the cautionary
// case. Each fact now lives once, in the operator guide. This gate bans the
// duplicate phrasing from every other living doc so the next edit cannot
// silently re-fan it, and proves the phrase still exists in its home so the gate
// can never be satisfied by the fact disappearing everywhere.

type FrontDoorPhrase = {
  pattern: RegExp;
  // The single living doc that owns the phrase.
  home: string;
  description: string;
};

const FRONT_DOOR_PHRASES: FrontDoorPhrase[] = [
  {
    pattern: /^\| Host \| You type \| What happens \|/,
    home: 'docs/operator-guide.md',
    description: 'the per-host front-door run table',
  },
  {
    pattern: /root `\/circuit` alias is not shipped/,
    home: 'docs/operator-guide.md',
    description: 'the root-`/circuit`-alias status',
  },
];

describe('front-door phrases stay single-sourced', () => {
  const docs = livingDocs();

  it('scans a healthy living-doc corpus (loud on empty)', () => {
    expect(docs.length).toBeGreaterThanOrEqual(30);
  });

  it('keeps each front-door phrase in its operator-guide home only', () => {
    const violations: string[] = [];
    for (const doc of docs) {
      const lines = readFileSync(join(REPO_ROOT, doc), 'utf8').split('\n');
      for (const phrase of FRONT_DOOR_PHRASES) {
        if (doc === phrase.home) continue;
        lines.forEach((line, index) => {
          if (phrase.pattern.test(line)) {
            violations.push(
              `${doc}:${index + 1} — ${phrase.description} belongs only in ${phrase.home}`,
            );
          }
        });
      }
    }
    expect(violations).toEqual([]);
  });

  it('still finds each phrase alive in its home (single-source, not zero-source)', () => {
    for (const phrase of FRONT_DOOR_PHRASES) {
      const lines = readFileSync(join(REPO_ROOT, phrase.home), 'utf8').split('\n');
      expect(
        lines.some((line) => phrase.pattern.test(line)),
        `${phrase.description} vanished from ${phrase.home}`,
      ).toBe(true);
    }
  });

  it('anchors every phrase home inside the living-doc corpus', () => {
    const living = new Set(docs);
    for (const phrase of FRONT_DOOR_PHRASES) {
      expect(living.has(phrase.home), `${phrase.home} is not a living doc`).toBe(true);
    }
  });
});

describe('front-door phrase calibration (false-positive net)', () => {
  // Known-legitimate strings that must never match a front-door pattern.
  const legitimate = [
    'Use the `/circuit` command to start a run.',
    '| Host | You type | What runs |',
    'The host adapter prefers a normal coding command rather than a root `/circuit` alias.',
    'A flow name is always required on the CLI.',
  ];

  it('never matches known-legitimate strings', () => {
    for (const phrase of FRONT_DOOR_PHRASES) {
      for (const sample of legitimate) {
        expect(phrase.pattern.test(sample), `${phrase.pattern} must not match: "${sample}"`).toBe(
          false,
        );
      }
    }
  });
});
