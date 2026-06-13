import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..');

function readRepoFile(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

const runSurfacePaths = [
  'src/commands/run.md',
  'plugins/claude/commands/run.md',
  'plugins/codex/commands/run.md',
  'plugins/codex/skills/run/SKILL.md',
];

const directFlowSourcePaths = [
  'src/flows/build/command.md',
  'src/flows/explore/command.md',
  'src/flows/fix/command.md',
  'src/flows/goal/command.md',
  'src/flows/prototype/command.md',
  'src/flows/review/command.md',
];

const directFlowGeneratedPaths = [
  ...['build', 'explore', 'fix', 'goal', 'prototype', 'review'].flatMap((flow) => [
    `plugins/claude/commands/${flow}.md`,
    `plugins/codex/commands/${flow}.md`,
    `plugins/codex/skills/${flow}/SKILL.md`,
  ]),
];

const cliOnlyUtilityGeneratedPaths = [
  'plugins/claude/commands/create.md',
  'plugins/codex/commands/create.md',
  'plugins/codex/skills/create/SKILL.md',
];

const uninstallGeneratedPaths = [
  'plugins/claude/commands/uninstall.md',
  'plugins/codex/commands/uninstall.md',
  'plugins/codex/skills/uninstall/SKILL.md',
];

describe('generated host surface framing', () => {
  it('makes run the default Circuit command instead of a flow selector', () => {
    for (const path of runSurfacePaths) {
      const content = readRepoFile(path);

      expect(content, path).toMatch(/intent\s+front\s+door/);
      expect(content, path).toContain('records the selected flow');
      expect(content, path).toContain('not published as separate host commands');
      expect(content, path).not.toMatch(/flow selector/i);
      expect(content, path).not.toContain('Direct Flow Bypass');
      expect(content, path).not.toContain('host model chooses the flow before invoking Circuit');
      expect(content, path).not.toContain('skip this classifier layer');
      expect(content, path).not.toContain('Chooses and runs the best Circuit flow');
    }
  });

  it('does not publish direct flow command or skill surfaces', () => {
    for (const path of [...directFlowSourcePaths, ...directFlowGeneratedPaths]) {
      expect(existsSync(resolve(REPO_ROOT, path)), path).toBe(false);
    }
  });

  it('keeps Create as a CLI-only utility instead of a host command', () => {
    const generatedSurfaceMap = readRepoFile('docs/generated-surfaces.md');

    expect(existsSync(resolve(REPO_ROOT, 'src/commands/create.md'))).toBe(true);
    for (const path of cliOnlyUtilityGeneratedPaths) {
      expect(existsSync(resolve(REPO_ROOT, path)), path).toBe(false);
    }
    expect(generatedSurfaceMap).toContain('## CLI-only Utilities');
    expect(generatedSurfaceMap).toContain('| `create` | `src/commands/create.md` | none |');
  });

  it('keeps Uninstall as a CLI-only utility instead of a host command', () => {
    // Uninstall is a once-per-lifetime action; surfacing it in the /circuit
    // palette would clutter every routine invocation. It stays a real CLI
    // command (./bin/circuit uninstall) the docs point to, with no host
    // command or skill mirror.
    const generatedSurfaceMap = readRepoFile('docs/generated-surfaces.md');

    expect(existsSync(resolve(REPO_ROOT, 'src/commands/uninstall.md'))).toBe(true);
    expect(existsSync(resolve(REPO_ROOT, 'src/cli/uninstall.ts'))).toBe(true);
    for (const path of uninstallGeneratedPaths) {
      expect(existsSync(resolve(REPO_ROOT, path)), path).toBe(false);
    }
    expect(generatedSurfaceMap).toContain('| `uninstall` | `src/commands/uninstall.md` | none |');
  });

  it('keeps manifests intent-first and run-only for normal coding work', () => {
    const codexManifest = readRepoFile('plugins/codex/.codex-plugin/plugin.json');
    const claudeManifest = readRepoFile('plugins/claude/.claude-plugin/plugin.json');

    expect(codexManifest).toContain('coding intents');
    expect(codexManifest).toContain('default Circuit entry point');
    expect(codexManifest).not.toContain('choose the best bundled Circuit flow');

    expect(claudeManifest).toContain('default Circuit command');
    expect(claudeManifest).not.toContain('expert controls');
    expect(claudeManifest).not.toContain('selects the best flow');
  });

  it('freezes Goal to an internal flow with no separate host surface (S8)', () => {
    const generatedSurfaceMap = readRepoFile('docs/generated-surfaces.md');
    const runSkill = readRepoFile('plugins/codex/skills/run/SKILL.md');

    expect(generatedSurfaceMap).toContain('| `goal` | `internal` |');
    expect(generatedSurfaceMap).toContain(
      '`generated/flows/goal/circuit.json`<br>`generated/flows/goal/circuit.work-contract.v0.json` | none; internal flow | none | none |',
    );
    expect(existsSync(resolve(REPO_ROOT, 'plugins/claude/skills/goal'))).toBe(false);
    expect(existsSync(resolve(REPO_ROOT, 'plugins/codex/flows/goal'))).toBe(false);
    expect(runSkill).toContain('Goal is not a kind of work');
    expect(runSkill).toMatch(/completion\s+standard\s+Run\s+uses\s+by\s+default/);
  });
});
