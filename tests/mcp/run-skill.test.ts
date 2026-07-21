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

    expect(readRepoFile(CLAUDE_RUN_COMMAND)).not.toContain('circuit_start');
    expect(readRepoFile(CODEX_RUN_COMMAND)).not.toContain('circuit_start');
  });

  it('teaches the complete six-tool lifecycle without a shell fallback', () => {
    expect(existsSync(resolve(REPO_ROOT, MCP_RUN_SKILL_SOURCE))).toBe(true);
    if (!existsSync(resolve(REPO_ROOT, MCP_RUN_SKILL_SOURCE))) return;
    const skill = readRepoFile(MCP_RUN_SKILL_SOURCE);

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
    expect(skill).toContain('recovery_required');
    expect(skill).toContain('final_report.schema');
    expect(skill).toContain('final_report.summary');
    expect(skill).toContain('final_report.data');
    expect(skill).toContain('web_search: "cached"');
    expect(skill).toContain('cached_web_search: true');
    expect(skill).toMatch(/query leaves the machine/i);

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
