import { assembleFlowSchematic } from '../assemble-flow-schematic.js';
import type { FlowData } from '../flow-definition.js';
import { prototypeAssemblySpec } from './assembly-spec.js';
import {
  prototypeArtifactShapeHint,
  prototypeVariantArtifactShapeHint,
  prototypeVariantReviewShapeHint,
} from './relay-hints.js';
import {
  PrototypeArtifact,
  PrototypeBrief,
  PrototypePlan,
  PrototypeResult,
  PrototypeVariantAggregate,
  PrototypeVariantArtifact,
  PrototypeVariantChoiceOptions,
  PrototypeVariantOptions,
  PrototypeVariantProviderEvidence,
  PrototypeVariantReview,
  PrototypeVariantVerification,
  PrototypeVerification,
} from './reports.js';
import { prototypeBriefComposeBuilder } from './writers/brief.js';
import { prototypeCloseBuilder } from './writers/close.js';
import { prototypePlanComposeBuilder } from './writers/plan.js';
import { prototypeVariantChoiceOptionsComposeBuilder } from './writers/variant-choice-options.js';
import { prototypeVariantOptionsComposeBuilder } from './writers/variant-options.js';
import { prototypeVariantProviderEvidenceComposeBuilder } from './writers/variant-provider-evidence.js';
import { prototypeVariantVerificationWriter } from './writers/variant-verification.js';
import { prototypeVerificationWriter } from './writers/verification.js';

export const prototypeFlowData = {
  id: 'prototype',
  visibility: 'public',
  paths: {
    schematic: 'src/flows/prototype/schematic.json',
    contract: 'src/flows/prototype/contract.md',
  },
  // First-class composition (A5): prototype is one of the assembler's
  // production customers, and its fanout / tournament stress-test. Its block
  // sequence (including the dynamic variant fanout, two checkpoints, and the
  // non-monotonic single-artifact vs model-comparison branches), scaffolding,
  // engine_flags, and required_config live in ./assembly-spec.ts;
  // `assembleFlowSchematic` derives starts_at / stages / stage_path_policy and
  // returns the validated FlowSchematic that used to be a hand-authored literal
  // here. The prove-by-equivalence test proves byte-identity (schematic +
  // compiled).
  schematic: assembleFlowSchematic(prototypeAssemblySpec),
  canonicalStagePolicy: {
    kind: 'enforce',
    canonicals: ['frame', 'plan', 'act', 'verify', 'review', 'close'],
    omits: ['analyze'],
    optional_canonicals: [],
    variants: [],
    title: 'Frame -> Plan -> Act -> Verify -> Review -> Close',
    authority: 'src/flows/prototype/contract.md Prototype Flow Contract',
  },
  reports: [
    {
      schemaName: 'prototype.artifact@v1',
      channel: 'relay',
      schema: PrototypeArtifact,
      relayHint: prototypeArtifactShapeHint.instruction,
    },
    {
      schemaName: 'prototype.variant-artifact@v1',
      channel: 'relay',
      schema: PrototypeVariantArtifact,
      relayHint: prototypeVariantArtifactShapeHint.instruction,
    },
    {
      schemaName: 'prototype.variant-review@v1',
      channel: 'relay',
      schema: PrototypeVariantReview,
      relayHint: prototypeVariantReviewShapeHint.instruction,
    },
    {
      schemaName: 'prototype.brief@v1',
      channel: 'report',
      schema: PrototypeBrief,
      writers: { compose: [prototypeBriefComposeBuilder] },
    },
    {
      schemaName: 'prototype.plan@v1',
      channel: 'report',
      schema: PrototypePlan,
      writers: { compose: [prototypePlanComposeBuilder] },
    },
    {
      schemaName: 'prototype.variant-options@v1',
      channel: 'report',
      schema: PrototypeVariantOptions,
      writers: { compose: [prototypeVariantOptionsComposeBuilder] },
    },
    {
      schemaName: 'prototype.variant-aggregate@v1',
      channel: 'report',
      schema: PrototypeVariantAggregate,
    },
    {
      schemaName: 'prototype.variant-provider-evidence@v1',
      channel: 'report',
      schema: PrototypeVariantProviderEvidence,
      writers: { compose: [prototypeVariantProviderEvidenceComposeBuilder] },
    },
    {
      schemaName: 'prototype.variant-verification@v1',
      channel: 'report',
      schema: PrototypeVariantVerification,
      writers: { verification: [prototypeVariantVerificationWriter] },
    },
    {
      schemaName: 'prototype.variant-choice-options@v1',
      channel: 'report',
      schema: PrototypeVariantChoiceOptions,
      writers: { compose: [prototypeVariantChoiceOptionsComposeBuilder] },
    },
    {
      schemaName: 'prototype.verification@v1',
      channel: 'report',
      schema: PrototypeVerification,
      writers: { verification: [prototypeVerificationWriter] },
    },
    {
      schemaName: 'prototype.result@v1',
      channel: 'report',
      schema: PrototypeResult,
      writers: { close: [prototypeCloseBuilder] },
    },
  ],
  runtimeSurface: {
    primaryResult: {
      schemaName: 'prototype.result@v1',
      path: 'reports/prototype-result.json',
      label: 'Prototype result',
    },
    progress: {
      steps: [
        {
          stepId: 'frame-step',
          taskTitle: 'Frame the prototype',
          activeText: 'Framing the prototype',
        },
        {
          stepId: 'plan-step',
          taskTitle: 'Plan the artifact',
          activeText: 'Planning the artifact',
        },
        {
          stepId: 'act-step',
          taskTitle: 'Create the prototype',
          activeText: 'Creating the prototype',
          relayRole: 'implementer',
          relayStartedText: 'Asking the specialist to create the prototype...',
          relayCompletedText: 'Finished creating the prototype.',
        },
        {
          stepId: 'variant-options-step',
          taskTitle: 'Resolve model variants',
          activeText: 'Resolving model variants',
        },
        {
          stepId: 'variant-fanout-step',
          taskTitle: 'Create prototype variants',
          activeText: 'Creating prototype variants',
        },
        {
          stepId: 'variant-provider-evidence-step',
          taskTitle: 'Capture provider evidence',
          activeText: 'Capturing provider evidence',
        },
        {
          stepId: 'variant-verification-step',
          taskTitle: 'Check prototype variants',
          activeText: 'Checking prototype variants',
        },
        {
          stepId: 'variant-review-step',
          taskTitle: 'Compare prototype variants',
          activeText: 'Comparing prototype variants',
          relayRole: 'reviewer',
          relayStartedText: 'Asking the reviewer to compare the variants...',
          relayCompletedText: 'Finished comparing the variants.',
        },
        {
          stepId: 'variant-choice-options-step',
          taskTitle: 'Prepare variant choices',
          activeText: 'Preparing variant choices',
        },
        {
          stepId: 'prototype-variant-checkpoint-step',
          taskTitle: 'Choose variant',
          activeText: 'Waiting on the Prototype variant checkpoint',
        },
        {
          stepId: 'close-model-comparison-step',
          taskTitle: 'Wrap up model comparison',
          activeText: 'Wrapping up model comparison',
        },
        {
          stepId: 'verify-step',
          taskTitle: 'Check the artifact',
          activeText: 'Checking the artifact',
        },
        {
          stepId: 'prototype-checkpoint-step',
          taskTitle: 'Choose what to do next',
          activeText: 'Waiting on the Prototype checkpoint',
        },
        {
          stepId: 'close-step',
          taskTitle: 'Wrap up',
          activeText: 'Wrapping up',
        },
      ],
    },
  },
  // The tournament axis fans out one relay per configured model variant, so it
  // cannot run without operator-provided variant models. Declare the
  // prerequisite so the CLI rejects up-front (exit 2, no run folder) instead of
  // aborting at the variant-options step after framing and planning work. The
  // variant-options writer keeps its own check as a last line of defense.
  requiredConfig: [
    {
      axis: 'tournament',
      path: 'circuits.prototype.variant_models',
      message:
        "prototype --tournament requires 'circuits.prototype.variant_models' in your Circuit config (one variant model per tournament branch). Add it under circuits.prototype.variant_models, or run prototype without --tournament.",
    },
  ],
} satisfies FlowData;
