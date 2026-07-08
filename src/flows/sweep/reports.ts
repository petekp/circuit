// Sweep's report schemas.
//
// Sweep clears a whole backlog of one mechanical finding (tsc/eslint/clippy
// diagnostics) by driving an external scanner to a zero-finding exit. Its loop
// body fans one worker out per partition unit, re-scans with a pinned oracle,
// and lets a judge decide whether the backlog is clear. Every schema name below
// is globally unique (the compose, verification, and report-schema registries
// are one keyspace shared across all flow packages), so Sweep owns `sweep.*`
// names and reuses only the shared VerificationCommand / VerificationResult
// shapes and the built-in converge.judgment@v1 contract.

import { z } from 'zod';
import { VerificationCommand, VerificationResult } from '../../schemas/verification.js';

// A single mechanical finding the scanner reported. `file` is null when a
// finding is not file-scoped (a project-level diagnostic), so partitioning can
// group it under the project unit rather than a file unit.
export const SweepFinding = z
  .object({
    finding_id: z.string().min(1),
    file: z.string().min(1).nullable(),
    rule: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();
export type SweepFinding = z.infer<typeof SweepFinding>;

// The preamble's census. It runs ONCE before the loop and does three jobs:
//   1. Resolves the scanner and the suppression audit into pinnable
//      VerificationCommands. The loop's rescan step reads exactly these, so the
//      oracle-command pin can snapshot them the first wave and refuse a swap.
//   2. Records the suppression baseline — the count of suppression directives
//      already in the tree — so a worker that silences a finding instead of
//      fixing it shows up as an audit that exits red against a baseline of zero.
//   3. Captures the opening finding census and the config surface, so the
//      operator sees the size of the backlog and which files define "clean".
export const SweepCensus = z
  .object({
    objective: z.string().min(1),
    // The scanner whose zero-finding exit is the oracle. A package-script
    // invocation (`npm run <script>`) so engine change 2 fingerprints its body.
    scanner: VerificationCommand,
    // The suppression audit: a second command whose non-zero exit means a
    // suppression directive was added. Also a package script, also fingerprinted.
    suppression_audit: VerificationCommand,
    suppression_baseline: z.number().int().nonnegative(),
    // The config files that define what the scanner treats as a finding
    // (recorded for legibility; the frozen-paths engine flag is what enforces
    // that a worker cannot edit them out from under the oracle).
    config_surface: z.array(z.string().min(1)),
    findings: z.array(SweepFinding),
    total_finding_count: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((census, ctx) => {
    if (census.total_finding_count !== census.findings.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['total_finding_count'],
        message: 'total_finding_count must match findings.length',
      });
    }
  });
export type SweepCensus = z.infer<typeof SweepCensus>;

// How independent a unit's fix is from its siblings, so the partition is honest
// about what may run in parallel:
//   isolated — touches only its own files; safe to fan out concurrently.
//   shared   — touches files another unit also needs; grouped, not split.
//   serial   — must run after an earlier unit (an ordering dependency).
//   project  — a project-level finding with no single file to scope.
export const SweepIndependence = z.enum(['isolated', 'shared', 'serial', 'project']);
export type SweepIndependence = z.infer<typeof SweepIndependence>;

// One partition unit: a disjoint slice of the backlog one worker owns this wave.
export const SweepUnit = z
  .object({
    unit_id: z.string().min(1),
    files: z.array(z.string().min(1)).min(1),
    finding_ids: z.array(z.string().min(1)).min(1),
    independence: SweepIndependence,
    fix_prompt: z.string().min(1),
  })
  .strict();
export type SweepUnit = z.infer<typeof SweepUnit>;

// The head step's output each wave. A partition must carry at least one unit:
// when a re-scan finds nothing left, the loop must already have stopped at the
// judge on a green rescan, so a zero-unit partition is a contract violation the
// writer surfaces rather than emitting. Units must be file-disjoint so the
// fanout can run them concurrently without two workers racing one file.
export const SweepPartition = z
  .object({
    units: z.array(SweepUnit).min(1),
    covers_all_findings: z.boolean(),
  })
  .strict()
  .superRefine((partition, ctx) => {
    const owner = new Map<string, string>();
    for (const [index, unit] of partition.units.entries()) {
      for (const file of unit.files) {
        const prior = owner.get(file);
        if (prior !== undefined && prior !== unit.unit_id) {
          ctx.addIssue({
            code: 'custom',
            path: ['units', index, 'files'],
            message: `file '${file}' is claimed by units '${prior}' and '${unit.unit_id}'; partition units must be file-disjoint`,
          });
        }
        owner.set(file, unit.unit_id);
      }
    }
  });
export type SweepPartition = z.infer<typeof SweepPartition>;

// A fanout worker's report. `unit_id` is the branch's provenance field — the
// engine forces it to equal the branch_id, so a worker cannot report against a
// unit it was not assigned. `verdict` is what the fanout admit list reads; all
// three values are admitted because the rescan floor, not the fanout, decides
// whether the backlog is clear — a `blocked` worker simply leaves its findings
// for the next wave. A `fixed` or `partial` worker must name the files it
// changed; a `blocked` worker legitimately changed nothing.
export const SweepUnitFixVerdict = z.enum(['fixed', 'partial', 'blocked']);
export type SweepUnitFixVerdict = z.infer<typeof SweepUnitFixVerdict>;

export const SweepUnitFix = z
  .object({
    unit_id: z.string().min(1),
    verdict: SweepUnitFixVerdict,
    changed_files: z.array(z.string().min(1)),
    rule_fixed: z.string().min(1),
    evidence: z.string().min(1),
  })
  .strict()
  .superRefine((fix, ctx) => {
    if (fix.verdict !== 'blocked' && fix.changed_files.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['changed_files'],
        message: `a '${fix.verdict}' unit fix must name at least one changed file`,
      });
    }
  });
export type SweepUnitFix = z.infer<typeof SweepUnitFix>;

// The fanout aggregate the engine writes after joining the wave's branches
// (buildFanoutAggregate). Sweep joins aggregate-only with no rubric, so
// rubric_result is always absent. branch_count is positive because the fanout
// executor refuses a zero-branch wave before any aggregate is written.
export const SweepWaveAggregateBranch = z
  .object({
    branch_id: z.string().min(1),
    child_run_id: z.string().min(1),
    child_outcome: z.enum(['complete', 'aborted', 'handoff', 'stopped', 'escalated']),
    verdict: z.string().min(1),
    admitted: z.boolean(),
    result_path: z.string().min(1),
    duration_ms: z.number().nonnegative(),
    result_body: SweepUnitFix.optional(),
  })
  .strict();
export type SweepWaveAggregateBranch = z.infer<typeof SweepWaveAggregateBranch>;

export const SweepWaveAggregate = z
  .object({
    schema_version: z.literal(1),
    join_policy: z.literal('aggregate-only'),
    branch_count: z.number().int().positive(),
    branches: z.array(SweepWaveAggregateBranch).min(1),
  })
  .strict()
  .superRefine((aggregate, ctx) => {
    if (aggregate.branch_count !== aggregate.branches.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['branch_count'],
        message: 'branch_count must match branches.length',
      });
    }
    for (const [index, branch] of aggregate.branches.entries()) {
      if (
        branch.child_outcome === 'complete' &&
        branch.result_body !== undefined &&
        branch.result_body.unit_id !== branch.branch_id
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['branches', index, 'result_body', 'unit_id'],
          message: `branch_id '${branch.branch_id}' must match result_body.unit_id '${branch.result_body.unit_id}'`,
        });
      }
    }
  });
export type SweepWaveAggregate = z.infer<typeof SweepWaveAggregate>;

// The rescan's canonical command-list result. Its overall_status is the proof
// the until-loop evidence floor reads each wave: passed only when the scanner
// AND the suppression audit both exit clean. The same strict VerificationResult
// shape Build and Fix Until Green emit, reused verbatim.
export const SweepVerification = VerificationResult;
export type SweepVerification = z.infer<typeof SweepVerification>;
