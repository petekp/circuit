#!/usr/bin/env node
// harvest.ts — Stop / SessionEnd hook that keeps an ambient continuity record
// warm. It is the in-engine replacement for the personal warm-handoff shell
// writer: on every turn end (Stop) and final flush (SessionEnd) it asks the
// Circuit CLI to harvest the live transcript into this repo's
// `.circuit/continuity` store, pointing the index's `ambient_record` at it
// without ever touching a manual `pending_record` (see
// docs/contracts/continuity.md CONT-I13..I18).
//
// Robustness contract: a continuity harvest must never break the session it
// fires in. Every path returns 0; nothing is written to stdout.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(scriptDir, '..');
const defaultLauncher = resolve(pluginRoot, 'scripts/circuit.ts');
const launcher = process.env.CIRCUIT_HANDOFF_HOOK_LAUNCHER ?? defaultLauncher;
const debug = process.env.CIRCUIT_HANDOFF_HOOK_DEBUG === '1';
const DEFAULT_HARVEST_TIMEOUT_MS = 5000;

type JsonRecord = Record<string, unknown>;

function warn(message: string): void {
  if (debug) process.stderr.write(`Circuit harvest hook: ${message}\n`);
}

function readInput(): JsonRecord {
  if (process.stdin.isTTY) return {};
  const raw = readFileSync(0, 'utf8');
  if (raw.trim().length === 0) return {};
  return JSON.parse(raw) as JsonRecord;
}

function stringField(input: JsonRecord, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function harvestTimeoutMs(): number {
  const raw = process.env.CIRCUIT_HARVEST_HOOK_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_HARVEST_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HARVEST_TIMEOUT_MS;
}

function main(): number {
  let input: JsonRecord;
  try {
    input = readInput();
  } catch (err) {
    warn(`could not parse hook input: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }

  // AGENTS.md rule #7: read identity from hook input, pass explicit roots.
  const cwd = stringField(input, 'cwd');
  const transcriptPath = stringField(input, 'transcript_path');
  if (cwd === undefined || transcriptPath === undefined) {
    warn('hook input lacked cwd or transcript_path; skipping harvest');
    return 0;
  }
  const sessionId = stringField(input, 'session_id');
  const source = stringField(input, 'hook_event_name') === 'SessionEnd' ? 'session-end' : 'stop';

  if (!existsSync(launcher)) {
    warn(`launcher is missing: ${launcher}`);
    return 0;
  }

  const launcherArgs = [
    launcher,
    'handoff',
    'harvest',
    '--project-root',
    cwd,
    '--transcript-path',
    transcriptPath,
    '--source',
    source,
  ];
  if (sessionId !== undefined) launcherArgs.push('--session-id', sessionId);

  const result = spawnSync(process.execPath, launcherArgs, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: harvestTimeoutMs(),
  });

  if (result.error !== undefined || result.status !== 0) {
    warn(
      `harvest command failed: status=${result.status ?? 'unknown'} error=${
        result.error?.message ?? 'none'
      } stderr=${result.stderr.slice(0, 300)}`,
    );
  }
  return 0;
}

process.exit(main());
