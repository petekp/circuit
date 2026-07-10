import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

import { BuildResult } from '../../src/flows/build/reports.js';
import {
  ExploreDecision,
  ExploreDecisionOptions,
  ExploreResult,
  ExploreTournamentAggregate,
  ExploreTournamentReview,
} from '../../src/flows/explore/reports.js';
import { FixResult } from '../../src/flows/fix/reports.js';
import { PursuitResult } from '../../src/flows/pursue/reports.js';
import { ReviewResult } from '../../src/flows/review/reports.js';
import {
  FLOW_CATALOG_CLAIM_ID,
  compareParity,
  releaseBlockers,
  validateProofCoverage,
  validatePublicClaims,
} from '../../src/release/checks.js';
import {
  CurrentCapabilitySnapshot,
  OriginalCapabilitySnapshot,
  ParityExceptionLedger,
  ProofScenarioIndex,
  PublicClaimLedger,
} from '../../src/release/schemas.js';
import { CompiledFlow } from '../../src/schemas/compiled-flow.js';
import { ContinuityIndex, ContinuityRecord } from '../../src/schemas/continuity.js';
import { ProgressEvent } from '../../src/schemas/progress-event.js';
import { RunResult } from '../../src/schemas/result.js';

const root = resolve(__dirname, '..', '..');
const proofRunsRoot = 'docs/release/proofs/runs';
const legacyProofRunsRoot = 'examples/runs';

function yamlFile(path: string): unknown {
  return YAML.parse(readFileSync(resolve(root, path), 'utf8'));
}

function jsonFile(path: string): unknown {
  return JSON.parse(readFileSync(resolve(root, path), 'utf8')) as unknown;
}

function exists(path: string): boolean {
  return existsSync(resolve(root, path));
}

function filesUnder(path: string): string[] {
  const abs = resolve(root, path);
  return readdirSync(abs).flatMap((entry) => {
    const child = join(abs, entry);
    const stat = statSync(child);
    if (stat.isDirectory()) return filesUnder(join(path, entry));
    return [child];
  });
}

describe('release truth infrastructure', () => {
  it('parses authored release ledgers', () => {
    expect(() =>
      OriginalCapabilitySnapshot.parse(yamlFile('docs/release/parity/original-circuit.yaml')),
    ).not.toThrow();
    expect(() =>
      ParityExceptionLedger.parse(yamlFile('docs/release/parity/exceptions.yaml')),
    ).not.toThrow();
    expect(() =>
      PublicClaimLedger.parse(yamlFile('docs/release/claims/public-claims.yaml')),
    ).not.toThrow();
    expect(() =>
      ProofScenarioIndex.parse(yamlFile('docs/release/proofs/index.yaml')),
    ).not.toThrow();
  });

  it('validates the generated current capability snapshot', () => {
    const snapshot = CurrentCapabilitySnapshot.parse(
      jsonFile('generated/release/current-capabilities.json'),
    );
    expect(snapshot.capabilities.length).toBeGreaterThan(30);
    expect(snapshot.flows.map((flow) => flow.id).sort()).toContain('build');
    expect(snapshot.flows.map((flow) => flow.id)).not.toContain('runtime-proof');
    expect(snapshot.capabilities.map((capability) => capability.id)).not.toContain(
      'flow:runtime-proof',
    );
    expect(snapshot.connectors.map((connector) => connector.id).sort()).toContain('custom');
  });

  it('records canonical flow stages from circuit.json when mode files are present', () => {
    expect(exists('generated/flows/fix/low.json')).toBe(true);
    const snapshot = CurrentCapabilitySnapshot.parse(
      jsonFile('generated/release/current-capabilities.json'),
    );
    const fix = snapshot.flows.find((flow) => flow.id === 'fix');
    const canonical = jsonFile('generated/flows/fix/circuit.json') as {
      readonly stages?: readonly {
        readonly canonical?: string;
        readonly id: string;
        readonly title?: string;
      }[];
    };
    const expectedStages =
      canonical.stages
        ?.map((stage) =>
          stage.canonical === 'act' ? 'Fix' : (stage.title ?? stage.canonical ?? stage.id),
        )
        .filter(Boolean) ?? [];

    expect(fix?.stages).toEqual(expectedStages);
  });

  it('records flow capability axes (stage path, proof, outputs)', () => {
    const snapshot = CurrentCapabilitySnapshot.parse(
      jsonFile('generated/release/current-capabilities.json'),
    );
    const capabilities = new Map(
      snapshot.capabilities.map((capability) => [capability.id, capability]),
    );

    expect(capabilities.get('flow:explore')?.axes.stage_path).toContain('Plan or Decision');
    expect(capabilities.get('flow:explore')?.axes.proof).toBe('Golden decision or tournament run.');
    expect(capabilities.get('flow:build')?.axes.proof).toBe(
      'Routed Build golden run. Explicit Build checkpoint golden run.',
    );
    expect(capabilities.get('flow:fix')?.axes.proof).toBe(
      'Fix golden run with regression evidence.',
    );
    expect(capabilities.get('flow:explore')?.axes.outputs).toEqual([
      'analysis.md',
      'brief.md',
      'decision.md',
      'plan.md',
      'result.md',
    ]);

    const exploreRecord = snapshot.flows.find((flow) => flow.id === 'explore');
    expect(exploreRecord?.reports).toEqual(
      expect.arrayContaining([
        'explore.brief@v1',
        'explore.analysis@v1',
        'explore.decision-options@v1',
        'explore.tournament-aggregate@v1',
        'explore.tournament-proposal@v1',
        'explore.tournament-review@v1',
        'explore.decision@v1',
        'explore.result@v1',
      ]),
    );

    expect(capabilities.get('utility:review')?.axes.outputs).toEqual(['review.md']);
    expect(capabilities.get('utility:review')?.axes.review).toContain('fresh reviewer relay');
    expect(capabilities.get('utility:review')?.axes.proof).toBe('Standalone Review golden run.');
    expect(capabilities.get('feature:checkpoints')?.axes.checkpoint).toContain(
      'Compiled checkpoints',
    );
    expect(capabilities.get('feature:checkpoints')?.axes.proof).toBe(
      'Checkpoint/resume golden run.',
    );
    expect(capabilities.get('utility:create')?.status).toBe('implemented');
    expect(capabilities.get('utility:create')?.axes.outputs).toEqual([
      'SKILL.md',
      'circuit.yaml',
      'publish summary',
    ]);
    expect(capabilities.get('utility:create')?.axes.proof).toBe(
      'Create or custom-connector proof scenario.',
    );
    expect(capabilities.get('utility:handoff')?.status).toBe('implemented');
    expect(capabilities.get('utility:handoff')?.axes.outputs).toEqual([
      'active-run.md',
      'continuity record',
    ]);
    expect(capabilities.get('utility:handoff')?.axes.proof).toBe('Handoff/resume golden run.');
    expect(capabilities.get('feature:continuity')?.status).toBe('implemented');
    expect(capabilities.get('feature:continuity')?.axes.proof).toBe('Handoff/resume golden run.');
    expect(capabilities.get('proof:golden-runs')?.status).toBe('implemented');
    expect(capabilities.get('proof:golden-runs')?.summary).toContain(
      'All defined golden example runs are captured.',
    );
    expect(capabilities.get('proof:golden-runs')?.summary).not.toContain('proof:plan-execution');
  });

  it('route inventory marks rich routes executable', () => {
    const snapshot = CurrentCapabilitySnapshot.parse(
      jsonFile('generated/release/current-capabilities.json'),
    );
    const unsupported = new Set(snapshot.flows.flatMap((flow) => flow.unsupported_route_outcomes));
    for (const route of ['retry', 'revise', 'stop', 'ask', 'handoff', 'escalate']) {
      expect(unsupported.has(route), route).toBe(false);
    }
    const richRoute = snapshot.capabilities.find(
      (capability) => capability.id === 'route-outcomes:rich',
    );
    expect(richRoute?.status).toBe('implemented');
  });

  it('parity comparison passes only because gaps are tracked', () => {
    const original = OriginalCapabilitySnapshot.parse(
      yamlFile('docs/release/parity/original-circuit.yaml'),
    );
    const current = CurrentCapabilitySnapshot.parse(
      jsonFile('generated/release/current-capabilities.json'),
    );
    const exceptions = ParityExceptionLedger.parse(yamlFile('docs/release/parity/exceptions.yaml'));
    const result = compareParity({ original, current, exceptions });
    expect(result.issues).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('parity comparison rejects implemented names that lack behavioral axes', () => {
    const original = OriginalCapabilitySnapshot.parse({
      schema_version: 1,
      sources: [{ id: 'legacy', path: '/tmp/legacy.md', note: 'fixture' }],
      capabilities: [
        {
          id: 'flow:fixture',
          kind: 'flow',
          title: 'Fixture',
          summary: 'Fixture flow',
          axes: {
            modes: ['default'],
            stage_path: ['Frame', 'Close'],
            checkpoint: 'Pauses for risky decisions.',
          },
          source_refs: ['legacy'],
        },
      ],
    });
    const current = CurrentCapabilitySnapshot.parse({
      schema_version: 1,
      generated_by: 'test',
      flows: [],
      commands: { source: [], claude_plugin: [], codex_plugin: [], claude_plugin_skills: [] },
      connectors: [],
      hosts: [],
      capabilities: [
        {
          id: 'flow:fixture',
          kind: 'flow',
          title: 'Fixture',
          status: 'implemented',
          summary: 'Fixture flow exists',
          axes: {
            modes: ['default', 'low'],
            stage_path: ['frame', 'close'],
          },
        },
      ],
    });
    const exceptions = ParityExceptionLedger.parse({ schema_version: 1, exceptions: [] });
    const result = compareParity({ original, current, exceptions });
    expect(result.issues).toContainEqual(
      expect.stringContaining('untracked behavioral parity gap: flow:fixture'),
    );
    expect(result.issues).toContainEqual(expect.stringContaining('modes extra low'));
    expect(result.issues).toContainEqual(
      expect.stringContaining('checkpoint missing current value'),
    );
  });

  // The current snapshot's text axes are machine-derived from a closed,
  // declared vocabulary (see CANONICAL_TEXT_AXIS_VALUES in checks.ts). The gate
  // must accept those legitimate machine phrasings even though they read
  // differently from the hand-authored original prose.
  function fixtureSnapshots(currentCheckpoint: string) {
    const original = OriginalCapabilitySnapshot.parse({
      schema_version: 1,
      sources: [{ id: 'legacy', path: '/tmp/legacy.md', note: 'fixture' }],
      capabilities: [
        {
          id: 'flow:fixture',
          kind: 'flow',
          title: 'Fixture',
          summary: 'Fixture flow',
          // Original promise prose intentionally differs in wording from the
          // machine-derived current description.
          axes: { checkpoint: 'Legacy prose for checkpoint behavior.' },
          source_refs: ['legacy'],
        },
      ],
    });
    const current = CurrentCapabilitySnapshot.parse({
      schema_version: 1,
      generated_by: 'test',
      flows: [],
      commands: { source: [], claude_plugin: [], codex_plugin: [], claude_plugin_skills: [] },
      connectors: [],
      hosts: [],
      capabilities: [
        {
          id: 'flow:fixture',
          kind: 'flow',
          title: 'Fixture',
          status: 'implemented',
          summary: 'Fixture flow exists',
          axes: { checkpoint: currentCheckpoint },
        },
      ],
    });
    return { original, current };
  }

  it('parity comparison accepts a canonical machine-derived text axis value', () => {
    const { original, current } = fixtureSnapshots(
      'Compiled checkpoints can pause, auto-resolve safe defaults, or resume from operator input.',
    );
    const exceptions = ParityExceptionLedger.parse({ schema_version: 1, exceptions: [] });
    const result = compareParity({ original, current, exceptions });
    expect(result.issues).toEqual([]);
  });

  it('parity comparison rejects a text axis replaced with inverted or invented text', () => {
    // An inverted checkpoint description (the opposite of the truth) is not part
    // of the declared canonical vocabulary, so it must fail the gate instead of
    // silently feeding the public parity matrix.
    const { original, current } = fixtureSnapshots(
      'Never pauses; applies risky changes without asking the operator.',
    );
    const exceptions = ParityExceptionLedger.parse({ schema_version: 1, exceptions: [] });
    const result = compareParity({ original, current, exceptions });
    expect(result.issues).toContainEqual(
      expect.stringContaining('checkpoint current value is not a recognized canonical description'),
    );
    expect(result.issues).toContainEqual(
      expect.stringContaining('untracked behavioral parity gap'),
    );
  });

  it('parity comparison tracks an inverted text axis when an exception covers it', () => {
    const { original, current } = fixtureSnapshots(
      'Never pauses; applies risky changes without asking the operator.',
    );
    const exceptions = ParityExceptionLedger.parse({
      schema_version: 1,
      exceptions: [
        {
          id: 'EX-FIXTURE',
          capability_id: 'flow:fixture',
          status: 'approved_exception',
          readiness_ref: 'REL-999',
          rationale: 'Fixture exception covering the axis drift.',
        },
      ],
    });
    const result = compareParity({ original, current, exceptions });
    expect(result.issues).toEqual([]);
    expect(result.warnings).toContainEqual(
      expect.stringContaining('checkpoint current value is not a recognized canonical description'),
    );
  });

  it('claim checks reject unsupported current claims', () => {
    const current = CurrentCapabilitySnapshot.parse(
      jsonFile('generated/release/current-capabilities.json'),
    );
    const proofs = ProofScenarioIndex.parse(yamlFile('docs/release/proofs/index.yaml'));
    const exceptions = ParityExceptionLedger.parse(yamlFile('docs/release/parity/exceptions.yaml'));
    const claims = PublicClaimLedger.parse({
      schema_version: 1,
      claims: [
        {
          id: 'CLAIM-BOGUS',
          claim: 'Bogus current claim',
          type: 'flow',
          status: 'verified_current',
          surfaces: ['README.md'],
          backing: { capability_ids: ['flow:not-real'] },
          user_risk: 'Would mislead users.',
        },
      ],
    });
    const result = validatePublicClaims({
      claims,
      current,
      proofs,
      exceptions,
      pathExists: exists,
    });
    expect(result.issues).toEqual([
      'claim CLAIM-BOGUS references unsupported capability: flow:not-real',
    ]);
  });

  it('claim checks reject partially backed current claims', () => {
    const current = CurrentCapabilitySnapshot.parse(
      jsonFile('generated/release/current-capabilities.json'),
    );
    const proofs = ProofScenarioIndex.parse(yamlFile('docs/release/proofs/index.yaml'));
    const exceptions = ParityExceptionLedger.parse(yamlFile('docs/release/parity/exceptions.yaml'));
    const claims = PublicClaimLedger.parse({
      schema_version: 1,
      claims: [
        {
          id: 'CLAIM-PARTIAL',
          claim: 'Build and a missing flow are both current',
          type: 'flow',
          status: 'verified_current',
          surfaces: ['README.md'],
          backing: { capability_ids: ['flow:build', 'flow:not-real'] },
          user_risk: 'Would certify a multi-part claim with partial evidence.',
        },
      ],
    });
    const result = validatePublicClaims({
      claims,
      current,
      proofs,
      exceptions,
      pathExists: exists,
    });

    expect(result.issues).toEqual([
      'claim CLAIM-PARTIAL references unsupported capability: flow:not-real',
    ]);
  });

  it('claim checks do not accept unchecked script names as backing', () => {
    const current = CurrentCapabilitySnapshot.parse(
      jsonFile('generated/release/current-capabilities.json'),
    );
    const proofs = ProofScenarioIndex.parse(yamlFile('docs/release/proofs/index.yaml'));
    const exceptions = ParityExceptionLedger.parse(yamlFile('docs/release/parity/exceptions.yaml'));
    const claims = PublicClaimLedger.parse({
      schema_version: 1,
      claims: [
        {
          id: 'CLAIM-BOGUS-SCRIPT',
          claim: 'Bogus script-backed claim',
          type: 'docs',
          status: 'verified_current',
          surfaces: ['README.md'],
          backing: { script_checks: ['definitely-not-a-real-check --check'] },
          user_risk: 'Would let prose bypass release truth checks.',
        },
      ],
    });
    const result = validatePublicClaims({
      claims,
      current,
      proofs,
      exceptions,
      pathExists: exists,
    });
    expect(result.issues).toEqual([
      'claim CLAIM-BOGUS-SCRIPT references unavailable script check: definitely-not-a-real-check --check',
    ]);
  });

  it('verified_current claim fails when its backing script check does not pass', () => {
    const current = CurrentCapabilitySnapshot.parse(
      jsonFile('generated/release/current-capabilities.json'),
    );
    const proofs = ProofScenarioIndex.parse(yamlFile('docs/release/proofs/index.yaml'));
    const exceptions = ParityExceptionLedger.parse(yamlFile('docs/release/parity/exceptions.yaml'));
    // The backing command file exists (passes the availability guard), but when
    // actually executed it exits non-zero: verified_current must not survive a
    // failing backing script.
    const claims = PublicClaimLedger.parse({
      schema_version: 1,
      claims: [
        {
          id: 'CLAIM-STALE-SCRIPT',
          claim: 'Backed by a script that no longer passes',
          type: 'docs',
          status: 'verified_current',
          surfaces: ['README.md'],
          backing: { script_checks: ['scripts/release/check-proof-coverage.ts'] },
          user_risk: 'Would certify a claim whose backing script has rotted.',
        },
      ],
    });
    const result = validatePublicClaims({
      claims,
      current,
      proofs,
      exceptions,
      pathExists: exists,
      runScriptCheck: () => ({ ok: false, detail: 'exit 1' }),
    });
    expect(result.issues).toEqual([
      'claim CLAIM-STALE-SCRIPT backing script check failed: scripts/release/check-proof-coverage.ts (exit 1)',
    ]);
  });

  it('verified_current claim passes when its backing script check succeeds', () => {
    const current = CurrentCapabilitySnapshot.parse(
      jsonFile('generated/release/current-capabilities.json'),
    );
    const proofs = ProofScenarioIndex.parse(yamlFile('docs/release/proofs/index.yaml'));
    const exceptions = ParityExceptionLedger.parse(yamlFile('docs/release/parity/exceptions.yaml'));
    const runCalls: string[] = [];
    const claims = PublicClaimLedger.parse({
      schema_version: 1,
      claims: [
        {
          id: 'CLAIM-LIVE-SCRIPT',
          claim: 'Backed by a script that still passes',
          type: 'docs',
          status: 'verified_current',
          surfaces: ['README.md'],
          backing: { script_checks: ['scripts/release/check-proof-coverage.ts'] },
          user_risk: 'Would need a genuinely-passing backing script.',
        },
      ],
    });
    const result = validatePublicClaims({
      claims,
      current,
      proofs,
      exceptions,
      pathExists: exists,
      runScriptCheck: (check) => {
        runCalls.push(check);
        return { ok: true };
      },
    });
    expect(result.issues).toEqual([]);
    // The gate actually ran the backing script rather than trusting file existence.
    expect(runCalls).toEqual(['scripts/release/check-proof-coverage.ts']);
  });

  it('flow-catalog claim enumerates the catalog completely (real ledger is in sync)', () => {
    const current = CurrentCapabilitySnapshot.parse(
      jsonFile('generated/release/current-capabilities.json'),
    );
    const proofs = ProofScenarioIndex.parse(yamlFile('docs/release/proofs/index.yaml'));
    const exceptions = ParityExceptionLedger.parse(yamlFile('docs/release/parity/exceptions.yaml'));
    const claims = PublicClaimLedger.parse(yamlFile('docs/release/claims/public-claims.yaml'));

    // The gate can only protect what the ledger still contains: fail loudly if
    // the completeness claim itself is ever deleted.
    expect(claims.claims.some((claim) => claim.id === FLOW_CATALOG_CLAIM_ID)).toBe(true);

    const result = validatePublicClaims({
      claims,
      current,
      proofs,
      exceptions,
      pathExists: exists,
      // Keep the unit hermetic: assert the backing scripts would be executed
      // without spawning them here. Their real execution is covered by the
      // release pipeline and the dedicated script-check tests above.
      runScriptCheck: () => ({ ok: true }),
    });
    expect(result.issues.filter((issue) => issue.includes(FLOW_CATALOG_CLAIM_ID))).toEqual([]);
  });

  it('flow-catalog completeness gate fails when the catalog grows past the claim', () => {
    const current = CurrentCapabilitySnapshot.parse(
      jsonFile('generated/release/current-capabilities.json'),
    );
    const proofs = ProofScenarioIndex.parse(yamlFile('docs/release/proofs/index.yaml'));
    const exceptions = ParityExceptionLedger.parse(yamlFile('docs/release/parity/exceptions.yaml'));
    const claims = PublicClaimLedger.parse(yamlFile('docs/release/claims/public-claims.yaml'));

    // Add a new public flow to the catalog without touching the claim.
    const realFlow = current.capabilities.find((capability) => capability.id === 'flow:review');
    expect(realFlow).toBeDefined();
    const phantom = {
      ...structuredClone(realFlow as typeof realFlow & object),
      id: 'flow:phantom',
    };
    const grown = { ...current, capabilities: [...current.capabilities, phantom] };

    const result = validatePublicClaims({
      claims,
      current: grown,
      proofs,
      exceptions,
      pathExists: exists,
      runScriptCheck: () => ({ ok: true }),
    });
    expect(result.issues).toContain(
      `claim ${FLOW_CATALOG_CLAIM_ID} omits catalog flow capability: flow:phantom`,
    );
  });

  it('flow-catalog completeness gate fails when the claim drops a catalog flow', () => {
    const current = CurrentCapabilitySnapshot.parse(
      jsonFile('generated/release/current-capabilities.json'),
    );
    const proofs = ProofScenarioIndex.parse(yamlFile('docs/release/proofs/index.yaml'));
    const exceptions = ParityExceptionLedger.parse(yamlFile('docs/release/parity/exceptions.yaml'));
    const claims = PublicClaimLedger.parse(yamlFile('docs/release/claims/public-claims.yaml'));

    // Drop a flow the catalog still ships from the claim's capability set.
    const mutated = structuredClone(claims);
    const claim = mutated.claims.find((entry) => entry.id === FLOW_CATALOG_CLAIM_ID);
    expect(claim).toBeDefined();
    if (claim !== undefined) {
      claim.backing.capability_ids = claim.backing.capability_ids.filter(
        (id) => id !== 'flow:review',
      );
    }

    const result = validatePublicClaims({
      claims: mutated,
      current,
      proofs,
      exceptions,
      pathExists: exists,
      runScriptCheck: () => ({ ok: true }),
    });
    expect(result.issues).toContain(
      `claim ${FLOW_CATALOG_CLAIM_ID} omits catalog flow capability: flow:review`,
    );
  });

  it('proof coverage is complete as a tracked blocker set', () => {
    const proofs = ProofScenarioIndex.parse(yamlFile('docs/release/proofs/index.yaml'));
    const exceptions = ParityExceptionLedger.parse(yamlFile('docs/release/parity/exceptions.yaml'));
    const result = validateProofCoverage({ proofs, exceptions, pathExists: exists });
    expect(result.issues).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('keeps proof run files in the release proof corpus', () => {
    const proofs = ProofScenarioIndex.parse(yamlFile('docs/release/proofs/index.yaml'));
    const claims = PublicClaimLedger.parse(yamlFile('docs/release/claims/public-claims.yaml'));
    const indexedPaths = proofs.scenarios.flatMap((scenario) => [
      ...scenario.required_files,
      ...scenario.backing_paths,
    ]);
    const goldenProofClaim = claims.claims.find((claim) => claim.id === 'CLAIM-GOLDEN-PROOF');
    const captureScripts = ['scripts/release/capture-golden-run-proofs.ts'];

    expect(exists(legacyProofRunsRoot)).toBe(false);
    expect(indexedPaths.length).toBeGreaterThan(0);
    expect(goldenProofClaim?.surfaces).toContain(proofRunsRoot);

    for (const path of indexedPaths) {
      expect(path.startsWith(`${proofRunsRoot}/`), path).toBe(true);
      expect(exists(path), path).toBe(true);
    }

    for (const script of captureScripts) {
      const source = readFileSync(resolve(root, script), 'utf8');
      expect(source).toContain(proofRunsRoot);
      expect(source).not.toContain(legacyProofRunsRoot);
    }
  });

  it('captures the Explore decision proof as verified current evidence', () => {
    const proofs = ProofScenarioIndex.parse(yamlFile('docs/release/proofs/index.yaml'));
    const scenario = proofs.scenarios.find((item) => item.id === 'proof:explore-decision');
    expect(scenario?.status).toBe('verified_current');
    expect(scenario?.command).toContain('decide: React vs Vue');
    expect(scenario?.command).toContain('resume');
    expect(scenario?.command).toContain('--checkpoint-choice option-2');
    expect(scenario?.expected_outcome).toBe('checkpoint_waiting, then complete after resume');
    for (const path of scenario?.required_files ?? []) {
      expect(exists(path), path).toBe(true);
    }

    const progress = readFileSync(
      resolve(root, 'docs/release/proofs/runs/explore-decision/progress.jsonl'),
      'utf8',
    )
      .trim()
      .split('\n')
      .map((line) => ProgressEvent.parse(JSON.parse(line)));
    expect(progress[0]).toMatchObject({
      type: 'route.selected',
      selected_flow: 'explore',
      entry_mode: 'tournament',
      routed_by: 'explicit',
      router_reason: 'explicit flow positional argument',
    });
    expect(progress.map((event) => event.type)).toContain('checkpoint.waiting');
    expect(progress.map((event) => event.type)).toContain('run.completed');

    const cliResult = jsonFile('docs/release/proofs/runs/explore-decision/result.json') as {
      readonly flow_id?: string;
      readonly outcome?: string;
    };
    expect(cliResult).toMatchObject({ flow_id: 'explore', outcome: 'complete' });
    expect(
      RunResult.parse(
        jsonFile('docs/release/proofs/runs/explore-decision/run/reports/result.json'),
      ),
    ).toMatchObject({ flow_id: 'explore', outcome: 'complete' });
    expect(
      ExploreDecisionOptions.parse(
        jsonFile('docs/release/proofs/runs/explore-decision/run/reports/decision-options.json'),
      ).options.map((option) => option.label),
    ).toEqual(['React', 'Vue', 'Hybrid path']);
    const aggregate = ExploreTournamentAggregate.parse(
      jsonFile('docs/release/proofs/runs/explore-decision/run/reports/tournament-aggregate.json'),
    );
    for (const branch of aggregate.branches) {
      expect(branch.result_body?.option_id).toBe(branch.branch_id);
    }
    expect(
      ExploreTournamentReview.parse(
        jsonFile('docs/release/proofs/runs/explore-decision/run/reports/tournament-review.json'),
      ).verdict,
    ).toBe('recommend');
    expect(
      ExploreDecision.parse(
        jsonFile('docs/release/proofs/runs/explore-decision/run/reports/decision.json'),
      ),
    ).toMatchObject({
      selected_option_id: 'option-2',
      selected_option_label: 'Vue',
      follow_up_workflow: 'Build',
    });
    expect(
      ExploreResult.parse(
        jsonFile('docs/release/proofs/runs/explore-decision/run/reports/explore-result.json'),
      ).verdict_snapshot,
    ).toMatchObject({ decision_verdict: 'decided', selected_option_id: 'option-2' });
    const summary = readFileSync(
      resolve(root, 'docs/release/proofs/runs/explore-decision/operator-summary.md'),
      'utf8',
    );
    expect(summary).toContain('Circuit · Explore');
    expect(summary).toContain('Choose Vue for a smaller surface and faster product iteration.');
    expect(summary).toContain('Caveat: Team familiarity may be thinner.');
    expect(summary).toContain('Next: Run a Build plan for a Vue prototype.');
    // Format-drift guards. The current renderMarkdown does not emit
    // legacy '## What Happened' / '## Run Files' / '## Reports' sections,
    // and tournament-shape proofs MUST carry the 'Rich summary:' link
    // (visible fallback when auto-open is unavailable).
    expect(summary).not.toContain('## What Happened');
    expect(summary).not.toContain('## Run Files');
    expect(summary).not.toContain('## Reports');
    expect(summary).toContain('Rich summary:');
    for (const file of filesUnder('docs/release/proofs/runs/explore-decision')) {
      const text = readFileSync(file, 'utf8');
      expect(text).not.toMatch(/\/Users\/petepetrash|Code\/circuit|\/private|\/var\/folders/);
    }
  });

  it('all-golden proof capture includes the Explore decision proof', () => {
    const script = readFileSync(
      resolve(root, 'scripts/release/capture-golden-run-proofs.ts'),
      'utf8',
    );

    expect(script).toContain("slug: 'explore-decision'");
    expect(script).toContain('decide: React vs Vue');
    expect(script).toContain("resumeChoice: 'option-2'");
  });

  it('captures the golden Fix proof through runtime executor injection instead of composeWriter', () => {
    const script = readFileSync(
      resolve(root, 'scripts/release/capture-golden-run-proofs.ts'),
      'utf8',
    );

    expect(script).toContain("slug: 'fix'");
    expect(script).toContain('runtimeExecutors: fixProofExecutors()');
    expect(script).toContain("proof: 'release-fix-brief'");
    expect(script).not.toContain('../../dist/runtime/runner.js');
    expect(script).not.toContain('composeWriter:');
  });

  it('keeps index.yaml command strings consistent with the capture scenarios', () => {
    const proofs = ProofScenarioIndex.parse(yamlFile('docs/release/proofs/index.yaml'));
    const script = readFileSync(
      resolve(root, 'scripts/release/capture-golden-run-proofs.ts'),
      'utf8',
    );
    const command = (id: string): string =>
      proofs.scenarios.find((item) => item.id === id)?.command ?? '';

    // Each fragment mirrors argv the capture script actually runs. Without
    // this pin a command string can drop a flag or rename a goal and the
    // published reproduction instructions rot silently.
    const expectedFragments = new Map([
      ['proof:routed-build', ['run build', '"develop: add a small safe change"']],
      ['proof:explicit-build', ['run build', '"add a focused change"', '--depth high']],
      ['proof:review', ['run review', '"review this change"']],
      [
        'proof:checkpoint-resume',
        [
          'run build',
          '"deep change that asks for scope"',
          '--depth high',
          '--checkpoint-choice continue',
        ],
      ],
      ['proof:abort-failure', ['run build', '"simulate connector failure"']],
      ['proof:fix', ['run fix', '"quick fix: restore the failing login test"']],
      [
        'proof:pursue',
        [
          'run pursue',
          '"add the fallback answer guard in src/example.ts; document the guard in notes.md"',
        ],
      ],
      [
        'proof:explore-standard',
        ['run explore', '"recommend a frontend framework for the new analytics dashboard"'],
      ],
      [
        'proof:explore-decision',
        ['run explore', '"decide: React vs Vue"', '--tournament 3', '--checkpoint-choice option-2'],
      ],
      [
        'proof:explore-autonomous-decision',
        ['run explore', '"decide: React vs Vue"', '--tournament 2', '--autonomous'],
      ],
      [
        'proof:prototype',
        [
          'run prototype',
          '"prototype: sketch a custom Circuit flow builder UI"',
          '--depth high',
          '--checkpoint-choice save-build-input',
        ],
      ],
      [
        'proof:plan-execution',
        ['run build', '"Execute this plan: ./docs/specs/headless-engine-host-api-v1.md"'],
      ],
    ]);
    for (const [id, fragments] of expectedFragments) {
      for (const fragment of fragments) {
        expect(command(id), id).toContain(fragment);
        // Goal text must also appear in the capture script (argv strings are
        // single-quoted there), so the index, the script, and this pin agree
        // three ways. Flags are argv-array elements in the script, so only
        // quoted goal fragments carry over.
        if (fragment.startsWith('"')) {
          expect(script, id).toContain(fragment.replaceAll('"', "'"));
        }
      }
    }
  });

  it('captures current golden run proofs with scrubbed, schema-valid files', () => {
    const proofs = ProofScenarioIndex.parse(yamlFile('docs/release/proofs/index.yaml'));
    const expected = new Map([
      ['proof:routed-build', { slug: 'routed-build', flow: 'build', outcome: 'complete' }],
      [
        'proof:explicit-build',
        { slug: 'explicit-build', flow: 'build', outcome: 'checkpoint_waiting' },
      ],
      ['proof:review', { slug: 'review', flow: 'review', outcome: 'complete' }],
      ['proof:checkpoint-resume', { slug: 'checkpoint', flow: 'build', outcome: 'complete' }],
      ['proof:abort-failure', { slug: 'abort', flow: 'build', outcome: 'aborted' }],
      // H1 (pre-launch audit): this proof's fixture defers a regression, so the
      // Fix primary result is `partial`. An honest run closes `stopped`, not
      // `complete` — the run outcome must never out-claim the fix result. Before
      // H1 this pair was `complete` over a `partial` result: the exact leak the
      // audit closed. Do not revert to `complete`.
      ['proof:fix', { slug: 'fix', flow: 'fix', outcome: 'stopped' }],
      ['proof:pursue', { slug: 'pursue', flow: 'pursue', outcome: 'complete' }],
      [
        'proof:explore-standard',
        { slug: 'explore-standard', flow: 'explore', outcome: 'complete' },
      ],
      [
        'proof:explore-decision',
        { slug: 'explore-decision', flow: 'explore', outcome: 'complete' },
      ],
      [
        'proof:explore-autonomous-decision',
        { slug: 'explore-autonomous-decision', flow: 'explore', outcome: 'complete' },
      ],
      ['proof:prototype', { slug: 'prototype', flow: 'prototype', outcome: 'complete' }],
      ['proof:plan-execution', { slug: 'plan-execution', flow: 'build', outcome: 'complete' }],
      ['proof:doctor-first-run', { slug: 'doctor', flow: 'doctor', outcome: 'ok' }],
    ]);

    for (const [id, proof] of expected) {
      const scenario = proofs.scenarios.find((item) => item.id === id);
      expect(scenario?.status, id).toBe('verified_current');
      expect(scenario?.exception_ids, id).toEqual([]);
      for (const path of [
        ...(scenario?.required_files ?? []),
        ...(scenario?.backing_paths ?? []),
      ]) {
        expect(exists(path), `${id} ${path}`).toBe(true);
      }

      if (proof.slug === 'doctor') {
        const output = readFileSync(
          resolve(root, 'docs/release/proofs/runs/doctor/output.txt'),
          'utf8',
        );
        expect(output).toContain('exit: 0');
        expect(output).toContain('"status": "ok"');
        continue;
      }

      const topLevelResult = jsonFile(`docs/release/proofs/runs/${proof.slug}/result.json`) as {
        readonly flow_id?: string;
        readonly selected_flow?: string;
        readonly outcome?: string;
      };
      expect(topLevelResult.flow_id ?? topLevelResult.selected_flow, id).toBe(proof.flow);
      expect(topLevelResult.outcome, id).toBe(proof.outcome);
      if (proof.outcome !== 'checkpoint_waiting') {
        expect(
          RunResult.parse(
            jsonFile(`docs/release/proofs/runs/${proof.slug}/run/reports/result.json`),
          ),
        ).toMatchObject({ flow_id: proof.flow, outcome: proof.outcome });
      }
      const progress = readFileSync(
        resolve(root, `docs/release/proofs/runs/${proof.slug}/progress.jsonl`),
        'utf8',
      )
        .trim()
        .split('\n')
        .map((line) => ProgressEvent.parse(JSON.parse(line)));
      expect(progress[0]?.type, id).toBe('route.selected');
      expect(
        progress.map((event) => event.type),
        id,
      ).toContain(
        proof.outcome === 'aborted'
          ? 'run.aborted'
          : proof.outcome === 'checkpoint_waiting'
            ? 'checkpoint.waiting'
            : 'run.completed',
      );
    }

    expect(
      BuildResult.parse(
        jsonFile('docs/release/proofs/runs/routed-build/run/reports/build-result.json'),
      ).outcome,
    ).toBe('complete');
    expect(
      ReviewResult.parse(jsonFile('docs/release/proofs/runs/review/run/reports/review-result.json'))
        .verdict,
    ).toBe('CLEAN');
    expect(
      FixResult.parse(jsonFile('docs/release/proofs/runs/fix/run/reports/fix-result.json')).outcome,
    ).toBe('partial');
    expect(
      PursuitResult.parse(
        jsonFile('docs/release/proofs/runs/pursue/run/reports/pursuit-result.json'),
      ),
    ).toMatchObject({
      outcome: 'complete',
      verification_status: 'passed',
      review_verdict: 'clean',
      total_pursuits: 2,
      completed_count: 2,
      serial_code_writes: true,
    });

    const handoffScenario = proofs.scenarios.find((item) => item.id === 'proof:handoff');
    expect(handoffScenario?.status).toBe('verified_current');
    for (const path of [
      ...(handoffScenario?.required_files ?? []),
      ...(handoffScenario?.backing_paths ?? []),
    ]) {
      expect(exists(path), `proof:handoff ${path}`).toBe(true);
    }
    expect(
      ContinuityRecord.parse(jsonFile('docs/release/proofs/runs/handoff/continuity.json')),
    ).toMatchObject({
      continuity_kind: 'run-backed',
      narrative: { next: 'DO: resolve the Build checkpoint and continue.' },
    });
    expect(
      ContinuityIndex.parse(
        jsonFile('docs/release/proofs/runs/handoff/control-plane/continuity/index.json'),
      ).pending_record?.record_id,
    ).toBe('continuity-44444444-4444-4444-8444-444444444411');
    expect(
      readFileSync(resolve(root, 'docs/release/proofs/runs/handoff/operator-summary.md'), 'utf8'),
    ).toContain('DO: resolve the Build checkpoint and continue.');

    const customizationScenario = proofs.scenarios.find(
      (item) => item.id === 'proof:customization',
    );
    expect(customizationScenario?.status).toBe('verified_current');
    for (const path of [
      ...(customizationScenario?.required_files ?? []),
      ...(customizationScenario?.backing_paths ?? []),
    ]) {
      expect(exists(path), `proof:customization ${path}`).toBe(true);
    }
    const customizationResult = jsonFile('docs/release/proofs/runs/customization/result.json') as {
      readonly status?: string;
      readonly slug?: string;
    };
    expect(customizationResult).toMatchObject({
      status: 'published',
      slug: 'release-note-flow',
    });
    // The proof run is a frozen record captured before the dead `entry`
    // routing metadata was removed from CompiledFlow (schema_version '2');
    // drop the legacy key and pin the current schema_version at the parse
    // site instead of editing the frozen file. See
    // docs/contracts/schema-versioning.md.
    const { entry: _legacyEntry, ...customFlowProof } = jsonFile(
      'docs/release/proofs/runs/customization/custom-home/flows/release-note-flow/circuit.json',
    ) as Record<string, unknown>;
    expect(CompiledFlow.parse({ ...customFlowProof, schema_version: '3' }).id).toBe(
      'release-note-flow',
    );

    for (const file of filesUnder('docs/release/proofs/runs')) {
      const text = readFileSync(file, 'utf8');
      expect(text).not.toMatch(
        /\/Users\/petepetrash|Code\/circuit|\/private|\/var\/folders|\/tmp\//,
      );
    }
  });

  it('planned proof scenarios still block release readiness', () => {
    const proofs = ProofScenarioIndex.parse({
      schema_version: 1,
      scenarios: [
        {
          id: 'proof:planned',
          title: 'Planned Proof',
          category: 'doing-work',
          command: 'circuit planned',
          expected_outcome: 'complete',
          summary_contract: 'Shows the result.',
          redaction_policy: 'No private data.',
          required_files: [],
          status: 'planned',
          exception_ids: ['EX-PLANNED-PROOF'],
        },
      ],
    });
    const exceptions = ParityExceptionLedger.parse({
      schema_version: 1,
      exceptions: [
        {
          id: 'EX-PLANNED-PROOF',
          proof_id: 'proof:planned',
          status: 'approved_exception',
          readiness_ref: 'REL-011',
          rationale: 'Fixture exception',
        },
      ],
    });
    const claims = PublicClaimLedger.parse({ schema_version: 1, claims: [] });
    const coverage = validateProofCoverage({ proofs, exceptions, pathExists: exists });
    expect(coverage.issues).toEqual([
      'proof category has no scenario: deciding',
      'proof category has no scenario: continuity',
      'proof category has no scenario: customization',
      'proof category has no scenario: first-run',
      'proof category has no scenario: failure',
      'proof category has no scenario: plan-execution',
    ]);
    expect(releaseBlockers({ exceptions, claims, proofs })).toContain(
      'proof:planned: proof scenario is not captured',
    );
  });
});
