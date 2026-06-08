import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow } from '../helpers/runtime-fixtures.js';

import { writeOperatorSummary } from '../../src/app/operator-summary/writer.js';
import type { ClaudeCodeRelayInput } from '../../src/connectors/claude-code.js';
import { fromCompiledFlow } from '../../src/runtime/manifest/from-compiled-flow.js';
import {
  parseCompiledFlowBytes,
  runCompiledFlow,
} from '../../src/runtime/run/compiled-flow-runner.js';
import { executeExecutableFlowOutcome } from '../../src/runtime/run/graph-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import { Config } from '../../src/schemas/config.js';
import type { LayeredConfig } from '../../src/schemas/config.js';
import {
  PolicyLayer,
  type PolicyLayer as PolicyLayerValue,
} from '../../src/schemas/policy-envelope.js';
import { RunResult } from '../../src/schemas/result.js';
import type { RelayResult } from '../../src/shared/connector-relay.js';
import type { RelayFn } from '../../src/shared/relay-runtime-types.js';

// Slice 3 (the actuator): an `auto` skill-hook policy injects its resolved
// skills into subsequent IMPLEMENTER relay prompts and the skills.loaded trace,
// while `mute` records the event but injects nothing. Injection is role-scoped —
// a researcher or reviewer relay never receives an injected (edit-oriented)
// skill. Proven end-to-end on Build's before:edit-files arm (the plan predicts a
// file surface, the matching auto rule injects, a non-matching rule does not),
// the after:verification-failed retry arm, and the no-cross-role-leak case.
// Hermetic: HOME points at a temp skills root, so only the skills this test
// writes resolve.

const FIXTURE_PATH = resolve('generated/flows/build/circuit.json');
const TIMEOUT_MS = 15_000;
const TDD_BODY = 'UNIQUE_INJECTED_TDD_SKILL_BODY';
const PY_BODY = 'UNIQUE_UNPREDICTED_PYTHON_SKILL_BODY';
const RD_BODY = 'UNIQUE_INJECTED_REACT_DOCTOR_SKILL_BODY';

let runFolderBase: string;
let homeDir: string;
let originalHome: string | undefined;

beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-skill-actuation-'));
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

// A Build relayer whose analyze (context) output predicts a `.ts` file surface,
// so the compiled plan carries `anticipated_file_extensions` (the
// before:edit-files detection signal), and which captures the act-step prompts.
function surfaceRelayer(opts: {
  readonly extensions: readonly string[];
  readonly onActPrompt: (prompt: string) => void;
}): RelayFn {
  const context = JSON.stringify({
    verdict: 'accept',
    sources: [{ kind: 'file', ref: 'src/example.ts', summary: 'Module the change touches' }],
    observations: ['Small self-contained module'],
    open_questions: [],
    anticipated_file_extensions: opts.extensions,
    slices: [
      {
        id: 'slice-1',
        intent: 'implement the change',
        anticipated_file_extensions: opts.extensions,
      },
    ],
  });
  const implementation = JSON.stringify({
    verdict: 'accept',
    summary: 'Implemented the requested change',
    changed_files: ['src/example.ts'],
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

function failingProjectRoot(): string {
  const projectRoot = join(runFolderBase, 'project');
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(
    join(projectRoot, 'package.json'),
    `${JSON.stringify({ private: true, scripts: { check: 'node -e "process.exit(1)"' } }, null, 2)}\n`,
  );
  return projectRoot;
}

function projectPolicyLayer(policy: Record<string, unknown>): LayeredConfig {
  return {
    layer: 'project',
    source_path: '.circuit/config.yaml',
    config: Config.parse({ schema_version: 1, skill_hooks: { policy } }),
  };
}

// A PolicyEnvelope layer that denies the given skill ids (the hard-constraint
// gate assertPolicyAllowsRelayPlan enforces against loaded skills).
function denySkillsPolicyLayer(skills: readonly string[]): PolicyLayerValue {
  return PolicyLayer.parse({
    source: 'project',
    envelope: {
      schema_version: 2,
      policy: { rules: { skills: { deny: [...skills] } } },
    },
  });
}

async function readTrace(runFolder: string) {
  return await new TraceStore(runFolder).load();
}

function skillHookEntries(entries: Awaited<ReturnType<typeof readTrace>>) {
  return entries.filter(
    (entry): entry is Extract<(typeof entries)[number], { kind: 'run.skill-hook' }> =>
      entry.kind === 'run.skill-hook',
  );
}

function actStepSkillsLoaded(entries: Awaited<ReturnType<typeof readTrace>>) {
  return entries.filter(
    (entry): entry is Extract<(typeof entries)[number], { kind: 'skills.loaded' }> =>
      entry.kind === 'skills.loaded' && entry.step_id === 'act-step',
  );
}

function traceIndex(
  entries: Awaited<ReturnType<typeof readTrace>>,
  predicate: (entry: (typeof entries)[number]) => boolean,
): number {
  const index = entries.findIndex(predicate);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

describe('Skill-hook actuation (auto injection, Build before:edit-files)', () => {
  it(
    'injects an auto-matched skill into the next relay prompt and skills.loaded',
    async () => {
      writeSkill('tdd', TDD_BODY);
      writeSkill('python-doctor', PY_BODY);
      const runFolder = join(runFolderBase, 'auto-inject');
      const actPrompts: string[] = [];
      await runCompiledFlow({
        runDir: runFolder,
        flowBytes: fixtureBytes(),
        runId: 'b1000000-0000-0000-0000-000000000001',
        goal: 'Add a tiny Build feature',
        depth: 'standard',
        now: deterministicNow(Date.UTC(2026, 5, 4, 3, 0, 0)),
        relayer: surfaceRelayer({ extensions: ['.ts'], onActPrompt: (p) => actPrompts.push(p) }),
        projectRoot: failingProjectRoot(),
        selectionConfigLayers: [
          projectPolicyLayer({
            'before:edit-files:.ts': { mode: 'auto', skills: ['tdd'] },
            'before:edit-files:.py': { mode: 'auto', skills: ['python-doctor'] },
          }),
        ],
      });

      // The plan predicted .ts, so the .ts auto rule resolved tdd and injected it.
      const entries = await readTrace(runFolder);
      const before = skillHookEntries(entries).find(
        (entry) => entry.event.hook === 'before:edit-files:.ts',
      );
      expect(before?.event.policy).toMatchObject({ mode: 'auto', source: 'project-policy' });
      expect(before?.event.triggered_skills.map((skill) => skill.id as string)).toContain('tdd');
      // A plain auto event with a resolved skill carries no pending decision, so
      // the actuator gate lets it inject (contrast the strict-unavailable case).
      expect(before?.event.decision_packet_id).toBeUndefined();

      // The act-step relay prompt carries the injected skill body ...
      expect(actPrompts.length).toBeGreaterThan(0);
      expect(actPrompts.some((prompt) => prompt.includes(TDD_BODY))).toBe(true);
      // ... and skills.loaded records tdd as loaded for the act step.
      const loaded = actStepSkillsLoaded(entries);
      expect(loaded.length).toBeGreaterThan(0);
      expect(
        loaded.some((entry) =>
          (entry.skills as ReadonlyArray<{ readonly id: string }>).some(
            (skill) => skill.id === 'tdd',
          ),
        ),
      ).toBe(true);
      const planCompletedIndex = traceIndex(
        entries,
        (entry) =>
          entry.kind === 'step.completed' &&
          entry.step_id === before?.event.step_id &&
          entry.route_taken === 'pass',
      );
      const hookIndex = traceIndex(entries, (entry) => entry === before);
      const actLoadedIndex = traceIndex(
        entries,
        (entry) =>
          entry.kind === 'skills.loaded' &&
          entry.step_id === 'act-step' &&
          (entry.skills as ReadonlyArray<{ readonly id: string }>).some(
            (skill) => skill.id === 'tdd',
          ),
      );
      expect(hookIndex).toBeGreaterThan(planCompletedIndex);
      expect(actLoadedIndex).toBeGreaterThan(hookIndex);

      // The unpredicted .py rule never fired, so python-doctor is never injected.
      expect(actPrompts.every((prompt) => !prompt.includes(PY_BODY))).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    'a strict auto policy with an unavailable skill records the decision but injects nothing',
    async () => {
      // strict means "if a configured skill is missing, do not silently proceed —
      // surface a decision." buildRunSkillHookEvent sets a strict-skill-unavailable
      // decision_packet_id, and the actuator must then inject NOTHING (not even the
      // skills that resolved) until that decision is made. tdd resolves;
      // missing-skill does not.
      writeSkill('tdd', TDD_BODY);
      const runFolder = join(runFolderBase, 'strict-unavailable');
      const actPrompts: string[] = [];
      await runCompiledFlow({
        runDir: runFolder,
        flowBytes: fixtureBytes(),
        runId: 'b1000000-0000-0000-0000-000000000005',
        goal: 'Add a tiny Build feature',
        depth: 'standard',
        now: deterministicNow(Date.UTC(2026, 5, 4, 3, 30, 0)),
        relayer: surfaceRelayer({ extensions: ['.ts'], onActPrompt: (p) => actPrompts.push(p) }),
        projectRoot: failingProjectRoot(),
        selectionConfigLayers: [
          projectPolicyLayer({
            'before:edit-files:.ts': {
              mode: 'auto',
              strict: true,
              skills: ['tdd', 'missing-skill'],
            },
          }),
        ],
      });

      const entries = await readTrace(runFolder);
      const before = entries
        .filter(
          (entry): entry is Extract<(typeof entries)[number], { kind: 'run.skill-hook' }> =>
            entry.kind === 'run.skill-hook',
        )
        .find((entry) => entry.event.hook === 'before:edit-files:.ts');
      // The event records the split and a pending strict-unavailable decision ...
      expect(before?.event.policy).toMatchObject({ mode: 'auto', strict: true });
      expect(before?.event.triggered_skills.map((skill) => skill.id as string)).toContain('tdd');
      expect((before?.event.unavailable_skills ?? []).map((skill) => skill.id as string)).toContain(
        'missing-skill',
      );
      expect(before?.event.decision_packet_id).toContain('strict-skill-unavailable');
      // ... but injects nothing while that decision is pending — not even tdd.
      expect(actPrompts.length).toBeGreaterThan(0);
      expect(actPrompts.every((prompt) => !prompt.includes(TDD_BODY))).toBe(true);
      expect(actStepSkillsLoaded(entries)).toHaveLength(0);
    },
    TIMEOUT_MS,
  );

  it(
    'a non-strict auto policy injects the resolved skill even when another is unavailable',
    async () => {
      // strict defaults to false: a missing skill is recorded as unavailable but
      // does NOT raise a decision, so the resolved skill still injects.
      writeSkill('tdd', TDD_BODY);
      const runFolder = join(runFolderBase, 'nonstrict-unavailable');
      const actPrompts: string[] = [];
      await runCompiledFlow({
        runDir: runFolder,
        flowBytes: fixtureBytes(),
        runId: 'b1000000-0000-0000-0000-000000000006',
        goal: 'Add a tiny Build feature',
        depth: 'standard',
        now: deterministicNow(Date.UTC(2026, 5, 4, 3, 40, 0)),
        relayer: surfaceRelayer({ extensions: ['.ts'], onActPrompt: (p) => actPrompts.push(p) }),
        projectRoot: failingProjectRoot(),
        selectionConfigLayers: [
          projectPolicyLayer({
            'before:edit-files:.ts': { mode: 'auto', skills: ['tdd', 'missing-skill'] },
          }),
        ],
      });

      const entries = await readTrace(runFolder);
      const before = skillHookEntries(entries).find(
        (entry) => entry.event.hook === 'before:edit-files:.ts',
      );
      expect(before?.event.triggered_skills.map((skill) => skill.id as string)).toContain('tdd');
      expect((before?.event.unavailable_skills ?? []).map((skill) => skill.id as string)).toContain(
        'missing-skill',
      );
      // Non-strict: no pending decision, so the gate injects the resolved skill.
      expect(before?.event.decision_packet_id).toBeUndefined();
      expect(actPrompts.some((prompt) => prompt.includes(TDD_BODY))).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    'defaults an omitted mode to auto and injects',
    async () => {
      // No `mode` key on the rule: it resolves to auto, so tdd injects exactly as
      // an explicit `mode: auto` rule would. This is the terse common case.
      writeSkill('tdd', TDD_BODY);
      const runFolder = join(runFolderBase, 'default-auto-inject');
      const actPrompts: string[] = [];
      await runCompiledFlow({
        runDir: runFolder,
        flowBytes: fixtureBytes(),
        runId: 'b1000000-0000-0000-0000-000000000007',
        goal: 'Add a tiny Build feature',
        depth: 'standard',
        now: deterministicNow(Date.UTC(2026, 5, 4, 3, 45, 0)),
        relayer: surfaceRelayer({ extensions: ['.ts'], onActPrompt: (p) => actPrompts.push(p) }),
        projectRoot: failingProjectRoot(),
        selectionConfigLayers: [
          projectPolicyLayer({ 'before:edit-files:.ts': { skills: ['tdd'] } }),
        ],
      });

      const entries = await readTrace(runFolder);
      const before = skillHookEntries(entries).find(
        (entry) => entry.event.hook === 'before:edit-files:.ts',
      );
      // The omitted mode resolved to auto, so it triggered and injected tdd.
      expect(before?.event.policy.mode).toBe('auto');
      expect(before?.event.triggered_skills.map((skill) => skill.id as string)).toContain('tdd');
      expect(actPrompts.some((prompt) => prompt.includes(TDD_BODY))).toBe(true);
      expect(
        actStepSkillsLoaded(entries).some((entry) =>
          (entry.skills as ReadonlyArray<{ readonly id: string }>).some(
            (skill) => skill.id === 'tdd',
          ),
        ),
      ).toBe(true);
    },
    TIMEOUT_MS,
  );

  it(
    'a PolicyEnvelope skill-deny bounds an auto-injected skill (run aborts before the relay loads it)',
    async () => {
      // The injected skill is still subject to the hard-constraint gate: a policy
      // that denies it makes the implementer relay fail to plan, aborting the run
      // rather than smuggling a denied skill in via a hook.
      writeSkill('tdd', TDD_BODY);
      const runFolder = join(runFolderBase, 'policy-deny-injected');
      const actPrompts: string[] = [];
      const result = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: fixtureBytes(),
        runId: 'b1000000-0000-0000-0000-000000000008',
        goal: 'Add a tiny Build feature',
        depth: 'standard',
        now: deterministicNow(Date.UTC(2026, 5, 4, 3, 50, 0)),
        relayer: surfaceRelayer({ extensions: ['.ts'], onActPrompt: (p) => actPrompts.push(p) }),
        projectRoot: failingProjectRoot(),
        selectionConfigLayers: [
          projectPolicyLayer({ 'before:edit-files:.ts': { mode: 'auto', skills: ['tdd'] } }),
        ],
        policyLayers: [denySkillsPolicyLayer(['tdd'])],
      });

      // The denied injected skill aborts the run at relay planning ...
      expect(result.outcome).toBe('aborted');
      expect(result.reason ?? '').toMatch(/disallows skill 'tdd'/);
      // ... so it never reaches a relay prompt or skills.loaded.
      expect(actPrompts.every((prompt) => !prompt.includes(TDD_BODY))).toBe(true);
      expect(actStepSkillsLoaded(await readTrace(runFolder))).toHaveLength(0);
    },
    TIMEOUT_MS,
  );

  it(
    'a mute policy records the event but injects nothing',
    async () => {
      writeSkill('tdd', TDD_BODY);
      const runFolder = join(runFolderBase, 'mute-no-inject');
      const actPrompts: string[] = [];
      await runCompiledFlow({
        runDir: runFolder,
        flowBytes: fixtureBytes(),
        runId: 'b1000000-0000-0000-0000-000000000002',
        goal: 'Add a tiny Build feature',
        depth: 'standard',
        now: deterministicNow(Date.UTC(2026, 5, 4, 3, 5, 0)),
        relayer: surfaceRelayer({ extensions: ['.ts'], onActPrompt: (p) => actPrompts.push(p) }),
        projectRoot: failingProjectRoot(),
        selectionConfigLayers: [
          projectPolicyLayer({ 'before:edit-files:.ts': { mode: 'mute', strict: false } }),
        ],
      });

      const entries = await readTrace(runFolder);
      const before = skillHookEntries(entries).find(
        (entry) => entry.event.hook === 'before:edit-files:.ts',
      );
      // The event is still recorded ...
      expect(before?.event.policy.mode).toBe('mute');
      expect(before?.event.triggered_skills).toEqual([]);
      // ... but mute injects nothing: no body in the prompt, no skills.loaded.
      expect(actPrompts.length).toBeGreaterThan(0);
      expect(actPrompts.every((prompt) => !prompt.includes(TDD_BODY))).toBe(true);
      expect(actStepSkillsLoaded(entries)).toHaveLength(0);
    },
    TIMEOUT_MS,
  );
});

describe('Skill-hook actuation (auto injection, check-outcome after:verification-failed)', () => {
  it(
    'injects an auto-matched skill into the retry relay after a failed verification',
    async () => {
      // No predicted surface (extensions: []), so before:edit-files never fires;
      // the only signal is the failing verification. after:verification-failed
      // fires AFTER the verify step, so the first act runs un-injected and the
      // recovery (retry) act picks up the injected skill — proving the after /
      // retry timing actuates into the next relay, not the one already run.
      writeSkill('react-doctor', RD_BODY);
      const runFolder = join(runFolderBase, 'after-verify-inject');
      const actPrompts: string[] = [];
      await runCompiledFlow({
        runDir: runFolder,
        flowBytes: fixtureBytes(),
        runId: 'b1000000-0000-0000-0000-000000000003',
        goal: 'Add a tiny Build feature',
        depth: 'standard',
        now: deterministicNow(Date.UTC(2026, 5, 4, 3, 10, 0)),
        relayer: surfaceRelayer({ extensions: [], onActPrompt: (p) => actPrompts.push(p) }),
        projectRoot: failingProjectRoot(),
        selectionConfigLayers: [
          projectPolicyLayer({
            'after:verification-failed': { mode: 'auto', skills: ['react-doctor'] },
          }),
        ],
      });

      const entries = await readTrace(runFolder);
      const fired = skillHookEntries(entries).filter(
        (entry) => entry.event.hook === 'after:verification-failed',
      );
      expect(fired.length).toBeGreaterThan(0);
      expect(fired[0]?.event.policy).toMatchObject({ mode: 'auto', source: 'project-policy' });
      expect(fired[0]?.event.triggered_skills.map((skill) => skill.id as string)).toContain(
        'react-doctor',
      );

      // At least two act relays ran (initial + retry), and the skill body appears
      // only after the trigger: the first act is un-injected, a later one is not.
      expect(actPrompts.length).toBeGreaterThan(1);
      expect(actPrompts[0]?.includes(RD_BODY)).toBe(false);
      expect(actPrompts.some((prompt) => prompt.includes(RD_BODY))).toBe(true);
    },
    TIMEOUT_MS,
  );
});

// A passing project root (npm run check exits 0), so a Build run proceeds past
// verification to the reviewer relay and close.
function passingProjectRoot(): string {
  const projectRoot = join(runFolderBase, 'passing-project');
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(
    join(projectRoot, 'package.json'),
    `${JSON.stringify({ private: true, scripts: { check: 'node -e "process.exit(0)"' } }, null, 2)}\n`,
  );
  return projectRoot;
}

// Captures every relay prompt keyed by its step role, predicting `.ts` so
// before:edit-files:.ts fires after plan-step. Returns passing bodies so the run
// reaches the reviewer relay (review-step) and close.
function roleCapturingRelayer(captured: {
  analyze: string[];
  act: string[];
  review: string[];
}): RelayFn {
  const context = JSON.stringify({
    verdict: 'accept',
    sources: [{ kind: 'file', ref: 'src/example.ts', summary: 'Module the change touches' }],
    observations: ['Small self-contained module'],
    open_questions: [],
    anticipated_file_extensions: ['.ts'],
    slices: [
      { id: 'slice-1', intent: 'implement the change', anticipated_file_extensions: ['.ts'] },
    ],
  });
  const implementation = JSON.stringify({
    verdict: 'accept',
    summary: 'Implemented the requested change',
    changed_files: ['src/example.ts'],
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
      const isReview = input.prompt.includes('Step: review-step');
      if (isAnalyze) captured.analyze.push(input.prompt);
      if (isAct) captured.act.push(input.prompt);
      if (isReview) captured.review.push(input.prompt);
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

describe('Skill-hook actuation (role separation — no cross-role leak)', () => {
  it(
    'injects only into the implementer relay, never the researcher or reviewer relay',
    async () => {
      // before:edit-files:.ts fires after plan-step and injects tdd. The act-step
      // (implementer) must receive it, but the run-scoped channel must NOT leak it
      // into the review-step (reviewer) — a reviewer judges the work independently.
      writeSkill('tdd', TDD_BODY);
      const runFolder = join(runFolderBase, 'no-cross-role-leak');
      const captured = { analyze: [] as string[], act: [] as string[], review: [] as string[] };
      const result = await runCompiledFlow({
        runDir: runFolder,
        flowBytes: fixtureBytes(),
        runId: 'b1000000-0000-0000-0000-000000000004',
        goal: 'Add a tiny Build feature',
        depth: 'standard',
        now: deterministicNow(Date.UTC(2026, 5, 4, 3, 20, 0)),
        relayer: roleCapturingRelayer(captured),
        projectRoot: passingProjectRoot(),
        selectionConfigLayers: [
          projectPolicyLayer({ 'before:edit-files:.ts': { mode: 'auto', skills: ['tdd'] } }),
        ],
      });

      // The run reached the reviewer relay (verification passed).
      expect(result.outcome).not.toBe('aborted');
      expect(captured.act.length).toBeGreaterThan(0);
      expect(captured.review.length).toBeGreaterThan(0);

      // tdd is injected into the implementer (act) relay ...
      expect(captured.act.some((prompt) => prompt.includes(TDD_BODY))).toBe(true);
      // ... but never into the researcher (analyze) or reviewer (review) relay.
      expect(captured.analyze.every((prompt) => !prompt.includes(TDD_BODY))).toBe(true);
      expect(captured.review.every((prompt) => !prompt.includes(TDD_BODY))).toBe(true);

      // skills.loaded confirms tdd loaded for act-step but not review-step.
      const entries = await readTrace(runFolder);
      const loadedFor = (stepId: string) =>
        entries
          .filter(
            (entry): entry is Extract<(typeof entries)[number], { kind: 'skills.loaded' }> =>
              entry.kind === 'skills.loaded' && entry.step_id === stepId,
          )
          .flatMap((entry) =>
            (entry.skills as ReadonlyArray<{ readonly id: string }>).map((s) => s.id),
          );
      expect(loadedFor('act-step')).toContain('tdd');
      expect(loadedFor('review-step')).not.toContain('tdd');
    },
    TIMEOUT_MS,
  );
});

describe('Skill-hook actuation (operator summary disclosure)', () => {
  it(
    'discloses the injected skill, its hook, and provenance in the operator summary',
    async () => {
      // End-to-end: a real Build run injects tdd via before:edit-files:.ts, then
      // the operator-summary writer must surface that the hook fired, what it
      // injected, and which policy authorized it — not leave it buried in the trace.
      writeSkill('tdd', TDD_BODY);
      const runFolder = join(runFolderBase, 'summary-disclosure');
      const captured = { analyze: [] as string[], act: [] as string[], review: [] as string[] };
      await runCompiledFlow({
        runDir: runFolder,
        flowBytes: fixtureBytes(),
        runId: 'b1000000-0000-0000-0000-000000000009',
        goal: 'Add a tiny Build feature',
        depth: 'standard',
        now: deterministicNow(Date.UTC(2026, 5, 4, 4, 0, 0)),
        relayer: roleCapturingRelayer(captured),
        projectRoot: passingProjectRoot(),
        selectionConfigLayers: [
          projectPolicyLayer({ 'before:edit-files:.ts': { mode: 'auto', skills: ['tdd'] } }),
        ],
      });

      const runResult = RunResult.parse(
        JSON.parse(readFileSync(join(runFolder, 'reports', 'result.json'), 'utf8')),
      );
      const written = writeOperatorSummary({
        runFolder,
        runResult,
        route: { selectedFlow: 'build' },
      });

      const activations = written.summary.skill_hook_activations ?? [];
      const before = activations.find((entry) => entry.hook === 'before:edit-files:.ts');
      expect(before).toBeDefined();
      expect(before?.injected_skills).toContain('tdd');
      expect(before?.source).toBe('project-policy');
      expect(before?.policy_ref).toBe('.circuit/config.yaml');

      const markdown = readFileSync(written.markdownPath, 'utf8');
      expect(markdown).toContain('Skill hooks:');
      expect(markdown).toContain('`before:edit-files:.ts` injected tdd');
    },
    TIMEOUT_MS,
  );
});

describe('Skill-hook actuation (checkpoint resume re-seeds injections, D5)', () => {
  it(
    're-seeds an injected skill from the trace so a resumed implementer step still loads it',
    async () => {
      // D5 sub-bug: on resume the injection channel is recreated EMPTY. An `auto`
      // hook that fired before the resume point recorded its injection durably in
      // the trace, but without re-seeding, the resumed implementer step would run
      // WITHOUT that skill — a silent divergence from a single-process run. This
      // reproduces it: process 1 injects tdd via before:edit-files:.ts; we then
      // truncate the trace to just after the injection (dropping the act/verify/
      // review/close tail) and resume at act-step. With the fix the channel is
      // re-seeded from the recorded run.skill-hook event, so the resumed act prompt
      // still carries tdd. Without the fix this assertion fails (channel empty,
      // plan-step is not re-executed, so nothing re-injects).
      writeSkill('tdd', TDD_BODY);
      const folderA = join(runFolderBase, 'resume-seed-process1');
      await runCompiledFlow({
        runDir: folderA,
        flowBytes: fixtureBytes(),
        runId: 'b1000000-0000-0000-0000-000000000010',
        goal: 'Add a tiny Build feature',
        depth: 'standard',
        now: deterministicNow(Date.UTC(2026, 5, 4, 5, 0, 0)),
        relayer: surfaceRelayer({ extensions: ['.ts'], onActPrompt: () => {} }),
        projectRoot: passingProjectRoot(),
        selectionConfigLayers: [
          projectPolicyLayer({ 'before:edit-files:.ts': { mode: 'auto', skills: ['tdd'] } }),
        ],
      });

      // Copy to a fresh folder and truncate the trace to just after the recorded
      // before:edit-files injection (so act-step has not yet completed and resumes
      // cleanly). The reports the act relay reads stay intact in the copy.
      const folderB = join(runFolderBase, 'resume-seed-process2');
      cpSync(folderA, folderB, { recursive: true });
      const tracePath = join(folderB, 'trace.ndjson');
      const lines = readFileSync(tracePath, 'utf8')
        .split(/\r?\n/)
        .filter((line) => line.length > 0);
      const cut = lines.findIndex((line) => {
        const parsed = JSON.parse(line) as { kind?: string; event?: { hook?: string } };
        return parsed.kind === 'run.skill-hook' && parsed.event?.hook === 'before:edit-files:.ts';
      });
      expect(cut).toBeGreaterThan(-1);
      writeFileSync(tracePath, `${lines.slice(0, cut + 1).join('\n')}\n`, 'utf8');

      // Resume at act-step via the resume-capable graph entry (runCompiledFlow is
      // the fresh-run baseline and rejects a non-empty dir; resume re-enters the
      // executable directly, the same path the checkpoint-resume API uses).
      const actPrompts: string[] = [];
      const executable = fromCompiledFlow(parseCompiledFlowBytes(fixtureBytes()));
      const outcome = await executeExecutableFlowOutcome(executable, {
        runDir: folderB,
        runId: 'b1000000-0000-0000-0000-000000000010',
        goal: 'Add a tiny Build feature',
        depth: 'standard',
        now: deterministicNow(Date.UTC(2026, 5, 4, 5, 5, 0)),
        relayer: surfaceRelayer({ extensions: ['.ts'], onActPrompt: (p) => actPrompts.push(p) }),
        projectRoot: passingProjectRoot(),
        selectionConfigLayers: [
          projectPolicyLayer({ 'before:edit-files:.ts': { mode: 'auto', skills: ['tdd'] } }),
        ],
        resumeCheckpoint: { stepId: 'act-step', attempt: 1, selection: 'continue' },
      });

      expect(outcome.kind).not.toBe('rejected');
      expect(actPrompts.length).toBeGreaterThan(0);
      expect(actPrompts.some((prompt) => prompt.includes(TDD_BODY))).toBe(true);
    },
    TIMEOUT_MS,
  );
});
