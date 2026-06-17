import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow } from '../helpers/runtime-fixtures.js';

import type { ClaudeCodeRelayInput } from '../../src/connectors/claude-code.js';
import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import { LayeredConfig } from '../../src/schemas/config.js';
import type { RelayResult } from '../../src/shared/connector-relay.js';
import type { RelayFn } from '../../src/shared/relay-runtime-types.js';

// Step 2 — the live equipment reshape, end to end through the real Build flow.
// The first time the engine adapts a RUNNING flow. The researcher relay
// (analyze-step) surfaces a confirmed turned-out-react discovery in its report;
// the runner re-resolves equipment on the REMAINING relay steps (act-step,
// review-step), re-validates the whole flow through the compiled-flow gate, and
// the implementer relay then runs WITH the injected react-expert skill loaded.
// An unconfirmed discovery parks as a finding and the run continues un-reshaped.
//
// The injected `react-expert` slot is bound to an on-disk skill so its body
// reaching the act-step prompt (and skills.loaded) is hard proof the reshaped
// equipment was actually carried into the downstream relay, not just recorded.
// Hermetic: HOME points at a temp skills root, so only this skill resolves.

const FIXTURE_PATH = resolve('generated/flows/build/circuit.json');
const TIMEOUT_MS = 15_000;
const REACT_BODY = 'UNIQUE_INJECTED_REACT_EXPERT_SKILL_BODY';

let runFolderBase: string;
let homeDir: string;
let originalHome: string | undefined;

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-equip-reshape-'));
  homeDir = join(runFolderBase, 'home');
  originalHome = process.env.HOME;
  process.env.HOME = homeDir;
});

afterEach(() => {
  if (originalHome === undefined) {
    Reflect.deleteProperty(process.env, 'HOME');
  } else {
    process.env.HOME = originalHome;
  }
  rmSync(runFolderBase, { recursive: true, force: true });
});

function writeSkill(id: string, body: string): void {
  const dir = join(homeDir, '.agents', 'skills', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), body, 'utf8');
}

function fixtureBytes(): Buffer {
  return readFileSync(FIXTURE_PATH);
}

// Bind the slot id react-expert (the skill the equipment resolver injects for a
// react domain tag) to the on-disk react-expert skill, so an equipped relay
// actually loads it.
function reactBindingLayer(): LayeredConfig {
  return LayeredConfig.parse({
    layer: 'user-global',
    config: {
      schema_version: 1,
      skills: { bindings: { 'react-expert': 'react-expert' } },
    },
  });
}

// A passing project root (npm run check exits 0) so a Build run flows all the
// way through act → verify → review → close.
function passingProjectRoot(): string {
  const projectRoot = join(runFolderBase, 'project');
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(
    join(projectRoot, 'package.json'),
    `${JSON.stringify({ private: true, scripts: { check: 'node -e "process.exit(0)"' } }, null, 2)}\n`,
  );
  return projectRoot;
}

// A Build relayer whose analyze (researcher) report carries an equipment
// discovery, and which records the act-step (implementer) prompts so the test
// can assert whether the injected skill body reached the relay.
function discoveryRelayer(opts: {
  readonly confirmed: boolean;
  readonly onActPrompt: (prompt: string) => void;
}): RelayFn {
  const context = JSON.stringify({
    verdict: 'accept',
    sources: [
      { kind: 'file', ref: 'src/example.tsx', summary: 'React component the change touches' },
    ],
    observations: ['Small self-contained React component'],
    open_questions: [],
    anticipated_file_extensions: ['.tsx'],
    slices: [
      { id: 'slice-1', intent: 'implement the change', anticipated_file_extensions: ['.tsx'] },
    ],
    equipment_discovery: {
      confirmed: opts.confirmed,
      domain_tags: ['react'],
      evidence: 'package.json depends on react and the touched files use JSX',
    },
  });
  const implementation = JSON.stringify({
    verdict: 'accept',
    summary: 'Implemented the requested change',
    changed_files: ['src/example.tsx'],
    evidence: ['stub'],
  });
  const review = JSON.stringify({
    verdict: 'accept',
    summary: 'ok',
    findings: [],
    alignment: { scope_adherence: 'within_scope', non_goals: [], invariants: [] },
  });
  return {
    connectorName: 'claude-code',
    relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
      const isAnalyze = input.prompt.includes('Step: analyze-step');
      const isAct = input.prompt.includes('Step: act-step');
      if (isAct) opts.onActPrompt(input.prompt);
      return {
        request_payload: input.prompt,
        receipt_id: 'stub',
        result_body: isAnalyze ? context : isAct ? implementation : review,
        duration_ms: 1,
        cli_version: '0.0.0-stub',
      };
    },
  };
}

async function readTrace(runFolder: string) {
  return await new TraceStore(runFolder).load();
}

function reshapeEntries(entries: Awaited<ReturnType<typeof readTrace>>) {
  return entries.filter(
    (entry): entry is Extract<(typeof entries)[number], { kind: 'run.equipment-reshape' }> =>
      entry.kind === 'run.equipment-reshape',
  );
}

function actStepSkillIds(entries: Awaited<ReturnType<typeof readTrace>>): string[] {
  return entries
    .filter(
      (entry): entry is Extract<(typeof entries)[number], { kind: 'skills.loaded' }> =>
        entry.kind === 'skills.loaded' && entry.step_id === 'act-step',
    )
    .flatMap((entry) => (entry.skills as ReadonlyArray<{ readonly id: string }>).map((s) => s.id));
}

describe('Live equipment reshape (Build, confirmed turned-out-react discovery)', () => {
  it(
    're-resolves, re-compiles, and continues with the injected equipment loaded into the next relay',
    async () => {
      writeSkill('react-expert', REACT_BODY);
      const runFolder = join(runFolderBase, 'confirmed');
      const actPrompts: string[] = [];
      const result = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: fixtureBytes(),
        runId: 'e1000000-0000-0000-0000-000000000001',
        goal: 'Add a tiny React feature',
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 5, 17, 4, 0, 0)),
        relayer: discoveryRelayer({ confirmed: true, onActPrompt: (p) => actPrompts.push(p) }),
        projectRoot: passingProjectRoot(),
        selectionConfigLayers: [reactBindingLayer()],
      });

      // The run records exactly one honored reshape, triggered by analyze-step,
      // equipping the remaining relay steps.
      const entries = await readTrace(runFolder);
      const reshapes = reshapeEntries(entries);
      const honored = reshapes.find((entry) => entry.reshaped);
      expect(honored).toBeDefined();
      expect(honored?.step_id).toBe('analyze-step');
      expect(honored?.confirmed).toBe(true);
      expect(honored?.domain_tags).toContain('react');
      expect(honored?.equipped_steps ?? []).toEqual(
        expect.arrayContaining(['act-step', 'review-step']),
      );

      // The injected skill was actually carried into the implementer relay:
      // its body reached the prompt and skills.loaded records it for act-step.
      expect(actPrompts.length).toBeGreaterThan(0);
      expect(actPrompts.some((prompt) => prompt.includes(REACT_BODY))).toBe(true);
      expect(actStepSkillIds(entries)).toContain('react-expert');

      // The run continued on the reshaped tail to completion (no broken tail).
      expect(result.outcome).not.toBe('aborted');
    },
    TIMEOUT_MS,
  );
});

describe('Live equipment reshape (Build, unconfirmed discovery parks as a finding)', () => {
  it(
    'records a finding and continues un-reshaped — the next relay does not load the equipment',
    async () => {
      writeSkill('react-expert', REACT_BODY);
      const runFolder = join(runFolderBase, 'unconfirmed');
      const actPrompts: string[] = [];
      const result = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: fixtureBytes(),
        runId: 'e1000000-0000-0000-0000-000000000002',
        goal: 'Add a tiny feature',
        depth: 'medium',
        now: deterministicNow(Date.UTC(2026, 5, 17, 4, 30, 0)),
        relayer: discoveryRelayer({ confirmed: false, onActPrompt: (p) => actPrompts.push(p) }),
        projectRoot: passingProjectRoot(),
        selectionConfigLayers: [reactBindingLayer()],
      });

      // An unconfirmed discovery is recorded as a finding (reshaped:false), never
      // honored.
      const entries = await readTrace(runFolder);
      const reshapes = reshapeEntries(entries);
      expect(reshapes.length).toBeGreaterThan(0);
      expect(reshapes.every((entry) => entry.reshaped === false)).toBe(true);
      const parked = reshapes.find((entry) => entry.step_id === 'analyze-step');
      expect(parked?.confirmed).toBe(false);

      // The equipment was never injected: the implementer relay ran without it.
      expect(actPrompts.length).toBeGreaterThan(0);
      expect(actPrompts.every((prompt) => !prompt.includes(REACT_BODY))).toBe(true);
      expect(actStepSkillIds(entries)).not.toContain('react-expert');

      // The run still completed on the original, valid flow.
      expect(result.outcome).not.toBe('aborted');
    },
    TIMEOUT_MS,
  );
});
