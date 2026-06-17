import { z } from 'zod';
import { CompiledDepth } from './depth.js';
import { CompiledFlowId, RunId } from './ids.js';
import { Power } from './power.js';
import { MAX_STATUS_TEXT_CHARS } from './progress-event.js';
import { RubricResult } from './rubric.js';
import { ProviderScopedModel } from './selection-policy.js';
import { RelayRole } from './step.js';
import { CatalogSourcedBinding, RunClosedOutcome } from './trace-entry.js';

export const OperatorSummaryWarning = z
  .object({
    kind: z.string().min(1),
    message: z.string().min(1),
    path: z.string().min(1).optional(),
  })
  .strict();
export type OperatorSummaryWarning = z.infer<typeof OperatorSummaryWarning>;

export const OperatorSummaryReportLink = z
  .object({
    label: z.string().min(1),
    path: z.string().min(1),
    schema: z.string().min(1).optional(),
  })
  .strict();
export type OperatorSummaryReportLink = z.infer<typeof OperatorSummaryReportLink>;

// The digest contract mirrors the five-slot output model directly. The older
// dormant seat used headline/primary/why/startWith/cautions/nextStep, but that
// shape had no key-points array and would make JSON disagree with the markdown
// operators actually read.
export const OperatorBriefSlots = z
  .object({
    headline: z.string().min(1),
    assessment: z.string().min(1),
    key_points: z.array(z.string().min(1)).max(4),
    caveats: z.array(z.string().min(1)).max(3),
    next_action: z.string().min(1),
  })
  .strict();
export type OperatorBriefSlots = z.infer<typeof OperatorBriefSlots>;

export const OperatorAutoResolution = z
  .object({
    checkpoint_id: z.string().min(1),
    checkpoint_label: z.string().min(1).optional(),
    policy: z.literal('highest-score'),
    resolved_value: z.string().min(1),
    alternatives_available: z.array(z.string().min(1)),
    scores: z.record(
      z.string().min(1),
      z
        .object({
          aggregate_score: z.number().min(0).max(1),
          runtime_veto_count: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    rubric_results: z.record(z.string().min(1), RubricResult),
    winning_score: z.number().min(0).max(1),
    runner_up_score: z.number().min(0).max(1).optional(),
    margin: z.number().nullable(),
    tie_break: z.string().min(1),
    runtime_veto_effect: z.string().min(1),
    resolved_at: z.string().min(1),
  })
  .strict();
export type OperatorAutoResolution = z.infer<typeof OperatorAutoResolution>;

// A digest of one skill-hook activation for the operator summary. Derived from
// the run's `run.skill-hook` trace events so the operator can see, without
// reading the raw trace, which hook fired, what it injected, where the rule that
// authorized it lives (provenance), and any configured skill that could not be
// found. `injected_skills` are the ids actually merged into the implementer
// worker; `withheld_skills` resolved but were held back by a pending strict-mode
// decision; `unavailable_skills` were named by the policy but did not resolve.
export const OperatorSkillHookActivation = z
  .object({
    hook: z.string().min(1),
    mode: z.enum(['auto', 'mute']),
    source: z.enum(['project-policy', 'user-global-policy', 'default-mapping']),
    policy_ref: z.string().min(1).optional(),
    injected_skills: z.array(z.string().min(1)),
    withheld_skills: z.array(z.string().min(1)),
    unavailable_skills: z.array(
      z
        .object({
          id: z.string().min(1),
          reason: z.string().min(1).optional(),
        })
        .strict(),
    ),
  })
  .strict();
export type OperatorSkillHookActivation = z.infer<typeof OperatorSkillHookActivation>;

// One honored live equipment reshape (Step 2: the engine adapted a running
// flow), projected from the run's `run.equipment-reshape` trace entries so the
// operator can see, without reading the raw trace, that a later relay gained
// skills mid-run and why. `step_id` is the step whose confirmed discovery
// triggered the reshape; `domain_tags` are the domains it confirmed;
// `equipped_steps` are the steps that gained skills; `reason` is the rationale
// recorded in the trace. Only honored reshapes (reshaped=true) appear here; a
// discovery that parked as a finding is surfaced as an evidence warning instead,
// so the operator sees why nothing changed.
export const OperatorEquipmentReshape = z
  .object({
    step_id: z.string().min(1),
    domain_tags: z.array(z.string().min(1)),
    equipped_steps: z.array(z.string().min(1)),
    reason: z.string().min(1),
  })
  .strict();
export type OperatorEquipmentReshape = z.infer<typeof OperatorEquipmentReshape>;

// Per-role model spend, joined reader-side from the trace: role and model come
// from `relay.started`, the usage meter from `relay.completed`, on the shared
// `(step_id, attempt)` key. Only completed relays count — a failed attempt
// never reaches `relay.completed`, so it never bills. `models` entries are
// `provider:model` strings in first-seen order. `cache_creation_tokens` is the
// usage seam's TTL-summed total; the receipt does not split TTLs.
export const OperatorRunReceiptSpendRole = z
  .object({
    role: RelayRole,
    relays: z.number().int().positive(),
    relays_missing_usage: z.number().int().nonnegative(),
    models: z.array(z.string().min(1)),
    input_tokens: z.number().nonnegative(),
    output_tokens: z.number().nonnegative(),
    cache_read_tokens: z.number().nonnegative(),
    cache_creation_tokens: z.number().nonnegative(),
    cost_usd_reported: z.number().nonnegative().optional(),
  })
  .strict();
export type OperatorRunReceiptSpendRole = z.infer<typeof OperatorRunReceiptSpendRole>;

// Run-level spend rollup. Absent (never empty) when no completed relay carried
// a usage block, so a usage-less trace produces a byte-identical receipt. Role
// order is fixed — researcher, implementer, reviewer — and roles with zero
// completed relays are omitted. `total_cost_usd_reported` is present iff at
// least one relay reported a cost. `partial` is the honesty bit: true when any
// completed relay lacked usage or any usage lacked a reported cost, because a
// sum with missing meters must never read as complete.
export const OperatorRunReceiptSpend = z
  .object({
    total_cost_usd_reported: z.number().nonnegative().optional(),
    relays_missing_usage: z.number().int().nonnegative(),
    partial: z.boolean(),
    roles: z.array(OperatorRunReceiptSpendRole).min(1),
  })
  .strict();
export type OperatorRunReceiptSpend = z.infer<typeof OperatorRunReceiptSpend>;

// End-of-run receipt: what the run actually spent and proved, aggregated from
// the trace. `depth` comes from `run.bootstrapped`, `worker_runs` and `models`
// from `relay.started` (distinct models in first-seen order; entries without a
// resolved model still count as runs), and the check counts from every
// `check.evaluated` entry across all attempts. The rendered digest line uses
// plain words only — model ids stay here and in the run record. Deliberately
// no retry count: relay attempt numbers also increment per slice in slice
// loops, so a retry count derived from them would overstate failures.
// `power` is the run's dial position and is absent when the dial was off. On
// a fixed dial it is the first power a relay selection carried (the dial is
// run-level so they all agree); under an auto setting it is the run's
// resolved inference — NOT the first selection, which materialized the
// medium fallback before the researcher's recommendation landed.
// `escalations` counts relays that ran one tier above their allocation —
// it is dial-provenance (power_escalated), not an attempt count, so it does
// not reintroduce the retry-count overstatement above.
export const OperatorRunReceipt = z
  .object({
    depth: CompiledDepth,
    power: Power.optional(),
    // Present only when the dial setting was `auto` (any relay selection
    // carried power_source 'auto'). The three companion fields below are
    // present only when a researcher recommendation actually resolved;
    // their absence under `auto` means the run stayed on the medium fallback.
    power_source: z.literal('auto').optional(),
    power_recommended: Power.optional(),
    power_rationale: z.string().min(1).optional(),
    power_clamped: z.boolean().optional(),
    worker_runs: z.number().int().nonnegative(),
    escalations: z.number().int().nonnegative(),
    models: z.array(ProviderScopedModel),
    checks_evaluated: z.number().int().nonnegative(),
    checks_failed: z.number().int().nonnegative(),
    // Catalog-sourced bindings that fell back to defaults because no catalog
    // package resolved for this flow id — a composed or published custom flow.
    // Absent on a normal built-in run. Surfaced as a receipt note so a reduced
    // run is visible, not silent. See
    // docs/ideas/first-class-composition-sequence.md (Stage 1).
    reduced_bindings: z.array(CatalogSourcedBinding).optional(),
    spend: OperatorRunReceiptSpend.optional(),
  })
  .strict();
export type OperatorRunReceipt = z.infer<typeof OperatorRunReceipt>;

export const OperatorSummary = z
  .object({
    schema_version: z.literal(1),
    run_id: RunId,
    flow_id: CompiledFlowId,
    selected_flow: CompiledFlowId,
    routed_by: z.literal('explicit').optional(),
    router_reason: z.string().min(1).optional(),
    outcome: z.union([RunClosedOutcome, z.literal('checkpoint_waiting')]),
    headline: z.string().min(1),
    status_text: z.string().min(1).max(MAX_STATUS_TEXT_CHARS).optional(),
    brief_slots: OperatorBriefSlots.optional(),
    details: z.array(z.string().min(1)),
    evidence_warnings: z.array(OperatorSummaryWarning),
    run_folder: z.string().min(1),
    result_path: z.string().min(1).optional(),
    html_path: z.string().min(1).optional(),
    report_paths: z.array(OperatorSummaryReportLink),
    auto_resolutions: z.array(OperatorAutoResolution).optional(),
    skill_hook_activations: z.array(OperatorSkillHookActivation).optional(),
    equipment_reshapes: z.array(OperatorEquipmentReshape).optional(),
    receipt: OperatorRunReceipt.optional(),
    checkpoint: z
      .object({
        step_id: z.string().min(1),
        request_path: z.string().min(1),
        allowed_choices: z.array(z.string().min(1)).min(1),
      })
      .strict()
      .optional(),
  })
  .strict();
export type OperatorSummary = z.infer<typeof OperatorSummary>;
