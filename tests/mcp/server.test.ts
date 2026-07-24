import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MCP_TOOL_NAMES } from '../../src/hosts/codex-mcp/contracts.js';
import { CODEX_SANDBOX_METADATA_KEY } from '../../src/hosts/codex-mcp/resources.js';
import { createCircuitMcpServer } from '../../src/hosts/codex-mcp/server.js';

describe('Codex MCP server contract', () => {
  let client: Client;
  let closeServer: () => Promise<void>;

  beforeEach(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCircuitMcpServer({
      handle: async () => ({
        schema_version: 1,
        ok: false,
        error: { code: 'test_handler_unavailable', message: 'The test handler is unavailable.' },
      }),
    });
    client = new Client({ name: 'circuit-test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    closeServer = () => server.close();
  });

  afterEach(async () => {
    await client.close();
    await closeServer();
  });

  it('exposes exactly six strict public tools and no sandbox probe', async () => {
    const result = await client.listTools();
    expect(result.tools.map((tool) => tool.name)).toEqual(MCP_TOOL_NAMES);
    expect(result.tools.map((tool) => tool.name)).not.toContain('circuit_sandbox_probe');
    for (const tool of result.tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(JSON.stringify(tool.inputSchema)).not.toMatch(
        /workspace_path|executable|command|arguments|environment|config_path|flow_root|output_path/i,
      );
    }
  });

  it('advertises the Codex sandbox-state metadata capability', () => {
    expect(client.getServerCapabilities()?.experimental).toHaveProperty(CODEX_SANDBOX_METADATA_KEY);
  });

  it('advertises self-contained lifecycle instructions without a CLI fallback', () => {
    const instructions = client.getInstructions();
    expect(instructions).toEqual(expect.any(String));
    if (instructions === undefined) return;

    const firstParagraph = instructions.split('\n\n')[0] ?? '';
    expect(firstParagraph.length).toBeGreaterThan(0);
    expect(firstParagraph.length).toBeLessThanOrEqual(512);
    expect(firstParagraph).toContain("Use Circuit's MCP tools for the entire run lifecycle");
    expect(firstParagraph).toContain('never replace them with shell or CLI commands');
    expect(firstParagraph).toContain('circuit_start');
    expect(firstParagraph).toContain('circuit_status');
    expect(firstParagraph).toContain('circuit_list');
    expect(firstParagraph).toContain('never automatically retry');
    expect(firstParagraph).toContain('force-unlock');

    expect(instructions).toContain('waiting_for_input');
    expect(instructions).toContain('checkpoint.prompt');
    expect(instructions).toContain('description when present');
    expect(instructions).toContain('stop and wait for the user');
    expect(instructions).toContain('Never choose for the user');
    expect(instructions).toContain('recovery_required');
    expect(instructions).toContain('state is complete and final_report is present');
    expect(instructions).toContain('direct circuit_cancel response');
    expect(instructions).toContain('state is cancelled and cleanup_confirmed is true');
    expect(instructions).toContain(
      'A cancelled state from circuit_status or circuit_list is terminal',
    );
    expect(instructions).toContain('query leaves the machine');
    expect(instructions).toContain('untracked Review contents');
    // Four anchors for the Review target contract, one per decision the host
    // has to get right: consent to relay tracked code, one pinned target, keep
    // a path narrowing instead of widening it, and no pull-request fetch.
    // Pinning every sentence made ordinary rewording a test failure without
    // catching anything more.
    expect(instructions).toContain(
      'A direct user request to run Review on tracked workspace content authorizes the normal tracked-code relay',
    );
    expect(instructions).toContain('selected target as the only code under review');
    expect(instructions).toContain(
      'If the request narrows the target to a file or directory, or excludes paths, keep that wording in the goal',
    );
    expect(instructions).toContain('Circuit cannot fetch a pull request');
    expect(instructions).toContain('error.next_action when present');
    expect(instructions).toContain('Never execute next_action as shell or CLI text');
  });

  it('describes cached search as leaving the machine and keeps live search absent', async () => {
    const result = await client.listTools();
    const start = result.tools.find((tool) => tool.name === 'circuit_start');
    expect(start?.description).toContain('query leaves the machine');
    expect(JSON.stringify(start?.inputSchema)).toContain('cached');
    expect(JSON.stringify(start?.inputSchema)).not.toContain('live');
  });

  it('does not label status reconciliation as read-only', async () => {
    const result = await client.listTools();
    const status = result.tools.find((tool) => tool.name === 'circuit_status');
    const list = result.tools.find((tool) => tool.name === 'circuit_list');
    expect(status?.annotations?.readOnlyHint).toBe(false);
    expect(status?.annotations?.idempotentHint).toBe(false);
    expect(list?.annotations?.readOnlyHint).toBe(true);
    expect(list?.annotations?.idempotentHint).toBe(true);
  });

  it('renders a stable error returned by its lifecycle handler', async () => {
    const result = await client.callTool({
      name: 'circuit_status',
      arguments: { run_id: '11111111-1111-4111-8111-111111111111' },
    });
    expect(result.structuredContent).toMatchObject({
      schema_version: 1,
      ok: false,
      error: { code: 'test_handler_unavailable' },
    });
    expect(result.content).toEqual([{ type: 'text', text: 'The test handler is unavailable.' }]);
  });

  it('rejects unknown input fields before calling an injected handler', async () => {
    const handler = vi.fn();
    await client.close();
    await closeServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCircuitMcpServer({ handle: handler });
    client = new Client({ name: 'circuit-test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    closeServer = () => server.close();

    const result = await client.callTool({
      name: 'circuit_start',
      arguments: {
        flow: 'review',
        goal: 'Review this change',
        web_search: 'off',
        workspace_path: '/tmp/escape',
      },
    });
    expect(result.isError).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns a structured successful list from the production handler', async () => {
    await client.close();
    await closeServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCircuitMcpServer({
      handle: async () => ({
        schema_version: 1,
        ok: true,
        runs: [],
        truncated: false,
        summary: 'No recent Circuit runs were found for this workspace.',
      }),
    });
    client = new Client({ name: 'circuit-test', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    closeServer = () => server.close();

    const result = await client.callTool({ name: 'circuit_list', arguments: {} });
    expect(result.structuredContent).toMatchObject({ ok: true, runs: [] });
  });

  it('lets the lifecycle handler ask the Codex client for MCP roots', async () => {
    await client.close();
    await closeServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    let observedRoots: unknown;
    const server = createCircuitMcpServer({
      handle: async (call) => {
        observedRoots = await call.listRoots?.();
        return {
          schema_version: 1,
          ok: true,
          runs: [],
          truncated: false,
          summary: 'Listed test roots.',
        };
      },
    });
    client = new Client(
      { name: 'circuit-test', version: '1.0.0' },
      { capabilities: { roots: {} } },
    );
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: [{ uri: 'file:///tmp/circuit-workspace', name: 'workspace' }],
    }));
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    closeServer = () => server.close();

    const result = await client.callTool({ name: 'circuit_list', arguments: {} });
    expect(result.structuredContent).toMatchObject({ ok: true, runs: [] });
    expect(observedRoots).toEqual([{ uri: 'file:///tmp/circuit-workspace', name: 'workspace' }]);
  });
});
