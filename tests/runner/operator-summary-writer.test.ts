import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readPriorRoute, writeOperatorSummary } from '../../src/app/operator-summary/writer.js';
import { THREE_AXIS_RUBRIC_TIE_BREAK_ORDER, combineRubricResult } from '../../src/policy/rubric.js';
import { CompiledFlowId, RunId } from '../../src/schemas/ids.js';
import { OperatorSummary } from '../../src/schemas/operator-summary.js';
import { RunResult } from '../../src/schemas/result.js';

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
        routedBy: 'explicit',
        routerReason: 'matched review',
      },
    });

    expect(existsSync(written.jsonPath)).toBe(true);
    expect(existsSync(written.markdownPath)).toBe(true);
    const summary = OperatorSummary.parse(JSON.parse(readFileSync(written.jsonPath, 'utf8')));
    expect(summary.headline).toBe('Circuit · Review');
    expect(summary.status_text).toBe('Review');
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
    expect(markdown).toContain('Circuit · Review');
    expect(markdown).toContain('Untracked evidence: contents included for 1 file');
    expect(markdown).toContain('diff_truncated');
    expect(markdown).not.toContain('CIRCUIT');
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
        'Checked generated docs',
        'Ran npm test',
        'Skipped fifth proof because the digest budget is capped',
      ],
      confidence_limitations: [
        'HEAD~1 history was out of scope for this review.',
        'No untracked content was relayed.',
        'A third reviewer limitation should be visible.',
        'A fourth reviewer limitation should be hidden by the caveat cap.',
      ],
      evidence_summary: {
        kind: 'git-working-tree',
        untracked_content_policy: 'metadata-only',
        untracked_file_count: 0,
        untracked_files_sampled: 0,
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
      route: { selectedFlow: 'review' },
    });

    expect(written.summary.headline).toBe('Circuit · Review');
    expect(written.summary.status_text).toBe('Review');
    expect(written.summary.brief_slots).toEqual({
      headline: 'Circuit · Review',
      assessment:
        'Reviewer inspected the staged diff and the new test fixture; nothing actionable surfaced.',
      key_points: [
        'Read src/example.ts',
        'Replayed the staged diff against tests/example.test.ts',
        'Checked generated docs',
        'Ran npm test',
      ],
      caveats: [
        'HEAD~1 history was out of scope for this review.',
        'No untracked content was relayed.',
        'A third reviewer limitation should be visible.',
      ],
      next_action: 'nothing required.',
    });
    // The bare "Findings: 0" detail is replaced by the reviewer's assessment.
    expect(written.summary.details).not.toContain('Findings: 0');
    expect(written.summary.details).toContain(
      'Assessment: Reviewer inspected the staged diff and the new test fixture; nothing actionable surfaced.',
    );
    expect(written.summary.details).toContain(
      'Reviewer steps: Read src/example.ts; Replayed the staged diff against tests/example.test.ts; Checked generated docs; Ran npm test; Skipped fifth proof because the digest budget is capped',
    );
    expect(written.summary.details).toContain(
      'Confidence limitations: HEAD~1 history was out of scope for this review.; No untracked content was relayed.; A third reviewer limitation should be visible.; A fourth reviewer limitation should be hidden by the caveat cap.',
    );
    const markdown = readFileSync(written.markdownPath, 'utf8');
    expect(written.htmlPath).toBeDefined();
    expect(markdown).toBe(
      [
        'Circuit · Review',
        '',
        'Reviewer inspected the staged diff and the new test fixture; nothing actionable surfaced.',
        '',
        '- Read src/example.ts',
        '- Replayed the staged diff against tests/example.test.ts',
        '- Checked generated docs',
        '- Ran npm test',
        '- Caveat: HEAD~1 history was out of scope for this review.',
        '- Caveat: No untracked content was relayed.',
        '- Caveat: A third reviewer limitation should be visible.',
        '',
        'Next: nothing required.',
        '',
        `Rich summary: ${written.htmlPath as string}`,
        '',
      ].join('\n'),
    );
    expect(markdown).not.toContain('CIRCUIT');
    expect(markdown).not.toContain('Skipped fifth proof');
    expect(markdown).not.toContain('A fourth reviewer limitation');
    expect(markdown).not.toContain('diff_truncated');
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

    expect(written.summary.headline).toBe('Circuit · Review');
    expect(written.summary.status_text).toBe('Review');
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

    expect(written.summary.headline).toBe('Circuit · Explore');
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

    expect(written.summary.headline).toBe('Circuit · Review');
    expect(written.summary.brief_slots?.assessment).toContain(
      'no uncommitted source content to examine',
    );
    expect(written.summary.brief_slots?.assessment).toContain(
      'committed history (HEAD~1) was not part of this',
    );
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

    expect(written.summary.headline).toBe('Circuit · Review');
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
        expected: 'Circuit · Build',
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
        expected: 'Circuit · Build',
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
        expected: 'Circuit · Fix',
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
        expected: 'Circuit · Pursue',
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

  it('does not repeat the Pursue Result summary as a key point (F-L-1)', () => {
    writeReport('reports/pursuit-result.json', {
      summary:
        'Executed both tiny pursuits serially. Pursuit-1 documented add.js; Pursuit-2 ran npm run verify, which succeeded.',
      outcome: 'complete',
      verification_status: 'passed',
      review_verdict: 'clean',
      total_pursuits: 2,
      completed_count: 2,
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
    });

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('pursue'),
      route: { selectedFlow: 'pursue' },
    });

    const slots = written.summary.brief_slots;
    if (slots === undefined) throw new Error('expected brief_slots');
    // The Result summary already fills the assessment slot, so it must not also
    // render as a key point (neither bare nor with the "Result: " prefix).
    expect(slots.key_points).not.toContain(`Result: ${slots.assessment}`);
    for (const point of slots.key_points) {
      expect(point).not.toBe(slots.assessment);
    }
  });

  it('keeps the Review Result summary as a key point when a distinct assessment exists (F-L-1 non-regression)', () => {
    writeReport('reports/review-result.json', {
      summary: 'Reviewed the auth diff; one medium finding.',
      verdict: 'ISSUES_FOUND',
      assessment: 'The token refresh path drops the retry budget on a 401.',
      findings: [{ severity: 'medium', text: 'Retry budget reset on 401', file_refs: ['auth.ts'] }],
      evidence_links: [
        { report_id: 'review.audit', path: 'reports/review/audit.json', schema: 'review.audit@v1' },
      ],
    });

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('review'),
      route: { selectedFlow: 'review' },
    });

    const slots = written.summary.brief_slots;
    if (slots === undefined) throw new Error('expected brief_slots');
    // Review carries both an assessment paragraph and a Result summary; the
    // assessment comes from the paragraph, so the Result line stays a distinct
    // key point and must not be dropped.
    expect(slots.assessment).toContain('token refresh path');
    expect(slots.key_points.some((point) => point.startsWith('Result: '))).toBe(true);
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
        expectedHeadline: 'Circuit · Fix',
      },
      {
        outcome: 'partial',
        verification: 'passed',
        review: 'accept',
        expectedHeadline: 'Circuit · Fix',
      },
      {
        outcome: 'partial',
        verification: 'passed',
        review: 'accept-with-fixes',
        expectedHeadline: 'Circuit · Fix',
      },
      {
        outcome: 'failed',
        verification: 'failed',
        review: 'accept-with-fixes',
        expectedHeadline: 'Circuit · Fix',
      },
      {
        outcome: 'not-reproduced',
        verification: 'not-run',
        review: 'accept',
        expectedHeadline: 'Circuit · Fix',
      },
      {
        outcome: 'stopped',
        verification: 'passed',
        review: 'accept',
        expectedHeadline: 'Circuit · Fix',
      },
      {
        outcome: 'handoff',
        verification: 'not-run',
        review: 'accept',
        expectedHeadline: 'Circuit · Fix',
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

    expect(written.summary.headline).toBe('Circuit · Build');
    expect(written.summary.brief_slots?.assessment).toBe(
      'The flow stopped before complete evidence was produced.',
    );
  });

  it('uses a defined handoff digest shape for run-level handoff outcomes', () => {
    const handoffResult = RunResult.parse({
      ...baseResult('build'),
      outcome: 'handoff',
      summary: 'build prepared a handoff',
      reason: 'operator asked to continue in a fresh session',
    });

    const written = writeOperatorSummary({
      runFolder,
      runResult: handoffResult,
      route: { selectedFlow: 'build' },
    });

    expect(written.summary.headline).toBe('Circuit · Build');
    expect(written.summary.brief_slots).toMatchObject({
      assessment: 'The flow prepared a handoff instead of closing complete.',
      key_points: [
        'Handoff reason: operator asked to continue in a fresh session',
        'Worker access: A worker can edit this checkout.',
      ],
      next_action: 'resume from the handoff record.',
    });
    expect(readFileSync(written.markdownPath, 'utf8')).toContain(
      'Handoff reason: operator asked to continue in a fresh session',
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

    expect(written.summary.headline).toBe('Circuit · Explore');
    expect(written.summary.details).toEqual([
      'Recommendation: Build a private eval suite around product-specific failure modes: Seam-fit eval; Operator-prose eval.',
      'Before building: inspect src/ and tests/ for an existing eval harness; confirm the saved run corpus.',
      'Start with: the operator-prose eval.',
      'Reviewer: Accepted the direction, with required fold-ins.',
      'Required fold-in: Clarify whether host output was inspected directly.',
      'Consider: Check the operator summary markdown, not only the JSON report.',
    ]);
    const markdown = readFileSync(written.markdownPath, 'utf8');
    expect(markdown).toContain('Circuit · Explore');
    expect(markdown).toContain('Build a private eval suite around product-specific failure modes');
    expect(markdown).toContain('Caveat: Clarify whether host output was inspected');
    expect(markdown).toContain('Caveat: Check the operator summary markdown');
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

    expect(written.summary.headline).toBe('Circuit · Explore');
    expect(readFileSync(written.markdownPath, 'utf8').split('\n')[0]).toBe('Circuit · Explore');
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
        routedBy: 'explicit',
        routerReason: 'matched explore goal',
      },
    });

    const recovered = readPriorRoute(runFolder);
    expect(recovered.routedBy).toBe('explicit');
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

    expect(written.summary.headline).toBe('Circuit · Review');
    expect(written.summary.brief_slots?.assessment).toBe(
      'The run aborted before this flow could finish.',
    );
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
    expect(written.summary.headline).toBe('Circuit · Review');
    expect(written.summary.brief_slots?.assessment).toBe(
      'The run escalated because Circuit could not close the flow safely.',
    );
    expect(written.summary.details).toContain(
      'Escalation reason: recovery exceeded the allowed attempts',
    );
    expect(readFileSync(written.markdownPath, 'utf8')).toContain(
      'recovery exceeded the allowed attempts',
    );
  });
});

describe('operator summary writer — skill hook activations', () => {
  const RUN = '87000000-0000-0000-0000-000000000001';

  function hookEntry(sequence: number, event: Record<string, unknown>): Record<string, unknown> {
    return {
      schema_version: 1,
      sequence,
      recorded_at: '2026-06-04T12:00:00.000Z',
      run_id: RUN,
      kind: 'run.skill-hook',
      event,
    };
  }

  function autoEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schema: 'run.skill-hook@v0',
      event_id: `${RUN}:apply-step:1:after:edit-files:.tsx:5`,
      hook: 'after:edit-files:.tsx',
      detected_from: ['change-set:observed'],
      cardinality: 'per-step',
      policy: {
        mode: 'auto',
        source: 'project-policy',
        strict: false,
        policy_ref: './.circuit/config.yaml',
      },
      flow_id: 'fix',
      step_id: 'apply-step',
      attempt_id: '1',
      triggered_skills: [{ id: 'react-doctor', state: 'planned', source: 'project-policy' }],
      ...overrides,
    };
  }

  it('discloses the fired hook, the injected skill, and its provenance (A1/A2)', () => {
    writeTrace([hookEntry(5, autoEvent())]);

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('fix'),
      route: { selectedFlow: 'fix' },
    });

    const activations = written.summary.skill_hook_activations ?? [];
    expect(activations).toHaveLength(1);
    expect(activations[0]).toMatchObject({
      hook: 'after:edit-files:.tsx',
      mode: 'auto',
      source: 'project-policy',
      policy_ref: './.circuit/config.yaml',
      injected_skills: ['react-doctor'],
      withheld_skills: [],
      unavailable_skills: [],
    });

    const markdown = readFileSync(written.markdownPath, 'utf8');
    expect(markdown).toContain('Skill hooks:');
    expect(markdown).toContain(
      '`after:edit-files:.tsx` injected react-doctor — ./.circuit/config.yaml',
    );
  });

  it('discloses a configured-but-unavailable skill with its reason (A3)', () => {
    writeTrace([
      hookEntry(
        5,
        autoEvent({
          triggered_skills: [],
          unavailable_skills: [
            {
              id: 'react-doctor',
              state: 'unavailable',
              source: 'project-policy',
              reason: "Circuit could not find skill 'react-doctor'.\nSearched:\n- /home/x",
            },
          ],
        }),
      ),
    ]);

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('fix'),
      route: { selectedFlow: 'fix' },
    });

    const activations = written.summary.skill_hook_activations ?? [];
    expect(activations).toHaveLength(1);
    expect(activations[0]?.injected_skills).toEqual([]);
    expect(activations[0]?.unavailable_skills).toEqual([
      { id: 'react-doctor', reason: "Circuit could not find skill 'react-doctor'." },
    ]);

    const markdown = readFileSync(written.markdownPath, 'utf8');
    expect(markdown).toContain(
      "`after:edit-files:.tsx` could not load react-doctor (Circuit could not find skill 'react-doctor'.) — ./.circuit/config.yaml",
    );
    // The multi-line "Searched:" tail must not bleed into the digest.
    expect(markdown).not.toContain('Searched:');
  });

  it('shows a muted hook as observe-only', () => {
    writeTrace([
      hookEntry(
        5,
        autoEvent({
          hook: 'after:verification-failed',
          detected_from: ['evidence-map:required-check-failed'],
          cardinality: 'per-step',
          policy: { mode: 'mute', source: 'user-global-policy', strict: false },
          triggered_skills: [],
        }),
      ),
    ]);

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('fix'),
      route: { selectedFlow: 'fix' },
    });

    expect(written.summary.skill_hook_activations?.[0]).toMatchObject({
      hook: 'after:verification-failed',
      mode: 'mute',
      injected_skills: [],
    });
    expect(readFileSync(written.markdownPath, 'utf8')).toContain(
      '`after:verification-failed` fired (muted; nothing injected) — user-global policy',
    );
  });

  it('marks a resolved skill as withheld when a strict decision packet blocks injection', () => {
    writeTrace([
      hookEntry(
        5,
        autoEvent({
          decision_packet_id: 'decision-1:strict-skill-unavailable',
          policy: {
            mode: 'auto',
            source: 'project-policy',
            strict: true,
            policy_ref: './.circuit/config.yaml',
          },
          triggered_skills: [{ id: 'react-doctor', state: 'planned', source: 'project-policy' }],
          unavailable_skills: [
            { id: 'tdd', state: 'unavailable', source: 'project-policy', reason: 'missing' },
          ],
        }),
      ),
    ]);

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('fix'),
      route: { selectedFlow: 'fix' },
    });

    const activation = written.summary.skill_hook_activations?.[0];
    expect(activation?.injected_skills).toEqual([]);
    expect(activation?.withheld_skills).toEqual(['react-doctor']);
    expect(readFileSync(written.markdownPath, 'utf8')).toContain(
      'withheld react-doctor pending a strict-mode decision',
    );
  });

  it('dedups a hook that re-fires across steps with the same outcome', () => {
    writeTrace([
      hookEntry(5, autoEvent({ event_id: `${RUN}:a:1:after:edit-files:.tsx:5`, step_id: 'a' })),
      hookEntry(9, autoEvent({ event_id: `${RUN}:b:1:after:edit-files:.tsx:9`, step_id: 'b' })),
    ]);

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('fix'),
      route: { selectedFlow: 'fix' },
    });

    // Same hook + same injected set on two steps collapses to one digest line.
    expect(written.summary.skill_hook_activations).toHaveLength(1);
  });

  it('surfaces a swallowed dispatch failure as a warning (A8)', () => {
    writeTrace([
      {
        schema_version: 1,
        sequence: 5,
        recorded_at: '2026-06-04T12:00:00.000Z',
        run_id: RUN,
        kind: 'run.skill-hook-error',
        step_id: 'apply-step',
        message: 'report surface extractor threw: Unexpected end of JSON input\nstack trace line',
      },
    ]);

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('fix'),
      route: { selectedFlow: 'fix' },
    });

    expect(written.summary.evidence_warnings).toContainEqual({
      kind: 'skill_hook_dispatch_failed',
      message: 'report surface extractor threw: Unexpected end of JSON input',
    });
    expect(readFileSync(written.markdownPath, 'utf8')).toContain(
      'report surface extractor threw: Unexpected end of JSON input',
    );
  });

  it('omits the skill-hooks surface entirely on a run with no skill-hook records', () => {
    writeTrace([
      {
        schema_version: 1,
        sequence: 1,
        recorded_at: '2026-06-04T12:00:00.000Z',
        run_id: RUN,
        kind: 'step.completed',
        step_id: 'apply-step',
        attempt: 1,
      },
    ]);

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('fix'),
      route: { selectedFlow: 'fix' },
    });

    expect(written.summary.skill_hook_activations).toBeUndefined();
    expect(readFileSync(written.markdownPath, 'utf8')).not.toContain('Skill hooks:');
  });
});

describe('operator summary writer — run receipt', () => {
  const RUN = '87000000-0000-0000-0000-000000000001';

  function traceEntry(
    sequence: number,
    kind: string,
    fields: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      schema_version: 1,
      sequence,
      recorded_at: '2026-06-10T12:00:00.000Z',
      run_id: RUN,
      kind,
      ...fields,
    };
  }

  function bootstrapped(depth: string): Record<string, unknown> {
    return traceEntry(1, 'run.bootstrapped', {
      flow_id: 'fix',
      depth,
      goal: 'run fix',
      change_kind: 'behavioral',
      manifest_hash: 'abc123',
    });
  }

  function relayStarted(
    sequence: number,
    stepId: string,
    attempt: number,
    model?: { provider: string; model: string },
    selectionExtras?: Record<string, unknown>,
  ): Record<string, unknown> {
    return traceEntry(sequence, 'relay.started', {
      step_id: stepId,
      attempt,
      connector: 'claude-code-task',
      role: 'implementer',
      resolved_selection: {
        ...(model === undefined ? {} : { model }),
        skills: [],
        invocation_options: {},
        ...(selectionExtras ?? {}),
      },
      resolved_from: { source: 'role', role: 'implementer' },
    });
  }

  function checkEvaluated(sequence: number, outcome: 'pass' | 'fail'): Record<string, unknown> {
    return traceEntry(sequence, 'check.evaluated', {
      step_id: 'apply-step',
      attempt: 1,
      check_kind: 'schema_sections',
      outcome,
    });
  }

  it('aggregates depth, worker runs, distinct models, and check counts from the trace', () => {
    writeTrace([
      bootstrapped('medium'),
      relayStarted(2, 'diagnose-step', 1, { provider: 'anthropic', model: 'claude-haiku-4-5' }),
      relayStarted(3, 'apply-step', 1, { provider: 'anthropic', model: 'claude-haiku-4-5' }),
      relayStarted(4, 'review-step', 1, { provider: 'anthropic', model: 'claude-opus-4-8' }),
      checkEvaluated(5, 'pass'),
      checkEvaluated(6, 'pass'),
    ]);

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('fix'),
      route: { selectedFlow: 'fix' },
    });

    expect(written.summary.receipt).toEqual({
      depth: 'medium',
      worker_runs: 3,
      escalations: 0,
      models: [
        { provider: 'anthropic', model: 'claude-haiku-4-5' },
        { provider: 'anthropic', model: 'claude-opus-4-8' },
      ],
      checks_evaluated: 2,
      checks_failed: 0,
    });
  });

  it('renders the receipt line in plain words with no model ids and no "power" claim', () => {
    writeTrace([
      bootstrapped('medium'),
      relayStarted(2, 'diagnose-step', 1, { provider: 'anthropic', model: 'claude-haiku-4-5' }),
      relayStarted(3, 'apply-step', 1, { provider: 'anthropic', model: 'claude-opus-4-8' }),
      checkEvaluated(4, 'pass'),
    ]);

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('fix'),
      route: { selectedFlow: 'fix' },
    });

    const markdown = readFileSync(written.markdownPath, 'utf8');
    expect(markdown).toContain('⎿ depth medium · 2 worker runs · all checks passed');
    // Phase 1 makes no model-tier claims: model ids stay in the run record.
    expect(markdown).not.toContain('claude-haiku-4-5');
    expect(markdown).not.toContain('claude-opus-4-8');
    expect(markdown).not.toMatch(/power/i);
  });

  it('uses the singular form for a single worker run', () => {
    writeTrace([bootstrapped('low'), relayStarted(2, 'apply-step', 1), checkEvaluated(3, 'pass')]);

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('fix'),
      route: { selectedFlow: 'fix' },
    });

    expect(readFileSync(written.markdownPath, 'utf8')).toContain(
      '⎿ depth low · 1 worker run · all checks passed',
    );
  });

  it('surfaces a reduced-bindings note when a composed flow lost catalog-sourced bindings', () => {
    // Stage 1 (first-class composition): a composed/published-custom flow whose
    // id matched no catalog package records its lost bindings on run.bootstrapped.
    // The receipt must make that loss visible instead of looking like a full run.
    writeTrace([
      traceEntry(1, 'run.bootstrapped', {
        flow_id: 'my-composed-flow',
        depth: 'medium',
        goal: 'run a composed flow',
        change_kind: 'behavioral',
        manifest_hash: 'abc123',
        package_resolved: false,
        reduced_bindings: [
          'edit_file_surfaces',
          'depth_binding',
          'slice_loop',
          'terminal_outcome_binding',
          'primary_result_surface',
        ],
      }),
      relayStarted(2, 'apply-step', 1),
      checkEvaluated(3, 'pass'),
    ]);

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('fix'),
      route: { selectedFlow: 'fix' },
    });

    expect(written.summary.receipt?.reduced_bindings).toEqual([
      'edit_file_surfaces',
      'depth_binding',
      'slice_loop',
      'terminal_outcome_binding',
      'primary_result_surface',
    ]);
    const markdown = readFileSync(written.markdownPath, 'utf8');
    expect(markdown).toContain(
      '⎿ reduced bindings (no catalog package): edit-file hooks · depth binding · slice loop · terminal outcome · primary result',
    );
  });

  it('shows no reduced-bindings note for a built-in flow with all bindings resolved', () => {
    // A normal built-in run carries no reduced_bindings; the note must stay
    // absent so it only ever signals a genuinely reduced run.
    writeTrace([
      bootstrapped('medium'),
      relayStarted(2, 'apply-step', 1),
      checkEvaluated(3, 'pass'),
    ]);

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('fix'),
      route: { selectedFlow: 'fix' },
    });

    expect(written.summary.receipt?.reduced_bindings).toBeUndefined();
    expect(readFileSync(written.markdownPath, 'utf8')).not.toContain('reduced bindings');
  });

  it('reports the passed-of-evaluated count instead of claiming all checks passed when any check failed', () => {
    writeTrace([
      bootstrapped('high'),
      relayStarted(2, 'apply-step', 1),
      checkEvaluated(3, 'fail'),
      checkEvaluated(4, 'pass'),
      checkEvaluated(5, 'pass'),
    ]);

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('fix'),
      route: { selectedFlow: 'fix' },
    });

    expect(written.summary.receipt).toMatchObject({ checks_evaluated: 3, checks_failed: 1 });
    const markdown = readFileSync(written.markdownPath, 'utf8');
    expect(markdown).toContain('⎿ depth high · 1 worker run · 2 of 3 checks passed');
    expect(markdown).not.toContain('all checks passed');
  });

  it('omits the checks clause when the run evaluated no checks', () => {
    writeTrace([bootstrapped('medium'), relayStarted(2, 'apply-step', 1)]);

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('fix'),
      route: { selectedFlow: 'fix' },
    });

    expect(readFileSync(written.markdownPath, 'utf8')).toContain('⎿ depth medium · 1 worker run\n');
  });

  it('omits the receipt entirely when the trace has no run.bootstrapped entry', () => {
    writeTrace([relayStarted(2, 'apply-step', 1), checkEvaluated(3, 'pass')]);

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('fix'),
      route: { selectedFlow: 'fix' },
    });

    expect(written.summary.receipt).toBeUndefined();
    expect(readFileSync(written.markdownPath, 'utf8')).not.toContain('⎿');
  });

  it('omits the receipt when the trace file is missing', () => {
    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('fix'),
      route: { selectedFlow: 'fix' },
    });

    expect(written.summary.receipt).toBeUndefined();
    expect(readFileSync(written.markdownPath, 'utf8')).not.toContain('⎿');
  });

  it('reads the power dial and escalation count from relay.started selections', () => {
    writeTrace([
      bootstrapped('medium'),
      relayStarted(
        2,
        'diagnose-step',
        1,
        { provider: 'anthropic', model: 'opus' },
        { power: 'low' },
      ),
      relayStarted(3, 'apply-step', 1, { provider: 'anthropic', model: 'haiku' }, { power: 'low' }),
      relayStarted(
        4,
        'apply-step',
        2,
        { provider: 'anthropic', model: 'sonnet' },
        { power: 'low', power_escalated: true },
      ),
      checkEvaluated(5, 'pass'),
    ]);

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('fix'),
      route: { selectedFlow: 'fix' },
    });

    expect(written.summary.receipt).toMatchObject({ power: 'low', escalations: 1 });
    const markdown = readFileSync(written.markdownPath, 'utf8');
    expect(markdown).toContain(
      '⎿ depth medium · power low · 3 worker runs · 1 escalation · all checks passed',
    );
    // The dial line stays plain-word: tier words yes, model ids no.
    expect(markdown).not.toContain('haiku');
    expect(markdown).not.toContain('sonnet');
    expect(markdown).not.toContain('opus');
  });

  it('pluralizes escalations and renders them even when the dial never escalated elsewhere', () => {
    writeTrace([
      bootstrapped('low'),
      relayStarted(2, 'apply-step', 2, undefined, { power: 'medium', power_escalated: true }),
      relayStarted(3, 'verify-step', 2, undefined, { power: 'medium', power_escalated: true }),
    ]);

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('fix'),
      route: { selectedFlow: 'fix' },
    });

    expect(written.summary.receipt).toMatchObject({ power: 'medium', escalations: 2 });
    expect(readFileSync(written.markdownPath, 'utf8')).toContain(
      '⎿ depth low · power medium · 2 worker runs · 2 escalations\n',
    );
  });

  it('omits the power clause and escalations when no relay carried a dial (dial off)', () => {
    writeTrace([
      bootstrapped('medium'),
      relayStarted(2, 'apply-step', 1),
      checkEvaluated(3, 'pass'),
    ]);

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('fix'),
      route: { selectedFlow: 'fix' },
    });

    expect(written.summary.receipt?.power).toBeUndefined();
    expect(written.summary.receipt?.escalations).toBe(0);
    const markdown = readFileSync(written.markdownPath, 'utf8');
    expect(markdown).toContain('⎿ depth medium · 1 worker run · all checks passed');
    expect(markdown).not.toMatch(/power|escalation/);
  });

  it('skips relay.started entries whose resolved_selection carries no model without losing the run count', () => {
    writeTrace([
      bootstrapped('medium'),
      relayStarted(2, 'diagnose-step', 1),
      relayStarted(3, 'apply-step', 1, { provider: 'openai', model: 'gpt-5.2-codex' }),
    ]);

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('fix'),
      route: { selectedFlow: 'fix' },
    });

    expect(written.summary.receipt).toMatchObject({
      worker_runs: 2,
      models: [{ provider: 'openai', model: 'gpt-5.2-codex' }],
    });
  });

  function powerInference(
    sequence: number,
    fields: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return traceEntry(sequence, 'run.power-inference', {
      step_id: 'diagnose-step',
      recommended: 'low',
      rationale: 'small localized change with good test coverage',
      floor: 'low',
      ceiling: 'high',
      resolved: 'low',
      clamped: false,
      ...fields,
    });
  }

  it('reports the auto dial from the resolved inference, not the pre-inference fallback', () => {
    writeTrace([
      bootstrapped('medium'),
      // The researcher relay materialized the medium fallback before the
      // inference landed; the receipt must report the resolved low, not medium.
      relayStarted(
        2,
        'diagnose-step',
        1,
        { provider: 'anthropic', model: 'opus' },
        { power: 'medium', power_source: 'auto' },
      ),
      powerInference(3),
      relayStarted(
        4,
        'apply-step',
        1,
        { provider: 'anthropic', model: 'haiku' },
        { power: 'low', power_source: 'auto' },
      ),
      checkEvaluated(5, 'pass'),
    ]);

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('fix'),
      route: { selectedFlow: 'fix' },
    });

    expect(written.summary.receipt).toMatchObject({
      power: 'low',
      power_source: 'auto',
      power_recommended: 'low',
      power_rationale: 'small localized change with good test coverage',
      power_clamped: false,
    });
    const markdown = readFileSync(written.markdownPath, 'utf8');
    expect(markdown).toContain('power low (auto)');
    expect(written.summary.details).toContain(
      'Power dial: auto chose low. Reason: small localized change with good test coverage',
    );
  });

  it('says when the auto choice was capped to the operator bounds', () => {
    writeTrace([
      bootstrapped('medium'),
      relayStarted(
        2,
        'diagnose-step',
        1,
        { provider: 'anthropic', model: 'opus' },
        { power: 'medium', power_source: 'auto' },
      ),
      powerInference(3, {
        recommended: 'high',
        rationale: 'wide and weakly tested',
        ceiling: 'medium',
        resolved: 'medium',
        clamped: true,
      }),
      relayStarted(
        4,
        'apply-step',
        1,
        { provider: 'anthropic', model: 'sonnet' },
        { power: 'medium', power_source: 'auto' },
      ),
    ]);

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('fix'),
      route: { selectedFlow: 'fix' },
    });

    expect(written.summary.receipt).toMatchObject({
      power: 'medium',
      power_source: 'auto',
      power_recommended: 'high',
      power_clamped: true,
    });
    const markdown = readFileSync(written.markdownPath, 'utf8');
    expect(markdown).toContain('power medium (auto, capped)');
    expect(written.summary.details).toContain(
      'Power dial: auto chose medium (recommended high, held to the configured bounds). Reason: wide and weakly tested',
    );
  });

  it('marks an auto run whose researcher never recommended as the fallback it ran at', () => {
    writeTrace([
      bootstrapped('medium'),
      relayStarted(
        2,
        'apply-step',
        1,
        { provider: 'anthropic', model: 'sonnet' },
        { power: 'medium', power_source: 'auto' },
      ),
    ]);

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('fix'),
      route: { selectedFlow: 'fix' },
    });

    expect(written.summary.receipt).toMatchObject({ power: 'medium', power_source: 'auto' });
    expect(written.summary.receipt?.power_rationale).toBeUndefined();
    const markdown = readFileSync(written.markdownPath, 'utf8');
    expect(markdown).toContain('power medium (auto, no recommendation)');
    expect(written.summary.details.join('\n')).not.toContain('Power dial:');
  });

  it('a fixed dial renders without any auto qualifier', () => {
    writeTrace([
      bootstrapped('medium'),
      relayStarted(
        2,
        'apply-step',
        1,
        { provider: 'anthropic', model: 'sonnet' },
        { power: 'medium' },
      ),
    ]);

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('fix'),
      route: { selectedFlow: 'fix' },
    });

    expect(written.summary.receipt?.power_source).toBeUndefined();
    const markdown = readFileSync(written.markdownPath, 'utf8');
    expect(markdown).toContain('power medium ·');
    expect(markdown).not.toContain('(auto');
  });

  function relayStartedAs(
    sequence: number,
    stepId: string,
    attempt: number,
    role: 'researcher' | 'implementer' | 'reviewer',
    model?: { provider: string; model: string },
  ): Record<string, unknown> {
    return traceEntry(sequence, 'relay.started', {
      step_id: stepId,
      attempt,
      connector: 'claude-code-task',
      role,
      resolved_selection: {
        ...(model === undefined ? {} : { model }),
        skills: [],
        invocation_options: {},
      },
      resolved_from: { source: 'role', role },
    });
  }

  function relayCompleted(
    sequence: number,
    stepId: string,
    attempt: number,
    usage?: Record<string, unknown>,
  ): Record<string, unknown> {
    return traceEntry(sequence, 'relay.completed', {
      step_id: stepId,
      attempt,
      verdict: 'accept',
      duration_ms: 1200,
      result_path: `relays/${stepId}-${attempt}/result.json`,
      receipt_path: `relays/${stepId}-${attempt}/receipt.json`,
      ...(usage === undefined ? {} : { usage }),
    });
  }

  function usageBlock(fields: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      cache_creation_5m_tokens: 0,
      cache_creation_1h_tokens: 0,
      ...fields,
    };
  }

  it('itemizes per-role spend in dollars and renders it directly after the receipt line', () => {
    writeTrace([
      bootstrapped('medium'),
      // Trace order is implementer-first to prove the rendered role order is
      // fixed (researcher, implementer, reviewer), not trace-arrival order.
      relayStartedAs(2, 'apply-step', 1, 'implementer', {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
      }),
      relayCompleted(3, 'apply-step', 1, {
        ...usageBlock({ input_tokens: 20000, output_tokens: 3000 }),
        total_cost_usd_reported: 0.04,
      }),
      relayStartedAs(4, 'diagnose-step', 1, 'researcher', {
        provider: 'anthropic',
        model: 'claude-opus-4-8',
      }),
      relayCompleted(5, 'diagnose-step', 1, {
        ...usageBlock({
          input_tokens: 50000,
          output_tokens: 4000,
          cache_read_tokens: 100000,
          cache_creation_tokens: 20000,
        }),
        total_cost_usd_reported: 0.35,
      }),
      relayStartedAs(6, 'review-step', 1, 'reviewer', {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
      }),
      relayCompleted(7, 'review-step', 1, {
        ...usageBlock({ input_tokens: 15000, output_tokens: 2000 }),
        total_cost_usd_reported: 0.08,
      }),
      checkEvaluated(8, 'pass'),
    ]);

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('fix'),
      route: { selectedFlow: 'fix' },
    });

    const spend = written.summary.receipt?.spend;
    expect(spend?.relays_missing_usage).toBe(0);
    expect(spend?.partial).toBe(false);
    expect(spend?.total_cost_usd_reported).toBeCloseTo(0.47, 10);
    expect(spend?.roles).toEqual([
      {
        role: 'researcher',
        relays: 1,
        relays_missing_usage: 0,
        models: ['anthropic:claude-opus-4-8'],
        input_tokens: 50000,
        output_tokens: 4000,
        cache_read_tokens: 100000,
        cache_creation_tokens: 20000,
        cost_usd_reported: 0.35,
      },
      {
        role: 'implementer',
        relays: 1,
        relays_missing_usage: 0,
        models: ['anthropic:claude-haiku-4-5'],
        input_tokens: 20000,
        output_tokens: 3000,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cost_usd_reported: 0.04,
      },
      {
        role: 'reviewer',
        relays: 1,
        relays_missing_usage: 0,
        models: ['anthropic:claude-sonnet-4-6'],
        input_tokens: 15000,
        output_tokens: 2000,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cost_usd_reported: 0.08,
      },
    ]);
    const markdown = readFileSync(written.markdownPath, 'utf8');
    expect(markdown).toContain(
      '⎿ depth medium · 3 worker runs · all checks passed\n' +
        '⎿ spend $0.47 · researcher $0.35 · implementer $0.04 · reviewer $0.08',
    );
  });

  it('marks the dollar sum (partial) when a completed relay carried no usage', () => {
    writeTrace([
      bootstrapped('medium'),
      relayStartedAs(2, 'diagnose-step', 1, 'researcher', {
        provider: 'anthropic',
        model: 'claude-opus-4-8',
      }),
      relayCompleted(3, 'diagnose-step', 1, {
        ...usageBlock({ input_tokens: 40000, output_tokens: 3000 }),
        total_cost_usd_reported: 0.35,
      }),
      relayStartedAs(4, 'apply-step', 1, 'implementer', {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
      }),
      relayCompleted(5, 'apply-step', 1),
      relayStartedAs(6, 'review-step', 1, 'reviewer', {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
      }),
      relayCompleted(7, 'review-step', 1, {
        ...usageBlock({ input_tokens: 12000, output_tokens: 1500 }),
        total_cost_usd_reported: 0.08,
      }),
    ]);

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('fix'),
      route: { selectedFlow: 'fix' },
    });

    const spend = written.summary.receipt?.spend;
    expect(spend?.relays_missing_usage).toBe(1);
    expect(spend?.partial).toBe(true);
    expect(spend?.total_cost_usd_reported).toBeCloseTo(0.43, 10);
    // The usage-less implementer relay still appears in the JSON (its model
    // ran; only its meter is missing) but contributes no figure to the line.
    expect(spend?.roles).toEqual([
      {
        role: 'researcher',
        relays: 1,
        relays_missing_usage: 0,
        models: ['anthropic:claude-opus-4-8'],
        input_tokens: 40000,
        output_tokens: 3000,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cost_usd_reported: 0.35,
      },
      {
        role: 'implementer',
        relays: 1,
        relays_missing_usage: 1,
        models: ['anthropic:claude-haiku-4-5'],
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
      },
      {
        role: 'reviewer',
        relays: 1,
        relays_missing_usage: 0,
        models: ['anthropic:claude-sonnet-4-6'],
        input_tokens: 12000,
        output_tokens: 1500,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cost_usd_reported: 0.08,
      },
    ]);
    expect(readFileSync(written.markdownPath, 'utf8')).toContain(
      '⎿ spend $0.43 (partial) · researcher $0.35 · reviewer $0.08',
    );
  });

  it('falls back to token counts when usage exists but no relay reported a cost', () => {
    writeTrace([
      bootstrapped('medium'),
      relayStartedAs(2, 'diagnose-step', 1, 'researcher', {
        provider: 'anthropic',
        model: 'claude-opus-4-8',
      }),
      // Cache tokens are deliberately large: the headline counts input +
      // output only, so they must not move the rendered figure.
      relayCompleted(
        3,
        'diagnose-step',
        1,
        usageBlock({
          input_tokens: 80000,
          output_tokens: 10100,
          cache_read_tokens: 500000,
          cache_creation_tokens: 90000,
        }),
      ),
      relayStartedAs(4, 'apply-step', 1, 'implementer', {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
      }),
      relayCompleted(5, 'apply-step', 1, usageBlock({ input_tokens: 600, output_tokens: 300 })),
      relayStartedAs(6, 'review-step', 1, 'reviewer', {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
      }),
      relayCompleted(7, 'review-step', 1, usageBlock({ input_tokens: 24000, output_tokens: 2000 })),
    ]);

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('fix'),
      route: { selectedFlow: 'fix' },
    });

    const spend = written.summary.receipt?.spend;
    expect(spend?.total_cost_usd_reported).toBeUndefined();
    expect(spend?.relays_missing_usage).toBe(0);
    // Every token figure is complete, but no dollars exist anywhere: the JSON
    // flag says so, while the token line carries no (partial) because the
    // figure it renders is whole.
    expect(spend?.partial).toBe(true);
    expect(readFileSync(written.markdownPath, 'utf8')).toContain(
      '⎿ spend 117.0k tokens · researcher 90.1k · implementer 900 · reviewer 26.0k',
    );
  });

  it('omits spend entirely when no completed relay carries a usage block', () => {
    writeTrace([
      bootstrapped('medium'),
      relayStartedAs(2, 'apply-step', 1, 'implementer', {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
      }),
      relayCompleted(3, 'apply-step', 1),
      checkEvaluated(4, 'pass'),
    ]);

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('fix'),
      route: { selectedFlow: 'fix' },
    });

    expect(written.summary.receipt?.spend).toBeUndefined();
    const markdown = readFileSync(written.markdownPath, 'utf8');
    expect(markdown).toContain('⎿ depth medium · 1 worker run · all checks passed');
    expect(markdown).not.toContain('spend');
  });

  it('sums both completed attempts of the same step under one role', () => {
    writeTrace([
      bootstrapped('medium'),
      relayStartedAs(2, 'apply-step', 1, 'implementer', {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
      }),
      relayCompleted(3, 'apply-step', 1, {
        ...usageBlock({ input_tokens: 10000, output_tokens: 1000 }),
        total_cost_usd_reported: 0.02,
      }),
      relayStartedAs(4, 'apply-step', 2, 'implementer', {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
      }),
      relayCompleted(5, 'apply-step', 2, {
        ...usageBlock({ input_tokens: 14000, output_tokens: 2000 }),
        total_cost_usd_reported: 0.03,
      }),
    ]);

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('fix'),
      route: { selectedFlow: 'fix' },
    });

    const spend = written.summary.receipt?.spend;
    expect(spend?.partial).toBe(false);
    expect(spend?.roles).toHaveLength(1);
    expect(spend?.roles[0]).toMatchObject({
      role: 'implementer',
      relays: 2,
      relays_missing_usage: 0,
      models: ['anthropic:claude-haiku-4-5'],
      input_tokens: 24000,
      output_tokens: 3000,
    });
    expect(spend?.roles[0]?.cost_usd_reported).toBeCloseTo(0.05, 10);
    expect(readFileSync(written.markdownPath, 'utf8')).toContain(
      '⎿ spend $0.05 · implementer $0.05',
    );
  });

  it('ignores relay.failed attempts: only completed relays count toward spend', () => {
    writeTrace([
      bootstrapped('medium'),
      relayStartedAs(2, 'apply-step', 1, 'implementer', {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
      }),
      traceEntry(3, 'relay.failed', {
        step_id: 'apply-step',
        attempt: 1,
        reason: 'connector subprocess crashed',
      }),
      relayStartedAs(4, 'apply-step', 2, 'implementer', {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
      }),
      relayCompleted(5, 'apply-step', 2, {
        ...usageBlock({ input_tokens: 9000, output_tokens: 800 }),
        total_cost_usd_reported: 0.02,
      }),
    ]);

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('fix'),
      route: { selectedFlow: 'fix' },
    });

    const spend = written.summary.receipt?.spend;
    expect(spend?.partial).toBe(false);
    expect(spend?.relays_missing_usage).toBe(0);
    expect(spend?.roles).toEqual([
      {
        role: 'implementer',
        relays: 1,
        relays_missing_usage: 0,
        models: ['anthropic:claude-haiku-4-5'],
        input_tokens: 9000,
        output_tokens: 800,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        cost_usd_reported: 0.02,
      },
    ]);
  });

  it('dedupes models within a role in first-seen order and keeps sub-dime sums precise', () => {
    writeTrace([
      bootstrapped('medium'),
      relayStartedAs(2, 'diagnose-step', 1, 'researcher', {
        provider: 'anthropic',
        model: 'claude-opus-4-8',
      }),
      relayCompleted(3, 'diagnose-step', 1, {
        ...usageBlock({ input_tokens: 5000, output_tokens: 400 }),
        total_cost_usd_reported: 0.005,
      }),
      relayStartedAs(4, 'findings-step', 1, 'researcher', {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
      }),
      relayCompleted(5, 'findings-step', 1, {
        ...usageBlock({ input_tokens: 6000, output_tokens: 500 }),
        total_cost_usd_reported: 0.0073,
      }),
      relayStartedAs(6, 'recheck-step', 1, 'researcher', {
        provider: 'anthropic',
        model: 'claude-opus-4-8',
      }),
      relayCompleted(7, 'recheck-step', 1, {
        ...usageBlock({ input_tokens: 2000, output_tokens: 100 }),
        total_cost_usd_reported: 0.002,
      }),
    ]);

    const written = writeOperatorSummary({
      runFolder,
      runResult: baseResult('fix'),
      route: { selectedFlow: 'fix' },
    });

    const spend = written.summary.receipt?.spend;
    expect(spend?.roles).toHaveLength(1);
    expect(spend?.roles[0]).toMatchObject({
      role: 'researcher',
      relays: 3,
      models: ['anthropic:claude-opus-4-8', 'anthropic:claude-sonnet-4-6'],
    });
    // 0.005 + 0.0073 + 0.002 = 0.0143: below ten cents the line keeps three
    // significant figures instead of rounding the signal away to $0.01.
    expect(spend?.total_cost_usd_reported).toBeCloseTo(0.0143, 10);
    expect(readFileSync(written.markdownPath, 'utf8')).toContain(
      '⎿ spend $0.0143 · researcher $0.0143',
    );
  });
});
