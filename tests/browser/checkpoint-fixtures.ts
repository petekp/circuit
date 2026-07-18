import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { renderCheckpointPage as RenderCheckpointPage } from '../../src/shared/html/checkpoint-page.js';
import type {
  previewForEntryPoints as PreviewForEntryPoints,
  renderMultiVariantComparisonPage as RenderMultiVariantComparisonPage,
} from '../../src/shared/html/multi-variant.js';

const checkpointRendererPath = '../../dist/shared/html/checkpoint-page.js';
const multiVariantRendererPath = '../../dist/shared/html/multi-variant.js';
const { renderCheckpointPage } = (await import(checkpointRendererPath)) as {
  renderCheckpointPage: typeof RenderCheckpointPage;
};
const { previewForEntryPoints, renderMultiVariantComparisonPage } = (await import(
  multiVariantRendererPath
)) as {
  previewForEntryPoints: typeof PreviewForEntryPoints;
  renderMultiVariantComparisonPage: typeof RenderMultiVariantComparisonPage;
};

const GENERIC_IDENTITY = {
  attempt: 2,
  requestSha256: 'a'.repeat(64),
} as const;

const MULTI_IDENTITY = {
  attempt: 3,
  requestSha256: 'b'.repeat(64),
} as const;

export type CheckpointBrowserFixtures = {
  readonly root: string;
  readonly genericUrl: string;
  readonly genericNewIdentityUrl: string;
  readonly limitsUrl: string;
  readonly multiUrl: string;
  readonly singleArtifactUrl: string;
  readonly deletedPreviewSourcePath: string;
};

export function createCheckpointBrowserFixtures(): CheckpointBrowserFixtures {
  const root = mkdtempSync(join(tmpdir(), 'circuit-checkpoint-browser-'));
  const genericPath = join(root, 'generic-checkpoint.html');
  const genericNewIdentityPath = join(root, 'generic-checkpoint-new-identity.html');
  const limitsPath = join(root, 'generic-checkpoint-limits.html');
  const reportsRoot = join(root, 'reports');
  const prototypeFilesRoot = join(root, 'prototype-files');
  const multiPath = join(reportsRoot, 'multi-variant-checkpoint.html');
  const singleArtifactPath = join(reportsRoot, 'single-artifact-checkpoint.html');
  const artifactPath = join(prototypeFilesRoot, 'working-artifact.html');
  const singleArtifactSourcePath = join(prototypeFilesRoot, 'single-artifact.html');
  const longWord = 'unbroken-review-question-'.repeat(24);

  mkdirSync(reportsRoot, { recursive: true });
  mkdirSync(prototypeFilesRoot, { recursive: true });

  writeFileSync(
    artifactPath,
    `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Working artifact</title></head>
  <body>
    <main>
      <h1>Working artifact</h1>
      <details><summary>Reveal details</summary>
        <p>The artifact native interaction works.</p>
      </details>
    </main>
  </body>
</html>`,
    'utf8',
  );
  const workingPreview = previewForEntryPoints({
    entryPoints: ['prototype-files/working-artifact.html'],
    runFolder: root,
  });
  if (workingPreview.status !== 'ready') {
    throw new Error('browser fixture artifact should be previewable while it exists');
  }

  writeFileSync(
    singleArtifactSourcePath,
    `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Single artifact</title></head>
  <body>
    <main>
      <h1>Single artifact</h1>
      <details><summary>Show single details</summary>
        <p>The single artifact native interaction works.</p>
      </details>
    </main>
  </body>
</html>`,
    'utf8',
  );
  const singleArtifactPreview = previewForEntryPoints({
    entryPoints: ['prototype-files/single-artifact.html'],
    runFolder: root,
  });
  if (singleArtifactPreview.status !== 'ready') {
    throw new Error('single-artifact browser fixture should be previewable');
  }

  writeFileSync(
    genericPath,
    renderCheckpointPage({
      meta: {
        flowLabel: 'Browser fixture',
        runId: 'browser-generic-run',
        stepId: 'review-checkpoint',
      },
      question: `Choose the safest direction for ${longWord}`,
      subtitle: 'Compare each direction, leave a note, and finish when the decision is clear.',
      ribbon: ['Waiting for you', 'Three choices'],
      recommendation: {
        label: 'Ship the focused change',
        rationale: 'It has the narrowest risk and the clearest proof plan.',
      },
      options: [
        {
          id: 'focused',
          label: 'Ship the focused change',
          description: 'Keep the current scope and verify the browser behavior.',
          isDefault: true,
          isRecommended: true,
        },
        {
          id: 'broader',
          label: 'Broaden the change',
          description: 'Include the adjacent cleanup before shipping.',
        },
        {
          id: 'park',
          label: 'Park the work',
          description: 'Leave the run waiting until more evidence is available.',
        },
      ],
      defaultChoice: { id: 'focused', label: 'Ship the focused change' },
      resume: {
        runFolder: `${root}/Circuit checkpoint Pete's run`,
        commandPrefix: 'circuit resume',
        ...GENERIC_IDENTITY,
      },
      footerLeft: 'circuit · review-checkpoint · browser-generic-run',
      footerRight: `reports/${longWord}/request.json`,
    }),
    'utf8',
  );

  writeFileSync(
    genericNewIdentityPath,
    renderCheckpointPage({
      meta: {
        flowLabel: 'Browser fixture',
        runId: 'browser-generic-run',
        stepId: 'review-checkpoint',
      },
      question: 'Choose the safest direction for the newer checkpoint request.',
      ribbon: ['Waiting for you', 'New request identity'],
      options: [
        {
          id: 'focused',
          label: 'Ship the focused change',
          isDefault: true,
          isRecommended: true,
        },
        { id: 'broader', label: 'Broaden the change' },
        { id: 'park', label: 'Park the work' },
      ],
      defaultChoice: { id: 'focused', label: 'Ship the focused change' },
      resume: {
        runFolder: `${root}/Circuit checkpoint Pete's run`,
        commandPrefix: 'circuit resume',
        attempt: GENERIC_IDENTITY.attempt + 1,
        requestSha256: 'd'.repeat(64),
      },
    }),
    'utf8',
  );

  const limitOptions = Array.from({ length: 25 }, (_, index) => ({
    id: `choice-${index + 1}`,
    label: `Choice ${index + 1}`,
    ...(index === 0 ? { isDefault: true, isRecommended: true } : {}),
  }));
  writeFileSync(
    limitsPath,
    renderCheckpointPage({
      meta: {
        flowLabel: 'Browser fixture',
        runId: 'browser-limits-run',
        stepId: 'review-limits',
      },
      question: 'Review the payload safety limits.',
      ribbon: ['Waiting for you', 'Twenty-five choices'],
      options: limitOptions,
      defaultChoice: { id: 'choice-1', label: 'Choice 1' },
      resume: {
        runFolder: `${root}/Circuit checkpoint Pete's run`,
        commandPrefix: 'circuit resume',
        attempt: 4,
        requestSha256: 'c'.repeat(64),
      },
    }),
    'utf8',
  );

  writeFileSync(
    multiPath,
    renderMultiVariantComparisonPage({
      title: 'Prototype browser fixture',
      metaLine: 'Prototype · browser-multi-run',
      headline: `Choose the strongest prototype ${longWord}`,
      subtitle: 'Interact with each artifact, record what matters, then choose one.',
      recommendation: {
        label: 'Working artifact',
        rationale: 'It communicates the idea with the least friction.',
        badgeText: 'Recommended variant',
        intent: 'positive',
      },
      variants: [
        {
          id: 'working',
          label: 'Working artifact',
          description: 'A small interactive review card.',
          recommended: true,
          facts: [{ label: 'Relay', value: 'deterministic/browser-fixture' }],
          evidence: ['working-artifact.html'],
          preview: workingPreview,
          action: { label: 'Choose working', prompt: 'circuit resume --checkpoint-choice working' },
        },
        {
          id: 'missing',
          label: 'Missing artifact',
          description: 'The reported local artifact no longer exists.',
          recommended: false,
          facts: [],
          evidence: [`prototype-files/${longWord}/missing.html`],
          preview: {
            status: 'missing',
            sourcePath: `prototype-files/${longWord}/missing.html`,
          },
          action: { label: 'Choose missing', prompt: 'circuit resume --checkpoint-choice missing' },
        },
        {
          id: 'unavailable',
          label: 'Evidence only',
          description: 'This option has no browser-viewable entry point.',
          recommended: false,
          facts: [],
          evidence: ['reports/evidence-only.json'],
          preview: { status: 'unavailable' },
          action: {
            label: 'Choose evidence only',
            prompt: 'circuit resume --checkpoint-choice unavailable',
          },
        },
      ],
      resume: {
        runFolder: `${root}/Circuit checkpoint Pete's run`,
        runId: 'browser-multi-run',
        stepId: 'prototype-variant-checkpoint-step',
        commandPrefix: 'circuit resume',
        ...MULTI_IDENTITY,
      },
    }),
    'utf8',
  );
  writeFileSync(
    singleArtifactPath,
    renderCheckpointPage({
      meta: {
        flowLabel: 'Prototype',
        runId: 'browser-single-artifact-run',
        stepId: 'prototype-review',
      },
      question: 'Keep this single prototype artifact?',
      subtitle: 'Use the artifact, choose an outcome, and leave a review note.',
      ribbon: ['Waiting for you', 'Verified local artifact'],
      options: [
        {
          id: 'keep',
          label: 'Keep the prototype',
          description: 'Preserve the artifact and its evidence.',
          isDefault: true,
          isRecommended: true,
        },
        {
          id: 'revise',
          label: 'Revise the prototype',
          description: 'Return with specific review feedback.',
        },
      ],
      defaultChoice: { id: 'keep', label: 'Keep the prototype' },
      artifact: {
        title: 'Single prototype preview',
        description: 'A real interactive HTML artifact resolved from disk.',
        preview: singleArtifactPreview,
      },
      resume: {
        runFolder: root,
        commandPrefix: 'circuit resume',
        attempt: 5,
        requestSha256: '7'.repeat(64),
      },
    }),
    'utf8',
  );
  // The review must carry the rendered HTML artifact with it. Deleting the
  // source after projection reproduces a run folder being cleaned up or moved
  // before the operator opens the waiting report.
  unlinkSync(artifactPath);

  return {
    root,
    genericUrl: pathToFileURL(genericPath).href,
    genericNewIdentityUrl: pathToFileURL(genericNewIdentityPath).href,
    limitsUrl: pathToFileURL(limitsPath).href,
    multiUrl: pathToFileURL(multiPath).href,
    singleArtifactUrl: pathToFileURL(singleArtifactPath).href,
    deletedPreviewSourcePath: artifactPath,
  };
}

export function removeCheckpointBrowserFixtures(fixtures: CheckpointBrowserFixtures): void {
  rmSync(fixtures.root, { recursive: true, force: true });
}
