#!/usr/bin/env node

import { existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from 'commander';

import type * as CatalogModule from '../../src/flows/catalog.js';
import type * as ReleaseSchemasModule from '../../src/release/schemas.js';
import type * as ConnectorSchemasModule from '../../src/schemas/connector.js';

import {
  fileIsPresent,
  formatWithBiome,
  listMarkdownBasenames,
  loadYamlWithSchema,
  projectRoot,
  readJson,
  stableJson,
  writeOrCheck,
} from './shared.ts';

type FlowPackage = CatalogModule.CompiledFlowPackage;
type ProofScenarios = ReturnType<(typeof ReleaseSchemasModule)['ProofScenarioIndex']['parse']>;
type ConnectorSchemas = typeof ConnectorSchemasModule;
type ConnectorRecord = {
  id: string;
  status: 'implemented' | 'missing';
  filesystem: string;
  structured_output: string;
  protocol: string;
  summary: string;
  readiness_refs: string[];
};
type HostRecord = {
  id: string;
  status: string;
  summary: string;
  evidence: string[];
  readiness_refs: string[];
};
type FlowGeneratedFile = {
  rel: string;
  json: {
    axes?: FlowAxisSupport;
    stages?: Array<{ id?: string; canonical?: string; title?: string }>;
    steps?: Array<{
      kind?: string;
      role?: string;
      writes?: {
        report?: { schema?: string };
        aggregate?: { schema?: string };
      };
    }>;
  };
};
type FlowAxisSupport = {
  allowed_depths: string[];
  supports_tournament: boolean;
  supports_autonomous: boolean;
  default: {
    depth: string;
    tournament: boolean;
    tournament_n: number;
    autonomous: boolean;
  };
  tournament_fan_out_stage?: string;
};
type FlowRecord = {
  id: string;
  source: string;
  command_path?: string;
  contract_path?: string;
  axis_support: FlowAxisSupport;
  stages: string[];
  reports: string[];
  writers: {
    compose: number;
    close: number;
    verification: number;
    checkpoint: number;
  };
  route_outcomes: string[];
  unsupported_route_outcomes: string[];
};

const program = new Command('emit-current-capabilities').option('--check');
program.parse(process.argv.slice(2), { from: 'user' });
const check = program.opts<{ check?: boolean }>().check === true;
const OUT_REL = 'generated/release/current-capabilities.json';
const EXECUTABLE_SCHEMATIC_ROUTES = new Set([
  'ask',
  'complete',
  'continue',
  'escalate',
  'handoff',
  'retry',
  'revise',
  'split',
  'stop',
]);
const CANONICAL_STAGE_ORDER = ['frame', 'analyze', 'plan', 'act', 'verify', 'review', 'close'];

function flowDir(id: string): string {
  return resolve(projectRoot, 'generated/flows', id);
}

function readGeneratedFlowFiles(id: string): FlowGeneratedFile[] {
  const dir = flowDir(id);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith('.json') && !entry.endsWith('.work-contract.v0.json'))
    .sort()
    .map((entry) => ({
      rel: `generated/flows/${id}/${entry}`,
      json: readJson<FlowGeneratedFile['json']>(`generated/flows/${id}/${entry}`),
    }));
}

function stableAxisSupportKey(axes: FlowAxisSupport): string {
  return JSON.stringify({
    allowed_depths: axes.allowed_depths,
    supports_tournament: axes.supports_tournament,
    supports_autonomous: axes.supports_autonomous,
    default: axes.default,
    ...(axes.tournament_fan_out_stage === undefined
      ? {}
      : { tournament_fan_out_stage: axes.tournament_fan_out_stage }),
  });
}

function axisSupportFor(id: string): FlowAxisSupport {
  let support: FlowAxisSupport | undefined;
  let supportKey: string | undefined;
  for (const file of readGeneratedFlowFiles(id)) {
    if (file.json.axes === undefined) continue;
    const key = stableAxisSupportKey(file.json.axes);
    if (supportKey !== undefined && supportKey !== key) {
      throw new Error(`${file.rel} declares axis support that differs from other ${id} fixtures`);
    }
    support = file.json.axes;
    supportKey = key;
  }
  if (support === undefined) {
    throw new Error(`generated flow ${id} has no axes block`);
  }
  return support;
}

function axisSelectionsFor(axes: FlowAxisSupport): string[] {
  const selections = new Set<string>();
  if (axes.allowed_depths.includes('medium')) selections.add('default');
  if (axes.allowed_depths.includes('low')) selections.add('low');
  if (axes.allowed_depths.includes('high')) selections.add('high');
  if (axes.supports_tournament) selections.add('tournament');
  if (axes.supports_autonomous) selections.add('autonomous');
  return [...selections].sort();
}

function stageAxisLabel(
  flowId: string,
  stage: { id?: string; canonical?: string; title?: string },
): string | undefined {
  const canonical = stage.canonical ?? stage.id;
  if (canonical === 'plan' && /decision/i.test(stage.title ?? '')) return 'Plan or Decision';
  if (flowId === 'fix' && canonical === 'act') return 'Fix';
  if (typeof stage.title === 'string' && stage.title.length > 0) return stage.title;
  return canonical;
}

function stagesFor(id: string): string[] {
  const stages = new Map<string, { label: string; order: number }>();
  for (const file of readGeneratedFlowFiles(id)) {
    for (const stage of file.json.stages ?? []) {
      const label = stageAxisLabel(id, stage);
      if (typeof label !== 'string') continue;
      const canonical = stage.canonical ?? stage.id ?? '';
      const order = CANONICAL_STAGE_ORDER.indexOf(canonical);
      stages.set(label, {
        label,
        order: order === -1 ? Number.MAX_SAFE_INTEGER : order,
      });
    }
  }
  return [...stages.values()]
    .sort((left, right) => left.order - right.order || left.label.localeCompare(right.label))
    .map((stage) => stage.label);
}

function reportsFor(pkg: FlowPackage): string[] {
  const reports = new Set<string>(pkg.relayReports.map((report) => report.schemaName));
  for (const file of readGeneratedFlowFiles(pkg.id)) {
    for (const step of file.json.steps ?? []) {
      const writes = step.writes ?? {};
      if (typeof writes.report?.schema === 'string') reports.add(writes.report.schema);
      if (typeof writes.aggregate?.schema === 'string') reports.add(writes.aggregate.schema);
    }
  }
  return [...reports].sort();
}

const SEMANTIC_OUTPUTS_BY_REPORT = new Map(
  Object.entries({
    'build.brief@v1': ['brief.md'],
    'build.plan@v1': ['plan.md'],
    'build.review@v1': ['review.md'],
    'build.result@v1': ['result.md'],
    'explore.brief@v1': ['brief.md'],
    'explore.analysis@v1': ['analysis.md'],
    'explore.compose@v1': ['plan.md'],
    'explore.decision-options@v1': ['decision.md'],
    'explore.decision@v1': ['decision.md'],
    'explore.result@v1': ['result.md'],
    'fix.brief@v1': ['brief.md'],
    'fix.context@v1': ['analysis.md'],
    'fix.diagnosis@v1': ['analysis.md'],
    'fix.review@v1': ['review.md'],
    'fix.result@v1': ['result.md'],
    'review.result@v1': ['review.md'],
  }),
);

function semanticOutputsFor(record: FlowRecord): string[] {
  const outputs = new Set<string>();
  for (const report of record.reports) {
    for (const output of SEMANTIC_OUTPUTS_BY_REPORT.get(report) ?? []) {
      outputs.add(output);
    }
  }
  return [...outputs].sort();
}

type SchematicRouteItem = {
  routes?: Record<string, unknown>;
  route_overrides?: Record<string, unknown>;
};
type SchematicRoutes = { items?: SchematicRouteItem[] };

// M6: route outcomes are derived from the in-memory catalog definition
// (flowDefinitions[*].schematic), threaded in by main(), not read back from the
// generated src/flows/<id>/schematic.json on disk. The committed JSON is a
// drift-checked snapshot of this same definition, so the derived facts are
// identical; reading the definition keeps schematic.json a pure snapshot.
function routeOutcomesFor(schematic: SchematicRoutes): {
  route_outcomes: string[];
  unsupported_route_outcomes: string[];
} {
  const outcomes = new Set<string>();
  const unsupported = new Set<string>();
  for (const item of schematic.items ?? []) {
    for (const outcome of Object.keys(item.routes ?? {})) {
      outcomes.add(outcome);
      if (!EXECUTABLE_SCHEMATIC_ROUTES.has(outcome)) unsupported.add(outcome);
    }
    for (const outcome of Object.keys(item.route_overrides ?? {})) {
      outcomes.add(outcome);
      if (!EXECUTABLE_SCHEMATIC_ROUTES.has(outcome)) unsupported.add(outcome);
    }
  }
  return {
    route_outcomes: [...outcomes].sort(),
    unsupported_route_outcomes: [...unsupported].sort(),
  };
}

function generatedStepsFor(id: string): NonNullable<FlowGeneratedFile['json']['steps']> {
  return readGeneratedFlowFiles(id).flatMap((file) => file.json.steps ?? []);
}

function flowBehaviorAxes(pkg: FlowRecord): Record<string, string> {
  const steps = generatedStepsFor(pkg.id);
  const axes: Record<string, string> = {};
  if (steps.some((step) => step.kind === 'checkpoint')) {
    axes.checkpoint =
      'Compiled checkpoints can pause, auto-resolve safe defaults, or resume from operator input.';
  }
  if (
    steps.some((step) => step.role === 'reviewer') ||
    readGeneratedFlowFiles(pkg.id).some((file) =>
      (file.json.stages ?? []).some((stage) => stage.canonical === 'review'),
    )
  ) {
    axes.review = 'Compiled review stages or reviewer relays are present.';
  }
  if (steps.some((step) => step.kind === 'verification')) {
    axes.verification = 'Compiled verification steps write command-result reports before close.';
  } else if (pkg.id === 'explore') {
    axes.verification =
      'Explore deep mode records seam proof through analysis and embedded critique rather than command verification.';
  }
  if (
    steps.some(
      (step) => step.kind !== undefined && ['relay', 'sub-run', 'fanout'].includes(step.kind),
    )
  ) {
    axes.worker_handoff =
      'Compiled worker handoffs write request, receipt, result, and report evidence where applicable.';
  }
  if (steps.length > 0) {
    axes.continuity =
      'Runs persist manifest, trace, result, and checkpoint resume data in the run folder.';
  }
  return axes;
}

function flowRecord(pkg: FlowPackage, schematic: SchematicRoutes): FlowRecord {
  const routeOutcomes = routeOutcomesFor(schematic);
  return {
    id: pkg.id,
    source: pkg.paths.schematic,
    ...(pkg.paths.command === undefined ? {} : { command_path: pkg.paths.command }),
    ...(pkg.paths.contract === undefined ? {} : { contract_path: pkg.paths.contract }),
    axis_support: axisSupportFor(pkg.id),
    stages: stagesFor(pkg.id),
    reports: reportsFor(pkg),
    writers: {
      compose: pkg.writers.compose.length,
      close: pkg.writers.close.length,
      verification: pkg.writers.verification.length,
      checkpoint: pkg.writers.checkpoint.length,
    },
    ...routeOutcomes,
  };
}

function commandEvidence(id: string, host: string): string[] {
  if (host === 'claude-code') return [`plugins/claude/commands/${id}.md`];
  if (host === 'codex-plugin') return [`plugins/codex/commands/${id}.md`];
  return [`src/commands/${id}.md`];
}

function commandCapability(id: string, host: string, present: boolean) {
  return {
    id: host === 'claude-code' ? `command:${id}` : `command:${host}:${id}`,
    kind: 'flow',
    title: `${host} command ${id}`,
    status: present ? 'implemented' : 'missing',
    summary: present
      ? `Command ${id} is present for ${host}.`
      : `Command ${id} is absent for ${host}.`,
    evidence: present ? commandEvidence(id, host) : [],
    readiness_refs: present ? [] : ['REL-004'],
  };
}

const PROOF_AXIS_BY_SCENARIO = new Map([
  [
    'proof:routed-build',
    {
      capability: 'flow:build',
      proof: 'Routed Build golden run.',
    },
  ],
  [
    'proof:explicit-build',
    {
      capability: 'flow:build',
      proof: 'Explicit Build checkpoint golden run.',
    },
  ],
  [
    'proof:review',
    {
      capability: 'utility:review',
      proof: 'Standalone Review golden run.',
    },
  ],
  [
    'proof:checkpoint-resume',
    {
      capability: 'feature:checkpoints',
      proof: 'Checkpoint/resume golden run.',
    },
  ],
  [
    'proof:fix',
    {
      capability: 'flow:fix',
      proof: 'Fix golden run with regression evidence.',
    },
  ],
  [
    'proof:explore-decision',
    {
      capability: 'flow:explore',
      proof: 'Golden decision or tournament run.',
    },
  ],
  [
    'proof:prototype',
    {
      capability: 'flow:prototype',
      proof: 'Prototype golden run with checkpoint disposition.',
    },
  ],
  [
    'proof:plan-execution',
    {
      capability: 'feature:plan-execution',
      proof: 'Plan-execution campaign-start proof.',
    },
  ],
  [
    'proof:handoff',
    {
      capability: ['utility:handoff', 'feature:continuity'],
      proof: 'Handoff/resume golden run.',
    },
  ],
  [
    'proof:customization',
    {
      capability: 'utility:create',
      proof: 'Create or custom-connector proof scenario.',
    },
  ],
]);

function verifiedProofAxesByCapability(proofs: ProofScenarios): Map<string, { proof: string }> {
  const byCapability = new Map<string, string[]>();
  for (const scenario of proofs.scenarios) {
    if (scenario.status !== 'verified_current') continue;
    const proofAxis = PROOF_AXIS_BY_SCENARIO.get(scenario.id);
    if (proofAxis === undefined) continue;
    const capabilities = Array.isArray(proofAxis.capability)
      ? proofAxis.capability
      : [proofAxis.capability];
    for (const capability of capabilities) {
      const proofsForCapability = byCapability.get(capability) ?? [];
      proofsForCapability.push(proofAxis.proof);
      byCapability.set(capability, proofsForCapability);
    }
  }
  return new Map(
    [...byCapability.entries()].map(([capability, proofsForCapability]) => [
      capability,
      { proof: proofsForCapability.join(' ') },
    ]),
  );
}

function capabilityFromFlow(
  record: FlowRecord,
  proofAxesByCapability: Map<string, { proof: string }>,
) {
  const isRuntimeOnly = record.id === 'runtime-proof';
  const proofAxes = proofAxesByCapability.get(`flow:${record.id}`) ?? {};
  const behaviorAxes = flowBehaviorAxes(record);
  const semanticOutputs = semanticOutputsFor(record);
  return {
    id: `flow:${record.id}`,
    kind: 'flow',
    title: `${record.id} flow`,
    status: 'implemented',
    summary: isRuntimeOnly
      ? 'Runtime proof flow is present as an internal test surface.'
      : `Flow ${record.id} is registered in the catalog.`,
    evidence: [record.source, `generated/flows/${record.id}/circuit.json`],
    axes: {
      modes: axisSelectionsFor(record.axis_support),
      stage_path: record.stages,
      outputs: semanticOutputs.length > 0 ? semanticOutputs : record.reports,
      ...behaviorAxes,
      ...proofAxes,
    },
  };
}

function modeCapabilities(record: FlowRecord) {
  return axisSelectionsFor(record.axis_support).map((mode) => ({
    id: `mode:${record.id}:${mode}`,
    kind: 'mode',
    title: `${record.id} ${mode}`,
    status: 'implemented',
    summary: `${record.id} supports the ${mode} axis selection.`,
    evidence: [`generated/flows/${record.id}`],
  }));
}

function routeCapabilities(record: FlowRecord) {
  return record.route_outcomes.map((outcome) => {
    const supported = !record.unsupported_route_outcomes.includes(outcome);
    return {
      id: `route-outcome:${record.id}:${outcome}`,
      kind: 'route_outcome',
      title: `${record.id} route ${outcome}`,
      status: supported ? 'implemented' : 'partial',
      summary: supported
        ? `${outcome} maps to an executable compiled route.`
        : `${outcome} is declared in the schematic but not executable in compiled routes.`,
      evidence: [record.source],
      readiness_refs: supported ? [] : ['REL-003'],
    };
  });
}

function connectorRecords(connectorSchemas: ConnectorSchemas): ConnectorRecord[] {
  const records: ConnectorRecord[] = connectorSchemas.EnabledConnector.options.map((name) => {
    const caps = connectorSchemas.BUILTIN_CONNECTOR_CAPABILITIES[name];
    return {
      id: name,
      status: 'implemented',
      filesystem: caps.filesystem,
      structured_output: caps.structured_output,
      protocol: 'builtin-json',
      summary: `${name} is a built-in connector.`,
      readiness_refs: [],
    };
  });
  records.push({
    id: 'custom',
    status: 'implemented',
    filesystem: 'read-only',
    structured_output: 'json',
    protocol: connectorSchemas.PromptTransport.options.join(', '),
    summary:
      'Custom connectors receive prompt and output file paths and return a JSON response through the output file.',
    readiness_refs: [],
  });
  return records;
}

function connectorCapabilities(records: ConnectorRecord[]) {
  return records.map((record) => ({
    id: `connector:${record.id}`,
    kind: 'connector',
    title: `${record.id} connector`,
    status: record.status,
    summary: record.summary,
    evidence: [
      'src/schemas/connector.ts',
      'src/runtime/executors/relay.ts',
      'src/shared/relay-selection.ts',
    ],
    readiness_refs: record.readiness_refs,
    axes: {
      worker_handoff:
        record.id === 'custom'
          ? 'Wrapper receives a prompt and returns structured output.'
          : record.protocol,
      ...(record.id === 'custom' ? { proof: 'Working custom connector example.' } : {}),
    },
  }));
}

function hostRecords(): HostRecord[] {
  return [
    {
      id: 'claude-code-command',
      status: fileIsPresent('plugins/claude/commands/run.md') ? 'partial' : 'missing',
      summary: 'Claude Code plugin command surface exists but remains model-mediated.',
      evidence: [
        'plugins/claude/.claude-plugin/plugin.json',
        'plugins/claude/commands/run.md',
        'plugins/claude/scripts/circuit.ts',
      ],
      readiness_refs: ['REL-014'],
    },
    {
      id: 'codex-plugin',
      status: fileIsPresent('plugins/codex/.codex-plugin/plugin.json') ? 'partial' : 'missing',
      summary: 'Codex plugin files exist and use the current model-mediated host surface.',
      evidence: ['plugins/codex/.codex-plugin/plugin.json', 'plugins/codex/scripts/circuit.ts'],
      readiness_refs: ['REL-014'],
    },
    {
      id: 'generic-shell',
      status: 'partial',
      summary:
        'Generic shell can consume JSONL/final JSON, but human text progress is still pending.',
      evidence: ['src/cli/circuit.ts'],
      readiness_refs: ['REL-019'],
    },
  ];
}

function hostCapabilities(records: HostRecord[]) {
  return records.map((record) => ({
    id: `host:${record.id}`,
    kind: 'host',
    title: `${record.id} host`,
    status: record.status,
    summary: record.summary,
    evidence: record.evidence,
    readiness_refs: record.readiness_refs,
  }));
}

function proofCompletionSummary(proofs: ProofScenarios): {
  captured_count: number;
  remaining_count: number;
  remaining_ids: string[];
} {
  const captured = proofs.scenarios.filter((scenario) => scenario.status === 'verified_current');
  const remaining = proofs.scenarios.filter((scenario) => scenario.status !== 'verified_current');
  return {
    captured_count: captured.length,
    remaining_count: remaining.length,
    remaining_ids: remaining.map((scenario) => scenario.id).sort(),
  };
}

function supportCapabilities(
  hostCommands: string[],
  proofAxesByCapability: Map<string, { proof: string }>,
  proofs: ProofScenarios,
) {
  const commandSet = new Set(hostCommands);
  const proofCompletion = proofCompletionSummary(proofs);
  const createProofAxes = proofAxesByCapability.get('utility:create');
  const createImplemented =
    existsSync(resolve(projectRoot, 'src/cli/create.ts')) &&
    existsSync(resolve(projectRoot, 'src/commands/create.md')) &&
    typeof createProofAxes?.proof === 'string';
  const handoffProofAxes = proofAxesByCapability.get('utility:handoff');
  const handoffImplemented =
    commandSet.has('handoff') && typeof handoffProofAxes?.proof === 'string';
  const continuityProofAxes = proofAxesByCapability.get('feature:continuity');
  const continuityImplemented =
    handoffImplemented && typeof continuityProofAxes?.proof === 'string';
  return [
    {
      id: 'utility:review',
      kind: 'utility',
      title: 'Review utility',
      status: commandSet.has('run') ? 'implemented' : 'missing',
      summary: 'Review is present as a routed flow through Run.',
      evidence: ['plugins/claude/commands/run.md', 'src/flows/review/schematic.json'],
      axes: {
        invocation: '/circuit:run review <scope>',
        outputs: ['review.md'],
        review:
          'Routed Review runs a fresh reviewer relay and writes a severity-ordered review result.',
        ...(proofAxesByCapability.get('utility:review') ?? {}),
      },
    },
    {
      id: 'utility:create',
      kind: 'customization',
      title: 'Create utility',
      status: createImplemented ? 'implemented' : 'missing',
      summary: createImplemented
        ? 'Create remains available as an experimental CLI utility for drafting, validating, and publishing user-global custom flow packages after explicit confirmation.'
        : 'Create CLI utility is not fully proven in the current source tree.',
      evidence: createImplemented
        ? ['src/commands/create.md', 'src/cli/create.ts', 'tests/runner/utility-cli.test.ts']
        : [],
      readiness_refs: createImplemented ? [] : ['REL-013'],
      axes: {
        invocation: './bin/circuit create --name <slug> --description <flow idea>',
        outputs: ['SKILL.md', 'circuit.yaml', 'publish summary'],
        checkpoint: 'Publishing requires an explicit --yes confirmation after draft validation.',
        verification: 'The generated compiled flow parses and passes flow-kind policy validation.',
        continuity: 'Published custom flows are written to the user-global custom flow root.',
        ...createProofAxes,
      },
    },
    {
      id: 'utility:handoff',
      kind: 'continuity',
      title: 'Handoff utility',
      status: handoffImplemented
        ? 'implemented'
        : commandSet.has('handoff')
          ? 'partial'
          : 'missing',
      summary: handoffImplemented
        ? 'Handoff saves, resumes, and clears explicit continuity records through the CLI.'
        : 'Handoff utility command is not fully proven in the current command surface.',
      evidence: handoffImplemented
        ? ['src/commands/handoff.md', 'src/cli/handoff.ts', 'tests/runner/utility-cli.test.ts']
        : [],
      readiness_refs: handoffImplemented ? [] : ['REL-014'],
      axes: {
        outputs: ['active-run.md', 'continuity record'],
        continuity:
          'Fresh sessions resume from an explicit continuity record or get a clear not-found result.',
        ...handoffProofAxes,
      },
    },
    {
      id: 'feature:checkpoints',
      kind: 'checkpoint',
      title: 'Checkpoints',
      status: 'implemented',
      summary: 'Checkpoint waiting and resume paths exist in runtime and the CLI.',
      evidence: [
        'src/runtime/executors/checkpoint.ts',
        'src/runtime/run/checkpoint-resume.ts',
        'src/cli/circuit.ts',
      ],
      axes: {
        checkpoint:
          'Compiled checkpoints can pause, auto-resolve safe defaults, or resume from operator input.',
        ...(proofAxesByCapability.get('feature:checkpoints') ?? {}),
      },
    },
    {
      id: 'feature:continuity',
      kind: 'continuity',
      title: 'Continuity',
      status: continuityImplemented ? 'implemented' : 'partial',
      summary: continuityImplemented
        ? 'Runtime run records, checkpoint resume, and explicit handoff continuity records are proven.'
        : 'Runtime run records and checkpoint resume exist; explicit handoff continuity proof is still pending.',
      evidence: [
        'src/runtime/run/checkpoint-resume.ts',
        'src/runtime/run/manifest-snapshot.ts',
        'src/cli/handoff.ts',
      ],
      readiness_refs: continuityImplemented ? [] : ['REL-014'],
      axes: {
        outputs: ['active-run.md', 'continuity record'],
        continuity: 'Resume is explicit and auditable through continuity record and index files.',
        ...continuityProofAxes,
      },
    },
    {
      id: 'safety:review-untracked-evidence',
      kind: 'safety',
      title: 'Review untracked evidence policy',
      status: 'implemented',
      summary:
        'Review sends untracked paths and sizes by default; file contents require explicit opt-in and still skip binary, unreadable, and oversized samples safely.',
      evidence: [
        'src/flows/review/writers/intake.ts',
        'tests/runner/review-runtime-wiring.test.ts',
        'tests/runner/cli-router.test.ts',
      ],
      readiness_refs: [],
    },
    {
      id: 'safety:accept-with-fixes',
      kind: 'safety',
      title: 'Accept with fixes semantics',
      status: 'implemented',
      summary:
        'Build reports needs_attention and Fix reports partial when review accepts with required follow-up fixes.',
      evidence: ['src/flows/build/writers/close.ts', 'src/flows/fix/writers/close.ts'],
      readiness_refs: [],
    },
    {
      id: 'safety:write-capable-worker',
      kind: 'safety',
      title: 'Write-capable worker disclosure',
      status: 'implemented',
      summary:
        'Write-capable worker behavior is disclosed in docs, progress, and final summaries for Build, Fix, Prototype, and Pursue.',
      evidence: [
        'README.md',
        'docs/first-run.md',
        'docs/contracts/host-capabilities.md',
        'src/runtime/run/graph-runner.ts',
        'src/shared/operator-summary-writer.ts',
        'src/shared/write-capable-worker-disclosure.ts',
      ],
      readiness_refs: [],
    },
    {
      id: 'matrix:flow-mode-parity',
      kind: 'docs',
      title: 'Flow and mode parity matrix',
      status: 'implemented',
      summary:
        'Generated matrix exists; approved behavioral exceptions are tracked in the exception ledger.',
      evidence: ['docs/release/parity-matrix.generated.md'],
      readiness_refs: [],
    },
    {
      id: 'route-outcomes:rich',
      kind: 'route_outcome',
      title: 'Rich route outcomes',
      status: 'implemented',
      summary:
        'Rich route outcomes are emitted into compiled routes and checkpoint selections can execute them.',
      evidence: ['src/flows/compile-schematic-to-flow.ts'],
      readiness_refs: [],
    },
    {
      id: 'proof:golden-runs',
      kind: 'proof',
      title: 'Golden release runs',
      status: proofCompletion.remaining_count === 0 ? 'implemented' : 'partial',
      summary:
        proofCompletion.remaining_count === 0
          ? 'All defined golden example runs are captured.'
          : `${proofCompletion.captured_count} golden example runs are captured; remaining blockers: ${proofCompletion.remaining_ids.join(', ')}.`,
      evidence: ['docs/release/proofs/index.yaml'],
      readiness_refs: proofCompletion.remaining_count === 0 ? [] : ['REL-011'],
    },
  ];
}

async function main(): Promise<void> {
  const [releaseSchemas, catalog, connectorSchemas] = await Promise.all([
    import(resolve(projectRoot, 'dist/release/schemas.js')) as Promise<typeof ReleaseSchemasModule>,
    import(resolve(projectRoot, 'dist/flows/catalog.js')) as Promise<typeof CatalogModule>,
    import(resolve(projectRoot, 'dist/schemas/connector.js')) as Promise<
      typeof ConnectorSchemasModule
    >,
  ]);
  const { CurrentCapabilitySnapshot, ProofScenarioIndex } = releaseSchemas;
  const { flowPackages, flowDefinitions } = catalog;
  // M6: derive route outcomes from the in-memory schematic, keyed by flow id, so
  // schematic.json on disk stays a pure drift-checked snapshot rather than a
  // source this script reads back.
  const schematicById = new Map(
    flowDefinitions.map((definition) => [definition.id, definition.schematic]),
  );

  const publicFlowPackages = flowPackages.filter((pkg) => pkg.visibility !== 'internal');
  const flows = publicFlowPackages.map((pkg) => {
    const schematic = schematicById.get(pkg.id);
    if (schematic === undefined) {
      throw new Error(`emit-current-capabilities: no in-memory schematic for flow '${pkg.id}'`);
    }
    return flowRecord(pkg, schematic as unknown as SchematicRoutes);
  });
  const proofs = loadYamlWithSchema('docs/release/proofs/index.yaml', ProofScenarioIndex);
  const proofAxesByCapability = verifiedProofAxesByCapability(proofs);
  const sourceCommands = listMarkdownBasenames('src/commands').filter((id) => id !== 'README');
  const claudeCommands = listMarkdownBasenames('plugins/claude/commands');
  const codexCommands = listMarkdownBasenames('plugins/codex/commands');
  const claudeSkills = existsSync(resolve(projectRoot, 'plugins/claude/skills'))
    ? readdirSync(resolve(projectRoot, 'plugins/claude/skills')).filter((entry) =>
        statSync(resolve(projectRoot, 'plugins/claude/skills', entry)).isDirectory(),
      )
    : [];
  const connectors = connectorRecords(connectorSchemas);
  const hosts = hostRecords();

  const capabilities = [
    ...flows.map((record) => capabilityFromFlow(record, proofAxesByCapability)),
    ...flows.flatMap(modeCapabilities),
    ...flows.flatMap(routeCapabilities),
    ...claudeCommands.map((id) => commandCapability(id, 'claude-code', true)),
    ...['handoff']
      .filter((id: string) => !claudeCommands.includes(id))
      .map((id: string) => commandCapability(id, 'claude-code', false)),
    ...connectorCapabilities(connectors),
    ...hostCapabilities(hosts),
    ...supportCapabilities(claudeCommands, proofAxesByCapability, proofs),
  ].sort((a, b) => a.id.localeCompare(b.id));

  const snapshot = CurrentCapabilitySnapshot.parse({
    schema_version: 1,
    generated_by: 'scripts/release/emit-current-capabilities.ts',
    flows,
    commands: {
      source: sourceCommands,
      claude_plugin: claudeCommands,
      codex_plugin: codexCommands,
      claude_plugin_skills: claudeSkills.sort(),
    },
    connectors,
    hosts,
    capabilities,
  });

  writeOrCheck(OUT_REL, formatWithBiome(OUT_REL, stableJson(snapshot)), check);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
