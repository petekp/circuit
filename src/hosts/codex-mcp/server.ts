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

export const CIRCUIT_MCP_SERVER_INSTRUCTIONS = [
  "Use Circuit's MCP tools for the entire run lifecycle; never replace them with shell or CLI commands. Start new work with circuit_start. After start or resume, call circuit_status with the latest cursor until the run completes, needs attention, is cancelled or interrupted, waits for input, or requires recovery. If start is busy or uncertain, call circuit_list and inspect status; never automatically retry, start a competing run, or force-unlock a workspace.",
  'A successful circuit_start means the run was accepted, not completed. Keep polling only while the state is starting, running, resuming, or cancelling.',
  'When the state is waiting_for_input, show checkpoint.prompt and every advertised choice with its label and description when present. Then stop and wait for the user. Resume only with the same run ID, the current opaque checkpoint token, and the exact choice ID selected by the user. Never choose for the user, invent a choice, or expose the token.',
  'When the user asks to continue an earlier run and no run ID is available, call circuit_list. Continue only a clearly matching non-terminal run. Never match by flow alone; ask the user when multiple runs could match.',
  'Use circuit_recover only for recovery_required. Recovery closes the old run; it does not continue it. Stop without claiming success for needs_attention, cancelled, or interrupted. Claim success only when the state is complete and final_report is present.',
  'When the user cancels or replaces an active request, call circuit_cancel. On a direct circuit_cancel response, say the run was cancelled and start replacement work only when state is cancelled and cleanup_confirmed is true. A cancelled state from circuit_status or circuit_list is terminal; report it without calling circuit_cancel again or claiming fresh cleanup proof.',
  'A direct user request to run Review on tracked workspace content authorizes the normal tracked-code relay for that Review run. Do not ask for a second confirmation for tracked files. This does not authorize cached web search or untracked Review file contents.',
  'When the user asks Review to inspect a specific code target, keep that target in the goal. Examples include current diff, staged changes, latest commit, HEAD, HEAD~1, commit abc1234, main...feature, and PR #123. Circuit uses that wording to collect the requested evidence. Do not rewrite a commit, range, branch comparison, or PR request as only current diff unless the user actually asked for staged or unstaged changes.',
  'Treat the selected target as the only code under review. Review sees only Circuit’s captured evidence and cannot inspect nearby repository files or run tools. A file path by itself is not Review evidence; choose a complete target, or include the plan or report’s actual text in the goal.',
  'PR review uses local repository evidence. If the PR ref is not available locally, Circuit will report that the target is unavailable. Do not fetch, call gh, or fall back to shell unless the user separately asks for that setup work.',
  'Before cached search, tell the user that the query leaves the machine and obtain explicit consent for this run. Include untracked Review contents only after the user explicitly agrees that those contents may be relayed for this run. Never infer either consent.',
  'On error, show error.message and error.next_action when present. Follow next_action only when it clearly names an in-scope Circuit MCP call and requires no user choice. Otherwise stop and report it. Never execute next_action as shell or CLI text.',
].join('\n\n');

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
      instructions: CIRCUIT_MCP_SERVER_INSTRUCTIONS,
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
