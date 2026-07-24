import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  renderClaudeHostCommand,
  renderCodexHostCommand,
  renderCodexHostSkill,
} from '../../scripts/flows/host-renderers.ts';
import {
  MCP_TOOL_NAMES,
  McpPublicFlowV1,
  McpRunStateV1,
} from '../../src/hosts/codex-mcp/contracts.js';

const REPO_ROOT = resolve(__dirname, '..', '..');
const CLI_RUN_SOURCE = 'src/commands/run.md';
const MCP_RUN_SKILL_SOURCE = 'src/hosts/codex-mcp/run-skill.md';
const CLAUDE_RUN_COMMAND = 'plugins/claude/commands/run.md';
const CODEX_RUN_COMMAND = 'plugins/codex/commands/run.md';
const CODEX_RUN_SKILL = 'plugins/codex/skills/run/SKILL.md';

function readRepoFile(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

describe('Codex MCP Run skill', () => {
  it('routes only the Codex Run skill to its MCP-specific source', () => {
    expect(existsSync(resolve(REPO_ROOT, MCP_RUN_SKILL_SOURCE))).toBe(true);
    if (!existsSync(resolve(REPO_ROOT, MCP_RUN_SKILL_SOURCE))) return;

    const cliSource = readRepoFile(CLI_RUN_SOURCE);
    const mcpSource = readRepoFile(MCP_RUN_SKILL_SOURCE);

    expect(readRepoFile(CLAUDE_RUN_COMMAND)).toBe(renderClaudeHostCommand(cliSource));
    expect(readRepoFile(CODEX_RUN_COMMAND)).toBe(renderCodexHostCommand(cliSource));
    expect(readRepoFile(CODEX_RUN_SKILL)).toBe(mcpSource);
    expect(readRepoFile(CODEX_RUN_SKILL)).not.toBe(renderCodexHostSkill('run', cliSource));

    for (const toolName of MCP_TOOL_NAMES) {
      expect(readRepoFile(CLAUDE_RUN_COMMAND), toolName).not.toContain(toolName);
      expect(readRepoFile(CODEX_RUN_COMMAND), toolName).not.toContain(toolName);
    }
  });

  it('teaches the complete six-tool lifecycle without a shell fallback', () => {
    expect(existsSync(resolve(REPO_ROOT, MCP_RUN_SKILL_SOURCE))).toBe(true);
    if (!existsSync(resolve(REPO_ROOT, MCP_RUN_SKILL_SOURCE))) return;
    const skill = readRepoFile(MCP_RUN_SKILL_SOURCE);
    const compactSkill = skill.replace(/\s+/g, ' ');

    for (const toolName of MCP_TOOL_NAMES) {
      expect(skill, toolName).toContain(`\`${toolName}\``);
    }
    for (const flow of McpPublicFlowV1.options) {
      const title = `${flow[0]?.toUpperCase()}${flow.slice(1)}`;
      expect(skill, flow).toContain(`**${title}**`);
    }
    for (const state of McpRunStateV1.options) {
      expect(skill, state).toContain(`\`${state}\``);
    }

    expect(skill).toContain('### Explore tournament');
    expect(skill).toContain('### Prototype tournament');
    expect(skill).toContain('task restarted');
    expect(skill).toContain('checkpoint.token');
    expect(skill).toContain('choice.id');
    expect(skill).toContain('descriptions when present');
    expect(skill).toContain('recovery_required');
    expect(skill).toContain('final_report.schema');
    expect(skill).toContain('final_report.summary');
    expect(skill).toContain('final_report.data');
    expect(skill).toContain('web_search: "cached"');
    expect(skill).toContain('cached_web_search: true');
    expect(skill).toMatch(/query leaves the machine/i);
    // Four anchors for the target contract, one per decision the skill has to
    // get right: consent to relay tracked code, one pinned target, no path
    // subsets, and no pull-request fetch. Pinning every sentence of the section
    // made ordinary rewording a test failure without catching anything more.
    expect(compactSkill).toContain(
      'A direct user request to run Review on tracked workspace content is enough permission',
    );
    expect(compactSkill).toContain('Treat that selected target as the only code under review');
    expect(compactSkill).toContain(
      'If the request narrows a complete target to a file or directory subset, or excludes paths',
    );
    expect(compactSkill).toContain('Circuit cannot fetch a pull request');
    expect(compactSkill).not.toContain('may inspect nearby repository files');
    expect(readRepoFile(CLI_RUN_SOURCE).replace(/\s+/g, ' ')).toContain(
      'Do not remove a requested file or directory subset or path exclusion',
    );
    expect(compactSkill).toContain(
      'This includes starting, reconnecting, listing, reading progress, handling checkpoints, cancelling, recovering, and releasing the workspace.',
    );
    expect(skill).toContain('private MCP state files');
    expect(compactSkill).toContain(
      'An MCP error, timeout, restart, busy workspace, or uncertain launch is not permission to fall back.',
    );
    expect(compactSkill).toContain(
      "This boundary governs Circuit run control. It does not disable Codex's normal file and shell tools",
    );
    expect(compactSkill).toContain('Do not invoke another Circuit interface from this Run skill');
    expect(compactSkill).toContain(
      'Requests to create or generate custom flows are outside this skill',
    );

    for (const shellToken of [
      './bin/circuit',
      'scripts/circuit.js',
      '--progress jsonl',
      '--checkpoint-review',
      'Bash tool',
      '<plugin root>',
      '$ARGUMENTS',
      '/circuit:',
      'run_folder',
      'operator_summary_markdown_path',
      'result_path',
    ]) {
      expect(skill, shellToken).not.toContain(shellToken);
    }
  });
});
