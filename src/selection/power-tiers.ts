// Power dial materialization.
//
// The dial never names models. At relay-selection time, after the layered
// selection stack has resolved, this module translates the run's Power dial
// into a concrete model and/or effort: dial × role → tier, tier × connector →
// spec. Explicit selection config always wins — materialization only fills
// fields the stack left unset, so the existing per-flow/stage/step escape
// hatch is untouched.
import type { LayeredConfig, PowerTierSpec, PowerTierTable } from '../schemas/config.js';
import { POWER_ORDER, type Power, type PowerDialSetting, powerIndex } from '../schemas/power.js';
import type { ResolvedSelection } from '../schemas/selection-policy.js';
import type { RelayRole } from '../schemas/step.js';

// Shipped tier tables — release-reviewed data, never engine logic. The
// anthropic entries use the Claude CLI's durable aliases (haiku/sonnet/opus)
// so the table does not rot with model generations. The codex entries tier by
// reasoning effort only — the OpenAI cost dial — and leave the model at the
// operator's codex default, avoiding a pinned id that would rot. cursor-agent
// and custom connectors ship no entry: the dial is inert there unless the
// operator declares `power_tiers.<connector>` in config.
export const DEFAULT_POWER_TIERS: Readonly<Record<string, PowerTierTable>> = {
  'claude-code': {
    low: { model: { provider: 'anthropic', model: 'haiku' } },
    medium: { model: { provider: 'anthropic', model: 'sonnet' } },
    high: { model: { provider: 'anthropic', model: 'opus' } },
  },
  codex: {
    low: { effort: 'low' },
    medium: { effort: 'medium' },
    high: { effort: 'high' },
  },
};

// Dial × role → tier. Judgment compounds, so the researcher stays on the big
// tier at every dial position; the dial's main effect is execution (the
// implementer), with review held one notch safer than execution at low.
const ROLE_POWER_ALLOCATION: Readonly<Record<Power, Readonly<Record<RelayRole, Power>>>> = {
  high: { researcher: 'high', implementer: 'high', reviewer: 'high' },
  medium: { researcher: 'high', implementer: 'medium', reviewer: 'medium' },
  low: { researcher: 'high', implementer: 'low', reviewer: 'medium' },
};

// Escalation is monotonic and capped: one tier up, never down, never past
// the top. Attempt numbers are keyed per (step, slice), so attempt > 1 means
// this same unit of work needed another try — slice advances restart at 1.
function bumpOneTier(tier: Power): Power {
  return POWER_ORDER[Math.min(powerIndex(tier) + 1, POWER_ORDER.length - 1)] as Power;
}

// Layer precedence for dial and table reads. Same order the selection
// resolver walks; declared here (not array order) so an out-of-order layers
// array cannot invert precedence.
const LAYER_PRECEDENCE = ['default', 'user-global', 'project', 'invocation'] as const;

function layersInPrecedenceOrder(layers: readonly LayeredConfig[]): readonly LayeredConfig[] {
  return LAYER_PRECEDENCE.flatMap((name) => layers.filter((layer) => layer.layer === name));
}

// The dial *setting*: either a fixed tier or auto with operator bounds.
// Fixed resolution is the highest-precedence layer with a `defaults.power`
// opinion; default-on means no opinion reads as fixed medium — the dial ships
// engaged, and an operator turns it rather than discovers it. When the
// winning opinion is `auto`, the bounds compose per field across layers.
export type PowerDialResolution =
  | { readonly kind: 'fixed'; readonly value: Power }
  | { readonly kind: 'auto'; readonly floor: Power; readonly ceiling: Power };

export function resolvePowerDialSetting(layers: readonly LayeredConfig[]): PowerDialResolution {
  let dial: PowerDialSetting = 'medium';
  for (const layer of layersInPrecedenceOrder(layers)) {
    // Optional access: a zod-parsed Config always defaults these containers,
    // but callers also hand layers built structurally (tests, embedders), and
    // a missing container must read as "no opinion", not a crash.
    const power = layer.config.defaults?.power;
    if (power !== undefined) dial = power;
  }
  if (dial !== 'auto') return { kind: 'fixed', value: dial };
  let floor: Power = 'low';
  let ceiling: Power = 'high';
  for (const layer of layersInPrecedenceOrder(layers)) {
    const bounds = layer.config.power_auto;
    if (bounds?.floor !== undefined) floor = bounds.floor;
    if (bounds?.ceiling !== undefined) ceiling = bounds.ceiling;
  }
  // Schema validation rejects floor > ceiling inside one document, but two
  // layers can compose into an inverted range. The ceiling is the spend cap,
  // so it wins: the floor lowers to meet it rather than pushing spend up.
  if (powerIndex(floor) > powerIndex(ceiling)) floor = ceiling;
  return { kind: 'auto', floor, ceiling };
}

// The run's effective dial as a single tier, for callers with no inferred
// tier to apply. An auto setting without an inference reads as the default-on
// medium — never a crash, never a surprise high. (BREAKING vs the pre-flip
// inert default: relays whose selection stack left the model unset now
// materialize the medium-tier allocation for their role.)
export function resolvePowerDial(layers: readonly LayeredConfig[]): Power {
  const setting = resolvePowerDialSetting(layers);
  return setting.kind === 'fixed' ? setting.value : 'medium';
}

// Tier lookup: the highest-precedence layer that declares this connector+tier
// wins; the shipped defaults fill anything config leaves unset.
function tierSpec(
  layers: readonly LayeredConfig[],
  connectorName: string,
  tier: Power,
): PowerTierSpec | undefined {
  let spec = DEFAULT_POWER_TIERS[connectorName]?.[tier];
  for (const layer of layersInPrecedenceOrder(layers)) {
    const candidate = layer.config.power_tiers?.[connectorName]?.[tier];
    if (candidate !== undefined) spec = candidate;
  }
  return spec;
}

export function materializePowerSelection(input: {
  readonly resolved: ResolvedSelection;
  readonly role: RelayRole;
  readonly connectorName: string;
  readonly attempt: number;
  readonly configLayers?: readonly LayeredConfig[];
  // The run's resolved auto-power tier (already clamped), when one exists.
  // Consulted only when the dial setting is `auto`; a fixed setting ignores it.
  readonly inferredPower?: Power;
}): ResolvedSelection {
  // Explicit model config wins outright; the dial never overrides it.
  if (input.resolved.model !== undefined) return input.resolved;
  const layers = input.configLayers ?? [];
  const setting = resolvePowerDialSetting(layers);
  // Auto before its inference resolves (the researcher's own relay, or a run
  // whose researcher never recommended) materializes the default-on medium.
  const dial = setting.kind === 'fixed' ? setting.value : (input.inferredPower ?? 'medium');
  const allocated = ROLE_POWER_ALLOCATION[dial][input.role];
  const tier = input.attempt > 1 ? bumpOneTier(allocated) : allocated;
  const spec = tierSpec(layers, input.connectorName, tier);
  if (spec === undefined) return input.resolved;
  return {
    ...input.resolved,
    ...(spec.model === undefined ? {} : { model: spec.model }),
    ...(input.resolved.effort === undefined && spec.effort !== undefined
      ? { effort: spec.effort }
      : {}),
    power: dial,
    ...(tier === allocated ? {} : { power_escalated: true }),
    ...(setting.kind === 'auto' ? { power_source: 'auto' as const } : {}),
  };
}
