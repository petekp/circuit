// Plain-English fixes for broken builtin connector CLIs. Shared by the
// connectors' own spawn-failure errors (so a mid-run death names its fix) and
// by `circuit doctor` (so the operator hears about it before any spend).
// Standalone module with no imports: connectors and health checks both use
// it without creating an import cycle.

export type BuiltinConnectorName = 'claude-code' | 'codex' | 'cursor-agent';

export function connectorRemediation(name: BuiltinConnectorName): string {
  switch (name) {
    case 'claude-code':
      return 'Fix: install Claude Code (https://claude.com/claude-code), then check it with: claude --version';
    case 'codex':
      return 'Fix: reinstall the Codex CLI (npm install -g @openai/codex), then check it with: codex --version. If it is installed but signed out, run: codex login';
    case 'cursor-agent':
      return 'Fix: install the Cursor CLI, then check it with: cursor-agent status. If it is installed but signed out, run: cursor-agent login';
  }
}
