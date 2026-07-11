import { z } from 'zod';

// The Power dial: how much model per unit of work. Operator-facing sibling of
// Process (the process dial); both share the low/medium/high scale. The dial
// never names models — per-connector tier tables translate a tier word into a
// concrete model and/or effort at selection time, and explicit model config
// always wins over the dial.
//
// Kept import-free (zod only) like process.ts so any schema can reference the
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

// A researcher's per-run tier recommendation, emitted from inside the run by
// the role that has already read the goal and the code. Advisory only: the
// engine clamps it to the operator's `power_auto` bounds and ignores it
// entirely unless the dial setting is `auto`. Always a concrete tier.
export const PowerRecommendation = z
  .object({
    value: Power.describe('the power tier this job needs: low, medium, or high'),
    rationale: z
      .string()
      .min(1)
      .max(280)
      .describe('one short sentence grounding the tier in what you read'),
  })
  .strict();
export type PowerRecommendation = z.infer<typeof PowerRecommendation>;
