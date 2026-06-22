import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

function walk(dir: string, extensions = new Set(['.ts', '.md', '.json'])): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      out.push(...walk(path, extensions));
      continue;
    }
    if (extensions.has(extname(path))) out.push(path);
  }
  return out;
}

function matchingLines(paths: readonly string[], pattern: RegExp): string[] {
  const matches: string[] = [];
  for (const path of paths) {
    const lines = readFileSync(path, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (pattern.test(line)) matches.push(`${path}:${index + 1}: ${line.trim()}`);
    });
  }
  return matches;
}

const importPattern =
  /\b(?:import\s+(?:type\s+)?(?:[^'"\n;]+\s+from\s+)?|export\s+(?:type\s+)?(?:\*\s+|\{[^}]*\}\s+)?from\s+|import\(\s*)['"]([^'"\n]+)['"]/g;

function importPathsFrom(path: string): string[] {
  const source = readFileSync(path, 'utf8');
  return [...source.matchAll(importPattern)].map((match) => match[1]).filter(Boolean) as string[];
}

const sourceEnvelopeFiles = [
  'src/app/run-envelope/source-record.ts',
  ...walk('src/app/run-envelope/source').filter((path) => path.endsWith('.ts')),
];

describe('Run-centered V1 safety ratchets', () => {
  it('keeps internal Supervisor vocabulary out of operator-facing surfaces', () => {
    // The proposer prompt (composition/propose-prompts.ts) is a MODEL-facing
    // string: the proposer reads it to learn the block menu; no operator ever
    // sees it. Its text is pinned byte-for-byte to a validated experiment
    // artifact (experiments/flow-lab/_proposer-prompt.md) by a separate
    // equality test, so it cannot be reworded here without diverging from what
    // was validated. It is excluded from this operator-surface scan for the same
    // reason the test excludes itself from the skill-hook scan below.
    const operatorSurfaceFiles = [
      'README.md',
      ...walk('src/commands'),
      ...walk('src/flows'),
      ...walk('plugins'),
      ...walk('docs/release'),
    ].filter((path) => path !== 'src/flows/composition/propose-prompts.ts');

    expect(matchingLines(operatorSurfaceFiles, /\bsupervisor\b/i)).toEqual([]);
  });

  it('keeps future Run envelope code away from runtime executor internals', () => {
    const futureEnvelopeFiles = [...walk('src/app/run-envelope'), ...walk('src/cli/run-envelope')];
    const offenders = futureEnvelopeFiles.flatMap((path) =>
      importPathsFrom(path)
        .filter((importPath) => importPath.includes('/runtime/executors/'))
        .map((importPath) => `${path} -> ${importPath}`),
    );

    expect(offenders).toEqual([]);
  });

  it('keeps the source Run envelope projection-only', () => {
    const offenders = sourceEnvelopeFiles.flatMap((path) =>
      importPathsFrom(path)
        .filter(
          (importPath) =>
            importPath.endsWith('/schemas/result.js') ||
            importPath.includes('/runtime/') ||
            importPath.endsWith('/process-evidence/projection.js') ||
            importPath.includes('/flows/catalog'),
        )
        .map((importPath) => `${path} -> ${importPath}`),
    );

    expect(offenders).toEqual([]);
  });

  it('keeps runtime-shaped child inputs out of the source Run envelope', () => {
    expect(
      matchingLines(
        sourceEnvelopeFiles,
        /\b(?:ClosedChild|CheckpointWaitingChild|buildProjection|runResult|resultPath|00000000-0000-4000-8000-000000000000)\b/,
      ),
    ).toEqual([]);
  });

  it('keeps future Run envelope code from hard-coding private report paths', () => {
    const futureEnvelopeFiles = [...walk('src/app/run-envelope'), ...walk('src/cli/run-envelope')];

    expect(matchingLines(futureEnvelopeFiles, /reports\/[^'"\s]+\/[^'"\s]+\.json/)).toEqual([]);
  });

  it('keeps Skill Hook policy from becoming flow-step skill slots again', () => {
    const schematicAndTestFiles = [...walk('src/flows'), ...walk('tests')].filter(
      (path) =>
        ![
          'tests/contracts/run-centered-v1-safety.test.ts',
          'tests/contracts/skill-hook-policy-schema.test.ts',
        ].includes(path),
    );

    expect(matchingLines(schematicAndTestFiles, /skill_hooks.*skills|skills.*skill_hooks/)).toEqual(
      [],
    );
  });
});
