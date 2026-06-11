import type { FlowAxes } from '../schemas/axes.js';
import type { FlowAxisSelection } from '../schemas/flow-schematic.js';

export function axisSelectionsForAxes(
  flowId: string,
  axes: FlowAxes,
): readonly FlowAxisSelection[] {
  const selections: FlowAxisSelection[] = [
    {
      name: 'default',
      depth: axes.default.depth,
      description: `Default ${flowId} axis tuple.`,
    },
  ];

  for (const depth of axes.allowed_depths) {
    if (depth === axes.default.depth) continue;
    selections.push({
      name: depth,
      depth: depth,
      description: `${depth} ${flowId} axis tuple.`,
    });
  }

  if (axes.supports_tournament) {
    selections.push({
      name: 'tournament',
      depth: 'tournament',
      description: `Tournament ${flowId} axis tuple.`,
    });
  }

  if (axes.supports_autonomous) {
    selections.push({
      name: 'autonomous',
      depth: 'autonomous',
      description: `Autonomous ${flowId} axis tuple.`,
    });
  }

  return selections;
}
