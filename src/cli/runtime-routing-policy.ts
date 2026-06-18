// CLI runtime routing policy.
//
// The CLI uses the runtime by default only when the requested inputs are trusted
// runtime surfaces: generated flows, generated mirrors, or published custom
// flows. External fixtures and programmatic composeWriter injection fail closed
// here so one-off test hooks cannot silently become production behavior.
import { readFileSync } from 'node:fs';
import { basename, dirname, relative, resolve } from 'node:path';

export const GENERATED_FLOW_MIRROR_ROOT_ENV = 'CIRCUIT_GENERATED_FLOW_MIRROR_ROOT';

const COMPOSE_WRITER_UNSUPPORTED_REASON =
  'programmatic composeWriter injections are not supported by the CLI runtime; use executor injection or generated reports';

export const COMPOSE_WRITER_RUNTIME_POLICY = {
  status: 'unsupported',
  runtimeCustomization: 'executor-injection-or-generated-reports',
  reason: COMPOSE_WRITER_UNSUPPORTED_REASON,
} as const;

export const RUNTIME_POLICY_REASONS = {
  externalFixtureOrRoot:
    'explicit --fixture/--flow-root inputs must point at generated flows, trusted generated mirrors, or published custom flows',
  composeWriter: COMPOSE_WRITER_UNSUPPORTED_REASON,
  checkpointResume: 'checkpoint resume follows the saved run folder engine marker',
} as const;

export const CUSTOM_FLOW_ROOT_RUNTIME_POLICY =
  'Custom roots created by `circuit create` publish a normal runnable flow command.';

export const CLI_RUNTIME_ROUTING_POLICY =
  'Runtime routing: supported flow modes use the runtime by default. Unsupported modes, untrusted fixtures, and programmatic composeWriter injection fail closed. Runtime diagnostics: CIRCUIT_SHOW_RUNTIME_DECISION=1 includes runtime_reason for the selector decision.';

export type RuntimeSelectionKind = 'supported' | 'unsupported';

export interface RuntimeSupportDecision {
  readonly kind: RuntimeSelectionKind;
  readonly flowId: string;
  readonly entryModeName: string;
  readonly depth: string;
  readonly reason: string;
}

interface FixturePolicyArgs {
  readonly fixturePath?: string;
  readonly flowRoot?: string;
}

function pathIsInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel.length === 0 || (!rel.startsWith('..') && !rel.startsWith('/'));
}

export function fixtureEligibleForRuntime(input: {
  readonly args: FixturePolicyArgs;
  readonly fixturePath: string;
  readonly generatedFlowsRoot?: string;
  readonly generatedFlowMirrorRoot?: string;
}): boolean {
  if (input.args.fixturePath === undefined && input.args.flowRoot === undefined) return true;
  const fixturePath = resolve(input.fixturePath);
  if (pathIsInside(resolve(input.generatedFlowsRoot ?? 'generated/flows'), fixturePath)) {
    return true;
  }
  if (
    input.args.flowRoot !== undefined &&
    publishedCustomFlowMatches(input.args.flowRoot, fixturePath)
  ) {
    return true;
  }
  const mirrorRoot = input.generatedFlowMirrorRoot ?? process.env[GENERATED_FLOW_MIRROR_ROOT_ENV];
  if (mirrorRoot === undefined || mirrorRoot.length === 0 || input.args.flowRoot === undefined) {
    return false;
  }
  const trustedMirrorRoot = resolve(mirrorRoot);
  return (
    resolve(input.args.flowRoot) === trustedMirrorRoot &&
    pathIsInside(trustedMirrorRoot, fixturePath)
  );
}

// Read the published custom-flow entries from the manifest beside a flow root.
// Loose by design: a malformed or missing manifest yields no entries, so the
// gate fails closed rather than throwing.
function readCustomFlowEntries(flowRoot: string): Array<Record<string, unknown>> {
  try {
    const manifest = JSON.parse(
      readFileSync(resolve(dirname(resolve(flowRoot)), 'manifest.json'), 'utf8'),
    );
    if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return [];
    const customFlows = (manifest as { custom_flows?: unknown }).custom_flows;
    if (!Array.isArray(customFlows)) return [];
    return customFlows.filter(
      (candidate): candidate is Record<string, unknown> =>
        candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate),
    );
  } catch {
    return [];
  }
}

// Every compiled-flow file a manifest entry blesses: its default-mode flow_path
// plus any per-mode siblings recorded under flow_paths. Resolved for comparison.
function recordedFlowPaths(candidate: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const flowPath = candidate.flow_path;
  if (typeof flowPath === 'string') paths.push(resolve(flowPath));
  const flowPaths = candidate.flow_paths;
  if (Array.isArray(flowPaths)) {
    for (const entry of flowPaths) {
      if (typeof entry === 'string') paths.push(resolve(entry));
    }
  }
  return paths;
}

// A published custom flow blesses its default circuit.json (flow_path) and every
// per-mode sibling it recorded (flow_paths). The loader serves a <mode>.json
// sibling by disk presence; this trusts the ones the publish actually wrote.
function publishedCustomFlowMatches(flowRoot: string, fixturePath: string): boolean {
  return readCustomFlowEntries(flowRoot).some((candidate) =>
    recordedFlowPaths(candidate).includes(fixturePath),
  );
}

// Fail-closed fallback message. When a rejected fixture is a per-mode sibling
// that lives inside a published flow's own directory but is NOT one of the paths
// that flow recorded (a stale or tampered <mode>.json), return a clear,
// actionable reason instead of the generic one. The file still never runs — this
// only improves the message. Returns undefined for anything else, so the caller
// falls back to the generic reason (e.g. a truly external fixture).
export function unrecordedPublishedSiblingReason(input: {
  readonly args: FixturePolicyArgs;
  readonly fixturePath: string;
}): string | undefined {
  const flowRoot = input.args.flowRoot;
  if (flowRoot === undefined) return undefined;
  const fixturePath = resolve(input.fixturePath);
  const fixtureDir = dirname(fixturePath);
  for (const candidate of readCustomFlowEntries(flowRoot)) {
    const recorded = recordedFlowPaths(candidate);
    if (recorded.length === 0) continue;
    // recorded[0] is the resolved flow_path; its directory is the flow's package
    // dir (<flowRoot>/<slug>). A fixture in that dir belongs to this flow.
    if (dirname(recorded[0] as string) !== fixtureDir) continue;
    if (recorded.includes(fixturePath)) continue; // recorded → would be eligible
    const id = typeof candidate.id === 'string' ? candidate.id : basename(fixtureDir);
    const mode = basename(fixturePath).replace(/\.json$/, '');
    return `mode '${mode}' is not published for flow '${id}'. Only the published modes are available; re-publish the flow to enable other modes.`;
  }
  return undefined;
}

export function applyFixturePolicy(
  decision: RuntimeSupportDecision,
  input: {
    readonly args: FixturePolicyArgs;
    readonly fixturePath: string;
  },
): RuntimeSupportDecision {
  if (decision.kind !== 'supported') return decision;
  if (fixtureEligibleForRuntime(input)) return decision;
  return {
    ...decision,
    kind: 'unsupported',
    reason: unrecordedPublishedSiblingReason(input) ?? RUNTIME_POLICY_REASONS.externalFixtureOrRoot,
  };
}

export function applyComposeWriterPolicy(
  decision: RuntimeSupportDecision,
  input: { readonly hasComposeWriter: boolean },
): RuntimeSupportDecision {
  if (decision.kind !== 'supported' || !input.hasComposeWriter) return decision;
  return {
    ...decision,
    kind: 'unsupported',
    reason: RUNTIME_POLICY_REASONS.composeWriter,
  };
}

export function showRuntimeDecision(): boolean {
  return process.env.CIRCUIT_SHOW_RUNTIME_DECISION === '1';
}

export function runtimeOutputFields(input: {
  readonly include: boolean;
  readonly decision: RuntimeSupportDecision;
}): { readonly runtime_reason?: string } {
  if (!input.include) return {};
  return {
    runtime_reason: input.decision.reason,
  };
}
