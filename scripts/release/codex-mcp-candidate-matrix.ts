import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import { validateCodexInvocationEvidence } from './codex-invocation-evidence.ts';

type ExpectedCandidate = {
  readonly proofRoot: string;
  readonly repository: string;
  readonly candidateRef: string;
  readonly pluginVersion: string;
  readonly pluginTreeSha256: string;
  readonly codexVersion: string;
  readonly validateTraceEntry: (value: unknown) => boolean;
  /** Strict family-result validation injected from built output by the release checker. */
  readonly validateFlowResult: (schema: string, value: unknown) => boolean;
};

const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_JSON_BYTES = 256 * 1024;
const MAX_TRACE_BYTES = 4 * 1024 * 1024;
const REQUIRED_RUNS = new Map<string, string>([
  ['review', 'review'],
  ['fix', 'fix'],
  ['build', 'build'],
  ['explore', 'explore'],
  ['explore-tournament', 'explore'],
  ['prototype', 'prototype'],
  ['prototype-tournament', 'prototype'],
  ['cached-search-explore', 'explore'],
]);
const REQUIRED_LOADER_EVIDENCE = [
  'real_plugin_loader_completed',
  'tool_search_discovered_six_tools',
  'circuit_list_invoked',
  'trusted_workspace_metadata',
  'exact_workspace_identity',
  'product_created_private_control_state',
  'owned_process_cleanup',
  'source_ref_exact',
] as const;
const KNOWN_EVENTS = new Set([
  'thread.started',
  'turn.started',
  'item.started',
  'item.updated',
  'item.completed',
  'turn.completed',
]);
const SAFE_ITEMS = new Set([
  'agent_message',
  'reasoning',
  'todo_list',
  'tool_search',
  'tool_search_call',
]);
const MATRIX_RUN_RESULT = z
  .object({
    schema_version: z.literal(1),
    run_id: z.guid(),
    flow_id: z.string().regex(/^[a-z][a-z0-9-]*$/u),
    goal: z.string().min(1),
    why: z.string().min(1).optional(),
    outcome: z.enum(['complete', 'aborted', 'evidence_invalid', 'handoff', 'stopped', 'escalated']),
    summary: z.string().min(1),
    closed_at: z.iso.datetime(),
    trace_entries_observed: z.number().int().nonnegative(),
    manifest_hash: z.string().min(1),
    reason: z.string().min(1).optional(),
    verdict: z.string().min(1).optional(),
  })
  .strict();

const FLOW_RESULT_SCHEMA = new Map<string, string>([
  ['review', 'review.result@v1'],
  ['fix', 'fix.result@v1'],
  ['build', 'build.result@v1'],
  ['explore', 'explore.result@v1'],
  ['explore-tournament', 'explore.result@v1'],
  ['prototype', 'prototype.result@v1'],
  ['prototype-tournament', 'prototype.result@v1'],
  ['cached-search-explore', 'explore.result@v1'],
]);

const FLOW_RESULT_REPORT_IDS = new Map<string, readonly string[]>([
  [
    'fix',
    [
      'fix.brief',
      'fix.context',
      'fix.diagnosis',
      'fix.regression-proof',
      'fix.baseline-snapshot',
      'fix.change',
      'fix.verification',
      'fix.regression-rerun',
      'fix.change-set',
      'fix.review',
    ],
  ],
  [
    'build',
    ['build.brief', 'build.plan', 'build.implementation', 'build.verification', 'build.review'],
  ],
  ['explore', ['explore.brief', 'explore.analysis', 'explore.compose', 'explore.review-verdict']],
  [
    'cached-search-explore',
    ['explore.brief', 'explore.analysis', 'explore.compose', 'explore.review-verdict'],
  ],
  [
    'explore-tournament',
    [
      'explore.brief',
      'explore.analysis',
      'explore.decision-options',
      'explore.tournament-aggregate',
      'explore.tournament-review',
      'explore.decision',
    ],
  ],
]);

const SANDBOX_CANARY_CHECKS = [
  'AUTH_READ_DENIED',
  'ENV_CLEAN',
  'GIT_EXEC',
  'NETWORK_DENIED',
  'NODE_EXEC',
  'PRIVATE_WRITE',
  'SIBLING_READ_DENIED',
  'SYMLINK_READ_DENIED',
  'WORKSPACE_WRITE',
  'SHARED_TEMP_DIAGNOSTIC_RECORDED',
  'TOOL_SURFACE_OFF',
  'TOOL_SURFACE_CACHED',
] as const;

const PROOF_NETWORK_CANARY_CHECKS = [
  'SOCKET_DENIED',
  'DNS_DENIED',
  'CURL_DENIED',
  'URLSESSION_DENIED',
  'BACKGROUND_URLSESSION_XPC_DENIED',
  'NO_LOOPBACK_CONNECTIONS',
  'CLEANUP_CONFIRMED',
] as const;

const CONSENT_ERROR =
  'cached web search requires explicit consent because the query leaves the machine';

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function reference(value: unknown): { readonly path: string; readonly sha256: string } | undefined {
  const ref = record(value);
  return typeof ref?.path === 'string' && typeof ref.sha256 === 'string'
    ? { path: ref.path, sha256: ref.sha256 }
    : undefined;
}

function readArtifact(input: {
  readonly root: string;
  readonly value: unknown;
  readonly label: string;
  readonly maxBytes: number;
  readonly issues: string[];
}): Buffer | undefined {
  const ref = reference(input.value);
  if (ref === undefined || !SHA256.test(ref.sha256)) {
    input.issues.push(`${input.label} reference must contain a safe path and SHA-256 digest`);
    return undefined;
  }
  const parts = ref.path.split('/');
  if (
    isAbsolute(ref.path) ||
    ref.path.includes('\\') ||
    ref.path.includes('\0') ||
    parts.some((part) => part.length === 0 || part === '.' || part === '..')
  ) {
    input.issues.push(`${input.label} path must stay inside the candidate proof folder`);
    return undefined;
  }
  let cursor = input.root;
  try {
    for (const part of parts.slice(0, -1)) {
      cursor = join(cursor, part);
      const info = lstatSync(cursor);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        input.issues.push(`${input.label} path crosses a link or non-directory`);
        return undefined;
      }
    }
    const path = join(cursor, parts.at(-1) as string);
    const info = lstatSync(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.size === 0 ||
      info.size > input.maxBytes
    ) {
      input.issues.push(`${input.label} must be one bounded ordinary file`);
      return undefined;
    }
    const bytes = readFileSync(path);
    if (createHash('sha256').update(bytes).digest('hex') !== ref.sha256) {
      input.issues.push(`${input.label} digest does not match its artifact`);
      return undefined;
    }
    return bytes;
  } catch {
    input.issues.push(`${input.label} artifact is missing or unreadable`);
    return undefined;
  }
}

function json(bytes: Buffer | undefined, label: string, issues: string[]): unknown | undefined {
  if (bytes === undefined) return undefined;
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    issues.push(`${label} artifact is not valid JSON`);
    return undefined;
  }
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  issues: string[],
): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    issues.push(`${label} contains an unknown field`);
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function safeWorkspacePath(value: unknown): value is string {
  if (!nonEmptyString(value) || isAbsolute(value) || value.includes('\\') || value.includes('\0')) {
    return false;
  }
  return value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function readJsonArtifact(input: {
  readonly root: string;
  readonly value: unknown;
  readonly label: string;
  readonly issues: string[];
}): unknown | undefined {
  return json(
    readArtifact({
      root: input.root,
      value: input.value,
      label: input.label,
      maxBytes: MAX_JSON_BYTES,
      issues: input.issues,
    }),
    input.label,
    input.issues,
  );
}

function evidenceReportIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids: string[] = [];
  for (const item of value) {
    const pointer = record(item);
    if (
      pointer === undefined ||
      !nonEmptyString(pointer.report_id) ||
      !nonEmptyString(pointer.path) ||
      !nonEmptyString(pointer.schema)
    ) {
      return undefined;
    }
    ids.push(pointer.report_id);
  }
  return ids;
}

function exactReportIds(value: unknown, expected: readonly string[]): boolean {
  const ids = evidenceReportIds(value);
  if (ids === undefined || ids.length !== expected.length || new Set(ids).size !== ids.length) {
    return false;
  }
  const actual = new Set(ids);
  return expected.every((id) => actual.has(id));
}

function successfulCommands(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((item) => {
    const command = record(item);
    return command?.status === 'passed' && command.exit_code === 0;
  });
}

function supportingReport(
  lane: Record<string, unknown>,
  name: string,
  id: string,
  expected: ExpectedCandidate,
  issues: string[],
): Record<string, unknown> | undefined {
  const supporting = record(lane.supporting_reports);
  const value = readJsonArtifact({
    root: expected.proofRoot,
    value: supporting?.[name],
    label: `${id} ${name.replaceAll('_', ' ')} report`,
    issues,
  });
  const parsed = record(value);
  if (parsed === undefined) {
    issues.push(`${id} ${name.replaceAll('_', ' ')} report is malformed`);
  }
  return parsed;
}

function validatePrototypeArtifacts(
  lane: Record<string, unknown>,
  requiredPaths: readonly string[],
  id: string,
  expected: ExpectedCandidate,
  issues: string[],
): void {
  const files = Array.isArray(lane.artifact_files) ? lane.artifact_files.map(record) : [];
  const seen = new Set<string>();
  for (const [index, item] of files.entries()) {
    const label = `${id} artifact file ${index + 1}`;
    if (item === undefined || !safeWorkspacePath(item.workspace_path)) {
      issues.push(`${label} has an unsafe workspace path`);
      continue;
    }
    exactKeys(item, ['workspace_path', 'artifact'], label, issues);
    if (seen.has(item.workspace_path)) {
      issues.push(`${id} artifact files contain a duplicate workspace path`);
      continue;
    }
    seen.add(item.workspace_path);
    readArtifact({
      root: expected.proofRoot,
      value: item.artifact,
      label,
      maxBytes: MAX_TRACE_BYTES,
      issues,
    });
  }
  if (
    requiredPaths.length === 0 ||
    requiredPaths.some((path) => !safeWorkspacePath(path) || !seen.has(path))
  ) {
    issues.push(`${id} did not copy and hash every verified prototype entry point`);
  }
}

function officialCodexReleaseSource(value: unknown): boolean {
  if (!nonEmptyString(value)) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      url.pathname.startsWith('/openai/codex/releases')
    );
  } catch {
    return false;
  }
}

function argumentsOf(item: Record<string, unknown>): Record<string, unknown> | undefined {
  if (typeof item.arguments === 'string') {
    try {
      return record(JSON.parse(item.arguments) as unknown);
    } catch {
      return undefined;
    }
  }
  return record(item.arguments);
}

function responseOf(item: Record<string, unknown>): Record<string, unknown> | undefined {
  return record(record(item.result)?.structured_content);
}

function cursor(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function validateSuccessfulMcpCall(
  tool: unknown,
  args: Record<string, unknown> | undefined,
  response: Record<string, unknown> | undefined,
  label: string,
  issues: string[],
): void {
  if (args === undefined || response === undefined) {
    issues.push(`${label} does not match the public MCP input and response contracts`);
    return;
  }
  let valid = response.schema_version === 1 && response.ok === true;
  switch (tool) {
    case 'circuit_start':
      exactKeys(
        args,
        [
          'flow',
          'goal',
          'why',
          'power',
          'process',
          'tournament',
          'autonomous',
          'include_untracked_content',
          'variants',
          'consent',
          'web_search',
        ],
        `${label} input`,
        issues,
      );
      exactKeys(
        response,
        ['schema_version', 'ok', 'run_id', 'state', 'next_cursor', 'summary'],
        `${label} response`,
        issues,
      );
      valid =
        valid &&
        nonEmptyString(args.goal) &&
        ['review', 'fix', 'build', 'explore', 'prototype'].includes(String(args.flow)) &&
        nonEmptyString(response.run_id) &&
        (response.state === 'starting' || response.state === 'running') &&
        cursor(response.next_cursor) &&
        nonEmptyString(response.summary);
      break;
    case 'circuit_status': {
      exactKeys(
        args,
        ['run_id', 'after_cursor', 'max_events', 'wait_ms'],
        `${label} input`,
        issues,
      );
      exactKeys(
        response,
        [
          'schema_version',
          'ok',
          'run_id',
          'state',
          'events',
          'next_cursor',
          'truncated',
          'checkpoint',
          'final_report',
          'summary',
        ],
        `${label} response`,
        issues,
      );
      valid =
        valid &&
        nonEmptyString(args.run_id) &&
        nonEmptyString(response.run_id) &&
        nonEmptyString(response.state) &&
        Array.isArray(response.events) &&
        response.events.length <= 100 &&
        cursor(response.next_cursor) &&
        typeof response.truncated === 'boolean' &&
        nonEmptyString(response.summary);
      if (response.state === 'waiting_for_input') {
        const checkpoint = record(response.checkpoint);
        const choices = Array.isArray(checkpoint?.choices) ? checkpoint.choices.map(record) : [];
        valid =
          valid &&
          checkpoint !== undefined &&
          nonEmptyString(checkpoint.token) &&
          checkpoint.token.length >= 16 &&
          nonEmptyString(checkpoint.prompt) &&
          choices.length > 0 &&
          choices.every((choice) => nonEmptyString(choice?.id) && nonEmptyString(choice.label));
      }
      if (response.state === 'complete') {
        const finalReport = record(response.final_report);
        valid =
          valid &&
          finalReport !== undefined &&
          nonEmptyString(finalReport.schema) &&
          nonEmptyString(finalReport.summary) &&
          finalReport.data !== undefined;
      }
      break;
    }
    case 'circuit_resume':
      exactKeys(args, ['run_id', 'checkpoint_token', 'choice_id'], `${label} input`, issues);
      exactKeys(
        response,
        ['schema_version', 'ok', 'run_id', 'state', 'next_cursor', 'summary'],
        `${label} response`,
        issues,
      );
      valid =
        valid &&
        nonEmptyString(args.run_id) &&
        nonEmptyString(args.checkpoint_token) &&
        args.checkpoint_token.length >= 16 &&
        nonEmptyString(args.choice_id) &&
        nonEmptyString(response.run_id) &&
        (response.state === 'resuming' || response.state === 'running') &&
        cursor(response.next_cursor) &&
        nonEmptyString(response.summary);
      break;
    case 'circuit_list': {
      exactKeys(args, ['limit'], `${label} input`, issues);
      exactKeys(
        response,
        ['schema_version', 'ok', 'runs', 'truncated', 'summary'],
        `${label} response`,
        issues,
      );
      const runs = Array.isArray(response.runs) ? response.runs.map(record) : [];
      valid =
        valid &&
        Array.isArray(response.runs) &&
        runs.length <= 50 &&
        typeof response.truncated === 'boolean' &&
        nonEmptyString(response.summary) &&
        runs.every(
          (run) =>
            nonEmptyString(run?.run_id) &&
            nonEmptyString(run.flow) &&
            nonEmptyString(run.state) &&
            nonEmptyString(run.updated_at) &&
            typeof run.checkpoint_available === 'boolean' &&
            nonEmptyString(run.summary),
        );
      break;
    }
    default:
      valid = false;
  }
  if (!valid) issues.push(`${label} does not match the public MCP input and response contracts`);
}

function parseHostEvents(
  bytes: Buffer,
  label: string,
  issues: string[],
): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (const [index, line] of bytes.toString('utf8').split(/\r?\n/u).filter(Boolean).entries()) {
    let event: Record<string, unknown> | undefined;
    try {
      event = record(JSON.parse(line) as unknown);
    } catch {
      // Never echo a captured line: it can contain source text.
    }
    if (event === undefined || typeof event.type !== 'string') {
      issues.push(`${label} line ${index + 1} is malformed`);
      continue;
    }
    if (!KNOWN_EVENTS.has(event.type)) issues.push(`${label} contains an unknown event type`);
    events.push(event);
  }
  if (events[0]?.type !== 'thread.started' || events[1]?.type !== 'turn.started') {
    issues.push(`${label} is missing its opening thread and turn events`);
  }
  if (events.at(-1)?.type !== 'turn.completed') {
    issues.push(`${label} is missing its terminal turn.completed event`);
  }
  return events;
}

function validateExploreSupportingReports(
  lane: Record<string, unknown>,
  id: string,
  expected: ExpectedCandidate,
  issues: string[],
): void {
  const compose = supportingReport(lane, 'compose', id, expected, issues);
  const analysis = supportingReport(lane, 'analysis', id, expected, issues);
  const aspects = Array.isArray(compose?.supporting_aspects)
    ? compose.supporting_aspects.map(record)
    : [];
  if (
    compose?.verdict !== 'accept' ||
    !nonEmptyString(compose.recommendation) ||
    aspects.length === 0 ||
    aspects.some(
      (aspect) =>
        !nonEmptyString(aspect?.aspect) ||
        !nonEmptyString(aspect.contribution) ||
        !Array.isArray(aspect.evidence_refs) ||
        aspect.evidence_refs.length === 0 ||
        aspect.evidence_refs.some((ref) => !nonEmptyString(ref)),
    )
  ) {
    issues.push(`${id} did not preserve a cited final recommendation`);
  }
  const analysisAspects = Array.isArray(analysis?.aspects) ? analysis.aspects.map(record) : [];
  const citations = analysisAspects.flatMap((aspect) =>
    Array.isArray(aspect?.evidence) ? aspect.evidence.map(record) : [],
  );
  if (
    analysisAspects.length === 0 ||
    citations.length === 0 ||
    citations.some(
      (citation) =>
        citation === undefined ||
        !nonEmptyString(citation.source) ||
        !nonEmptyString(citation.summary),
    )
  ) {
    issues.push(`${id} Explore analysis does not contain usable citations`);
  }
  if (id === 'cached-search-explore') {
    if (
      !nonEmptyString(compose?.recommendation) ||
      !compose.recommendation.includes(expected.codexVersion) ||
      !citations.some((citation) => officialCodexReleaseSource(citation?.source))
    ) {
      issues.push(
        'cached-search-explore did not cite the official release and name the proven Codex version',
      );
    }
  }
}

function validateFlowSpecificResult(input: {
  readonly lane: Record<string, unknown>;
  readonly id: string;
  readonly expectedFlow: string;
  readonly resumedChoice: string | undefined;
  readonly expected: ExpectedCandidate;
  readonly issues: string[];
}): void {
  const { lane, id, resumedChoice, expected, issues } = input;
  const expectedSupportingReports =
    id === 'explore' || id === 'cached-search-explore'
      ? ['analysis', 'compose']
      : id === 'explore-tournament'
        ? ['decision']
        : id === 'prototype'
          ? ['verification']
          : id === 'prototype-tournament'
            ? ['variant_verification']
            : [];
  const supporting = record(lane.supporting_reports);
  if (expectedSupportingReports.length > 0) {
    if (supporting === undefined) {
      issues.push(`${id} is missing required supporting reports`);
    } else {
      exactKeys(supporting, expectedSupportingReports, `${id} supporting reports`, issues);
    }
  } else if (supporting !== undefined) {
    issues.push(`${id} contains unexpected supporting reports`);
  }
  if (!id.startsWith('prototype') && lane.artifact_files !== undefined) {
    issues.push(`${id} contains unexpected prototype artifacts`);
  }
  const expectedSchema = FLOW_RESULT_SCHEMA.get(id);
  if (expectedSchema === undefined || lane.flow_result_schema !== expectedSchema) {
    issues.push(`${id} is missing flow-specific result evidence`);
    return;
  }
  const value = readJsonArtifact({
    root: expected.proofRoot,
    value: lane.flow_result,
    label: `${id} flow result`,
    issues,
  });
  const result = record(value);
  if (result === undefined) {
    issues.push(`${id} flow result is malformed`);
    return;
  }
  if (!expected.validateFlowResult(expectedSchema, value)) {
    issues.push(`${id} flow result does not match the ${expectedSchema} contract`);
    return;
  }

  switch (id) {
    case 'review': {
      const findings = Array.isArray(result.findings) ? result.findings.map(record) : [];
      if (
        result.verdict !== 'CLEAN' ||
        result.outcome !== 'complete' ||
        !nonEmptyString(result.assessment) ||
        !Array.isArray(result.verification) ||
        result.verification.length === 0 ||
        result.verification.some((step) => !nonEmptyString(step)) ||
        findings.some((finding) => finding?.severity !== 'low')
      ) {
        issues.push('review flow result does not prove a clean reviewed change');
      }
      break;
    }
    case 'fix':
      if (
        result.outcome !== 'fixed' ||
        result.verification_status !== 'passed' ||
        result.regression_status !== 'proved' ||
        result.regression_rerun_status !== 'cleared' ||
        result.change_set_status !== 'pass' ||
        result.review_status !== 'completed' ||
        result.review_verdict !== 'accept' ||
        !exactReportIds(result.evidence_links, FLOW_RESULT_REPORT_IDS.get(id) ?? [])
      ) {
        issues.push('fix flow result does not prove the seeded failure was fixed and reviewed');
      }
      break;
    case 'build': {
      const scope = record(result.scope);
      const touchArea = record(result.touch_area);
      if (
        result.outcome !== 'complete' ||
        result.verification_status !== 'passed' ||
        result.review_verdict !== 'accept' ||
        scope?.adherence !== 'within_scope' ||
        !Array.isArray(scope.violated_guardrails) ||
        scope.violated_guardrails.length !== 0 ||
        !Array.isArray(scope.unassessed_guardrails) ||
        scope.unassessed_guardrails.length !== 0 ||
        touchArea?.containment !== 'within' ||
        !Array.isArray(touchArea.out_of_bounds_paths) ||
        touchArea.out_of_bounds_paths.length !== 0 ||
        !exactReportIds(result.evidence_links, FLOW_RESULT_REPORT_IDS.get(id) ?? [])
      ) {
        issues.push('build flow result does not prove a verified, accepted, in-scope build');
      }
      break;
    }
    case 'explore':
    case 'cached-search-explore': {
      const snapshot = record(result.verdict_snapshot);
      if (
        snapshot?.compose_verdict !== 'accept' ||
        (snapshot.review_verdict !== 'accept' &&
          snapshot.review_verdict !== 'accept-with-fold-ins') ||
        !exactReportIds(result.evidence_links, FLOW_RESULT_REPORT_IDS.get(id) ?? [])
      ) {
        issues.push(`${id} flow result does not prove an accepted Explore recommendation`);
      }
      validateExploreSupportingReports(lane, id, expected, issues);
      break;
    }
    case 'explore-tournament': {
      const snapshot = record(result.verdict_snapshot);
      const decision = supportingReport(lane, 'decision', id, expected, issues);
      if (
        snapshot?.decision_verdict !== 'decided' ||
        !nonEmptyString(snapshot.selected_option_id) ||
        snapshot.selected_option_id !== resumedChoice ||
        decision?.verdict !== 'decided' ||
        decision.selected_option_id !== resumedChoice ||
        !nonEmptyString(decision.decision) ||
        !nonEmptyString(decision.rationale) ||
        !Array.isArray(decision.evidence_links) ||
        decision.evidence_links.length === 0 ||
        !exactReportIds(result.evidence_links, FLOW_RESULT_REPORT_IDS.get(id) ?? [])
      ) {
        issues.push('explore-tournament result does not match the selected checkpoint option');
      }
      break;
    }
    case 'prototype': {
      const verification = supportingReport(lane, 'verification', id, expected, issues);
      const entryPoints = Array.isArray(result.entry_points)
        ? result.entry_points.filter((entry): entry is string => typeof entry === 'string')
        : [];
      if (
        result.mode !== 'single-artifact' ||
        (result.outcome !== 'kept' && result.outcome !== 'build_input_saved') ||
        result.artifact_status !== 'accepted' ||
        result.verification_status !== 'passed' ||
        result.checkpoint_status !== 'operator_selected' ||
        result.checkpoint_selection !== resumedChoice ||
        (evidenceReportIds(result.evidence_links)?.length ?? 0) < 3 ||
        verification?.overall_status !== 'passed' ||
        !successfulCommands(verification.commands) ||
        entryPoints.length === 0
      ) {
        issues.push('prototype result does not prove a verified, operator-selected artifact');
      }
      validatePrototypeArtifacts(lane, entryPoints, id, expected, issues);
      break;
    }
    case 'prototype-tournament': {
      const verification = supportingReport(lane, 'variant_verification', id, expected, issues);
      const variantRows = Array.isArray(verification?.variant_results)
        ? verification.variant_results.map(record)
        : [];
      const passedRows = variantRows.filter((row) => row?.status === 'passed');
      const entryPoints = passedRows.flatMap((row) =>
        Array.isArray(row?.entry_points)
          ? row.entry_points.filter((entry): entry is string => typeof entry === 'string')
          : [],
      );
      if (
        result.mode !== 'model-comparison' ||
        result.outcome !== 'kept' ||
        result.artifact_status !== 'accepted' ||
        result.verification_status !== 'passed' ||
        result.checkpoint_status !== 'operator_selected' ||
        result.checkpoint_selection !== resumedChoice ||
        result.selected_variant_id !== resumedChoice ||
        (evidenceReportIds(result.evidence_links)?.length ?? 0) < 3 ||
        result.variant_count !== 2 ||
        typeof result.admitted_variant_count !== 'number' ||
        result.admitted_variant_count < 2 ||
        typeof result.captured_provider_evidence_count !== 'number' ||
        result.captured_provider_evidence_count < 2 ||
        result.model_evidence_status !== 'captured' ||
        !nonEmptyString(result.selected_variant_label) ||
        !nonEmptyString(result.selected_variant_root) ||
        !nonEmptyString(result.comparison_summary) ||
        verification?.overall_status !== 'passed' ||
        verification.required_captured_provider_evidence_count !== 2 ||
        typeof verification.admitted_variant_count !== 'number' ||
        verification.admitted_variant_count < 2 ||
        typeof verification.captured_provider_evidence_count !== 'number' ||
        verification.captured_provider_evidence_count < 2 ||
        passedRows.length < 2 ||
        !successfulCommands(verification.commands)
      ) {
        issues.push(
          'prototype-tournament result does not prove two verified variants and the selected winner',
        );
      }
      validatePrototypeArtifacts(lane, entryPoints, id, expected, issues);
      break;
    }
    default:
      issues.push(`${id} has no flow-specific result validator`);
  }
}

function validateRun(
  lane: Record<string, unknown>,
  expectedFlow: string,
  expected: ExpectedCandidate,
  hosts: ReadonlyMap<string, { readonly codexVersion: string; readonly macosVersion: string }>,
  issues: string[],
): void {
  const id = typeof lane.id === 'string' ? lane.id : '<unknown>';
  exactKeys(
    lane,
    [
      'id',
      'flow',
      'run_id',
      'architecture',
      'workspace_sha256',
      'run_result',
      'flow_result_schema',
      'flow_result',
      'supporting_reports',
      'artifact_files',
      'host_traces',
      'invocations',
      'circuit_trace',
    ],
    `${id} lane`,
    issues,
  );
  const runId = typeof lane.run_id === 'string' ? lane.run_id : undefined;
  const architecture =
    lane.architecture === 'arm64' || lane.architecture === 'x64' ? lane.architecture : undefined;
  const workspaceSha256 = typeof lane.workspace_sha256 === 'string' ? lane.workspace_sha256 : '';
  const host = architecture === undefined ? undefined : hosts.get(architecture);
  if (lane.flow !== expectedFlow || runId === undefined) {
    issues.push(`${id} does not name its expected flow and run ID`);
  }
  const resultValue = json(
    readArtifact({
      root: expected.proofRoot,
      value: lane.run_result,
      label: `${id} run result`,
      maxBytes: MAX_JSON_BYTES,
      issues,
    }),
    `${id} run result`,
    issues,
  );
  const parsedResult = MATRIX_RUN_RESULT.safeParse(resultValue);
  if (!parsedResult.success) {
    issues.push(`${id} run result does not match the RunResult contract`);
  } else if (
    parsedResult.data.run_id !== runId ||
    parsedResult.data.flow_id !== expectedFlow ||
    parsedResult.data.outcome !== 'complete'
  ) {
    issues.push(`${id} run result does not describe the completed matrix run`);
  }

  const traceRefs = Array.isArray(lane.host_traces) ? lane.host_traces : [];
  const invocationRefs = Array.isArray(lane.invocations) ? lane.invocations : [];
  if (traceRefs.length === 0 || invocationRefs.length !== traceRefs.length) {
    issues.push(`${id} must bind every host trace to one invocation record`);
  }
  if (id === 'prototype-tournament' && traceRefs.length !== 2) {
    issues.push('prototype-tournament must prove a Codex host restart');
  }

  let starts = 0;
  let resumes = 0;
  let lists = 0;
  let finalStatuses = 0;
  let unsafe = false;
  let resumedChoice: string | undefined;
  let restartListFound = false;
  let startSession: number | undefined;
  let checkpointSession: number | undefined;
  let resumeSession: number | undefined;
  let finalSession: number | undefined;
  const threadIds = new Set<string>();
  let advertisedCheckpoint:
    | { readonly token: string; readonly choiceIds: ReadonlySet<string> }
    | undefined;
  for (const [sessionIndex, traceRef] of traceRefs.entries()) {
    const label = `${id} host trace ${sessionIndex + 1}`;
    const bytes = readArtifact({
      root: expected.proofRoot,
      value: traceRef,
      label,
      maxBytes: MAX_TRACE_BYTES,
      issues,
    });
    if (bytes === undefined) continue;
    const events = parseHostEvents(bytes, label, issues);
    const threadId = events[0]?.thread_id;
    if (typeof threadId === 'string' && threadId.length > 0) threadIds.add(threadId);
    const opened = new Map<string, Record<string, unknown>>();
    for (const event of events) {
      if (!String(event.type).startsWith('item.')) continue;
      const item = record(event.item);
      if (item === undefined || typeof item.id !== 'string' || typeof item.type !== 'string') {
        issues.push(`${label} contains a malformed item`);
        continue;
      }
      if (item.type === 'command_execution' || item.type === 'file_change') {
        unsafe = true;
        continue;
      }
      if (item.type !== 'mcp_tool_call') {
        if (!SAFE_ITEMS.has(item.type)) issues.push(`${label} contains an unknown item type`);
        continue;
      }
      if (item.server !== 'circuit') {
        issues.push(`${label} contains a non-Circuit MCP call`);
        continue;
      }
      if (event.type === 'item.started') {
        if (opened.has(item.id)) issues.push(`${label} duplicates an MCP start item ID`);
        opened.set(item.id, item);
        continue;
      }
      if (event.type !== 'item.completed') continue;
      const opening = opened.get(item.id);
      if (opening === undefined || opening.tool !== item.tool) {
        issues.push(`${label} contains an unpaired MCP completion`);
      } else {
        opened.delete(item.id);
      }
      const args = argumentsOf(item);
      const response = responseOf(item);
      validateSuccessfulMcpCall(item.tool, args, response, label, issues);
      if (
        response?.ok !== true ||
        item.error !== undefined ||
        record(item.result)?.is_error === true
      ) {
        issues.push(`${label} contains a failed MCP call`);
        continue;
      }
      switch (item.tool) {
        case 'circuit_start': {
          starts += 1;
          startSession = sessionIndex;
          if (args?.flow !== expectedFlow || response.run_id !== runId) {
            issues.push(`${id} circuit_start does not match the matrix run`);
          }
          const cached = id === 'cached-search-explore';
          if (
            cached
              ? args?.web_search !== 'cached' || record(args.consent)?.cached_web_search !== true
              : args?.web_search !== undefined && args.web_search !== 'off'
          ) {
            issues.push(`${id} circuit_start has the wrong search consent policy`);
          }
          if (id.endsWith('-tournament') && args?.tournament !== 2) {
            issues.push(`${id} did not start a two-way tournament`);
          }
          if (id === 'prototype-tournament') {
            const variants = Array.isArray(args?.variants) ? args.variants.map(record) : [];
            if (variants.length !== 2 || variants.some((variant) => variant?.effort !== 'low')) {
              issues.push('prototype-tournament did not use two low-effort variants');
            }
          }
          break;
        }
        case 'circuit_status': {
          if (args?.run_id !== runId || response.run_id !== runId) {
            issues.push(`${id} circuit_status used a different run ID`);
          }
          if (response.state === 'complete') {
            finalStatuses += 1;
            finalSession = sessionIndex;
            if (record(response.final_report)?.schema !== `circuit.${expectedFlow}.result`) {
              issues.push(`${id} terminal MCP report has the wrong flow schema`);
            }
            if (!isDeepStrictEqual(record(response.final_report)?.data, parsedResult.data)) {
              issues.push(`${id} terminal MCP report does not match its checked run result`);
            }
          } else if (response.state === 'waiting_for_input') {
            checkpointSession = sessionIndex;
            const checkpoint = record(response.checkpoint);
            const choices = Array.isArray(checkpoint?.choices)
              ? checkpoint.choices.map(record)
              : [];
            const choiceIds = choices
              .map((choice) => choice?.id)
              .filter((choice): choice is string => typeof choice === 'string');
            if (typeof checkpoint?.token === 'string' && choiceIds.length === choices.length) {
              advertisedCheckpoint = { token: checkpoint.token, choiceIds: new Set(choiceIds) };
            }
          }
          break;
        }
        case 'circuit_resume':
          resumes += 1;
          resumeSession = sessionIndex;
          if (args?.run_id !== runId || response.run_id !== runId) {
            issues.push(`${id} circuit_resume used a different run ID`);
          }
          if (
            advertisedCheckpoint === undefined ||
            args?.checkpoint_token !== advertisedCheckpoint.token ||
            typeof args.choice_id !== 'string' ||
            !advertisedCheckpoint.choiceIds.has(args.choice_id)
          ) {
            issues.push(`${id} checkpoint resume does not match its advertised checkpoint`);
          } else {
            resumedChoice = args.choice_id as string;
          }
          advertisedCheckpoint = undefined;
          break;
        case 'circuit_list': {
          lists += 1;
          const runs = Array.isArray(response.runs) ? response.runs.map(record) : [];
          if (
            sessionIndex === 1 &&
            resumes === 0 &&
            runs.some(
              (run) =>
                run?.run_id === runId &&
                run?.state === 'waiting_for_input' &&
                run?.checkpoint_available === true,
            )
          ) {
            restartListFound = true;
          }
          break;
        }
        default:
          issues.push(`${label} contains an unexpected Circuit tool call`);
      }
    }
    if (opened.size > 0) issues.push(`${label} has an MCP call without a completion`);
  }
  for (const [sessionIndex, invocationRef] of invocationRefs.entries()) {
    const label = `${id} invocation ${sessionIndex + 1}`;
    const invocation = json(
      readArtifact({
        root: expected.proofRoot,
        value: invocationRef,
        label,
        maxBytes: MAX_JSON_BYTES,
        issues,
      }),
      label,
      issues,
    );
    if (architecture === undefined || host === undefined) {
      issues.push(`${label} does not name a recorded Mac architecture`);
    } else {
      issues.push(
        ...validateCodexInvocationEvidence(invocation, label, {
          workspaceSha256,
          repository: expected.repository,
          candidateRef: expected.candidateRef,
          pluginVersion: expected.pluginVersion,
          pluginTreeSha256: expected.pluginTreeSha256,
          codexVersion: host.codexVersion,
          architecture,
          macosVersion: host.macosVersion,
        }),
      );
    }
  }
  if (unsafe) issues.push(`${id} host trace contains shell or file-change work`);
  if (starts !== 1) issues.push(`${id} must contain exactly one successful circuit_start`);
  if (finalStatuses !== 1) issues.push(`${id} must contain exactly one terminal circuit_status`);
  const checkpointLane = id === 'explore-tournament' || id.startsWith('prototype');
  if (checkpointLane && resumes !== 1) {
    issues.push(`${id} did not prove checkpoint resume`);
  }
  if (!checkpointLane && resumes !== 0) {
    issues.push(`${id} unexpectedly resumed a checkpoint`);
  }
  if (id === 'prototype-tournament' && lists < 1) {
    issues.push('prototype-tournament did not recover the run through circuit_list');
  }
  if (id === 'prototype-tournament' && !restartListFound) {
    issues.push('prototype-tournament circuit_list did not contain the waiting run');
  }
  if (id === 'prototype-tournament' && threadIds.size !== 2) {
    issues.push('prototype-tournament did not prove two distinct Codex host sessions');
  }
  if (
    id === 'prototype-tournament' &&
    (startSession !== 0 || checkpointSession !== 0 || resumeSession !== 1 || finalSession !== 1)
  ) {
    issues.push(
      'prototype-tournament did not prove wait before restart, then list, resume, and close',
    );
  }

  validateFlowSpecificResult({ lane, id, expectedFlow, resumedChoice, expected, issues });

  if (id === 'cached-search-explore') {
    const trace = readArtifact({
      root: expected.proofRoot,
      value: lane.circuit_trace,
      label: `${id} Circuit trace`,
      maxBytes: MAX_TRACE_BYTES,
      issues,
    });
    let searchEvents = 0;
    const codexRelays = new Set<string>();
    for (const [index, line] of (
      trace?.toString('utf8').split(/\r?\n/u).filter(Boolean) ?? []
    ).entries()) {
      try {
        const entry = record(JSON.parse(line) as unknown);
        if (entry === undefined || !expected.validateTraceEntry(entry)) {
          issues.push(
            `${id} Circuit trace line ${index + 1} does not match the TraceEntry contract`,
          );
          continue;
        }
        if (
          entry.schema_version !== 1 ||
          entry.run_id !== runId ||
          typeof entry.sequence !== 'number' ||
          !Number.isInteger(entry.sequence) ||
          !nonEmptyString(entry.recorded_at) ||
          Number.isNaN(Date.parse(entry.recorded_at)) ||
          !nonEmptyString(entry.kind)
        ) {
          issues.push(`${id} Circuit trace line ${index + 1} is not bound to the matrix run`);
          continue;
        }
        if (entry.kind === 'relay.started') {
          exactKeys(
            entry,
            [
              'schema_version',
              'sequence',
              'recorded_at',
              'run_id',
              'kind',
              'step_id',
              'attempt',
              'connector',
              'role',
              'resolved_selection',
              'resolved_from',
            ],
            `${id} relay.started trace entry`,
            issues,
          );
          const connector = record(entry.connector);
          if (
            nonEmptyString(entry.step_id) &&
            typeof entry.attempt === 'number' &&
            Number.isInteger(entry.attempt) &&
            entry.attempt > 0 &&
            connector?.kind === 'builtin' &&
            connector.name === 'codex'
          ) {
            codexRelays.add(`${entry.step_id}:${entry.attempt}`);
          }
        }
        if (
          entry?.kind === 'relay.receipt' &&
          nonEmptyString(entry.step_id) &&
          typeof entry.attempt === 'number' &&
          Number.isInteger(entry.attempt) &&
          entry.attempt > 0 &&
          nonEmptyString(entry.cli_version) &&
          nonEmptyString(entry.receipt_id) &&
          typeof entry.web_search_count === 'number' &&
          Number.isInteger(entry.web_search_count) &&
          entry.web_search_count > 0
        ) {
          exactKeys(
            entry,
            [
              'schema_version',
              'sequence',
              'recorded_at',
              'run_id',
              'kind',
              'step_id',
              'attempt',
              'cli_version',
              'receipt_id',
              'model',
              'web_search_count',
            ],
            `${id} relay.receipt trace entry`,
            issues,
          );
          if (codexRelays.has(`${entry.step_id}:${entry.attempt}`)) {
            searchEvents += entry.web_search_count;
          }
        }
      } catch {
        issues.push(`${id} Circuit trace contains malformed JSONL`);
      }
    }
    if (searchEvents < 1) issues.push(`${id} did not record a nested Codex search event`);
  }
}

function validateLoader(
  value: unknown,
  architecture: string,
  expected: ExpectedCandidate,
  issues: string[],
): void {
  const loader = record(value);
  if (loader !== undefined) {
    exactKeys(
      loader,
      [
        'schema_version',
        'host',
        'surface',
        'mode',
        'status',
        'reason',
        'source',
        'versions',
        'evidence',
      ],
      `${architecture} loader evidence`,
      issues,
    );
  }
  const source = record(loader?.source);
  const versions = record(loader?.versions);
  if (source !== undefined) {
    exactKeys(
      source,
      ['repository', 'ref', 'expected_version'],
      `${architecture} loader source`,
      issues,
    );
  }
  if (versions !== undefined) {
    exactKeys(
      versions,
      ['codex', 'node', 'plugin', 'plugin_tree_sha256'],
      `${architecture} loader versions`,
      issues,
    );
  }
  if (
    loader?.schema_version !== 1 ||
    loader.host !== 'codex' ||
    loader.surface !== 'mcp' ||
    loader.mode !== 'published' ||
    loader.status !== 'pass' ||
    source?.repository !== expected.repository ||
    source.ref !== expected.candidateRef ||
    source.expected_version !== expected.pluginVersion ||
    versions?.plugin !== expected.pluginVersion ||
    versions.plugin_tree_sha256 !== expected.pluginTreeSha256 ||
    versions.codex !== expected.codexVersion ||
    typeof versions.node !== 'string'
  ) {
    issues.push(`${architecture} loader evidence does not match the exact candidate`);
  }
  const evidence = Array.isArray(loader?.evidence) ? loader.evidence : [];
  for (const name of REQUIRED_LOADER_EVIDENCE) {
    const matches = evidence.filter((item) => {
      const entry = record(item);
      return entry?.name === name && entry.ok === true;
    });
    if (matches.length !== 1) issues.push(`${architecture} loader evidence ${name} did not pass`);
  }
}

function validateCanary(input: {
  readonly value: unknown;
  readonly kind: 'sandbox' | 'proof-network';
  readonly architecture: 'arm64' | 'x64';
  readonly macosVersion: string;
  readonly expected: ExpectedCandidate;
  readonly issues: string[];
}): void {
  const { kind, architecture, macosVersion, expected, issues } = input;
  const label = `${architecture} ${kind === 'sandbox' ? 'sandbox' : 'proof-network'} canary`;
  const canaryId = kind === 'sandbox' ? 'nested_codex_sandbox' : 'proof_command_network';
  const testFile =
    kind === 'sandbox'
      ? 'tests/mcp/host-sandbox-canary-live.test.ts'
      : 'tests/mcp/proof-sandbox-live.test.ts';
  const requiredChecks = kind === 'sandbox' ? SANDBOX_CANARY_CHECKS : PROOF_NETWORK_CANARY_CHECKS;
  const report = record(input.value);
  if (report !== undefined) {
    exactKeys(
      report,
      [
        'schema_version',
        'canary_id',
        'status',
        'test_file',
        'source',
        'host',
        'checks',
        'cleanup_confirmed',
        'cleanup_intervention_required',
        ...(kind === 'sandbox' ? ['shared_temp_isolation'] : []),
      ],
      label,
      issues,
    );
  }
  const source = record(report?.source);
  const host = record(report?.host);
  const checks = Array.isArray(report?.checks) ? report.checks.map(record) : [];
  if (source !== undefined) {
    exactKeys(
      source,
      ['repository', 'ref', 'expected_version', 'plugin_tree_sha256'],
      `${label} source`,
      issues,
    );
  }
  if (host !== undefined) {
    exactKeys(
      host,
      ['architecture', 'macos_version', 'codex_version', 'node_version'],
      `${label} host`,
      issues,
    );
  }
  for (const check of checks) {
    if (check !== undefined) exactKeys(check, ['name', 'ok'], `${label} check`, issues);
  }
  if (
    report?.schema_version !== 1 ||
    report.canary_id !== canaryId ||
    report.status !== 'pass' ||
    report.test_file !== testFile ||
    source?.repository !== expected.repository ||
    source.ref !== expected.candidateRef ||
    source.expected_version !== expected.pluginVersion ||
    source.plugin_tree_sha256 !== expected.pluginTreeSha256 ||
    host?.architecture !== architecture ||
    host.macos_version !== macosVersion ||
    host.codex_version !== expected.codexVersion ||
    !nonEmptyString(host.node_version) ||
    report.cleanup_confirmed !== true ||
    report.cleanup_intervention_required !== false ||
    (kind === 'sandbox' &&
      report.shared_temp_isolation !== 'isolated' &&
      report.shared_temp_isolation !== 'exposed')
  ) {
    issues.push(`${label} does not match the exact candidate and host`);
  }
  for (const name of requiredChecks) {
    const matches = checks.filter((check) => check?.name === name && check.ok === true);
    if (matches.length !== 1) issues.push(`${label} check ${name} did not pass exactly once`);
  }
  if (
    checks.length !== requiredChecks.length ||
    checks.some(
      (check) =>
        check === undefined ||
        typeof check.name !== 'string' ||
        !requiredChecks.includes(check.name as never),
    )
  ) {
    issues.push(`${label} contains an unknown or duplicate check`);
  }
}

function validateNoConsentSearch(
  value: unknown,
  expected: ExpectedCandidate,
  hosts: ReadonlyMap<string, { readonly codexVersion: string; readonly macosVersion: string }>,
  issues: string[],
): void {
  const proof = record(value);
  if (proof === undefined) {
    issues.push('no-consent cached search proof is missing');
    return;
  }
  exactKeys(
    proof,
    ['architecture', 'workspace_sha256', 'host_trace', 'invocation'],
    'no-consent cached search proof',
    issues,
  );
  const architecture =
    proof.architecture === 'arm64' || proof.architecture === 'x64' ? proof.architecture : undefined;
  const workspaceSha256 = typeof proof.workspace_sha256 === 'string' ? proof.workspace_sha256 : '';
  const host = architecture === undefined ? undefined : hosts.get(architecture);
  const bytes = readArtifact({
    root: expected.proofRoot,
    value: proof.host_trace,
    label: 'no-consent search trace',
    maxBytes: MAX_TRACE_BYTES,
    issues,
  });
  if (bytes === undefined) return;
  const events = parseHostEvents(bytes, 'no-consent search trace', issues);
  let rejected = 0;
  let successful = 0;
  let startCalls = 0;
  let unsafe = false;
  const listSnapshots: string[][] = [];
  const opened = new Map<string, Record<string, unknown>>();
  for (const event of events) {
    if (!String(event.type).startsWith('item.')) continue;
    const item = record(event.item);
    if (item === undefined || typeof item.id !== 'string' || typeof item.type !== 'string') {
      unsafe = true;
      continue;
    }
    if (item.type === 'command_execution' || item.type === 'file_change') {
      unsafe = true;
      continue;
    }
    if (item.type !== 'mcp_tool_call') {
      if (!SAFE_ITEMS.has(item.type)) unsafe = true;
      continue;
    }
    if (
      item.server !== 'circuit' ||
      (item.tool !== 'circuit_list' && item.tool !== 'circuit_start')
    ) {
      unsafe = true;
      continue;
    }
    if (event.type === 'item.started') {
      if (opened.has(item.id)) unsafe = true;
      opened.set(item.id, item);
      continue;
    }
    if (event.type !== 'item.completed') {
      unsafe = true;
      continue;
    }
    const opening = opened.get(item.id);
    if (opening === undefined || opening.tool !== item.tool) {
      unsafe = true;
    } else {
      opened.delete(item.id);
    }
    const args = argumentsOf(item);
    const response = responseOf(item);
    if (item.tool === 'circuit_list') {
      const runs = Array.isArray(response?.runs) ? response.runs.map(record) : [];
      if (response?.ok !== true || runs.some((run) => typeof run?.run_id !== 'string')) {
        issues.push('no-consent cached search has a malformed circuit_list snapshot');
      } else {
        listSnapshots.push(
          runs.map((run) => run?.run_id as string).sort((left, right) => left.localeCompare(right)),
        );
      }
      continue;
    }
    if (item.tool === 'circuit_start') {
      startCalls += 1;
      if (response?.ok === true) successful += 1;
      const error = record(response?.error);
      const rendered = JSON.stringify(item);
      const expectedRejection =
        args?.flow === 'explore' &&
        args.web_search === 'cached' &&
        record(args.consent)?.cached_web_search !== true &&
        response?.ok === false &&
        response.run_id === undefined &&
        error?.message === CONSENT_ERROR &&
        rendered.includes(CONSENT_ERROR);
      if (expectedRejection) {
        rejected += 1;
      } else {
        unsafe = true;
      }
    }
  }
  if (opened.size > 0) unsafe = true;
  if (unsafe) issues.push('no-consent search trace contains unsafe or unrelated host work');
  if (
    startCalls !== 1 ||
    rejected !== 1 ||
    successful !== 0 ||
    listSnapshots.length !== 2 ||
    !isDeepStrictEqual(listSnapshots[0], listSnapshots[1])
  ) {
    issues.push(
      'no-consent cached search did not prove the exact consent rejection without run creation',
    );
  }

  const invocation = readJsonArtifact({
    root: expected.proofRoot,
    value: proof.invocation,
    label: 'no-consent search invocation',
    issues,
  });
  if (architecture === undefined || host === undefined) {
    issues.push('no-consent search invocation does not name a recorded Mac architecture');
  } else {
    issues.push(
      ...validateCodexInvocationEvidence(invocation, 'no-consent search invocation', {
        workspaceSha256,
        repository: expected.repository,
        candidateRef: expected.candidateRef,
        pluginVersion: expected.pluginVersion,
        pluginTreeSha256: expected.pluginTreeSha256,
        codexVersion: host.codexVersion,
        architecture,
        macosVersion: host.macosVersion,
      }),
    );
  }
}

export function validateCodexMcpCandidateMatrix(
  value: unknown,
  expected: ExpectedCandidate,
): string[] {
  const issues: string[] = [];
  const root = record(value);
  if (root === undefined) return ['candidate matrix must be a JSON object'];
  exactKeys(
    root,
    [
      'schema_version',
      'source',
      'stable_codex_version',
      'spend',
      'architectures',
      'runs',
      'negative_checks',
    ],
    'candidate matrix',
    issues,
  );
  if (root.schema_version !== 1) issues.push('candidate matrix schema_version must be 1');
  const source = record(root.source);
  if (source !== undefined) {
    exactKeys(
      source,
      ['repository', 'ref', 'expected_version', 'plugin_tree_sha256'],
      'candidate matrix source',
      issues,
    );
  }
  if (
    source?.repository !== expected.repository ||
    source.ref !== expected.candidateRef ||
    source.expected_version !== expected.pluginVersion ||
    source.plugin_tree_sha256 !== expected.pluginTreeSha256
  ) {
    issues.push('candidate matrix source does not match the exact release candidate');
  }
  if (root.stable_codex_version !== expected.codexVersion) {
    issues.push('candidate matrix does not name the exact proven stable Codex version');
  }
  const spend = record(root.spend);
  if (spend !== undefined) {
    exactKeys(
      spend,
      ['hard_cap_usd', 'stop_at_usd', 'provider_reported_usd', 'input_tokens', 'output_tokens'],
      'candidate matrix spend',
      issues,
    );
  }
  if (spend?.hard_cap_usd !== 50 || spend.stop_at_usd !== 45) {
    issues.push('candidate matrix must record the approved $50 cap and $45 stop point');
  }
  if (
    typeof spend?.provider_reported_usd !== 'number' ||
    spend.provider_reported_usd < 0 ||
    spend.provider_reported_usd > 45
  ) {
    issues.push('candidate matrix provider-reported spend must not exceed $45');
  }
  for (const field of ['input_tokens', 'output_tokens'] as const) {
    if (typeof spend?.[field] !== 'number' || !Number.isInteger(spend[field]) || spend[field] < 0) {
      issues.push(`candidate matrix spend is missing ${field}`);
    }
  }

  const architectures = Array.isArray(root.architectures) ? root.architectures.map(record) : [];
  const hosts = new Map<string, { codexVersion: string; macosVersion: string }>();
  for (const architecture of ['arm64', 'x64'] as const) {
    const matches = architectures.filter((entry) => entry?.architecture === architecture);
    if (matches.length !== 1) {
      issues.push(`candidate matrix must contain ${architecture} exactly once`);
      continue;
    }
    const entry = matches[0] as Record<string, unknown>;
    exactKeys(
      entry,
      ['architecture', 'macos_version', 'loader', 'sandbox_canary', 'proof_network_canary'],
      `${architecture} architecture evidence`,
      issues,
    );
    if (typeof entry.macos_version !== 'string' || entry.macos_version.length === 0) {
      issues.push(`${architecture} evidence is missing the macOS version`);
    }
    const loader = json(
      readArtifact({
        root: expected.proofRoot,
        value: entry.loader,
        label: `${architecture} loader`,
        maxBytes: MAX_JSON_BYTES,
        issues,
      }),
      `${architecture} loader`,
      issues,
    );
    validateLoader(loader, architecture, expected, issues);
    const versions = record(record(loader)?.versions);
    if (typeof versions?.codex === 'string') {
      hosts.set(architecture, {
        codexVersion: versions.codex,
        macosVersion: entry.macos_version as string,
      });
    }
    for (const [field, kind] of [
      ['sandbox_canary', 'sandbox'],
      ['proof_network_canary', 'proof-network'],
    ] as const) {
      validateCanary({
        value: readJsonArtifact({
          root: expected.proofRoot,
          value: entry[field],
          label: `${architecture} ${kind} canary`,
          issues,
        }),
        kind,
        architecture,
        macosVersion: entry.macos_version as string,
        expected,
        issues,
      });
    }
  }
  if (
    architectures.length !== 2 ||
    architectures.some((entry) => entry?.architecture !== 'arm64' && entry?.architecture !== 'x64')
  ) {
    issues.push('candidate matrix contains an unknown or duplicate architecture');
  }

  const runs = Array.isArray(root.runs) ? root.runs.map(record) : [];
  for (const [id, flow] of REQUIRED_RUNS) {
    const matches = runs.filter((run) => run?.id === id);
    if (matches.length !== 1) {
      issues.push(`candidate matrix must contain ${id} exactly once`);
      continue;
    }
    validateRun(matches[0] as Record<string, unknown>, flow, expected, hosts, issues);
  }
  const extraRuns = runs.filter((run) => typeof run?.id !== 'string' || !REQUIRED_RUNS.has(run.id));
  if (extraRuns.length > 0) issues.push('candidate matrix contains an unknown run lane');

  const negative = record(root.negative_checks);
  if (negative === undefined) {
    issues.push('candidate matrix negative checks are missing');
  } else {
    exactKeys(negative, ['no_consent_search'], 'candidate matrix negative checks', issues);
  }
  validateNoConsentSearch(negative?.no_consent_search, expected, hosts, issues);
  return issues;
}
