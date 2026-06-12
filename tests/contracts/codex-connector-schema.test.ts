import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CODEX_EXECUTABLE,
  CODEX_FORBIDDEN_ARGV_TOKENS,
  CODEX_REASONING_EFFORT_CONFIG_KEY,
  CODEX_SUPPORTED_EFFORTS,
  CODEX_WRITE_FLAGS,
  type CodexRelayResult,
  assertCodexSpawnArgvBoundary,
  buildCodexArgs,
  parseCodexStdout,
} from '../../src/connectors/codex.js';

const HAPPY_PATH_FIXTURE = resolve('tests/fixtures/codex-smoke/protocol/happy-path-ok.jsonl');
const TURN_FAILED_FIXTURE = resolve('tests/fixtures/codex-smoke/protocol/turn-failed.jsonl');

// Codex connector contract tests. Mirrors the claude-code connector
// contract test shape. Three concerns:
//   (A) `src/connectors/codex.ts` module shape + capability-
//       boundary argv-constant invariants.
//   (B) `parseCodexStdout` NDJSON parser branches (happy path + each
//       fail-closed assertion).
//   (C) Cross-connector parity — both connectors produce the same
//       `RelayResult` shape so the runtime relay executor
//       (src/runtime/executors/relay.ts) consumes them interchangeably
//       (the connector descriptor on the relay trace entries records
//       identity, not the result shape).
//
// Import-level connector discipline coverage for `codex.ts` is
// exercised by the live-repo regression guard in the claude-code
// connector suite; adding a new connector file cannot smuggle a
// forbidden SDK because the
// scan pattern walks the tree recursively.

// ---- (A) module shape + capability-boundary argv-constant invariants ---

describe('Codex connector — src/connectors/codex.ts module shape', () => {
  it('exports CODEX_EXECUTABLE as "codex"', () => {
    expect(CODEX_EXECUTABLE).toBe('codex');
  });

  it('CODEX_WRITE_FLAGS places "-s" immediately followed by "workspace-write"', () => {
    // The argv-constant assertion relies on `-s workspace-write` appearing as
    // a contiguous pair so Codex's argv parser receives them as a
    // single --sandbox policy declaration. A regression that separated
    // the two (e.g. flag reorder that shoved a different flag between)
    // would silently leave `-s` dangling and Codex might default to a
    // different policy.
    const flags = [...CODEX_WRITE_FLAGS];
    const sIdx = flags.indexOf('-s');
    expect(sIdx).toBeGreaterThanOrEqual(0);
    expect(flags[sIdx + 1]).toBe('workspace-write');
  });

  it('CODEX_WRITE_FLAGS includes the connector-owned execution flags', () => {
    expect(CODEX_WRITE_FLAGS).toContain('--json');
    expect(CODEX_WRITE_FLAGS).toContain('--ephemeral');
    expect(CODEX_WRITE_FLAGS).toContain('--skip-git-repo-check');
    expect(CODEX_WRITE_FLAGS).toContain('--ignore-user-config');
    expect(CODEX_WRITE_FLAGS).toContain('--ignore-rules');
  });

  it('CODEX_WRITE_FLAGS contains exactly 8 tokens (pinned surface — additions require contract-test update)', () => {
    // Authoring note: an exact-length pin so that
    // adding ANY new token to CODEX_WRITE_FLAGS — even an ostensibly
    // harmless one — forces a contract-test update alongside, which
    // forces reviewer attention on whether the new token widens the
    // capability surface. Without this pin, adding `--full-auto` would
    // pass all named negative checks but miss the length check.
    expect([...CODEX_WRITE_FLAGS]).toHaveLength(8);
  });

  it('CODEX_WRITE_FLAGS does NOT contain --dangerously-bypass-approvals-and-sandbox', () => {
    // Capability-boundary anchor. If this flag ever enters the constant,
    // Codex runs outside the connector-owned sandbox and the boundary claim
    // collapses.
    expect([...CODEX_WRITE_FLAGS]).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('CODEX_WRITE_FLAGS does NOT contain --full-auto or --add-dir (widening aliases)', () => {
    // `--full-auto` changes approvals/sandbox outside the pinned contract;
    // `--add-dir` extends writable directories.
    const flags = [...CODEX_WRITE_FLAGS];
    expect(flags).not.toContain('--full-auto');
    expect(flags).not.toContain('--add-dir');
  });

  it('CODEX_WRITE_FLAGS does NOT contain -o / --output-last-message (CLI-side write path)', () => {
    // Authoring note: Codex's `-o <FILE>` writes the
    // final message to a caller-chosen path. Unlike shell writes from
    // inside the model, `-o` is a CLI wrapper write that bypasses the
    // connector-owned workspace because it runs in the Codex CLI
    // process itself.
    const flags = [...CODEX_WRITE_FLAGS];
    expect(flags).not.toContain('-o');
    expect(flags).not.toContain('--output-last-message');
  });

  it('CODEX_WRITE_FLAGS does NOT contain -c / --config / -p / --profile (config-layer bypass)', () => {
    // Authoring note: `-c sandbox_mode="danger-full-access"`
    // or a profile loaded via `-p name` can widen capability at the config
    // layer while `-s workspace-write` still appears in argv. The final argv
    // assertion permits only the connector-owned effort override.
    const flags = [...CODEX_WRITE_FLAGS];
    expect(flags).not.toContain('-c');
    expect(flags).not.toContain('--config');
    expect(flags).not.toContain('-p');
    expect(flags).not.toContain('--profile');
  });

  it('CODEX_WRITE_FLAGS starts with the "exec" subcommand', () => {
    // If `exec` drifts to a later position or disappears, the
    // subprocess is no longer running the non-interactive exec mode
    // and the `--json` stream semantics do not apply.
    expect([...CODEX_WRITE_FLAGS][0]).toBe('exec');
  });

  it('CODEX_FORBIDDEN_ARGV_TOKENS enumerates the argv surfaces that bypass the connector boundary', () => {
    // Authoring note: the exported forbidden-token set
    // is the module-load runtime assertion's deny-list. Every surface
    // listed here has been empirically (or documentary) shown to widen
    // the sandbox. A future regression that tries to smuggle one of
    // these into CODEX_WRITE_FLAGS fires the module-load throw.
    const forbidden = [...CODEX_FORBIDDEN_ARGV_TOKENS];
    expect(forbidden).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(forbidden).toContain('--full-auto');
    expect(forbidden).toContain('--add-dir');
    expect(forbidden).toContain('-o');
    expect(forbidden).toContain('--output-last-message');
    expect(forbidden).toContain('-c');
    expect(forbidden).toContain('--config');
    expect(forbidden).toContain('-p');
    expect(forbidden).toContain('--profile');
    expect(forbidden).toContain('--sandbox');
    expect(forbidden.length).toBeGreaterThanOrEqual(10);
  });

  it('buildCodexArgs passes openai model and reasoning effort through the allowlisted config key', () => {
    const args = buildCodexArgs({
      prompt: 'hello',
      resolvedSelection: {
        model: { provider: 'openai', model: 'gpt-5.4' },
        effort: 'xhigh',
        skills: [],
        invocation_options: {},
      },
    });

    expect(args.slice(-5)).toEqual([
      '-m',
      'gpt-5.4',
      '-c',
      `${CODEX_REASONING_EFFORT_CONFIG_KEY}="xhigh"`,
      'hello',
    ]);
  });

  it('buildCodexArgs threads the runtime cwd through --cd before model and prompt args', () => {
    const args = buildCodexArgs({
      cwd: '/tmp/circuit-workspace',
      prompt: 'hello',
      resolvedSelection: {
        model: { provider: 'openai', model: 'gpt-5.5' },
        effort: 'xhigh',
        skills: [],
        invocation_options: {},
      },
    });

    expect(args).toEqual([
      ...CODEX_WRITE_FLAGS,
      '--cd',
      '/tmp/circuit-workspace',
      '-m',
      'gpt-5.5',
      '-c',
      `${CODEX_REASONING_EFFORT_CONFIG_KEY}="xhigh"`,
      'hello',
    ]);
  });

  it('buildCodexArgs rejects non-openai model providers instead of silently ignoring them', () => {
    expect(() =>
      buildCodexArgs({
        prompt: 'hello',
        resolvedSelection: {
          model: { provider: 'anthropic', model: 'claude-opus-4-7' },
          skills: [],
          invocation_options: {},
        },
      }),
    ).toThrow(/codex connector cannot honor model provider 'anthropic'/);
  });

  it('buildCodexArgs only emits the model_reasoning_effort config override', () => {
    const args = buildCodexArgs({
      prompt: 'hello',
      resolvedSelection: {
        effort: 'high',
        skills: [],
        invocation_options: {},
      },
    });
    const configIndex = args.indexOf('-c');
    expect(configIndex).toBeGreaterThanOrEqual(0);
    expect(args[configIndex + 1]).toBe(`${CODEX_REASONING_EFFORT_CONFIG_KEY}="high"`);
    expect(args[configIndex + 1]).not.toMatch(/sandbox|approval|profile|permissions/);
  });

  it('buildCodexArgs rejects effort tiers the Codex CLI cannot honor before spawn', () => {
    expect([...CODEX_SUPPORTED_EFFORTS]).toEqual(['low', 'medium', 'high', 'xhigh']);
    for (const effort of ['none', 'minimal', 'max'] as const) {
      expect(() =>
        buildCodexArgs({
          prompt: 'hello',
          resolvedSelection: {
            effort,
            skills: [],
            invocation_options: {},
          },
        }),
      ).toThrow(new RegExp(`codex connector cannot honor effort '${effort}'`));
    }
  });

  it('assertCodexSpawnArgvBoundary allows only one model_reasoning_effort -c override', () => {
    const safeArgs = [
      ...CODEX_WRITE_FLAGS,
      '-c',
      `${CODEX_REASONING_EFFORT_CONFIG_KEY}="high"`,
      'hello',
    ];
    expect(() => assertCodexSpawnArgvBoundary(safeArgs)).not.toThrow();
    expect(() =>
      assertCodexSpawnArgvBoundary([
        ...CODEX_WRITE_FLAGS,
        '-c',
        `${CODEX_REASONING_EFFORT_CONFIG_KEY}="high"`,
        '-c',
        `${CODEX_REASONING_EFFORT_CONFIG_KEY}="low"`,
        'hello',
      ]),
    ).toThrow(/at most one allowlisted -c override/);
    expect(() =>
      assertCodexSpawnArgvBoundary([
        ...CODEX_WRITE_FLAGS,
        '-c',
        'sandbox_mode="workspace-write"',
        'hello',
      ]),
    ).toThrow(/only model_reasoning_effort/);
  });

  it('assertCodexSpawnArgvBoundary rejects config/profile/sandbox rewidening tokens in final argv', () => {
    expect(() =>
      assertCodexSpawnArgvBoundary([
        ...CODEX_WRITE_FLAGS,
        '--config=sandbox_mode="workspace-write"',
        'hello',
      ]),
    ).toThrow(/forbidden argv token "--config=sandbox_mode/);
    expect(() =>
      assertCodexSpawnArgvBoundary([...CODEX_WRITE_FLAGS, '--profile', 'write-enabled', 'hello']),
    ).toThrow(/forbidden argv token "--profile"/);
    expect(() =>
      assertCodexSpawnArgvBoundary([...CODEX_WRITE_FLAGS, '--sandbox=workspace-write', 'hello']),
    ).toThrow(/forbidden argv token "--sandbox=workspace-write"/);
    expect(() =>
      assertCodexSpawnArgvBoundary([...CODEX_WRITE_FLAGS, '-s', 'read-only', 'hello']),
    ).toThrow(/exactly one "-s workspace-write"/);
  });
});

// ---- (B) parseCodexStdout parser branches -------------------------------

describe('Codex connector — parseCodexStdout NDJSON parser branches', () => {
  // Helper: build a well-formed codex `--json` stdout capturing a
  // single-turn relay. Caller can override any top-level field set.
  const ndjson = (overrides?: {
    threadId?: string;
    items?: Array<{ type: string; text?: string; id?: string }>;
    omitThreadStarted?: boolean;
    omitTurnCompleted?: boolean;
  }) => {
    const parts: string[] = [];
    if (!overrides?.omitThreadStarted) {
      parts.push(
        JSON.stringify({
          type: 'thread.started',
          thread_id: overrides?.threadId ?? 'thread-abc-123',
        }),
      );
    }
    parts.push(JSON.stringify({ type: 'turn.started' }));
    const items = overrides?.items ?? [
      { type: 'agent_message', id: 'item_0', text: 'final response body' },
    ];
    for (const [idx, it] of items.entries()) {
      parts.push(
        JSON.stringify({
          type: 'item.completed',
          item: { id: it.id ?? `item_${idx}`, type: it.type, text: it.text },
        }),
      );
    }
    if (!overrides?.omitTurnCompleted) {
      parts.push(
        JSON.stringify({
          type: 'turn.completed',
          usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 20 },
        }),
      );
    }
    return `${parts.join('\n')}\n`;
  };

  it('extracts receipt_id from thread.started, result_body from terminal agent_message, plumbs cli_version', () => {
    const stdout = ndjson();
    const parsed: CodexRelayResult = parseCodexStdout(
      stdout,
      'the prompt',
      42,
      'codex-cli 0.118.0',
    );
    expect(parsed.request_payload).toBe('the prompt');
    expect(parsed.receipt_id).toBe('thread-abc-123');
    expect(parsed.result_body).toBe('final response body');
    expect(parsed.duration_ms).toBe(42);
    expect(parsed.cli_version).toBe('codex-cli 0.118.0');
  });

  it('takes the LAST agent_message item when multiple are present (terminal semantics)', () => {
    const stdout = ndjson({
      items: [
        { type: 'agent_message', id: 'item_0', text: 'first' },
        { type: 'reasoning', id: 'item_1', text: 'thinking' },
        { type: 'agent_message', id: 'item_2', text: 'terminal' },
      ],
    });
    const parsed = parseCodexStdout(stdout, 'p', 0, 'codex-cli 0.118.0');
    expect(parsed.result_body).toBe('terminal');
  });

  it('accepts reasoning items alongside agent_message (known-type allowlist)', () => {
    const stdout = ndjson({
      items: [
        { type: 'reasoning', id: 'item_0', text: 'thought' },
        { type: 'agent_message', id: 'item_1', text: 'response' },
      ],
    });
    const parsed = parseCodexStdout(stdout, 'p', 0, 'codex-cli 0.118.0');
    expect(parsed.result_body).toBe('response');
  });

  it('accepts file_change items emitted by write-capable Codex before the terminal agent_message', () => {
    const stdout = ndjson({
      items: [
        { type: 'command_execution', id: 'item_0' },
        { type: 'file_change', id: 'item_1' },
        { type: 'agent_message', id: 'item_2', text: '{"verdict":"accept"}' },
      ],
    });
    const parsed = parseCodexStdout(stdout, 'p', 0, 'codex-cli 0.130.0');
    expect(JSON.parse(parsed.result_body)).toEqual({ verdict: 'accept' });
  });

  it('accepts todo_list items emitted by current Codex before the terminal agent_message', () => {
    const stdout = ndjson({
      items: [
        { type: 'todo_list', id: 'item_0' },
        { type: 'command_execution', id: 'item_1' },
        { type: 'file_change', id: 'item_2' },
        { type: 'agent_message', id: 'item_3', text: '{"verdict":"accept"}' },
      ],
    });
    const parsed = parseCodexStdout(stdout, 'p', 0, 'codex-cli 0.130.0');
    expect(JSON.parse(parsed.result_body)).toEqual({ verdict: 'accept' });
  });

  it('accepts Codex 0.128 item.updated trace_entries between item.started and item.completed', () => {
    // Regression for codex-cli 0.128 emitting `item.updated` as an
    // incremental progress beacon for a long-running command_execution.
    // The event type must pass the top-level allowlist, and the inner
    // item.type is gated by the same KNOWN_CODEX_ITEM_TYPES set as
    // item.completed so a novel protocol item type cannot smuggle in via the
    // update channel either.
    const stdout =
      `${JSON.stringify({ type: 'thread.started', thread_id: 'thread-128' })}\n` +
      `${JSON.stringify({ type: 'turn.started' })}\n` +
      `${JSON.stringify({
        type: 'item.started',
        item: {
          id: 'item_0',
          type: 'command_execution',
          command: 'cat large-file',
          status: 'in_progress',
        },
      })}\n` +
      `${JSON.stringify({
        type: 'item.updated',
        item: {
          id: 'item_0',
          type: 'command_execution',
          command: 'cat large-file',
          aggregated_output: 'partial chunk 1',
          status: 'in_progress',
        },
      })}\n` +
      `${JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_0',
          type: 'command_execution',
          command: 'cat large-file',
          aggregated_output: 'partial chunk 1\npartial chunk 2',
          exit_code: 0,
          status: 'completed',
        },
      })}\n` +
      `${JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_1',
          type: 'agent_message',
          text: 'OK',
        },
      })}\n` +
      `${JSON.stringify({ type: 'turn.completed' })}\n`;

    const parsed = parseCodexStdout(stdout, 'p', 0, 'codex-cli 0.128.0');
    expect(parsed.result_body).toBe('OK');
  });

  it('rejects an item.updated trace_entry whose item.type is not in the allowlist', () => {
    const stdout =
      `${JSON.stringify({ type: 'thread.started', thread_id: 'thread-128' })}\n` +
      `${JSON.stringify({ type: 'turn.started' })}\n` +
      `${JSON.stringify({
        type: 'item.updated',
        item: { id: 'item_0', type: 'apply_patch', status: 'in_progress' },
      })}\n` +
      `${JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_1', type: 'agent_message', text: 'OK' },
      })}\n` +
      `${JSON.stringify({ type: 'turn.completed' })}\n`;
    expect(() => parseCodexStdout(stdout, 'p', 0, 'codex-cli 0.128.0')).toThrow(
      /capability-boundary violation.*item\.updated.*apply_patch.*not in the known-types allowlist/,
    );
  });

  it('accepts Codex 0.125 command_execution start/completion events before the terminal agent message', () => {
    const stdout =
      `${JSON.stringify({ type: 'thread.started', thread_id: 'thread-abc-123' })}\n` +
      `${JSON.stringify({ type: 'turn.started' })}\n` +
      `${JSON.stringify({
        type: 'item.started',
        item: {
          id: 'item_0',
          type: 'command_execution',
          command: 'pwd',
          status: 'in_progress',
        },
      })}\n` +
      `${JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_0',
          type: 'command_execution',
          command: 'pwd',
          aggregated_output: '/tmp/project',
          exit_code: 0,
          status: 'completed',
        },
      })}\n` +
      `${JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'item_1',
          type: 'agent_message',
          text: '{"verdict":"NO_ISSUES_FOUND","findings":[]}',
        },
      })}\n` +
      `${JSON.stringify({ type: 'turn.completed' })}\n`;

    const parsed = parseCodexStdout(stdout, 'p', 0, 'codex-cli 0.125.0');
    expect(JSON.parse(parsed.result_body)).toEqual({
      verdict: 'NO_ISSUES_FOUND',
      findings: [],
    });
  });

  it('throws on empty stdout', () => {
    expect(() => parseCodexStdout('', 'p', 0, 'codex-cli 0.118.0')).toThrow(
      /codex --json stdout is empty/,
    );
  });

  it('throws on malformed NDJSON line', () => {
    const stdout = `not-json\n${JSON.stringify({ type: 'turn.completed' })}\n`;
    expect(() => parseCodexStdout(stdout, 'p', 0, 'codex-cli 0.118.0')).toThrow(
      /is not valid JSON/,
    );
  });

  it('throws when thread.started is missing', () => {
    const stdout = ndjson({ omitThreadStarted: true });
    expect(() => parseCodexStdout(stdout, 'p', 0, 'codex-cli 0.118.0')).toThrow(
      /thread\.started trace_entry missing/,
    );
  });

  it('throws when thread.started.thread_id is empty', () => {
    const stdout = ndjson({ threadId: '' });
    expect(() => parseCodexStdout(stdout, 'p', 0, 'codex-cli 0.118.0')).toThrow(
      /thread_id missing or empty/,
    );
  });

  it('throws when turn.completed is missing', () => {
    const stdout = ndjson({ omitTurnCompleted: true });
    expect(() => parseCodexStdout(stdout, 'p', 0, 'codex-cli 0.118.0')).toThrow(
      /turn\.completed trace_entry missing/,
    );
  });

  it('throws when no agent_message item is present', () => {
    const stdout = ndjson({
      items: [{ type: 'reasoning', id: 'item_0', text: 'only thinking' }],
    });
    expect(() => parseCodexStdout(stdout, 'p', 0, 'codex-cli 0.118.0')).toThrow(
      /no item\.completed\/agent_message trace_entry found/,
    );
  });

  it('throws on unknown item.type — capability-boundary allowlist', () => {
    const stdout = ndjson({
      items: [
        { type: 'agent_message', id: 'item_0', text: 'ok' },
        { type: 'apply_patch', id: 'item_1' },
      ],
    });
    expect(() => parseCodexStdout(stdout, 'p', 0, 'codex-cli 0.118.0')).toThrow(
      /capability-boundary violation.*apply_patch.*not in the known-types allowlist/,
    );
  });

  it('throws when agent_message item.text is missing', () => {
    const stdout = ndjson({
      items: [{ type: 'agent_message', id: 'item_0' }],
    });
    expect(() => parseCodexStdout(stdout, 'p', 0, 'codex-cli 0.118.0')).toThrow(
      /agent_message item\.text missing/,
    );
  });
});

// ---- (B2) real Codex 0.118 JSONL fixtures (HIGH 5 fold-in) -------------

describe('Codex connector — parseCodexStdout against real Codex 0.118 JSONL fixtures', () => {
  it('parses the real happy-path-ok.jsonl fixture from codex CLI 0.118.0', () => {
    // Fixture source: captured via `codex exec --json -s read-only
    // --ephemeral --skip-git-repo-check "Respond with exactly the
    // single word: OK"` at codex-cli 0.118.0, commit e693441. The
    // fixture is the exact stdout bytes the real subprocess produced
    // — no compose, no normalization. Authoring note.
    const stdout = readFileSync(HAPPY_PATH_FIXTURE, 'utf-8');
    const parsed = parseCodexStdout(stdout, 'any prompt', 1234, 'codex-cli 0.118.0');
    expect(parsed.receipt_id).toMatch(/^[0-9a-f-]{30,}$/); // uuid-like thread id
    expect(parsed.result_body).toBe('OK');
    expect(parsed.cli_version).toBe('codex-cli 0.118.0');
  });

  it('rejects the turn-failed.jsonl fixture with a named "codex reported turn.failed" error', () => {
    // Failure-shape fixture modeled on the challenger's observed
    // no-network probe output (no-network probe shape): top-level
    // `error` and `turn.failed` trace_entries. Rejected with a named message
    // so relay callers see a legible cause rather than "missing
    // turn.completed" and guessing.
    const stdout = readFileSync(TURN_FAILED_FIXTURE, 'utf-8');
    expect(() => parseCodexStdout(stdout, 'any prompt', 0, 'codex-cli 0.118.0')).toThrow(
      /codex reported (error|turn\.failed)/,
    );
  });

  it('rejects an unknown top-level trace_entry type (connector-level capability-boundary allowlist)', () => {
    // Synthesized: a future Codex CLI version might emit a novel
    // top-level trace_entry we have not reviewed. The connector refuses to
    // admit it rather than silently forward it.
    const stdout =
      `${JSON.stringify({ type: 'thread.started', thread_id: 't' })}\n` +
      `${JSON.stringify({ type: 'novel.future.trace_entry', foo: 'bar' })}\n` +
      `${JSON.stringify({ type: 'turn.completed' })}\n`;
    expect(() => parseCodexStdout(stdout, 'p', 0, 'codex-cli 0.118.0')).toThrow(
      /unknown top-level trace_entry type 'novel\.future\.trace_entry'/,
    );
  });

  it('rejects an trace_entry without a string type field', () => {
    const stdout =
      `${JSON.stringify({ type: 'thread.started', thread_id: 't' })}\n` +
      `${JSON.stringify({ kind: 'malformed' })}\n`;
    expect(() => parseCodexStdout(stdout, 'p', 0, 'codex-cli 0.118.0')).toThrow(
      /trace_entry has no string 'type' field/,
    );
  });
});

// ---- (C) cross-connector shape parity ------------------------------------

describe('Codex connector — cross-connector shape parity (RelayResult uniformity)', () => {
  it('CodexRelayResult has the same field set as the shared RelayResult', async () => {
    // Structural assertion: both connectors' result types alias the shared
    // `RelayResult` from `src/shared/connector-relay.ts`, so the runtime
    // relay executor can consume them without branching on
    // connector name. The field set is fixed at 5 fields:
    //   request_payload, receipt_id, result_body, duration_ms, cli_version.
    // If a future slice adds a field to one connector only, this test
    // becomes the forcing function to either (a) extend the shared shape,
    // (b) keep the field connector-private.
    const stdout = `${JSON.stringify({ type: 'thread.started', thread_id: 't' })}\n${JSON.stringify({ type: 'item.completed', item: { id: 'i', type: 'agent_message', text: 'x' } })}\n${JSON.stringify({ type: 'turn.completed' })}\n`;
    const result = parseCodexStdout(stdout, 'p', 1, 'codex-cli 0.0.0');
    expect(Object.keys(result).sort()).toEqual(
      ['cli_version', 'duration_ms', 'receipt_id', 'request_payload', 'result_body'].sort(),
    );
  });
});
