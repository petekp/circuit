// Explainer ideation compose writer.
//
// Drafts N scoped concepts for the tournament to fan out over, one per persona
// lens, sized from axes.tournament_n (mirrors explore's decision-options
// writer). Each concept carries a `scoped_prompt` — the best-case advocacy
// instruction the matching tournament branch relay runs under — and a
// `fidelity_anchor` tying it to the lossless outline so a branch cannot drift
// off the paper's real driver. Deterministic in v1; the concepts' bodies are
// thin, but the per-branch relay is where each concept gets argued for real.

import type {
  ComposeBuildContext,
  ComposeBuilder,
} from '../../registries/compose-writers/types.js';
import { ExplainerDigest, ExplainerIdeas, ExplainerIntake } from '../reports.js';

// The operator's three real evaluation personas (proposals/README.md). Concepts
// cycle through them so the tournament ranks genuinely different framings, not
// three flavors of one.
const PERSONAS = [
  {
    label: 'Skeptical economist',
    lens: 'incentives, second-order effects, and whether the claimed driver survives scrutiny',
  },
  {
    label: 'Memetics strategist',
    lens: 'what makes the idea spread without distorting it — the shareable, sticky frame',
  },
  {
    label: 'Product designer / engineer',
    lens: 'what is buildable as an interactive site and reads clearly across audiences',
  },
] as const;

const DEFAULT_CONCEPT_COUNT = 3;

function fidelityAnchor(digest: ExplainerDigest): string {
  return digest.outline_sections[0]?.section_id ?? 'O:1';
}

export const explainerIdeasComposeBuilder: ComposeBuilder = {
  resultSchemaName: 'explainer.ideas@v1',
  reads: [
    { name: 'intake', schema: 'explainer.intake@v1', required: true },
    { name: 'digest', schema: 'explainer.digest@v1', required: true },
  ],
  build(context: ComposeBuildContext): unknown {
    const intake = ExplainerIntake.parse(context.inputs.intake);
    const digest = ExplainerDigest.parse(context.inputs.digest);
    const count = context.axes?.tournament_n ?? DEFAULT_CONCEPT_COUNT;
    const anchor = fidelityAnchor(digest);

    const concepts = Array.from({ length: count }, (_unused, index) => {
      const persona = PERSONAS[index % PERSONAS.length];
      const conceptNumber = index + 1;
      return {
        id: `concept-${conceptNumber}`,
        label: `${persona?.label} framing of ${intake.subject}`,
        summary: `An interactive explainer of ${intake.subject} conceived through the ${persona?.label.toLowerCase()} lens.`,
        lens: persona?.lens ?? 'a distinct framing of the subject',
        scoped_prompt: [
          `Make the strongest evidence-backed case for an interactive web explainer of ${intake.subject},`,
          `conceived through the ${persona?.label.toLowerCase()} lens (${persona?.lens}).`,
          `Cite the lossless outline (${anchor}) to prove it teaches the paper's actual driver, never the seductive wrong one.`,
        ].join(' '),
        fidelity_anchor: anchor,
      };
    });

    return ExplainerIdeas.parse({
      brief_question: `Which framing of ${intake.subject} should we build into an interactive explainer?`,
      concepts,
    });
  },
};
