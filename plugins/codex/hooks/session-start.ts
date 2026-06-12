#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(scriptDir, '..');
const defaultLauncher = resolve(pluginRoot, 'scripts/circuit.ts');
const launcher = process.env.CIRCUIT_HANDOFF_HOOK_LAUNCHER ?? defaultLauncher;
const debug = process.env.CIRCUIT_HANDOFF_HOOK_DEBUG === '1';
const DEFAULT_BRIEF_TIMEOUT_MS = 3000;

type JsonRecord = Record<string, unknown>;

// Hook-local fallback line when the brief never produced an envelope (a
// timeout, a non-zero exit, or unparseable JSON). A1: a failed restore says
// so once rather than looking like a clean repo.
const BRIEF_FAILED_NOTICE =
  "Circuit could not check this repo's saved continuity (the restore step did not complete). Continuing without it.";

function warn(message: string): void {
  if (debug) process.stderr.write(`Circuit handoff hook: ${message}\n`);
}

function emitContext(additionalContext: string): void {
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext,
      },
    })}\n`,
  );
}

function invalidNotice(code: string): string {
  return `Circuit found saved continuity for this repo but could not load it (${code}). Run /circuit:handoff done to clear it, or /circuit:handoff resume to inspect.`;
}

function readInput(): JsonRecord {
  if (process.stdin.isTTY) return {};
  const raw = readFileSync(0, 'utf8');
  if (raw.trim().length === 0) return {};
  return JSON.parse(raw) as JsonRecord;
}

function hookCwd(input: JsonRecord): string | undefined {
  return typeof input?.cwd === 'string' && input.cwd.length > 0 ? input.cwd : undefined;
}

function hookSource(input: JsonRecord): string | undefined {
  return typeof input?.source === 'string' && input.source.length > 0 ? input.source : undefined;
}

function hookSessionId(input: JsonRecord): string | undefined {
  return typeof input?.session_id === 'string' && input.session_id.length > 0
    ? input.session_id
    : undefined;
}

// E2: brief injection is source-aware and opt-in. The SessionStart matcher
// fires on startup|resume|clear|compact; today every source injects the full
// brief. A deliberate `clear` (the operator just wiped context) and a fresh
// `compact` (the host already left its own summary) are the two sources where
// re-injecting the snapshot is redundant or unwanted. Suppression is per-source
// and defaults to today's inject-everything, so nothing changes unless the
// operator opts in via CIRCUIT_HANDOFF_ON_CLEAR / CIRCUIT_HANDOFF_ON_COMPACT.
function injectModeForSource(source: string | undefined): 'inject' | 'suppress' {
  if (source === 'clear' && process.env.CIRCUIT_HANDOFF_ON_CLEAR === 'suppress') return 'suppress';
  if (source === 'compact' && process.env.CIRCUIT_HANDOFF_ON_COMPACT === 'suppress') {
    return 'suppress';
  }
  return 'inject';
}

function briefTimeoutMs() {
  const raw = process.env.CIRCUIT_HANDOFF_HOOK_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_BRIEF_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BRIEF_TIMEOUT_MS;
}

function main() {
  let input: Record<string, unknown>;
  try {
    input = readInput();
  } catch (err) {
    warn(`could not parse hook input: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }

  const cwd = hookCwd(input);
  if (cwd === undefined) {
    warn('hook input did not include cwd; skipping handoff injection');
    return 0;
  }

  // E2: a deliberate clear or a fresh compaction can opt out of re-injecting
  // the snapshot. Default stays inject-everything.
  const source = hookSource(input);
  if (injectModeForSource(source) === 'suppress') {
    warn(`source '${source ?? 'unknown'}' opted out of brief injection; skipping`);
    return 0;
  }

  if (!existsSync(launcher)) {
    warn(`launcher is missing: ${launcher}`);
    return 0;
  }

  // Session-scoped ambient resolution: pass the host's identity for THIS
  // session so the brief prefers its own capture and a compact/resume restore
  // is never steered by a concurrent session's last request.
  const sessionId = hookSessionId(input);
  const briefArgs = [launcher, 'handoff', 'brief', '--json', '--project-root', cwd];
  if (sessionId !== undefined) briefArgs.push('--session-id', sessionId);
  if (source !== undefined) briefArgs.push('--session-source', source);

  const result = spawnSync(process.execPath, briefArgs, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: briefTimeoutMs(),
  });

  if (result.error !== undefined || result.status !== 0) {
    // A1: a timeout or non-zero exit is a real restore failure, not a benign
    // empty. Surface one short line instead of vanishing.
    warn(
      `brief command failed: status=${result.status ?? 'unknown'} error=${
        result.error?.message ?? 'none'
      } stderr=${result.stderr.slice(0, 300)}`,
    );
    emitContext(BRIEF_FAILED_NOTICE);
    return 0;
  }

  let brief: JsonRecord;
  try {
    brief = JSON.parse(result.stdout);
  } catch (err) {
    warn(
      `brief command returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
    emitContext(BRIEF_FAILED_NOTICE);
    return 0;
  }

  if (brief.status === 'invalid') {
    const error = brief.error;
    const code =
      typeof error === 'object' && error !== null && !Array.isArray(error)
        ? (error as JsonRecord).code
        : undefined;
    warn(`brief state is invalid: ${String(code ?? 'unknown')}`);
    // A1: the brief carries operator_notice; synthesize one if an older
    // envelope omits it so the broken store is never silent.
    const notice =
      typeof brief.operator_notice === 'string'
        ? brief.operator_notice
        : invalidNotice(String(code ?? 'unknown'));
    emitContext(notice);
    return 0;
  }

  if (brief.status !== 'available' || typeof brief.additional_context !== 'string') {
    return 0;
  }

  // A4: when the brief recovered from a broken manual save it carries an
  // operator_notice on the available path; prepend it so the operator learns
  // the manual save was broken even though a fallback snapshot was shown.
  const additionalContext =
    typeof brief.operator_notice === 'string'
      ? `${brief.operator_notice}\n\n${brief.additional_context}`
      : brief.additional_context;
  emitContext(additionalContext);
  return 0;
}

process.exit(main());
