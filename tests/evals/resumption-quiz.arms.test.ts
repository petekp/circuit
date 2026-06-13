// Builder 2 (arms): deterministic seams of build-arm-materials.ts, driven by
// the synthetic fixture transcript. Never touches real session data and never
// spawns a model.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildArmMaterials,
  extractCompactionSummary,
  parseBuildArmsArgs,
  renderTranscriptText,
  stubBriefProbeFrom,
} from '../../evals/resumption-quiz/build-arm-materials.ts';
import {
  ARM_IDS,
  ORDERING_ERRORS,
  armMaterialPath,
  armMetaPath,
  type ArmMeta,
  type ResumptionManifest,
} from '../../evals/resumption-quiz/shared/types.ts';
import { summaryForRecord } from '../../src/app/continuity/records.ts';
import { ContinuityRecord } from '../../src/schemas/continuity.ts';
import {
  cleanupBundleFixtures,
  FIXTURE_CONTINUITY,
  FIXTURE_TRANSCRIPT,
  makeBundle,
  MANIFEST,
  MANUAL_RECORD_STEM,
} from './resumption-quiz.bundle-fixture.ts';

afterEach(() => {
  cleanupBundleFixtures();
});

function buildAll(bundleDir: string, manifest: ResumptionManifest = MANIFEST): ArmMeta[] {
  return buildArmMaterials({ bundleDir, arms: [...ARM_IDS], dryRun: false }, manifest);
}

function readMeta(bundleDir: string, arm: (typeof ARM_IDS)[number]): ArmMeta {
  return JSON.parse(readFileSync(armMetaPath(bundleDir, arm), 'utf8')) as ArmMeta;
}

function readMaterial(bundleDir: string, arm: (typeof ARM_IDS)[number]): string {
  return readFileSync(armMaterialPath(bundleDir, arm), 'utf8');
}

describe('parseBuildArmsArgs', () => {
  it('requires --bundle', () => {
    expect(() => parseBuildArmsArgs([])).toThrow('--bundle is required');
  });

  it('parses csv arms into stable ARM_IDS order and rejects unknown ids', () => {
    const args = parseBuildArmsArgs(['--bundle', '/tmp/x', '--arms', 'A4,A0,A2']);
    expect(args.arms).toEqual(['A0', 'A2', 'A4']);
    expect(() => parseBuildArmsArgs(['--bundle', '/tmp/x', '--arms', 'A9'])).toThrow(
      'unknown arm id: A9',
    );
  });
});

describe('ordering enforcement', () => {
  it('refuses with the exact quiz_missing message when quiz/quiz.json is absent', () => {
    const bundleDir = makeBundle({ withQuiz: false });
    let message = '';
    try {
      buildAll(bundleDir);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(ORDERING_ERRORS.quiz_missing);
  });

  it('refuses with the exact source_sha_mismatch message when the quiz hash disagrees', () => {
    const bundleDir = makeBundle({ quizSha: 'mismatch' });
    let message = '';
    try {
      buildAll(bundleDir);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(ORDERING_ERRORS.source_sha_mismatch);
  });

  it('dry run validates ordering but writes nothing', () => {
    const bundleDir = makeBundle();
    const metas = buildArmMaterials({ bundleDir, arms: [...ARM_IDS], dryRun: true }, MANIFEST);
    expect(metas).toEqual([]);
    expect(existsSync(join(bundleDir, 'arms'))).toBe(false);
  });
});

describe('A0 nothing and A5 grep', () => {
  it('A0 writes empty material; A5 writes no material and records the transcript path', () => {
    const bundleDir = makeBundle();
    buildAll(bundleDir);

    expect(readMaterial(bundleDir, 'A0')).toBe('');
    expect(readMeta(bundleDir, 'A0')).toEqual({
      schema_version: 1,
      arm: 'A0',
      available: true,
      material_chars: 0,
    });

    expect(existsSync(armMaterialPath(bundleDir, 'A5'))).toBe(false);
    const a5 = readMeta(bundleDir, 'A5');
    expect(a5.available).toBe(true);
    if (a5.available) {
      expect(a5.transcript_path).toBe(resolve(bundleDir, 'source', 'transcript.jsonl'));
    }
  });
});

describe('A1 compaction summary', () => {
  it('extracts the last isCompactSummary entry with structure preserved', () => {
    const text = readFileSync(FIXTURE_TRANSCRIPT, 'utf8');
    const summary = extractCompactionSummary(text);
    expect(summary).toBeDefined();
    expect(summary).toContain('This session is being continued from a previous conversation');
    expect(summary).toContain('## Pending');
    // Newlines preserved, unlike intent extraction.
    expect(summary).toContain('\n');
  });

  it('keeps the LAST summary when several exist', () => {
    const base = readFileSync(FIXTURE_TRANSCRIPT, 'utf8');
    const extra = `${JSON.stringify({
      type: 'user',
      isCompactSummary: true,
      message: { role: 'user', content: 'Later summary wins.' },
    })}\n`;
    expect(extractCompactionSummary(base + extra)).toBe('Later summary wins.');
  });

  it('writes the summary as A1 material and reports unavailable without one', () => {
    const withSummary = makeBundle();
    buildAll(withSummary);
    expect(readMaterial(withSummary, 'A1')).toContain('## Key decisions');

    const without = makeBundle({ transcript: 'no-compaction' });
    buildAll(without);
    expect(readMeta(without, 'A1')).toEqual({
      schema_version: 1,
      arm: 'A1',
      available: false,
      arm_unavailable_reason: 'no_compaction_summary',
    });
    expect(existsSync(armMaterialPath(without, 'A1'))).toBe(false);
  });
});

describe('A2 ambient brief via the real composer', () => {
  it('composes the product ambient brief deterministically from the frozen store', () => {
    const bundleDir = makeBundle();
    buildAll(bundleDir);
    const material = readMaterial(bundleDir, 'A2');

    // The REAL ambient brief, not the manual one and not a synthesized text.
    expect(material).toContain('Circuit automatically captured the recent state of parse-config');
    expect(material).toContain("Latest request: ok let's stop here for tonight");
    // Deterministic age from the frozen clock (55s after capture).
    expect(material).toContain('(captured just now)');
    // Staleness rendered from the stubbed freeze-time probe.
    expect(material).toContain('- Captured on branch fix/duration-units at abc1234.');
    expect(material).not.toContain('# Circuit Handoff');

    // Same inputs, same brief: rebuild and compare bytes.
    const again = makeBundle();
    buildAll(again);
    expect(readMaterial(again, 'A2')).toBe(material);
  });

  it('never routes to the manual record even though the index has a pending_record', () => {
    const bundleDir = makeBundle();
    buildAll(bundleDir);
    expect(readMaterial(bundleDir, 'A2')).not.toContain('Circuit handoff is present');
  });

  it('reports unavailable when no ambient record exists', () => {
    const bundleDir = makeBundle({ continuity: 'no-ambient' });
    buildAll(bundleDir);
    expect(readMeta(bundleDir, 'A2')).toEqual({
      schema_version: 1,
      arm: 'A2',
      available: false,
      arm_unavailable_reason: 'no_ambient_record',
    });
  });

  it('reports unavailable when the frozen store has no index at all', () => {
    const bundleDir = makeBundle({ continuity: 'no-index' });
    buildAll(bundleDir);
    const meta = readMeta(bundleDir, 'A2');
    expect(meta.available).toBe(false);
  });
});

describe('stubBriefProbeFrom', () => {
  it('derives head_advanced and tree_clean purely from freeze-time facts', () => {
    const clean = stubBriefProbeFrom({ branch: 'main', head: 'abc1234', status_short: '' });
    expect(clean({ projectRoot: '/x', capturedHead: 'abc1234', capturedBranch: 'main' })).toEqual({
      current_head: 'abc1234',
      head_advanced: false,
      tree_clean: true,
    });

    const moved = stubBriefProbeFrom({
      branch: 'main',
      head: 'def5678',
      status_short: ' M src/a.ts',
    });
    const facts = moved({ projectRoot: '/x', capturedHead: 'abc1234', capturedBranch: 'main' });
    expect(facts.head_advanced).toBe(true);
    expect(facts.tree_clean).toBe(false);
    // A freeze snapshot can never prove a ref is gone.
    expect('branch_gone' in facts).toBe(false);
  });

  it('omits head facts it cannot compute', () => {
    const probe = stubBriefProbeFrom({ status_short: '' });
    expect(probe({ projectRoot: '/x', capturedHead: 'abc1234' })).toEqual({ tree_clean: true });
  });
});

describe('A3 manual handoff', () => {
  it('renders the in-window frozen record with the product summary renderer', () => {
    const bundleDir = makeBundle();
    buildAll(bundleDir);
    const material = readMaterial(bundleDir, 'A3');

    const record = ContinuityRecord.parse(
      JSON.parse(
        readFileSync(join(FIXTURE_CONTINUITY, 'records', `${MANUAL_RECORD_STEM}.json`), 'utf8'),
      ),
    );
    expect(material).toBe(summaryForRecord(record, 'resumption-quiz-arm'));
    expect(material).toContain('# Circuit Handoff');
    expect(material).toContain('Source: resumption-quiz-arm');
    expect(material).toContain('Fix duration parsing in parse-config');
  });

  it('falls back to the pending_record pointer when no record sits in the window', () => {
    const bundleDir = makeBundle({ continuity: 'manual-outside-window' });
    buildAll(bundleDir);
    const meta = readMeta(bundleDir, 'A3');
    expect(meta.available).toBe(true);
    expect(readMaterial(bundleDir, 'A3')).toContain('# Circuit Handoff');
  });

  it('reports unavailable rather than synthesizing when no manual save exists', () => {
    const bundleDir = makeBundle({ continuity: 'no-manual' });
    buildAll(bundleDir);
    expect(readMeta(bundleDir, 'A3')).toEqual({
      schema_version: 1,
      arm: 'A3',
      available: false,
      arm_unavailable_reason: 'no_manual_handoff',
    });
    expect(existsSync(armMaterialPath(bundleDir, 'A3'))).toBe(false);
  });
});

describe('A4 full transcript rendering', () => {
  it('labels turns and collapses tool calls and results to one line each', () => {
    const text = readFileSync(FIXTURE_TRANSCRIPT, 'utf8');
    const rendered = renderTranscriptText(text, 1_000_000);
    expect(rendered.truncated).toBe(false);
    expect(rendered.dropped_chars).toBe(0);
    expect(rendered.kept_chars).toBe(rendered.text.length);
    expect(rendered.text).toContain('user:');
    expect(rendered.text).toContain('assistant:');
    expect(rendered.text).toContain('[tool call] Bash: npm test');
    // The multi-line npm test output is collapsed onto a single summary line.
    expect(rendered.text).toContain('[tool result] > parse-config@0.3.1 test > node --test tests/');
  });

  it('keeps the tail and records the cut when over the cap', () => {
    const text = readFileSync(FIXTURE_TRANSCRIPT, 'utf8');
    const full = renderTranscriptText(text, 1_000_000);
    const cut = renderTranscriptText(text, 500);
    expect(cut.truncated).toBe(true);
    expect(cut.text).toBe(full.text.slice(-500));
    expect(cut.kept_chars).toBe(500);
    expect(cut.kept_chars + cut.dropped_chars).toBe(full.text.length);
  });

  it('stamps truncation into A4 meta when a4_max_chars is exceeded', () => {
    const bundleDir = makeBundle();
    buildAll(bundleDir, { ...MANIFEST, a4_max_chars: 400 });
    const meta = readMeta(bundleDir, 'A4');
    expect(meta.available).toBe(true);
    if (meta.available) {
      expect(meta.truncated).toBe(true);
      expect(meta.kept_chars).toBe(400);
      expect(meta.material_chars).toBe(400);
      expect((meta.dropped_chars ?? 0) > 0).toBe(true);
    }
    expect(readMaterial(bundleDir, 'A4').length).toBe(400);
  });

  it('omits the truncation fields when the rendering fits', () => {
    const bundleDir = makeBundle();
    buildAll(bundleDir);
    const meta = readMeta(bundleDir, 'A4');
    expect(meta.available).toBe(true);
    if (meta.available) {
      expect('truncated' in meta).toBe(false);
      expect(meta.material_chars).toBe(readMaterial(bundleDir, 'A4').length);
    }
  });
});
