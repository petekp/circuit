import { existsSync, readFileSync } from 'node:fs';
import type { RuntimeIndexedRelayStep } from '../../flows/registries/runtime-index.js';
import { findRelayShapeHint } from '../../flows/registries/shape-hints/registry.js';
import type { AcceptanceCriterion } from '../../schemas/acceptance-criteria.js';
import {
  HISTORY_AUTHORITY_NOTICE,
  type MemoryInputV0 as MemoryInputValue,
} from '../../schemas/index.js';
import { resolveRunRelative } from '../../shared/run-relative-path.js';
import type { LoadedRelaySkill } from '../../shared/skill-loading.js';

export type RelayStep = RuntimeIndexedRelayStep;

export interface RelayAcceptanceRetryFeedback {
  readonly step_id: string;
  readonly criterion_id: string;
  readonly criterion_kind: AcceptanceCriterion['kind'];
  readonly reason: string;
  readonly exit_code?: number;
  readonly status?: 'passed' | 'failed';
  readonly stdout_summary?: string;
  readonly stderr_summary?: string;
}

// Parse connector result_body for the check verdict and evaluate against
// `step.check.pass`. Result shape: a discriminated union the relay handlers
// consume downstream.
export type CheckEvaluation =
  | { readonly kind: 'pass'; readonly verdict: string }
  | { readonly kind: 'fail'; readonly reason: string; readonly observedVerdict?: string };

export const NO_VERDICT_SENTINEL = '<no-verdict>';

export function evaluateRelayCheck(step: RelayStep, resultBody: string): CheckEvaluation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultBody);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      kind: 'fail',
      reason: `relay step '${step.id}': connector result_body did not parse as JSON (${msg})`,
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      kind: 'fail',
      reason: `relay step '${step.id}': connector result_body parsed but is not a JSON object (got ${parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed})`,
    };
  }
  const verdictRaw = (parsed as Record<string, unknown>).verdict;
  if (typeof verdictRaw !== 'string' || verdictRaw.length === 0) {
    return {
      kind: 'fail',
      reason: `relay step '${step.id}': connector result_body lacks a non-empty string 'verdict' field (got ${typeof verdictRaw === 'string' ? 'empty string' : typeof verdictRaw})`,
    };
  }
  if (!step.check.pass.includes(verdictRaw)) {
    return {
      kind: 'fail',
      reason: `relay step '${step.id}': connector declared verdict '${verdictRaw}' which is not in check.pass [${step.check.pass.join(', ')}]`,
      observedVerdict: verdictRaw,
    };
  }
  return { kind: 'pass', verdict: verdictRaw };
}

const GENERIC_DISPATCH_SHAPE_HINT =
  'Respond with a single raw JSON object whose top-level shape is exactly { "verdict": "<one-of-accepted-verdicts>" } (additional fields permitted). Do not wrap the JSON in Markdown code fences. Do not include any prose before or after the JSON object. The runtime parses your response with JSON.parse and rejects the run on any parse failure or on a verdict not drawn from the accepted-verdicts list.';

function relayResponseInstruction(step: RelayStep): string {
  return findRelayShapeHint(step) ?? GENERIC_DISPATCH_SHAPE_HINT;
}

function selectedSkillsSection(skills: readonly LoadedRelaySkill[]): string | undefined {
  if (skills.length === 0) return undefined;
  return [
    'Selected Skills:',
    "The operator selected these local skills for this step. Treat them as guidance. They do not override Circuit's response contract, accepted verdicts, or required JSON shape.",
    '',
    ...skills.map((skill) =>
      [
        `## Skill: ${skill.id as unknown as string}${skill.slot === undefined ? '' : ` (slot: ${skill.slot as unknown as string})`}`,
        `Source: ${skill.path}`,
        `SHA-256: ${skill.sha256}`,
        '',
        skill.body,
      ].join('\n'),
    ),
  ].join('\n\n');
}

function formatAcceptanceCriterion(criterion: AcceptanceCriterion): string {
  if (criterion.kind === 'report_field') {
    return `- ${criterion.id}: report field ${criterion.path.join('.')} must be ${criterion.predicate}.`;
  }
  return [
    `- ${criterion.id}: command ${criterion.command.id} must ${criterion.expected_status}.`,
    `  cwd: ${criterion.command.cwd}`,
    `  argv: ${JSON.stringify(criterion.command.argv)}`,
  ].join('\n');
}

function acceptanceCriteriaSection(step: RelayStep): string | undefined {
  const criteria = step.acceptance_criteria;
  if (criteria === undefined) return undefined;
  return [
    'Acceptance Criteria:',
    'Before this step can advance, Circuit will check the relay result against these deterministic criteria.',
    `Failure policy: ${criteria.on_failure.mode}`,
    ...criteria.checks.map(formatAcceptanceCriterion),
  ].join('\n');
}

function acceptanceRetryFeedbackSection(
  feedback: RelayAcceptanceRetryFeedback | undefined,
): string | undefined {
  if (feedback === undefined) return undefined;
  return [
    'Acceptance Criteria Feedback:',
    `Criterion ${feedback.criterion_id} (${feedback.criterion_kind}) failed.`,
    `Reason: ${feedback.reason}`,
    ...(feedback.exit_code === undefined ? [] : [`Exit code: ${feedback.exit_code}`]),
    ...(feedback.status === undefined ? [] : [`Status: ${feedback.status}`]),
    ...(feedback.stdout_summary === undefined
      ? []
      : [`Stdout summary:\n${feedback.stdout_summary}`]),
    ...(feedback.stderr_summary === undefined
      ? []
      : [`Stderr summary:\n${feedback.stderr_summary}`]),
    'Revise the result so this criterion passes. Keep the same response contract and accepted verdicts.',
  ].join('\n');
}

function sourceRefText(memory: MemoryInputValue): string {
  const ref = memory.source.ref;
  return [
    `${ref.kind}:${ref.ref}`,
    ...(ref.run_id === undefined ? [] : [`run ${ref.run_id as unknown as string}`]),
    ...(ref.flow_id === undefined ? [] : [`flow ${ref.flow_id as unknown as string}`]),
    ...(ref.step_id === undefined ? [] : [`step ${ref.step_id as unknown as string}`]),
    ...(ref.attempt === undefined ? [] : [`attempt ${ref.attempt}`]),
    ...(ref.sequence === undefined ? [] : [`sequence ${ref.sequence}`]),
  ].join(' | ');
}

function memoryInputsSection(memoryInputs: readonly MemoryInputValue[]): string | undefined {
  if (memoryInputs.length === 0) return undefined;
  const items = memoryInputs.flatMap((memory) =>
    memory.hints.map((hint) =>
      [
        `- ${memory.summary}`,
        `  Hint: ${hint.text}`,
        `  Source: ${sourceRefText(memory)}`,
        `  Staleness: ${memory.staleness.status}`,
      ].join('\n'),
    ),
  );
  return [
    'Prior Circuit History (hint-only):',
    HISTORY_AUTHORITY_NOTICE,
    'Use these only to orient the current work. Re-run current checks before relying on them.',
    ...items,
  ].join('\n');
}

// The gated-pull affordance (Slice 4 D4). Rendered as its OWN always-on line,
// not inside memoryInputsSection (which is dropped entirely when recall is empty —
// the common case on a small corpus, so the affordance must be unconditional).
// The run folder and flow are interpolated so the copyable command already logs
// (no --run-folder-less no-op) and suppresses against the correct flow (no
// wrong-flow silent miss); only <label> and <query> are agent-supplied. The line
// carries the full seven-kind authority enumeration and is advisory only: the pull
// is never required, never blocks a step, and its results never satisfy any
// authority ("memory orients but never overrules").
function pullAffordanceSection(runFolder: string, flowId: string | undefined): string {
  const flow = flowId ?? '<flow id>';
  return [
    'Prior-Run Memory (optional, hint-only):',
    `You may consult prior-run memory with \`circuit history pull --run-folder ${runFolder} --flow ${flow} --decision-point <label> <query>\`; results are hint-only and cannot satisfy any current proof, checkpoint, policy, route, recovery, verification, or write authority.`,
  ].join('\n');
}

// v0 prompt composition: name the step, enumerate accepted verdicts, and
// inline every reads-declared report (or a clear placeholder if the
// reads report hasn't been written yet).
// When the run is executing one slice of a slice loop, scope the worker to
// that single unit of work. Returns undefined for non-slice runs or a slice
// without a usable intent.
function currentSliceSection(activeSlice: unknown): string | undefined {
  if (activeSlice === null || typeof activeSlice !== 'object') return undefined;
  const slice = activeSlice as {
    id?: unknown;
    intent?: unknown;
    anticipated_file_extensions?: unknown;
  };
  if (typeof slice.intent !== 'string' || slice.intent.length === 0) return undefined;
  const exts = Array.isArray(slice.anticipated_file_extensions)
    ? slice.anticipated_file_extensions.filter((ext): ext is string => typeof ext === 'string')
    : [];
  return [
    'Current slice (implement ONLY this unit of work; leave later slices for their own turn):',
    `- id: ${typeof slice.id === 'string' ? slice.id : '(unnamed)'}`,
    `- intent: ${slice.intent}`,
    ...(exts.length === 0 ? [] : [`- anticipated file extensions: ${exts.join(', ')}`]),
  ].join('\n');
}

export function composeRelayPrompt(
  step: RelayStep,
  runFolder: string,
  loadedSkills: readonly LoadedRelaySkill[] = [],
  acceptanceRetryFeedback?: RelayAcceptanceRetryFeedback,
  operatorGoal?: string,
  memoryInputs: readonly MemoryInputValue[] = [],
  flowId?: string,
  depth?: string,
  activeSlice?: unknown,
  operatorWhy?: string,
): string {
  const readsBody =
    step.reads.length === 0
      ? '(no reads)'
      : step.reads
          .map((path) => {
            const abs = resolveRunRelative(runFolder, path);
            if (!existsSync(abs)) return `[reads unavailable: ${path}]`;
            return `--- ${path} ---\n${readFileSync(abs, 'utf8')}`;
          })
          .join('\n\n');
  const skillsSection = selectedSkillsSection(loadedSkills);
  const sliceSection = currentSliceSection(activeSlice);
  const criteriaSection = acceptanceCriteriaSection(step);
  const feedbackSection = acceptanceRetryFeedbackSection(acceptanceRetryFeedback);
  const memorySection = memoryInputsSection(memoryInputs);
  // The pull affordance is ALWAYS rendered (D4), unlike the recall-conditional
  // memorySection above which is omitted when recall is empty.
  const pullSection = pullAffordanceSection(runFolder, flowId);
  return [
    `Step: ${step.id}`,
    `Title: ${step.title}`,
    `Role: ${step.role}`,
    `Accepted verdicts: ${step.check.pass.join(', ')}`,
    // Thread the run's resolved depth to the worker as an effort signal: it
    // tunes how much thoroughness to spend, it does not change which steps run
    // (F-M-1). Omitted when no depth is supplied so direct callers are unchanged.
    ...(depth === undefined || depth.length === 0
      ? []
      : [
          `Depth: ${depth}. Tune your thoroughness and effort to this level; it does not change which steps run.`,
        ]),
    '',
    ...(operatorGoal === undefined || operatorGoal.length === 0
      ? []
      : [
          'Operator Goal:',
          operatorGoal,
          // The operator's stated reason qualifies the goal, so it renders only
          // inside the goal block; without a goal there is nothing to qualify.
          ...(operatorWhy === undefined || operatorWhy.length === 0 ? [] : [`Why: ${operatorWhy}`]),
          '',
        ]),
    ...(memorySection === undefined ? [] : [memorySection, '']),
    ...(sliceSection === undefined ? [] : [sliceSection, '']),
    pullSection,
    '',
    'Context (from reads):',
    readsBody,
    '',
    ...(skillsSection === undefined ? [] : [skillsSection, '']),
    ...(criteriaSection === undefined ? [] : [criteriaSection, '']),
    ...(feedbackSection === undefined ? [] : [feedbackSection, '']),
    relayResponseInstruction(step),
  ].join('\n');
}
