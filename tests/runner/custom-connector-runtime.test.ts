import { afterEach, describe, expect, it } from 'vitest';

import { relayCustom } from '../../src/connectors/custom.js';
import { CustomConnectorDescriptor } from '../../src/schemas/connector.js';

const ENV_TOKEN = 'CIRCUIT_CUSTOM_CONNECTOR_TEST_TOKEN';

function descriptor(command: readonly string[]): CustomConnectorDescriptor {
  return CustomConnectorDescriptor.parse({
    kind: 'custom',
    name: 'test-reviewer',
    command,
    prompt_transport: 'prompt-file',
    output: { kind: 'output-file' },
    capabilities: { filesystem: 'read-only', structured_output: 'json' },
  });
}

afterEach(() => {
  delete process.env[ENV_TOKEN];
});

describe('custom connector runtime protocol', () => {
  it('uses direct argv, prompt/output files, inherited cwd/env, and ignored stdin', async () => {
    process.env[ENV_TOKEN] = 'visible-to-custom-connector';
    const shellMeaningfulArg = `$${ENV_TOKEN}; echo should-not-run`;
    const script = [
      "const { readFileSync, writeFileSync } = require('node:fs');",
      'const args = process.argv.slice(1);',
      'const promptFile = args[args.length - 2];',
      'const outputFile = args[args.length - 1];',
      'const authoredArgs = args.slice(0, -2);',
      "let stdin = '';",
      "try { stdin = readFileSync(0, 'utf8'); } catch (err) { stdin = `error:${err.code ?? err.message}`; }",
      'writeFileSync(outputFile, JSON.stringify({',
      "verdict: 'accept',",
      "prompt: readFileSync(promptFile, 'utf8'),",
      'authoredArgs,',
      'cwd: process.cwd(),',
      `envToken: process.env.${ENV_TOKEN},`,
      'stdin,',
      '}));',
    ].join(' ');

    const result = await relayCustom({
      descriptor: descriptor([process.execPath, '-e', script, shellMeaningfulArg]),
      prompt: 'custom connector prompt',
      resolvedSelection: { skills: [], invocation_options: {} },
    });

    expect(result.request_payload).toBe('custom connector prompt');
    expect(result.receipt_id).toMatch(/^custom:test-reviewer:\d+$/);
    expect(result.cli_version).toBe('custom:test-reviewer');
    expect(JSON.parse(result.result_body)).toEqual({
      verdict: 'accept',
      prompt: 'custom connector prompt',
      authoredArgs: [shellMeaningfulArg],
      cwd: process.cwd(),
      envToken: 'visible-to-custom-connector',
      stdin: '',
    });
  });

  it('treats the output file as canonical and extracts the first JSON object', async () => {
    const script = [
      "const { writeFileSync } = require('node:fs');",
      'const outputFile = process.argv[process.argv.length - 1];',
      "console.log(JSON.stringify({ verdict: 'wrong-source' }));",
      "writeFileSync(outputFile, `status before JSON\\n${JSON.stringify({ verdict: 'accept', source: 'output-file' })}\\nstatus after JSON`);",
    ].join(' ');

    const result = await relayCustom({
      descriptor: descriptor([process.execPath, '-e', script]),
      prompt: 'use the output file',
      resolvedSelection: { skills: [], invocation_options: {} },
    });

    expect(JSON.parse(result.result_body)).toEqual({
      verdict: 'accept',
      source: 'output-file',
    });
  });

  it('exposes the resolved model and effort to the subprocess as CIRCUIT_RELAY_* env vars', async () => {
    const script = [
      "const { writeFileSync } = require('node:fs');",
      'const outputFile = process.argv[process.argv.length - 1];',
      'writeFileSync(outputFile, JSON.stringify({',
      'model: process.env.CIRCUIT_RELAY_MODEL ?? null,',
      'provider: process.env.CIRCUIT_RELAY_MODEL_PROVIDER ?? null,',
      'effort: process.env.CIRCUIT_RELAY_EFFORT ?? null,',
      '}));',
    ].join(' ');

    const result = await relayCustom({
      descriptor: descriptor([process.execPath, '-e', script]),
      prompt: 'report your selection env',
      resolvedSelection: {
        model: { provider: 'custom', model: 'local/qwen2.5-coder:7b' },
        effort: 'low',
        skills: [],
        invocation_options: {},
      },
    });

    expect(JSON.parse(result.result_body)).toEqual({
      model: 'local/qwen2.5-coder:7b',
      provider: 'custom',
      effort: 'low',
    });
  });

  it('leaves CIRCUIT_RELAY_* env vars unset when the selection carries no model or effort', async () => {
    const script = [
      "const { writeFileSync } = require('node:fs');",
      'const outputFile = process.argv[process.argv.length - 1];',
      'writeFileSync(outputFile, JSON.stringify({',
      "modelSet: 'CIRCUIT_RELAY_MODEL' in process.env,",
      "providerSet: 'CIRCUIT_RELAY_MODEL_PROVIDER' in process.env,",
      "effortSet: 'CIRCUIT_RELAY_EFFORT' in process.env,",
      '}));',
    ].join(' ');

    const result = await relayCustom({
      descriptor: descriptor([process.execPath, '-e', script]),
      prompt: 'report which env vars exist',
      resolvedSelection: { skills: [], invocation_options: {} },
    });

    expect(JSON.parse(result.result_body)).toEqual({
      modelSet: false,
      providerSet: false,
      effortSet: false,
    });
  });

  it('fails nonzero connectors with a capped stderr sample', async () => {
    const script = ["console.error('custom connector failed loudly');", 'process.exit(7);'].join(
      ' ',
    );

    await expect(
      relayCustom({
        descriptor: descriptor([process.execPath, '-e', script]),
        prompt: 'fail please',
        resolvedSelection: { skills: [], invocation_options: {} },
      }),
    ).rejects.toThrow(
      /custom connector 'test-reviewer' exited with code 7; stderr\[:500\]=custom connector failed loudly/s,
    );
  });

  it('fails timed-out connectors naming the bound that fired and its remedy', async () => {
    const script = [
      "console.error('custom connector still running');",
      'setInterval(() => {}, 1000);',
    ].join(' ');

    await expect(
      relayCustom({
        descriptor: descriptor([process.execPath, '-e', script]),
        prompt: 'timeout please',
        timeoutMs: 20,
        resolvedSelection: { skills: [], invocation_options: {} },
      }),
    ).rejects.toThrow(
      /custom connector 'test-reviewer' timed out: exceeded the 20ms wall-clock backstop.*budgets\.wall_clock_ms.*stderr\[:500\]=/s,
    );
  });
});
