import { describe, expect, it } from 'vitest';

import { tournamentCheckpointPresentation } from '../../src/runtime/projections/tournament-checkpoint-context.js';

// Mirrors the shape a parked Explore tournament run leaves on disk. The
// pre-tournament decision-options labels are derived from the operator's raw
// question and are often mangled ("query needs", a fragment of the goal). The
// tournament aggregate is the source the checkpoint step's `choices_from`
// declares, and it carries the model's post-tournament option labels. The
// presentation must show the configured aggregate labels, not the pre-tournament
// echoes — the F15 finding: a parked checkpoint rendered "option-1 (…question
// echo…)" instead of the real option.
function reader(reports: Record<string, unknown>) {
  return (path: string) => reports[path];
}

describe('tournamentCheckpointPresentation', () => {
  it('labels choices from the configured tournament aggregate, not the pre-tournament options', () => {
    const presentation = tournamentCheckpointPresentation({
      readJson: reader({
        'reports/decision-options.json': {
          options: [
            {
              id: 'option-1',
              label: 'store notes as JSON files on disk or in SQLite? Weigh simplicity',
              summary: 'question echo',
            },
            { id: 'option-2', label: 'query needs', summary: 'fragment' },
          ],
        },
        'reports/tournament-aggregate.json': {
          branches: [
            {
              branch_id: 'option-1',
              child_outcome: 'complete',
              result_body: {
                option_id: 'option-1',
                option_label: 'Store notes as JSON files on disk (simplicity-first)',
                case_summary: 'Simplest path; no query engine needed.',
              },
            },
            {
              branch_id: 'option-2',
              child_outcome: 'complete',
              result_body: {
                option_id: 'option-2',
                option_label: 'Store notes in SQLite (query-ready)',
                case_summary: 'Pays a migration cost now for query power later.',
              },
            },
          ],
        },
      }),
      allowedChoices: ['option-1', 'option-2'],
      fallbackPrompt: 'Choose how to continue this checkpoint.',
      fallbackLabel: (choice) => choice,
      fallbackDescription: (choice) => `Resume with '${choice}'.`,
    });

    expect(presentation.choices[0]?.label).toBe(
      'Store notes as JSON files on disk (simplicity-first)',
    );
    expect(presentation.choices[1]?.label).toBe('Store notes in SQLite (query-ready)');
    expect(presentation.choices[0]?.description).toContain('Simplest path');
  });

  it('falls back to the decision options when no tournament aggregate is present', () => {
    const presentation = tournamentCheckpointPresentation({
      readJson: reader({
        'reports/decision-options.json': {
          options: [{ id: 'option-1', label: 'Conservative path', summary: 'safe choice' }],
        },
      }),
      allowedChoices: ['option-1'],
      fallbackPrompt: 'Choose.',
      fallbackLabel: (choice) => choice,
      fallbackDescription: (choice) => `Resume with '${choice}'.`,
    });

    expect(presentation.choices[0]?.label).toBe('Conservative path');
  });

  it('falls back to the caller-supplied label when neither report names the choice', () => {
    const presentation = tournamentCheckpointPresentation({
      readJson: reader({}),
      allowedChoices: ['option-1'],
      fallbackPrompt: 'Choose.',
      fallbackLabel: (choice) => `policy label for ${choice}`,
      fallbackDescription: (choice) => `Resume with '${choice}'.`,
    });

    expect(presentation.choices[0]?.label).toBe('policy label for option-1');
  });
});
