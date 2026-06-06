// Shared continuity-record fixtures for the CONT-I* invariant family
// (continuity-schema.test.ts).

export const CONT_RUN = '0191d2f0-cccc-7fff-8aaa-000000000030' as const;

export const CONT_NARRATIVE = {
  goal: 'Resume circuit work',
  next: 'Read PROJECT_STATE.md',
  state_markdown: '- state',
  debt_markdown: '- debt',
} as const;

export const CONT_RUN_PROVENANCE = {
  run_id: CONT_RUN,
  current_stage: 'frame',
  current_step: 'frame-goal',
  runtime_status: 'in_progress',
  runtime_updated_at: '2026-04-19T00:00:00.000Z',
} as const;

export const CONT_AMBIENT_PROVENANCE = {
  transcript_path: '/Users/x/.claude/projects/-Users-x-Code/abc.jsonl',
  session_id: 'abc-session',
  source: 'stop',
} as const;
