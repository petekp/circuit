import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ExploreAnalysis,
  ExploreAspect,
  ExploreBrief,
  ExploreCompose,
  ExploreComposeAspect,
  ExploreDefaultResult,
  ExploreEvidenceCitation,
  ExploreResult,
  ExploreResultReportPointer,
  ExploreReviewVerdict,
  ExploreReviewVerdictValue,
  ExploreRubricModelJudgments,
  ExploreTournamentAggregate,
  ExploreTournamentProposal,
  ExploreTournamentResult,
} from '../../src/flows/explore/reports.js';
import { combineRubricResult } from '../../src/policy/rubric.js';
import { CompiledFlow } from '../../src/schemas/compiled-flow.js';

const EXPLORE_FIXTURE_PATH = resolve('generated/flows/explore/circuit.json');

function loadExploreCompiledFlow(): CompiledFlow {
  return CompiledFlow.parse(JSON.parse(readFileSync(EXPLORE_FIXTURE_PATH, 'utf8')));
}

const PASSING_RUBRIC_MODEL_JUDGMENTS = {
  evidence_rigor: 'pass',
  actionability: 'pass',
  coverage_adequacy: 'pass',
  scope_discipline: 'pass',
  honest_calibration: 'pass',
  project_specificity: 'pass',
  insight_density: 'pass',
  branch_distinctness: 'pass',
} as const;

function passingRubricResult() {
  return combineRubricResult({
    orderedDims: Object.keys(PASSING_RUBRIC_MODEL_JUDGMENTS),
    dims: {
      evidence_rigor: { runtime_signal: 'met', model_judgment: 'pass' },
      actionability: { runtime_signal: 'met', model_judgment: 'pass' },
      coverage_adequacy: { runtime_signal: 'met', model_judgment: 'pass' },
      scope_discipline: { runtime_signal: 'met', model_judgment: 'pass' },
      honest_calibration: { runtime_signal: 'n/a', model_judgment: 'pass' },
      project_specificity: { runtime_signal: 'n/a', model_judgment: 'pass' },
      insight_density: { runtime_signal: 'n/a', model_judgment: 'pass' },
      branch_distinctness: { runtime_signal: 'n/a', model_judgment: 'pass' },
    },
  });
}

function defaultResultPointers(): ExploreResultReportPointer[] {
  return [
    ExploreResultReportPointer.parse({
      report_id: 'explore.brief',
      path: 'reports/brief.json',
      schema: 'explore.brief@v1',
    }),
    ExploreResultReportPointer.parse({
      report_id: 'explore.analysis',
      path: 'reports/analysis.json',
      schema: 'explore.analysis@v1',
    }),
    ExploreResultReportPointer.parse({
      report_id: 'explore.compose',
      path: 'reports/compose.json',
      schema: 'explore.compose@v1',
    }),
    ExploreResultReportPointer.parse({
      report_id: 'explore.review-verdict',
      path: 'reports/review-verdict.json',
      schema: 'explore.review-verdict@v1',
    }),
  ];
}

function tournamentResultPointers(): ExploreResultReportPointer[] {
  return [
    ExploreResultReportPointer.parse({
      report_id: 'explore.brief',
      path: 'reports/brief.json',
      schema: 'explore.brief@v1',
    }),
    ExploreResultReportPointer.parse({
      report_id: 'explore.analysis',
      path: 'reports/analysis.json',
      schema: 'explore.analysis@v1',
    }),
    ExploreResultReportPointer.parse({
      report_id: 'explore.decision-options',
      path: 'reports/decision-options.json',
      schema: 'explore.decision-options@v1',
    }),
    ExploreResultReportPointer.parse({
      report_id: 'explore.tournament-aggregate',
      path: 'reports/tournament-aggregate.json',
      schema: 'explore.tournament-aggregate@v1',
    }),
    ExploreResultReportPointer.parse({
      report_id: 'explore.tournament-review',
      path: 'reports/tournament-review.json',
      schema: 'explore.tournament-review@v1',
    }),
    ExploreResultReportPointer.parse({
      report_id: 'explore.decision',
      path: 'reports/decision.json',
      schema: 'explore.decision@v1',
    }),
  ];
}

describe('explore report schemas', () => {
  it('accepts the typed explore.brief shape', () => {
    expect(
      ExploreBrief.parse({
        subject: 'Investigate the runtime',
        task: 'Find the next risk',
        success_condition: 'A clear recommendation exists',
      }),
    ).toEqual({
      subject: 'Investigate the runtime',
      task: 'Find the next risk',
      success_condition: 'A clear recommendation exists',
    });
  });

  it('rejects surplus keys in explore.brief', () => {
    const parsed = ExploreBrief.safeParse({
      subject: 'Investigate the runtime',
      task: 'Find the next risk',
      success_condition: 'A clear recommendation exists',
      smuggled: true,
    });

    expect(parsed.success).toBe(false);
  });

  it('accepts evidence-backed explore.analysis aspects', () => {
    const evidence = ExploreEvidenceCitation.parse({
      source: 'reports/brief.json',
      summary: 'The brief asks for runtime risk analysis',
    });
    const aspect = ExploreAspect.parse({
      name: 'runtime-risk',
      summary: 'The runtime path is the relevant subject',
      evidence: [evidence],
    });

    expect(
      ExploreAnalysis.parse({
        subject: 'Investigate the runtime',
        aspects: [aspect],
      }),
    ).toEqual({
      subject: 'Investigate the runtime',
      aspects: [aspect],
    });
  });

  it('rejects explore.analysis without at least one aspect and one evidence citation', () => {
    expect(
      ExploreAnalysis.safeParse({
        subject: 'Investigate the runtime',
        aspects: [],
      }).success,
    ).toBe(false);

    expect(
      ExploreAnalysis.safeParse({
        subject: 'Investigate the runtime',
        aspects: [{ name: 'runtime-risk', summary: 'No evidence', evidence: [] }],
      }).success,
    ).toBe(false);
  });

  it('accepts the typed explore.compose shape', () => {
    const supportingAspect = ExploreComposeAspect.parse({
      aspect: 'runtime-risk',
      contribution: 'Identifies the runtime path most likely to affect users',
      evidence_refs: ['reports/analysis.json'],
    });

    expect(
      ExploreCompose.parse({
        verdict: 'accept',
        subject: 'Investigate the runtime',
        recommendation: 'Harden the report writer first',
        success_condition_alignment: 'The recommendation names the next action',
        supporting_aspects: [supportingAspect],
      }),
    ).toEqual({
      verdict: 'accept',
      subject: 'Investigate the runtime',
      recommendation: 'Harden the report writer first',
      success_condition_alignment: 'The recommendation names the next action',
      supporting_aspects: [supportingAspect],
    });
  });

  it('rejects explore.compose without a recommendation and supporting aspect', () => {
    expect(
      ExploreCompose.safeParse({
        verdict: 'accept',
        subject: 'Investigate the runtime',
        success_condition_alignment: 'The recommendation names the next action',
        supporting_aspects: [
          {
            aspect: 'runtime-risk',
            contribution: 'Identifies the runtime path most likely to affect users',
            evidence_refs: ['reports/analysis.json'],
          },
        ],
      }).success,
    ).toBe(false);

    expect(
      ExploreCompose.safeParse({
        verdict: 'accept',
        subject: 'Investigate the runtime',
        recommendation: 'Harden the report writer first',
        success_condition_alignment: 'The recommendation names the next action',
        supporting_aspects: [],
      }).success,
    ).toBe(false);
  });

  it('rejects surplus keys in explore.compose and nested supporting aspects', () => {
    expect(
      ExploreCompose.safeParse({
        verdict: 'accept',
        subject: 'Investigate the runtime',
        recommendation: 'Harden the report writer first',
        success_condition_alignment: 'The recommendation names the next action',
        supporting_aspects: [
          {
            aspect: 'runtime-risk',
            contribution: 'Identifies the runtime path most likely to affect users',
            evidence_refs: ['reports/analysis.json'],
          },
        ],
        smuggled: true,
      }).success,
    ).toBe(false);

    expect(
      ExploreCompose.safeParse({
        verdict: 'accept',
        subject: 'Investigate the runtime',
        recommendation: 'Harden the report writer first',
        success_condition_alignment: 'The recommendation names the next action',
        supporting_aspects: [
          {
            aspect: 'runtime-risk',
            contribution: 'Identifies the runtime path most likely to affect users',
            evidence_refs: ['reports/analysis.json'],
            smuggled: true,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects explore.compose supporting aspects without evidence references', () => {
    expect(
      ExploreComposeAspect.safeParse({
        aspect: 'runtime-risk',
        contribution: 'Identifies the runtime path most likely to affect users',
      }).success,
    ).toBe(false);
  });

  it('accepts the typed explore.review-verdict shape with empty objection lists', () => {
    expect(
      ExploreReviewVerdict.parse({
        verdict: 'accept',
        overall_assessment: 'The compose covers the requested scope',
        objections: [],
        missed_angles: [],
      }),
    ).toEqual({
      verdict: 'accept',
      overall_assessment: 'The compose covers the requested scope',
      objections: [],
      missed_angles: [],
    });
  });

  it('accepts a blocking reject verdict so the reviewer can route the compose to rework', () => {
    expect(
      ExploreReviewVerdict.safeParse({
        verdict: 'reject',
        overall_assessment: 'The compose misses the requested scope',
        objections: ['Missing evidence'],
        missed_angles: [],
      }).success,
    ).toBe(true);
  });

  it('rejects invalid explore.review-verdict verdicts and surplus keys', () => {
    expect(
      ExploreReviewVerdict.safeParse({
        verdict: 'needs-work',
        overall_assessment: 'The compose misses the requested scope',
        objections: ['Missing evidence'],
        missed_angles: [],
      }).success,
    ).toBe(false);

    expect(
      ExploreReviewVerdict.safeParse({
        verdict: 'accept-with-fold-ins',
        overall_assessment: 'The compose is usable with a follow-up',
        objections: ['Clarify the migration risk'],
        missed_angles: ['Operational rollout'],
        smuggled: true,
      }).success,
    ).toBe(false);
  });

  it('accepts tournament proposals with all eight model rubric judgments', () => {
    const proposal = ExploreTournamentProposal.parse({
      verdict: 'accept',
      option_id: 'option-1',
      option_label: 'Keep the proof path',
      case_summary: 'The proposal keeps the proof path simple.',
      assumptions: ['The branch can be implemented in one slice.'],
      evidence_refs: ['reports/decision-options.json'],
      risks: ['The fixture is synthetic.'],
      next_action: 'Run Build on the selected option.',
      rubric_model_judgments: PASSING_RUBRIC_MODEL_JUDGMENTS,
    });

    expect(proposal.rubric_model_judgments).toEqual(PASSING_RUBRIC_MODEL_JUDGMENTS);
  });

  it('rejects tournament proposals missing any model rubric judgment', () => {
    expect(
      ExploreRubricModelJudgments.safeParse({
        evidence_rigor: 'pass',
        actionability: 'pass',
        coverage_adequacy: 'pass',
        scope_discipline: 'pass',
        honest_calibration: 'pass',
        project_specificity: 'pass',
        insight_density: 'pass',
      }).success,
    ).toBe(false);
  });

  it('accepts tournament aggregates with one RubricResult per completed option', () => {
    const aggregate = ExploreTournamentAggregate.parse({
      schema_version: 1,
      join_policy: 'aggregate-survivors',
      branch_count: 1,
      branches: [
        {
          branch_id: 'option-1',
          child_run_id: 'option-1-run',
          child_outcome: 'complete',
          verdict: 'accept',
          admitted: true,
          result_path: 'reports/tournament-branches/option-1/report.json',
          duration_ms: 1,
          result_body: {
            verdict: 'accept',
            option_id: 'option-1',
            option_label: 'Keep the proof path',
            case_summary: 'The proposal keeps the proof path simple.',
            assumptions: ['The branch can be implemented in one slice.'],
            evidence_refs: ['reports/decision-options.json'],
            risks: ['The fixture is synthetic.'],
            next_action: 'Run Build on the selected option.',
            rubric_model_judgments: PASSING_RUBRIC_MODEL_JUDGMENTS,
          },
          rubric_result: passingRubricResult(),
        },
      ],
    });

    const branch = aggregate.branches[0];
    expect(branch?.rubric_result?.dims).toHaveProperty('evidence_rigor');
    expect(Object.keys(branch?.rubric_result?.dims ?? {}).sort()).toEqual(
      Object.keys(PASSING_RUBRIC_MODEL_JUDGMENTS).sort(),
    );
  });

  it('rejects completed tournament aggregate branches without rubric_result', () => {
    expect(
      ExploreTournamentAggregate.safeParse({
        schema_version: 1,
        join_policy: 'aggregate-survivors',
        branch_count: 1,
        branches: [
          {
            branch_id: 'option-1',
            child_run_id: 'option-1-run',
            child_outcome: 'complete',
            verdict: 'accept',
            admitted: true,
            result_path: 'reports/tournament-branches/option-1/report.json',
            duration_ms: 1,
            result_body: {
              verdict: 'accept',
              option_id: 'option-1',
              option_label: 'Keep the proof path',
              case_summary: 'The proposal keeps the proof path simple.',
              assumptions: ['The branch can be implemented in one slice.'],
              evidence_refs: ['reports/decision-options.json'],
              risks: ['The fixture is synthetic.'],
              next_action: 'Run Build on the selected option.',
              rubric_model_judgments: PASSING_RUBRIC_MODEL_JUDGMENTS,
            },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('keeps explore.review-verdict verdict vocabulary aligned with the fixture check', () => {
    const flow = loadExploreCompiledFlow();
    const reviewStep = flow.steps.find((step) => step.id === 'review-step');
    if (reviewStep?.kind !== 'relay') throw new Error('expected review-step relay');

    // The pass list is a strict subset of the schema vocabulary: 'reject'
    // is schema-valid but not a pass verdict, which is exactly the
    // mechanism that routes a rejected compose back to synthesize-step.
    expect(reviewStep.check.pass).toEqual(['accept', 'accept-with-fold-ins']);
    expect([...ExploreReviewVerdictValue.options]).toEqual([...reviewStep.check.pass, 'reject']);
  });

  it('accepts the typed explore.result aggregate shape', () => {
    const pointers = defaultResultPointers();
    const body = {
      summary: 'Explore recommendation: keep the aggregate deterministic',
      verdict_snapshot: {
        compose_verdict: 'accept',
        review_verdict: 'accept-with-fold-ins',
        objection_count: 1,
        missed_angle_count: 1,
      },
      review_fold_ins: {
        overall_assessment: 'The compose is usable with a follow-up',
        objections: ['Clarify the downstream consumer'],
        missed_angles: ['Check the host summary output'],
      },
      evidence_links: pointers,
    };

    expect(ExploreDefaultResult.parse(body)).toEqual({
      summary: 'Explore recommendation: keep the aggregate deterministic',
      verdict_snapshot: {
        compose_verdict: 'accept',
        review_verdict: 'accept-with-fold-ins',
        objection_count: 1,
        missed_angle_count: 1,
      },
      review_fold_ins: {
        overall_assessment: 'The compose is usable with a follow-up',
        objections: ['Clarify the downstream consumer'],
        missed_angles: ['Check the host summary output'],
      },
      evidence_links: pointers,
    });
    expect(ExploreResult.parse(body)).toEqual(ExploreDefaultResult.parse(body));
  });

  it('accepts the typed tournament explore.result branch without review fold-ins', () => {
    const pointers = tournamentResultPointers();
    const body = {
      summary: "Explore 'decide: React vs Vue': Choose Vue.",
      verdict_snapshot: {
        decision_verdict: 'decided',
        tournament_review_verdict: 'recommend',
        selected_option_id: 'option-2',
        objection_count: 1,
        missing_evidence_count: 0,
      },
      evidence_links: pointers,
    };

    expect(ExploreTournamentResult.parse(body)).toEqual(body);
    expect(ExploreResult.parse(body)).toEqual(body);
  });

  it('rejects default explore.result when fold-ins are signaled but missing', () => {
    const pointers = defaultResultPointers();

    expect(
      ExploreResult.safeParse({
        summary: 'Missing fold-ins for a fold-in verdict',
        verdict_snapshot: {
          compose_verdict: 'accept',
          review_verdict: 'accept-with-fold-ins',
          objection_count: 0,
          missed_angle_count: 0,
        },
        evidence_links: pointers,
      }).success,
    ).toBe(false);

    expect(
      ExploreResult.safeParse({
        summary: 'Missing fold-ins for nonzero counts',
        verdict_snapshot: {
          compose_verdict: 'accept',
          review_verdict: 'accept',
          objection_count: 1,
          missed_angle_count: 0,
        },
        evidence_links: pointers,
      }).success,
    ).toBe(false);
  });

  it('rejects default explore.result when fold-in counts do not match the arrays', () => {
    const pointers = defaultResultPointers();

    expect(
      ExploreResult.safeParse({
        summary: 'Mismatched fold-in counts',
        verdict_snapshot: {
          compose_verdict: 'accept',
          review_verdict: 'accept-with-fold-ins',
          objection_count: 2,
          missed_angle_count: 1,
        },
        review_fold_ins: {
          overall_assessment: 'The compose is usable with follow-ups',
          objections: ['Only one objection is present'],
          missed_angles: [],
        },
        evidence_links: pointers,
      }).success,
    ).toBe(false);
  });

  it('rejects review fold-ins on tournament explore.result', () => {
    expect(
      ExploreResult.safeParse({
        summary: "Explore 'decide: React vs Vue': Choose Vue.",
        verdict_snapshot: {
          decision_verdict: 'decided',
          tournament_review_verdict: 'recommend',
          selected_option_id: 'option-2',
          objection_count: 1,
          missing_evidence_count: 0,
        },
        review_fold_ins: {
          overall_assessment: 'Tournament branches use their own decision structure',
          objections: [],
          missed_angles: [],
        },
        evidence_links: tournamentResultPointers(),
      }).success,
    ).toBe(false);
  });

  it('rejects explore.result with missing pointers, invalid review verdict, or surplus keys', () => {
    expect(
      ExploreResult.safeParse({
        summary: 'Missing one pointer',
        verdict_snapshot: {
          compose_verdict: 'accept',
          review_verdict: 'accept',
          objection_count: 0,
          missed_angle_count: 0,
        },
        evidence_links: [
          {
            report_id: 'explore.compose',
            path: 'reports/compose.json',
            schema: 'explore.compose@v1',
          },
        ],
      }).success,
    ).toBe(false);

    expect(
      ExploreResult.safeParse({
        summary: 'Invalid review verdict',
        verdict_snapshot: {
          compose_verdict: 'accept',
          review_verdict: 'reject',
          objection_count: 0,
          missed_angle_count: 0,
        },
        evidence_links: [],
      }).success,
    ).toBe(false);

    expect(
      ExploreResult.safeParse({
        summary: 'Extra field',
        verdict_snapshot: {
          compose_verdict: 'accept',
          review_verdict: 'accept',
          objection_count: 0,
          missed_angle_count: 0,
        },
        evidence_links: [],
        smuggled: true,
      }).success,
    ).toBe(false);
  });

  it('rejects explore.result pointer duplicates and report/schema mismatches', () => {
    expect(
      ExploreResultReportPointer.safeParse({
        report_id: 'explore.brief',
        path: 'reports/brief.json',
        schema: 'explore.compose@v1',
      }).success,
    ).toBe(false);

    expect(
      ExploreResult.safeParse({
        summary: 'Duplicate pointer ids',
        verdict_snapshot: {
          compose_verdict: 'accept',
          review_verdict: 'accept',
          objection_count: 0,
          missed_angle_count: 0,
        },
        evidence_links: [
          {
            report_id: 'explore.brief',
            path: 'reports/brief.json',
            schema: 'explore.brief@v1',
          },
          {
            report_id: 'explore.brief',
            path: 'reports/brief-copy.json',
            schema: 'explore.brief@v1',
          },
          {
            report_id: 'explore.compose',
            path: 'reports/compose.json',
            schema: 'explore.compose@v1',
          },
          {
            report_id: 'explore.review-verdict',
            path: 'reports/review-verdict.json',
            schema: 'explore.review-verdict@v1',
          },
        ],
      }).success,
    ).toBe(false);
  });
});
