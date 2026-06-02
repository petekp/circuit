import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { THREE_AXIS_RUBRIC_TIE_BREAK_ORDER, combineRubricResult } from '../../src/policy/rubric.js';
import { CompiledFlowId, RunId } from '../../src/schemas/ids.js';
import { OperatorSummary } from '../../src/schemas/operator-summary.js';
import { RunResult } from '../../src/schemas/result.js';
import { readPriorRoute, writeOperatorSummary } from '../../src/shared/operator-summary-writer.js';

let runFolder: string;

beforeEach(() => {
  runFolder = mkdtempSync(join(tmpdir(), 'circuit-operator-summary-'));
  mkdirSync(join(runFolder, 'reports'), { recursive: true });
});

afterEach(() => {
  rmSync(runFolder, { recursive: true, force: true });
});

function writeReport(relPath: string, body: unknown): void {
  const path = join(runFolder, relPath);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
}

function writeTrace(entries: readonly unknown[]): void {
  writeFileSync(
    join(runFolder, 'trace.ndjson'),
    `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
  );
}

function baseResult(flowId: string): RunResult {
  return RunResult.parse({
    schema_version: 1,
    run_id: '87000000-0000-0000-0000-000000000001',
    flow_id: flowId,
    goal: `run ${flowId}`,
    outcome: 'complete',
    summary: `${flowId} v0.1.0 closed 3 step(s) for goal "run ${flowId}".`,
    closed_at: '2026-04-28T12:00:00.000Z',
    trace_entries_observed: 3,
    manifest_hash: 'abc123',
  });
}

function passingRubricResult() {
  return combineRubricResult({
    dims: Object.fromEntries(
      THREE_AXIS_RUBRIC_TIE_BREAK_ORDER.map((dim) => [
        dim,
        { runtime_signal: 'met', model_judgment: 'pass' },
      ]),
    ),
    orderedDims: THREE_AXIS_RUBRIC_TIE_BREAK_ORDER,
  });
}

function writeHighestScoreAutoResolution(): void {
  const record = {
    checkpoint_id: 'tradeoff-checkpoint-step',
    checkpoint_label: 'Decision - tradeoff checkpoint',
    policy: 'highest-score',
    resolved_value: 'option-2',
    alternatives_available: ['option-1'],
    scores: {
      'option-1': { aggregate_score: 0.875, runtime_veto_count: 1 },
      'option-2': { aggregate_score: 1, runtime_veto_count: 0 },
    },
    rubric_results: {
      'option-2': passingRubricResult(),
    },
    winning_score: 1,
    runner_up_score: 0.875,
    margin: 0.125,
    tie_break: 'aggregate_score',
    runtime_veto_effect:
      'option-1 evidence_rigor runtime_signal=missing forced final_score=fail and dim_score=0',
    resolved_at: '2026-05-19T12:00:00.000Z',
  };
  writeReport('reports/checkpoints/tradeoff-response.json', {
    schema_version: 1,
    step_id: 'tradeoff-checkpoint-step',
    selection: 'option-2',
    route_id: 'select',
    resolution_source: 'policy',
    auto_resolution: record,
  });
  writeTrace([
    {
      schema_version: 1,
      sequence: 1,
      recorded_at: '2026-05-19T12:00:00.000Z',
      run_id: '87000000-0000-0000-0000-000000000001',
      kind: 'checkpoint.resolved',
      step_id: 'tradeoff-checkpoint-step',
      attempt: 1,
      selection: 'option-2',
      route_id: 'select',
      auto_resolved: true,
      resolution_source: 'policy',
      response_path: 'reports/checkpoints/tradeoff-response.json',
    },
  ]);
}

function buildVerificationCommand() {
  return {
    id: 'build-verify',
    cwd: '.',
    argv: ['npm', 'run', 'verify'],
    timeout_ms: 120_000,
    max_output_bytes: 200_000,
    env: {},
  };
}

function buildCheckpointPacket(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'build.checkpoint_packet@v1',
    salience: {
      summary: 'Confirm the Build brief before write-capable work starts.',
      why_now: ['The next route can edit the checkout.'],
      hidden_routine_work: ['Routine status and raw traces stay behind evidence links.'],
    },
    decision: {
      question: 'Confirm the Build brief before implementation starts.',
      operator_judgment: 'Decide whether this is the right scope and proof plan.',
    },
    recommendation: {
      choice_id: 'continue',
      label: 'Continue',
      rationale: 'The scope is bounded and the proof plan is explicit.',
    },
    artifact: {
      title: 'Build brief',
      preview: 'Objective: Add checkpoint HTML',
      scope: 'Touch Build checkpoint presentation only',
      success_criteria: ['Waiting checkpoint emits useful HTML'],
    },
    proof: {
      status: 'planned',
      summary: 'Circuit will verify with npm run verify.',
      commands: [buildVerificationCommand()],
      evidence: ['No implementation proof has been collected before the checkpoint.'],
    },
    risk: {
      summary: 'Scope mismatch is the meaningful risk.',
      tradeoffs: ['Too narrow misses intent.', 'Too broad touches unrelated files.'],
    },
    choices: [
      {
        id: 'continue',
        label: 'Continue',
        description: 'Proceed on the recommended executable route.',
        route: { key: 'continue', target: 'plan-step' },
      },
    ],
    internal: {
      request_path: 'reports/checkpoints/frame-step-request.json',
      response_path: 'reports/checkpoints/frame-step-response.json',
      report_path: 'reports/build/brief.json',
      raw_evidence: ['reports/build/brief.json'],
    },
    ...overrides,
  };
}

function buildBrief(overrides: Record<string, unknown> = {}) {
  return {
    objective: 'Add checkpoint HTML',
    scope: 'Touch Build checkpoint presentation only',
    success_criteria: ['Waiting checkpoint emits useful HTML'],
    verification_command_candidates: [buildVerificationCommand()],
    checkpoint: {
      request_path: 'reports/checkpoints/frame-step-request.json',
      response_path: 'reports/checkpoints/frame-step-response.json',
      allowed_choices: ['continue'],
    },
    checkpoint_packet: buildCheckpointPacket(),
    ...overrides,
  };
}

const PROTOTYPE_ROOT = '.circuit/prototypes/operator-summary';

function prototypeBrief(overrides: Record<string, unknown> = {}) {
  return {
    objective: 'Custom flow builder',
    prototype_scope: 'Create a disposable UI artifact.',
    out_of_scope: ['Production code', 'Deployment'],
    target_user: 'Circuit operator',
    success_criteria: ['Prototype files exist'],
    prototype_root: PROTOTYPE_ROOT,
    verification_command_candidates: [],
    claim_limits: ['not production', 'not deployed'],
    ...overrides,
  };
}

function prototypePlan(overrides: Record<string, unknown> = {}) {
  return {
    objective: 'Custom flow builder',
    prototype_root: PROTOTYPE_ROOT,
    files_to_create: [`${PROTOTYPE_ROOT}/index.html`, `${PROTOTYPE_ROOT}/README.md`],
    entry_points: [`${PROTOTYPE_ROOT}/index.html`],
    interaction_path: `${PROTOTYPE_ROOT}/index.html`,
    preview_instructions: `Open ${PROTOTYPE_ROOT}/index.html locally.`,
    verification: { commands: [] },
    build_followup_prompt: 'Use this prototype as Build input later.',
    risks: ['Prototype polish can overstate readiness.'],
    claim_limits: ['not production', 'not deployed'],
    ...overrides,
  };
}

function prototypeArtifact(overrides: Record<string, unknown> = {}) {
  return {
    verdict: 'accept',
    summary: 'Created a local custom-flow UI prototype.',
    prototype_root: PROTOTYPE_ROOT,
    created_files: [`${PROTOTYPE_ROOT}/index.html`, `${PROTOTYPE_ROOT}/README.md`],
    entry_points: [`${PROTOTYPE_ROOT}/index.html`],
    preview_instructions: `Open ${PROTOTYPE_ROOT}/index.html locally.`,
    known_limitations: ['Not wired to live Circuit flow saving.'],
    evidence: ['index.html exists'],
    claim_limits: ['not production', 'not deployed'],
    ...overrides,
  };
}

function prototypeVerification(overrides: Record<string, unknown> = {}) {
  return {
    overall_status: 'passed',
    commands: [
      {
        command_id: 'prototype-artifact-integrity',
        argv: [process.execPath, '-e', 'process.exit(0)'],
        cwd: '.',
        exit_code: 0,
        status: 'passed',
        duration_ms: 1,
        stdout_summary: 'ok',
        stderr_summary: '',
      },
    ],
    ...overrides,
  };
}

const PROTOTYPE_VARIANT_ROOT = 'prototype-files';

function prototypeRubricJudgments() {
  return Object.fromEntries(THREE_AXIS_RUBRIC_TIE_BREAK_ORDER.map((dim) => [dim, 'pass']));
}

function prototypeVariantArtifact(id: string, label: string, root = PROTOTYPE_VARIANT_ROOT) {
  return {
    verdict: 'accept',
    variant_id: id,
    variant_label: label,
    summary: `${label} created a flow builder prototype.`,
    prototype_root: root,
    variant_root: `${root}/variants/${id}`,
    created_files: [`${root}/variants/${id}/index.html`],
    entry_points: [`${root}/variants/${id}/index.html`],
    preview_instructions: `Open ${root}/variants/${id}/index.html locally.`,
    known_limitations: ['Local prototype only.'],
    evidence: [`${root}/variants/${id}/index.html exists`],
    rubric_model_judgments: prototypeRubricJudgments(),
    claim_limits: ['not production', 'not deployed'],
  };
}

function writePrototypeVariantReports(root = PROTOTYPE_VARIANT_ROOT): void {
  writeReport('reports/prototype/variant-aggregate.json', {
    schema_version: 1,
    join_policy: 'aggregate-survivors',
    branch_count: 2,
    branches: [
      {
        branch_id: 'variant-a',
        child_run_id: 'child-a',
        child_outcome: 'complete',
        verdict: 'accept',
        admitted: true,
        result_path: 'reports/prototype/variant-branches/variant-a/report.json',
        duration_ms: 1,
        result_body: prototypeVariantArtifact('variant-a', 'Variant A', root),
        rubric_result: passingRubricResult(),
      },
      {
        branch_id: 'variant-b',
        child_run_id: 'child-b',
        child_outcome: 'complete',
        verdict: 'accept',
        admitted: true,
        result_path: 'reports/prototype/variant-branches/variant-b/report.json',
        duration_ms: 1,
        result_body: prototypeVariantArtifact('variant-b', 'Variant B', root),
        rubric_result: passingRubricResult(),
      },
    ],
  });
  writeReport('reports/prototype/variant-provider-evidence.json', {
    schema_version: 1,
    evidence_source: 'relay.started resolved_selection trace entries',
    required_captured_count: 2,
    captured_count: 2,
    variants: [
      {
        variant_id: 'variant-a',
        label: 'Variant A',
        relay_step_id: 'variant-fanout-step-variant-a',
        status: 'captured',
        connector_name: 'claude-code',
        provider: 'anthropic',
        model: 'fixture-a',
        effort: 'medium',
        trace_sequence: 4,
        trace_entry_kind: 'relay.started',
        resolved_from: { source: 'role', role: 'implementer' },
      },
      {
        variant_id: 'variant-b',
        label: 'Variant B',
        relay_step_id: 'variant-fanout-step-variant-b',
        status: 'captured',
        connector_name: 'claude-code',
        provider: 'anthropic',
        model: 'fixture-b',
        effort: 'high',
        trace_sequence: 8,
        trace_entry_kind: 'relay.started',
        resolved_from: { source: 'role', role: 'implementer' },
      },
    ],
    missing_evidence: [],
  });
  writeReport('reports/prototype/variant-verification.json', {
    overall_status: 'passed',
    required_captured_provider_evidence_count: 2,
    captured_provider_evidence_count: 2,
    admitted_variant_count: 2,
    variant_results: [
      {
        variant_id: 'variant-a',
        status: 'passed',
        entry_points: [`${root}/variants/variant-a/index.html`],
        created_files: [`${root}/variants/variant-a/index.html`],
        notes: ['ok'],
      },
      {
        variant_id: 'variant-b',
        status: 'passed',
        entry_points: [`${root}/variants/variant-b/index.html`],
        created_files: [`${root}/variants/variant-b/index.html`],
        notes: ['ok'],
      },
    ],
    commands: [
      {
        command_id: 'prototype-variant-artifact-integrity',
        argv: [process.execPath, '-e', 'process.exit(0)'],
        cwd: '.',
        exit_code: 0,
        status: 'passed',
        duration_ms: 1,
        stdout_summary: 'ok',
        stderr_summary: '',
      },
    ],
  });
  writeReport('reports/prototype/variant-review.json', {
    verdict: 'recommend',
    recommended_variant_id: 'variant-a',
    comparison_summary: 'Variant A is clearer; Variant B is denser.',
    strengths: [{ variant_id: 'variant-a', note: 'Clearer.' }],
    risks: [],
    missing_evidence: [],
    confidence: 'medium',
  });
  writeReport('reports/prototype/variant-choice-options.json', {
    schema_version: 1,
    prompt: 'Choose one.',
    recommended_variant_id: 'variant-a',
    choices: [
      {
        id: 'variant-a',
        variant_id: 'variant-a',
        label: 'Variant A',
        description: 'Clearer.',
        variant_root: `${root}/variants/variant-a`,
        entry_points: [`${root}/variants/variant-a/index.html`],
        verification_status: 'passed',
        model_evidence_status: 'captured',
        review_recommendation: true,
        recommended: true,
      },
      {
        id: 'variant-b',
        variant_id: 'variant-b',
        label: 'Variant B',
        description: 'Denser.',
        variant_root: `${root}/variants/variant-b`,
        entry_points: [`${root}/variants/variant-b/index.html`],
        verification_status: 'passed',
        model_evidence_status: 'captured',
        review_recommendation: false,
        recommended: false,
      },
    ],
  });
}

describe('operator summary writer', () => {
  it('writes Review summary files with verdict, finding count, warnings, and report paths', () => {
    writeReport('reports/review-result.json', {
      scope: 'review current changes',
      findings: [],
      verdict: 'CLEAN',
      evidence_summary: {
        kind: 'git-working-tree',
        untracked_content_policy: 'include-content',
        untracked_file_count: 1,
        untracked_files_sampled: 1,
        untracked_files_truncated: false,
      },
      evidence_warnings: [
        {
          kind: 'diff_truncated',
          message: 'staged diff was truncated before relay',
        },
      ],
    });

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('review'),
      route: {
        selectedFlow: 'review',
        routedBy: 'classifier',
        routerReason: 'matched review',
      },
    });

    expect(existsSync(written.jsonPath)).toBe(true);
    expect(existsSync(written.markdownPath)).toBe(true);
    const summary = OperatorSummary.parse(JSON.parse(readFileSync(written.jsonPath, 'utf8')));
    expect(summary.headline).toBe('Circuit: Review complete. Verdict: CLEAN. Findings: 0.');
    expect(summary.status_text).toBe('Review complete. Verdict: CLEAN. Findings: 0.');
    expect(summary.details).toContain(
      'Untracked evidence: contents included for 1 file (1 untracked file found).',
    );
    expect(summary.evidence_warnings).toContainEqual(
      expect.objectContaining({ kind: 'diff_truncated' }),
    );
    expect(summary.report_paths.map((report) => report.label)).toEqual([
      'Run result',
      'review result',
    ]);
    const markdown = readFileSync(written.markdownPath, 'utf8');
    expect(markdown).toContain('CIRCUIT\n⎿ Review complete. Verdict: CLEAN. Findings: 0.');
    expect(markdown).toContain('Untracked evidence: contents included for 1 file');
    expect(markdown).toContain('diff_truncated');
    expect(markdown).not.toContain('write-capable Claude Code worker');
    expect(markdown).not.toContain('v0.1.0 closed');
  });

  it('renders the reviewer assessment, verification steps, and confidence limitations on a clean verdict', () => {
    writeReport('reports/review-result.json', {
      scope: 'review the staged change',
      findings: [],
      verdict: 'CLEAN',
      assessment:
        'Reviewer inspected the staged diff and the new test fixture; nothing actionable surfaced.',
      verification: [
        'Read src/example.ts',
        'Replayed the staged diff against tests/example.test.ts',
      ],
      confidence_limitations: [
        'HEAD~1 history was out of scope for this review.',
        'No untracked content was relayed.',
      ],
      evidence_summary: {
        kind: 'git-working-tree',
        untracked_content_policy: 'metadata-only',
        untracked_file_count: 0,
        untracked_files_sampled: 0,
        untracked_files_truncated: false,
      },
      evidence_warnings: [],
    });

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('review'),
      route: { selectedFlow: 'review' },
    });

    expect(written.summary.headline).toBe('Circuit: Review complete. Verdict: CLEAN. Findings: 0.');
    // The bare "Findings: 0" detail is replaced by the reviewer's assessment.
    expect(written.summary.details).not.toContain('Findings: 0');
    expect(written.summary.details).toContain(
      'Assessment: Reviewer inspected the staged diff and the new test fixture; nothing actionable surfaced.',
    );
    expect(written.summary.details).toContain(
      'Reviewer steps: Read src/example.ts; Replayed the staged diff against tests/example.test.ts',
    );
    expect(written.summary.details).toContain(
      'Confidence limitations: HEAD~1 history was out of scope for this review.; No untracked content was relayed.',
    );
    const markdown = readFileSync(written.markdownPath, 'utf8');
    expect(markdown).toContain('Assessment: Reviewer inspected the staged diff');
    expect(markdown).toContain('Reviewer steps: Read src/example.ts');
    expect(markdown).toContain('Confidence limitations:');
  });

  it('renders clean Review results with low-severity notes without saying Findings are blocking', () => {
    writeReport('reports/review-result.json', {
      scope: 'review untracked notes',
      findings: [
        {
          severity: 'low',
          id: 'note-001',
          text: 'small naming note',
          file_refs: ['notes.txt'],
        },
      ],
      verdict: 'CLEAN',
      assessment: 'Reviewer inspected the relayed untracked file and found only a note.',
      verification: ['Read notes.txt'],
      confidence_limitations: [],
      evidence_warnings: [],
    });

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('review'),
      route: { selectedFlow: 'review' },
    });

    expect(written.summary.headline).toBe(
      'Circuit: Review complete. Verdict: CLEAN. Low-severity notes: 1.',
    );
    expect(written.summary.status_text).toBe(
      'Review complete. Verdict: CLEAN. Low-severity notes: 1.',
    );
    expect(written.summary.details).toContain('[LOW] small naming note — at notes.txt');
    expect(readFileSync(written.markdownPath, 'utf8')).not.toContain(
      'Verdict: CLEAN. Findings: 1.',
    );
  });

  it('keeps the assessment alongside finding bullets when issues are found', () => {
    writeReport('reports/review-result.json', {
      scope: 'review evil.js',
      findings: [
        {
          severity: 'high',
          id: 'eval-001',
          text: 'eval call enables remote code execution',
          file_refs: ['evil.js:7'],
        },
      ],
      verdict: 'ISSUES_FOUND',
      assessment: 'Reviewer flagged one high-severity issue in evil.js.',
      verification: ['Read evil.js'],
      confidence_limitations: [],
      evidence_warnings: [],
    });

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('review'),
      route: { selectedFlow: 'review' },
    });

    expect(written.summary.details).toContain(
      'Assessment: Reviewer flagged one high-severity issue in evil.js.',
    );
    expect(written.summary.details).toContain(
      '[HIGH] eval call enables remote code execution — at evil.js:7',
    );
    expect(written.summary.details).toContain('Reviewer steps: Read evil.js');
    expect(written.summary.details).not.toContain('Confidence limitations:');
  });

  it('frames Explore review fold-ins as optional considerations when the reviewer left no objections', () => {
    writeReport('reports/explore-result.json', {
      summary:
        "Explore 'doc set': Add a contributor onboarding doc. Recommend starting with the README.",
      verdict_snapshot: {
        compose_verdict: 'accept',
        review_verdict: 'accept-with-fold-ins',
        objection_count: 0,
        missed_angle_count: 1,
      },
      review_fold_ins: {
        overall_assessment: 'Direction is useful.',
        objections: [],
        missed_angles: ['Mention the contributor agreement up front.'],
      },
      evidence_links: [],
    });

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('explore'),
      route: { selectedFlow: 'explore' },
    });

    expect(written.summary.headline).toBe(
      'Circuit: Recommendation accepted, with optional considerations.',
    );
    expect(written.summary.details).toContain(
      'Reviewer: Accepted the direction, with optional considerations.',
    );
    expect(written.summary.details).toContain(
      'Consider: Mention the contributor agreement up front.',
    );
    expect(written.summary.details.join('\n')).not.toContain('Required fold-in:');
    expect(written.summary.details.join('\n')).not.toContain('Follow-up:');
  });

  it('rewrites the Review headline to flag scope_empty so a CLEAN/0-findings verdict cannot quietly stand in for "nothing was reviewed"', () => {
    writeReport('reports/review-result.json', {
      scope: 'review the new evil.js — flag any safety problems',
      findings: [],
      verdict: 'CLEAN',
      evidence_summary: {
        kind: 'git-working-tree',
        untracked_content_policy: 'metadata-only',
        untracked_file_count: 0,
        untracked_files_sampled: 0,
        untracked_files_truncated: false,
      },
      evidence_warnings: [
        {
          kind: 'scope_empty',
          message:
            'review scoped to uncommitted changes only; HEAD~1 differences not examined. The reviewer had no source content to inspect: staged/unstaged diffs were empty and no untracked file content was relayed.',
        },
      ],
    });

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('review'),
      route: { selectedFlow: 'review' },
    });

    expect(written.summary.headline).toContain('no uncommitted source content to examine');
    expect(written.summary.headline).toContain('committed history (HEAD~1) was not part of this');
    expect(written.summary.headline).not.toMatch(/^Circuit: Review complete\./);
    // Verdict reference must not survive into the scope_empty headline:
    // verdict is meaningless when no source content was inspected, and
    // the projector's fallback for a missing verdict reads ungrammatical
    // ("Verdict review complete reflects scope...") through the headline.
    expect(written.summary.headline).not.toMatch(/Verdict\s/);
    expect(written.summary.evidence_warnings).toContainEqual(
      expect.objectContaining({ kind: 'scope_empty' }),
    );
    const markdown = readFileSync(written.markdownPath, 'utf8');
    expect(markdown).toContain('no uncommitted source content to examine');
    expect(markdown).toContain('scope_empty');
  });

  it('lists Review findings with severity, text, and file refs in the operator summary', () => {
    writeReport('reports/review-result.json', {
      scope: 'review staged evil.js',
      findings: [
        {
          severity: 'critical',
          id: 'rce-001',
          text: 'eval call enables remote code execution',
          file_refs: ['evil.js'],
        },
        {
          severity: 'high',
          id: 'regex-002',
          text: 'unbounded regex risks ReDoS\nin parser',
          file_refs: ['parser.ts', 'parser.test.ts'],
        },
        {
          severity: 'low',
          id: 'naming-003',
          text: 'inconsistent variable naming',
          file_refs: [],
        },
      ],
      verdict: 'ISSUES_FOUND',
      evidence_warnings: [],
    });

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('review'),
      route: { selectedFlow: 'review' },
    });

    expect(written.summary.headline).toBe(
      'Circuit: Review complete. Verdict: ISSUES_FOUND. Findings: 3.',
    );
    expect(written.summary.details).toContain(
      '[CRITICAL] eval call enables remote code execution — at evil.js',
    );
    expect(written.summary.details).toContain(
      '[HIGH] unbounded regex risks ReDoS — at parser.ts, parser.test.ts',
    );
    expect(written.summary.details).toContain('[LOW] inconsistent variable naming');
    expect(written.summary.details).not.toContain('Findings: 3');
    const markdown = readFileSync(written.markdownPath, 'utf8');
    expect(markdown).toContain('[CRITICAL] eval call enables remote code execution — at evil.js');
    expect(markdown).toContain('[HIGH] unbounded regex risks ReDoS');
    expect(markdown).toContain('[LOW] inconsistent variable naming');
  });

  it('strips leading markdown markers from finding text so summary bullets cannot nest', () => {
    writeReport('reports/review-result.json', {
      scope: 'review',
      findings: [
        {
          severity: 'high',
          id: 'leak-001',
          text: '- nested bullet from finding',
          file_refs: [],
        },
        {
          severity: 'low',
          id: 'leak-002',
          text: '   ',
          file_refs: [],
        },
      ],
      verdict: 'ISSUES_FOUND',
      evidence_warnings: [],
    });
    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('review'),
      route: { selectedFlow: 'review' },
    });
    expect(written.summary.details).toContain('[HIGH] nested bullet from finding');
    expect(written.summary.details).not.toContain('[HIGH] - nested bullet from finding');
    expect(written.summary.details).toContain('[LOW] (no text)');
  });

  it('summarizes Build and Fix close reports with verification and review status', () => {
    const cases = [
      {
        flow: 'build',
        label: 'Build',
        relPath: 'reports/build-result.json',
        body: {
          summary: 'Build result for feature: implemented change',
          outcome: 'complete',
          verification_status: 'passed',
          review_verdict: 'accept',
          evidence_links: [
            {
              report_id: 'build.review',
              path: 'reports/build/review.json',
              schema: 'build.review@v1',
            },
          ],
        },
        expected:
          'Circuit: Build complete. Change implemented, verification passed, review accepted.',
      },
      {
        flow: 'build',
        label: 'Build',
        relPath: 'reports/build-result.json',
        body: {
          summary: 'Build result for feature: implemented change with follow-ups',
          outcome: 'needs_attention',
          verification_status: 'passed',
          review_verdict: 'accept-with-fixes',
          evidence_links: [
            {
              report_id: 'build.review',
              path: 'reports/build/review.json',
              schema: 'build.review@v1',
            },
          ],
        },
        expected:
          'Circuit: Build needs follow-up. Verification passed, but review requested fixes.',
      },
      {
        flow: 'fix',
        label: 'Fix',
        relPath: 'reports/fix-result.json',
        body: {
          summary: 'Fix bug: patched change',
          outcome: 'fixed',
          verification_status: 'passed',
          review_verdict: 'accept',
          evidence_links: [
            { report_id: 'fix.review', path: 'reports/fix/review.json', schema: 'fix.review@v1' },
          ],
        },
        expected: 'Circuit: Fix complete. Verification: passed. Review: accepted.',
      },
      {
        flow: 'pursue',
        label: 'Pursue',
        relPath: 'reports/pursuit-result.json',
        body: {
          summary: 'Pursuits result for README update: completed serially',
          outcome: 'complete',
          verification_status: 'passed',
          review_verdict: 'clean',
          total_pursuits: 1,
          completed_count: 1,
          skipped_count: 0,
          blocked_count: 0,
          failed_count: 0,
          serial_code_writes: true,
          evidence_links: [
            {
              report_id: 'pursuit.review',
              path: 'reports/pursuit/review.json',
              schema: 'pursuit.review@v1',
            },
          ],
        },
        expected:
          'Circuit: Pursue finished with outcome complete. 1/1 pursuit completed. Verification: passed.',
      },
    ];

    for (const entry of cases) {
      writeReport(entry.relPath, entry.body);
      const written = writeOperatorSummary({
        runFolder,
        runResult: baseResult(entry.flow),
        route: { selectedFlow: entry.flow },
      });
      expect(written.summary.headline).toBe(entry.expected);
      expect(written.summary.details).toContain(
        `Run note: Completed 3 ${entry.label} steps for this goal.`,
      );
      expect(written.summary.details).toContainEqual(
        expect.stringContaining('A worker can edit this checkout.'),
      );
      expect(written.summary.details.join('\n')).not.toContain(`${entry.flow} v0.1.0 closed`);
      expect(written.summary.details.join('\n')).not.toContain('result for');
      expect(written.summary.report_paths.some((report) => report.schema?.endsWith('@v1'))).toBe(
        true,
      );
    }
  });

  it('renders Fix outcomes through friendly phrases instead of leaking the raw "outcome partial" enum into the headline', () => {
    const cases: Array<{
      readonly outcome: string;
      readonly verification: string;
      readonly review: string;
      readonly expectedHeadline: string;
    }> = [
      {
        outcome: 'fixed',
        verification: 'passed',
        review: 'accept',
        expectedHeadline: 'Circuit: Fix complete. Verification: passed. Review: accepted.',
      },
      {
        outcome: 'partial',
        verification: 'passed',
        review: 'accept',
        expectedHeadline:
          'Circuit: Fix applied with follow-ups. Verification: passed. Review: accepted.',
      },
      {
        outcome: 'partial',
        verification: 'passed',
        review: 'accept-with-fixes',
        expectedHeadline:
          'Circuit: Fix applied with follow-ups. Verification: passed. Review: requested follow-up fixes.',
      },
      {
        outcome: 'failed',
        verification: 'failed',
        review: 'accept-with-fixes',
        expectedHeadline:
          'Circuit: Fix attempt failed verification. Verification: failed. Review: requested follow-up fixes.',
      },
      {
        outcome: 'not-reproduced',
        verification: 'not-run',
        review: 'accept',
        expectedHeadline:
          'Circuit: Could not reproduce the issue. Verification: not-run. Review: accepted.',
      },
      {
        outcome: 'stopped',
        verification: 'passed',
        review: 'accept',
        expectedHeadline: 'Circuit: Fix stopped. Verification: passed. Review: accepted.',
      },
      {
        outcome: 'handoff',
        verification: 'not-run',
        review: 'accept',
        expectedHeadline: 'Circuit: Fix handed off. Verification: not-run. Review: accepted.',
      },
    ];

    for (const entry of cases) {
      writeReport('reports/fix-result.json', {
        summary: 'Fix bug: patched change',
        outcome: entry.outcome,
        verification_status: entry.verification,
        review_verdict: entry.review,
        evidence_links: [
          { report_id: 'fix.review', path: 'reports/fix/review.json', schema: 'fix.review@v1' },
        ],
      });

      const written = writeOperatorSummary({
        runFolder,
        runResult: baseResult('fix'),
        route: { selectedFlow: 'fix' },
      });

      expect(written.summary.headline).toBe(entry.expectedHeadline);
      // Verbatim guard against the original F-M-2 wording. If this string
      // ever reappears in the headline, the regression has returned.
      expect(written.summary.headline).not.toContain('outcome partial');
      expect(written.summary.headline).not.toMatch(/Fix finished with outcome/);
    }
  });

  it('falls back to the run-level outcome when the flow-result file is missing instead of silently rendering complete', () => {
    // No reports/build-result.json on disk — simulates the legacy @stop
    // path where close-step never ran. Without the runOutcome fallback,
    // the projector would default outcome to 'complete' and contradict
    // result.json's stopped outcome.
    const stoppedResult = RunResult.parse({
      schema_version: 1,
      run_id: '87000000-0000-0000-0000-000000000007',
      flow_id: 'build',
      goal: 'run build',
      outcome: 'stopped',
      summary: 'build v0.1.0 closed 3 step(s) for goal "run build".',
      closed_at: '2026-04-28T12:00:00.000Z',
      trace_entries_observed: 3,
      manifest_hash: 'abc123',
    });

    const written = writeOperatorSummary({
      runFolder,
      runResult: stoppedResult,
      route: { selectedFlow: 'build' },
    });

    expect(written.summary.headline).toBe(
      'Circuit: Build finished with outcome stopped. Verification: unknown. Review: unknown.',
    );
  });

  it('renders Explore summaries as concise operator guidance', () => {
    writeReport('reports/explore-result.json', {
      summary:
        "Explore 'internal evals': Build a private eval suite around product-specific failure modes. Concretely: (1) Seam-fit eval — trace schema changes before authoring. (2) Operator-prose eval — score final summaries for clarity. Before building, the proof needed is: (a) inspect src/ and tests/ for an existing eval harness; (b) confirm the saved run corpus. Recommend starting with the operator-prose eval.",
      verdict_snapshot: {
        compose_verdict: 'accept',
        review_verdict: 'accept-with-fold-ins',
        objection_count: 1,
        missed_angle_count: 1,
      },
      review_fold_ins: {
        overall_assessment: 'Good enough to use, but it needs one proof callout.',
        objections: ['Clarify whether host output was inspected directly.'],
        missed_angles: ['Check the operator summary markdown, not only the JSON report.'],
      },
      evidence_links: [],
    });

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('explore'),
      route: { selectedFlow: 'explore' },
    });

    expect(written.summary.headline).toBe(
      'Circuit: Recommendation accepted, with required fold-ins to address.',
    );
    expect(written.summary.details).toEqual([
      'Recommendation: Build a private eval suite around product-specific failure modes: Seam-fit eval; Operator-prose eval.',
      'Before building: inspect src/ and tests/ for an existing eval harness; confirm the saved run corpus.',
      'Start with: the operator-prose eval.',
      'Reviewer: Accepted the direction, with required fold-ins.',
      'Required fold-in: Clarify whether host output was inspected directly.',
      'Consider: Check the operator summary markdown, not only the JSON report.',
    ]);
    const markdown = readFileSync(written.markdownPath, 'utf8');
    expect(markdown).toContain('CIRCUIT\n⎿ Recommendation accepted, with required fold-ins');
    expect(markdown).toContain(
      'Recommendation: Build a private eval suite around product-specific failure modes',
    );
    expect(markdown).toContain('Required fold-in: Clarify whether host output was inspected');
    expect(markdown).toContain('Consider: Check the operator summary markdown');
    expect(markdown).not.toContain('Follow-up:');
    expect(markdown).not.toContain('accept-with-fold-ins');
    expect(markdown).not.toContain('Run folder:');
    expect(markdown).not.toContain('## Reports');
    expect(markdown).not.toContain('Evidence Warnings');
  });

  it('strips the quoted-goal prefix from prose-style Explore recommendations even when the goal spans multiple lines', () => {
    // Regression: Explore writers emit `Explore '<brief.subject>': <recommendation>`,
    // and the brief subject is the operator's verbatim multi-line prompt. When
    // the recommendation is single-paragraph prose (no numbered-label list) and
    // the goal contains newlines or embedded colons, the previous single-line
    // `^Explore .+?:\s*` strip pattern silently failed to match, and the
    // first-sentence fallback then emitted a literal "Recommendation: Explore
    // '<goal text>" line into the operator summary.
    const multiLineGoal = [
      'Review the current working tree for generated-surface drift risks.',
      '',
      'Do not edit files.',
      '',
      'Focus on whether the current changes keep these surfaces consistent:',
      '',
      '- source flow files',
      '- generated flow output',
      '',
      'Use this severity shape:',
      '- High: a generated surface or runtime bundle is stale.',
    ].join('\n');
    writeReport('reports/explore-result.json', {
      summary: `Explore '${multiLineGoal}': No generated-surface drift detected. The only source code change in the working tree is src/flows/explore/relay-hints.ts. All verification checks pass.`,
      verdict_snapshot: {
        compose_verdict: 'accept',
        review_verdict: 'accept-with-fold-ins',
        objection_count: 1,
        missed_angle_count: 0,
      },
      review_fold_ins: {
        overall_assessment: 'Direction is useful but missing concrete evidence.',
        objections: ['Evidence citations lack actual command outputs.'],
        missed_angles: [],
      },
      evidence_links: [],
    });

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('explore'),
      route: { selectedFlow: 'explore' },
    });

    const recommendation = written.summary.details.find((detail) =>
      detail.startsWith('Recommendation:'),
    );
    expect(recommendation).toBe('Recommendation: No generated-surface drift detected.');
    expect(recommendation).not.toContain('Explore ');
    expect(recommendation).not.toContain('Review the current working tree');
    expect(written.summary.details).toContain(
      'Required fold-in: Evidence citations lack actual command outputs.',
    );
    const markdown = readFileSync(written.markdownPath, 'utf8');
    expect(markdown).not.toContain("Recommendation: Explore '");
    expect(markdown).not.toContain('Review the current working tree for generated-surface');
  });

  it('does not splice numbered back-references like "(1), (4), and (5)" into the recommendation label list', () => {
    // Regression for cee25546: a compose summary that listed seven
    // numbered options and then referred back to "Of these, (1), (4),
    // and (5) likely return..." caused numberedRecommendationLabels to
    // capture the back-reference as a giant 8th label, producing a
    // malformed duplicate fragment in operator-summary.md.
    writeReport('reports/explore-result.json', {
      summary:
        "Explore 'eval menu': The highest-leverage internal eval categories are: (1) Verdict-correctness evals — seed runs with planted defects. (2) Operator-summary evals — score plain-language. (3) Cross-adapter equivalence evals — diff agent vs codex outputs. (4) Schema-conformance evals — validate report bodies. (5) Adversarial-review catch-rate evals — track defect catches. Of these, (1), (4), and (5) likely return the most signal for the least build cost. Before committing build effort, the next concrete proof needed is to inspect existing evals/ for prior art.",
      verdict_snapshot: {
        compose_verdict: 'accept',
        review_verdict: 'accept-with-fold-ins',
        objection_count: 0,
        missed_angle_count: 0,
      },
      review_fold_ins: {
        overall_assessment: 'Direction is useful.',
        objections: [],
        missed_angles: [],
      },
      evidence_links: [],
    });

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('explore'),
      route: { selectedFlow: 'explore' },
    });

    const recommendation = written.summary.details.find((detail) =>
      detail.startsWith('Recommendation:'),
    );
    expect(recommendation).toBeDefined();
    expect(recommendation).not.toContain(', (4), and (5) likely return');
    expect(recommendation).not.toContain('the next concrete proof needed is');
    expect(recommendation).toContain('Verdict-correctness evals');
    expect(recommendation).toContain('Adversarial-review catch-rate evals');
    expect(recommendation).not.toMatch(/(Verdict-correctness evals.*){2}/s);
  });

  it('summarizes Explore tournament decisions with selected option, rationale, risks, and next action', () => {
    writeReport('reports/decision.json', {
      verdict: 'decided',
      decision_question: 'Which frontend framework should the project use?',
      selected_option_id: 'option-2',
      selected_option_label: 'Vue',
      decision: 'Choose Vue for a smaller surface and faster product iteration.',
      rationale: 'Vue gives this team the fastest path to a polished prototype.',
      rejected_options: [{ option_id: 'option-1', reason: 'React was safer but slower here.' }],
      evidence_links: [
        'reports/decision-options.json',
        'reports/tournament-aggregate.json',
        'reports/tournament-review.json',
        'reports/checkpoints/tradeoff-response.json',
      ],
      assumptions: ['The team is comfortable learning Vue quickly.'],
      residual_risks: ['Hiring familiarity may be thinner.'],
      next_action: 'Run a Build plan for a Vue prototype.',
      follow_up_workflow: 'Build',
    });
    writeReport('reports/explore-result.json', {
      summary: "Explore 'decide: React vs Vue': Choose Vue for a smaller surface.",
      verdict_snapshot: {
        decision_verdict: 'decided',
        tournament_review_verdict: 'recommend',
        selected_option_id: 'option-2',
        objection_count: 1,
        missing_evidence_count: 1,
      },
      evidence_links: [
        { report_id: 'explore.brief', path: 'reports/brief.json', schema: 'explore.brief@v1' },
        {
          report_id: 'explore.analysis',
          path: 'reports/analysis.json',
          schema: 'explore.analysis@v1',
        },
        {
          report_id: 'explore.decision-options',
          path: 'reports/decision-options.json',
          schema: 'explore.decision-options@v1',
        },
        {
          report_id: 'explore.tournament-aggregate',
          path: 'reports/tournament-aggregate.json',
          schema: 'explore.tournament-aggregate@v1',
        },
        {
          report_id: 'explore.tournament-review',
          path: 'reports/tournament-review.json',
          schema: 'explore.tournament-review@v1',
        },
        {
          report_id: 'explore.decision',
          path: 'reports/decision.json',
          schema: 'explore.decision@v1',
        },
      ],
    });

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('explore'),
      route: { selectedFlow: 'explore' },
    });

    expect(written.summary.headline).toBe(
      'Circuit: Decision made. Selected: Vue. Choose Vue for a smaller surface and faster product iteration.',
    );
    expect(written.summary.details).toContain(
      'Decision question: Which frontend framework should the project use?',
    );
    expect(written.summary.details).toContain(
      'Rationale: Vue gives this team the fastest path to a polished prototype.',
    );
    expect(written.summary.details).toContain('Residual risks: Hiring familiarity may be thinner.');
    expect(written.summary.details).toContain('Next action: Run a Build plan for a Vue prototype.');
  });

  it('emits operator-summary.html for Explore tournament runs with recommended highlight and XSS escaping', () => {
    writeHighestScoreAutoResolution();
    writeReport('reports/decision-options.json', {
      decision_question: 'Which framework <should> we pick?',
      recommendation_basis: 'tournament-aggregate@v1 + tournament-review@v1',
      options: [
        {
          id: 'option-1',
          label: 'React',
          summary: 'Mature, large community.',
          best_case_prompt: 'Bootstrap a React prototype with the design system in src/ui.',
          evidence_refs: ['reports/analysis.json#aspect-react'],
          tradeoffs: ['Larger surface area', 'Slower iteration'],
        },
        {
          id: 'option-2',
          label: 'Vue <script>alert(1)</script>',
          summary: 'Smaller surface, faster iteration.',
          best_case_prompt: 'Bootstrap a Vue prototype starting from src/ui/main.ts.',
          evidence_refs: ['reports/analysis.json#aspect-vue'],
          tradeoffs: ['Thinner hiring pool', 'Less ecosystem'],
        },
      ],
    });
    writeReport('reports/tournament-review.json', {
      verdict: 'recommend',
      recommended_option_id: 'option-2',
      comparison: 'Vue wins on iteration speed; React wins on hiring familiarity.',
      objections: ['Vue ecosystem is thinner.'],
      missing_evidence: ['No data on team Vue experience.'],
      tradeoff_question: 'Are we optimizing for speed-to-prototype or long-term hiring?',
      confidence: 'high',
    });
    writeReport('reports/decision.json', {
      verdict: 'decided',
      decision_question: 'Which framework <should> we pick?',
      selected_option_id: 'option-2',
      selected_option_label: 'Vue',
      decision: 'Choose Vue for a smaller surface and faster product iteration.',
      rationale: 'Vue gives this team the fastest path to a polished prototype.',
      rejected_options: [{ option_id: 'option-1', reason: 'Slower for this team.' }],
      evidence_links: ['reports/decision-options.json'],
      assumptions: ['Team can learn Vue quickly.'],
      residual_risks: ['Hiring familiarity may be thinner.'],
      next_action: 'Run a Build plan for a Vue prototype.',
      follow_up_workflow: 'Build',
    });
    writeReport('reports/explore-result.json', {
      summary: "Explore 'pick framework': Choose Vue.",
      verdict_snapshot: {
        decision_verdict: 'decided',
        tournament_review_verdict: 'recommend',
        selected_option_id: 'option-2',
        objection_count: 1,
        missing_evidence_count: 1,
      },
      evidence_links: [
        { report_id: 'explore.brief', path: 'reports/brief.json', schema: 'explore.brief@v1' },
        {
          report_id: 'explore.analysis',
          path: 'reports/analysis.json',
          schema: 'explore.analysis@v1',
        },
        {
          report_id: 'explore.decision-options',
          path: 'reports/decision-options.json',
          schema: 'explore.decision-options@v1',
        },
        {
          report_id: 'explore.tournament-aggregate',
          path: 'reports/tournament-aggregate.json',
          schema: 'explore.tournament-aggregate@v1',
        },
        {
          report_id: 'explore.tournament-review',
          path: 'reports/tournament-review.json',
          schema: 'explore.tournament-review@v1',
        },
        {
          report_id: 'explore.decision',
          path: 'reports/decision.json',
          schema: 'explore.decision@v1',
        },
      ],
    });

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('explore'),
      route: { selectedFlow: 'explore' },
    });

    expect(written.htmlPath).toBeDefined();
    expect(existsSync(written.htmlPath as string)).toBe(true);
    expect(written.summary.report_paths.map((report) => report.label)).toContain(
      'Operator summary (HTML)',
    );
    expect(written.summary.auto_resolutions).toHaveLength(1);
    expect(written.summary.auto_resolutions?.[0]).toMatchObject({
      checkpoint_id: 'tradeoff-checkpoint-step',
      policy: 'highest-score',
      resolved_value: 'option-2',
      winning_score: 1,
      runner_up_score: 0.875,
      margin: 0.125,
      tie_break: 'aggregate_score',
    });
    const [autoResolution] = written.summary.auto_resolutions ?? [];
    if (autoResolution === undefined || autoResolution.rubric_results === undefined) {
      throw new Error('expected auto-resolution rubric results');
    }
    expect(autoResolution.rubric_results['option-2']?.aggregate_score).toBe(1);

    const html = readFileSync(written.htmlPath as string, 'utf8');
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Which framework &lt;should&gt; we pick?');
    expect(html).toContain('class="card intent-positive"');
    expect(html).toContain('<span class="intent-badge intent-positive">Selected</span>');
    expect(html).toContain('Vue &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('high confidence');
    expect(html).toContain('Auto-resolutions');
    expect(html).toContain('option-2 selected by policy');
    expect(html).toContain('margin +0.125 over runner-up');

    const markdown = readFileSync(written.markdownPath, 'utf8');
    expect(markdown).toContain(`Rich summary: ${written.htmlPath as string}`);
    expect(markdown).toContain('Auto-resolutions');
    expect(markdown).toContain(
      'Decision - tradeoff checkpoint: option-2 selected by policy `highest-score`',
    );
  });

  it('emits operator-summary.html for Build waiting checkpoints and links it from JSON and Markdown', () => {
    writeReport('reports/build/brief.json', buildBrief());
    const requestPath = join(runFolder, 'reports/checkpoints/frame-step-request.json');
    writeReport('reports/checkpoints/frame-step-request.json', {
      schema_version: 1,
      step_id: 'frame-step',
      prompt: 'Confirm the Build brief before implementation starts.',
      allowed_choices: ['continue'],
    });

    const written = writeOperatorSummary({
      runFolder,
      runResult: {
        schema_version: 1,
        run_id: RunId.parse('87000000-0000-0000-0000-000000000008'),
        flow_id: CompiledFlowId.parse('build'),
        goal: 'Add checkpoint HTML',
        outcome: 'checkpoint_waiting',
        summary: "checkpoint 'frame-step' is waiting for an operator choice.",
        trace_entries_observed: 3,
        manifest_hash: 'abc123',
        checkpoint: {
          step_id: 'frame-step',
          request_path: requestPath,
          allowed_choices: ['continue'],
        },
      },
      route: { selectedFlow: 'build' },
    });

    expect(written.htmlPath).toBe(join(runFolder, 'reports', 'operator-summary.html'));
    expect(existsSync(written.htmlPath as string)).toBe(true);
    expect(written.summary.html_path).toBe(written.htmlPath);
    expect(written.summary.report_paths.map((report) => report.label)).toEqual([
      'Operator summary (HTML)',
      'Checkpoint request',
    ]);
    expect(written.summary.checkpoint).toEqual({
      step_id: 'frame-step',
      request_path: requestPath,
      allowed_choices: ['continue'],
    });

    const html = readFileSync(written.htmlPath as string, 'utf8');
    expect(html).toContain('Add checkpoint HTML');
    expect(html).toContain('The scope is bounded and the proof plan is explicit.');
    expect(html).toContain('Touch Build checkpoint presentation only');
    expect(html).toContain('Copy resume command');

    const markdown = readFileSync(written.markdownPath, 'utf8');
    expect(markdown).toContain(`Rich summary: ${written.htmlPath as string}`);
    expect(markdown).toContain('Choices: continue');
  });

  it('removes stale Build checkpoint HTML when the waiting packet is malformed', () => {
    const stalePath = join(runFolder, 'reports', 'operator-summary.html');
    writeFileSync(stalePath, '<!doctype html><body>stale build checkpoint</body>');
    const malformed = { ...buildBrief(), checkpoint_packet: undefined };
    writeReport('reports/build/brief.json', malformed);
    const requestPath = join(runFolder, 'reports/checkpoints/frame-step-request.json');

    const written = writeOperatorSummary({
      runFolder,
      runResult: {
        schema_version: 1,
        run_id: RunId.parse('87000000-0000-0000-0000-000000000009'),
        flow_id: CompiledFlowId.parse('build'),
        goal: 'Add checkpoint HTML',
        outcome: 'checkpoint_waiting',
        summary: "checkpoint 'frame-step' is waiting for an operator choice.",
        trace_entries_observed: 3,
        manifest_hash: 'abc123',
        checkpoint: {
          step_id: 'frame-step',
          request_path: requestPath,
          allowed_choices: ['continue'],
        },
      },
      route: { selectedFlow: 'build' },
    });

    expect(written.htmlPath).toBeUndefined();
    expect(existsSync(stalePath)).toBe(false);
    expect(written.summary.report_paths.map((report) => report.label)).not.toContain(
      'Operator summary (HTML)',
    );
  });

  it('emits operator-summary.html for Prototype waiting checkpoints and links it from JSON and Markdown', () => {
    writeReport('reports/prototype/brief.json', prototypeBrief());
    writeReport('reports/prototype/plan.json', prototypePlan());
    writeReport('reports/prototype/artifact.json', prototypeArtifact());
    writeReport('reports/prototype/verification.json', prototypeVerification());
    const requestPath = join(runFolder, 'reports/checkpoints/prototype-review-request.json');
    writeReport('reports/checkpoints/prototype-review-request.json', {
      schema_version: 1,
      step_id: 'prototype-checkpoint-step',
      prompt: 'Decide what to do with this verified Prototype artifact.',
      allowed_choices: ['keep-prototype', 'save-build-input', 'discard-prototype'],
    });

    const written = writeOperatorSummary({
      runFolder,
      runResult: {
        schema_version: 1,
        run_id: RunId.parse('87000000-0000-0000-0000-000000000018'),
        flow_id: CompiledFlowId.parse('prototype'),
        goal: 'prototype: sketch a custom flow builder UI',
        outcome: 'checkpoint_waiting',
        summary: "checkpoint 'prototype-checkpoint-step' is waiting for an operator choice.",
        trace_entries_observed: 5,
        manifest_hash: 'abc123',
        checkpoint: {
          step_id: 'prototype-checkpoint-step',
          request_path: requestPath,
          allowed_choices: ['keep-prototype', 'save-build-input', 'discard-prototype'],
        },
      },
      route: { selectedFlow: 'prototype' },
    });

    expect(written.htmlPath).toBe(join(runFolder, 'reports', 'operator-summary.html'));
    expect(existsSync(written.htmlPath as string)).toBe(true);
    expect(written.summary.html_path).toBe(written.htmlPath);
    expect(written.summary.report_paths.map((report) => report.label)).toEqual([
      'Operator summary (HTML)',
      'Checkpoint request',
    ]);

    const html = readFileSync(written.htmlPath as string, 'utf8');
    expect(html).toContain('Custom flow builder');
    expect(html).toContain('Verified local artifact');
    expect(html).toContain('Keep Prototype');
    expect(html).toContain('Save Build Input');
    expect(html).toContain('Discard Prototype');
    expect(html).toContain(`${PROTOTYPE_ROOT}/index.html`);
    expect(html).toContain('not production');
    expect(html).toContain('not deployed');

    const markdown = readFileSync(written.markdownPath, 'utf8');
    expect(markdown).toContain(`Rich summary: ${written.htmlPath as string}`);
    expect(markdown).toContain('Choices: keep-prototype, save-build-input, discard-prototype');
  });

  it('emits pinned-preview HTML for Prototype visual variant checkpoints through operator summary', () => {
    writePrototypeVariantReports();
    const requestPath = join(
      runFolder,
      'reports/checkpoints/prototype-variant-choice-request.json',
    );
    writeReport('reports/checkpoints/prototype-variant-choice-request.json', {
      schema_version: 1,
      step_id: 'prototype-variant-checkpoint-step',
      prompt: 'Choose a prototype variant.',
      allowed_choices: ['variant-a', 'variant-b'],
    });

    const written = writeOperatorSummary({
      runFolder,
      runResult: {
        schema_version: 1,
        run_id: RunId.parse('87000000-0000-0000-0000-000000000020'),
        flow_id: CompiledFlowId.parse('prototype'),
        goal: 'prototype: tournament custom flow builder UI',
        outcome: 'checkpoint_waiting',
        summary:
          "checkpoint 'prototype-variant-checkpoint-step' is waiting for an operator choice.",
        trace_entries_observed: 12,
        manifest_hash: 'abc123',
        checkpoint: {
          step_id: 'prototype-variant-checkpoint-step',
          request_path: requestPath,
          allowed_choices: ['variant-a', 'variant-b'],
        },
      },
      route: { selectedFlow: 'prototype' },
    });

    expect(written.htmlPath).toBe(join(runFolder, 'reports', 'operator-summary.html'));
    expect(written.summary.html_path).toBe(written.htmlPath);
    expect(written.summary.report_paths.map((report) => report.label)).toEqual([
      'Operator summary (HTML)',
      'Checkpoint request',
    ]);

    const html = readFileSync(written.htmlPath as string, 'utf8');
    expect(html).toContain('mv-wrap mv-visual');
    expect(html).toContain('Selected variant preview');
    expect(html).toContain('src="../prototype-files/variants/variant-a/index.html"');
    expect(html).toContain(
      'data-mv-preview-src="../prototype-files/variants/variant-b/index.html"',
    );
    expect(html).toContain('--checkpoint-choice &#39;variant-a&#39;');

    const markdown = readFileSync(written.markdownPath, 'utf8');
    expect(markdown).toContain(`Rich summary: ${written.htmlPath as string}`);
    expect(markdown).toContain('Choices: variant-a, variant-b');
  });

  it('uses the checkpoint execution context to preview project-root Prototype variant artifacts', () => {
    const projectRoot = join(runFolder, '..', 'project-root');
    const prototypeRoot = '.circuit/prototypes/operator-summary-external';
    writePrototypeVariantReports(prototypeRoot);
    const requestPath = join(
      runFolder,
      'reports/checkpoints/prototype-variant-choice-request.json',
    );
    writeReport('reports/checkpoints/prototype-variant-choice-request.json', {
      schema_version: 1,
      step_id: 'prototype-variant-checkpoint-step',
      prompt: 'Choose a prototype variant.',
      allowed_choices: ['variant-a', 'variant-b'],
      execution_context: { project_root: projectRoot },
    });

    const written = writeOperatorSummary({
      runFolder,
      runResult: {
        schema_version: 1,
        run_id: RunId.parse('87000000-0000-0000-0000-000000000021'),
        flow_id: CompiledFlowId.parse('prototype'),
        goal: 'prototype: tournament custom flow builder UI',
        outcome: 'checkpoint_waiting',
        summary:
          "checkpoint 'prototype-variant-checkpoint-step' is waiting for an operator choice.",
        trace_entries_observed: 12,
        manifest_hash: 'abc123',
        checkpoint: {
          step_id: 'prototype-variant-checkpoint-step',
          request_path: requestPath,
          allowed_choices: ['variant-a', 'variant-b'],
        },
      },
      route: { selectedFlow: 'prototype' },
    });

    const html = readFileSync(written.htmlPath as string, 'utf8');
    const expectedHref = pathToFileURL(
      join(projectRoot, prototypeRoot, 'variants', 'variant-a', 'index.html'),
    ).href;
    expect(html).toContain('mv-wrap mv-visual');
    expect(html).toContain(`src="${expectedHref}"`);
  });

  it('removes stale Prototype checkpoint HTML when typed reports are malformed', () => {
    const stalePath = join(runFolder, 'reports', 'operator-summary.html');
    writeFileSync(stalePath, '<!doctype html><body>stale prototype checkpoint</body>');
    writeReport('reports/prototype/brief.json', prototypeBrief());
    writeReport('reports/prototype/plan.json', prototypePlan());
    writeReport('reports/prototype/artifact.json', {
      ...prototypeArtifact(),
      entry_points: ['src/outside.html'],
    });
    writeReport('reports/prototype/verification.json', prototypeVerification());
    const requestPath = join(runFolder, 'reports/checkpoints/prototype-review-request.json');

    const written = writeOperatorSummary({
      runFolder,
      runResult: {
        schema_version: 1,
        run_id: RunId.parse('87000000-0000-0000-0000-000000000019'),
        flow_id: CompiledFlowId.parse('prototype'),
        goal: 'prototype: sketch a custom flow builder UI',
        outcome: 'checkpoint_waiting',
        summary: "checkpoint 'prototype-checkpoint-step' is waiting for an operator choice.",
        trace_entries_observed: 5,
        manifest_hash: 'abc123',
        checkpoint: {
          step_id: 'prototype-checkpoint-step',
          request_path: requestPath,
          allowed_choices: ['keep-prototype'],
        },
      },
      route: { selectedFlow: 'prototype' },
    });

    expect(written.htmlPath).toBeUndefined();
    expect(existsSync(stalePath)).toBe(false);
    expect(written.summary.report_paths.map((report) => report.label)).not.toContain(
      'Operator summary (HTML)',
    );
  });

  it('skips HTML emission when tournament-review.json is malformed', () => {
    writeReport('reports/decision-options.json', {
      decision_question: 'Which framework should we pick?',
      recommendation_basis: 'tournament-aggregate@v1 + tournament-review@v1',
      options: [
        {
          id: 'option-1',
          label: 'React',
          summary: 'Mature.',
          best_case_prompt: 'Bootstrap React.',
          evidence_refs: ['reports/analysis.json#aspect-react'],
          tradeoffs: ['Larger surface'],
        },
        {
          id: 'option-2',
          label: 'Vue',
          summary: 'Smaller.',
          best_case_prompt: 'Bootstrap Vue.',
          evidence_refs: ['reports/analysis.json#aspect-vue'],
          tradeoffs: ['Thinner ecosystem'],
        },
      ],
    });
    // Missing required fields (no `verdict`, `recommended_option_id`, etc.) — Zod parse should fail.
    writeReport('reports/tournament-review.json', { verdict: 'recommend' });
    writeReport('reports/decision.json', {
      verdict: 'decided',
      decision_question: 'Which framework should we pick?',
      selected_option_id: 'option-2',
      selected_option_label: 'Vue',
      decision: 'Choose Vue.',
      rationale: 'Faster path.',
      rejected_options: [{ option_id: 'option-1', reason: 'Slower.' }],
      evidence_links: ['reports/decision-options.json'],
      assumptions: ['Team can learn Vue.'],
      residual_risks: ['Hiring familiarity may be thinner.'],
      next_action: 'Run a Build plan.',
      follow_up_workflow: 'Build',
    });
    writeReport('reports/explore-result.json', {
      summary: "Explore 'pick framework': Choose Vue.",
      verdict_snapshot: {
        decision_verdict: 'decided',
        tournament_review_verdict: 'recommend',
        selected_option_id: 'option-2',
        objection_count: 0,
        missing_evidence_count: 0,
      },
      evidence_links: [
        {
          report_id: 'explore.decision-options',
          path: 'reports/decision-options.json',
          schema: 'explore.decision-options@v1',
        },
        {
          report_id: 'explore.tournament-review',
          path: 'reports/tournament-review.json',
          schema: 'explore.tournament-review@v1',
        },
        {
          report_id: 'explore.decision',
          path: 'reports/decision.json',
          schema: 'explore.decision@v1',
        },
      ],
    });

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('explore'),
      route: { selectedFlow: 'explore' },
    });

    expect(written.htmlPath).toBeUndefined();
    expect(written.summary.report_paths.map((report) => report.label)).not.toContain(
      'Operator summary (HTML)',
    );
    const markdown = readFileSync(written.markdownPath, 'utf8');
    expect(markdown).not.toContain('Rich summary:');
    expect(existsSync(join(runFolder, 'reports', 'operator-summary.html'))).toBe(false);
  });

  it('skips HTML emission when verdict_snapshot.decision_verdict is not "decided"', () => {
    // Pre-decision state (e.g. a checkpoint_waiting close that set
    // selected_option_id but has not yet finalized the decision) must
    // NOT produce an HTML surface. Operator deserves a surface that
    // matches actual run state, not a partial one.
    writeReport('reports/decision-options.json', {
      decision_question: 'Which framework should we pick?',
      recommendation_basis: 'tournament-aggregate@v1 + tournament-review@v1',
      options: [
        {
          id: 'option-1',
          label: 'React',
          summary: 'Mature.',
          best_case_prompt: 'Bootstrap React.',
          evidence_refs: ['reports/analysis.json#aspect-react'],
          tradeoffs: ['Larger surface'],
        },
        {
          id: 'option-2',
          label: 'Vue',
          summary: 'Smaller.',
          best_case_prompt: 'Bootstrap Vue.',
          evidence_refs: ['reports/analysis.json#aspect-vue'],
          tradeoffs: ['Thinner ecosystem'],
        },
      ],
    });
    writeReport('reports/tournament-review.json', {
      verdict: 'recommend',
      recommended_option_id: 'option-2',
      comparison: 'Vue wins on iteration speed.',
      objections: [],
      missing_evidence: [],
      tradeoff_question: 'Speed vs hiring?',
      confidence: 'high',
    });
    writeReport('reports/explore-result.json', {
      summary: "Explore 'pick framework': Vue is recommended.",
      // No decision_verdict — recommendation is in but operator has not decided.
      verdict_snapshot: {
        tournament_review_verdict: 'recommend',
        selected_option_id: 'option-2',
        objection_count: 0,
        missing_evidence_count: 0,
      },
      evidence_links: [
        {
          report_id: 'explore.decision-options',
          path: 'reports/decision-options.json',
          schema: 'explore.decision-options@v1',
        },
        {
          report_id: 'explore.tournament-review',
          path: 'reports/tournament-review.json',
          schema: 'explore.tournament-review@v1',
        },
      ],
    });

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('explore'),
      route: { selectedFlow: 'explore' },
    });

    expect(written.htmlPath).toBeUndefined();
    expect(existsSync(join(runFolder, 'reports', 'operator-summary.html'))).toBe(false);
    expect(written.summary.report_paths.map((report) => report.label)).not.toContain(
      'Operator summary (HTML)',
    );
  });

  it('degrades to markdown-only when HTML write fails (does not promise a missing file)', () => {
    writeReport('reports/decision-options.json', {
      decision_question: 'Which framework should we pick?',
      recommendation_basis: 'tournament-aggregate@v1 + tournament-review@v1',
      options: [
        {
          id: 'option-1',
          label: 'React',
          summary: 'Mature.',
          best_case_prompt: 'Bootstrap React.',
          evidence_refs: ['reports/analysis.json#aspect-react'],
          tradeoffs: ['Larger surface'],
        },
        {
          id: 'option-2',
          label: 'Vue',
          summary: 'Smaller.',
          best_case_prompt: 'Bootstrap Vue.',
          evidence_refs: ['reports/analysis.json#aspect-vue'],
          tradeoffs: ['Thinner ecosystem'],
        },
      ],
    });
    writeReport('reports/tournament-review.json', {
      verdict: 'recommend',
      recommended_option_id: 'option-2',
      comparison: 'Vue wins.',
      objections: [],
      missing_evidence: [],
      tradeoff_question: 'Speed vs hiring?',
      confidence: 'high',
    });
    writeReport('reports/decision.json', {
      verdict: 'decided',
      decision_question: 'Which framework should we pick?',
      selected_option_id: 'option-2',
      selected_option_label: 'Vue',
      decision: 'Choose Vue.',
      rationale: 'Faster path.',
      rejected_options: [{ option_id: 'option-1', reason: 'Slower.' }],
      evidence_links: ['reports/decision-options.json'],
      assumptions: ['Team can learn Vue.'],
      residual_risks: ['Hiring familiarity may be thinner.'],
      next_action: 'Run a Build plan.',
      follow_up_workflow: 'Build',
    });
    writeReport('reports/explore-result.json', {
      summary: "Explore 'pick framework': Vue.",
      verdict_snapshot: {
        decision_verdict: 'decided',
        tournament_review_verdict: 'recommend',
        selected_option_id: 'option-2',
        objection_count: 0,
        missing_evidence_count: 0,
      },
      evidence_links: [
        {
          report_id: 'explore.decision-options',
          path: 'reports/decision-options.json',
          schema: 'explore.decision-options@v1',
        },
        {
          report_id: 'explore.tournament-review',
          path: 'reports/tournament-review.json',
          schema: 'explore.tournament-review@v1',
        },
        {
          report_id: 'explore.decision',
          path: 'reports/decision.json',
          schema: 'explore.decision@v1',
        },
      ],
    });
    // Force HTML write to fail by occupying the target path with a directory.
    mkdirSync(join(runFolder, 'reports', 'operator-summary.html'), { recursive: true });

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('explore'),
      route: { selectedFlow: 'explore' },
    });

    expect(written.htmlPath).toBeUndefined();
    expect(written.summary.report_paths.map((report) => report.label)).not.toContain(
      'Operator summary (HTML)',
    );
    expect(existsSync(written.jsonPath)).toBe(true);
    expect(existsSync(written.markdownPath)).toBe(true);
    const markdown = readFileSync(written.markdownPath, 'utf8');
    expect(markdown).not.toContain('Rich summary:');
    // Operator must see a signal that HTML was attempted and failed; otherwise
    // a transient disk problem looks indistinguishable from "this flow does
    // not produce HTML."
    expect(written.summary.evidence_warnings).toContainEqual(
      expect.objectContaining({ kind: 'html_write_failed' }),
    );
    expect(markdown).toContain('html_write_failed');
    // The pre-existing directory at the target path was cleaned up so the
    // envelope can never claim a path that does not point at a valid file.
    expect(existsSync(join(runFolder, 'reports', 'operator-summary.html'))).toBe(false);
  });

  it('removes a stale HTML file when a re-run no longer produces a typed payload', () => {
    // Simulate: an earlier successful tournament emitted operator-summary.html
    // in this run folder. A subsequent rewrite (e.g. resume into a non-decided
    // state) must NOT leave the prior HTML on disk — operators may have
    // bookmarked or scrolled to that path and would otherwise open stale data.
    const stalePath = join(runFolder, 'reports', 'operator-summary.html');
    writeFileSync(stalePath, '<!doctype html><body>stale tournament summary</body>');

    writeReport('reports/explore-result.json', {
      summary: "Explore 'compose path': recommendation ready.",
      verdict_snapshot: {
        compose_verdict: 'ready',
        review_verdict: 'accept',
        objection_count: 0,
        missed_angle_count: 0,
      },
      evidence_links: [],
    });

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('explore'),
      route: { selectedFlow: 'explore' },
    });

    expect(written.htmlPath).toBeUndefined();
    expect(existsSync(stalePath)).toBe(false);
  });

  it('does not abort the close when an evidence_link path is malformed', () => {
    // Regression: evidence_links[].path is not Zod-validated. A malformed
    // path (traversal, absolute, symlinked) used to throw inside
    // resolveRunRelative and abort the entire run close after JSON+MD had
    // already been written elsewhere. The writer must degrade silently.
    writeReport('reports/decision-options.json', {
      decision_question: 'Pick one.',
      recommendation_basis: 'tournament-aggregate@v1 + tournament-review@v1',
      options: [
        {
          id: 'option-1',
          label: 'A',
          summary: 'a',
          best_case_prompt: 'a',
          evidence_refs: ['x'],
          tradeoffs: ['t'],
        },
        {
          id: 'option-2',
          label: 'B',
          summary: 'b',
          best_case_prompt: 'b',
          evidence_refs: ['y'],
          tradeoffs: ['t'],
        },
      ],
    });
    writeReport('reports/explore-result.json', {
      summary: "Explore 'pick': decided.",
      verdict_snapshot: {
        decision_verdict: 'decided',
        tournament_review_verdict: 'recommend',
        selected_option_id: 'option-2',
        objection_count: 0,
        missing_evidence_count: 0,
      },
      evidence_links: [
        {
          report_id: 'explore.decision-options',
          path: '../../etc/passwd',
          schema: 'explore.decision-options@v1',
        },
      ],
    });

    expect(() =>
      writeOperatorSummary({
        runFolder,
        runResult: baseResult('explore'),
        route: { selectedFlow: 'explore' },
      }),
    ).not.toThrow();
  });

  it('strips bidi overrides and C0 controls from option labels in the rendered HTML', () => {
    // Adversarial input: a U+202E (RTL override) in an option label flips
    // the visible order of subsequent text in the operator's browser. The
    // operator could be deceived about which option they are picking.
    const rtlLabel = 'safe‮gnp.exe';
    writeReport('reports/decision-options.json', {
      decision_question: 'Pick one.',
      recommendation_basis: 'tournament-aggregate@v1 + tournament-review@v1',
      options: [
        {
          id: 'option-1',
          label: rtlLabel,
          summary: 'a',
          best_case_prompt: 'a',
          evidence_refs: ['x'],
          tradeoffs: ['t'],
        },
        {
          id: 'option-2',
          label: 'B',
          summary: 'b',
          best_case_prompt: 'b',
          evidence_refs: ['y'],
          tradeoffs: ['t'],
        },
      ],
    });
    writeReport('reports/tournament-review.json', {
      verdict: 'recommend',
      recommended_option_id: 'option-2',
      comparison: 'B wins.',
      objections: [],
      missing_evidence: [],
      tradeoff_question: '?',
      confidence: 'high',
    });
    writeReport('reports/decision.json', {
      verdict: 'decided',
      decision_question: 'Pick one.',
      selected_option_id: 'option-2',
      selected_option_label: 'B',
      decision: 'Choose B.',
      rationale: 'Better.',
      rejected_options: [{ option_id: 'option-1', reason: 'No.' }],
      evidence_links: ['reports/decision-options.json'],
      assumptions: [],
      residual_risks: [],
      next_action: 'Build B.',
      follow_up_workflow: 'Build',
    });
    writeReport('reports/explore-result.json', {
      summary: "Explore 'pick': decided.",
      verdict_snapshot: {
        decision_verdict: 'decided',
        tournament_review_verdict: 'recommend',
        selected_option_id: 'option-2',
        objection_count: 0,
        missing_evidence_count: 0,
      },
      evidence_links: [
        {
          report_id: 'explore.decision-options',
          path: 'reports/decision-options.json',
          schema: 'explore.decision-options@v1',
        },
        {
          report_id: 'explore.tournament-review',
          path: 'reports/tournament-review.json',
          schema: 'explore.tournament-review@v1',
        },
        {
          report_id: 'explore.decision',
          path: 'reports/decision.json',
          schema: 'explore.decision@v1',
        },
      ],
    });

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('explore'),
      route: { selectedFlow: 'explore' },
    });

    expect(written.htmlPath).toBeDefined();
    const html = readFileSync(written.htmlPath as string, 'utf8');
    expect(html).not.toContain('‮');
    // The label is rendered with the override stripped (visible ASCII intact).
    expect(html).toContain('safegnp.exe');
  });

  it('truncates oversized tradeoff bullets so a runaway model output does not produce multi-MB HTML', () => {
    const oversized = 'A'.repeat(8192);
    writeReport('reports/decision-options.json', {
      decision_question: 'Pick.',
      recommendation_basis: 'tournament-aggregate@v1 + tournament-review@v1',
      options: [
        {
          id: 'option-1',
          label: 'A',
          summary: 'a',
          best_case_prompt: 'a',
          evidence_refs: ['x'],
          tradeoffs: [oversized],
        },
        {
          id: 'option-2',
          label: 'B',
          summary: 'b',
          best_case_prompt: 'b',
          evidence_refs: ['y'],
          tradeoffs: ['t'],
        },
      ],
    });
    writeReport('reports/tournament-review.json', {
      verdict: 'recommend',
      recommended_option_id: 'option-2',
      comparison: 'B wins.',
      objections: [],
      missing_evidence: [],
      tradeoff_question: '?',
      confidence: 'high',
    });
    writeReport('reports/decision.json', {
      verdict: 'decided',
      decision_question: 'Pick.',
      selected_option_id: 'option-2',
      selected_option_label: 'B',
      decision: 'Choose B.',
      rationale: 'Better.',
      rejected_options: [{ option_id: 'option-1', reason: 'No.' }],
      evidence_links: ['reports/decision-options.json'],
      assumptions: [],
      residual_risks: [],
      next_action: 'Build B.',
      follow_up_workflow: 'Build',
    });
    writeReport('reports/explore-result.json', {
      summary: "Explore 'pick': decided.",
      verdict_snapshot: {
        decision_verdict: 'decided',
        tournament_review_verdict: 'recommend',
        selected_option_id: 'option-2',
        objection_count: 0,
        missing_evidence_count: 0,
      },
      evidence_links: [
        {
          report_id: 'explore.decision-options',
          path: 'reports/decision-options.json',
          schema: 'explore.decision-options@v1',
        },
        {
          report_id: 'explore.tournament-review',
          path: 'reports/tournament-review.json',
          schema: 'explore.tournament-review@v1',
        },
        {
          report_id: 'explore.decision',
          path: 'reports/decision.json',
          schema: 'explore.decision@v1',
        },
      ],
    });

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('explore'),
      route: { selectedFlow: 'explore' },
    });

    expect(written.htmlPath).toBeDefined();
    const html = readFileSync(written.htmlPath as string, 'utf8');
    // Original tradeoff was 8192 chars; truncate caps at 4096 with ellipsis.
    expect(html).not.toContain(oversized);
    expect(html).toContain('A'.repeat(100));
    expect(html).toContain('…');
  });

  it('readPriorRoute recovers routedBy and routerReason from a previously-written summary', () => {
    writeReport('reports/explore-result.json', {
      summary: "Explore 'compose': ready.",
      verdict_snapshot: {
        compose_verdict: 'ready',
        review_verdict: 'accept',
        objection_count: 0,
        missed_angle_count: 0,
      },
      evidence_links: [],
    });
    writeOperatorSummary({
      runFolder,
      runResult: baseResult('explore'),
      route: {
        selectedFlow: 'explore',
        routedBy: 'classifier',
        routerReason: 'matched explore goal',
      },
    });

    const recovered = readPriorRoute(runFolder);
    expect(recovered.routedBy).toBe('classifier');
    expect(recovered.routerReason).toBe('matched explore goal');
  });

  it('readPriorRoute returns empty when no prior summary exists', () => {
    const recovered = readPriorRoute(runFolder);
    expect(recovered.routedBy).toBeUndefined();
    expect(recovered.routerReason).toBeUndefined();
  });

  it('does not emit HTML for Explore default (compose) path', () => {
    writeReport('reports/explore-result.json', {
      summary: "Explore 'compose path': recommendation ready.",
      verdict_snapshot: {
        compose_verdict: 'ready',
        review_verdict: 'accept',
        objection_count: 0,
        missed_angle_count: 0,
      },
      evidence_links: [
        { report_id: 'explore.brief', path: 'reports/brief.json', schema: 'explore.brief@v1' },
      ],
    });

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('explore'),
      route: { selectedFlow: 'explore' },
    });

    expect(written.htmlPath).toBeUndefined();
    expect(written.summary.report_paths.map((report) => report.label)).not.toContain(
      'Operator summary (HTML)',
    );
    const markdown = readFileSync(written.markdownPath, 'utf8');
    expect(markdown).not.toContain('Rich summary:');
  });

  it('includes abort reasons in aborted summaries', () => {
    const result = RunResult.parse({
      ...baseResult('review'),
      outcome: 'aborted',
      summary: 'review aborted',
      reason: 'relay result failed schema validation',
    });

    const written = writeOperatorSummary({
      runFolder,
      runResult: result,
      route: { selectedFlow: 'review' },
    });

    expect(written.summary.headline).toBe('Circuit: Run aborted.');
    expect(written.summary.details).toContain(
      'Abort reason: relay result failed schema validation',
    );
    expect(readFileSync(written.markdownPath, 'utf8')).toContain(
      'relay result failed schema validation',
    );
  });

  it('surfaces the failure reason and headline for an escalated run', () => {
    const result = RunResult.parse({
      ...baseResult('review'),
      outcome: 'escalated',
      summary: 'review escalated',
      reason: 'recovery exceeded the allowed attempts',
    });

    const written = writeOperatorSummary({
      runFolder,
      runResult: result,
      route: { selectedFlow: 'review' },
    });

    // An escalated run is a failure; it must not read as a neutral/complete
    // per-flow headline, and its reason must be surfaced like an abort.
    expect(written.summary.headline).toBe('Circuit: Run escalated.');
    expect(written.summary.details).toContain(
      'Escalation reason: recovery exceeded the allowed attempts',
    );
    expect(readFileSync(written.markdownPath, 'utf8')).toContain(
      'recovery exceeded the allowed attempts',
    );
  });
});
