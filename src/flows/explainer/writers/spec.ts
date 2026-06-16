// Explainer spec compose writer.
//
// Reads the operator's PICK checkpoint response to learn which concept won,
// then assembles the build-ready design law: house-style direction (visual,
// motion, copy), the fidelity citations the build must not violate (lifted
// from the winning tournament branch's evidence plus the hardening pass), and
// the build_brief handed to the child build run. Mirrors explore's decision
// writer (response file -> selected branch -> composed report).

import { readFileSync } from 'node:fs';
import { resolveRunRelative } from '../../../shared/run-relative-path.js';
import type {
  ComposeBuildContext,
  ComposeBuilder,
} from '../../registries/compose-writers/types.js';
import {
  ExplainerHardening,
  ExplainerIdeas,
  ExplainerIntake,
  ExplainerSpec,
  ExplainerTournamentAggregate,
} from '../reports.js';

const PICK_CHECKPOINT_STEP_ID = 'pick-checkpoint-step';

function readJson(runFolder: string, path: string): unknown {
  return JSON.parse(readFileSync(resolveRunRelative(runFolder, path), 'utf8'));
}

function pickResponsePath(context: ComposeBuildContext): string {
  const checkpoint = context.flow.steps.find(
    (step) => step.kind === 'checkpoint' && step.id === PICK_CHECKPOINT_STEP_ID,
  );
  if (checkpoint?.kind !== 'checkpoint') {
    throw new Error('explainer.spec@v1 requires the pick checkpoint step');
  }
  return checkpoint.writes.response;
}

function selectedConceptId(context: ComposeBuildContext): string {
  const response = readJson(context.runFolder, pickResponsePath(context));
  const selection =
    response !== null && typeof response === 'object' && !Array.isArray(response)
      ? (response as Record<string, unknown>).selection
      : undefined;
  if (typeof selection !== 'string' || selection.length === 0) {
    throw new Error('explainer.spec@v1 pick checkpoint response has no string selection');
  }
  return selection;
}

export const explainerSpecComposeBuilder: ComposeBuilder = {
  resultSchemaName: 'explainer.spec@v1',
  reads: [
    { name: 'intake', schema: 'explainer.intake@v1', required: true },
    { name: 'ideas', schema: 'explainer.ideas@v1', required: true },
    { name: 'aggregate', schema: 'explainer.tournament-aggregate@v1', required: true },
    { name: 'hardening', schema: 'explainer.hardening@v1', required: true },
  ],
  build(context: ComposeBuildContext): unknown {
    const intake = ExplainerIntake.parse(context.inputs.intake);
    const ideas = ExplainerIdeas.parse(context.inputs.ideas);
    const aggregate = ExplainerTournamentAggregate.parse(context.inputs.aggregate);
    const hardening = ExplainerHardening.parse(context.inputs.hardening);

    const conceptId = selectedConceptId(context);
    const concept = ideas.concepts.find((entry) => entry.id === conceptId);
    if (concept === undefined) {
      throw new Error(
        `explainer.spec@v1 selected concept '${conceptId}' is not in the ideas report`,
      );
    }
    const branch = aggregate.branches.find((entry) => entry.branch_id === conceptId);
    const proposal = branch?.result_body;

    // Fidelity citations: the winning branch's outline-anchored evidence, plus
    // every banned-phrase finding the hardening pass flagged present. The build
    // must not violate these — they are the "teach the right driver" guardrail.
    const fidelityCitations = [
      ...(proposal?.fidelity_evidence ?? [concept.fidelity_anchor]),
      ...hardening.banned_phrase_findings
        .filter((finding) => finding.present)
        .map((finding) => `Avoid "${finding.phrase}": ${finding.note}`),
    ];

    return ExplainerSpec.parse({
      concept_id: concept.id,
      concept_label: concept.label,
      visual_system: `Apply VISUAL_SYSTEM.md to the ${concept.label}: tokenized palette, type scale, and spacing; no ad-hoc styling.`,
      motion_architecture: `Apply MOTION_ARCHITECTURE.md: motion is explanatory, tied to the ${intake.subject} mechanism, never decorative.`,
      copy_deck:
        'Apply COPY_DECK.md voice; every claim is fidelity-tagged (VERIFIED vs O:N) per FIDELITY_CITATIONS.md.',
      fidelity_citations:
        fidelityCitations.length > 0 ? fidelityCitations : [concept.fidelity_anchor],
      build_brief: [
        `Build an interactive web explainer for ${intake.subject} using the "${concept.label}".`,
        `Honor the house-style specs (${intake.house_style_references.join(', ')}).`,
        'Teach the paper’s actual driver, never the seductive wrong one. Do not deploy; stop at a locally building site.',
      ].join(' '),
    });
  },
};
