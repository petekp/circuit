import { describe, expect, it } from 'vitest';

import { exploreTournamentProjector } from '../../../../src/flows/explore/index.js';
import type { HtmlProjectorContext, JsonObject } from '../../../../src/shared/html/projector.js';

function buildContext(overrides: {
  readonly flowReport?: JsonObject;
  readonly evidence?: Record<string, JsonObject>;
}): HtmlProjectorContext {
  const evidence = overrides.evidence ?? {};
  return {
    runFolder: '/tmp/run-folder',
    runId: 'run-test',
    flowId: 'explore',
    runOutcome: 'complete',
    flowReport: overrides.flowReport,
    readJsonRunRelative: () => undefined,
    readEvidenceReportById: (id) => evidence[id],
  };
}

const validOptions = {
  decision_question: 'Which framework should we pick?',
  recommendation_basis: 'tournament-aggregate@v1 + tournament-review@v1',
  options: [
    {
      id: 'option-1',
      label: 'React',
      summary: 'Mature, large community.',
      best_case_prompt: 'Bootstrap a React prototype.',
      evidence_refs: ['reports/analysis.json#aspect-react'],
      tradeoffs: ['Larger surface area'],
    },
    {
      id: 'option-2',
      label: 'Vue',
      summary: 'Smaller surface, faster iteration.',
      best_case_prompt: 'Bootstrap a Vue prototype.',
      evidence_refs: ['reports/analysis.json#aspect-vue'],
      tradeoffs: ['Thinner ecosystem'],
    },
  ],
};

const validReview = {
  verdict: 'recommend',
  recommended_option_id: 'option-2',
  comparison: 'Vue wins on iteration speed.',
  objections: ['Vue ecosystem is thinner.'],
  missing_evidence: ['No data on team Vue experience.'],
  tradeoff_question: 'Speed vs hiring familiarity?',
  confidence: 'high',
};

const validDecision = {
  verdict: 'decided',
  decision_question: 'Which framework should we pick?',
  selected_option_id: 'option-2',
  selected_option_label: 'Vue',
  decision: 'Choose Vue.',
  rationale: 'Vue gives the fastest path.',
  rejected_options: [{ option_id: 'option-1', reason: 'Slower for this team.' }],
  evidence_links: ['reports/decision-options.json'],
  assumptions: ['Team can learn Vue quickly.'],
  residual_risks: ['Hiring familiarity may be thinner.'],
  next_action: 'Run a Build plan.',
  follow_up_workflow: 'Build',
};

const decidedFlowReport = {
  summary: "Explore 'pick framework': Choose Vue.",
  verdict_snapshot: { decision_verdict: 'decided', selected_option_id: 'option-2' },
};

const allEvidence: Record<string, JsonObject> = {
  'explore.decision-options': validOptions,
  'explore.tournament-review': validReview,
  'explore.decision': validDecision,
};

describe('exploreTournamentProjector — gating', () => {
  it('returns undefined when verdict_snapshot is missing', () => {
    expect(exploreTournamentProjector(buildContext({ evidence: allEvidence }))).toBeUndefined();
  });

  it('returns undefined when decision_verdict is not "decided"', () => {
    const ctx = buildContext({
      flowReport: { verdict_snapshot: { decision_verdict: 'pending' } },
      evidence: allEvidence,
    });
    expect(exploreTournamentProjector(ctx)).toBeUndefined();
  });

  it('returns undefined when decision-options evidence is missing', () => {
    const ctx = buildContext({
      flowReport: decidedFlowReport,
      evidence: {
        'explore.tournament-review': validReview,
        'explore.decision': validDecision,
      },
    });
    expect(exploreTournamentProjector(ctx)).toBeUndefined();
  });

  it('returns undefined when any evidence schema parse fails', () => {
    const malformedReview = { ...validReview, verdict: 'not-a-real-verdict' };
    const ctx = buildContext({
      flowReport: decidedFlowReport,
      evidence: { ...allEvidence, 'explore.tournament-review': malformedReview },
    });
    expect(exploreTournamentProjector(ctx)).toBeUndefined();
  });
});

describe('exploreTournamentProjector — rendering', () => {
  it('emits a complete HTML document with the decision question as headline', () => {
    const html = exploreTournamentProjector(
      buildContext({ flowReport: decidedFlowReport, evidence: allEvidence }),
    );
    expect(html).toBeDefined();
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<title>Which framework should we pick? · Circuit Explore</title>');
    expect(html).toMatch(/<h1[^>]*>Which framework should we pick\?<\/h1>/);
  });

  it('marks the recommended option with intent-info and the selected option with intent-positive', () => {
    const html = exploreTournamentProjector(
      buildContext({ flowReport: decidedFlowReport, evidence: allEvidence }),
    ) as string;
    // option-2 is BOTH recommended and selected — selected wins in visual hierarchy.
    expect(html).toMatch(/data-slot="card"[^>]*data-intent="positive"/);
    expect(html).toMatch(/data-intent="positive"[^>]*>Selected</);
  });

  it('marks the recommended option with intent-info when a different option is selected', () => {
    const decisionDifferentSelection = {
      ...validDecision,
      selected_option_id: 'option-1',
      selected_option_label: 'React',
    };
    const html = exploreTournamentProjector(
      buildContext({
        flowReport: decidedFlowReport,
        evidence: { ...allEvidence, 'explore.decision': decisionDifferentSelection },
      }),
    ) as string;
    // The recommendation badge carries the info intent; the selected badge stays positive.
    expect(html).toMatch(/data-intent="info"[^>]*>Recommended</);
    expect(html).toMatch(/data-intent="positive"[^>]*>Selected</);
  });

  it('escapes HTML metacharacters in operator-controlled fields (XSS defense)', () => {
    const optionsWithXss = {
      ...validOptions,
      decision_question: 'Which <script>alert(1)</script> framework?',
      options: [
        validOptions.options[0],
        { ...validOptions.options[1], label: 'Vue <img src=x onerror=alert(2)>' },
      ],
    };
    const html = exploreTournamentProjector(
      buildContext({
        flowReport: decidedFlowReport,
        evidence: { ...allEvidence, 'explore.decision-options': optionsWithXss },
      }),
    ) as string;
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x onerror=alert(2)>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(2)&gt;');
  });

  it('strips bidi overrides from option labels so the operator cannot be visually deceived', () => {
    // U+202E reverses rendering direction; left in markup it could make a
    // "Recommended" badge appear attached to the wrong option.
    const optionsWithBidi = {
      ...validOptions,
      options: [{ ...validOptions.options[0], label: 'React‮evil' }, validOptions.options[1]],
    };
    const html = exploreTournamentProjector(
      buildContext({
        flowReport: decidedFlowReport,
        evidence: { ...allEvidence, 'explore.decision-options': optionsWithBidi },
      }),
    ) as string;
    expect(html).not.toContain('‮');
    expect(html).toContain('Reactevil');
  });

  it('renders confidence text in lowercase', () => {
    const html = exploreTournamentProjector(
      buildContext({ flowReport: decidedFlowReport, evidence: allEvidence }),
    ) as string;
    expect(html).toContain('high confidence');
  });

  it('includes the rationale, residual risks, and next action in the details section', () => {
    const html = exploreTournamentProjector(
      buildContext({ flowReport: decidedFlowReport, evidence: allEvidence }),
    ) as string;
    expect(html).toContain('<strong>Rationale.</strong>');
    expect(html).toContain('Vue gives the fastest path.');
    expect(html).toContain('<strong>Residual risks.</strong>');
    expect(html).toContain('Hiring familiarity may be thinner.');
    expect(html).toContain('<strong>Next action.</strong>');
    expect(html).toContain('Run a Build plan.');
  });
});

// The banner must have a single source of truth. The observed incoherence:
// the tournament recommended one option, the decision selected another, and
// the banner bolded the recommended label next to the selected option's
// decision text — the headline named the wrong option.
describe('exploreTournamentProjector — banner coherence', () => {
  function extractBanner(html: string): string {
    const start = html.indexOf('data-slot="verdict"');
    expect(start).toBeGreaterThan(-1);
    return html.slice(start, html.indexOf('</div>', start));
  }

  it('names the selected option in the banner when selection and recommendation disagree', () => {
    const decisionDifferentSelection = {
      ...validDecision,
      selected_option_id: 'option-1',
      selected_option_label: 'React',
      decision: 'Choose React for ecosystem depth.',
    };
    const html = exploreTournamentProjector(
      buildContext({
        flowReport: decidedFlowReport,
        evidence: { ...allEvidence, 'explore.decision': decisionDifferentSelection },
      }),
    ) as string;

    const banner = extractBanner(html);
    // The decision leads: the banner bolds React and reads Selected. The
    // losing recommendation must not be the headline.
    expect(banner).toContain('<strong>React</strong>');
    expect(banner).toContain('Selected');
    expect(banner).not.toContain('<strong>Vue</strong>');
  });

  it('still names the decided option when selection matches the recommendation', () => {
    const html = exploreTournamentProjector(
      buildContext({ flowReport: decidedFlowReport, evidence: allEvidence }),
    ) as string;
    const banner = extractBanner(html);
    expect(banner).toContain('<strong>Vue</strong>');
    expect(banner).not.toContain('<strong>React</strong>');
  });
});
