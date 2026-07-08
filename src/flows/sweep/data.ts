import { assembleFlowSchematic } from '../assemble-flow-schematic.js';
import type { FlowData } from '../flow-definition.js';
import { sweepAssemblySpec } from './assembly-spec.js';
import { sweepUnitFixShapeHint } from './relay-hints.js';
import {
  SweepCensus,
  SweepPartition,
  SweepUnitFix,
  SweepVerification,
  SweepWaveAggregate,
} from './reports.js';
import { sweepCensusComposeBuilder } from './writers/census.js';
import { sweepPartitionComposeBuilder } from './writers/partition.js';
import { sweepRescanVerificationWriter } from './writers/verification.js';

const sweepPaths = {
  schematic: 'src/flows/sweep/schematic.json',
} satisfies FlowData['paths'];

// First-class composition: sweep is an assembler customer, like fix-until-green.
// Its block sequence and the until-loop engine flag live in ./assembly-spec.ts;
// `assembleFlowSchematic` derives starts_at / stages / stage_path_policy and
// carries the until flag through to the returned FlowSchematic.
const sweepSchematic = assembleFlowSchematic(sweepAssemblySpec) satisfies FlowData['schematic'];

const sweepCanonicalStagePolicy = {
  kind: 'exempt',
  reason: 'partial-stage path, recorded',
} satisfies FlowData['canonicalStagePolicy'];

// Sweep owns the `sweep.*` schema names on the global compose, verification, and
// report-schema registries. Five reports:
//   sweep.census@v1     — compose. The preamble; pins the oracle commands.
//   sweep.partition@v1  — compose. The loop head; re-scans and groups survivors.
//   sweep.wave-aggregate@v1 — the engine's fanout aggregate (no writer; the
//     fanout executor writes it after joining the wave).
//   sweep.unit-fix@v1   — relay. A fanout worker's typed report; the relayHint
//     tells the worker the exact JSON shape to emit.
//   sweep.verification@v1 — verification. The rescan floor the until-loop reads.
// The judge tail's converge.judgment@v1 is a built-in contract; fix-until-green
// registers its structural shape hint globally, so sweep does not restate it.
const sweepReports = [
  {
    schemaName: 'sweep.census@v1',
    channel: 'report',
    schema: SweepCensus,
    writers: { compose: [sweepCensusComposeBuilder] },
  },
  {
    schemaName: 'sweep.partition@v1',
    channel: 'report',
    schema: SweepPartition,
    writers: { compose: [sweepPartitionComposeBuilder] },
  },
  {
    schemaName: 'sweep.wave-aggregate@v1',
    channel: 'report',
    schema: SweepWaveAggregate,
  },
  {
    schemaName: 'sweep.unit-fix@v1',
    channel: 'relay',
    schema: SweepUnitFix,
    relayHint: sweepUnitFixShapeHint.instruction,
  },
  {
    schemaName: 'sweep.verification@v1',
    channel: 'report',
    schema: SweepVerification,
    writers: { verification: [sweepRescanVerificationWriter] },
  },
] satisfies NonNullable<FlowData['reports']>;

export const sweepFlowData = {
  id: 'sweep',
  visibility: 'internal',
  paths: sweepPaths,
  schematic: sweepSchematic,
  canonicalStagePolicy: sweepCanonicalStagePolicy,
  reports: sweepReports,
} satisfies FlowData;
