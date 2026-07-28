import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureStreams, deterministicNow, makeStubRelayer } from '../helpers/runtime-fixtures.js';

import { RUN_ENVELOPE_SHADOW_RELATIVE_PATH } from '../../src/app/run-envelope/shadow-record.js';
import { RUN_ENVELOPE_RELATIVE_PATH } from '../../src/app/run-envelope/source-record.js';
import { main } from '../../src/cli/circuit.js';
import { RunEnvelopeRecord, RunEnvelopeShadowRecord } from '../../src/schemas/run-envelope.js';

const REVIEW_RELAY_BODY = JSON.stringify({
  // Review fans out one reviewer per unit; a single-unit target has unit-1.
  unit_id: 'unit-1',
  verdict: 'NO_ISSUES_FOUND',
  findings: [],
  assessment: 'Stub reviewer: nothing actionable in the relayed evidence.',
  verification: ['Inspected the relayed intake report.'],
  confidence_limitations: [],
});

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'circuit-cli-run-envelope-shadow-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const relayer = makeStubRelayer(REVIEW_RELAY_BODY, {
  receipt_id: 'stub-receipt-run-envelope-shadow',
});

async function runMainJson(argv: readonly string[]): Promise<Record<string, unknown>> {
  return runMainJsonInProject(argv, process.cwd());
}

async function runMainJsonInProject(
  argv: readonly string[],
  configCwd: string,
): Promise<Record<string, unknown>> {
  const { result: exit, stdout } = await captureStreams(() =>
    main(argv, {
      relayer,
      now: deterministicNow(Date.UTC(2026, 4, 28, 5, 0, 0)),
      runId: '84000000-0000-0000-0000-000000000001',
      configHomeDir: join(tempDir, 'empty-home'),
      configCwd,
    }),
  );
  expect(exit).toBe(0);
  return JSON.parse(stdout) as Record<string, unknown>;
}

function createProofProject(): string {
  const projectRoot = join(tempDir, 'proof-project');
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(
    join(projectRoot, 'package.json'),
    `${JSON.stringify(
      {
        private: true,
        scripts: {
          verify: 'node -e "process.exit(0)"',
        },
      },
      null,
      2,
    )}\n`,
  );
  return projectRoot;
}

describe('CLI Run envelope shadow artifact', () => {
  it('writes Run envelope artifacts and a compact surface while keeping shadow internal', async () => {
    const runFolder = join(tempDir, 'review-run');
    const output = await runMainJson([
      'run',
      'review',
      '--goal',
      'Review this supplied text: the run envelope should preserve completed Review evidence.',
      '--run-folder',
      runFolder,
    ]);

    expect(output).not.toHaveProperty('run_envelope_shadow_path');
    expect(output.run_envelope_path).toBe(join(runFolder, RUN_ENVELOPE_RELATIVE_PATH));
    expect(typeof output.run_surface_markdown_path).toBe('string');
    expect(output.run_surface_status_text).toBe(
      'Done: review completed with required process evidence.',
    );
    expect(output).not.toHaveProperty('run_decision_packet_paths');
    expect(output.outcome).toBe('complete');

    const shadowPath = join(runFolder, RUN_ENVELOPE_SHADOW_RELATIVE_PATH);
    expect(existsSync(shadowPath)).toBe(true);
    const record = RunEnvelopeShadowRecord.parse(JSON.parse(readFileSync(shadowPath, 'utf8')));
    expect(record).toMatchObject({
      schema: 'run.envelope-shadow@v0',
      mode: 'shadow',
      selected_process: {
        process_id: 'review',
        routed_by: 'explicit',
      },
      child_run: {
        outcome: 'complete',
        result_ref: {
          source: 'child_result',
          ref: { ref: 'reports/result.json' },
        },
      },
    });

    const sourcePath = join(runFolder, RUN_ENVELOPE_RELATIVE_PATH);
    expect(existsSync(sourcePath)).toBe(true);
    const sourceRecord = RunEnvelopeRecord.parse(JSON.parse(readFileSync(sourcePath, 'utf8')));
    expect(sourceRecord.outcome).toBe('complete');
    expect(sourceRecord.completion_gate).toMatchObject({
      verdict: 'complete',
      clean_streak: 2,
      required_passes: 2,
      next_action: 'close',
    });
    expect(sourceRecord.completion_gate.gate_passes.map((pass) => pass.attack_lens)).toEqual([
      'required-evidence-present',
      'child-outcome-consistent',
    ]);
    expect(sourceRecord.process_attempts[0]?.evidence_refs.map((ref) => ref.source)).toContain(
      'process_evidence',
    );

    const surfaceMarkdown = readFileSync(output.run_surface_markdown_path as string, 'utf8');
    expect(surfaceMarkdown).toContain('⎿ Done: review completed with required process evidence.');
    expect(surfaceMarkdown).toContain('[Run envelope]');
    expect(surfaceMarkdown).toContain('[Process evidence]');
  });

  it('writes a checkpoint-waiting shadow artifact without a child result ref', async () => {
    const runFolder = join(tempDir, 'build-run');
    const output = await runMainJsonInProject(
      [
        'run',
        'build',
        '--goal',
        'Frame a Build change',
        '--process',
        'high',
        '--run-folder',
        runFolder,
      ],
      createProofProject(),
    );

    expect(output.outcome).toBe('checkpoint_waiting');
    expect(output).not.toHaveProperty('result_path');
    expect(output).not.toHaveProperty('run_envelope_shadow_path');
    expect(output.run_envelope_path).toBe(join(runFolder, RUN_ENVELOPE_RELATIVE_PATH));
    expect(typeof output.run_surface_markdown_path).toBe('string');
    expect(output.run_surface_status_text).toBe('Needs input: build is waiting at a checkpoint.');
    expect(output.run_decision_packet_paths).toEqual([
      join(runFolder, 'reports/decision-packets/decision-checkpoint-primary.json'),
    ]);

    const shadowPath = join(runFolder, RUN_ENVELOPE_SHADOW_RELATIVE_PATH);
    expect(existsSync(shadowPath)).toBe(true);
    const record = RunEnvelopeShadowRecord.parse(JSON.parse(readFileSync(shadowPath, 'utf8')));
    expect(record.child_run.outcome).toBe('checkpoint_waiting');
    expect(record.child_run.result_ref).toBeUndefined();
    expect(record.child_run.checkpoint).toMatchObject({
      step_id: 'frame-step',
      allowed_choices: ['continue'],
    });

    const sourcePath = join(runFolder, RUN_ENVELOPE_RELATIVE_PATH);
    expect(existsSync(sourcePath)).toBe(true);
    const sourceRecord = RunEnvelopeRecord.parse(JSON.parse(readFileSync(sourcePath, 'utf8')));
    expect(sourceRecord.outcome).toBe('needs_attention');
    expect(sourceRecord.process_attempts[0]?.outcome).toBe('checkpoint_waiting');
    expect(sourceRecord.process_attempts[0]?.child_run.result_ref).toBeUndefined();
    expect(sourceRecord.decision_packets[0]).toMatchObject({
      reason: 'process-checkpoint',
      resume_target: {
        kind: 'process-checkpoint',
        step_id: 'frame-step',
      },
    });

    const surfaceMarkdown = readFileSync(output.run_surface_markdown_path as string, 'utf8');
    expect(surfaceMarkdown).toContain('⎿ Needs input: build is waiting at a checkpoint.');
    expect(surfaceMarkdown).toContain('[Decision packet]');
    expect(surfaceMarkdown).toContain('[Decision request]');
  });
});
