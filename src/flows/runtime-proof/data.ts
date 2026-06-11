import type { FlowData } from '../flow-definition.js';
import { RuntimeProofCompose } from './reports.js';
import { runtimeProofComposeBuilder } from './writers/compose.js';

const runtimeProofPaths = {
  schematic: 'src/flows/runtime-proof/schematic.json',
} satisfies FlowData['paths'];

const runtimeProofSchematic = {
  schema_version: '2',
  id: 'runtime-proof',
  title: 'Runtime Proof Schematic',
  purpose:
    'Runtime Proof flow: exercise one compose step and one relay step end-to-end so the runtime boundary can be observed closing a real run.',
  status: 'active',
  version: '0.1.0',
  starts_at: 'compose-step',
  initial_contracts: ['flow.brief@v1'],
  contract_aliases: [],
  axes: {
    allowed_depths: ['standard'],
    supports_tournament: false,
    supports_autonomous: false,
    default: {
      depth: 'standard',
      tournament: false,
      tournament_n: 3,
      autonomous: false,
    },
  },
  stage_path_policy: {
    mode: 'partial',
    omits: ['frame', 'analyze', 'verify', 'review', 'close'],
    rationale:
      'Runtime Proof is a narrow proof flow; only plan and act are needed to exercise compose and relay through the runtime boundary.',
  },
  stages: [
    {
      id: 'plan-stage',
      canonical: 'plan',
      title: 'Plan',
    },
    {
      id: 'act-stage',
      canonical: 'act',
      title: 'Act',
    },
  ],
  items: [
    {
      id: 'compose-step',
      title: 'Compose runtime proof report',
      stage: 'plan',
      block: 'plan',
      input: {
        brief: 'flow.brief@v1',
      },
      output: 'plan.strategy@v1',
      evidence_requirements: ['ordered steps', 'risk notes', 'proof strategy'],
      execution: {
        kind: 'compose',
      },
      protocol: 'runtime-proof-compose@v1',
      writes: {
        report_path: 'reports/compose.json',
      },
      check: {
        required: ['summary'],
      },
      routes: {
        continue: 'relay-step',
      },
    },
    {
      id: 'relay-step',
      title: 'Relay dry-run connector',
      stage: 'act',
      block: 'act',
      input: {
        brief: 'flow.brief@v1',
        plan: 'plan.strategy@v1',
      },
      output: 'change.evidence@v1',
      evidence_requirements: ['changed files', 'change rationale', 'declared follow-up proof'],
      execution: {
        kind: 'relay',
        role: 'implementer',
      },
      protocol: 'runtime-proof-relay@v1',
      writes: {
        request_path: 'reports/relay.request.json',
        receipt_path: 'reports/relay.receipt.json',
        result_path: 'reports/relay.result.json',
      },
      check: {
        pass: ['ok'],
      },
      routes: {
        continue: '@complete',
      },
    },
  ],
} satisfies FlowData['schematic'];

const runtimeProofCanonicalStagePolicy = {
  kind: 'exempt',
  reason: 'partial-stage path, recorded',
} satisfies FlowData['canonicalStagePolicy'];

const runtimeProofReports = [
  {
    schemaName: 'runtime-proof.compose@v1',
    channel: 'report',
    schema: RuntimeProofCompose,
    writers: { compose: [runtimeProofComposeBuilder] },
  },
] satisfies NonNullable<FlowData['reports']>;

export const runtimeProofFlowData = {
  id: 'runtime-proof',
  visibility: 'internal',
  paths: runtimeProofPaths,
  schematic: runtimeProofSchematic,
  canonicalStagePolicy: runtimeProofCanonicalStagePolicy,
  reportWriterSchemaAliases: ['plan.strategy@v1'],
  reports: runtimeProofReports,
} satisfies FlowData;
