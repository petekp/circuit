// Explainer intake compose writer.
//
// Deterministic projection of the run goal into the framing report: subject,
// how to find the source paper, the operator house-style files the build must
// honor, and the success condition. A real run supplies the paper path in the
// goal; this writer keeps schematic execution honest with no operator input.

import type {
  ComposeBuildContext,
  ComposeBuilder,
} from '../../registries/compose-writers/types.js';
import { ExplainerIntake } from '../reports.js';

// The operator's house-style spec files (the-gap/spec/*). Referenced by name so
// the flow runs anywhere; the build sub-run resolves them in the paper repo.
const HOUSE_STYLE_REFERENCES = [
  'VISUAL_SYSTEM.md',
  'MOTION_ARCHITECTURE.md',
  'COPY_DECK.md',
  'FIDELITY_CITATIONS.md',
] as const;

function successCondition(goal: string): string {
  return [
    `Ship an interactive web explainer for: ${goal}.`,
    'It must teach the paper’s actual driver (never the seductive wrong one), obey the house-style specs, and survive an operator fidelity sign-off before publishing.',
  ].join(' ');
}

export const explainerIntakeComposeBuilder: ComposeBuilder = {
  resultSchemaName: 'explainer.intake@v1',
  build(context: ComposeBuildContext): unknown {
    return ExplainerIntake.parse({
      subject: context.goal,
      paper_reference: context.goal,
      house_style_references: [...HOUSE_STYLE_REFERENCES],
      success_condition: successCondition(context.goal),
    });
  },
};
