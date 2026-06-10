import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// These tests assert that the Claude Code plugin command body under
// `plugins/claude/commands/run.md` is wired to the runtime rather than carrying
// placeholder text, and that routed-only flows are not published as separate
// host command files.
//
// Safe-construction: the unsafe `--goal "$ARGUMENTS"` double-quoted splice
// pattern is forbidden; regression tests assert that fenced bash invocation
// examples use single-quoted --goal arguments.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

const CLAUDE_COMMAND_ROOT = resolve(REPO_ROOT, 'plugins/claude/commands');
const RUN_COMMAND_PATH = resolve(CLAUDE_COMMAND_ROOT, 'run.md');
const ROUTED_ONLY_COMMAND_PATHS = ['build', 'explore', 'fix', 'goal', 'prototype', 'review'].map(
  (flow) => resolve(CLAUDE_COMMAND_ROOT, `${flow}.md`),
);
const MANIFEST_PATH = resolve(REPO_ROOT, 'plugins/claude/.claude-plugin/plugin.json');
const CLAUDE_WRAPPER_PATTERN = String.raw`node "\$\{CLAUDE_PLUGIN_ROOT\}/scripts/circuit\.ts"`;

function extractBashBlocks(body: string): string[] {
  const regex = /```bash\n([\s\S]*?)```/g;
  const blocks: string[] = [];
  for (const match of body.matchAll(regex)) {
    const block = match[1];
    if (block !== undefined) blocks.push(block);
  }
  return blocks;
}

function hasExecutableCompiledFlowInvocation(body: string, flow: string): boolean {
  const blocks = extractBashBlocks(body);
  const flowPattern = flow.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const binInvocation = new RegExp(`^\\s*\\.\\/bin\\/circuit run ${flowPattern}(?:\\s|$)`);
  const nodeInvocation = new RegExp(
    `^\\s*node dist\\/cli\\/circuit\\.js run ${flowPattern}(?:\\s|$)`,
  );
  const claudePluginInvocation = new RegExp(
    `^\\s*${CLAUDE_WRAPPER_PATTERN} present run ${flowPattern}(?:\\s|$)`,
  );
  for (const block of blocks) {
    for (const line of block.split('\n')) {
      const hasCli =
        binInvocation.test(line) || nodeInvocation.test(line) || claudePluginInvocation.test(line);
      const hasGoal = /--goal\s+/.test(line);
      if (hasCli && hasGoal) return true;
    }
  }
  return false;
}

function hasExecutableExploreInvocation(body: string): boolean {
  return hasExecutableCompiledFlowInvocation(body, 'explore');
}

function hasExecutableReviewInvocation(body: string): boolean {
  return hasExecutableCompiledFlowInvocation(body, 'review');
}

function hasExecutableBuildInvocation(body: string): boolean {
  return hasExecutableCompiledFlowInvocation(body, 'build');
}

function hasExecutableRouterInvocation(body: string): boolean {
  const blocks = extractBashBlocks(body);
  // Routing is model-only, so an executable invocation always names a flow:
  // `run <flow> --goal ...`. (The old flowless `run --goal` form is gone.)
  const binInvocation = /^\s*\.\/bin\/circuit run [a-z]+ --goal(?:\s|$)/;
  const nodeInvocation = /^\s*node dist\/cli\/circuit\.js run [a-z]+ --goal(?:\s|$)/;
  const claudePluginInvocation = new RegExp(
    `^\\s*${CLAUDE_WRAPPER_PATTERN} present run [a-z]+ --goal(?:\\s|$)`,
  );
  for (const block of blocks) {
    for (const line of block.split('\n')) {
      if (
        binInvocation.test(line) ||
        nodeInvocation.test(line) ||
        claudePluginInvocation.test(line)
      ) {
        return true;
      }
    }
  }
  return false;
}

describe('plugin command invocation binding', () => {
  describe('real command bodies - positive assertions', () => {
    const runBody = readFileSync(RUN_COMMAND_PATH, 'utf-8');

    it('plugins/claude/commands/run.md has an executable router invocation in a fenced bash block with --goal', () => {
      expect(hasExecutableRouterInvocation(runBody)).toBe(true);
    });

    it('plugins/claude/commands/run.md carries explicit flow invocation examples for routed work', () => {
      expect(hasExecutableExploreInvocation(runBody)).toBe(true);
      expect(hasExecutableReviewInvocation(runBody)).toBe(true);
      expect(hasExecutableBuildInvocation(runBody)).toBe(true);
    });

    it('run command uses the installed Claude plugin wrapper, not the repo-local launcher', () => {
      expect(runBody).toContain('node "${CLAUDE_PLUGIN_ROOT}/scripts/circuit.ts"');
      expect(runBody).not.toMatch(/\.\/bin\/circuit/);
      expect(runBody).not.toMatch(/npm run circuit:run/);
      expect(runBody).not.toMatch(/dist\/cli\/runtime-proof\.js/);
    });

    it('does not publish routed-only flows as Claude command files', () => {
      for (const commandPath of ROUTED_ONLY_COMMAND_PATHS) {
        expect(existsSync(commandPath), commandPath).toBe(false);
      }
    });
  });

  describe('HIGH 2 regression: --goal value is single-quoted', () => {
    const runBody = readFileSync(RUN_COMMAND_PATH, 'utf-8');

    it('run command does not contain the unsafe --goal "$ARGUMENTS" double-quoted splice', () => {
      expect(runBody).not.toMatch(/--goal "\$ARGUMENTS"/);
    });

    it('all fenced bash invocation blocks in plugins/claude/commands/run.md use single-quoted --goal values', () => {
      const blocks = extractBashBlocks(runBody).filter(
        (b) =>
          /(?:\.\/bin\/circuit|node dist\/cli\/circuit\.js|node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/circuit\.ts")/.test(
            b,
          ) && /--goal/.test(b),
      );
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks) {
        expect(block).toMatch(/--goal\s+'/);
        expect(block).not.toMatch(/--goal\s+"/);
      }
    });

    it('run command documents the single-quote-with-escape rule for apostrophes', () => {
      expect(runBody).toMatch(/'\\''/);
    });

    it('all fenced bash invocation blocks in plugins/claude/commands/run.md use single-quoted --why values', () => {
      const blocks = extractBashBlocks(runBody).filter((b) => /--why/.test(b));
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks) {
        expect(block).toMatch(/--why\s+'/);
        expect(block).not.toMatch(/--why\s+"/);
      }
    });
  });

  describe('MED 1 negative fixtures: prose-only / classifier-pointer-only / negated bodies', () => {
    it('rejects a body that mentions the CLI only in prose', () => {
      const proseOnly = `---
name: circuit:explore
description: stub
---

The CLI ./bin/circuit is documented somewhere else; this body does not invoke it.
`;
      expect(hasExecutableExploreInvocation(proseOnly)).toBe(false);
    });

    it('rejects a body that only carries a classifier pointer without an invocation block', () => {
      const classifierOnly = `---
name: circuit:run
description: stub
---

# /circuit:run

The router classifier chooses explore or review. See /circuit:run for direct use.
`;
      expect(hasExecutableRouterInvocation(classifierOnly)).toBe(false);
    });

    it('rejects a body with a bash block that does not include an explore invocation', () => {
      const wrongBlock = `---
name: circuit:explore
description: stub
---

\`\`\`bash
echo "no invocation here"
\`\`\`
`;
      expect(hasExecutableExploreInvocation(wrongBlock)).toBe(false);
    });

    it('rejects review appearing only inside the goal text instead of as the flow token', () => {
      const wrongCompiledFlow = `---
name: circuit:review
description: stub
---

\`\`\`bash
./bin/circuit explore --goal 'review the latest change'
\`\`\`
`;
      expect(hasExecutableReviewInvocation(wrongCompiledFlow)).toBe(false);
    });

    it('accepts a body with a fenced bash block containing an explore invocation with --goal', () => {
      const goodBody = `---
name: circuit:explore
description: stub
---

\`\`\`bash
./bin/circuit run explore --goal 'find deprecated APIs'
\`\`\`
`;
      expect(hasExecutableExploreInvocation(goodBody)).toBe(true);
    });

    it('accepts a body using the compiled-JS path as the CLI identifier', () => {
      const compiledJsBody = `---
name: circuit:explore
description: stub
---

\`\`\`bash
node dist/cli/circuit.js run explore --goal 'find deprecated APIs'
\`\`\`
`;
      expect(hasExecutableExploreInvocation(compiledJsBody)).toBe(true);
    });
  });

  describe('manifest description consistency', () => {
    const manifestBody = readFileSync(MANIFEST_PATH, 'utf-8');
    const manifest = JSON.parse(manifestBody) as {
      name: string;
      description: string;
    };

    it('manifest name creates the public /circuit:* namespace', () => {
      expect(manifest.name).toBe('circuit');
    });

    it('manifest exposes run as the generated coding command, not direct flow commands', () => {
      expect(manifest.description).toMatch(/\/circuit:run/);
      expect(manifest.description).not.toMatch(
        /\/circuit:(?:explore|review|build|fix|prototype|goal)/,
      );
    });
  });
});
