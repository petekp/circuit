import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deterministicNow } from '../helpers/runtime-fixtures.js';

import type { ClaudeCodeRelayInput } from '../../src/connectors/claude-code.js';
import { runCompiledFlow } from '../../src/runtime/run/compiled-flow-runner.js';
import { TraceStore } from '../../src/runtime/trace/trace-store.js';
import { Config } from '../../src/schemas/config.js';
import type { LayeredConfig } from '../../src/schemas/config.js';
import type { TraceEntry } from '../../src/schemas/trace-entry.js';
import type { RelayResult } from '../../src/shared/connector-relay.js';
import type { RelayFn } from '../../src/shared/relay-runtime-types.js';
import {
  dispatchEditFileHooksForEntries,
  dispatchSkillHooksForEntries,
} from '../../src/skill-hooks/dispatch.js';

const FIXTURE_PATH = resolve('generated/flows/build/circuit.json');
const TIMEOUT_MS = 15_000;

let runFolderBase: string;
beforeEach(() => {
  runFolderBase = mkdtempSync(join(tmpdir(), 'circuit-skill-hook-'));
});
afterEach(() => {
  rmSync(runFolderBase, { recursive: true, force: true });
});

function fixtureBytes(): Buffer {
  return readFileSync(FIXTURE_PATH);
}

function relayer(onActPrompt?: (prompt: string) => void): RelayFn {
  const context = JSON.stringify({
    verdict: 'accept',
    sources: [{ kind: 'file', ref: 'src/example.ts', summary: 'Module the change touches' }],
    observations: ['Small self-contained module'],
    open_questions: [],
  });
  const implementation = JSON.stringify({
    verdict: 'accept',
    summary: 'Implemented the requested change',
    changed_files: ['src/example.ts'],
    evidence: ['stub'],
  });
  const review = JSON.stringify({ verdict: 'accept', summary: 'ok', findings: [] });
  return {
    connectorName: 'claude-code',
    relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
      const isAnalyze = input.prompt.includes('Step: analyze-step');
      const isAct = input.prompt.includes('Step: act-step');
      if (isAct) onActPrompt?.(input.prompt);
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

// A Build relayer whose analyze (context) output predicts a file surface, so
// the compiled plan carries `anticipated_file_extensions` (the before:edit-file
// detection signal). Mirrors relayer() but threads the predicted extensions
// through the context and its single slice.
function surfaceRelayer(opts: {
  readonly extensions: readonly string[];
  readonly onActPrompt?: (prompt: string) => void;
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
  const review = JSON.stringify({ verdict: 'accept', summary: 'ok', findings: [] });
  return {
    connectorName: 'claude-code',
    relay: async (input: ClaudeCodeRelayInput): Promise<RelayResult> => {
      const isAnalyze = input.prompt.includes('Step: analyze-step');
      const isAct = input.prompt.includes('Step: act-step');
      if (isAct) opts.onActPrompt?.(input.prompt);
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

// A verification project whose check always fails, so the run emits a failing
// verification check (the after:verification-failed detection signal).
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

async function readTrace(runFolder: string) {
  return await new TraceStore(runFolder).load();
}

function skillHookEntries(entries: Awaited<ReturnType<typeof readTrace>>) {
  return entries.filter(
    (entry): entry is Extract<(typeof entries)[number], { kind: 'run.skill-hook' }> =>
      entry.kind === 'run.skill-hook',
  );
}

describe('Skill-hook report-only dispatch', () => {
  it(
    'records a skill-hook event when a configured hook fires, with the resolved policy',
    async () => {
      const runFolder = join(runFolderBase, 'configured');
      await runCompiledFlow({
        runDir: runFolder,
        flowBytes: fixtureBytes(),
        runId: 'a1000000-0000-0000-0000-000000000001',
        goal: 'Add a tiny Build feature',
        depth: 'standard',
        now: deterministicNow(Date.UTC(2026, 5, 4, 1, 0, 0)),
        relayer: relayer(),
        projectRoot: failingProjectRoot(),
        selectionConfigLayers: [
          projectPolicyLayer({ 'after:verification-failed': { mode: 'mute', strict: false } }),
        ],
      });

      const entries = await readTrace(runFolder);
      const hooks = skillHookEntries(entries);
      expect(hooks.length).toBeGreaterThan(0);
      for (const entry of hooks) {
        expect(entry.event.hook).toBe('after:verification-failed');
        expect(entry.event.policy.mode).toBe('mute');
        expect(entry.event.policy.source).toBe('project-policy');
        expect(entry.event.triggered_skills).toEqual([]);
        expect(entry.event.step_id).toBe('verify-step');
      }
      // after:evidence-gap is not configured, so it must not be recorded even
      // though a failing verify also produces a proof.assessed gap.
      expect(hooks.some((entry) => entry.event.hook === 'after:evidence-gap')).toBe(false);
    },
    TIMEOUT_MS,
  );

  it(
    'records no skill-hook events on a run with no skill_hooks config',
    async () => {
      const runFolder = join(runFolderBase, 'unconfigured');
      await runCompiledFlow({
        runDir: runFolder,
        flowBytes: fixtureBytes(),
        runId: 'a1000000-0000-0000-0000-000000000002',
        goal: 'Add a tiny Build feature',
        depth: 'standard',
        now: deterministicNow(Date.UTC(2026, 5, 4, 1, 5, 0)),
        relayer: relayer(),
        projectRoot: failingProjectRoot(),
        // no selectionConfigLayers
      });

      const entries = await readTrace(runFolder);
      expect(skillHookEntries(entries)).toHaveLength(0);
    },
    TIMEOUT_MS,
  );

  it(
    'is report-only: an auto policy records the would-trigger skill but injects nothing into the relay',
    async () => {
      const runFolder = join(runFolderBase, 'report-only');
      const actPrompts: string[] = [];
      await runCompiledFlow({
        runDir: runFolder,
        flowBytes: fixtureBytes(),
        runId: 'a1000000-0000-0000-0000-000000000003',
        goal: 'Add a tiny Build feature',
        depth: 'standard',
        now: deterministicNow(Date.UTC(2026, 5, 4, 1, 10, 0)),
        relayer: relayer((prompt) => actPrompts.push(prompt)),
        projectRoot: failingProjectRoot(),
        selectionConfigLayers: [
          projectPolicyLayer({
            'after:verification-failed': {
              mode: 'auto',
              skills: ['react-doctor'],
              strict: false,
            },
          }),
        ],
      });

      const entries = await readTrace(runFolder);
      const hooks = skillHookEntries(entries);
      expect(hooks.length).toBeGreaterThan(0);
      // The configured skill is recorded as what WOULD be triggered (it lands in
      // triggered or unavailable depending on the local registry) ...
      const named = hooks.flatMap((entry) => [
        ...entry.event.triggered_skills.map((skill) => skill.id as string),
        ...(entry.event.unavailable_skills ?? []).map((skill) => skill.id as string),
      ]);
      expect(named).toContain('react-doctor');
      // ... but report-only must not inject it into any relay prompt.
      expect(actPrompts.length).toBeGreaterThan(0);
      for (const prompt of actPrompts) {
        expect(prompt).not.toContain('react-doctor');
      }
    },
    TIMEOUT_MS,
  );

  it(
    'does not over-fire after:evidence-gap on a failing verify (hard failure) or a relay acceptance proof',
    async () => {
      const runFolder = join(runFolderBase, 'no-overfire');
      await runCompiledFlow({
        runDir: runFolder,
        flowBytes: fixtureBytes(),
        runId: 'a1000000-0000-0000-0000-000000000004',
        goal: 'Add a tiny Build feature',
        depth: 'standard',
        now: deterministicNow(Date.UTC(2026, 5, 4, 1, 15, 0)),
        relayer: relayer(),
        projectRoot: failingProjectRoot(),
        selectionConfigLayers: [
          projectPolicyLayer({
            'after:verification-failed': { mode: 'mute', strict: false },
            'after:evidence-gap': { mode: 'mute', strict: false },
          }),
        ],
      });

      const entries = await readTrace(runFolder);
      const hooks = skillHookEntries(entries);
      // The failing verify fires after:verification-failed ...
      expect(hooks.some((entry) => entry.event.hook === 'after:verification-failed')).toBe(true);
      // ... but after:evidence-gap must NOT fire: the act relay's acceptance proof
      // is excluded (proof.acceptance:*), and the failing verify's proof is a hard
      // failure (contradicted), already covered by after:verification-failed.
      expect(hooks.some((entry) => entry.event.hook === 'after:evidence-gap')).toBe(false);
    },
    TIMEOUT_MS,
  );
});

describe('Skill-hook edit-file dispatch (Build, end-to-end)', () => {
  it(
    'records before:edit-file:.ts when the plan predicts the surface, and injects nothing',
    async () => {
      const runFolder = join(runFolderBase, 'build-before');
      const actPrompts: string[] = [];
      await runCompiledFlow({
        runDir: runFolder,
        flowBytes: fixtureBytes(),
        runId: 'a1000000-0000-0000-0000-000000000010',
        goal: 'Add a tiny Build feature',
        depth: 'standard',
        now: deterministicNow(Date.UTC(2026, 5, 4, 2, 0, 0)),
        relayer: surfaceRelayer({ extensions: ['.ts'], onActPrompt: (p) => actPrompts.push(p) }),
        projectRoot: failingProjectRoot(),
        selectionConfigLayers: [
          projectPolicyLayer({
            'before:edit-file:.ts': { mode: 'auto', skills: ['tdd'] },
            'before:edit-file:.py': { mode: 'auto', skills: ['python-doctor'] },
          }),
        ],
      });

      const hooks = skillHookEntries(await readTrace(runFolder));
      const hookNames = hooks.map((entry) => entry.event.hook);
      // The plan predicted .ts, so the .ts rule fires on the plan step ...
      expect(hookNames).toContain('before:edit-file:.ts');
      const before = hooks.find((entry) => entry.event.hook === 'before:edit-file:.ts');
      expect(before?.event.step_id).toBe('plan-step');
      expect(before?.event.policy).toMatchObject({ mode: 'auto', source: 'project-policy' });
      // ... but the unpredicted .py rule does not.
      expect(hookNames).not.toContain('before:edit-file:.py');
      // Report-only: the predicted skill is never injected into the act relay.
      expect(actPrompts.length).toBeGreaterThan(0);
      for (const prompt of actPrompts) {
        expect(prompt).not.toContain('tdd');
      }
    },
    TIMEOUT_MS,
  );
});

// A minimal synthetic trace entry exposing only the fields the dispatcher reads.
function entry(fields: Record<string, unknown>): TraceEntry {
  return {
    schema_version: 1,
    run_id: 'r',
    recorded_at: '2026-06-04T00:00:00.000Z',
    ...fields,
  } as unknown as TraceEntry;
}

describe('Skill-hook detection (unit)', () => {
  const configLayers = [
    projectPolicyLayer({
      'after:verification-failed': { mode: 'mute', strict: false },
      'after:evidence-gap': { mode: 'mute', strict: false },
    }),
  ];

  function hooksFor(e: TraceEntry): string[] {
    return dispatchSkillHooksForEntries({
      entries: [e],
      configLayers,
      scope: { flowId: 'build', stepId: 's', attemptId: '1' },
      eventIdBase: 'e',
    }).map((event) => event.hook);
  }

  it('fires after:verification-failed only on a failed verification (schema_sections) check', () => {
    expect(
      hooksFor(
        entry({
          kind: 'check.evaluated',
          check_kind: 'schema_sections',
          outcome: 'fail',
          sequence: 1,
        }),
      ),
    ).toEqual(['after:verification-failed']);
    // A failed relay verdict / acceptance check is NOT a verification failure.
    expect(
      hooksFor(
        entry({
          kind: 'check.evaluated',
          check_kind: 'result_verdict',
          outcome: 'fail',
          sequence: 2,
        }),
      ),
    ).toEqual([]);
    expect(
      hooksFor(
        entry({
          kind: 'check.evaluated',
          check_kind: 'acceptance_criteria',
          outcome: 'fail',
          sequence: 3,
        }),
      ),
    ).toEqual([]);
    // A passing verification check does not fire.
    expect(
      hooksFor(
        entry({
          kind: 'check.evaluated',
          check_kind: 'schema_sections',
          outcome: 'pass',
          sequence: 4,
        }),
      ),
    ).toEqual([]);
  });

  it('fires after:evidence-gap only on an unproved VERIFICATION proof, never on relay or hard-fail proofs', () => {
    // A verification proof that ran but left the claim unproved: the genuine gap.
    expect(
      hooksFor(
        entry({
          kind: 'proof.assessed',
          assessment_id: 'proof.verification:verify-step:1',
          overall_status: 'unproved',
          sequence: 1,
        }),
      ),
    ).toEqual(['after:evidence-gap']);
    // A relay's ordinary non-proven acceptance proof must NOT fire (the bug the
    // review caught: every successful implementer relay emits one of these).
    expect(
      hooksFor(
        entry({
          kind: 'proof.assessed',
          assessment_id: 'proof.acceptance:act-step:1',
          overall_status: 'weak',
          sequence: 2,
        }),
      ),
    ).toEqual([]);
    // A hard verification failure is covered by after:verification-failed; do not
    // double-fire it here.
    expect(
      hooksFor(
        entry({
          kind: 'proof.assessed',
          assessment_id: 'proof.verification:verify-step:1',
          overall_status: 'contradicted',
          sequence: 3,
        }),
      ),
    ).toEqual([]);
    // A proven verification proof is no gap.
    expect(
      hooksFor(
        entry({
          kind: 'proof.assessed',
          assessment_id: 'proof.verification:verify-step:1',
          overall_status: 'proven',
          sequence: 4,
        }),
      ),
    ).toEqual([]);
  });
});

describe('Skill-hook edit-file detection (unit, Fix change-set)', () => {
  // A synthetic step.report_written pointing at a fix.change-set@v1 report.
  function reportWritten(schema: string): TraceEntry {
    return entry({
      kind: 'step.report_written',
      step_id: 'fix-change-set',
      report_path: 'reports/fix/change-set.json',
      report_schema: schema,
      sequence: 1,
    });
  }

  // The real FixChangeSet `observed` field carries the actual touched paths.
  async function editHooksFor(
    schema: string,
    reportBody: unknown,
    policy: Record<string, unknown>,
  ): Promise<string[]> {
    const events = await dispatchEditFileHooksForEntries({
      entries: [reportWritten(schema)],
      configLayers: [projectPolicyLayer(policy)],
      scope: { flowId: 'fix', stepId: 'fix-change-set', attemptId: '1' },
      eventIdBase: 'e',
      readJson: async () => reportBody,
    });
    return events.map((event) => event.hook).sort();
  }

  it('fires after:edit-file:.ts when an observed path matches the extension suffix', async () => {
    expect(
      await editHooksFor(
        'fix.change-set@v1',
        { observed: ['src/foo.ts', 'src/bar.tsx'] },
        { 'after:edit-file:.ts': { mode: 'auto', skills: ['tdd'] } },
      ),
    ).toEqual(['after:edit-file:.ts']);
  });

  it('matches multi-dot extensions and the bare any-edit anchor; skips non-matching suffixes', async () => {
    expect(
      await editHooksFor(
        'fix.change-set@v1',
        { observed: ['src/bar.tsx', 'src/foo.test.ts'] },
        {
          'after:edit-file:.tsx': { mode: 'auto', skills: ['react-doctor'] },
          'after:edit-file:.test.ts': { mode: 'auto', skills: ['tdd'] },
          'after:edit-file:.py': { mode: 'auto', skills: ['python-doctor'] },
          'after:edit-file': { mode: 'auto', skills: ['any-edit'] },
        },
      ),
    ).toEqual(['after:edit-file', 'after:edit-file:.tsx', 'after:edit-file:.test.ts'].sort());
  });

  it('records the resolved policy and the parameterized hook name on the event', async () => {
    const events = await dispatchEditFileHooksForEntries({
      entries: [reportWritten('fix.change-set@v1')],
      configLayers: [
        projectPolicyLayer({ 'after:edit-file:.tsx': { mode: 'mute', strict: false } }),
      ],
      scope: { flowId: 'fix', stepId: 'fix-change-set', attemptId: '1' },
      eventIdBase: 'e',
      readJson: async () => ({ observed: ['src/bar.tsx'] }),
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.hook).toBe('after:edit-file:.tsx');
    expect(events[0]?.policy).toMatchObject({ mode: 'mute', source: 'project-policy' });
    expect(events[0]?.triggered_skills).toEqual([]);
  });

  it('does not fire a before:edit-file key on an after-timed (change-set) report', async () => {
    expect(
      await editHooksFor(
        'fix.change-set@v1',
        { observed: ['src/bar.tsx'] },
        { 'before:edit-file:.tsx': { mode: 'auto', skills: ['react-doctor'] } },
      ),
    ).toEqual([]);
  });

  it('records nothing without a configured edit-file policy, or for an unknown report schema', async () => {
    expect(
      await editHooksFor(
        'fix.change-set@v1',
        { observed: ['src/bar.tsx'] },
        { 'after:verification-failed': { mode: 'mute', strict: false } },
      ),
    ).toEqual([]);
    expect(
      await editHooksFor(
        'something.unmapped@v1',
        { observed: ['src/bar.tsx'] },
        { 'after:edit-file:.tsx': { mode: 'auto', skills: ['react-doctor'] } },
      ),
    ).toEqual([]);
  });
});
