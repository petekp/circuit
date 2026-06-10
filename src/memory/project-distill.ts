import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listCandidateRunFolders } from '../history/run-corpus.js';
import {
  type MemoryInputV0,
  MemoryInputV0 as MemoryInputV0Schema,
  type Ref,
  Ref as RefSchema,
  type RunMemoryUpdateEvent,
  RunMemoryUpdateEvent as RunMemoryUpdateEventSchema,
  StepAbortedTraceEntry,
} from '../schemas/index.js';
import { sha256Hex } from '../shared/connector-relay.js';
import { runsRoot } from '../shared/control-plane-paths.js';

// The deterministic, propose-first project-fact distiller (Slice 5). It mines
// the ONE grounded auto-signal the typed corpus supports today (D4): a
// recurring failure cause, clustered as `(flow_id, normalized_reason)` over
// `step.aborted` trace entries across runs of the project. When the same
// normalized reason appears in two or more INDEPENDENT runs with fresh sources
// and no contradiction, it emits a single `proposed` `prior_failure` proposal
// plus a matching `RunMemoryUpdateEvent` that cites BOTH contributing runs.
//
// It is propose-first (D2): every fact is `action:"proposed"`, never recorded.
// It is redacted at capture (D5): the proposal's `summary` and `hints[].text`
// are composed from NORMALIZED typed fields only — the reason head, the flow
// id, and the cited run ids — never the raw reason tail, an un-normalized
// reason string, or raw stdout/stderr. A test asserts no stored hint contains
// the raw reason tail.
//
// It is pure over the history corpus + run folders: it reads trace files and
// writes nothing. The cold-start reality (section 5) is that the cluster does
// not currently reach two independent runs, so on today's corpus this emits
// nothing — by design.

export const DEFAULT_MIN_DISTINCT_RUNS = 2;

export interface DistillProjectFactsOptions {
  // Repo root; the runs base is `<repoRoot>/.circuit/runs` unless overridden.
  readonly repoRoot: string;
  readonly runsBase?: string;
  // When set, only clusters whose runs carry this flow_id are mined; a review
  // run distills review failures, a goal run goal failures (D6 scope).
  readonly flowId?: string;
  // The resolved project identity; stamped into proposal provenance text so a
  // proposal names the project it was mined from.
  readonly projectId: string;
  // Minimum DISTINCT run_ids a cluster must reach to propose (default 2).
  readonly minDistinctRuns?: number;
  readonly now?: () => Date;
}

export interface DistillProjectFactsResult {
  readonly proposals: readonly MemoryInputV0[];
  readonly events: readonly RunMemoryUpdateEvent[];
}

// One step.aborted occurrence, located to its run and trace position. The raw
// reason is NOT carried past normalization — only the normalized head reaches
// the cluster, so the leak vector (D5) never enters the data structure.
interface AbortOccurrence {
  readonly runId: string;
  readonly flowId: string;
  readonly sequence: number;
  readonly stepId?: string;
  readonly attempt?: number;
  readonly traceSha256: string;
}

// D4 reason normalization: the head is the prefix before the first colon,
// lowercased, whitespace-collapsed. This groups e.g.
//   "relay step 'goal-run-build': connector result_body lacks a non-empty..."
// by its stable head ("relay step 'goal-run-build'") while dropping the
// run-specific tail. Exported so a contract test can pin it and a future
// taxonomy can replace it without touching the cluster logic (the veto path).
export function normalizeReasonHead(reason: string): string {
  const head = reason.split(':', 1)[0] ?? reason;
  return head.toLowerCase().replace(/\s+/g, ' ').trim();
}

// The raw tail (everything after the first colon) is the primary leak vector
// (D5): in the real corpus it inlines stdout/stderr fragments and session ids.
// It NEVER reaches a hint; this helper exists only so the redaction test can
// assert its absence in produced facts.
export function reasonTail(reason: string): string {
  const colon = reason.indexOf(':');
  return colon === -1 ? '' : reason.slice(colon + 1).trim();
}

function clusterKey(flowId: string, normalizedHead: string): string {
  return `${flowId}\u0000${normalizedHead}`;
}

// Build the trace source ref for an occurrence (kind:"trace", run_id, sequence;
// carries NO ref.sha256 by the Ref schema — the trace branch keys on
// run_id+sequence). The content hash lives on the MemoryInputV0 source.sha256.
// Mirrors the history extractor's traceSourceRef shape.
function traceRef(occurrence: AbortOccurrence): Ref {
  return RefSchema.parse({
    kind: 'trace',
    ref: `trace.ndjson#sequence=${occurrence.sequence}`,
    run_id: occurrence.runId,
    flow_id: occurrence.flowId,
    ...(occurrence.stepId === undefined ? {} : { step_id: occurrence.stepId }),
    ...(occurrence.attempt === undefined ? {} : { attempt: occurrence.attempt }),
    sequence: occurrence.sequence,
  });
}

// A deterministic, path-safe memory id for a proposed cluster fact, derived
// from the cluster key so re-running the distiller proposes the same id for the
// same cluster (idempotent identity).
function proposalMemoryId(flowId: string, normalizedHead: string): string {
  return `project-prior-failure-${sha256Hex(clusterKey(flowId, normalizedHead)).slice(0, 16)}`;
}

interface Cluster {
  readonly flowId: string;
  readonly normalizedHead: string;
  // run_id -> that run's representative (lowest-sequence) occurrence.
  readonly occurrencesByRun: Map<string, AbortOccurrence>;
}

// Read one run folder's trace.ndjson once, returning the run's flow_id and its
// (normalizedHead, occurrence) pairs. A run with no trace, no bootstrap, or no
// aborts contributes nothing. A torn line never blinds the rest of the trace.
function readRunCluster(runFolder: string):
  | {
      readonly flowId: string;
      readonly aborts: readonly { head: string; occurrence: AbortOccurrence }[];
    }
  | undefined {
  const tracePath = join(runFolder, 'trace.ndjson');
  if (!existsSync(tracePath)) return undefined;
  let raw: string;
  try {
    raw = readFileSync(tracePath, 'utf8');
  } catch {
    return undefined;
  }
  const traceSha256 = sha256Hex(raw);

  const values: unknown[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      values.push(JSON.parse(line));
    } catch {
      // skip a torn line
    }
  }

  let flowId: string | undefined;
  for (const value of values) {
    if (value !== null && typeof value === 'object') {
      const kind = (value as { kind?: unknown }).kind;
      if (kind === 'run.bootstrapped') {
        const fid = (value as { flow_id?: unknown }).flow_id;
        if (typeof fid === 'string') flowId = fid;
      }
    }
  }
  if (flowId === undefined) return undefined;

  const aborts: { head: string; occurrence: AbortOccurrence }[] = [];
  for (const value of values) {
    const parsed = StepAbortedTraceEntry.safeParse(value);
    if (!parsed.success) continue;
    const head = normalizeReasonHead(parsed.data.reason);
    if (head.length === 0) continue;
    aborts.push({
      head,
      occurrence: {
        runId: parsed.data.run_id as unknown as string,
        flowId,
        sequence: parsed.data.sequence,
        ...(parsed.data.step_id === undefined
          ? {}
          : { stepId: parsed.data.step_id as unknown as string }),
        attempt: parsed.data.attempt,
        traceSha256,
      },
    });
  }
  return { flowId, aborts };
}

export function distillProjectFacts(
  options: DistillProjectFactsOptions,
): DistillProjectFactsResult {
  const runsBase = options.runsBase ?? runsRoot(options.repoRoot);
  const minDistinctRuns = options.minDistinctRuns ?? DEFAULT_MIN_DISTINCT_RUNS;
  const now = options.now ?? (() => new Date());
  const capturedAt = now().toISOString();

  let runFolders: readonly string[];
  try {
    runFolders = listCandidateRunFolders(runsBase);
  } catch {
    // No runs base yet (cold start): nothing to distill, fail-open.
    return { proposals: [], events: [] };
  }

  const clusters = new Map<string, Cluster>();
  for (const runFolder of runFolders) {
    const run = readRunCluster(runFolder);
    if (run === undefined) continue;
    if (options.flowId !== undefined && run.flowId !== options.flowId) continue;
    for (const { head, occurrence } of run.aborts) {
      const key = clusterKey(run.flowId, head);
      let cluster = clusters.get(key);
      if (cluster === undefined) {
        cluster = { flowId: run.flowId, normalizedHead: head, occurrencesByRun: new Map() };
        clusters.set(key, cluster);
      }
      // Keep the lowest-sequence occurrence per run as that run's
      // representative (deterministic head selection within a run).
      const existing = cluster.occurrencesByRun.get(occurrence.runId);
      if (existing === undefined || occurrence.sequence < existing.sequence) {
        cluster.occurrencesByRun.set(occurrence.runId, occurrence);
      }
    }
  }

  const proposals: MemoryInputV0[] = [];
  const events: RunMemoryUpdateEvent[] = [];

  // Deterministic cluster order so output is stable across runs.
  const orderedClusters = [...clusters.values()].sort(
    (left, right) =>
      left.flowId.localeCompare(right.flowId) ||
      left.normalizedHead.localeCompare(right.normalizedHead),
  );

  for (const cluster of orderedClusters) {
    const runIds = [...cluster.occurrencesByRun.keys()].sort();
    if (runIds.length < minDistinctRuns) continue; // single isolated abort -> no proposal

    // The head run (lowest run_id) is the proposal's single cited source ref;
    // the matching event cites every contributing run's trace ref.
    const contributingOccurrences = runIds.map((runId) => {
      const occurrence = cluster.occurrencesByRun.get(runId);
      if (occurrence === undefined) throw new Error('unreachable: run id without occurrence');
      return occurrence;
    });
    const headOccurrence = contributingOccurrences[0];
    if (headOccurrence === undefined) continue;

    const memoryId = proposalMemoryId(cluster.flowId, cluster.normalizedHead);
    // REDACTED composition (D5): head + flow id + cited run ids only.
    const summary = `Recurring ${cluster.flowId} failure in ${options.projectId}: ${cluster.normalizedHead}`;
    const hintText = `In flow ${cluster.flowId}, the failure cause "${cluster.normalizedHead}" recurred across ${runIds.length} runs (${runIds.join(', ')}). Re-verify whether this cause still applies before relying on it.`;

    const proposal = MemoryInputV0Schema.parse({
      schema_version: 1,
      memory_id: memoryId,
      kind: 'project',
      source: {
        ref: traceRef(headOccurrence),
        captured_at: capturedAt,
        // The trace file's content hash. The trace Ref carries no ref.sha256,
        // so the MemoryInputV0 `source.sha256 === source.ref.sha256` refine
        // simply does not fire (it guards only when both are present).
        sha256: headOccurrence.traceSha256,
      },
      summary,
      hints: [
        {
          id: `prior-failure-${sha256Hex(memoryId).slice(0, 12)}`,
          text: hintText,
          applies_to: 'prior_failure',
        },
      ],
      // Distilled facts enter `unknown` until re-verified at injection; the
      // injection path re-checks freshness against the cited source.
      staleness: {
        status: 'unknown',
        checked_at: capturedAt,
        reason_codes: ['memory_unverified'],
      },
      authority: 'hint_only',
    });
    proposals.push(proposal);

    const event = RunMemoryUpdateEventSchema.parse({
      schema: 'run.memory-update-event@v0',
      event_id: `mue-${memoryId}`,
      scope: 'flow',
      flow_id: cluster.flowId,
      action: 'proposed',
      reason: `recurring ${cluster.flowId} abort cause observed across ${runIds.length} independent runs`,
      summary,
      // The array is the schema-legal home for the two-run citation: it cites
      // EVERY contributing run's trace ref (min 1, here >= 2).
      source_refs: contributingOccurrences.map((occurrence) => traceRef(occurrence)),
      authority: 'hint_only',
      operator_indicator: `Memory (hint-only): proposed a recurring-failure fact for flow ${cluster.flowId} from ${runIds.length} runs; not recorded until you confirm it.`,
      staleness: {
        status: 'unknown',
        checked_at: capturedAt,
        reason_codes: ['memory_unverified'],
      },
    });
    events.push(event);
  }

  return { proposals, events };
}
