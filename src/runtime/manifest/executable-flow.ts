import type {
  CompiledFlowAxisConfigRequirement,
  CompiledFlowEngineFlags,
} from '../../flows/types.js';
import type { AcceptanceCriteria } from '../../schemas/acceptance-criteria.js';
import type { Axes } from '../../schemas/axes.js';
import type {
  Check,
  CheckpointSelectionCheck,
  FanoutAggregateCheck,
  ResultVerdictCheck,
  SchemaSectionsCheck,
} from '../../schemas/check.js';
import type { EquipmentScope } from '../../schemas/equipment-scope.js';
import type { ReportFileSurfaceDeclaration } from '../../schemas/report-file-surface.js';
import type {
  CheckpointPolicy,
  FanoutBranches,
  FanoutConcurrency,
  FanoutFailurePolicy,
  FanoutRubric,
  StepBudgets,
} from '../../schemas/step.js';
import type { ExecutableStage, FlowId } from '../domain/flow.js';
import type { Routes } from '../domain/route.js';
import type { RunFileRef } from '../domain/run-file.js';
import type { Selection } from '../domain/selection.js';
import type { StepId } from '../domain/step.js';

export interface ExecutableEntryMode {
  readonly name: string;
  readonly startAt: StepId;
  readonly depth: string;
  readonly description: string;
  readonly defaultChangeKind?: string;
}

export interface BaseStep {
  readonly id: StepId;
  readonly title?: string;
  readonly protocol?: string;
  readonly routes: Routes;
  readonly reads?: readonly RunFileRef[];
  readonly writes?: Readonly<Record<string, RunFileRef>>;
  readonly selection?: Selection;
  readonly skillSlots?: readonly unknown[];
  readonly equipmentScope?: EquipmentScope;
  readonly routeFromReport?: { readonly path: readonly string[] };
  readonly check: Check;
  readonly budgets?: StepBudgets;
}

export interface ComposeStep extends BaseStep {
  readonly kind: 'compose';
  readonly writer: string;
  readonly body?: unknown;
}

export interface VerificationStep extends BaseStep {
  readonly kind: 'verification';
  readonly check: SchemaSectionsCheck;
}

export interface CheckpointStep extends BaseStep {
  readonly kind: 'checkpoint';
  readonly choices: readonly string[];
  readonly policy: CheckpointPolicy;
  readonly check: CheckpointSelectionCheck;
}

export interface RelayStep extends BaseStep {
  readonly kind: 'relay';
  readonly role: string;
  readonly acceptanceCriteria?: AcceptanceCriteria;
  readonly connector?: string;
  readonly prompt?: string;
  readonly report?: RunFileRef;
  readonly check: ResultVerdictCheck;
}

export interface SubRunStep extends BaseStep {
  readonly kind: 'sub-run';
  readonly flowRef: FlowId;
  readonly entryMode: string;
  readonly version?: string;
  readonly goal: string;
  readonly depth: string;
  readonly check: ResultVerdictCheck;
}

export interface FanoutStep extends BaseStep {
  readonly kind: 'fanout';
  readonly branches: FanoutBranches;
  readonly concurrency: FanoutConcurrency;
  readonly onChildFailure?: FanoutFailurePolicy;
  readonly rubric?: FanoutRubric;
  readonly check: FanoutAggregateCheck;
}

export type ExecutableStep =
  | ComposeStep
  | VerificationStep
  | CheckpointStep
  | RelayStep
  | SubRunStep
  | FanoutStep;

export interface ExecutableFlow {
  readonly id: FlowId;
  readonly version: string;
  readonly entry: StepId;
  readonly entryModes?: readonly ExecutableEntryMode[];
  readonly stages: readonly ExecutableStage[];
  readonly steps: readonly ExecutableStep[];
  readonly purpose?: string;
  readonly defaultSelection?: Selection;
  readonly stagePathPolicy?: unknown;
  readonly metadata?: Record<string, unknown>;
  readonly axes?: Axes;
  // Stage 3 (first-class composition): engine-visible behavior flags carried
  // from the compiled manifest's snake_case `engine_flags`, translated to the
  // in-code shape at the manifest→runtime boundary. Absent when the manifest
  // declares none; the engine then resolves them from the by-id catalog package.
  readonly engineFlags?: CompiledFlowEngineFlags;
  // Stage 3b (first-class composition): execution-bearing declarations carried
  // from the compiled manifest. reportFileSurfaces feeds the skill-hook
  // edit-file surface table; runtimeSurface.primaryResult binds the terminal
  // outcome to the result report; requiredConfig is the CLI's up-front config
  // gate. Absent when the manifest declares none; the engine then resolves them
  // from the by-id catalog package.
  readonly reportFileSurfaces?: Readonly<Record<string, ReportFileSurfaceDeclaration>>;
  readonly runtimeSurface?: {
    readonly primaryResult?: { readonly schemaName: string; readonly path: string };
  };
  readonly requiredConfig?: readonly CompiledFlowAxisConfigRequirement[];
}
