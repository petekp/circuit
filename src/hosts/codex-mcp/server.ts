import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type {
  RequestMeta,
  ServerNotification,
  ServerRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { ListRootsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  MCP_TOOL_INPUT_SCHEMAS,
  MCP_TOOL_NAMES,
  MCP_TOOL_RESPONSE_SCHEMAS,
  MCP_TOOL_WIRE_OUTPUT_SCHEMAS,
  type McpToolName,
} from './contracts.js';
import { CODEX_SANDBOX_METADATA_KEY } from './resources.js';

const TOOL_DESCRIPTIONS: Record<McpToolName, string> = {
  circuit_start:
    'Start one public Circuit flow and return immediately with a run ID. Search is off by default. Cached search requires explicit consent because the query leaves the machine.',
  circuit_status:
    'Read bounded progress for one Circuit run, optionally after a cursor or with a wait of at most 10 seconds.',
  circuit_resume:
    'Resume one waiting Circuit checkpoint using its opaque token and one advertised choice ID.',
  circuit_cancel:
    'Cancel one owned Circuit worker or close a waiting checkpoint, and report whether cleanup was observed.',
  circuit_list: 'List bounded recent Circuit runs for the current trusted Codex workspace.',
  circuit_recover:
    'Repair a recovery_required Circuit run only after Circuit proves that its recorded processes are absent.',
};

// Status may reconcile durable supervisor evidence and release a finished
// workspace lease. Only list is a strictly read-only operation.
const READ_ONLY_TOOLS = new Set<McpToolName>(['circuit_list']);

export interface CircuitMcpToolCall {
  readonly name: McpToolName;
  readonly input: unknown;
  readonly metadata: RequestMeta | undefined;
  readonly listRoots?: () => Promise<unknown>;
  readonly signal: AbortSignal;
}

export type CircuitMcpToolHandler = (call: CircuitMcpToolCall) => Promise<unknown>;

export interface CreateCircuitMcpServerOptions {
  readonly handle: CircuitMcpToolHandler;
}

function renderResponse(response: Record<string, unknown>): string {
  if (response.ok === false) {
    const error = response.error;
    if (typeof error === 'object' && error !== null && !Array.isArray(error)) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string') return message;
    }
  }
  const summary = response.summary;
  return typeof summary === 'string' ? summary : 'Circuit returned a structured result.';
}

export function createCircuitMcpServer(options: CreateCircuitMcpServerOptions): McpServer {
  const server = new McpServer(
    { name: 'circuit', version: '1.0.0' },
    {
      capabilities: {
        experimental: {
          [CODEX_SANDBOX_METADATA_KEY]: {},
        },
      },
    },
  );
  const handle = options.handle;

  function registerTool(name: McpToolName): void {
    const readOnly = READ_ONLY_TOOLS.has(name);
    server.registerTool(
      name,
      {
        title: name,
        description: TOOL_DESCRIPTIONS[name],
        inputSchema: MCP_TOOL_INPUT_SCHEMAS[name],
        outputSchema: MCP_TOOL_WIRE_OUTPUT_SCHEMAS[name],
        annotations: {
          readOnlyHint: readOnly,
          destructiveHint: !readOnly,
          idempotentHint: readOnly,
          openWorldHint: name === 'circuit_start',
        },
      },
      async (input: unknown, extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => {
        const response = MCP_TOOL_RESPONSE_SCHEMAS[name].parse(
          await handle({
            name,
            input,
            metadata: extra._meta,
            listRoots: async () =>
              (await extra.sendRequest({ method: 'roots/list' }, ListRootsResultSchema)).roots,
            signal: extra.signal,
          }),
        ) as Record<string, unknown>;
        return {
          content: [{ type: 'text' as const, text: renderResponse(response) }],
          structuredContent: response,
          isError: response.ok === false,
        };
      },
    );
  }

  for (const name of MCP_TOOL_NAMES) registerTool(name);
  return server;
}
