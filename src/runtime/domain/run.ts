// Single source of truth: the run-closed outcome enum lives on the durable
// trace-entry schema (`schemas/trace-entry.ts`). Re-export the inferred type
// here so runtime modules keep importing it from the domain layer without a
// hand-maintained second copy of the literal set.
export type { RunClosedOutcome } from '../../schemas/trace-entry.js';

// The runtime RunId is a plain string at this boundary: graph-runner accepts a
// caller-supplied run id and only brand-validates it (via `schemas/ids.ts`
// `RunId.parse`) when constructing refs. Keep it a structural string here so
// the runtime contract does not force every caller to mint a branded UUID.
export type RunId = string;

export type RuntimeRunStatus =
  | 'not_started'
  | 'running'
  | 'complete'
  | 'aborted'
  | 'evidence_invalid'
  | 'handoff'
  | 'stopped'
  | 'escalated';
