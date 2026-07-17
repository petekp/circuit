import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
      expect(embeddedHtml).toContain('circuit.artifact-preview-ready@v1');
      expect(embeddedHtml).toContain(preview.embedded.proof);
      expect(embeddedHtml).toContain('<base href="file://');
      expect(embeddedHtml).toContain('<title>ready</title>');
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
    expect(html).toContain('data-mv-live');
    expect(html).toContain('data-mv-preview-state="loading"');
    expect(html).toContain('data-mv-preview-retry');
    expect(html).toContain('Preview took too long to load');
    expect(html).toContain('MutationObserver');
    expect(html).toContain('aria-labelledby="mv-dialog-title"');
    expect(html).toContain('overscroll-behavior:contain');
    expect(html).toContain('min-width:0;overflow-wrap:anywhere');
    expect(html).toContain('max-height:calc(100dvh - 32px);margin:auto;overflow:auto');
    expect(html).toContain('[data-mv-interactive]{display:none!important}');
    expect(html).toContain('background:#fff;color:#71717a');
    expect(html).toContain('color:#18181b;font-size:16px');
    expect(html.match(/<iframe data-mv-frame/g)).toHaveLength(2);
    expect(html).toContain('sandbox="allow-scripts allow-forms allow-pointer-lock"');
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
