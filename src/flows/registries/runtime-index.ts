import type { AcceptanceCriteria } from '../../schemas/acceptance-criteria.js';
import type { EquipmentScope } from '../../schemas/equipment-scope.js';

export interface RuntimeIndexedReportRef {
  readonly path: string;
  readonly schema: string;
}

export type RuntimeIndexedWrite = string | RuntimeIndexedReportRef | undefined;

export interface RuntimeIndexedStepBase {
  readonly id: string;
  readonly title: string;
  readonly executor?: string | undefined;
  readonly protocol: string;
  readonly reads: readonly string[];
  readonly routes: Readonly<Record<string, string>>;
  readonly writes: Readonly<Record<string, RuntimeIndexedWrite>>;
  readonly check: unknown;
  readonly selection?: unknown | undefined;
  readonly skill_slots?: readonly unknown[] | undefined;
  readonly equipment_scope?: EquipmentScope | undefined;
  readonly budgets?: unknown | undefined;
}

export interface RuntimeIndexedComposeStep extends RuntimeIndexedStepBase {
  readonly kind: 'compose';
  readonly writes: RuntimeIndexedStepBase['writes'] & {
    readonly report: RuntimeIndexedReportRef;
  };
}

export interface RuntimeIndexedVerificationStep extends RuntimeIndexedStepBase {
  readonly kind: 'verification';
  readonly writes: RuntimeIndexedStepBase['writes'] & {
    readonly report: RuntimeIndexedReportRef;
  };
}

export interface RuntimeIndexedCheckpointStep extends RuntimeIndexedStepBase {
  readonly kind: 'checkpoint';
  readonly policy: {
    readonly prompt: string;
    readonly choices?:
      | readonly {
          readonly id: string;
          readonly label?: string | undefined;
          readonly description?: string | undefined;
        }[]
      | undefined;
    readonly choices_from?: unknown | undefined;
    readonly safe_default_choice?: string | undefined;
    readonly report_template?: unknown | undefined;
  };
  readonly writes: RuntimeIndexedStepBase['writes'] & {
    readonly request: string;
    readonly response: string;
    readonly report?: RuntimeIndexedReportRef | undefined;
  };
}

export interface RuntimeIndexedRelayStep extends RuntimeIndexedStepBase {
  readonly kind: 'relay';
  readonly role: 'researcher' | 'implementer' | 'reviewer';
  readonly connector?: string | undefined;
  readonly acceptance_criteria?: AcceptanceCriteria | undefined;
  readonly check: {
    readonly kind?: string | undefined;
    readonly source?: unknown | undefined;
    readonly pass: readonly string[];
    readonly require_empty?: readonly (readonly string[])[] | undefined;
  };
  readonly writes: RuntimeIndexedStepBase['writes'] & {
    readonly request: string;
    readonly receipt: string;
    readonly result: string;
    readonly report?: RuntimeIndexedReportRef | undefined;
  };
}

export interface RuntimeIndexedSubRunStep extends RuntimeIndexedStepBase {
  readonly kind: 'sub-run';
}

export interface RuntimeIndexedFanoutStep extends RuntimeIndexedStepBase {
  readonly kind: 'fanout';
}

export type RuntimeIndexedStep =
  | RuntimeIndexedComposeStep
  | RuntimeIndexedVerificationStep
  | RuntimeIndexedCheckpointStep
  | RuntimeIndexedRelayStep
  | RuntimeIndexedSubRunStep
  | RuntimeIndexedFanoutStep;

export interface RuntimeIndexedFlow {
  readonly id: string;
  readonly version: string;
  readonly purpose?: string | undefined;
  readonly default_selection?: SelectionOverrideValue | undefined;
  readonly stages: readonly {
    readonly id: string;
    readonly steps: readonly string[];
    readonly selection?: SelectionOverrideValue | undefined;
  }[];
  readonly steps: readonly RuntimeIndexedStep[];
}

export interface RuntimePackageIndex {
  readonly flow: RuntimeIndexedFlow;
  readonly stepsById: ReadonlyMap<string, RuntimeIndexedStep>;
  readonly reportPathBySchema: ReadonlyMap<string, string>;
}

export function requireRuntimeIndexedStep<Kind extends RuntimeIndexedStep['kind']>(
  index: RuntimePackageIndex,
  stepId: string,
  kind: Kind,
): Extract<RuntimeIndexedStep, { readonly kind: Kind }> {
  const indexedStep = index.stepsById.get(stepId);
  if (indexedStep === undefined) {
    throw new Error(`runtime package index has no step '${stepId}'`);
  }
  if (indexedStep.kind !== kind) {
    throw new Error(
      `runtime package index step '${stepId}' has kind '${indexedStep.kind}', expected '${kind}'`,
    );
  }
  return indexedStep as Extract<RuntimeIndexedStep, { readonly kind: Kind }>;
}

export function reportPathForSchemaInRuntimeFlow(
  flow: RuntimeIndexedFlow,
  schemaName: string,
): string {
  const matches = flow.steps.flatMap((step) =>
    Object.values(step.writes).flatMap((write) =>
      typeof write === 'object' && write !== null && write.schema === schemaName
        ? [{ step, write }]
        : [],
    ),
  );
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one report writer for schema '${schemaName}', found ${matches.length}`,
    );
  }
  const report = matches[0]?.write;
  if (typeof report !== 'object' || report === null) {
    throw new Error(`report writer for schema '${schemaName}' is missing a report path`);
  }
  return report.path;
}

export function flowHasReportSchemaInRuntimeFlow(
  flow: RuntimeIndexedFlow,
  schemaName: string,
): boolean {
  return flow.steps.some((step) =>
    Object.values(step.writes).some(
      (write) => typeof write === 'object' && write !== null && write.schema === schemaName,
    ),
  );
}
import type { SelectionOverride as SelectionOverrideValue } from '../../schemas/selection-policy.js';
