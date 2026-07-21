import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import {
  BuildContext,
  BuildImplementation,
  BuildReview,
} from '../../../src/flows/build/reports.js';
import {
  ExploreCompose,
  ExploreDecisionOptions,
  ExploreReviewVerdict,
  ExploreTournamentProposal,
  ExploreTournamentReview,
} from '../../../src/flows/explore/reports.js';
import { FixChange, FixContext, FixDiagnosis, FixReview } from '../../../src/flows/fix/reports.js';
import {
  PrototypeArtifact,
  PrototypePlan,
  PrototypeVariantArtifact,
  PrototypeVariantOptions,
  PrototypeVariantReview,
} from '../../../src/flows/prototype/reports.js';
import { ReviewRelayResult } from '../../../src/flows/review/reports.js';
import type { RelayResult } from '../../../src/shared/connector-relay.js';
import type { RelayFn, RelayInput } from '../../../src/shared/relay-runtime-types.js';
import { reflectChangedFiles } from '../../helpers/working-tree.js';

const PASSING_RUBRIC_MODEL_JUDGMENTS = {
  evidence_rigor: 'pass',
  actionability: 'pass',
  coverage_adequacy: 'pass',
  scope_discipline: 'pass',
  honest_calibration: 'pass',
  project_specificity: 'pass',
  insight_density: 'pass',
  branch_distinctness: 'pass',
} as const;

const FIX_CHANGED_FILE = 'src/circuit-mcp-fix-fixture.ts';
const BUILD_CHANGED_FILE = 'src/circuit-mcp-build-fixture.ts';

export interface PackagedFlowRelayerOptions {
  readonly workspace: string;
  readonly runFolder: string;
}

function result(input: RelayInput, receiptId: string, body: unknown): RelayResult {
  return {
    request_payload: input.prompt,
    receipt_id: receiptId,
    result_body: JSON.stringify(body),
    duration_ms: 1,
    cli_version: '0.0.0-packaged-flow-fixture',
  };
}

function readJson(runFolder: string, relativePath: string): unknown {
  return JSON.parse(readFileSync(join(runFolder, relativePath), 'utf8'));
}

function writeWorkspaceFile(workspace: string, relativePath: string, body: string): void {
  const absolutePath = join(workspace, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, body);
}

function prototypeFileBody(relativePath: string, label: string): string {
  switch (extname(relativePath)) {
    case '.html':
      return `<!doctype html><title>${label}</title><main>${label}</main>\n`;
    case '.json':
      return `${JSON.stringify({ fixture: label }, null, 2)}\n`;
    case '.md':
      return `# ${label}\n\nDeterministic packaged MCP fixture.\n`;
    default:
      return `Deterministic packaged MCP fixture: ${label}\n`;
  }
}

function reviewRelay(input: RelayInput): RelayResult | undefined {
  if (!input.prompt.includes('Step: audit-step')) return undefined;
  return result(
    input,
    'packaged-review-audit',
    ReviewRelayResult.parse({
      verdict: 'NO_ISSUES_FOUND',
      findings: [],
      assessment: 'The deterministic packaged MCP fixture found no actionable issue.',
      verification: ['Read the materialized review intake supplied to the audit block.'],
      confidence_limitations: ['This acceptance fixture does not make a real model call.'],
    }),
  );
}

function fixRelay(input: RelayInput, workspace: string): RelayResult | undefined {
  if (input.prompt.includes('Step: fix-gather-context')) {
    return result(
      input,
      'packaged-fix-context',
      FixContext.parse({
        verdict: 'accept',
        sources: [
          {
            kind: 'file',
            ref: 'package.json',
            summary: 'The isolated acceptance workspace is available to the Fix flow.',
          },
        ],
        observations: ['The fixture can make and verify one bounded local change.'],
        open_questions: [],
      }),
    );
  }
  if (input.prompt.includes('Step: fix-diagnose')) {
    return result(
      input,
      'packaged-fix-diagnosis',
      FixDiagnosis.parse({
        verdict: 'accept',
        reproduction_status: 'reproduced',
        cause_summary: 'The fixture source is missing the requested deterministic marker.',
        confidence: 'high',
        evidence: ['The marker file does not exist before the Fix act block runs.'],
        residual_uncertainty: [],
      }),
    );
  }
  if (input.prompt.includes('Step: fix-act')) {
    reflectChangedFiles(workspace, [FIX_CHANGED_FILE]);
    return result(
      input,
      'packaged-fix-act',
      FixChange.parse({
        verdict: 'accept',
        summary: 'Created the deterministic Fix fixture marker.',
        diagnosis_ref: 'fix.diagnosis@v1',
        changed_files: [FIX_CHANGED_FILE],
        evidence: [`${FIX_CHANGED_FILE} now differs from the workspace baseline.`],
      }),
    );
  }
  if (input.prompt.includes('Step: fix-review')) {
    return result(
      input,
      'packaged-fix-review',
      FixReview.parse({
        verdict: 'accept',
        summary: 'The deterministic Fix fixture change is bounded and matches the diagnosis.',
        findings: [],
      }),
    );
  }
  return undefined;
}

function buildRelay(input: RelayInput, workspace: string): RelayResult | undefined {
  if (input.prompt.includes('Step: analyze-step')) {
    return result(
      input,
      'packaged-build-context',
      BuildContext.parse({
        verdict: 'accept',
        sources: [
          {
            kind: 'file',
            ref: 'package.json',
            summary: 'The isolated acceptance workspace defines a passing check command.',
          },
        ],
        observations: ['The requested marker can be added as one TypeScript file.'],
        open_questions: [],
        anticipated_file_extensions: ['.ts'],
      }),
    );
  }
  if (input.prompt.includes('Step: act-step') && input.prompt.includes('build.implementation@v1')) {
    reflectChangedFiles(workspace, [BUILD_CHANGED_FILE]);
    return result(
      input,
      'packaged-build-act',
      BuildImplementation.parse({
        verdict: 'accept',
        summary: 'Created the deterministic Build fixture marker.',
        changed_files: [BUILD_CHANGED_FILE],
        evidence: [`${BUILD_CHANGED_FILE} now differs from the workspace baseline.`],
      }),
    );
  }
  if (input.prompt.includes('Step: review-step') && input.prompt.includes('build.review@v1')) {
    return result(
      input,
      'packaged-build-review',
      BuildReview.parse({
        verdict: 'accept',
        summary: 'The deterministic Build fixture change is within the requested scope.',
        findings: [],
        alignment: { scope_adherence: 'within_scope', non_goals: [], invariants: [] },
      }),
    );
  }
  return undefined;
}

function exploreRelay(input: RelayInput, runFolder: string): RelayResult | undefined {
  const proposalMatch = input.prompt.match(/Step: proposal-fanout-step-(option-[1-4])/);
  if (proposalMatch !== null) {
    const optionId = proposalMatch[1];
    const options = ExploreDecisionOptions.parse(
      readJson(runFolder, 'reports/decision-options.json'),
    );
    const option = options.options.find((candidate) => candidate.id === optionId);
    if (option === undefined) {
      throw new Error(`packaged Explore fixture could not find ${optionId} in decision options`);
    }
    return result(
      input,
      `packaged-explore-${option.id}`,
      ExploreTournamentProposal.parse({
        verdict: 'accept',
        option_id: option.id,
        option_label: option.label,
        case_summary: `${option.label} is a viable deterministic fixture option.`,
        assumptions: ['The acceptance run needs deterministic local evidence only.'],
        evidence_refs: ['reports/decision-options.json'],
        risks: ['This fixture does not compare real model output.'],
        next_action: `Use ${option.label} for the packaged MCP proof.`,
        rubric_model_judgments: PASSING_RUBRIC_MODEL_JUDGMENTS,
      }),
    );
  }
  if (input.prompt.includes('Step: stress-proposals-step')) {
    const options = ExploreDecisionOptions.parse(
      readJson(runFolder, 'reports/decision-options.json'),
    );
    const recommended = options.options[0];
    if (recommended === undefined) throw new Error('packaged Explore fixture has no options');
    return result(
      input,
      'packaged-explore-tournament-review',
      ExploreTournamentReview.parse({
        verdict: 'recommend',
        recommended_option_id: recommended.id,
        comparison: `${recommended.label} is the first deterministic accepted option.`,
        objections: [],
        missing_evidence: ['No real model comparison was performed.'],
        tradeoff_question: 'Should the first deterministic option be used for this proof?',
        confidence: 'medium',
      }),
    );
  }
  if (input.prompt.includes('Step: synthesize-step')) {
    return result(
      input,
      'packaged-explore-synthesis',
      ExploreCompose.parse({
        verdict: 'accept',
        subject: 'Packaged MCP acceptance',
        recommendation: 'Keep the packaged boundary deterministic and explicitly injected.',
        success_condition_alignment: 'The flow can reach its close block without a model call.',
        supporting_aspects: [
          {
            aspect: 'package boundary',
            contribution: 'The relocated package drives the same engine and reports.',
            evidence_refs: ['reports/analysis.json'],
          },
        ],
      }),
    );
  }
  if (
    input.prompt.includes('Step: review-step') &&
    input.prompt.includes('explore.review-verdict@v1')
  ) {
    return result(
      input,
      'packaged-explore-review',
      ExploreReviewVerdict.parse({
        verdict: 'accept',
        overall_assessment: 'The deterministic recommendation is supported by the run reports.',
        objections: [],
        missed_angles: [],
      }),
    );
  }
  return undefined;
}

function prototypeRelay(
  input: RelayInput,
  options: PackagedFlowRelayerOptions,
): RelayResult | undefined {
  if (input.prompt.includes('Step: act-step') && input.prompt.includes('prototype.artifact@v1')) {
    const plan = PrototypePlan.parse(readJson(options.runFolder, 'reports/prototype/plan.json'));
    for (const relativePath of new Set([...plan.files_to_create, ...plan.entry_points])) {
      writeWorkspaceFile(
        options.workspace,
        relativePath,
        prototypeFileBody(relativePath, 'Circuit packaged MCP prototype'),
      );
    }
    return result(
      input,
      'packaged-prototype-act',
      PrototypeArtifact.parse({
        verdict: 'accept',
        summary: 'Created a local deterministic prototype through the packaged MCP worker.',
        prototype_root: plan.prototype_root,
        created_files: plan.files_to_create,
        entry_points: plan.entry_points,
        preview_instructions: plan.preview_instructions,
        known_limitations: ['The acceptance artifact is deliberately minimal.'],
        evidence: ['Every declared prototype file exists in the isolated workspace.'],
        claim_limits: ['not production', 'not deployed'],
      }),
    );
  }

  const variantOptionsPath = join(options.runFolder, 'reports/prototype/variant-options.json');
  if (input.prompt.includes('Step: variant-fanout-step') || existsSync(variantOptionsPath)) {
    const variantOptions = PrototypeVariantOptions.parse(
      readJson(options.runFolder, 'reports/prototype/variant-options.json'),
    );
    const model = input.resolvedSelection?.model?.model;
    const variant = variantOptions.variants.find(
      (candidate) =>
        candidate.model === model ||
        input.prompt.includes(`Step: variant-fanout-step-${candidate.variant_id}`),
    );
    if (variant !== undefined) {
      const entryPoint = `${variant.variant_root}/index.html`;
      writeWorkspaceFile(
        options.workspace,
        entryPoint,
        prototypeFileBody(entryPoint, variant.label),
      );
      return result(
        input,
        `packaged-prototype-${variant.variant_id}`,
        PrototypeVariantArtifact.parse({
          verdict: 'accept',
          variant_id: variant.variant_id,
          variant_label: variant.label,
          summary: `${variant.label} created a deterministic local comparison artifact.`,
          prototype_root: variantOptions.prototype_root,
          variant_root: variant.variant_root,
          created_files: [entryPoint],
          entry_points: [entryPoint],
          preview_instructions: `Open ${entryPoint} locally.`,
          known_limitations: ['The variant is a deterministic acceptance fixture.'],
          evidence: [`${entryPoint} exists in the isolated workspace.`],
          rubric_model_judgments: PASSING_RUBRIC_MODEL_JUDGMENTS,
          claim_limits: ['not production', 'not deployed'],
        }),
      );
    }
  }

  if (input.prompt.includes('Step: variant-review-step')) {
    const variantOptions = PrototypeVariantOptions.parse(
      readJson(options.runFolder, 'reports/prototype/variant-options.json'),
    );
    const recommended = variantOptions.variants[0];
    if (recommended === undefined) throw new Error('packaged Prototype fixture has no variants');
    return result(
      input,
      'packaged-prototype-variant-review',
      PrototypeVariantReview.parse({
        verdict: 'recommend',
        recommended_variant_id: recommended.variant_id,
        comparison_summary: `${recommended.label} is the first deterministic admitted variant.`,
        strengths: variantOptions.variants.map((variant) => ({
          variant_id: variant.variant_id,
          note: `${variant.label} produced its declared local entry point.`,
        })),
        risks: ['The fixture compares contract-valid artifacts, not model quality.'],
        missing_evidence: [],
        confidence: 'medium',
      }),
    );
  }
  return undefined;
}

/**
 * A fully local relayer for packaged MCP acceptance tests.
 *
 * It returns schema-checked model output and performs the same workspace writes
 * a real Fix, Build, or Prototype worker would perform. It never reads process
 * environment or invokes an external model.
 */
export function createPackagedFlowRelayer(options: PackagedFlowRelayerOptions): RelayFn {
  return {
    connectorName: 'codex',
    relay: async (input) => {
      const fixtureResult =
        reviewRelay(input) ??
        fixRelay(input, options.workspace) ??
        buildRelay(input, options.workspace) ??
        exploreRelay(input, options.runFolder) ??
        prototypeRelay(input, options);
      if (fixtureResult !== undefined) return fixtureResult;

      const step = input.prompt.match(/Step: ([^\n]+)/)?.[1] ?? '<unknown>';
      throw new Error(`packaged flow fixture received an unsupported relay block: ${step}`);
    },
  };
}
