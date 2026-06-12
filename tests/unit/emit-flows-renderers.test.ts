import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  renderClaudeHostCommand,
  renderCodexHostCommand,
  renderCodexHostSkill,
} from '../../scripts/flows/host-renderers.ts';

// Real command sources that the emitter renders into host plugin surfaces.
// HOST_DIRECT_COMMANDS in scripts/flows/emit.ts is ['handoff', 'run']; these
// are the only files that flow through renderCodexHostSkill, so grounding the
// renderer test on them keeps it aligned with what generation actually emits.
// Re-basing on the real sources (rather than a hand-written fixture) means a
// future edit to the command docs that breaks a renderer transform is caught
// here instead of slipping through against a fixture that never changes.
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const runSource = readFileSync(`${repoRoot}/src/commands/run.md`, 'utf8');
const handoffSource = readFileSync(`${repoRoot}/src/commands/handoff.md`, 'utf8');

// Synthetic source covering renderer branches the current real sources do not
// exercise: the `generated-only` HTML comment strip and the
// "Confirm working directory" -> "Resolve plugin root" instruction rewrite.
const syntheticCommandSource = `---
description: Runs Circuit Sample for a sample flow.
---

# /circuit:sample

<!-- generated-only note -->

The user's request is passed as the command input.

> **Argument:** $ARGUMENTS

## Instructions

1. **Confirm working directory.** The CLI is project-relative in source commands.
2. **Build a shell-safe invocation.**

\`\`\`bash
./bin/circuit run --goal 'sample' --progress jsonl
\`\`\`

Use the Bash tool to execute the constructed command. \`node "\${CLAUDE_PLUGIN_ROOT}/scripts/circuit.ts"\`
   is the installed wrapper for \`dist/cli/circuit.js\`.

3. **Render progress** from stderr and parse final JSON from stdout.

## Authority

- \`src/cli/circuit.ts\`
`;

describe('emit-flows host renderers (real command sources)', () => {
  it('renders the real run command for Claude through the presentation wrapper', () => {
    const rendered = renderClaudeHostCommand(runSource);

    // ./bin/circuit is rewritten to the installed Claude plugin wrapper.
    expect(rendered).not.toContain('./bin/circuit');
    expect(rendered).toContain('${CLAUDE_PLUGIN_ROOT}');
    // run is rewritten to the present-mode invocation (routing is model-only,
    // so the example always names a flow).
    expect(rendered).toMatch(/present run [a-z]+ --goal/);
    // The presentation instruction block replaces the raw progress step.
    expect(rendered).toContain('Let the presentation wrapper render output');
    // HTML comments are stripped from generated output.
    expect(rendered).not.toContain('<!--');
    // The source-authority footer cites repo paths that do not exist in an
    // installed plugin, so it is stripped from the host command mirror.
    expect(rendered).not.toContain('## Authority');
    expect(rendered).not.toContain('`src/cli/circuit.ts`');
  });

  it('renders the real run command for Codex with plugin-root wording and JSONL intact', () => {
    const rendered = renderCodexHostCommand(runSource);

    expect(rendered).not.toContain('./bin/circuit');
    expect(rendered).toContain("node '<plugin root>/scripts/circuit.ts'");
    // Codex keeps raw JSONL progress (no presentation wrapper).
    expect(rendered).toContain('--progress jsonl');
    expect(rendered).not.toContain('<!--');
    // The source-authority footer is stripped from the Codex command mirror too.
    expect(rendered).not.toContain('## Authority');
    expect(rendered).not.toContain('`src/cli/circuit.ts`');
  });

  it('renders the real run source into a Codex skill with no slash-command surface', () => {
    const rendered = renderCodexHostSkill('run', runSource);

    expect(rendered).toContain('name: run');
    expect(rendered).toContain('## Use Case');
    expect(rendered).toContain("Use the user's current request as the command input.");
    // The skill must not leak any slash-command placeholders or the Authority
    // section; assertCodexHostSkillHasNoCommandPlaceholders enforces this and
    // would throw before returning if any survived.
    expect(rendered).not.toContain('$ARGUMENTS');
    expect(rendered).not.toContain('/circuit:');
    expect(rendered).not.toContain('## Authority');
  });

  it('renders the real handoff source into a Codex skill', () => {
    const rendered = renderCodexHostSkill('handoff', handoffSource);

    expect(rendered).toContain('name: handoff');
    expect(rendered).not.toContain('$ARGUMENTS');
    expect(rendered).not.toContain('/circuit:');
    expect(rendered).not.toContain('## Authority');
  });
});

describe('emit-flows host renderers (synthetic source branches)', () => {
  it('rewrites the source instruction block to the plugin-root resolution wording', () => {
    const rendered = renderClaudeHostCommand(syntheticCommandSource);

    expect(rendered).not.toContain('generated-only note');
    expect(rendered).toContain('Resolve plugin root');
    expect(rendered).toContain(
      'node "${CLAUDE_PLUGIN_ROOT}/scripts/circuit.ts" present run --goal',
    );
    expect(rendered).not.toContain('--progress jsonl');
    expect(rendered).toContain('Let the presentation wrapper render output');
    expect(rendered).not.toContain('## Authority');
    expect(rendered).not.toContain('`src/cli/circuit.ts`');
  });

  it('rewrites the Codex instruction block to plugin-root wording with JSONL intact', () => {
    const rendered = renderCodexHostCommand(syntheticCommandSource);

    expect(rendered).not.toContain('generated-only note');
    expect(rendered).toContain('Resolve plugin root');
    expect(rendered).toContain("node '<plugin root>/scripts/circuit.ts' run --goal");
    expect(rendered).toContain('--progress jsonl');
    expect(rendered).not.toContain('## Authority');
    expect(rendered).not.toContain('`src/cli/circuit.ts`');
  });

  it('renders a Codex skill without slash-command placeholders', () => {
    const rendered = renderCodexHostSkill('sample', syntheticCommandSource);

    expect(rendered).toContain('name: sample');
    expect(rendered).toContain('description: "Runs Circuit Sample for a sample flow."');
    expect(rendered).toContain('## Use Case');
    expect(rendered).toContain("Use the user's current request as the command input.");
    expect(rendered).not.toContain('$ARGUMENTS');
    expect(rendered).not.toContain('/circuit:');
    expect(rendered).not.toContain('slash command');
    expect(rendered).not.toContain('## Authority');
  });
});
