import { describe, expect, it } from 'vitest';

import { contractQualityReview } from '../../src/app/run-envelope/contract-quality.js';
import { deriveRequiredEvidence } from '../../src/app/run-envelope/source-record.js';
import { PrototypeBrief } from '../../src/flows/prototype/reports.js';
import { findComposeBuilder } from '../../src/flows/registries/compose-writers/registry.js';
import type { ComposeBuildContext } from '../../src/flows/registries/compose-writers/types.js';
import type { RunGoalContract } from '../../src/schemas/run-envelope.js';
import { harvestGoalCommandCandidates } from '../../src/shared/goal-commands.js';

// Verbatim operator goal from pdk-poc run 311b62bf-595e-4cd6-b59c-017a7f4bff2a
// (Prototype + --autonomous). The goal names three runnable evidence commands;
// the framer must harvest all three.
const SPIKE_GOAL_REQUIRED_EVIDENCE =
  'Throwaway spike for the Home Leads Pipeline migration. FIRST read .claude/migration/leads-pipeline/PLAN.md — it is the contract; verbatim arc reference sources are in .claude/migration/leads-pipeline/arc-src/. Build a disposable vertical slice that answers spike questions S1-S5 from PLAN.md section 5: adapt the seeded Dexie runtime data (opportunities + comms events + lead-linked tasks) into a minimally-ported buildHomeLeadsPipelineIndex under src/features/home/leads-pipeline-spike/, render the four-bucket ring scorecard on the Home screen in place of the leads funnel module, and wire at least one drill-down link that narrows the leads list via leadBucket/leadResult params. No polish, no mobile chrome. REQUIRED COMMAND EVIDENCE for completion: (1) pnpm typecheck exits 0 with the spike code in place; (2) pnpm vitest run src/features/home/leads-pipeline-spike exits 0 — write at least one spike unit test that feeds prod-shaped fixture records (opportunity + comms events + lead-linked tasks) through the adapter into the index builder and asserts non-trivial bucket counts; (3) test -f .claude/migration/leads-pipeline/SPIKE_LEARNINGS.md exits 0. SPIKE_LEARNINGS.md must answer S1-S5, each with an explicit verdict (works / needs X / blocked by Y), file:line anchors into both spike and existing prod code, and concrete recommendations for the final Build: adapter shapes, bucket mapping for stale/lost/bad leads, ring vs ProgressRing and token choices, memo strategy, and any seed-data gaps. Spike code stays uncommitted and disposable; SPIKE_LEARNINGS.md is the only keeper.';

// Verbatim goal from run f7fe10d0-6614-4a61-a3fe-fb4d4d695f25 — same commands
// under a "Verification commands:" heading instead of "REQUIRED COMMAND
// EVIDENCE for completion:".
const SPIKE_GOAL_VERIFICATION_COMMANDS = SPIKE_GOAL_REQUIRED_EVIDENCE.replace(
  'REQUIRED COMMAND EVIDENCE for completion:',
  'Verification commands:',
);

describe('harvestGoalCommandCandidates', () => {
  it('harvests all three enumerated "exits 0" commands from the pdk-poc spike goal', () => {
    const commands = harvestGoalCommandCandidates(SPIKE_GOAL_REQUIRED_EVIDENCE);
    const argvs = commands.map((command) => command.argv.join(' '));
    expect(argvs).toContain('pnpm typecheck');
    expect(argvs).toContain('pnpm vitest run src/features/home/leads-pipeline-spike');
    expect(argvs).toContain('test -f .claude/migration/leads-pipeline/SPIKE_LEARNINGS.md');
  });

  it('harvests the same commands under the "Verification commands:" phrasing', () => {
    const commands = harvestGoalCommandCandidates(SPIKE_GOAL_VERIFICATION_COMMANDS);
    expect(commands).toHaveLength(3);
  });

  it('harvests backticked commands with a success claim', () => {
    const commands = harvestGoalCommandCandidates(
      'Ship the widget. Done when `npm run typecheck` passes and `npm test` exits 0.',
    );
    const argvs = commands.map((command) => command.argv.join(' '));
    expect(argvs).toContain('npm run typecheck');
    expect(argvs).toContain('npm test');
  });

  it('does not harvest prose that happens to mention exiting zero', () => {
    expect(
      harvestGoalCommandCandidates('Make sure the app still exits 0 when the user quits.'),
    ).toEqual([]);
    expect(harvestGoalCommandCandidates('The final acceptance test exits 0.')).toEqual([]);
  });

  it('rejects shell-syntax candidates rather than mangling them', () => {
    expect(harvestGoalCommandCandidates('Done when `npm test && npm run lint` exits 0.')).toEqual(
      [],
    );
  });

  it('returns nothing for a goal with no command evidence stated', () => {
    expect(
      harvestGoalCommandCandidates(
        'Build a disposable vertical slice and write the learnings doc; nothing committed.',
      ),
    ).toEqual([]);
  });

  it('dedupes a command stated both inline and in backticks', () => {
    const commands = harvestGoalCommandCandidates(
      'Run `pnpm typecheck` until it passes; pnpm typecheck exits 0 is the bar.',
    );
    expect(commands).toHaveLength(1);
  });
});

function contractFor(processId: string, objective: string): RunGoalContract {
  return {
    schema: 'run.goal-contract@v0',
    objective,
    scope: { in: [objective], out: [], assumptions: [] },
    constraints: [],
    done_when: [
      {
        id: 'process-evidence',
        claim: `The ${processId} work is complete with the required proof for: ${objective}`,
        required_evidence: deriveRequiredEvidence(processId, objective),
      },
    ],
    recovery_policy: {
      max_process_attempts: 2,
      allowed_routes: ['retry-process', 'run-review', 'checkpoint', 'handoff', 'blocked'],
    },
    stop_conditions: ['Stop instead of closing complete when required evidence is missing.'],
    completion_gate: {
      required_passes: 2,
      blocking_severities: ['critical', 'high', 'medium'],
      reset_on_blocking_finding: true,
    },
  } as RunGoalContract;
}

describe('run-envelope framer honors goal-supplied command evidence (pdk-poc bug 1)', () => {
  it('derives required command entries from goal-stated commands for a Prototype run', () => {
    const derived = deriveRequiredEvidence('prototype', SPIKE_GOAL_REQUIRED_EVIDENCE);
    const commandEntries = derived.filter((entry) => entry.kind === 'command' && entry.required);
    expect(commandEntries.length).toBeGreaterThanOrEqual(3);
    expect(commandEntries.some((entry) => entry.description.includes('pnpm typecheck'))).toBe(true);
  });

  it('contract-quality gate passes the framed contract, so the autonomous loop can start', () => {
    const review = contractQualityReview(contractFor('prototype', SPIKE_GOAL_REQUIRED_EVIDENCE));
    expect(review.verdict).toBe('gate-pass');
  });

  it('still blocks when the goal supplies no commands, with an actionable finding', () => {
    const goal = 'Build a disposable vertical slice; nothing committed.';
    const review = contractQualityReview(contractFor('prototype', goal));
    expect(review.verdict).toBe('blocked');
    const finding = review.findings[0]?.text ?? '';
    // The finding must say what the contract HAS and why it was rejected...
    expect(finding).toContain("kind 'report'");
    // ...and tell the operator how to make the objective provable.
    expect(finding.toLowerCase()).toContain('exits 0');
    expect(finding).toContain('--autonomous');
  });
});

describe('prototype brief writer harvests goal-supplied verification commands (pdk-poc bug 1)', () => {
  function buildBrief(goal: string): PrototypeBrief {
    const builder = findComposeBuilder('prototype.brief@v1');
    if (builder === undefined) throw new Error('prototype.brief@v1 compose builder not found');
    const context = {
      runFolder: '/tmp/project/.circuit/runs/test-run',
      projectRoot: '/tmp/project',
      goal,
      inputs: {},
    } as unknown as ComposeBuildContext;
    return PrototypeBrief.parse(builder.build(context));
  }

  it('populates verification_command_candidates from the goal text', () => {
    const brief = buildBrief(SPIKE_GOAL_VERIFICATION_COMMANDS);
    const argvs = brief.verification_command_candidates.map((command) => command.argv.join(' '));
    expect(argvs).toContain('pnpm typecheck');
    expect(argvs).toContain('pnpm vitest run src/features/home/leads-pipeline-spike');
    expect(argvs).toContain('test -f .claude/migration/leads-pipeline/SPIKE_LEARNINGS.md');
  });

  it('leaves candidates empty when the goal states no commands', () => {
    const brief = buildBrief('Sketch a quick HTML mock of the pricing table.');
    expect(brief.verification_command_candidates).toEqual([]);
  });
});
