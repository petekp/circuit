// The per-iteration experiment ledger — a pure projection over a finished
// until-loop trace.
//
// A judge-gated until loop re-enters its body once per pass; at each tail seam
// the engine disposes the stop-judge's goal-met claim against the evidence floor
// and stamps a `run.until-judgment` entry (src/schemas/trace-entry.ts). That
// entry is the durable record of ONE pass: what the judge proposed, whether the
// floor confirmed it, the settled disposition, the stall count, the open-latch
// count, and the carried lesson. This projection joins each judgment to the
// per-relay usage recorded SINCE the previous judgment, producing one row per
// iteration the operator can read in the final summary. It is the Circuit analog
// of autoresearch's results.tsv: one line per experiment, with its cost.
//
// Usage parsing mirrors the until-loop budget accumulator
// (src/runtime/run/until-budget.ts): the same RelayUsageEvidence parse, the same
// input+output token sum, and a cost that stays undefined until a relay reports
// one. A run with no judgment entries (any non-until run, or a count-driven
// until loop) yields an empty ledger.

import { RelayUsageEvidence } from '../../schemas/trace-entry.js';
import type { TraceEntry } from '../domain/trace.js';

export interface IterationLedgerRow {
  readonly iteration: number;
  readonly disposition: 'stop-clean' | 'reenter' | 'needs-attention';
  readonly goalProposed: boolean;
  readonly evidenceConfirmed: boolean;
  readonly openLatchCount: number;
  readonly noProgressCount: number;
  readonly lesson?: string;
  // Input + output tokens summed from the relay.completed entries in this
  // iteration — those recorded after the previous judgment and up to this one.
  readonly inputPlusOutputTokens: number;
  // Reported cost summed the same way; undefined when no relay in this iteration
  // reported a cost (a cost cannot be fabricated from token counts).
  readonly costUsd?: number;
}

// One iteration's running usage accumulator, reset at each judgment boundary.
interface UsageAccumulator {
  tokens: number;
  costUsd: number | undefined;
}

function emptyUsage(): UsageAccumulator {
  return { tokens: 0, costUsd: undefined };
}

// Project the run's trace into one ledger row per iteration. Entries arrive in
// sequence order from TraceStore.load, but we sort defensively by sequence so a
// caller passing an unordered slice still projects in iteration order. The walk
// accumulates relay.completed usage and, at each run.until-judgment, emits a row
// joining the accumulated usage to that judgment, then resets the accumulator.
export function iterationLedgerFromTrace(entries: readonly TraceEntry[]): IterationLedgerRow[] {
  const ordered = [...entries].sort((a, b) => a.sequence - b.sequence);
  const rows: IterationLedgerRow[] = [];
  let usage = emptyUsage();
  for (const entry of ordered) {
    if (entry.kind === 'relay.completed') {
      const parsed = RelayUsageEvidence.safeParse(entry.usage);
      if (!parsed.success) continue;
      usage.tokens += parsed.data.input_tokens + parsed.data.output_tokens;
      if (parsed.data.total_cost_usd_reported !== undefined) {
        usage.costUsd = (usage.costUsd ?? 0) + parsed.data.total_cost_usd_reported;
      }
      continue;
    }
    if (entry.kind !== 'run.until-judgment') continue;
    rows.push({
      iteration: entry.iteration,
      disposition: entry.disposition,
      goalProposed: entry.goal_proposed,
      evidenceConfirmed: entry.evidence_confirmed,
      openLatchCount: entry.open_latch_count,
      noProgressCount: entry.no_progress_count,
      ...(entry.lesson === undefined ? {} : { lesson: entry.lesson }),
      inputPlusOutputTokens: usage.tokens,
      ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd }),
    });
    usage = emptyUsage();
  }
  return rows;
}

// Keep a carried lesson short enough that the table stays scannable. The cut
// uses a single-character ellipsis so the truncation reads as deliberate.
const LESSON_MAX = 80;

function truncateLesson(lesson: string): string {
  const oneLine = lesson.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= LESSON_MAX) return oneLine;
  return `${oneLine.slice(0, LESSON_MAX - 1)}…`;
}

// Escape the pipe so a lesson containing one never breaks the table grid.
function cell(value: string): string {
  return value.replace(/\|/g, '\\|');
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

// Render the ledger as a compact Markdown table, one row per iteration. Plain
// English headers only — no engine field names. Returns the empty string for an
// empty ledger so a caller can append it unconditionally and a non-until run (or
// a count-driven loop) adds nothing.
export function renderIterationLedgerMarkdown(rows: readonly IterationLedgerRow[]): string {
  if (rows.length === 0) return '';
  const header =
    '| Iteration | Disposition | Goal proposed | Evidence confirmed | Open latches | No-progress | Tokens | Lesson |';
  const separator = '| --- | --- | --- | --- | --- | --- | --- | --- |';
  const lines = rows.map((row) => {
    const lesson = row.lesson === undefined ? '' : cell(truncateLesson(row.lesson));
    return `| ${row.iteration} | ${row.disposition} | ${yesNo(row.goalProposed)} | ${yesNo(
      row.evidenceConfirmed,
    )} | ${row.openLatchCount} | ${row.noProgressCount} | ${row.inputPlusOutputTokens} | ${lesson} |`;
  });
  return [header, separator, ...lines].join('\n');
}
