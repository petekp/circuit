import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Script } from 'node:vm';

import { describe, expect, it } from 'vitest';

import { CHECKPOINT_REVIEW_RUNTIME } from '../../../../src/shared/html/checkpoint-review-runtime.generated.js';
import {
  isPreviewableArtifactPath,
  previewForEntryPoints,
  renderMultiVariantComparisonPage,
  runArtifactPreviewHref,
} from '../../../../src/shared/html/multi-variant.js';

const REVIEW_IDENTITY = { attempt: 3, requestSha256: 'c'.repeat(64) } as const;

describe('multi-variant HTML primitives', () => {
  it('recognizes visual artifact paths without treating evidence docs as previews', () => {
    expect(isPreviewableArtifactPath('prototype-files/variants/a/index.html')).toBe(true);
    expect(isPreviewableArtifactPath('prototype-files/variants/a/screen.png')).toBe(true);
    expect(isPreviewableArtifactPath('prototype-files/variants/a/README.md')).toBe(false);
    expect(isPreviewableArtifactPath('reports/prototype/variant-review.json')).toBe(false);
  });

  it('builds report-relative preview URLs only for artifacts inside the current run', () => {
    const runFolder = '/tmp/project/.circuit/runs/run-123';
    expect(
      runArtifactPreviewHref({
        entryPath: '.circuit/runs/run-123/prototype-files/variants/a/index.html',
        runFolder,
      }),
    ).toBe('../prototype-files/variants/a/index.html');
    expect(
      runArtifactPreviewHref({
        entryPath: '/tmp/project/.circuit/runs/run-123/prototype-files/with space/index.html',
        runFolder,
      }),
    ).toBe('../prototype-files/with%20space/index.html');
    expect(
      runArtifactPreviewHref({
        entryPath: '.circuit/runs/other-run/prototype-files/variants/a/index.html',
        runFolder,
      }),
    ).toBeUndefined();
    expect(
      runArtifactPreviewHref({
        entryPath: '.circuit/runs/run-123/prototype-files/variants/a/README.md',
        runFolder,
      }),
    ).toBeUndefined();
    expect(
      runArtifactPreviewHref({
        entryPath: '.circuit/prototypes/external-run/variants/a/index.html',
        runFolder,
        projectRoot: '/tmp/project',
      }),
    ).toBe('file:///tmp/project/.circuit/prototypes/external-run/variants/a/index.html');
  });

  it('selects the first previewable entry point from current-run artifacts', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'circuit-preview-'));
    const runFolder = join(projectRoot, '.circuit/runs/run-123');
    const artifact = join(runFolder, 'prototype-files/variants/a/index.html');
    mkdirSync(dirname(artifact), { recursive: true });
    writeFileSync(artifact, '<!doctype html><title>ready</title>');
    try {
      const preview = previewForEntryPoints({
        entryPoints: [
          '.circuit/runs/run-123/prototype-files/variants/a/missing.html',
          '.circuit/runs/run-123/prototype-files/variants/a/README.md',
          '.circuit/runs/run-123/prototype-files/variants/a/index.html',
        ],
        runFolder,
      });
      expect(preview).toMatchObject({
        status: 'ready',
        href: '../prototype-files/variants/a/index.html',
        sourcePath: '.circuit/runs/run-123/prototype-files/variants/a/index.html',
      });
      if (preview.status !== 'ready') throw new Error('expected a ready preview');
      expect(preview.embedded).toBeDefined();
      if (preview.embedded === undefined) throw new Error('expected an embedded HTML snapshot');

      rmSync(artifact);
      const embeddedHtml = Buffer.from(preview.embedded.base64, 'base64').toString('utf8');
      expect(embeddedHtml).not.toContain('circuit.artifact-preview-ready@v1');
      expect(embeddedHtml).not.toContain('<script');
      expect(embeddedHtml).not.toContain('<base href="file://');
      expect(embeddedHtml).toContain('http-equiv="Content-Security-Policy"');
      expect(embeddedHtml).toContain("connect-src 'none'");
      expect(embeddedHtml).toContain("form-action 'none'");
      expect(embeddedHtml).toContain("frame-src 'none'");
      expect(embeddedHtml).toContain('<title>ready</title>');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('freezes image previews into the saved review instead of rereading mutable disk bytes', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'circuit-image-preview-'));
    const runFolder = join(projectRoot, '.circuit/runs/run-123');
    const artifact = join(runFolder, 'prototype-files/variants/a/screen.png');
    mkdirSync(dirname(artifact), { recursive: true });
    const original = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    writeFileSync(artifact, original);
    try {
      const preview = previewForEntryPoints({
        entryPoints: ['prototype-files/variants/a/screen.png'],
        runFolder,
      });
      expect(preview).toMatchObject({
        status: 'ready',
        sourcePath: 'prototype-files/variants/a/screen.png',
      });
      if (preview.status !== 'ready' || preview.embedded === undefined) {
        throw new Error('expected a frozen image preview');
      }

      writeFileSync(artifact, Buffer.from('changed after checkpoint'));
      const embeddedHtml = Buffer.from(preview.embedded.base64, 'base64').toString('utf8');
      expect(embeddedHtml).toContain(`data:image/png;base64,${original.toString('base64')}`);
      expect(embeddedHtml).not.toContain('changed after checkpoint');
      expect(embeddedHtml).toContain("connect-src 'none'");
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it.each([
    { extension: 'html', original: Buffer.from('<!doctype html><title>original</title>') },
    { extension: 'png', original: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) },
  ])(
    'rejects a mutated oversized sparse $extension entry before embedding it',
    ({ extension, original }) => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'circuit-oversized-preview-'));
      const runFolder = join(projectRoot, '.circuit/runs/run-123');
      const entryPoint = `prototype-files/variants/a/artifact.${extension}`;
      const artifact = join(runFolder, entryPoint);
      mkdirSync(dirname(artifact), { recursive: true });
      writeFileSync(artifact, original);
      try {
        // A sparse file makes this a meaningful allocation guard without
        // putting a large fixture in memory or on disk.
        truncateSync(artifact, 8 * 1024 * 1024 + 1);
        expect(previewForEntryPoints({ entryPoints: [entryPoint], runFolder })).toEqual({
          status: 'unavailable',
          reason: 'too-large',
        });
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    },
  );

  it.each([
    {
      extension: 'html',
      original: Buffer.from('<!doctype html><title>original</title>'),
      changed: Buffer.from('<!doctype html><title>changed</title>'),
    },
    {
      extension: 'png',
      original: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
      changed: Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 8, 7]),
    },
  ])(
    'rejects a $extension entry whose recorded bytes changed',
    ({ extension, original, changed }) => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'circuit-mutated-preview-'));
      const runFolder = join(projectRoot, '.circuit/runs/run-123');
      const entryPoint = `prototype-files/variants/a/artifact.${extension}`;
      const artifact = join(runFolder, entryPoint);
      mkdirSync(dirname(artifact), { recursive: true });
      writeFileSync(artifact, original);
      const expectedFiles = [
        {
          path: entryPoint,
          sha256: createHash('sha256').update(original).digest('hex'),
        },
      ];

      try {
        writeFileSync(artifact, changed);
        expect(
          previewForEntryPoints({ entryPoints: [entryPoint], runFolder, expectedFiles }),
        ).toEqual({ status: 'unavailable', reason: 'changed' });
      } finally {
        rmSync(projectRoot, { recursive: true, force: true });
      }
    },
  );

  it('keeps allocation bounded when a regular file repeatedly returns short reads', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'circuit-short-preview-read-'));
    const runFolder = join(projectRoot, '.circuit/runs/run-123');
    const entryPoint = 'prototype-files/variants/a/index.html';
    const artifact = join(runFolder, entryPoint);
    const source = Buffer.from('x'.repeat(1_024));
    mkdirSync(dirname(artifact), { recursive: true });
    writeFileSync(artifact, source);

    const mutableFs = fs as unknown as { readSync: (...args: unknown[]) => number };
    const originalReadSync = mutableFs.readSync;
    const readBuffers: Buffer[] = [];
    try {
      mutableFs.readSync = (...args: unknown[]): number => {
        const [descriptor, buffer, offset, length, position] = args as [
          number,
          Buffer,
          number,
          number,
          number | null,
        ];
        readBuffers.push(buffer);
        return originalReadSync(descriptor, buffer, offset, Math.min(length, 1), position);
      };
      syncBuiltinESMExports();

      expect(previewForEntryPoints({ entryPoints: [entryPoint], runFolder })).toMatchObject({
        status: 'ready',
      });
      const contentBuffers = readBuffers.filter((buffer) => buffer.byteLength > 1);
      expect(contentBuffers).toHaveLength(source.byteLength);
      expect(new Set(contentBuffers).size).toBe(1);
      expect(contentBuffers[0]?.byteLength).toBe(source.byteLength);
      expect(readBuffers.at(-1)?.byteLength).toBe(1);
    } finally {
      mutableFs.readSync = originalReadSync;
      syncBuiltinESMExports();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it.each(['html', 'svg'])('rejects invalid UTF-8 in a textual $extension preview', (extension) => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'circuit-invalid-preview-text-'));
    const runFolder = join(projectRoot, '.circuit/runs/run-123');
    const entryPoint = `prototype-files/variants/a/artifact.${extension}`;
    const artifact = join(runFolder, entryPoint);
    const prefix = extension === 'svg' ? '<svg><text>' : '<!doctype html><title>';
    const suffix = extension === 'svg' ? '</text></svg>' : '</title>';
    mkdirSync(dirname(artifact), { recursive: true });
    writeFileSync(
      artifact,
      Buffer.concat([Buffer.from(prefix), Buffer.from([0xc3, 0x28]), Buffer.from(suffix)]),
    );
    try {
      expect(previewForEntryPoints({ entryPoints: [entryPoint], runFolder })).toEqual({
        status: 'unavailable',
        reason: 'invalid-text',
      });
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('distinguishes unavailable, unsupported, and missing previews', () => {
    const runFolder = '/tmp/project/.circuit/runs/run-123';
    expect(previewForEntryPoints({ entryPoints: [], runFolder })).toEqual({
      status: 'unavailable',
    });
    expect(
      previewForEntryPoints({
        entryPoints: ['prototype-files/variants/a/README.md'],
        runFolder,
      }),
    ).toEqual({
      status: 'unsupported',
      sourcePath: 'prototype-files/variants/a/README.md',
    });
    expect(
      previewForEntryPoints({
        entryPoints: ['prototype-files/variants/a/missing.html'],
        runFolder,
      }),
    ).toEqual({
      status: 'missing',
      sourcePath: 'prototype-files/variants/a/missing.html',
    });
  });

  it('refuses to snapshot symlinks that escape the run or project artifact roots', () => {
    const root = mkdtempSync(join(tmpdir(), 'circuit-preview-symlink-'));
    const projectRoot = join(root, 'project');
    const runFolder = join(projectRoot, '.circuit/runs/run-123');
    const outsideFile = join(root, 'outside-secret');
    const runLink = join(runFolder, 'prototype-files/escape.html');
    const projectLink = join(projectRoot, '.circuit/prototypes/html-test/escape.html');
    mkdirSync(dirname(runLink), { recursive: true });
    mkdirSync(dirname(projectLink), { recursive: true });
    writeFileSync(outsideFile, 'outside bytes must never enter the checkpoint report');
    symlinkSync(outsideFile, runLink);
    symlinkSync(outsideFile, projectLink);

    try {
      expect(
        previewForEntryPoints({
          entryPoints: ['prototype-files/escape.html'],
          runFolder,
          projectRoot,
        }),
      ).toEqual({ status: 'missing', sourcePath: 'prototype-files/escape.html' });
      expect(
        previewForEntryPoints({
          entryPoints: ['.circuit/prototypes/html-test/escape.html'],
          runFolder,
          projectRoot,
        }),
      ).toEqual({
        status: 'missing',
        sourcePath: '.circuit/prototypes/html-test/escape.html',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects an entry whose path is replaced while its descriptor is being read', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'circuit-preview-race-'));
    const runFolder = join(projectRoot, '.circuit/runs/run-123');
    const entryPoint = 'prototype-files/variants/a/index.html';
    const artifact = join(runFolder, entryPoint);
    const movedArtifact = `${artifact}.original`;
    mkdirSync(dirname(artifact), { recursive: true });
    writeFileSync(artifact, Buffer.alloc(128 * 1024, 0x61));

    const mutableFs = fs as unknown as { readSync: (...args: unknown[]) => number };
    const originalReadSync = mutableFs.readSync;
    let replaced = false;
    try {
      mutableFs.readSync = (...args: unknown[]): number => {
        const read = Reflect.apply(originalReadSync, fs, args) as number;
        if (!replaced) {
          replaced = true;
          fs.renameSync(artifact, movedArtifact);
          fs.writeFileSync(artifact, Buffer.alloc(128 * 1024, 0x62));
        }
        return read;
      };
      syncBuiltinESMExports();

      expect(previewForEntryPoints({ entryPoints: [entryPoint], runFolder })).toEqual({
        status: 'unavailable',
        reason: 'changed',
      });
      expect(replaced).toBe(true);
    } finally {
      mutableFs.readSync = originalReadSync;
      syncBuiltinESMExports();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects an ancestor directory swapped outside the allowed root immediately before open', () => {
    const root = mkdtempSync(join(tmpdir(), 'circuit-preview-parent-race-'));
    const projectRoot = join(root, 'project');
    const runFolder = join(projectRoot, '.circuit/runs/run-123');
    const entryPoint = 'prototype-files/variants/a/index.html';
    const artifact = join(runFolder, entryPoint);
    const outsideDirectory = join(root, 'outside');
    const outsideArtifact = join(outsideDirectory, 'index.html');
    mkdirSync(dirname(artifact), { recursive: true });
    mkdirSync(outsideDirectory, { recursive: true });
    writeFileSync(artifact, '<title>Bound artifact</title>');
    writeFileSync(outsideArtifact, '<title>Outside secret</title>');

    const canonicalArtifact = fs.realpathSync.native(artifact);
    const canonicalParent = dirname(canonicalArtifact);
    const canonicalOutside = fs.realpathSync.native(outsideDirectory);
    const movedParent = `${canonicalParent}.original`;
    const mutableFs = fs as unknown as { openSync: (...args: unknown[]) => number };
    const originalOpenSync = mutableFs.openSync;
    let replaced = false;
    try {
      mutableFs.openSync = (...args: unknown[]): number => {
        if (!replaced && args[0] === canonicalArtifact) {
          replaced = true;
          fs.renameSync(canonicalParent, movedParent);
          fs.symlinkSync(canonicalOutside, canonicalParent, 'dir');
        }
        return Reflect.apply(originalOpenSync, fs, args) as number;
      };
      syncBuiltinESMExports();

      expect(previewForEntryPoints({ entryPoints: [entryPoint], runFolder })).toEqual({
        status: 'unavailable',
        reason: 'changed',
      });
      expect(replaced).toBe(true);
    } finally {
      mutableFs.openSync = originalOpenSync;
      syncBuiltinESMExports();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('renders a preview-first review workspace when at least one variant has a visual preview', () => {
    const longChoiceId = `variant-${'b'.repeat(160)}`;
    const html = renderMultiVariantComparisonPage({
      title: 'Variant checkpoint',
      metaLine: 'Prototype - run',
      headline: 'Choose a variant',
      subtitle: 'Compare variants.',
      recommendation: {
        label: 'Variant A',
        rationale: 'Clearer visual artifact.',
        badgeText: 'Recommended variant',
        intent: 'positive',
      },
      variants: [
        {
          id: 'variant-a',
          label: 'Variant A',
          description: 'Clearer.',
          recommended: true,
          facts: [{ label: 'Relay', value: 'anthropic/sonnet (medium)' }],
          evidence: ['artifact exists'],
          preview: {
            status: 'ready',
            href: '../prototype-files/variants/a/index.html',
            sourcePath: '.circuit/runs/run/prototype-files/variants/a/index.html',
          },
        },
        {
          id: longChoiceId,
          label: 'Variant B',
          description: 'Denser.',
          recommended: false,
          facts: [],
          evidence: ['artifact exists'],
          preview: {
            status: 'ready',
            href: '../prototype-files/variants/b/index.html',
            sourcePath: '.circuit/runs/run/prototype-files/variants/b/index.html',
          },
        },
      ],
      resume: {
        runFolder: '/tmp/project/.circuit/runs/run',
        runId: '11111111-1111-4111-8111-111111111111',
        stepId: 'prototype-variant-checkpoint-step',
        commandPrefix: "'/usr/local/bin/node' '/tmp/circuit-plugin/scripts/circuit.js' resume",
        ...REVIEW_IDENTITY,
      },
    });

    expect(html).toContain('mv-wrap mv-visual');
    expect(html).toContain('data-mv-workspace');
    expect(html).toContain('data-mv-interactive');
    expect(html).toContain('href="#mv-comment"');
    expect(html).toMatch(/tabindex="-1"/i);
    expect(html).toContain('role="tablist"');
    expect(html).toContain('data-mv-option');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('data-mv-previous');
    expect(html).toContain('data-mv-next');
    expect(html).toContain('data-mv-comment');
    expect(html).toContain('data-mv-finish');
    expect(html).toContain('data-mv-submit-decision');
    expect(html).toContain('data-mv-live');
    expect(html).toContain('data-mv-preview-state="loading"');
    expect(html).toContain('data-mv-preview-retry');
    expect(html).toContain('Preview took too long to load');
    expect(html).toContain('You can retry the preview or continue reviewing without it.');
    expect(html).not.toContain('open the artifact full size');
    expect(html).not.toContain('Open it full size instead');
    expect(html).toContain('MutationObserver');
    expect(html).toContain('aria-labelledby="mv-dialog-title"');
    expect(html).toContain('overscroll-behavior:contain');
    expect(html).toContain('min-width:0;overflow-wrap:anywhere');
    expect(html).toContain('max-height:calc(100dvh - 32px);margin:auto;overflow:auto');
    expect(html).toContain('[data-mv-interactive]{display:none!important}');
    expect(html).toContain('background:#fff;color:#71717a');
    expect(html).toContain('color:#18181b;font-size:16px');
    expect(html.match(/<iframe data-mv-frame/g)).toHaveLength(2);
    expect(html).toContain('sandbox=""');
    expect(html).not.toContain('sandbox="allow-');
    expect(html).toContain('Safe preview · Scripts and links are off');
    expect(html).not.toContain('allow-same-origin');
    expect(html).toContain('data-mv-preview-src="../prototype-files/variants/a/index.html"');
    expect(html).toContain('data-mv-preview-src="../prototype-files/variants/b/index.html"');
    expect(html).toContain(`data-mv-variant-id="${longChoiceId}"`);
    expect(html).toContain('Saved in this browser');
    expect(html).toContain('--checkpoint-response');
    expect(html).toContain(
      'data-resume-prefix="&#x27;/usr/local/bin/node&#x27; &#x27;/tmp/circuit-plugin/scripts/circuit.js&#x27; resume"',
    );
    expect(html).toContain(CHECKPOINT_REVIEW_RUNTIME);
    expect(html.match(/checkpoint\.review-draft@v1/g)).toHaveLength(1);
    expect(html).toContain('checkpoint.review-response@v1');
    const reviewScript = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g))
      .map((match) => match[1] ?? '')
      .find((script) => script.includes('checkpoint.review-draft@v1'));
    expect(reviewScript).toBeDefined();
    if (reviewScript === undefined) throw new Error('expected checkpoint review script');
    expect(() => new Script(reviewScript)).not.toThrow();
    expect(html).toContain('data-attempt="3"');
    expect(html).toContain(`data-request-sha256="${REVIEW_IDENTITY.requestSha256}"`);
    expect(html).toContain('Why Circuit suggested Variant A');
    expect(html.match(/Clearer visual artifact\./g)).toHaveLength(1);
  });

  it('announces prepared-decision status changes to assistive technology', () => {
    const html = renderMultiVariantComparisonPage({
      title: 'Variant checkpoint',
      metaLine: 'Prototype - run',
      headline: 'Choose a variant',
      subtitle: 'Compare variants.',
      recommendation: {
        label: 'Variant A',
        rationale: 'Clearer visual artifact.',
        badgeText: 'Recommended variant',
        intent: 'positive',
      },
      variants: [
        {
          id: 'variant-a',
          label: 'Variant A',
          description: 'Clearer.',
          recommended: true,
          facts: [],
          evidence: [],
          preview: {
            status: 'ready',
            href: '../prototype-files/variants/a/index.html',
            sourcePath: 'prototype-files/variants/a/index.html',
          },
        },
      ],
      resume: {
        runFolder: '/tmp/project/.circuit/runs/run',
        runId: '11111111-1111-4111-8111-111111111111',
        stepId: 'prototype-variant-checkpoint-step',
        commandPrefix: 'circuit resume',
        ...REVIEW_IDENTITY,
      },
    });

    const commandState = html.match(/<div[^>]*data-mv-command-state=""[^>]*>/)?.[0];
    expect(commandState).toBeDefined();
    expect(commandState).toContain('role="status"');
    expect(commandState).toContain('aria-live="polite"');
  });

  it('keeps descriptions and decision facts in the no-JavaScript review', () => {
    const headline = 'Choose the prototype with the clearest interaction.';
    const description = 'A calm review card that reveals details on demand.';
    const factValue = 'anthropic/haiku (low)';
    const html = renderMultiVariantComparisonPage({
      title: 'Variant checkpoint',
      metaLine: 'Prototype - run',
      headline,
      subtitle: 'Compare variants.',
      recommendation: {
        label: 'Variant A',
        rationale: 'Clearer visual artifact.',
        badgeText: 'Recommended variant',
        intent: 'positive',
      },
      variants: [
        {
          id: 'variant-a',
          label: 'Variant A',
          description,
          recommended: true,
          facts: [{ label: 'Relay', value: factValue }],
          evidence: [],
          preview: {
            status: 'ready',
            href: '../prototype-files/variants/a/index.html',
            sourcePath: 'prototype-files/variants/a/index.html',
          },
          action: { label: 'Choose Variant A', prompt: 'circuit resume --checkpoint-choice a' },
        },
      ],
      resume: {
        runFolder: '/tmp/project/.circuit/runs/run',
        runId: '11111111-1111-4111-8111-111111111111',
        stepId: 'prototype-variant-checkpoint-step',
        commandPrefix: 'circuit resume',
        ...REVIEW_IDENTITY,
      },
    });

    const noScript = html.match(/<noscript>([\s\S]*?)<\/noscript>/)?.[1];
    expect(noScript).toBeDefined();
    expect(noScript).toContain(headline);
    expect(noScript).toContain(description);
    expect(noScript).toContain(factValue);
  });

  it('does not line-clamp the active variant description', () => {
    const html = renderMultiVariantComparisonPage({
      title: 'Variant checkpoint',
      metaLine: 'Prototype - run',
      headline: 'Choose a variant',
      subtitle: 'Compare variants.',
      recommendation: {
        label: 'Variant A',
        rationale: 'Clearer visual artifact.',
        badgeText: 'Recommended variant',
        intent: 'positive',
      },
      variants: [
        {
          id: 'variant-a',
          label: 'Variant A',
          description: 'Every part of this decision description must remain available to review.',
          recommended: true,
          facts: [],
          evidence: [],
          preview: {
            status: 'ready',
            href: '../prototype-files/variants/a/index.html',
            sourcePath: 'prototype-files/variants/a/index.html',
          },
        },
      ],
      resume: {
        runFolder: '/tmp/project/.circuit/runs/run',
        runId: '11111111-1111-4111-8111-111111111111',
        stepId: 'prototype-variant-checkpoint-step',
        commandPrefix: 'circuit resume',
        ...REVIEW_IDENTITY,
      },
    });

    expect(html).not.toMatch(/\.mv-description\{[^}]*-webkit-line-clamp/);
  });

  it('refuses to render an interactive visual review without resume identity', () => {
    expect(() =>
      renderMultiVariantComparisonPage({
        title: 'Variant checkpoint',
        metaLine: 'Prototype - run',
        headline: 'Choose a variant',
        subtitle: 'Compare variants.',
        recommendation: {
          label: 'Variant A',
          rationale: 'Clearer visual artifact.',
          badgeText: 'Recommended variant',
          intent: 'positive',
        },
        variants: [
          {
            id: 'variant-a',
            label: 'Variant A',
            description: 'Clearer.',
            recommended: true,
            facts: [],
            evidence: [],
            preview: {
              status: 'ready',
              href: '../a/index.html',
              sourcePath: 'a/index.html',
            },
          },
        ],
      }),
    ).toThrow('requires resume metadata');
  });

  it('keeps the review workspace when previews are unavailable', () => {
    const html = renderMultiVariantComparisonPage({
      title: 'Variant checkpoint',
      metaLine: 'Prototype - run',
      headline: 'Choose a variant',
      subtitle: 'Compare variants.',
      recommendation: {
        label: 'Variant A',
        rationale: 'Best available direction.',
        badgeText: 'Recommended variant',
        intent: 'positive',
      },
      variants: [
        {
          id: 'variant-a',
          label: 'Variant A',
          description: 'The artifact path is currently unavailable.',
          recommended: true,
          facts: [],
          evidence: ['reports/a.json'],
        },
      ],
      resume: {
        runFolder: '/tmp/project/.circuit/runs/run',
        runId: '11111111-1111-4111-8111-111111111111',
        stepId: 'prototype-variant-checkpoint-step',
        commandPrefix: 'circuit resume',
        ...REVIEW_IDENTITY,
      },
    });

    expect(html).toContain('mv-wrap mv-visual');
    expect(html).toContain('Preview unavailable');
    expect(html).toContain('data-mv-comment');
  });

  it('renders explicit failure states without broken preview controls', () => {
    const html = renderMultiVariantComparisonPage({
      title: 'Variant checkpoint',
      metaLine: 'Prototype - run',
      headline: 'Choose a variant',
      subtitle: 'Compare variants.',
      recommendation: {
        label: 'Variant A',
        rationale: 'Best available direction.',
        badgeText: 'Recommended variant',
        intent: 'positive',
      },
      variants: [
        {
          id: 'variant-a',
          label: 'Variant A',
          description: 'The reported artifact is missing.',
          recommended: true,
          facts: [],
          evidence: ['reports/a.json'],
          preview: {
            status: 'missing',
            sourcePath: 'prototype-files/variants/a/index.html',
          },
        },
      ],
      resume: {
        runFolder: '/tmp/project/.circuit/runs/run',
        runId: '11111111-1111-4111-8111-111111111111',
        stepId: 'prototype-variant-checkpoint-step',
        commandPrefix: 'circuit resume',
        ...REVIEW_IDENTITY,
      },
    });

    expect(html).toContain('Preview file missing');
    expect(html).toContain('Review the evidence instead.');
    expect(html).toContain('prototype-files/variants/a/index.html');
    expect(html).not.toContain('<iframe data-mv-frame');
    expect(html).not.toContain('href="prototype-files/variants/a/index.html"');
    expect(html).toContain('data-mv-comment');
    expect(html).toContain('data-mv-finish');
  });

  it.each([
    {
      reason: 'too-large' as const,
      title: 'Preview is too large',
      detail: 'This file exceeds the safe preview limit.',
    },
    {
      reason: 'changed' as const,
      title: 'Preview changed',
      detail: 'The reported file changed while Circuit prepared this review.',
    },
    {
      reason: 'invalid-text' as const,
      title: 'Preview text could not be read',
      detail: 'This HTML or SVG file is not valid UTF-8.',
    },
  ])(
    'renders a safe $reason fallback without internal error details',
    ({ reason, title, detail }) => {
      const html = renderMultiVariantComparisonPage({
        title: 'Variant checkpoint',
        metaLine: 'Prototype - run',
        headline: 'Choose a variant',
        subtitle: 'Compare variants.',
        recommendation: {
          label: 'Variant A',
          rationale: 'Best available direction.',
          badgeText: 'Recommended variant',
          intent: 'positive',
        },
        variants: [
          {
            id: 'variant-a',
            label: 'Variant A',
            description: 'The artifact preview is unavailable.',
            recommended: true,
            facts: [],
            evidence: ['reports/a.json'],
            preview: { status: 'unavailable', reason },
          },
        ],
        resume: {
          runFolder: '/tmp/project/.circuit/runs/run',
          runId: '11111111-1111-4111-8111-111111111111',
          stepId: 'prototype-variant-checkpoint-step',
          commandPrefix: 'circuit resume',
          ...REVIEW_IDENTITY,
        },
      });

      expect(html).toContain(title);
      expect(html).toContain(detail);
      expect(html).not.toContain('artifact preview is too large to freeze');
      expect(html).not.toContain('/private/tmp/secret-preview');
    },
  );

  it('renders evidence-first comparison without preview chrome for non-visual variants', () => {
    const html = renderMultiVariantComparisonPage({
      title: 'Variant checkpoint',
      metaLine: 'Prototype - run',
      headline: 'Choose a variant',
      subtitle: 'Compare variants.',
      recommendation: {
        label: 'Variant A',
        rationale: 'Better evidence.',
        badgeText: 'Recommended variant',
        intent: 'positive',
      },
      variants: [
        {
          id: 'variant-a',
          label: 'Variant A',
          description: 'Clearer report.',
          recommended: true,
          facts: [{ label: 'Relay', value: 'anthropic/sonnet (medium)' }],
          evidence: ['reports/a.json'],
        },
        {
          id: 'variant-b',
          label: 'Variant B',
          description: 'Denser report.',
          recommended: false,
          facts: [],
          evidence: ['reports/b.json'],
        },
      ],
    });

    expect(html).toContain('mv-wrap mv-evidence');
    expect(html).not.toContain('data-mv-frame');
    expect(html).not.toContain('Selected variant preview');
    expect(html).toContain('reports/a.json');
    expect(html).toContain('reports/b.json');
    expect(html).toContain('.mv-evidence-cell{grid-column:2}');
    expect(html).not.toContain('html,body{height:100%;overflow:hidden}');
  });
});
