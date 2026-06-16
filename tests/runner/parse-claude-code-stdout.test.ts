import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { parseClaudeCodeStdout } from '../../src/connectors/claude-code.js';

// A REAL claude CLI stdout stream (v2.1.178), captured by running the fix-act
// argv: `--tools Read,Grep,Glob,Edit,Write,Bash … --json-schema <object schema>`.
// Its init.tools is the allow-list PLUS the CLI's framework-injected
// `StructuredOutput` return-channel tool. This fixture is the ground truth the
// earlier guard tests lacked: they hand-built init.tools WITHOUT StructuredOutput,
// which is exactly what let the enforced-scope-vs-structured-output defect ship.
const REAL_JSON_SCHEMA_WITH_TOOLS_STREAM = readFileSync(
  new URL('../fixtures/claude-code/json-schema-with-tools.stream.jsonl', import.meta.url),
  'utf8',
);
const FIX_ACT_ALLOW_LIST = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'];

function buildInitLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: 'session-abc',
    claude_code_version: '2.1.139',
    mcp_servers: [],
    slash_commands: [],
    ...overrides,
  });
}

function successResultLine(): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '{"ok":true}',
  });
}

describe('parseClaudeCodeStdout — structured_output precedence', () => {
  it('uses result.structured_output when the schema-piping path is in effect', () => {
    const init = buildInitLine();
    const result = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'I have submitted the structured output.',
      structured_output: {
        verdict: 'accept',
        sources: [{ kind: 'file', ref: 'a.ts', summary: 'a' }],
        observations: ['o1'],
        open_questions: [],
      },
    });
    const stdout = `${init}\n${result}\n`;

    const parsed = parseClaudeCodeStdout(stdout, 'prompt', 1);

    expect(JSON.parse(parsed.result_body)).toEqual({
      verdict: 'accept',
      sources: [{ kind: 'file', ref: 'a.ts', summary: 'a' }],
      observations: ['o1'],
      open_questions: [],
    });
  });

  it('uses result.structured_output even when result.result is the empty string', () => {
    const init = buildInitLine();
    const result = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '',
      structured_output: { verdict: 'accept', count: 0 },
    });
    const stdout = `${init}\n${result}\n`;

    const parsed = parseClaudeCodeStdout(stdout, 'prompt', 1);

    expect(JSON.parse(parsed.result_body)).toEqual({ verdict: 'accept', count: 0 });
  });

  it('falls back to result.result when structured_output is absent', () => {
    const init = buildInitLine();
    const result = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '{"verdict":"accept","note":"plain"}',
    });
    const stdout = `${init}\n${result}\n`;

    const parsed = parseClaudeCodeStdout(stdout, 'prompt', 1);

    expect(JSON.parse(parsed.result_body)).toEqual({ verdict: 'accept', note: 'plain' });
  });

  it('rejects structured_output that is not an object', () => {
    const init = buildInitLine();
    const result = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '',
      structured_output: 'not-an-object',
    });
    const stdout = `${init}\n${result}\n`;

    expect(() => parseClaudeCodeStdout(stdout, 'prompt', 1)).toThrow(
      /structured_output present but not an object/,
    );
  });
});

describe('parseClaudeCodeStdout — equipment-scope honesty guard', () => {
  it('accepts an init whose tools exactly match the requested allow-list', () => {
    const init = buildInitLine({ tools: ['Read', 'Edit'] });
    const stdout = `${init}\n${successResultLine()}\n`;
    expect(() => parseClaudeCodeStdout(stdout, 'prompt', 1, ['Read', 'Edit'])).not.toThrow();
  });

  it('accepts an init whose tools are a SUBSET of the requested allow-list (more restrictive is fine)', () => {
    const init = buildInitLine({ tools: ['Read'] });
    const stdout = `${init}\n${successResultLine()}\n`;
    expect(() =>
      parseClaudeCodeStdout(stdout, 'prompt', 1, ['Read', 'Edit', 'Write']),
    ).not.toThrow();
  });

  it('throws when a tool outside the requested allow-list leaked into the session', () => {
    // A flag regression that silently widened the tool surface (e.g. --tools
    // stopped restricting) would surface a tool we never granted. That is the
    // exact safety violation the enforced tier exists to prevent.
    const init = buildInitLine({ tools: ['Read', 'Bash'] });
    const stdout = `${init}\n${successResultLine()}\n`;
    expect(() => parseClaudeCodeStdout(stdout, 'prompt', 1, ['Read'])).toThrow(/Bash/);
  });

  it('does not assert tools when no allow-list was requested (unrestricted by default)', () => {
    const init = buildInitLine({ tools: ['Read', 'Edit', 'Bash', 'WebFetch'] });
    const stdout = `${init}\n${successResultLine()}\n`;
    expect(() => parseClaudeCodeStdout(stdout, 'prompt', 1)).not.toThrow();
  });

  it('throws when init.tools contains a non-string entry under an allow-list (cannot verify it is in-scope)', () => {
    // A non-string tool entry means we cannot prove the surface stayed within
    // the allow-list. The guard must fail closed (treat it as a violation)
    // rather than silently drop it the way a type-narrowing filter would.
    const init = buildInitLine({ tools: ['Read', { name: 'Bash' }] });
    const stdout = `${init}\n${successResultLine()}\n`;
    expect(() => parseClaudeCodeStdout(stdout, 'prompt', 1, ['Read'])).toThrow(
      /enforced equipment scope violated/,
    );
  });
});

describe('parseClaudeCodeStdout — structured-output return channel under an enforced scope', () => {
  it('admits the CLI-injected StructuredOutput tool when --json-schema was emitted (real fix-act stream)', () => {
    // The regression: fix-act is enforced to [Read,Grep,Glob,Edit,Write,Bash] AND
    // produces a structured report, so the relay always passes --json-schema. The
    // real CLI then injects a `StructuredOutput` tool into the session. Before the
    // fix the guard read it as a leak and threw -> connector_failed, so fix-act
    // (the only enforced scope) failed on every real run. With the structured-output
    // signal threaded in, the framework return-channel tool is admitted.
    expect(() =>
      parseClaudeCodeStdout(
        REAL_JSON_SCHEMA_WITH_TOOLS_STREAM,
        'prompt',
        1,
        FIX_ACT_ALLOW_LIST,
        true,
      ),
    ).not.toThrow();
  });

  it('returns the structured_output payload from the real fix-act stream once admitted', () => {
    const parsed = parseClaudeCodeStdout(
      REAL_JSON_SCHEMA_WITH_TOOLS_STREAM,
      'prompt',
      1,
      FIX_ACT_ALLOW_LIST,
      true,
    );
    expect(JSON.parse(parsed.result_body)).toEqual({ verdict: 'accept', summary: 'Understood' });
  });

  it('still fails closed on StructuredOutput when --json-schema was NOT emitted (admission is gated, not blanket)', () => {
    // Defense in depth: StructuredOutput is admitted ONLY because we asked for it.
    // If it appeared without our flag, that is an unexpected surface change and the
    // guard must still fail closed.
    const init = buildInitLine({ tools: ['Read', 'StructuredOutput'] });
    const stdout = `${init}\n${successResultLine()}\n`;
    expect(() => parseClaudeCodeStdout(stdout, 'prompt', 1, ['Read'])).toThrow(/StructuredOutput/);
  });

  it('admits StructuredOutput but STILL throws on a genuine leak alongside it (boundary not weakened)', () => {
    // The fix admits exactly the framework return-channel tool — it does not
    // disable the guard. A real unlisted tool (WebFetch) leaking in must still fail
    // even while --json-schema is in effect, and the admitted framework tool must
    // not appear in the leak report.
    const init = buildInitLine({ tools: ['Read', 'StructuredOutput', 'WebFetch'] });
    const stdout = `${init}\n${successResultLine()}\n`;
    let error: Error | undefined;
    try {
      parseClaudeCodeStdout(stdout, 'prompt', 1, ['Read'], true);
    } catch (caught) {
      error = caught as Error;
    }
    expect(error).toBeDefined();
    expect(error?.message).toMatch(/WebFetch/);
    expect(error?.message).not.toMatch(/StructuredOutput/);
  });
});

describe('parseClaudeCodeStdout — usage extraction', () => {
  it('normalizes usage from the terminal result event', () => {
    const init = buildInitLine();
    const result = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '{"ok":true}',
      total_cost_usd: 0.0145286,
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 6024,
        cache_read_input_tokens: 17696,
        output_tokens: 39,
        cache_creation: { ephemeral_1h_input_tokens: 6024, ephemeral_5m_input_tokens: 0 },
      },
      modelUsage: {
        'claude-haiku-4-5-20251001': {
          inputTokens: 441,
          outputTokens: 13,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUSD: 0.000506,
        },
        'claude-haiku-4-5': {
          inputTokens: 10,
          outputTokens: 39,
          cacheReadInputTokens: 17696,
          cacheCreationInputTokens: 6024,
          costUSD: 0.0140226,
        },
      },
    });
    const stdout = `${init}\n${result}\n`;

    const parsed = parseClaudeCodeStdout(stdout, 'prompt', 1);

    // Token totals come from modelUsage (the true total, including helper
    // model calls), not the main-loop usage block.
    expect(parsed.usage?.input_tokens).toBe(451);
    expect(parsed.usage?.output_tokens).toBe(52);
    expect(parsed.usage?.cache_read_tokens).toBe(17696);
    expect(parsed.usage?.cache_creation_tokens).toBe(6024);
    expect(parsed.usage?.cache_creation_1h_tokens).toBe(6024);
    expect(parsed.usage?.total_cost_usd_reported).toBe(0.0145286);
    expect(parsed.usage?.models).toHaveLength(2);
  });

  it('leaves usage undefined when the result event has none, without failing the relay', () => {
    const init = buildInitLine();
    const result = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '{"ok":true}',
    });
    const stdout = `${init}\n${result}\n`;

    const parsed = parseClaudeCodeStdout(stdout, 'prompt', 1);

    expect(parsed.usage).toBeUndefined();
    expect(JSON.parse(parsed.result_body)).toEqual({ ok: true });
  });

  it('tolerates a malformed usage block instead of throwing', () => {
    const init = buildInitLine();
    const result = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '{"ok":true}',
      total_cost_usd: 'not-a-number',
      usage: { input_tokens: 'many', cache_creation: null },
      modelUsage: { 'claude-haiku-4-5': null },
    });
    const stdout = `${init}\n${result}\n`;

    const parsed = parseClaudeCodeStdout(stdout, 'prompt', 1);

    expect(parsed.usage).toBeDefined();
    expect(parsed.usage?.input_tokens).toBe(0);
    expect(parsed.usage?.total_cost_usd_reported).toBeUndefined();
    expect(parsed.usage?.models).toBeUndefined();
  });

  it('normalizes an empty modelUsage key so the strict trace schema cannot reject it', () => {
    // RelayUsageEvidence requires a non-empty model id; a schema rejection at
    // trace append would fail the relay, which observability must never do.
    const init = buildInitLine();
    const result = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '{"ok":true}',
      modelUsage: { '': { inputTokens: 5, outputTokens: 1 } },
    });
    const stdout = `${init}\n${result}\n`;

    const parsed = parseClaudeCodeStdout(stdout, 'prompt', 1);

    expect(parsed.usage?.models?.[0]?.model).toBe('unknown');
  });
});
