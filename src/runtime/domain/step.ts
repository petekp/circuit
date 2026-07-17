import type { RouteName } from './route.js';

export type StepId = string;

export type StepKind = 'compose' | 'verification' | 'checkpoint' | 'relay' | 'sub-run' | 'fanout';

export interface RouteStepOutcome {
  readonly route: RouteName;
  readonly details?: Record<string, unknown>;
}

export interface WaitingCheckpointStepOutcome {
  readonly kind: 'waiting_checkpoint';
  readonly checkpoint: {
    readonly stepId: string;
    readonly attempt: number;
    readonly requestPath: string;
    readonly requestSha256: string;
    readonly allowedChoices: readonly string[];
  };
}

export type StepOutcome = RouteStepOutcome | WaitingCheckpointStepOutcome;

export function isWaitingCheckpointStepOutcome(
  outcome: StepOutcome,
): outcome is WaitingCheckpointStepOutcome {
  return 'kind' in outcome && outcome.kind === 'waiting_checkpoint';
}
