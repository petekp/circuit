import { describe, expect, it } from 'vitest';

import {
  CircuitCancelResponseV1,
  CircuitListResponseV1,
  CircuitRecoverResponseV1,
  CircuitResumeResponseV1,
  CircuitStartInputV1,
  CircuitStartResponseV1,
  CircuitStatusResponseV1,
  MCP_TOOL_INPUT_SCHEMAS,
  MCP_TOOL_NAMES,
  MCP_TOOL_RESPONSE_SCHEMAS,
  McpErrorResponseV1,
} from '../../src/hosts/codex-mcp/contracts.js';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-07-20T08:00:00.000Z';

const validInputs = {
  circuit_start: {
    flow: 'review',
    goal: 'Review the current change',
  },
  circuit_status: {
    run_id: RUN_ID,
  },
  circuit_resume: {
    run_id: RUN_ID,
    checkpoint_token: 'checkpoint-token-1234567890',
    choice_id: 'continue',
  },
  circuit_cancel: {
    run_id: RUN_ID,
  },
  circuit_list: {},
  circuit_recover: {
    run_id: RUN_ID,
  },
} as const;

const validSuccessResponses = {
  circuit_start: {
    schema_version: 1,
    ok: true,
    run_id: RUN_ID,
    state: 'starting',
    next_cursor: 0,
    summary: 'Circuit started the Review flow.',
  },
  circuit_status: {
    schema_version: 1,
    ok: true,
    run_id: RUN_ID,
    state: 'running',
    events: [],
    next_cursor: 0,
    truncated: false,
    summary: 'Circuit is running.',
  },
  circuit_resume: {
    schema_version: 1,
    ok: true,
    run_id: RUN_ID,
    state: 'resuming',
    next_cursor: 4,
    summary: 'Circuit accepted the checkpoint choice.',
  },
  circuit_cancel: {
    schema_version: 1,
    ok: true,
    run_id: RUN_ID,
    state: 'cancelled',
    cleanup_confirmed: true,
    summary: 'Circuit stopped the run and confirmed cleanup.',
  },
  circuit_list: {
    schema_version: 1,
    ok: true,
    runs: [
      {
        run_id: RUN_ID,
        flow: 'review',
        state: 'running',
        updated_at: NOW,
        checkpoint_available: false,
        summary: 'Review is running.',
      },
    ],
    truncated: false,
    summary: 'Found one recent Circuit run.',
  },
  circuit_recover: {
    schema_version: 1,
    ok: true,
    run_id: RUN_ID,
    state: 'interrupted',
    recovered: true,
    cleanup_confirmed: true,
    lease_released: true,
    summary: 'Circuit confirmed the old worker is absent and released the lease.',
  },
} as const;

const stableError = {
  schema_version: 1,
  ok: false,
  error: {
    code: 'unsupported_platform',
    message: 'Circuit MCP currently supports macOS only.',
    next_action: 'Run Circuit from the ordinary CLI on this platform.',
  },
} as const;

describe('MCP v1 tool inputs', () => {
  it('pins exactly the six public tools', () => {
    expect(MCP_TOOL_NAMES).toEqual([
      'circuit_start',
      'circuit_status',
      'circuit_resume',
      'circuit_cancel',
      'circuit_list',
      'circuit_recover',
    ]);
    expect(Object.keys(MCP_TOOL_INPUT_SCHEMAS)).toEqual(MCP_TOOL_NAMES);
  });

  it.each(MCP_TOOL_NAMES)('%s accepts its smallest valid input', (toolName) => {
    expect(MCP_TOOL_INPUT_SCHEMAS[toolName].safeParse(validInputs[toolName]).success).toBe(true);
  });

  it.each(MCP_TOOL_NAMES)('%s rejects unknown input fields', (toolName) => {
    expect(
      MCP_TOOL_INPUT_SCHEMAS[toolName].safeParse({
        ...validInputs[toolName],
        surprise: true,
      }).success,
    ).toBe(false);
  });

  it.each([
    ['workspace', '/tmp/project'],
    ['executable', '/bin/sh'],
    ['command', 'curl'],
    ['arguments', ['https://example.com']],
    ['environment', { TOKEN: 'secret' }],
    ['config_path', '/tmp/config.yaml'],
    ['flow_root', '/tmp/flow'],
    ['output_path', '/tmp/out'],
    ['timeout_ms', 60_000],
  ] as const)('circuit_start rejects caller-controlled %s', (field, value) => {
    expect(
      CircuitStartInputV1.safeParse({
        ...validInputs.circuit_start,
        [field]: value,
      }).success,
    ).toBe(false);
  });

  it('defaults search to off and rejects live search', () => {
    expect(CircuitStartInputV1.parse(validInputs.circuit_start).web_search).toBe('off');
    expect(
      CircuitStartInputV1.safeParse({
        ...validInputs.circuit_start,
        web_search: 'live',
      }).success,
    ).toBe(false);
  });

  it('requires a separate consent flag for cached search', () => {
    expect(
      CircuitStartInputV1.safeParse({
        ...validInputs.circuit_start,
        web_search: 'cached',
      }).success,
    ).toBe(false);

    expect(
      CircuitStartInputV1.safeParse({
        ...validInputs.circuit_start,
        web_search: 'cached',
        consent: { cached_web_search: true },
      }).success,
    ).toBe(true);
  });

  it('requires explicit consent before relaying untracked Review contents', () => {
    expect(
      CircuitStartInputV1.safeParse({
        ...validInputs.circuit_start,
        include_untracked_content: true,
      }).success,
    ).toBe(false);
    expect(
      CircuitStartInputV1.safeParse({
        ...validInputs.circuit_start,
        include_untracked_content: true,
        consent: { untracked_review_content: true },
      }).success,
    ).toBe(true);
    expect(
      CircuitStartInputV1.safeParse({
        flow: 'build',
        goal: 'Build the feature',
        include_untracked_content: true,
        consent: { untracked_review_content: true },
      }).success,
    ).toBe(false);
  });

  it('accepts only bounded Explore and Prototype tournaments', () => {
    expect(
      CircuitStartInputV1.safeParse({
        flow: 'explore',
        goal: 'Compare two approaches',
        tournament: 2,
      }).success,
    ).toBe(true);
    expect(
      CircuitStartInputV1.safeParse({
        ...validInputs.circuit_start,
        tournament: 2,
      }).success,
    ).toBe(false);
    expect(
      CircuitStartInputV1.safeParse({
        flow: 'explore',
        goal: 'Compare too many approaches',
        tournament: 5,
      }).success,
    ).toBe(false);
  });

  it('limits Prototype variants to the safe public fields and supported Codex effort', () => {
    const variants = [
      { id: 'fast', label: 'Fast', model: 'gpt-5.1-codex-mini', effort: 'low' },
      { id: 'deep', label: 'Deep', model: 'gpt-5.4', effort: 'high' },
    ];
    expect(
      CircuitStartInputV1.safeParse({
        flow: 'prototype',
        goal: 'Prototype both approaches',
        tournament: 2,
        variants,
      }).success,
    ).toBe(true);
    expect(
      CircuitStartInputV1.safeParse({
        flow: 'prototype',
        goal: 'Prototype both approaches',
        tournament: 2,
        variants: [{ ...variants[0], command: 'curl example.com' }, variants[1]],
      }).success,
    ).toBe(false);
    expect(
      CircuitStartInputV1.safeParse({
        flow: 'prototype',
        goal: 'Prototype both approaches',
        tournament: 2,
        variants: [{ ...variants[0], effort: 'none' }, variants[1]],
      }).success,
    ).toBe(false);
  });

  it('requires unique Prototype variant ids and one variant per branch', () => {
    const duplicate = { id: 'same', label: 'Same', model: 'gpt-5.4', effort: 'low' };
    expect(
      CircuitStartInputV1.safeParse({
        flow: 'prototype',
        goal: 'Prototype both approaches',
        tournament: 2,
        variants: [duplicate, duplicate],
      }).success,
    ).toBe(false);
    expect(
      CircuitStartInputV1.safeParse({
        flow: 'prototype',
        goal: 'Prototype three approaches',
        tournament: 3,
        variants: [duplicate, { id: 'other', label: 'Other', model: 'gpt-5.4', effort: 'medium' }],
      }).success,
    ).toBe(false);
  });

  it('bounds status polling and list size', () => {
    expect(
      MCP_TOOL_INPUT_SCHEMAS.circuit_status.safeParse({
        run_id: RUN_ID,
        wait_ms: 10_000,
        max_events: 100,
      }).success,
    ).toBe(true);
    expect(
      MCP_TOOL_INPUT_SCHEMAS.circuit_status.safeParse({
        run_id: RUN_ID,
        wait_ms: 10_001,
      }).success,
    ).toBe(false);
    expect(MCP_TOOL_INPUT_SCHEMAS.circuit_list.safeParse({ limit: 50 }).success).toBe(true);
    expect(MCP_TOOL_INPUT_SCHEMAS.circuit_list.safeParse({ limit: 51 }).success).toBe(false);
  });
});

describe('MCP v1 tool responses', () => {
  it('uses one strict, stable error shape', () => {
    expect(McpErrorResponseV1.safeParse(stableError).success).toBe(true);
    expect(
      McpErrorResponseV1.safeParse({
        ...stableError,
        error: { ...stableError.error, internal_operation: 'releaseLease' },
      }).success,
    ).toBe(false);
    expect(
      McpErrorResponseV1.safeParse({
        ...stableError,
        error: { ...stableError.error, code: 'Not Stable' },
      }).success,
    ).toBe(false);
  });

  it.each(MCP_TOOL_NAMES)('%s accepts its success shape and the stable error shape', (toolName) => {
    const schema = MCP_TOOL_RESPONSE_SCHEMAS[toolName];
    expect(schema.safeParse(validSuccessResponses[toolName]).success).toBe(true);
    expect(schema.safeParse(stableError).success).toBe(true);
  });

  it.each(MCP_TOOL_NAMES)('%s rejects unknown response fields', (toolName) => {
    expect(
      MCP_TOOL_RESPONSE_SCHEMAS[toolName].safeParse({
        ...validSuccessResponses[toolName],
        internal_operation: 'workerSpawn',
      }).success,
    ).toBe(false);
  });

  it('requires checkpoint data while waiting and final report data when complete', () => {
    expect(
      CircuitStatusResponseV1.safeParse({
        ...validSuccessResponses.circuit_status,
        state: 'waiting_for_input',
      }).success,
    ).toBe(false);
    expect(
      CircuitStatusResponseV1.safeParse({
        ...validSuccessResponses.circuit_status,
        state: 'waiting_for_input',
        checkpoint: {
          token: 'checkpoint-token-1234567890',
          prompt: 'Choose the next step.',
          choices: [{ id: 'continue', label: 'Continue' }],
        },
      }).success,
    ).toBe(true);
    expect(
      CircuitStatusResponseV1.safeParse({
        ...validSuccessResponses.circuit_status,
        state: 'complete',
      }).success,
    ).toBe(false);
    expect(
      CircuitStatusResponseV1.safeParse({
        ...validSuccessResponses.circuit_status,
        state: 'complete',
        final_report: {
          schema: 'review.result@v1',
          summary: 'The review completed.',
          data: { outcome: 'complete' },
        },
      }).success,
    ).toBe(true);
  });

  it('bounds status events, checkpoint choices, reports, and summaries', () => {
    const event = {
      cursor: 1,
      kind: 'relay.started',
      recorded_at: NOW,
      summary: 'A relay started.',
    };
    expect(
      CircuitStatusResponseV1.safeParse({
        ...validSuccessResponses.circuit_status,
        events: Array.from({ length: 101 }, () => event),
      }).success,
    ).toBe(false);
    expect(
      CircuitStatusResponseV1.safeParse({
        ...validSuccessResponses.circuit_status,
        summary: 'x'.repeat(1_001),
      }).success,
    ).toBe(false);
    expect(
      CircuitStatusResponseV1.safeParse({
        ...validSuccessResponses.circuit_status,
        state: 'complete',
        final_report: {
          schema: 'review.result@v1',
          summary: 'Done.',
          data: { text: 'x'.repeat(262_145) },
        },
      }).success,
    ).toBe(false);
  });

  it('does not report uncertain cancellation as clean', () => {
    expect(
      CircuitCancelResponseV1.safeParse({
        ...validSuccessResponses.circuit_cancel,
        state: 'recovery_required',
        cleanup_confirmed: true,
      }).success,
    ).toBe(false);
    expect(
      CircuitCancelResponseV1.safeParse({
        ...validSuccessResponses.circuit_cancel,
        state: 'recovery_required',
        cleanup_confirmed: false,
        summary: 'Circuit could not confirm cleanup.',
      }).success,
    ).toBe(true);
  });

  it('keeps every individual response schema strict', () => {
    expect(CircuitStartResponseV1.safeParse(validSuccessResponses.circuit_start).success).toBe(
      true,
    );
    expect(CircuitResumeResponseV1.safeParse(validSuccessResponses.circuit_resume).success).toBe(
      true,
    );
    expect(CircuitListResponseV1.safeParse(validSuccessResponses.circuit_list).success).toBe(true);
    expect(CircuitRecoverResponseV1.safeParse(validSuccessResponses.circuit_recover).success).toBe(
      true,
    );
  });
});
