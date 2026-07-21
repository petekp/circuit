import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MCP_TOOL_NAMES } from '../../src/hosts/codex-mcp/contracts.js';
import { createCircuitMcpServer } from '../../src/hosts/codex-mcp/server.js';

describe('Codex MCP server contract', () => {
  let client: Client;
  let closeServer: () => Promise<void>;

  beforeEach(async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCircuitMcpServer();
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

  it('fails safely while the dormant package has no lifecycle handler', async () => {
    const result = await client.callTool({
      name: 'circuit_status',
      arguments: { run_id: '11111111-1111-4111-8111-111111111111' },
    });
    expect(result.structuredContent).toMatchObject({
      schema_version: 1,
      ok: false,
      error: { code: 'mcp_not_activated' },
    });
    expect(result.content).toEqual([
      { type: 'text', text: 'Circuit MCP is installed but not activated yet.' },
    ]);
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
});
