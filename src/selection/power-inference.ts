// Auto-power inference — the run-scoped resolution of an `auto` dial setting.
//
// When the dial setting is `auto`, the run's effective power tier comes from
// inside the run: the first accepted researcher report that carries a
// `recommended_power` resolves it, clamped to the operator's `power_auto`
// bounds. The resolution is set once, recorded as a `run.power-inference`
// trace entry, and every later relay materializes against it. Before it
// resolves (and on runs whose researcher never recommends), materialization
// falls back to the default-on `medium` — auto never crashes a run and never
// silently runs hotter than the ceiling.
//
// (Named "inference", not "auto-resolution": that term is taken by checkpoint
// auto-resolution, an unrelated mechanism.)
//
// The channel mirrors the skill-hook injection channel's shape and lifecycle
// (src/skill-hooks/injection.ts): a mutable run-scoped container on the
// otherwise-readonly RunContext, mutated only at the post-step seam between
// steps, read idempotently by relay planning, and reseeded from the trace on
// checkpoint resume so a resumed run continues at the tier already resolved
// instead of re-inferring.

import { type Power, PowerRecommendation, powerIndex } from '../schemas/power.js';
import type { TraceEntry } from '../schemas/trace-entry.js';

export interface ResolvedPowerInference {
  // What the researcher recommended, verbatim.
  readonly recommended: Power;
  readonly rationale: string;
  // The post-clamp tier the rest of the run materializes against.
  readonly resolved: Power;
  readonly clamped: boolean;
}

export interface PowerInferenceChannel {
  // First write wins; later writes are ignored. The run resolves its dial
  // once — a second researcher pass (recovery, fanout) cannot move it.
  set(inference: ResolvedPowerInference): void;
  // Pure idempotent read; undefined until a resolution lands.
  get(): ResolvedPowerInference | undefined;
}

export function createPowerInferenceChannel(): PowerInferenceChannel {
  let resolved: ResolvedPowerInference | undefined;
  return {
    set(inference) {
      if (resolved === undefined) resolved = inference;
    },
    get() {
      return resolved;
    },
  };
}

export function clampPowerToBounds(
  tier: Power,
  bounds: { readonly floor: Power; readonly ceiling: Power },
): Power {
  if (powerIndex(tier) < powerIndex(bounds.floor)) return bounds.floor;
  if (powerIndex(tier) > powerIndex(bounds.ceiling)) return bounds.ceiling;
  return tier;
}

// Field-tolerant read of a relay result body: a validated PowerRecommendation
// at the top-level `recommended_power` key, or undefined for anything else
// (absent key, malformed value, non-object body). Tolerance matters because
// this runs against raw result JSON at the post-step seam, where the body has
// already passed its flow schema but this module must not depend on any
// flow's report type.
export function extractPowerRecommendation(report: unknown): PowerRecommendation | undefined {
  if (report === null || typeof report !== 'object') return undefined;
  const candidate = (report as { recommended_power?: unknown }).recommended_power;
  if (candidate === undefined) return undefined;
  const parsed = PowerRecommendation.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

// Checkpoint-resume reseed: replay the durable record into a fresh channel so
// a resumed run continues at the already-resolved tier. Mirrors
// seedSkillHookInjectionsFromTrace.
export function seedPowerInferenceFromTrace(
  entries: readonly TraceEntry[],
  channel: PowerInferenceChannel | undefined,
): void {
  if (channel === undefined) return;
  for (const entry of entries) {
    if (entry.kind !== 'run.power-inference') continue;
    channel.set({
      recommended: entry.recommended,
      rationale: entry.rationale,
      resolved: entry.resolved,
      clamped: entry.clamped,
    });
    return;
  }
}
