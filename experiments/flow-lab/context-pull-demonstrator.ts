// On-demand context pull — offline demonstrator (the cheap first cut).
//
// The spec (docs/ideas/on-demand-context-pull.md) asks for a pure-function spike,
// spiked the same way the recompile demonstrator was: author a flow with a
// deliberately thin context envelope, fire a simulated "I need more about Y"
// query, answer it from the parent's typed surface, and SCORE whether targeted
// typed pull beats a fatter push. This module is that spike. It is a throwaway
// in experiments/; it never moves to src/, makes no model calls, touches no
// codebase, and adds no engine seam. It proves the *mechanism and the trade*:
// a minimal envelope plus a targeted pull reaches the same completeness as a fat
// push at a fraction of the carried context, while the conservative defaults
// (no "everything" query, a bounded budget, a recorded trace) hold.
//
// "Count = cost": every number below is computed by this module from the model,
// not asserted by hand, so the test can assert on measured values.

// ---------------------------------------------------------------------------
// The typed surface the parent exposes.
// ---------------------------------------------------------------------------

// One named, typed slice of a parent step's output. `size` is a token/byte proxy
// (the only thing that matters for the cost trade); a real surface would carry a
// schema, but the demonstrator only needs identity + size to score the trade.
export interface SurfaceField {
  readonly id: string;
  readonly size: number;
}

// The parent's whole typed surface for one child step: the declared, queryable
// view over the upstream steps' outputs. Modeled on the explainer pipeline
// (intake -> digest -> ideation -> tournament -> spec) feeding a build child.
export const PARENT_SURFACE: readonly SurfaceField[] = [
  { id: 'intake.paper_title', size: 1 },
  { id: 'intake.full_text', size: 200 },
  { id: 'digest.key_claims', size: 12 },
  { id: 'digest.figure_captions', size: 18 },
  { id: 'ideation.personas', size: 9 },
  { id: 'ideation.rejected_concepts', size: 14 },
  { id: 'tournament.winning_concept', size: 4 },
  { id: 'tournament.scorecards', size: 22 },
  { id: 'spec.house_style', size: 7 },
  { id: 'spec.section_outline', size: 6 },
];

const SURFACE_BY_ID = new Map(PARENT_SURFACE.map((f) => [f.id, f]));

function sizeOf(ids: Iterable<string>): number {
  let total = 0;
  for (const id of ids) total += SURFACE_BY_ID.get(id)?.size ?? 0;
  return total;
}

// ---------------------------------------------------------------------------
// The child step: what it was statically given, and what it actually needs.
// ---------------------------------------------------------------------------

// The fields the assembler statically guessed the child would read. A thin,
// focused envelope decided up front — it does not (cannot) know the runtime edge.
export const STATIC_READS: readonly string[] = ['tournament.winning_concept', 'spec.house_style'];

// The fields the child actually needs to do its job, knowable only at run time.
// It overlaps the static guess but exceeds it: the assembler under-provisioned.
// Every needed field exists on the parent surface (an honest, answerable need).
export const TRUE_NEED: readonly string[] = [
  'tournament.winning_concept',
  'spec.house_style',
  'spec.section_outline', // the edge the static guess missed
  'digest.key_claims', // the second edge
];

// ---------------------------------------------------------------------------
// A pull channel: targeted typed queries answered from the parent surface,
// bounded by a per-step budget, every answer recorded to a trace.
// ---------------------------------------------------------------------------

export interface PullQuery {
  // A targeted query names exactly one declared field. The sentinel '*' models
  // an "everything" query, which the channel must refuse (it re-imports the blob
  // the scoping was meant to escape).
  readonly fieldId: string;
}

export interface PullAnswer {
  readonly fieldId: string;
  readonly size: number;
}

export interface PullFinding {
  readonly kind: 'everything-query-refused' | 'budget-exhausted';
  readonly message: string;
  readonly fieldId?: string;
}

export interface PullChannelResult {
  readonly answered: readonly PullAnswer[];
  readonly findings: readonly PullFinding[];
  // The trace: one record per answered query. Legibility — "what context did
  // this step actually see" stays knowable after the fact.
  readonly trace: readonly PullAnswer[];
}

// Run a sequence of targeted queries against the surface under a budget. Targeted
// known-field queries are answered and recorded; an "everything" query is refused
// as a finding (the conservative default); once the budget is spent, further
// queries degrade to a budget-exhausted finding rather than widening unboundedly.
export function runPullChannel(queries: readonly PullQuery[], budget: number): PullChannelResult {
  const answered: PullAnswer[] = [];
  const findings: PullFinding[] = [];
  for (const query of queries) {
    if (query.fieldId === '*') {
      findings.push({
        kind: 'everything-query-refused',
        message:
          'an "everything" query re-imports the blob the scoping escaped; refused — narrow the envelope or the chop, or surface a finding',
      });
      continue;
    }
    if (answered.length >= budget) {
      findings.push({
        kind: 'budget-exhausted',
        message: `per-step pull budget of ${budget} spent; proceeding with what was pulled instead of widening`,
        fieldId: query.fieldId,
      });
      continue;
    }
    const field = SURFACE_BY_ID.get(query.fieldId);
    if (field === undefined) continue; // unknown field: nothing to answer (no widen)
    answered.push({ fieldId: field.id, size: field.size });
  }
  // The trace is exactly the answered set, in order: the recorded, replayable
  // record of every slice the step actually pulled.
  return { answered, findings, trace: [...answered] };
}

// ---------------------------------------------------------------------------
// The three envelope strategies, scored on the same need.
// ---------------------------------------------------------------------------

export type Strategy = 'thin-push' | 'fat-push' | 'thin-pull';

export interface EnvelopeScore {
  readonly strategy: Strategy;
  // The fields carried into the step (static envelope + any pulled fields).
  readonly carriedFields: readonly string[];
  readonly carriedBytes: number;
  // Needed fields the step never received. 0 == complete (no starvation).
  readonly starvedFields: number;
  // Bytes carried that the step did not need (the focus/distraction cost).
  readonly irrelevantBytes: number;
  // On-demand queries issued (thin-pull only).
  readonly pulls: number;
  // Conservative-default events surfaced (refusals, budget exhaustion).
  readonly findings: readonly PullFinding[];
  // The recorded pull trace (thin-pull only): legibility after the fact.
  readonly trace: readonly PullAnswer[];
}

function score(
  strategy: Strategy,
  carried: readonly string[],
  extras: {
    pulls?: number;
    findings?: readonly PullFinding[];
    trace?: readonly PullAnswer[];
  } = {},
): EnvelopeScore {
  const carriedSet = new Set(carried);
  const need = new Set(TRUE_NEED);
  let starved = 0;
  for (const id of need) if (!carriedSet.has(id)) starved += 1;
  let irrelevant = 0;
  for (const id of carriedSet) if (!need.has(id)) irrelevant += SURFACE_BY_ID.get(id)?.size ?? 0;
  return {
    strategy,
    carriedFields: [...carriedSet],
    carriedBytes: sizeOf(carriedSet),
    starvedFields: starved,
    irrelevantBytes: irrelevant,
    pulls: extras.pulls ?? 0,
    findings: extras.findings ?? [],
    trace: extras.trace ?? [],
  };
}

// Strategy 1: push only the static envelope. Focused and cheap, but it starves
// on every field the assembly-time guess missed.
export function thinPush(): EnvelopeScore {
  return score('thin-push', STATIC_READS);
}

// Strategy 2: push the entire parent surface. Never starves, but carries every
// irrelevant field — the blob the scoping was meant to escape.
export function fatPush(): EnvelopeScore {
  return score(
    'fat-push',
    PARENT_SURFACE.map((f) => f.id),
  );
}

// Strategy 3: push the static envelope, then pull exactly the missing needed
// fields on demand (targeted, budgeted, recorded). Reaches completeness at near
// the thin envelope's cost. The `budget` and any extra `queries` (e.g. an
// "everything" smell) let the test exercise the conservative defaults.
export function thinPull(
  options: { budget?: number; extraQueries?: readonly PullQuery[] } = {},
): EnvelopeScore {
  const carriedFromStatic = new Set(STATIC_READS);
  // The runtime edge: the step discovers it is missing needed fields and queries
  // for exactly those, by name — never "everything".
  const missing = TRUE_NEED.filter((id) => !carriedFromStatic.has(id));
  const queries: PullQuery[] = [
    ...missing.map((fieldId) => ({ fieldId })),
    ...(options.extraQueries ?? []),
  ];
  const budget = options.budget ?? missing.length; // default: enough for the real need
  const channel = runPullChannel(queries, budget);
  const carried = [...STATIC_READS, ...channel.answered.map((a) => a.fieldId)];
  return score('thin-pull', carried, {
    pulls: channel.answered.length,
    findings: channel.findings,
    trace: channel.trace,
  });
}

export interface DemonstratorSummary {
  readonly thinPush: EnvelopeScore;
  readonly fatPush: EnvelopeScore;
  readonly thinPull: EnvelopeScore;
  // The headline trade: thin-pull reaches fat-push's completeness while carrying
  // this many fewer bytes than fat-push.
  readonly bytesSavedVsFatPush: number;
  // ...and answers the same need the thin push starved on, closing this many
  // starved fields with this many targeted pulls.
  readonly starvedFieldsClosed: number;
}

export function summarize(): DemonstratorSummary {
  const tp = thinPush();
  const fp = fatPush();
  const pull = thinPull();
  return {
    thinPush: tp,
    fatPush: fp,
    thinPull: pull,
    bytesSavedVsFatPush: fp.carriedBytes - pull.carriedBytes,
    starvedFieldsClosed: tp.starvedFields - pull.starvedFields,
  };
}
