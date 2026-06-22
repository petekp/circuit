// PROPOSE REAL TASKS — drive the shipped proposeFlow() callable on real tasks.
// ===================================================================
// Tracked, default-OFF, experiments-only. Never imported by src/, never a
// vitest test, never run in CI. A THIN driver over the real src callable
// `proposeFlow` (src/flows/composition/propose.ts) — the engine-first proof
// that the PROPOSE half of the north star produces runnable flows on real
// tasks, before any product command exists.
//
//   npx tsx experiments/flow-lab/propose-real-tasks.ts                  # $0 stub self-check
//   npx tsx experiments/flow-lab/propose-real-tasks.ts --live          # real pinned-haiku run
//   npx tsx experiments/flow-lab/propose-real-tasks.ts --live --publish # + write circuit.json to a temp home
//   npx tsx experiments/flow-lab/propose-real-tasks.ts --live --task="..."  # one custom task
//   ... --max-repair=N   (default 2)   ... --timeout-ms=N   (default 90000)
//
// WHAT IT PROVES
// --------------
// proposeFlow is a real, callable unit: task in, a runnable composed flow out
// (or an honest parse/relay/wall failure). The $0 mode proves the driver wiring
// end-to-end with a stub relay (propose -> floor -> optional publish). The
// --live mode does the same against a real pinned-haiku relay, so we can USE the
// generator and learn from the result.
//
// SELECTION. Pinned to claude-haiku-4-5 / effort low, matching the proposer
// spike, for cheap reproducibility. A product caller would instead resolve the
// session power dial (materializePowerSelection, role 'researcher') and pass that
// ResolvedSelection; proposeFlow is selection-agnostic, so swapping the pin for a
// resolved selection is a one-line change here, not a change to the callable.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { publishComposedFlowWith } from '../../evals/dynamic-vs-reference/composed-fix-shapes.js';
import { relayClaudeCode } from '../../src/connectors/claude-code.js';
import { assembleFlowSchematic } from '../../src/flows/assemble-flow-schematic.js';
import { flowDefinitions } from '../../src/flows/catalog.js';
import { compileSchematicToCompiledFlow } from '../../src/flows/compile-schematic-to-flow.js';
import { planCompiledFlowFiles } from '../../src/flows/compiled-flow-file-plan.js';
import {
  BUILD_LINEAR_FULL,
  type CompositionRoleSet,
  composeFlow,
  evaluateRunnability,
  evaluateValidity,
  proposeFlow,
} from '../../src/flows/composition/index.js';
import type { ResolvedSelection } from '../../src/schemas/selection-policy.js';
import type { RelayResult } from '../../src/shared/connector-relay.js';
import type { RelayFn, RelayInput } from '../../src/shared/relay-runtime-types.js';

// --- pinned proposer model (matches the spike) -----------------------------
const PINNED_SELECTION: ResolvedSelection = {
  model: { provider: 'anthropic', model: 'claude-haiku-4-5' },
  effort: 'low',
  skills: [],
  invocation_options: {},
};

// --- the real tasks (a representative few across the runnable shapes) -------
interface RealTask {
  readonly id: string;
  readonly description: string;
}
const REAL_TASKS: readonly RealTask[] = [
  {
    id: 'fix-offbyone',
    description:
      'A date helper returns the wrong month for the last day of a 31-day month (off-by-one). Find the bug and fix it so the existing unit tests pass.',
  },
  {
    id: 'fix-flaky-upload',
    description:
      'An integration test for the upload endpoint fails intermittently — about one run in four. Make it reliably pass; the fix may take a couple of attempts and a re-run to confirm.',
  },
  {
    id: 'audit-auth',
    description:
      'Security review of the authentication module before release. Do not change any code — read it, find the weaknesses, and write up the findings.',
  },
  {
    id: 'build-csv-export',
    description:
      'Build a CSV export feature for the reports page: a new endpoint, the serializer, and the download button, with tests. A full build from frame to review.',
  },
];

// --- production relay: wrap the real connector as a RelayFn -----------------
const productionRelay: RelayFn = {
  connectorName: 'claude-code',
  relay: (input: RelayInput): Promise<RelayResult> => relayClaudeCode(input),
};

// --- $0 self-check relay: replay one grounded, known-runnable role set ------
// Proves the driver pipeline (propose -> floor -> optional publish) without
// spending. The triage shape (frame -> gather-context -> diagnose -> close) is
// runnable through the real floor; serving it for every task exercises the
// raw-runnable path end to end.
const STUB_RUNNABLE: CompositionRoleSet = {
  id: 'stub-triage',
  title: 'Stub Triage',
  purpose: 'A known-runnable role set for the $0 driver self-check.',
  roles: [
    { stage: 'frame', block: 'frame', executionKind: 'compose' },
    { stage: 'analyze', block: 'gather-context', executionKind: 'relay', relayRole: 'researcher' },
    { stage: 'analyze', block: 'diagnose', executionKind: 'relay', relayRole: 'researcher' },
    { stage: 'close', block: 'close-with-evidence', executionKind: 'compose', terminal: true },
  ],
};
const stubRelay: RelayFn = {
  connectorName: 'stub',
  relay: async (input: RelayInput): Promise<RelayResult> => ({
    request_payload: input.prompt,
    receipt_id: 'stub',
    result_body: JSON.stringify(STUB_RUNNABLE),
    duration_ms: 1,
    cli_version: '0.0.0-stub',
  }),
};

function shapeOf(roleSet: CompositionRoleSet): string {
  const roles = roleSet.roles ?? [];
  if (roles.some((r) => r.executionKind === 'fanout')) return 'fanout';
  if (roles.some((r) => r.executionKind === 'sub-run')) return 'sub-run';
  if (roles.some((r) => r.loopBackTo !== undefined)) return 'loop';
  const hasAct = roles.some((r) => r.stage === 'act');
  if (roles.some((r) => r.block === 'review-intake') && !hasAct) return 'review-only';
  if (!hasAct) return 'no-act';
  return 'linear';
}

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

async function main(): Promise<void> {
  const live = process.argv.includes('--live');
  const publish = process.argv.includes('--publish');
  const maxRepair = Number(arg('max-repair') ?? '2');
  const timeoutMs = Number(arg('timeout-ms') ?? '90000');
  const customTask = arg('task');

  const tasks: readonly RealTask[] = customTask
    ? [{ id: 'custom', description: customTask }]
    : REAL_TASKS;

  const relay = live ? productionRelay : stubRelay;
  const resolvedSelection = live ? PINNED_SELECTION : undefined;

  const home = publish ? mkdtempSync(join(tmpdir(), 'propose-real-')) : undefined;
  const deps = {
    composeFlow,
    evaluateValidity,
    evaluateRunnability,
    assembleFlowSchematic,
    compileSchematicToCompiledFlow,
    planCompiledFlowFiles,
    flowDefinitions,
    BUILD_LINEAR_FULL,
  };

  process.stderr.write(
    `\n=== PROPOSE REAL TASKS — ${live ? 'LIVE (pinned claude-haiku-4-5)' : '$0 stub self-check'} ===\n` +
      `tasks=${tasks.length} maxRepair=${maxRepair} timeoutMs=${timeoutMs}` +
      `${publish ? ` publish=on home=${home}` : ''}\n`,
  );

  // Build options without a `resolvedSelection: undefined` key (rejected under
  // exactOptionalPropertyTypes); absent means the relay uses its own default.
  const baseOptions = { relay, maxRepair, timeoutMs };

  let ok = 0;
  for (const task of tasks) {
    const outcome = await proposeFlow(
      resolvedSelection === undefined
        ? { ...baseOptions, task: task.description }
        : { ...baseOptions, task: task.description, resolvedSelection },
    );

    if (outcome.ok) {
      ok += 1;
      const where = outcome.convergedRound === 0 ? 'raw' : `repair round ${outcome.convergedRound}`;
      let publishNote = '';
      if (publish && home !== undefined) {
        const published = publishComposedFlowWith(deps, {
          roleSet: outcome.roleSet,
          home,
          description: task.description,
          createdAt: new Date().toISOString(),
        });
        publishNote = ` published=${published.slug}`;
      }
      process.stderr.write(
        `[${task.id}] OK shape=${shapeOf(outcome.roleSet)} runnable@${where} (${outcome.rounds.length} round(s))${publishNote}\n`,
      );
    } else {
      process.stderr.write(
        `[${task.id}] FAIL reason=${outcome.reason} after ${outcome.rounds.length} round(s)\n` +
          `   last errors: ${outcome.errors.slice(0, 3).join(' | ')}\n`,
      );
    }
  }

  process.stderr.write(`\n=== SUMMARY === runnable ${ok}/${tasks.length}\n`);
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
