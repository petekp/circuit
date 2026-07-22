export const CODEX_MCP_NODE_REMEDY =
  'Install Node.js 22.18 or newer, ensure node is on PATH, restart Codex, and try again.';

export const CODEX_MCP_LAUNCH_SCRIPT = [
  'circuit_node_error() {',
  "IFS= read -r request || request='';",
  `id=$(printf '%s\\n' "$request" | /usr/bin/sed -n 's/.*"id"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p');`,
  `case "$id" in ''|*[!0-9]*) id=0 ;; esac;`,
  `printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32000,"message":"%s"}}\\n' "$id" "$1";`,
  'exit 1;',
  '};',
  `if ! command -v node >/dev/null 2>&1; then circuit_node_error "Circuit MCP requires Node.js 22.18 or newer. ${CODEX_MCP_NODE_REMEDY}"; fi;`,
  `node_version=$(node -p 'process.versions.node' 2>/dev/null) || circuit_node_error "Circuit MCP could not read the Node.js version. ${CODEX_MCP_NODE_REMEDY}";`,
  `case "$node_version" in ''|*[!0-9.]*) circuit_node_error "Circuit MCP could not read the Node.js version. ${CODEX_MCP_NODE_REMEDY}" ;; esac;`,
  'node_major=${node_version%%.*}; node_minor_tail=${node_version#*.}; node_minor=${node_minor_tail%%.*};',
  `if [ "$node_major" -lt 22 ] || { [ "$node_major" -eq 22 ] && [ "$node_minor" -lt 18 ]; }; then circuit_node_error "Circuit MCP requires Node.js 22.18 or newer. Current Node.js is $node_version. ${CODEX_MCP_NODE_REMEDY}"; fi;`,
  'exec node ./mcp/server.cjs',
].join(' ');

export const CODEX_MCP_LAUNCH_COMMAND = '/bin/sh';
export const CODEX_MCP_LAUNCH_ARGS = ['-c', CODEX_MCP_LAUNCH_SCRIPT] as const;
