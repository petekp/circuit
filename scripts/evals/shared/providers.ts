import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

type WrapperOptions = {
  tempPrefix?: string;
  // When true the wrapper *forces* its model/effort onto every spawned `claude`,
  // stripping any --model/--effort the caller already passed. The default
  // (false) only injects when the caller omitted them. Forcing is what pins the
  // Circuit arm to a single model: without it, Circuit's power dial resolves a
  // per-role model, the builtin connector passes --model, and the inject path
  // defers to it — silently defeating a same-model comparison.
  forceModel?: boolean;
};

type ProviderWrapper = {
  binDir: string;
  env: NodeJS.ProcessEnv;
};

export function createCodexWrapper(
  realCodex: string,
  model: string,
  effort: string,
  { tempPrefix = 'circuit-eval-codex-' } = {},
): ProviderWrapper {
  const binDir = mkdtempSync(resolve(tmpdir(), tempPrefix));
  const wrapperPath = resolve(binDir, 'codex');
  writeFileSync(
    wrapperPath,
    `#!/usr/bin/env bash
set -euo pipefail

if [[ "\${1:-}" == "exec" ]]; then
  shift
  exec "$REAL_CODEX" exec -m "$CIRCUIT_EVAL_MODEL" -c "model_reasoning_effort=\\"$CIRCUIT_EVAL_EFFORT\\"" "$@"
fi

exec "$REAL_CODEX" "$@"
`,
    { mode: 0o755 },
  );
  return {
    binDir,
    env: {
      ...process.env,
      REAL_CODEX: realCodex,
      CIRCUIT_EVAL_MODEL: model,
      CIRCUIT_EVAL_EFFORT: effort,
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
    },
  };
}

export function createClaudeCodeWrapper(
  realClaude: string,
  model: string,
  effort: string,
  { tempPrefix = 'circuit-eval-claude-', forceModel = false }: WrapperOptions = {},
): ProviderWrapper {
  const binDir = mkdtempSync(resolve(tmpdir(), tempPrefix));
  const wrapperPath = resolve(binDir, 'claude');
  // The shim carries both behaviors and picks via CIRCUIT_EVAL_FORCE_MODEL, so
  // the generated script is identical regardless of the option; only the env
  // toggles. Force mode drops any caller --model/--effort (the value too) and
  // re-adds ours, so the dial cannot inject a stronger per-role model.
  writeFileSync(
    wrapperPath,
    `#!/usr/bin/env bash
set -euo pipefail

if [[ "\${CIRCUIT_EVAL_FORCE_MODEL:-0}" -eq 1 ]]; then
  KEPT=()
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --model|--effort)
        shift
        if [[ "$#" -gt 0 ]]; then shift; fi
        ;;
      *)
        KEPT+=("$1")
        shift
        ;;
    esac
  done
  exec "$REAL_CLAUDE" --model "$CIRCUIT_EVAL_MODEL" --effort "$CIRCUIT_EVAL_EFFORT" "\${KEPT[@]}"
fi

INJECT_MODEL=1
INJECT_EFFORT=1
for arg in "$@"; do
  case "$arg" in
    --model) INJECT_MODEL=0 ;;
    --effort) INJECT_EFFORT=0 ;;
  esac
done

INJECTED=()
if [[ "$INJECT_MODEL" -eq 1 ]]; then
  INJECTED+=(--model "$CIRCUIT_EVAL_MODEL")
fi
if [[ "$INJECT_EFFORT" -eq 1 ]]; then
  INJECTED+=(--effort "$CIRCUIT_EVAL_EFFORT")
fi
exec "$REAL_CLAUDE" "\${INJECTED[@]}" "$@"
`,
    { mode: 0o755 },
  );
  return {
    binDir,
    env: {
      ...process.env,
      REAL_CLAUDE: realClaude,
      CIRCUIT_EVAL_MODEL: model,
      CIRCUIT_EVAL_EFFORT: effort,
      CIRCUIT_EVAL_FORCE_MODEL: forceModel ? '1' : '0',
      PATH: `${binDir}:${process.env.PATH ?? ''}`,
    },
  };
}

export function createProviderWrapper(
  provider: string,
  realExecutable: string,
  model: string,
  effort: string,
): ProviderWrapper {
  if (provider === 'codex') return createCodexWrapper(realExecutable, model, effort);
  if (provider === 'claude-code') return createClaudeCodeWrapper(realExecutable, model, effort);
  throw new Error(`unsupported provider '${provider}'`);
}

// jsonEnvelope wraps stdout in the CLI's `--output-format json` result object
// (final text under `result`, token/cost usage alongside). Opt-in because the
// circuit-vs-vanilla harness treats vanilla stdout as the final answer text
// and must keep the plain format; the fix harness opts in and unwraps.
export function vanillaClaudeArgs(
  prompt: string,
  { jsonEnvelope = false }: { jsonEnvelope?: boolean } = {},
): string[] {
  return [
    '-p',
    ...(jsonEnvelope ? ['--output-format', 'json'] : []),
    '--permission-mode',
    'bypassPermissions',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--setting-sources',
    '',
    '--settings',
    '{}',
    '--no-session-persistence',
    prompt,
  ];
}

export function vanillaCodexArgs(prompt: string): string[] {
  return ['exec', '-s', 'read-only', '--ephemeral', '--skip-git-repo-check', '--color', 'never', prompt];
}
