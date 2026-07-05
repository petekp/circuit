import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');

function readRepoFile(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

function markdownFilesUnder(path: string): string[] {
  const abs = resolve(REPO_ROOT, path);
  if (!existsSync(abs)) return [];
  const stat = statSync(abs);
  if (stat.isFile()) return path.endsWith('.md') ? [path] : [];

  return readdirSync(abs).flatMap((entry) => {
    const child = join(abs, entry);
    const rel = relative(REPO_ROOT, child);
    const childStat = statSync(child);
    if (childStat.isDirectory()) return markdownFilesUnder(rel);
    return rel.endsWith('.md') ? [rel] : [];
  });
}

function isExcludedHistoricalPath(path: string): boolean {
  return (
    path.startsWith('docs/internal/archive/') ||
    path.startsWith('docs/release/proofs/runs/') ||
    path.startsWith('docs/ideas/') ||
    path.startsWith('docs/learnings/')
  );
}

function isFlowCommandSource(path: string): boolean {
  return /^src\/flows\/[^/]+\/command\.md$/.test(path);
}

describe('documentation surface', () => {
  it('documents the approved active how-to sources', () => {
    const docsMap = readRepoFile('docs/README.md');

    // AGENTS.md is the single canonical rules file. CLAUDE.md may exist only as
    // an import-only pointer so Claude Code (which reads CLAUDE.md, not
    // AGENTS.md) loads the same rules. It must never become a second rules file.
    expect(existsSync(resolve(REPO_ROOT, 'CLAUDE.md'))).toBe(true);
    const claudeMd = readRepoFile('CLAUDE.md');
    expect(claudeMd).toContain('@AGENTS.md');
    expect(claudeMd).not.toMatch(/^##\s/m);
    expect(docsMap).toContain('## Approved Active How-To Locations');
    for (const link of [
      '[AGENTS.md](../AGENTS.md)',
      '[docs/repository-map.md](repository-map.md)',
      '[docs/agent-setup.md](agent-setup.md)',
      '[docs/first-run.md](first-run.md)',
      '[docs/operator-guide.md](operator-guide.md)',
      '[docs/configuration.md](configuration.md)',
      '[docs/flows/authoring-model.md](flows/authoring-model.md)',
      '[docs/generated-surfaces.md](generated-surfaces.md)',
      '[plugins/README.md](../plugins/README.md)',
      '[plugins/codex/README.md](../plugins/codex/README.md)',
      '[src/shared/README.md](../src/shared/README.md)',
      '[src/commands/README.md](../src/commands/README.md)',
      '[src/README.md](../src/README.md)',
      '[docs/release/proofs/README.md](release/proofs/README.md)',
      '[docs/host-trial-checklist.md](host-trial-checklist.md)',
    ]) {
      expect(docsMap).toContain(link);
    }
  });

  it('keeps the host-ready flow-authoring playbook centralized', () => {
    const authoring = readRepoFile('docs/flows/authoring-model.md');
    const readme = readRepoFile('README.md');
    const firstRun = readRepoFile('docs/first-run.md');

    for (const required of [
      'This is the flow-authoring playbook.',
      '### 2. Decide command ownership',
      '`paths.command`',
      '`plugins/claude/commands/<id>.md`',
      '`plugins/codex/commands/<id>.md`',
      '`plugins/codex/skills/<id>/SKILL.md`',
      'npm run plugins:refresh-local',
      'npm run check-release-infra',
      'npm run check-flow-drift',
      'npm run verify',
    ]) {
      expect(authoring).toContain(required);
    }

    expect(readme).toContain('npm run plugins:refresh-local');
    expect(readme).not.toContain('npm run sync:codex-plugin-cache');
    expect(firstRun).toContain('npm run plugins:refresh-local');

    for (const pointerFile of [
      'AGENTS.md',
      'docs/architecture/declarative-flow-architecture.md',
      'src/commands/README.md',
      'docs/flows/pursue.md',
    ]) {
      expect(readRepoFile(pointerFile), pointerFile).toContain('docs/flows/authoring-model.md');
    }

    expect(readRepoFile('AGENTS.md')).not.toContain('Create `src/flows/<id>/` with `data.ts`');
    expect(readRepoFile('docs/architecture/declarative-flow-architecture.md')).not.toContain(
      '`plugins/codex/skills/**`',
    );
    expect(readRepoFile('src/commands/README.md')).not.toContain(
      'Claude Code commands: `plugins/claude/commands/<id>.md`',
    );
  });

  it('keeps approved active docs on the cutover path', () => {
    const activeCutoverDocs = [
      'README.md',
      'AGENTS.md',
      'UBIQUITOUS_LANGUAGE.md',
      'docs/README.md',
      'docs/agent-setup.md',
      'docs/architecture/declarative-flow-architecture.md',
      'docs/flows/authoring-model.md',
      'docs/flows/blocks.md',
      'docs/flows/explore-tournament.md',
      'docs/flows/pursue.md',
      'docs/operator-guide.md',
      'docs/generated-surfaces.md',
      'docs/reference/script-inventory.md',
      'src/commands/README.md',
      'src/commands/create.md',
      'src/commands/generate.md',
      'src/commands/run.md',
      'src/commands/uninstall.md',
    ];
    const cutoverBackslide = /\b(?:legacy|compatibility|shim|back[- ]?compat)\b/i;

    const offenders = activeCutoverDocs
      .map((path) => ({ path, matches: readRepoFile(path).match(cutoverBackslide) }))
      .filter(({ matches }) => matches !== null)
      .map(({ path, matches }) => `${path}: ${matches?.[0]}`);

    expect(offenders).toEqual([]);
  });

  it('does not publish rejected connector shorthand in configuration examples', () => {
    const configuration = readRepoFile('docs/configuration.md');

    expect(configuration).not.toContain('reviewer: codex');
    expect(configuration).not.toContain('researcher: codex');
    expect(configuration).not.toContain('explore: codex');
    expect(configuration).toContain('kind: builtin');
    expect(configuration).toContain('name: codex');
  });

  it('keeps progressive repository maps wired from docs to source layers', () => {
    const docsMap = readRepoFile('docs/README.md');
    const repoMap = readRepoFile('docs/repository-map.md');
    const sourceMap = readRepoFile('src/README.md');
    const generatedMap = readRepoFile('docs/generated-surfaces.md');

    for (const link of [
      '[docs/repository-map.md](repository-map.md)',
      '[docs/reference/script-inventory.md](reference/script-inventory.md)',
      '[plugins/README.md](../plugins/README.md)',
      '[src/README.md](../src/README.md)',
    ]) {
      expect(docsMap).toContain(link);
    }

    for (const required of [
      '## Before Map',
      '## After Map',
      '## Migration Rationale',
      'docs/reference/script-inventory.md',
      'plugins/codex/README.md',
      'src/runtime/README.md',
      'src/schemas/README.md',
      'src/flows/README.md',
      'src/shared/README.md',
    ]) {
      expect(repoMap).toContain(required);
    }

    for (const required of [
      '[src/runtime/README.md](runtime/README.md)',
      '[src/schemas/README.md](schemas/README.md)',
      '[src/flows/README.md](flows/README.md)',
      '[src/shared/README.md](shared/README.md)',
      '`src/index.ts`',
    ]) {
      expect(sourceMap).toContain(required);
    }

    expect(generatedMap).toContain('[plugins/README.md](../plugins/README.md)');

    const pluginMap = readRepoFile('plugins/README.md');
    expect(pluginMap).toContain('[`plugins/claude/`](claude/)');
    expect(pluginMap).toContain('[`plugins/codex/`](codex/)');
    expect(readRepoFile('plugins/codex/README.md')).toContain(
      'Codex skills are generated host instructions',
    );
    expect(readRepoFile('src/shared/README.md')).toContain('used across source layers');
  });

  it('keeps active how-to markers inside approved locations', () => {
    const approved = new Set([
      'README.md',
      'AGENTS.md',
      'docs/README.md',
      'docs/agent-setup.md',
      'docs/first-run.md',
      'docs/operator-guide.md',
      'docs/configuration.md',
      'docs/flows/authoring-model.md',
      'docs/flows/blocks.md',
      'docs/generated-surfaces.md',
      'docs/host-trial-checklist.md',
      'docs/release/proofs/README.md',
      'docs/release/runbook.md',
      'docs/specs/narration-display-profiles.md',
      'docs/contracts/host-rendering.md',
      'src/commands/README.md',
      'src/commands/create.md',
      'src/commands/generate.md',
      'src/commands/handoff.md',
      'src/commands/run.md',
      'src/commands/uninstall.md',
    ]);

    const howToMarker =
      /(^# .*?(?:Runbook|Playbook|Checklist)|^## Adding A Flow|^## Adding a flow|^## Copy-Paste Prompt|Release QA checklist|source map for Circuit command surfaces|Do not hand-edit generated host output)/im;
    const files = [
      'README.md',
      'AGENTS.md',
      ...markdownFilesUnder('docs'),
      ...markdownFilesUnder('src/commands'),
      ...markdownFilesUnder('src/flows'),
    ].filter((path) => !isExcludedHistoricalPath(path));

    const offenders = files
      .filter((path) => howToMarker.test(readRepoFile(path)))
      .filter((path) => !approved.has(path))
      .filter((path) => !isFlowCommandSource(path));

    expect(offenders).toEqual([]);
  });
});
