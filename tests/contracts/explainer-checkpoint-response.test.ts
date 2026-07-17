import { describe, expect, it } from 'vitest';

import { ExplainerCheckpointResponse } from '../../src/flows/explainer/reports.js';

describe('Explainer checkpoint response', () => {
  it('accepts the optional comments written by the shared checkpoint executor', () => {
    const parsed = ExplainerCheckpointResponse.parse({
      schema_version: 1,
      step_id: 'pick-step',
      selection: 'concept-b',
      route_id: 'continue',
      resolution_source: 'operator',
      comments: [
        {
          scope: 'choice',
          choice_id: 'concept-a',
          body: 'The opening is stronger, but the example is too narrow.',
        },
        { scope: 'overall', body: 'Keep the final page calm and direct.' },
      ],
    });

    expect(parsed.comments).toHaveLength(2);
  });
});
