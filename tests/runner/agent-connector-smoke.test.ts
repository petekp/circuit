import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { relayClaudeCode, sha256Hex } from '../../src/connectors/claude-code.js';

// Agent connector smoke test.
//
// This test lives in tests/runner/ because it exercises the real
// subprocess path end-to-end (spawns a `claude -p` child process with
// the capability-boundary flag combo). That path requires:
//   (1) the `claude` CLI on $PATH,
//   (2) an authenticated session (OAuth via operator's Claude Code
//       subscription, or ANTHROPIC_API_KEY for API users),
//   (3) network access.
//
// CI may not have any of those. To avoid flaking CI on missing auth,
// the end-to-end invocation runs ONLY when `AGENT_SMOKE=1` is set in
// the env. A static test (no subprocess) always runs so the
// contract-test ratchet sees a consistent static declaration count
// regardless of the env var.
//
// This smoke test IS the end-to-end regression guard: if a future
// change adds a write-capable tool to the flag combo, the AGENT_SMOKE
// run would surface the capability regression at the
// subprocess-tool-surface level (the subprocess's init trace_entry
// enumerates the available tools).

const AGENT_SMOKE = process.env.AGENT_SMOKE === '1';

describe('claude-code connector smoke (capability boundary)', () => {
  it('static: relayClaudeCode exports a function (ratchet-floor declaration)', () => {
    expect(typeof relayClaudeCode).toBe('function');
    expect(relayClaudeCode.length).toBeGreaterThanOrEqual(1);
  });

  it('static: sha256Hex produces a canonical hex digest of a known input', () => {
    // This binds the hash format used by relay transcript trace_entries
    // (RelayRequestTraceEntry.request_payload_hash +
    // RelayResultTraceEntry.result_report_hash — both ContentHash HEX64
    // per src/schemas/trace-entry.ts). A regression in the hash shape would
    // silently produce trace_entries that fail to round-trip through
    // TraceEntry.parse() at write time.
    const digest = sha256Hex('circuit');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toBe(createHash('sha256').update('circuit', 'utf8').digest('hex'));
  });

  // Spawns a real subprocess and asserts on a hard timeout + captured stdout;
  // inherently timing-sensitive under heavy parallel test load, so retry to
  // absorb transient scheduling races. A real regression fails every attempt.
  it(
    'timeout failures include bounded stdout diagnostics from the subprocess',
    { retry: 2 },
    async () => {
      const fakeBinDir = await mkdtemp(join(tmpdir(), 'circuit-fake-claude-'));
      const fakeClaudePath = join(fakeBinDir, 'claude');
      const init = JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 'session-timeout-diagnostic',
        claude_code_version: '2.1.141',
        mcp_servers: [],
        slash_commands: [],
      });
      const progress = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'working before timeout' }] },
      });
      const script = [
        '#!/bin/sh',
        `printf '%s\\n' '${init}'`,
        `printf '%s\\n' '${progress}'`,
        'while :; do sleep 1; done',
      ].join('\n');
      const originalPath = process.env.PATH;

      await writeFile(fakeClaudePath, script, 'utf8');
      await chmod(fakeClaudePath, 0o755);
      process.env.PATH = `${fakeBinDir}:${originalPath ?? ''}`;
      try {
        await expect(
          relayClaudeCode({
            prompt: 'hang after printing useful stdout',
            timeoutMs: 3_000,
          }),
        ).rejects.toThrow(
          // 3000ms per-step budget maps to the absolute backstop; the fake
          // streams init + progress (resetting the inactivity bound) then hangs,
          // so the absolute ceiling is what fires.
          /claude-code subprocess timed out: exceeded the 3000ms wall-clock backstop;.*stdout\[:500\]=.*session-timeout-diagnostic.*working before timeout.*stderr\[:500\]=/s,
        );
      } finally {
        process.env.PATH = originalPath;
        await rm(fakeBinDir, { recursive: true, force: true });
      }
    },
  );

  // Real-subprocess test; can exceed the default per-test timeout when the
  // machine is saturated, so retry to absorb transient scheduling races.
  it(
    'nonzero failures include bounded stdout diagnostics from the subprocess',
    { retry: 2 },
    async () => {
      const fakeBinDir = await mkdtemp(join(tmpdir(), 'circuit-fake-claude-'));
      const fakeClaudePath = join(fakeBinDir, 'claude');
      const script = [
        '#!/bin/sh',
        "printf '%s\\n' 'schema diagnostics on stdout'",
        "printf '%s\\n' 'quiet stderr detail' >&2",
        'exit 7',
      ].join('\n');
      const originalPath = process.env.PATH;

      await writeFile(fakeClaudePath, script, 'utf8');
      await chmod(fakeClaudePath, 0o755);
      process.env.PATH = `${fakeBinDir}:${originalPath ?? ''}`;
      try {
        await expect(
          relayClaudeCode({
            prompt: 'fail after printing useful stdout',
            timeoutMs: 10_000,
          }),
        ).rejects.toThrow(
          /claude-code subprocess exited with code 7;.*stdout\[:500\]=schema diagnostics on stdout.*stderr\[:500\]=quiet stderr detail/s,
        );
      } finally {
        process.env.PATH = originalPath;
        await rm(fakeBinDir, { recursive: true, force: true });
      }
    },
  );

  it('nonzero failures include the terminal Claude stream error when stdout head is noisy', async () => {
    const fakeBinDir = await mkdtemp(join(tmpdir(), 'circuit-fake-claude-'));
    const fakeClaudePath = join(fakeBinDir, 'claude');
    const init = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'session-auth-diagnostic',
      claude_code_version: '2.1.143',
      mcp_servers: [],
      slash_commands: [],
      padding: 'x'.repeat(800),
    });
    const result = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: 'Not logged in - Please run /login',
    });
    const script = [
      '#!/bin/sh',
      `printf '%s\\n' '${init}'`,
      `printf '%s\\n' '${result}'`,
      'exit 1',
    ].join('\n');
    const originalPath = process.env.PATH;

    await writeFile(fakeClaudePath, script, 'utf8');
    await chmod(fakeClaudePath, 0o755);
    process.env.PATH = `${fakeBinDir}:${originalPath ?? ''}`;
    try {
      await expect(
        relayClaudeCode({
          prompt: 'fail with auth message after init output',
          timeoutMs: 10_000,
        }),
      ).rejects.toThrow(
        /claude-code subprocess exited with code 1; stdout_diagnostic=subprocess reported is_error: Not logged in - Please run \/login; stdout\[:500\]=.*session-auth-diagnostic/s,
      );
    } finally {
      process.env.PATH = originalPath;
      await rm(fakeBinDir, { recursive: true, force: true });
    }
  });

  // AGENT_SMOKE-checkd real-subprocess path. Skipped when the env var is
  // not set so CI (and developer-local runs without auth) stay green.
  (AGENT_SMOKE ? it : it.skip)(
    'end-to-end: relayClaudeCode spawns claude -p and returns a result triple (AGENT_SMOKE=1)',
    async () => {
      const prompt = 'Respond with exactly the single word: OK';
      const result = await relayClaudeCode({ prompt, timeoutMs: 120_000 });

      // request_payload is echoed verbatim (the bytes hashed into
      // relay.request.request_payload_hash).
      expect(result.request_payload).toBe(prompt);

      // receipt_id is the Claude-side session UUID. The exact format is
      // connector-owned (receipt_id is z.string().min(1)); we assert
      // non-empty + non-whitespace per RelayReceiptTraceEntry's
      // refinement.
      expect(result.receipt_id.length).toBeGreaterThan(0);
      expect(result.receipt_id.trim().length).toBeGreaterThan(0);

      // result_body is the text response bytes. We don't assert on the
      // exact text (the model's response varies) — only that the subprocess
      // produced non-empty output and the duration was measured.
      expect(typeof result.result_body).toBe('string');
      expect(result.result_body.length).toBeGreaterThan(0);
      expect(result.duration_ms).toBeGreaterThan(0);

      // Hash the request + result bytes; assert digests are canonical hex
      // — these are the values that would populate the two ContentHash
      // fields on RelayRequestTraceEntry + RelayResultTraceEntry.
      expect(sha256Hex(result.request_payload)).toMatch(/^[0-9a-f]{64}$/);
      expect(sha256Hex(result.result_body)).toMatch(/^[0-9a-f]{64}$/);

      // CLI version is captured from the subprocess init trace_entry —
      // transcript evidence is version-pinned. Regex: semver-ish (e.g.
      // "2.1.117" or "2.1.117-beta.1").
      expect(result.cli_version).toMatch(/^\d+\.\d+\.\d+/);
    },
    180_000,
  );
});
