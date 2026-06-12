import { describe, expect, it } from 'vitest';

import {
  buildClaudeCodeArgs as neutralBuildClaudeCodeArgs,
  CLAUDE_CODE_DISPATCH_FLAGS as neutralClaudeCodeDispatchFlags,
  CLAUDE_CODE_EXECUTABLE as neutralClaudeCodeExecutable,
  CLAUDE_CODE_SUPPORTED_EFFORTS as neutralClaudeCodeSupportedEfforts,
  parseClaudeCodeStdout as neutralParseClaudeCodeStdout,
  relayClaudeCode as neutralRelayClaudeCode,
} from '../../src/connectors/claude-code.js';
import {
  assertCodexSpawnArgvBoundary as neutralAssertCodexSpawnArgvBoundary,
  buildCodexArgs as neutralBuildCodexArgs,
  CODEX_EXECUTABLE as neutralCodexExecutable,
  CODEX_FORBIDDEN_ARGV_TOKENS as neutralCodexForbiddenArgvTokens,
  CODEX_REASONING_EFFORT_CONFIG_KEY as neutralCodexReasoningEffortConfigKey,
  CODEX_SUPPORTED_EFFORTS as neutralCodexSupportedEfforts,
  CODEX_WRITE_FLAGS as neutralCodexWriteFlags,
  parseCodexStdout as neutralParseCodexStdout,
  relayCodex as neutralRelayCodex,
} from '../../src/connectors/codex.js';
import { relayCustom as neutralRelayCustom } from '../../src/connectors/custom.js';

describe('connector relay exports', () => {
  it('keeps connector exports bound to the implementation modules', () => {
    expect(neutralRelayClaudeCode).toEqual(expect.any(Function));
    expect(neutralParseClaudeCodeStdout).toEqual(expect.any(Function));
    expect(neutralBuildClaudeCodeArgs).toEqual(expect.any(Function));
    expect(neutralClaudeCodeDispatchFlags.length).toBeGreaterThan(0);
    expect(neutralClaudeCodeExecutable).toBe('claude');
    expect(neutralClaudeCodeSupportedEfforts).toContain('low');

    expect(neutralRelayCodex).toEqual(expect.any(Function));
    expect(neutralParseCodexStdout).toEqual(expect.any(Function));
    expect(neutralBuildCodexArgs).toEqual(expect.any(Function));
    expect(neutralAssertCodexSpawnArgvBoundary).toEqual(expect.any(Function));
    expect(neutralCodexWriteFlags.length).toBeGreaterThan(0);
    expect(neutralCodexForbiddenArgvTokens.length).toBeGreaterThan(0);
    expect(neutralCodexExecutable).toBe('codex');
    expect(neutralCodexReasoningEffortConfigKey).toBe('model_reasoning_effort');
    expect(neutralCodexSupportedEfforts).toContain('low');

    expect(neutralRelayCustom).toEqual(expect.any(Function));
  });
});
