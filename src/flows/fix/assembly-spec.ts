// Fix's flow assembly spec (first-class composition, A5).
//
// Fix is build's sibling proving shape: a Frame → Analyze → Act → Verify →
// Review → Close spine with a regression-baseline pair, a no-repro checkpoint, a
// low-depth close branch, and a handoff terminal. Like build
// (../build/assembly-spec.ts) and pursue (../pursue/assembly-spec.ts), data.ts
// now consumes `assembleFlowSchematic(fixAssemblySpec)` instead of a hand-
// authored literal. Fix omits the plan canonical stage (its planning folds into
// Diagnose), so the assembler derives a partial stage path with omits: ['plan'];
// the rationale is supplied via `stagePathRationale`.
//
// report_file_surfaces (the skill-hook edit-file surface table for
// fix.change-set@v1) rides the schematic as pass-through scaffolding. Each item
// omits output / evidence_requirements / execution wherever it equals the block
// default; the run-verification verify steps omit execution (single-kind block),
// and the handoff terminal omits output (matches the handoff block default).
import type { FlowSchematicAssemblySpec, StageLabelMap } from '../assemble-flow-schematic.js';
import type { BlockStepUse } from '../block-step-expansion.js';

const FIX_STAGE_PATH_RATIONALE =
  "Fix follows Frame, Analyze, Act, Verify, Review, Close. The Plan stage is omitted because Fix's planning is folded into Diagnose during the Analyze stage — there is no separate plan-of-attack report distinct from the diagnosis.";

// Fix's full block sequence, in route order.
export const fixBlockItems: readonly BlockStepUse[] = [
  {
    id: 'fix-frame',
    title: 'Frame — confirm Fix brief',
    stage: 'frame',
    block: 'frame',
    input: { task: 'task.intake@v1', route: 'route.decision@v1' },
    output: 'fix.brief@v1',
    execution: { kind: 'compose' },
    protocol: 'fix-frame@v1',
    writes: { report_path: 'reports/fix/brief.json' },
    check: { required: ['problem_statement', 'scope', 'regression_contract', 'success_criteria'] },
    routes: {
      continue: 'fix-regression-baseline',
      revise: 'fix-frame',
      ask: '@stop',
      stop: '@stop',
    },
  },
  {
    id: 'fix-gather-context',
    title: 'Analyze — gather problem context',
    stage: 'analyze',
    block: 'gather-context',
    input: { brief: 'fix.brief@v1', request: 'context.request@v1' },
    output: 'fix.context@v1',
    execution: { kind: 'relay', role: 'researcher' },
    protocol: 'fix-gather-context@v1',
    writes: {
      report_path: 'reports/fix/context.json',
      request_path: 'reports/relay/fix-gather-context.request.json',
      receipt_path: 'reports/relay/fix-gather-context.receipt.txt',
      result_path: 'reports/relay/fix-gather-context.result.json',
    },
    check: { pass: ['accept'] },
    skillSlots: [
      {
        id: 'fix-codebase-search',
        description:
          'A skill for navigating and searching the codebase to locate the code involved in the reported problem.',
      },
    ],
    routes: { continue: 'fix-diagnose', retry: 'fix-gather-context', ask: '@stop', stop: '@stop' },
  },
  {
    id: 'fix-diagnose',
    title: 'Analyze — diagnose problem',
    stage: 'analyze',
    block: 'diagnose',
    input: { brief: 'fix.brief@v1', context: 'fix.context@v1' },
    output: 'fix.diagnosis@v1',
    execution: { kind: 'relay', role: 'researcher' },
    protocol: 'fix-diagnose@v1',
    writes: {
      report_path: 'reports/fix/diagnosis.json',
      request_path: 'reports/relay/fix-diagnose.request.json',
      receipt_path: 'reports/relay/fix-diagnose.receipt.txt',
      result_path: 'reports/relay/fix-diagnose.result.json',
    },
    check: { pass: ['accept'] },
    skillSlots: [
      {
        id: 'fix-root-cause-analysis',
        description:
          'A skill for forming and testing hypotheses about the root cause of a bug before any change is made.',
      },
    ],
    routes: {
      continue: 'fix-act',
      revise: 'fix-gather-context',
      retry: 'fix-diagnose',
      ask: 'fix-no-repro-decision',
      stop: '@stop',
    },
  },
  {
    id: 'fix-no-repro-decision',
    title: 'Analyze — choose path forward when reproduction is uncertain',
    stage: 'analyze',
    block: 'human-decision',
    input: { question: 'flow.question@v1', evidence: 'fix.diagnosis@v1' },
    output: 'fix.no-repro-decision@v1',
    protocol: 'fix-no-repro-decision@v1',
    writes: {
      checkpoint_request_path: 'reports/checkpoints/fix-no-repro-decision-request.json',
      checkpoint_response_path: 'reports/checkpoints/fix-no-repro-decision-response.json',
    },
    check: { allow: ['continue'] },
    checkpointPolicy: {
      prompt: 'Diagnosis did not cleanly reproduce the bug. Choose how to proceed.',
      choices: [{ id: 'continue', label: 'Continue with a focused fix anyway' }],
      safe_default_choice: 'continue',
    },
    routes: {
      continue: 'fix-act',
      revise: 'fix-diagnose',
      stop: '@stop',
      handoff: 'fix-handoff',
      escalate: '@escalate',
    },
  },
  {
    id: 'fix-regression-baseline',
    title: 'Verify — capture regression baseline',
    stage: 'verify',
    block: 'run-verification',
    input: { proof: 'verification.plan@v1', brief: 'fix.brief@v1' },
    output: 'fix.regression-proof@v1',
    protocol: 'fix-regression-baseline@v1',
    writes: { report_path: 'reports/fix/regression-proof.json' },
    check: { required: ['status', 'overall_status'] },
    routes: { continue: 'fix-baseline-snapshot', retry: 'fix-frame', stop: '@stop' },
  },
  {
    id: 'fix-baseline-snapshot',
    title: 'Verify — snapshot pre-fix git state',
    stage: 'verify',
    block: 'run-verification',
    input: { proof: 'verification.plan@v1' },
    output: 'fix.baseline-snapshot@v1',
    protocol: 'fix-baseline-snapshot@v1',
    writes: { report_path: 'reports/fix/baseline-snapshot.json' },
    check: { required: ['overall_status', 'head_sha'] },
    routes: { continue: 'fix-gather-context', stop: '@stop' },
  },
  {
    id: 'fix-act',
    title: 'Act — apply focused fix',
    stage: 'act',
    block: 'act',
    input: {
      brief: 'fix.brief@v1',
      diagnosis: 'fix.diagnosis@v1',
      verification: 'fix.verification@v1',
      change_set: 'fix.change-set@v1',
      final_change_set: 'fix.final-change-set@v1',
      regression_rerun: 'fix.regression-rerun@v1',
      review: 'fix.review@v1',
    },
    optional_inputs: [
      'verification',
      'change_set',
      'final_change_set',
      'regression_rerun',
      'review',
    ],
    output: 'fix.change@v1',
    execution: { kind: 'relay', role: 'implementer' },
    protocol: 'fix-act@v1',
    writes: {
      report_path: 'reports/fix/change.json',
      request_path: 'reports/relay/fix-act.request.json',
      receipt_path: 'reports/relay/fix-act.receipt.txt',
      result_path: 'reports/relay/fix-act.result.json',
    },
    check: { pass: ['accept'] },
    acceptanceCriteria: {
      checks: [
        {
          kind: 'report_field',
          id: 'changed-files-present',
          path: ['changed_files'],
          predicate: 'present',
        },
        {
          kind: 'report_field',
          id: 'evidence-non-empty',
          path: ['evidence'],
          predicate: 'non_empty',
        },
      ],
      on_failure: { mode: 'retry-with-feedback' },
    },
    skillSlots: [
      {
        id: 'fix-focused-edit',
        description:
          'A skill for making the smallest correct code edit that resolves the diagnosed problem.',
      },
    ],
    equipmentScope: {
      tools: { allow: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'] },
      enforcement: 'enforced',
    },
    routes: {
      continue: 'fix-change-set',
      retry: 'fix-act',
      ask: 'fix-no-repro-decision',
      stop: '@stop',
      handoff: 'fix-handoff',
    },
  },
  {
    id: 'fix-verify',
    title: 'Verify — run Fix proof',
    stage: 'verify',
    block: 'run-verification',
    input: { proof: 'verification.plan@v1', brief: 'fix.brief@v1', change: 'fix.change@v1' },
    output: 'fix.verification@v1',
    protocol: 'fix-verify@v1',
    writes: { report_path: 'reports/fix/verification.json' },
    check: { required: ['overall_status', 'commands'] },
    routes: {
      continue: 'fix-regression-rerun',
      retry: 'fix-act',
      ask: 'fix-no-repro-decision',
      stop: '@stop',
    },
  },
  {
    id: 'fix-change-set',
    title: 'Verify — compute fix change-set',
    stage: 'verify',
    block: 'run-verification',
    input: {
      proof: 'verification.plan@v1',
      baseline: 'fix.baseline-snapshot@v1',
      change: 'fix.change@v1',
    },
    output: 'fix.change-set@v1',
    protocol: 'fix-change-set@v1',
    writes: { report_path: 'reports/fix/change-set.json' },
    check: { required: ['status', 'overall_status'] },
    routes: { continue: 'fix-verify', retry: 'fix-act', stop: '@stop' },
  },
  {
    id: 'fix-regression-rerun',
    title: 'Verify — rerun regression command after fix',
    stage: 'verify',
    block: 'run-verification',
    input: { proof: 'verification.plan@v1', brief: 'fix.brief@v1' },
    output: 'fix.regression-rerun@v1',
    protocol: 'fix-regression-rerun@v1',
    writes: { report_path: 'reports/fix/regression-rerun.json' },
    check: { required: ['status', 'overall_status'] },
    routeOverrides: { continue: { low: 'fix-final-change-set' } },
    routes: { continue: 'fix-review', retry: 'fix-act', stop: '@stop' },
  },
  {
    id: 'fix-final-change-set',
    title: 'Verify — recheck final fix change-set',
    stage: 'verify',
    block: 'run-verification',
    input: {
      proof: 'verification.plan@v1',
      baseline: 'fix.baseline-snapshot@v1',
      change_set: 'fix.change-set@v1',
    },
    output: 'fix.final-change-set@v1',
    protocol: 'fix-final-change-set@v1',
    writes: { report_path: 'reports/fix/final-change-set.json' },
    check: { required: ['status', 'overall_status'] },
    routeOverrides: { continue: { low: 'fix-close-low' } },
    routes: { continue: 'fix-close', retry: 'fix-act', stop: '@stop' },
  },
  {
    id: 'fix-review',
    title: 'Review — independent audit of Fix change',
    stage: 'review',
    block: 'review',
    input: {
      brief: 'fix.brief@v1',
      change: 'fix.change@v1',
      change_set: 'fix.change-set@v1',
      verification: 'fix.verification@v1',
    },
    output: 'fix.review@v1',
    execution: { kind: 'relay', role: 'reviewer' },
    protocol: 'fix-review@v1',
    writes: {
      report_path: 'reports/fix/review.json',
      request_path: 'reports/relay/fix-review.request.json',
      receipt_path: 'reports/relay/fix-review.receipt.txt',
      result_path: 'reports/relay/fix-review.result.json',
    },
    // Only a clean review can advance. Schema-valid rework verdicts and an
    // `accept` carrying findings fail this check, materialize
    // reports/fix/review.json, and take retry back to fix-act so the
    // implementer sees the exact findings.
    check: { pass: ['accept'], require_empty: [['findings']] },
    skillSlots: [
      {
        id: 'fix-change-audit',
        description:
          'A skill for independently auditing a change for correctness, scope creep, and regressions.',
      },
    ],
    routes: {
      continue: 'fix-final-change-set',
      'connector-failed': 'fix-final-change-set',
      retry: 'fix-act',
      revise: 'fix-act',
      ask: 'fix-no-repro-decision',
      stop: '@stop',
    },
  },
  {
    id: 'fix-close-low',
    title: 'Close (low depth) — emit Fix result without review',
    stage: 'close',
    block: 'close-with-evidence',
    input: {
      brief: 'fix.brief@v1',
      context: 'fix.context@v1',
      diagnosis: 'fix.diagnosis@v1',
      regression: 'fix.regression-proof@v1',
      baseline_snapshot: 'fix.baseline-snapshot@v1',
      change: 'fix.change@v1',
      verification: 'fix.verification@v1',
      regression_rerun: 'fix.regression-rerun@v1',
      change_set: 'fix.final-change-set@v1',
    },
    output: 'fix.result@v1',
    execution: { kind: 'compose' },
    protocol: 'fix-close-low@v1',
    writes: { report_path: 'reports/fix-result.json' },
    check: {
      required: [
        'summary',
        'outcome',
        'verification_status',
        'regression_status',
        'change_set_status',
        'review_status',
        'evidence_links',
      ],
    },
    routes: { complete: '@complete', stop: '@stop', handoff: 'fix-handoff', escalate: '@escalate' },
  },
  {
    id: 'fix-close',
    title: 'Close — emit Fix result',
    stage: 'close',
    block: 'close-with-evidence',
    input: {
      brief: 'fix.brief@v1',
      context: 'fix.context@v1',
      diagnosis: 'fix.diagnosis@v1',
      regression: 'fix.regression-proof@v1',
      baseline_snapshot: 'fix.baseline-snapshot@v1',
      change: 'fix.change@v1',
      verification: 'fix.verification@v1',
      regression_rerun: 'fix.regression-rerun@v1',
      change_set: 'fix.final-change-set@v1',
      review: 'fix.review@v1',
    },
    optional_inputs: ['review'],
    output: 'fix.result@v1',
    execution: { kind: 'compose' },
    protocol: 'fix-close@v1',
    writes: { report_path: 'reports/fix-result.json' },
    check: {
      required: [
        'summary',
        'outcome',
        'verification_status',
        'regression_status',
        'change_set_status',
        'review_status',
        'evidence_links',
      ],
    },
    routes: { complete: '@complete', stop: '@stop', handoff: 'fix-handoff', escalate: '@escalate' },
  },
  {
    id: 'fix-handoff',
    title: 'Persist Fix handoff',
    stage: 'close',
    block: 'handoff',
    input: { state: 'flow.state@v1', brief: 'fix.brief@v1' },
    execution: { kind: 'compose' },
    protocol: 'fix-handoff@v1',
    writes: { report_path: 'reports/fix/handoff.json' },
    check: { required: ['goal', 'next_action'] },
    routes: { complete: '@handoff', stop: '@stop' },
  },
];

const fixStageLabels: StageLabelMap = {
  frame: { id: 'frame-stage', title: 'Frame' },
  analyze: { id: 'analyze-stage', title: 'Analyze' },
  act: { id: 'act-stage', title: 'Act' },
  verify: { id: 'verify-stage', title: 'Verify' },
  review: { id: 'review-stage', title: 'Review' },
  close: { id: 'close-stage', title: 'Close' },
};

export const fixAssemblySpec: FlowSchematicAssemblySpec = {
  id: 'fix',
  title: 'Fix Schematic',
  purpose:
    'Fix captures the problem boundary, proves the pre-fix regression before a specialist relay edits the checkout, gathers context, diagnoses, applies a focused change, verifies, reviews at medium depth and above, and closes with evidence. If the reviewer connector is unavailable after proof passes, Fix closes with proof evidence and marks review skipped. Low depth skips the review relay after verification. fix-no-repro-decision and fix-handoff remain as future ask/handoff routing intent; they appear in compiled flows with declared ask/handoff recovery bindings, but the engine does not yet emit any failure cause those bindings accept, so no runtime path reaches them.',
  status: 'active',
  version: '0.1.0',
  initial_contracts: [
    'task.intake@v1',
    'route.decision@v1',
    'context.request@v1',
    'flow.question@v1',
    'verification.plan@v1',
    'flow.state@v1',
  ],
  contract_aliases: [
    { generic: 'flow.brief@v1', actual: 'fix.brief@v1' },
    { generic: 'context.packet@v1', actual: 'fix.context@v1' },
    { generic: 'diagnosis.result@v1', actual: 'fix.diagnosis@v1' },
    { generic: 'decision.answer@v1', actual: 'fix.no-repro-decision@v1' },
    { generic: 'flow.evidence@v1', actual: 'fix.diagnosis@v1' },
    { generic: 'change.evidence@v1', actual: 'fix.change@v1' },
    { generic: 'verification.result@v1', actual: 'fix.verification@v1' },
    { generic: 'verification.result@v1', actual: 'fix.regression-proof@v1' },
    { generic: 'verification.result@v1', actual: 'fix.baseline-snapshot@v1' },
    { generic: 'verification.result@v1', actual: 'fix.regression-rerun@v1' },
    { generic: 'verification.result@v1', actual: 'fix.change-set@v1' },
    { generic: 'verification.result@v1', actual: 'fix.final-change-set@v1' },
    { generic: 'review.verdict@v1', actual: 'fix.review@v1' },
    { generic: 'flow.result@v1', actual: 'fix.result@v1' },
  ],
  axes: {
    allowed_depths: ['low', 'medium', 'high'],
    supports_tournament: false,
    supports_autonomous: true,
    default: { depth: 'medium', tournament: false, tournament_n: 3, autonomous: false },
  },
  // Stage 3 (first-class composition): fix DECLARES the terminal-outcome bind on
  // its schematic, exactly as goal does (../goal/assembly-spec.ts). The compiler
  // propagates it to the compiled manifest and the engine reads it through
  // `resolveEngineFlags`, so an @complete close is downgraded to a non-success
  // run outcome whenever fix's primary result (reports/fix-result.json) reports a
  // degraded outcome such as `partial`. Fix's success words `fixed` /
  // `not-reproduced` are not degraded, so a clean fix still closes complete.
  engine_flags: {
    binds_terminal_outcome_to_primary_result: true,
  },
  // Stage 3b (first-class composition): fix's report file surfaces ride the
  // schematic onto the compiled manifest, so the engine reads the skill-hook
  // edit-file surface table off the manifest, not the by-id catalog package.
  report_file_surfaces: {
    'fix.change-set@v1': {
      timing: 'after',
      extractor: { kind: 'string-array-field', field: 'observed' },
    },
  },
  items: fixBlockItems,
  stageLabels: fixStageLabels,
  stagePathRationale: FIX_STAGE_PATH_RATIONALE,
};
