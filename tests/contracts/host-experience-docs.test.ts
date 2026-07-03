import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EnabledConnector } from '../../src/schemas/connector.js';

const REPO_ROOT = resolve(__dirname, '..', '..');

describe('host experience docs', () => {
  it('defines shared host capability slots for Codex and Claude Code', () => {
    const doc = readFileSync(resolve(REPO_ROOT, 'docs/contracts/host-capabilities.md'), 'utf8');

    for (const capability of [
      'progress',
      'task_list',
      'ask_user',
      'final_summary',
      'deep_links',
      'debug',
    ]) {
      expect(doc).toContain(`\`${capability}\``);
    }

    expect(doc).toContain('Codex');
    expect(doc).toContain('Claude Code');
    expect(doc).toContain('native');
    expect(doc).toContain('model-mediated');
    expect(doc).toContain('fallback');
    expect(doc).toContain('AskUserQuestion');
    expect(doc).toContain('TodoWrite');
    expect(doc).toContain('current roadmap');
    expect(doc).toContain('operator_summary_markdown_path');
  });

  it('keeps native adapter notes out of current product surfaces', () => {
    const doc = readFileSync(resolve(REPO_ROOT, 'docs/contracts/native-host-adapters.md'), 'utf8');

    expect(doc).toContain('contract: native-host-adapters');
    expect(doc).toContain('status: non-shipping');
    expect(doc).toMatch(/not current product\s+surfaces/);
    expect(doc).toContain('release truth must not list them as capabilities');
    expect(doc).toContain('task_list.updated');
    expect(doc).toContain('user_input.requested');
    expect(doc).toContain('Claude Agent SDK');
    expect(doc).toContain('AskUserQuestion');
    expect(doc).toContain('TodoWrite');
    expect(doc).toContain('Codex App Server');
    expect(doc).toContain('tool/requestUserInput');
    expect(doc).toContain('Current Circuit host support');
  });

  it('documents the Claude presentation wrapper and Explore visible budget', () => {
    const doc = readFileSync(
      resolve(REPO_ROOT, 'docs/specs/narration-display-profiles.md'),
      'utf8',
    );

    expect(doc).toContain('Claude host commands must use a presentation wrapper');
    expect(doc).toContain('Flow profiles provide semantic atoms');
    expect(doc).toContain('structured slots');
    expect(doc).toContain('no raw JSONL');
    expect(doc).toContain('no final stdout JSON');
    expect(doc).toContain('no report section by default');
    expect(doc).toContain('max 4-6 visible final bullets');
    expect(doc).toContain('max 3 visible reviewer cautions');
    expect(doc).toContain('`/circuit:run`');
  });

  it('keeps a repeatable Codex and Claude Code host trial checklist', () => {
    const doc = readFileSync(resolve(REPO_ROOT, 'docs/host-trial-checklist.md'), 'utf8');

    expect(doc).toContain(
      '/circuit:run the checkout total is wrong when discounts and tax both apply',
    );
    expect(doc).toContain('/circuit:run please review my current diff');
    expect(doc).toContain('/circuit:run add billing settings to the account page');
    expect(doc).toContain('/circuit:run decide: should we replace auth providers?');
    expect(doc).not.toContain('@Circuit');
    expect(doc).toContain('/circuit:run <natural task>');
    expect(doc).toContain('Run-selected Build');
    expect(doc).toContain('Checkpoint');
    expect(doc).toContain('Failure');
    expect(doc).toContain('Codex Scenarios');
    expect(doc).toContain('Claude Code Scenarios');
  });

  it('keeps /circuit:run host guidance aligned with model-mediated selection', () => {
    const doc = readFileSync(resolve(REPO_ROOT, 'plugins/claude/commands/run.md'), 'utf8');

    expect(doc).toContain('/circuit:run — default Circuit command');
    expect(doc).toContain('Recommend the flow before invoking the CLI');
    expect(doc).toContain('Circuit records the selected flow');
    expect(doc).toContain('node "${CLAUDE_PLUGIN_ROOT}/scripts/circuit.js" present run fix --goal');
    expect(doc).not.toContain('Do not classify the task yourself');
    expect(doc).toContain('Let the presentation wrapper render output');
    // The decider owns the why: when the host picks the flow it states its
    // one-line reason before invoking, so the operator can redirect in-thread.
    expect(doc).toContain('state the recommended flow and your one-line reason');
    // The operator's own stated reason travels separately, as --why on the
    // invocation, and is never invented by the host.
    expect(doc).toContain('pass it as `--why` after the goal');
    expect(doc).toContain('never invent one');

    // The Codex run skill renders output itself (no present wrapper), so it
    // parses the JSON. Routing is model-only, so it must treat router_reason as
    // a fixed placeholder and not present it as a CLI-derived rationale.
    const codexSkill = readFileSync(
      resolve(REPO_ROOT, 'plugins/codex/skills/run/SKILL.md'),
      'utf8',
    );
    expect(codexSkill).toContain('routing is model-only');
  });

  it('teaches one natural-language front door per host in the README', () => {
    const doc = readFileSync(resolve(REPO_ROOT, 'README.md'), 'utf8');
    const operatorGuide = readFileSync(resolve(REPO_ROOT, 'docs/operator-guide.md'), 'utf8');

    expect(doc).toContain(
      '/circuit:run the checkout total is wrong when discounts and tax both apply',
    );
    expect(doc).toContain('The process your coding agent follows');
    expect(doc).toMatch(/better working\s+environment/);
    expect(doc).toContain('Go from this:');
    expect(doc).toContain('To this:');
    expect(doc).not.toContain('@Circuit');
    expect(doc).toMatch(/Codex can recommend the right Circuit flow/);
    expect(doc).toContain('host/orchestrator behavior');
    expect(doc).toContain('worker connector behavior');
    expect(doc).toContain('docs/first-run.md');
    expect(doc).not.toContain('runtime_source');
    expect(doc).not.toContain('scripts/circuit.js');
    expect(doc).not.toContain('check:codex-plugin-cache');
    expect(doc).not.toContain('doctor');
    expect(doc).not.toMatch(/\b[Ww]orkflow(s)?\b/);

    expect(operatorGuide).not.toContain('old intent prefixes');
    expect(operatorGuide).not.toContain('develop:');
    expect(operatorGuide).toContain('Circuit records the selected flow');
  });

  it('keeps active Codex invocation docs on slash commands', () => {
    for (const file of [
      'README.md',
      'docs/operator-guide.md',
      'docs/configuration.md',
      'docs/first-run.md',
      'docs/host-trial-checklist.md',
      'plugins/codex/README.md',
      'plugins/codex/.codex-plugin/plugin.json',
    ]) {
      const doc = readFileSync(resolve(REPO_ROOT, file), 'utf8');
      expect(doc, file).not.toContain('@Circuit');
    }
  });

  it('links navigation doc references in the docs map', () => {
    const doc = readFileSync(resolve(REPO_ROOT, 'docs/README.md'), 'utf8');

    for (const linkedReference of [
      '[README.md](../README.md)',
      '[docs/repository-map.md](repository-map.md)',
      '[docs/first-run.md](first-run.md)',
      '[docs/operator-guide.md](operator-guide.md)',
      '[docs/configuration.md](configuration.md)',
      '[AGENTS.md](../AGENTS.md)',
      '[UBIQUITOUS_LANGUAGE.md](../UBIQUITOUS_LANGUAGE.md)',
      '[docs/generated-surfaces.md](generated-surfaces.md)',
    ]) {
      expect(doc).toContain(linkedReference);
    }

    const unlinkedDocReferences = doc.match(
      /`(?:README|AGENTS|CLAUDE|UBIQUITOUS_LANGUAGE|docs\/)[^`]*\.(?:md|json)`/g,
    );
    expect(unlinkedDocReferences).toBeNull();
  });

  it('keeps README connector names and custom protocol aligned with schemas and runtime', () => {
    const doc = readFileSync(resolve(REPO_ROOT, 'README.md'), 'utf8');

    for (const connector of EnabledConnector.options) {
      expect(doc).toContain(`**\`${connector}\`**`);
    }
    expect(doc).not.toContain('**`agent`**');
    expect(doc).toContain('stdin is ignored');
    expect(doc).toContain('inherits the Circuit process environment');
    expect(doc).toMatch(/not an\s+OS sandbox/);
  });
});
