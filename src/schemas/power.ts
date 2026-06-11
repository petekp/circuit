import { z } from 'zod';

// The Power dial: how much model per unit of work. Operator-facing sibling of
// Depth (the process dial); both share the low/medium/high scale. The dial
// never names models — per-connector tier tables translate a tier word into a
// concrete model and/or effort at selection time, and explicit model config
// always wins over the dial.
//
// Kept import-free (zod only) like depth.ts so any schema can reference the
// dial without risking an import cycle.
export const Power = z.enum(['low', 'medium', 'high']);
export type Power = z.infer<typeof Power>;

// Tier order, lowest first. Single source for every ordinal comparison on the
// dial (escalation bumps, auto-bound clamping) so the scale cannot drift.
export const POWER_ORDER = ['low', 'medium', 'high'] as const satisfies readonly Power[];

export function powerIndex(tier: Power): number {
  return POWER_ORDER.indexOf(tier);
}

// What an operator may *write* where the dial is set (config `defaults.power`,
// `--power`): the three tiers plus `auto`, which delegates the tier choice to
// the run itself (the researcher recommends, the engine clamps to the
// operator's `power_auto` bounds). `auto` exists only at the setting layer —
// allocation tables, tier specs, and resolved selections always carry a
// concrete Power.
export const PowerDialSetting = z.enum(['auto', 'low', 'medium', 'high']);
export type PowerDialSetting = z.infer<typeof PowerDialSetting>;
