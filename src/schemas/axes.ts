import { z } from 'zod';
import { type CompiledDepth, Depth } from './depth.js';
import { StageId } from './ids.js';

export const TournamentN = z.number().int().min(2).max(4);
export type TournamentN = z.infer<typeof TournamentN>;

export const Axes = z
  .object({
    depth: Depth.default('medium'),
    tournament: z.boolean().default(false),
    tournament_n: TournamentN.default(3),
    autonomous: z.boolean().default(false),
  })
  .strict();
export type Axes = z.infer<typeof Axes>;

export const DEFAULT_AXES = Axes.parse({});

export const FlowAxes = z
  .object({
    allowed_depths: z.array(Depth).min(1),
    supports_tournament: z.boolean().default(false),
    supports_autonomous: z.boolean().default(false),
    default: Axes.default(DEFAULT_AXES),
    tournament_fan_out_stage: StageId.optional(),
  })
  .strict()
  .superRefine((axes, ctx) => {
    const seenDepths = new Set<string>();
    for (const [index, depth] of axes.allowed_depths.entries()) {
      if (seenDepths.has(depth)) {
        ctx.addIssue({
          code: 'custom',
          path: ['allowed_depths', index],
          message: `duplicate allowed depth: ${depth}`,
        });
      }
      seenDepths.add(depth);
    }
    if (!seenDepths.has(axes.default.depth)) {
      ctx.addIssue({
        code: 'custom',
        path: ['default', 'depth'],
        message: `default depth '${axes.default.depth}' is not in allowed_depths`,
      });
    }
    if (axes.default.tournament && !axes.supports_tournament) {
      ctx.addIssue({
        code: 'custom',
        path: ['default', 'tournament'],
        message: 'default tournament cannot be true when supports_tournament is false',
      });
    }
    if (axes.default.autonomous && !axes.supports_autonomous) {
      ctx.addIssue({
        code: 'custom',
        path: ['default', 'autonomous'],
        message: 'default autonomous cannot be true when supports_autonomous is false',
      });
    }
    if (axes.supports_tournament && axes.tournament_fan_out_stage === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['tournament_fan_out_stage'],
        message: 'tournament_fan_out_stage is required when supports_tournament is true',
      });
    }
    if (!axes.supports_tournament && axes.tournament_fan_out_stage !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['tournament_fan_out_stage'],
        message: 'tournament_fan_out_stage is only allowed when supports_tournament is true',
      });
    }
  });
export type FlowAxes = z.infer<typeof FlowAxes>;

export const isConsequentialAxes = (axes: Axes): boolean =>
  axes.depth === 'high' || axes.tournament || axes.autonomous;

const axesForCompiledDepth = (depth: CompiledDepth): Axes => ({
  depth: Depth.safeParse(depth).success ? (depth as Depth) : 'medium',
  tournament: depth === 'tournament',
  autonomous: depth === 'autonomous',
  tournament_n: 3,
});

export const isConsequentialDepth = (r: CompiledDepth): boolean =>
  isConsequentialAxes(axesForCompiledDepth(r));
