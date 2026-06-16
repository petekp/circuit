import type { z } from 'zod';

import {
  FLOW_BLOCK_AUTHORING_POLICY,
  FLOW_BLOCK_DEFINITIONS,
  type FlowBlockDefinition,
} from '../schemas/flow-block-definitions.js';
import {
  SchematicStep,
  type SchematicStep as SchematicStepValue,
} from '../schemas/flow-schematic.js';
import type { Validation } from './flow-definition.js';

type SchematicStepInput = z.input<typeof SchematicStep>;
type StepWritesInput = NonNullable<SchematicStepInput['writes']>;
type StepCheckInput = NonNullable<SchematicStepInput['check']>;

export interface BlockStepUse
  extends Omit<
    SchematicStepInput,
    | 'check'
    | 'checkpoint_policy'
    | 'equipment_scope'
    | 'evidence_requirements'
    | 'execution'
    | 'output'
    | 'route_overrides'
    | 'skill_slots'
    | 'writes'
  > {
  readonly output?: SchematicStepInput['output'];
  readonly evidenceRequirements?: SchematicStepInput['evidence_requirements'];
  readonly execution?: SchematicStepInput['execution'];
  readonly writes?: StepWritesInput;
  readonly check?: StepCheckInput;
  readonly reportPath?: StepWritesInput['report_path'];
  readonly requestPath?: StepWritesInput['request_path'];
  readonly receiptPath?: StepWritesInput['receipt_path'];
  readonly resultPath?: StepWritesInput['result_path'];
  readonly branchesDirPath?: StepWritesInput['branches_dir_path'];
  readonly checkpointRequestPath?: StepWritesInput['checkpoint_request_path'];
  readonly checkpointResponsePath?: StepWritesInput['checkpoint_response_path'];
  readonly required?: StepCheckInput['required'];
  readonly allow?: StepCheckInput['allow'];
  readonly allowFrom?: StepCheckInput['allow_from'];
  readonly pass?: StepCheckInput['pass'];
  readonly routeOverrides?: SchematicStepInput['route_overrides'];
  readonly checkpointPolicy?: SchematicStepInput['checkpoint_policy'];
  readonly acceptanceCriteria?: SchematicStepInput['acceptance_criteria'];
  readonly skillSlots?: SchematicStepInput['skill_slots'];
  readonly equipmentScope?: SchematicStepInput['equipment_scope'];
}

export type ComposeBlockStepUse = Omit<BlockStepUse, 'execution'>;
export type VerificationBlockStepUse = Omit<BlockStepUse, 'execution'>;
export type CheckpointBlockStepUse = Omit<BlockStepUse, 'execution'>;
export type RelayBlockStepUse = Omit<BlockStepUse, 'execution'> & {
  readonly role: NonNullable<Extract<SchematicStepInput['execution'], { kind: 'relay' }>['role']>;
};

export type ExpandBlockStepUseError =
  | {
      readonly kind: 'unknown-block-step-use';
      readonly block: string;
    }
  | {
      readonly kind: 'ambiguous-block-step-execution';
      readonly block: string;
      readonly executionKinds: readonly string[];
    }
  | {
      readonly kind: 'missing-block-step-writes';
      readonly stepId: string;
      readonly executionKind: string;
    }
  | {
      readonly kind: 'missing-block-step-check';
      readonly stepId: string;
      readonly executionKind: string;
    }
  | {
      readonly kind: 'restated-block-step-default';
      readonly stepId: string;
      readonly block: string;
      readonly field: 'evidenceRequirements' | 'execution' | 'output';
    }
  | {
      readonly kind: 'invalid-block-step-use';
      readonly message: string;
    };

const BLOCK_DEFINITION_BY_ID = new Map(FLOW_BLOCK_DEFINITIONS.map((block) => [block.id, block]));

export function expandBlockStepUseValue(
  use: BlockStepUse,
): Validation<SchematicStepValue, ExpandBlockStepUseError> {
  const block = BLOCK_DEFINITION_BY_ID.get(use.block);
  if (block === undefined || FLOW_BLOCK_AUTHORING_POLICY[use.block] === undefined) {
    return { ok: false, errors: [{ kind: 'unknown-block-step-use', block: use.block }] };
  }
  const overrideErrors = validateOverrideOnlyFields(use, block);
  if (overrideErrors.length > 0) return { ok: false, errors: overrideErrors };
  const execution = resolveExecution(use, block);
  if (!execution.ok) return execution;
  const writes = resolveWrites(use, execution.value.kind);
  if (writes === undefined) {
    return {
      ok: false,
      errors: [
        {
          kind: 'missing-block-step-writes',
          stepId: use.id,
          executionKind: execution.value.kind,
        },
      ],
    };
  }
  const check = resolveCheck(use, execution.value.kind);
  if (check === undefined) {
    return {
      ok: false,
      errors: [
        {
          kind: 'missing-block-step-check',
          stepId: use.id,
          executionKind: execution.value.kind,
        },
      ],
    };
  }
  const parsed = SchematicStep.safeParse(
    schematicStepInputFromBlockUse({ use, block, execution: execution.value, writes, check }),
  );
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    errors: [
      {
        kind: 'invalid-block-step-use',
        message: parsed.error.issues.map((issue) => issue.message).join('; '),
      },
    ],
  };
}

export function expandBlockStepUse(use: BlockStepUse): SchematicStepValue {
  const result = expandBlockStepUseValue(use);
  if (result.ok) return result.value;
  throw new Error(result.errors.map(describeExpandBlockStepUseError).join('\n'));
}

export function composeBlockStep(use: ComposeBlockStepUse): SchematicStepValue {
  return expandBlockStepUse({ ...use, execution: { kind: 'compose' } });
}

export function verificationBlockStep(use: VerificationBlockStepUse): SchematicStepValue {
  return expandBlockStepUse(use);
}

export function checkpointBlockStep(use: CheckpointBlockStepUse): SchematicStepValue {
  return expandBlockStepUse({ ...use, execution: { kind: 'checkpoint' } });
}

export function relayBlockStep(use: RelayBlockStepUse): SchematicStepValue {
  const { role, ...stepUse } = use;
  return expandBlockStepUse({ ...stepUse, execution: { kind: 'relay', role } });
}

function validateOverrideOnlyFields(
  use: BlockStepUse,
  block: FlowBlockDefinition,
): readonly ExpandBlockStepUseError[] {
  const errors: ExpandBlockStepUseError[] = [];
  if (use.output === block.output_contract) {
    errors.push({
      kind: 'restated-block-step-default',
      stepId: use.id,
      block: block.id,
      field: 'output',
    });
  }
  if (
    use.evidenceRequirements !== undefined &&
    arraysEqual(use.evidenceRequirements, block.produces_evidence)
  ) {
    errors.push({
      kind: 'restated-block-step-default',
      stepId: use.id,
      block: block.id,
      field: 'evidenceRequirements',
    });
  }
  const defaultExecutionKind = block.authoringPolicy.defaults.executionKind;
  if (
    defaultExecutionKind !== undefined &&
    use.execution?.kind === defaultExecutionKind &&
    Object.keys(use.execution).length === 1
  ) {
    errors.push({
      kind: 'restated-block-step-default',
      stepId: use.id,
      block: block.id,
      field: 'execution',
    });
  }
  return errors;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function resolveExecution(
  use: BlockStepUse,
  block: FlowBlockDefinition,
): Validation<SchematicStepInput['execution'], ExpandBlockStepUseError> {
  if (use.execution !== undefined) return { ok: true, value: use.execution };
  const executionKind = block.authoringPolicy.defaults.executionKind;
  if (executionKind === undefined) {
    return {
      ok: false,
      errors: [
        {
          kind: 'ambiguous-block-step-execution',
          block: block.id,
          executionKinds: block.schematicPolicy.executionKinds,
        },
      ],
    };
  }
  return { ok: true, value: { kind: executionKind } as SchematicStepInput['execution'] };
}

function resolveWrites(
  use: BlockStepUse,
  executionKind: SchematicStepInput['execution']['kind'],
): StepWritesInput | undefined {
  if (use.writes !== undefined) return use.writes;
  if (executionKind === 'compose' || executionKind === 'verification') {
    return use.reportPath === undefined ? undefined : { report_path: use.reportPath };
  }
  if (executionKind === 'relay') {
    if (
      use.requestPath === undefined ||
      use.receiptPath === undefined ||
      use.resultPath === undefined
    ) {
      return undefined;
    }
    return {
      request_path: use.requestPath,
      receipt_path: use.receiptPath,
      result_path: use.resultPath,
      ...(use.reportPath === undefined ? {} : { report_path: use.reportPath }),
    };
  }
  if (executionKind === 'checkpoint') {
    if (use.checkpointRequestPath === undefined || use.checkpointResponsePath === undefined) {
      return undefined;
    }
    return {
      checkpoint_request_path: use.checkpointRequestPath,
      checkpoint_response_path: use.checkpointResponsePath,
      ...(use.reportPath === undefined ? {} : { report_path: use.reportPath }),
    };
  }
  if (executionKind === 'sub-run') {
    return use.resultPath === undefined
      ? undefined
      : {
          result_path: use.resultPath,
          ...(use.reportPath === undefined ? {} : { report_path: use.reportPath }),
        };
  }
  if (executionKind === 'fanout') {
    return use.reportPath === undefined || use.branchesDirPath === undefined
      ? undefined
      : { report_path: use.reportPath, branches_dir_path: use.branchesDirPath };
  }
  return undefined;
}

function resolveCheck(
  use: BlockStepUse,
  executionKind: SchematicStepInput['execution']['kind'],
): StepCheckInput | undefined {
  if (use.check !== undefined) return use.check;
  if (executionKind === 'compose' || executionKind === 'verification') {
    return use.required === undefined ? undefined : { required: use.required };
  }
  if (executionKind === 'checkpoint') {
    if (use.allow !== undefined) return { allow: use.allow };
    return use.allowFrom === undefined ? undefined : { allow_from: use.allowFrom };
  }
  return use.pass === undefined ? undefined : { pass: use.pass };
}

function schematicStepInputFromBlockUse(input: {
  readonly use: BlockStepUse;
  readonly block: FlowBlockDefinition;
  readonly execution: SchematicStepInput['execution'];
  readonly writes: StepWritesInput;
  readonly check: StepCheckInput;
}): SchematicStepInput {
  const { block, check, execution, use, writes } = input;
  const {
    checkpointPolicy,
    equipmentScope,
    evidenceRequirements,
    output,
    routeOverrides,
    skillSlots,
    acceptanceCriteria,
    reportPath: _reportPath,
    requestPath: _requestPath,
    receiptPath: _receiptPath,
    resultPath: _resultPath,
    branchesDirPath: _branchesDirPath,
    checkpointRequestPath: _checkpointRequestPath,
    checkpointResponsePath: _checkpointResponsePath,
    required: _required,
    allow: _allow,
    allowFrom: _allowFrom,
    pass: _pass,
    writes: _writes,
    check: _check,
    execution: _execution,
    ...step
  } = use;
  return {
    ...step,
    output: output ?? block.output_contract,
    evidence_requirements: evidenceRequirements ?? block.produces_evidence,
    execution,
    writes,
    check,
    ...(acceptanceCriteria === undefined ? {} : { acceptance_criteria: acceptanceCriteria }),
    ...(checkpointPolicy === undefined ? {} : { checkpoint_policy: checkpointPolicy }),
    ...(routeOverrides === undefined ? {} : { route_overrides: routeOverrides }),
    ...(skillSlots === undefined ? {} : { skill_slots: skillSlots }),
    ...(equipmentScope === undefined ? {} : { equipment_scope: equipmentScope }),
  };
}

function describeExpandBlockStepUseError(error: ExpandBlockStepUseError): string {
  if (error.kind === 'unknown-block-step-use') return `unknown Block '${error.block}'`;
  if (error.kind === 'ambiguous-block-step-execution') {
    return `Block '${error.block}' has ambiguous execution kinds: ${error.executionKinds.join(', ')}`;
  }
  if (error.kind === 'missing-block-step-writes') {
    return `Block Step '${error.stepId}' needs explicit paths for ${error.executionKind} writes`;
  }
  if (error.kind === 'missing-block-step-check') {
    return `Block Step '${error.stepId}' needs explicit check data for ${error.executionKind}`;
  }
  if (error.kind === 'restated-block-step-default') {
    return `Block Step '${error.stepId}' restates default ${error.field} for Block '${error.block}'`;
  }
  return error.message;
}
