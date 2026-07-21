#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function flagValue(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function progress(type, runId, flowId, label) {
  process.stderr.write(
    `${JSON.stringify({
      schema_version: 1,
      type,
      run_id: runId,
      flow_id: flowId,
      recorded_at: new Date().toISOString(),
      label,
    })}\n`,
  );
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function writeJsonArtifact(runFolder, relative, value) {
  const absolute = path.join(runFolder, relative);
  const body = `${JSON.stringify(value)}\n`;
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, body);
  return { path: relative, sha256: sha256(body) };
}

async function writeCheckpointFixture(runFolder, flow, flowRoot) {
  if (flowRoot === undefined) throw new Error('checkpoint fixture is missing its flow root');
  const flowPackage = JSON.parse(readFileSync(path.join(flowRoot, flow, 'circuit.json'), 'utf8'));
  const step = flowPackage.steps.find(
    (candidate) =>
      candidate.kind === 'checkpoint' &&
      (flow !== 'prototype' || candidate.id === 'prototype-checkpoint-step'),
  );
  if (step === undefined) throw new Error(`${flow} has no checkpoint fixture step`);

  const reviewPaths = [
    ...(Array.isArray(step.reads) ? step.reads : []),
    ...(step.writes?.report?.path === undefined ? [] : [step.writes.report.path]),
  ];
  const reviewInputs = [];
  for (const reviewPath of reviewPaths) {
    const content =
      flow === 'build' && reviewPath === step.writes.report.path
        ? {
            schema: 'build.brief@v1',
            objective: 'Review the checkpoint fixture.',
            scope: step.policy.report_template.scope,
            success_criteria: step.policy.report_template.success_criteria,
            checkpoint_packet: {
              choices: step.policy.choices.map((choice) => ({
                id: choice.id,
                label: choice.label ?? choice.id,
                description: `Approve the bounded Build route '${choice.id}'.`,
              })),
            },
          }
        : {
            schema: 'fixture.checkpoint-review@v1',
            flow,
            source: reviewPath,
            summary: `Decision material for ${path.basename(reviewPath, '.json')}.`,
          };
    reviewInputs.push(await writeJsonArtifact(runFolder, reviewPath, content));
  }
  const choices = step.policy.choices.map((choice) => ({
    id: choice.id,
    ...(choice.label === undefined ? {} : { label: choice.label }),
    ...(choice.description === undefined ? {} : { description: choice.description }),
  }));
  const request = {
    schema_version: 1,
    step_id: step.id,
    prompt: step.policy.prompt,
    allowed_choices: choices.map((choice) => choice.id),
    choices,
    ...(step.policy.safe_default_choice === undefined
      ? {}
      : { safe_default_choice: step.policy.safe_default_choice }),
    execution_context: { review_inputs: reviewInputs },
  };
  const requestArtifact = await writeJsonArtifact(runFolder, step.writes.request, request);
  return {
    step_id: step.id,
    attempt: 1,
    request_path: path.join(runFolder, requestArtifact.path),
    request_sha256: requestArtifact.sha256,
    allowed_choices: request.allowed_choices,
  };
}

async function configShow() {
  const configPath = path.join(process.cwd(), '.circuit', 'config.yaml');
  if (!existsSync(configPath)) {
    writeJson({ schema_version: 1, layers: [], effective: {} });
    return;
  }
  const raw = readFileSync(configPath, 'utf8');
  if (/slow-config/.test(raw)) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  if (/schema_version\s*:\s*2/.test(raw)) {
    writeJson({ schema_version: 1, layers: [], effective: {} });
    return;
  }
  const claude = /claude-code/.test(raw);
  const custom = /custom-command/.test(raw);
  writeJson({
    schema_version: 1,
    layers: [
      {
        layer: 'project',
        source_path: configPath,
        config: {
          schema_version: 1,
          relay: {
            default: 'auto',
            roles: claude ? { reviewer: { kind: 'builtin', name: 'claude-code' } } : {},
            flows: {},
            connectors: custom
              ? {
                  'custom-command': {
                    name: 'custom-command',
                    command: '/tmp/not-run',
                  },
                }
              : {},
          },
          flows: {},
        },
      },
    ],
    effective: {},
  });
}

async function writeFlowReport(runFolder, flow, outcome = 'complete') {
  const report = {
    schema_version: 1,
    outcome,
    verdict: outcome === 'complete' ? 'NO_ISSUES' : 'ISSUES_FOUND',
    findings: [],
    assessment: `Fixture ${flow} completed.`,
    verification: ['fixture'],
    confidence_limitations: [],
    environment_sentinel_seen: process.env.CIRCUIT_MCP_SENTINEL ?? null,
  };
  await mkdir(path.join(runFolder, 'reports'), { recursive: true });
  await writeFile(path.join(runFolder, 'reports', `${flow}-result.json`), JSON.stringify(report));
}

async function runFlow(args) {
  const flow = args[1] ?? 'review';
  const goal = flagValue(args, '--goal') ?? '';
  const runFolder = flagValue(args, '--run-folder');
  if (runFolder === undefined) throw new Error('missing run folder');
  const runId = path.basename(runFolder);
  await mkdir(runFolder, { recursive: true });
  await writeFile(path.join(runFolder, 'fixture-flow'), flow);
  progress('route.selected', runId, flow, `Selected ${flow}`);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
  progress('step.started', runId, flow, 'Fixture step');

  if (goal.includes('runtime failure')) {
    process.stderr.write('fixture connector authentication failed\n');
    process.stdout.write('not-json\n');
    process.exitCode = 3;
    return;
  }

  if (goal.includes('noisy')) {
    for (let index = 0; index < 2_100; index += 1) {
      progress('step.started', runId, flow, `Fixture progress ${index}`);
    }
  }

  if (goal.includes('slow')) {
    const workerPidPath = path.join(runFolder, 'worker.pid');
    const heartbeatPath = path.join(runFolder, 'heartbeat');
    const worker = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), 'heartbeat', heartbeatPath],
      {
        detached: true,
        stdio: 'ignore',
      },
    );
    await writeFile(workerPidPath, String(worker.pid));
    worker.unref();
    setInterval(() => undefined, 60_000);
    return;
  }

  if (goal.includes('restart recovery')) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }

  if (goal.includes('checkpoint')) {
    const checkpoint = await writeCheckpointFixture(
      runFolder,
      flow,
      flagValue(args, '--flow-root'),
    );
    writeJson({
      schema_version: 1,
      run_id: runId,
      flow_id: flow,
      outcome: 'checkpoint_waiting',
      checkpoint,
    });
    return;
  }

  if (!goal.includes('missing report')) await writeFlowReport(runFolder, flow);
  writeJson({
    schema_version: 1,
    run_id: runId,
    flow_id: flow,
    outcome: 'complete',
    reason: 'fixture complete',
  });
  if (goal.includes('nonzero complete')) {
    process.stderr.write('fixture teardown failed after result\n');
    process.exitCode = 3;
  }
}

async function resumeFlow(args) {
  const runFolder = flagValue(args, '--run-folder');
  const choice = flagValue(args, '--checkpoint-choice');
  if (runFolder === undefined || choice === undefined) throw new Error('missing resume input');
  const runId = path.basename(runFolder);
  const flow = readFileSync(path.join(runFolder, 'fixture-flow'), 'utf8');
  progress('checkpoint.resolved', runId, flow, `Chose ${choice}`);
  await writeFlowReport(runFolder, flow);
  writeJson({
    schema_version: 1,
    run_id: runId,
    flow_id: flow,
    outcome: 'complete',
    reason: `fixture resumed with ${choice}`,
  });
}

async function heartbeat(file) {
  await writeFile(file, String(Date.now()));
  setInterval(async () => {
    await writeFile(file, String(Date.now()));
  }, 25);
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === 'config' && args[1] === 'show') return await configShow();
  if (args[0] === 'run') return await runFlow(args);
  if (args[0] === 'resume') return await resumeFlow(args);
  if (args[0] === 'heartbeat' && args[1] !== undefined) return await heartbeat(args[1]);
  throw new Error(`unknown fake runtime command: ${args.join(' ')}`);
}

await main();
