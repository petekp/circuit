#!/usr/bin/env node

import { Command } from 'commander';
import type {
  CapabilityAxes,
  CurrentCapability,
  CurrentCapabilitySnapshot,
  FlowAxisSupportRecord,
  OriginalCapability,
  OriginalCapabilitySnapshot,
  ParityException,
} from '../../src/release/schemas.js';
import {
  formatMarkdown,
  loadJsonWithSchema,
  loadReleaseChecks,
  loadReleaseSchemas,
  loadYamlWithSchema,
  writeOrCheck,
} from './shared.ts';

const OUT_REL = 'docs/release/parity-matrix.generated.md';
const program = new Command('render-parity-matrix').option('--check');
program.parse(process.argv.slice(2), { from: 'user' });
const check = program.opts<{ check?: boolean }>().check === true;

type CapabilityById = Map<string, CurrentCapability>;
type ExceptionByCapability = Map<string, ParityException>;
// The behavioral-axis comparator (from the typed checks module) reads only the
// `axes` field; expected requires it, actual treats it as optional.
type AxisMismatchFn = (args: {
  expected: { readonly axes: CapabilityAxes };
  actual: { readonly axes?: CapabilityAxes };
}) => readonly unknown[];

function mdCell(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.length === 0 ? '' : value.map(String).join(', ');
  return String(value).replaceAll('\n', ' ');
}

function statusWithAxes(
  original: OriginalCapability,
  current: CurrentCapability | undefined,
  exceptionByCapability: ExceptionByCapability,
  behavioralAxisMismatches: AxisMismatchFn,
): string {
  const exception = exceptionByCapability.get(original.id);
  if (current === undefined) {
    return String(exception?.status ?? 'missing');
  }
  if (current.status !== 'implemented') return String(exception?.status ?? current.status);
  const mismatches = behavioralAxisMismatches({ expected: original, actual: current });
  if (mismatches.length === 0) return 'implemented';
  return String(exception?.status ?? 'partial');
}

function axisCell(
  original: OriginalCapability,
  current: CurrentCapability | undefined,
  key: keyof CapabilityAxes,
): string {
  const expected = original.axes[key];
  const actual = current?.axes?.[key];
  const expectedText = mdCell(expected);
  const actualText = mdCell(actual);
  if (expectedText === '') return actualText;
  if (actualText === '') return `expected: ${expectedText}`;
  if (expectedText.toLowerCase() === actualText.toLowerCase()) return actualText;
  return `current: ${actualText}; expected: ${expectedText}`;
}

function renderFlowRows(
  original: OriginalCapabilitySnapshot,
  currentById: CapabilityById,
  exceptionByCapability: ExceptionByCapability,
  behavioralAxisMismatches: AxisMismatchFn,
): string {
  const rows = original.capabilities
    .filter((capability) => capability.kind === 'flow')
    .map((capability) => {
      const current = currentById.get(capability.id);
      const status = statusWithAxes(
        capability,
        current,
        exceptionByCapability,
        behavioralAxisMismatches,
      );
      const readiness =
        exceptionByCapability.get(capability.id)?.readiness_ref ??
        (status === 'partial' ? 'REL-004' : '');
      return [
        capability.title,
        capability.id,
        status,
        axisCell(capability, current, 'modes'),
        axisCell(capability, current, 'stage_path'),
        axisCell(capability, current, 'outputs'),
        axisCell(capability, current, 'checkpoint'),
        axisCell(capability, current, 'review'),
        axisCell(capability, current, 'verification'),
        axisCell(capability, current, 'worker_handoff'),
        axisCell(capability, current, 'continuity'),
        axisCell(capability, current, 'proof'),
        readiness,
      ];
    });
  return table(
    [
      'Flow',
      'Capability',
      'Status',
      'Modes',
      'Stage Path',
      'Outputs / Reports',
      'Checkpoint',
      'Review',
      'Verification',
      'Worker Handoff',
      'Continuity',
      'Proof',
      'Readiness',
    ],
    rows,
  );
}

function renderOtherRows(
  original: OriginalCapabilitySnapshot,
  currentById: CapabilityById,
  exceptionByCapability: ExceptionByCapability,
  behavioralAxisMismatches: AxisMismatchFn,
): string {
  const rows = original.capabilities
    .filter((capability) => capability.kind !== 'flow')
    .map((capability) => {
      const current = currentById.get(capability.id);
      const status = statusWithAxes(
        capability,
        current,
        exceptionByCapability,
        behavioralAxisMismatches,
      );
      return [
        capability.kind,
        capability.title,
        capability.id,
        status,
        mdCell(capability.axes.invocation),
        axisCell(capability, current, 'modes'),
        axisCell(capability, current, 'checkpoint'),
        axisCell(capability, current, 'review'),
        axisCell(capability, current, 'verification'),
        axisCell(capability, current, 'worker_handoff'),
        axisCell(capability, current, 'continuity'),
        axisCell(capability, current, 'proof'),
        exceptionByCapability.get(capability.id)?.readiness_ref ??
          current?.readiness_refs.join(', ') ??
          '',
      ];
    });
  return table(
    [
      'Kind',
      'Name',
      'Capability',
      'Status',
      'Invocation',
      'Modes',
      'Checkpoint',
      'Review',
      'Verification',
      'Worker Handoff',
      'Continuity',
      'Proof',
      'Readiness',
    ],
    rows,
  );
}

function axisSelectionsFor(axes: FlowAxisSupportRecord): string[] {
  const selections = new Set<string>();
  const allowedDepths = axes.allowed_depths;
  if (allowedDepths.includes('standard')) selections.add('default');
  if (allowedDepths.includes('lite')) selections.add('lite');
  if (allowedDepths.includes('deep')) selections.add('deep');
  if (axes.supports_tournament) selections.add('tournament');
  if (axes.supports_autonomous) selections.add('autonomous');
  return [...selections].sort();
}

function renderCurrentModeRows(current: CurrentCapabilitySnapshot): string {
  const rows = current.flows.map((flow) => [
    flow.id,
    axisSelectionsFor(flow.axis_support).join(', '),
    flow.route_outcomes.map(String).join(', '),
    flow.unsupported_route_outcomes.map(String).join(', '),
  ]);
  return table(['Current Flow', 'Axis Selections', 'Declared Routes', 'Unsupported Routes'], rows);
}

function table(headers: string[], rows: unknown[][]): string {
  const headerLine = `| ${headers.join(' | ')} |`;
  const sep = `| ${headers.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.map(mdCell).join(' | ')} |`);
  return [headerLine, sep, ...body].join('\n');
}

async function main() {
  const schemas = await loadReleaseSchemas();
  const checks = await loadReleaseChecks();
  const original = loadYamlWithSchema(
    'docs/release/parity/original-circuit.yaml',
    schemas.OriginalCapabilitySnapshot,
  );
  const current = loadJsonWithSchema(
    'generated/release/current-capabilities.json',
    schemas.CurrentCapabilitySnapshot,
  );
  const exceptions = loadYamlWithSchema(
    'docs/release/parity/exceptions.yaml',
    schemas.ParityExceptionLedger,
  );
  const currentById: CapabilityById = new Map(
    current.capabilities.map((capability) => [capability.id, capability]),
  );
  const exceptionByCapability: ExceptionByCapability = new Map(
    exceptions.exceptions
      .filter((exception) => exception.capability_id !== undefined)
      .map((exception) => [exception.capability_id as string, exception]),
  );

  const lines = [
    '# Circuit Parity Matrix',
    '',
    '<!-- Generated by scripts/release/render-parity-matrix.ts. Do not edit by hand. -->',
    '',
    'Compares the checked-in original Circuit snapshot with the current capability snapshot. A `release_blocker` gap is known and tracked; it does not mean the release is ready.',
    '',
    '## Original Parity Surface',
    '',
    renderFlowRows(original, currentById, exceptionByCapability, checks.behavioralAxisMismatches),
    '',
    '## Utilities, Intents, Connectors, And Operator Features',
    '',
    renderOtherRows(original, currentById, exceptionByCapability, checks.behavioralAxisMismatches),
    '',
    '## Current Route And Axis Inventory',
    '',
    renderCurrentModeRows(current),
    '',
  ];

  writeOrCheck(OUT_REL, formatMarkdown(lines.join('\n')), check);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
