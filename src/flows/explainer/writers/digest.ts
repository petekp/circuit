// Explainer digest compose writer.
//
// v1 emits the lossless-outline SCAFFOLD deterministically: the principle the
// digest must obey plus one notation row and one outline section that name the
// shape a real digest fills from the paper. A deterministic writer cannot read
// the source paper, so it cannot author the dense, addressable outline itself —
// promoting this step to a model-authored relay (researcher reads the paper,
// emits explainer.digest@v1) is the flow's primary enrichment. Until then the
// scaffold keeps the spine runnable and schema-valid, and the downstream
// ideation/tournament steps are where the real model work happens.

import type {
  ComposeBuildContext,
  ComposeBuilder,
} from '../../registries/compose-writers/types.js';
import { ExplainerDigest, ExplainerIntake } from '../reports.js';

const LOSSLESS_PRINCIPLE = [
  'The outline is unsummarizable: every line is load-bearing and addressable (O:N).',
  'It is dense lookup, not narrative, and it teaches the paper’s actual driver — never the seductive wrong one.',
].join(' ');

export const explainerDigestComposeBuilder: ComposeBuilder = {
  resultSchemaName: 'explainer.digest@v1',
  reads: [{ name: 'intake', schema: 'explainer.intake@v1', required: true }],
  build(context: ComposeBuildContext): unknown {
    const intake = ExplainerIntake.parse(context.inputs.intake);
    return ExplainerDigest.parse({
      subject: intake.subject,
      lossless_principle: LOSSLESS_PRINCIPLE,
      // Scaffold rows/sections: schema-valid placeholders that name what a real
      // digest fills. The ideation step reads these as the fidelity spine.
      notation_rows: [
        {
          symbol: '<symbol>',
          name: '<name from the paper>',
          definition: '<one-line definition, lookup not narrative>',
          role: 'the actual driver this symbol carries, stated plainly',
        },
      ],
      outline_sections: [
        {
          section_id: 'O:1',
          title: `Setup — what ${intake.subject} actually claims`,
          load_bearing_points: [
            'State the real mechanism the paper teaches.',
            'Name the seductive wrong driver the explainer must NOT teach.',
          ],
        },
      ],
    });
  },
};
