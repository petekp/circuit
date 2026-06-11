// Verdict-correctness eval runner.
//
// Steps per case:
//   1. Read a real review.request.json from a historical run.
//   2. Apply a defect (or pass through unchanged for control runs).
//   3. Send the resulting prompt to the codex connector.
//   4. Parse the result_body, validate against the explore.review-verdict
//      schema, and score whether the planted defect surfaced.

import { readFileSync } from 'node:fs';
import { relayClaudeCode } from '../../dist/connectors/claude-code.js';
import { relayCodex } from '../../dist/connectors/codex.js';
import { ExploreReviewVerdict } from '../../dist/flows/explore/reports.js';
import { extractJsonObject } from '../../dist/shared/json-extraction.js';
import type { ResolvedSelection } from '../../src/schemas/selection-policy.js';
import { DEFECT_DESCRIPTIONS, DEFECT_IDS, DEFECT_PLANTERS } from './defect-taxonomy.ts';
import { parseRequest, rebuildRequest, upgradeShapeHintInstruction } from './prompt-mutation.ts';
import { scoreDefect } from './scorer.ts';
import type { DefectId, EvalCase, EvalCaseResult, JudgeId } from './types.ts';

// 2 minutes per case. Successful codex cases complete in 11–91s with the
// current prompt; a longer wait is almost always a CLI hang
// ("Reading additional input from stdin..."). Failing fast keeps total
// wallclock close to median × case-count even when a CLI misbehaves.
// claude-code under the same prompt completes in similar wallclock
// because the review prompt is self-contained (no tool use needed); the
// same 2-min ceiling applies as a fail-fast bound.
const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;

// Connector dispatch. Same input shape, same RelayResult shape; only the
// model family differs. Adding a new judge is a one-line addition here.
// `resolvedSelection` is how the claude-code connector receives a pinned
// model (provider 'anthropic'); the connector adds `--model` when present.
interface JudgeRelayInput {
  prompt: string;
  timeoutMs?: number;
  resolvedSelection?: ResolvedSelection;
}
const RELAY_BY_JUDGE: Record<
  JudgeId,
  (input: JudgeRelayInput) => Promise<{
    result_body: string;
    duration_ms: number;
    cli_version: string;
  }>
> = {
  codex: relayCodex,
  'claude-code': relayClaudeCode,
};

export interface BuildCasesInput {
  readonly requestPaths: readonly string[];
  readonly defects: readonly DefectId[];
  readonly includeControl: boolean;
}

export function buildCases(input: BuildCasesInput): EvalCase[] {
  const cases: EvalCase[] = [];
  for (const requestPath of input.requestPaths) {
    const requestText = readFileSync(requestPath, 'utf8');
    const parsed = parseRequest(requestText);
    const sourceRunId = extractRunIdFromPath(requestPath);
    const sourceSubject = parsed.originalCompose.subject;
    if (input.includeControl) {
      // Upgrade the captured shape-hint instruction to the current
      // production text so the control measures the same prompt the
      // mutated cases use. Otherwise the control's prompt-shape would
      // diverge from the test prompts and a regression in the
      // production prompt could not be observed via the control.
      const controlPrompt = upgradeShapeHintInstruction(requestText);
      cases.push({
        source_run_id: sourceRunId,
        source_request_path: requestPath,
        source_subject: sourceSubject,
        defect_id: 'control',
        prompt: controlPrompt,
        mutation_summary:
          'unmodified original request (shape hint upgraded to current production text)',
      });
    }
    for (const defectId of input.defects) {
      try {
        const planter = DEFECT_PLANTERS[defectId];
        const result = planter(parsed.originalCompose);
        const mutatedRequest = rebuildRequest(parsed, result.mutated);
        cases.push({
          source_run_id: sourceRunId,
          source_request_path: requestPath,
          source_subject: sourceSubject,
          defect_id: defectId,
          prompt: mutatedRequest,
          mutation_summary: result.mutation_summary,
        });
      } catch (err) {
        cases.push({
          source_run_id: sourceRunId,
          source_request_path: requestPath,
          source_subject: sourceSubject,
          defect_id: defectId,
          prompt: requestText,
          mutation_summary: `SKIPPED: ${(err as Error).message}`,
        });
      }
    }
  }
  return cases;
}

export interface RunOptions {
  readonly timeoutMs?: number;
  readonly judge?: JudgeId;
  // Anthropic model id to pin the claude-code judge to. Ignored for codex
  // (cli-args.ts rejects --model with any non-claude-code judge upstream).
  readonly model?: string | null;
  readonly onProgress?: (
    index: number,
    total: number,
    caseDef: EvalCase,
    result: EvalCaseResult,
  ) => void;
}

export async function runCase(
  caseDef: EvalCase,
  options: RunOptions = {},
): Promise<EvalCaseResult> {
  if (caseDef.mutation_summary.startsWith('SKIPPED')) {
    return {
      case: caseDef,
      outcome: { kind: 'connector_error', message: caseDef.mutation_summary },
      score: { kind: 'skipped', reason: caseDef.mutation_summary },
    };
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const judge: JudgeId = options.judge ?? 'codex';
  const relay = RELAY_BY_JUDGE[judge];
  // Only the claude-code connector honors a pinned model via resolvedSelection;
  // upstream validation guarantees model is unset for other judges. The
  // connector reads only `.model`/`.effort`; `skills`/`invocation_options` are
  // the schema defaults a fully resolved selection always carries.
  const resolvedSelection: ResolvedSelection | undefined =
    judge === 'claude-code' && options.model
      ? { skills: [], invocation_options: {}, model: { provider: 'anthropic', model: options.model } }
      : undefined;
  let raw: { result_body: string; duration_ms: number; cli_version: string };
  try {
    raw = await relay({
      prompt: caseDef.prompt,
      timeoutMs,
      ...(resolvedSelection ? { resolvedSelection } : {}),
    });
  } catch (err) {
    return {
      case: caseDef,
      outcome: { kind: 'connector_error', message: (err as Error).message },
      score: { kind: 'skipped', reason: 'connector_error' },
    };
  }
  let extracted: string;
  try {
    extracted = extractJsonObject(raw.result_body);
  } catch (err) {
    return {
      case: caseDef,
      outcome: {
        kind: 'parse_error',
        message: (err as Error).message,
        raw_response: raw.result_body,
      },
      score: { kind: 'skipped', reason: 'parse_error' },
    };
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(extracted);
  } catch (err) {
    return {
      case: caseDef,
      outcome: {
        kind: 'parse_error',
        message: `JSON.parse failed: ${(err as Error).message}`,
        raw_response: raw.result_body,
      },
      score: { kind: 'skipped', reason: 'parse_error' },
    };
  }
  const validation = ExploreReviewVerdict.safeParse(parsedJson);
  if (!validation.success) {
    return {
      case: caseDef,
      outcome: {
        kind: 'schema_error',
        message: validation.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        raw_response: raw.result_body,
      },
      score: { kind: 'skipped', reason: 'schema_error' },
    };
  }
  const verdict = validation.data;
  if (caseDef.defect_id === 'control') {
    return {
      case: caseDef,
      outcome: {
        kind: 'success',
        result: {
          verdict,
          raw_response: raw.result_body,
          duration_ms: raw.duration_ms,
          cli_version: raw.cli_version,
        },
      },
      score: { kind: 'control', original_verdict: verdict.verdict },
    };
  }
  const score = scoreDefect(caseDef.defect_id, verdict);
  return {
    case: caseDef,
    outcome: {
      kind: 'success',
      result: {
        verdict,
        raw_response: raw.result_body,
        duration_ms: raw.duration_ms,
        cli_version: raw.cli_version,
      },
    },
    score: score.caught
      ? { kind: 'caught', matched_signal: score.matched_signal ?? 'unknown' }
      : { kind: 'missed' },
  };
}

export async function runEval(
  cases: readonly EvalCase[],
  options: RunOptions = {},
): Promise<EvalCaseResult[]> {
  const results: EvalCaseResult[] = [];
  for (let i = 0; i < cases.length; i += 1) {
    const caseDef = cases[i];
    if (caseDef === undefined) continue;
    const result = await runCase(caseDef, options);
    results.push(result);
    options.onProgress?.(i, cases.length, caseDef, result);
  }
  return results;
}

function extractRunIdFromPath(p: string): string {
  const match = p.match(/runs\/([^/]+)\//);
  return match?.[1] ?? p;
}

export { DEFECT_IDS, DEFECT_DESCRIPTIONS };
