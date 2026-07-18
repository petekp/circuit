// Prototype checkpoint HTML projector.
//
// Two checkpoint surfaces share this projector. The single-prototype
// checkpoint renders through the shared checkpoint page (ribbon,
// recommendation, options, do-nothing strip, resume commands) with
// Prototype's evidence cards as context. The model-comparison checkpoint
// renders through the shared multi-variant comparison page.

import {
  type CheckpointPageOption,
  renderCheckpointPage,
  resumeCommandForChoice,
  shellSingleQuote,
} from '../../../shared/html/checkpoint-page.js';
import {
  type MultiVariantItem,
  previewForEntryPoints,
  renderMultiVariantComparisonPage,
} from '../../../shared/html/multi-variant.js';
import { MAX_PROMPT_LEN } from '../../../shared/html/page.js';
import type { HtmlProjector, JsonObject } from '../../../shared/html/projector.js';
import { t } from '../../../shared/html/react-page.js';
import {
  BulletList,
  Chip,
  ChipRow,
  ReportCard,
  SectionLabel,
  Summary,
} from '../../../shared/html/report-components.js';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../../../shared/html/ui/collapsible.js';
import {
  PrototypeArtifact,
  PrototypeBrief,
  type PrototypeCheckpointSelection,
  PrototypePlan,
  PrototypeVariantAggregate,
  PrototypeVariantChoiceOptions,
  PrototypeVariantProviderEvidence,
  PrototypeVariantReview,
  PrototypeVariantVerification,
  PrototypeVerification,
} from '../reports.js';

const PROTOTYPE_BRIEF_PATH = 'reports/prototype/brief.json';
const PROTOTYPE_PLAN_PATH = 'reports/prototype/plan.json';
const PROTOTYPE_ARTIFACT_PATH = 'reports/prototype/artifact.json';
const PROTOTYPE_VERIFICATION_PATH = 'reports/prototype/verification.json';
const PROTOTYPE_VARIANT_AGGREGATE_PATH = 'reports/prototype/variant-aggregate.json';
const PROTOTYPE_VARIANT_PROVIDER_EVIDENCE_PATH = 'reports/prototype/variant-provider-evidence.json';
const PROTOTYPE_VARIANT_VERIFICATION_PATH = 'reports/prototype/variant-verification.json';
const PROTOTYPE_VARIANT_REVIEW_PATH = 'reports/prototype/variant-review.json';
const PROTOTYPE_VARIANT_CHOICES_PATH = 'reports/prototype/variant-choice-options.json';

type ChoiceCard = {
  readonly id: PrototypeCheckpointSelection;
  readonly label: string;
  readonly description: string;
};

const CHOICES: readonly ChoiceCard[] = [
  {
    id: 'keep-prototype',
    label: 'Keep Prototype',
    description: 'Save the prototype as useful evidence and stop here.',
  },
  {
    id: 'save-build-input',
    label: 'Save Build Input',
    description: 'Close with a Build-ready follow-up prompt, without running Build.',
  },
  {
    id: 'discard-prototype',
    label: 'Discard Prototype',
    description: 'Mark the prototype as discarded while keeping the evidence trail.',
  },
];

function commandText(command: { readonly argv: readonly string[]; readonly cwd: string }): string {
  return `${command.cwd}$ ${command.argv.join(' ')}`;
}

function load<T>(
  readJsonRunRelative: (relPath: string) => JsonObject | undefined,
  relPath: string,
  parse: (
    raw: unknown,
  ) => { readonly success: true; readonly data: T } | { readonly success: false },
): T | undefined {
  const parsed = parse(readJsonRunRelative(relPath));
  return parsed.success ? parsed.data : undefined;
}

function ArtifactCard({ artifact }: { readonly artifact: PrototypeArtifact }) {
  return (
    <ReportCard intent="positive" eyebrow="artifact" title="Prototype files">
      <Summary text={artifact.summary} />
      <div>
        <SectionLabel>Prototype root</SectionLabel>
        <ChipRow items={[artifact.prototype_root]} />
      </div>
      <div>
        <SectionLabel>Entry points</SectionLabel>
        <ChipRow items={artifact.entry_points} />
      </div>
      <div>
        <SectionLabel>Preview</SectionLabel>
        <Summary text={artifact.preview_instructions} />
      </div>
    </ReportCard>
  );
}

function VerificationCard({ verification }: { readonly verification: PrototypeVerification }) {
  const status = verification.overall_status;
  return (
    <ReportCard
      intent={status === 'passed' ? 'positive' : 'negative'}
      eyebrow={status}
      title="Verification"
    >
      <Summary
        text={
          status === 'passed'
            ? 'Artifact integrity and target checks passed.'
            : 'One or more checks failed.'
        }
      />
      <div>
        <SectionLabel>Checks</SectionLabel>
        <ChipRow items={verification.commands.map(commandText)} />
      </div>
    </ReportCard>
  );
}

function RiskCard({
  artifact,
  brief,
}: {
  readonly artifact: PrototypeArtifact;
  readonly brief: PrototypeBrief;
}) {
  const limits = Array.from(new Set([...brief.claim_limits, ...artifact.claim_limits]));
  return (
    <ReportCard intent="attention" eyebrow="limits" title="Read Before Reuse">
      <Summary text="Prototype is local evidence, not a production or deployed result." />
      <div>
        <SectionLabel>Known limitations</SectionLabel>
        {artifact.known_limitations.length === 0 ? (
          <Summary text="No limitations were reported." />
        ) : (
          <BulletList items={artifact.known_limitations} />
        )}
      </div>
      <div>
        <SectionLabel>Claim limits</SectionLabel>
        <ChipRow items={limits} />
      </div>
    </ReportCard>
  );
}

function PlanCard({ plan }: { readonly plan: PrototypePlan }) {
  return (
    <ReportCard eyebrow="plan" title="Artifact Plan">
      <Summary text={plan.preview_instructions} />
      <div>
        <SectionLabel>Planned files</SectionLabel>
        <ChipRow items={plan.files_to_create} />
      </div>
    </ReportCard>
  );
}

function Appendix({
  rawEvidence,
  resumeCommandTemplate,
}: {
  readonly rawEvidence: readonly string[];
  readonly resumeCommandTemplate: string;
}) {
  return (
    <Collapsible className="mt-8 rounded-lg border bg-card px-4 py-3">
      <CollapsibleTrigger className="text-[13px] font-medium text-muted-foreground">
        Raw evidence and resume command
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-3 flex flex-col gap-2.5 text-[13px] text-muted-foreground">
        <p className="flex flex-wrap items-baseline gap-1.5">
          <strong className="font-semibold text-foreground">Resume command.</strong>
          <Chip text={resumeCommandTemplate} />
        </p>
        <p>
          <strong className="font-semibold text-foreground">Reports.</strong>
        </p>
        <ChipRow items={rawEvidence} />
      </CollapsibleContent>
    </Collapsible>
  );
}

function filteredChoices(allowedChoices: readonly string[]): ChoiceCard[] {
  const allowed = new Set(allowedChoices);
  return CHOICES.filter((choice) => allowed.has(choice.id));
}

function relaySelectionLine(
  evidence: PrototypeVariantProviderEvidence['variants'][number] | undefined,
): string {
  if (
    evidence?.status === 'captured' &&
    evidence.provider !== undefined &&
    evidence.model !== undefined &&
    evidence.effort !== undefined
  ) {
    return `${evidence.provider}/${evidence.model} (${evidence.effort})`;
  }
  return 'No captured relay selection evidence';
}

function VariantDetails({
  review,
  verification,
  providerEvidence,
  checkpointRequestPath,
  resumeCommand,
}: {
  readonly review: PrototypeVariantReview;
  readonly verification: PrototypeVariantVerification;
  readonly providerEvidence: PrototypeVariantProviderEvidence;
  readonly checkpointRequestPath: string | undefined;
  readonly resumeCommand: string;
}) {
  const missingEvidence = [
    ...providerEvidence.missing_evidence.map((item) => `${item.variant_id}: ${item.reason}`),
    ...review.missing_evidence,
  ];
  const reports = [
    PROTOTYPE_VARIANT_AGGREGATE_PATH,
    PROTOTYPE_VARIANT_PROVIDER_EVIDENCE_PATH,
    PROTOTYPE_VARIANT_VERIFICATION_PATH,
    PROTOTYPE_VARIANT_REVIEW_PATH,
    PROTOTYPE_VARIANT_CHOICES_PATH,
    checkpointRequestPath ?? '',
  ].filter((item) => item.length > 0);
  return (
    <Collapsible className="mt-8 rounded-lg border bg-card px-5 py-4">
      <CollapsibleTrigger className="text-sm font-medium text-muted-foreground hover:text-foreground">
        Comparison evidence and resume command
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-2.5 pt-4 text-sm leading-relaxed">
        <p>
          <strong>Comparison.</strong> {t(review.comparison_summary, MAX_PROMPT_LEN)}
        </p>
        {review.strengths.length === 0 ? null : (
          <>
            <p>
              <strong>Strengths.</strong>
            </p>
            <BulletList
              items={review.strengths.map((item) => `${item.variant_id}: ${item.note}`)}
            />
          </>
        )}
        {review.risks.length === 0 ? null : (
          <>
            <p>
              <strong>Risks.</strong>
            </p>
            <BulletList items={review.risks} />
          </>
        )}
        <p>
          <strong>Verification.</strong> {t(verification.overall_status, 120)}
        </p>
        {missingEvidence.length === 0 ? null : (
          <p>
            <strong>Missing evidence.</strong> {t(missingEvidence.join('; '), MAX_PROMPT_LEN)}
          </p>
        )}
        <p className="flex flex-wrap items-baseline gap-1.5">
          <strong>Resume command.</strong>
          <Chip text={resumeCommand} />
        </p>
        <p>
          <strong>Reports.</strong>
        </p>
        <ChipRow items={reports} />
      </CollapsibleContent>
    </Collapsible>
  );
}

function variantComparisonItems(input: {
  readonly aggregate: PrototypeVariantAggregate;
  readonly providerEvidence: PrototypeVariantProviderEvidence;
  readonly choices: PrototypeVariantChoiceOptions['choices'];
  readonly recommendedChoiceId: string;
  readonly runFolder: string;
  readonly commandPrefix: string;
  readonly projectRoot?: string | undefined;
  readonly reviewAssets: PrototypeVariantVerification['review_assets'];
}): MultiVariantItem[] {
  return input.choices.map((choice) => {
    const branch = input.aggregate.branches.find((candidate) => candidate.branch_id === choice.id);
    const artifact = branch?.result_body;
    const evidence = input.providerEvidence.variants.find(
      (candidate) => candidate.variant_id === choice.id,
    );
    const entryPoints = artifact?.entry_points ?? choice.entry_points;
    const createdFiles = artifact?.created_files ?? [];
    const artifactEvidence = artifact?.evidence ?? [];
    const risks = artifact?.known_limitations ?? [];
    const providerLine =
      evidence?.status === 'captured'
        ? relaySelectionLine(evidence)
        : 'No captured relay selection evidence';
    const reviewAsset = input.reviewAssets.find((group) => group.root === choice.variant_root);
    const preview =
      reviewAsset === undefined
        ? { status: 'unavailable' as const }
        : previewForEntryPoints({
            entryPoints,
            runFolder: input.runFolder,
            projectRoot: input.projectRoot,
            expectedFiles: reviewAsset.files,
          });
    return {
      id: choice.id,
      label: choice.label,
      description: artifact?.summary ?? choice.description,
      recommended: choice.id === input.recommendedChoiceId,
      facts: [
        { label: 'Relay', value: providerLine },
        { label: 'Verification', value: choice.verification_status },
        { label: 'Verdict', value: branch?.verdict ?? 'not reported' },
        { label: 'Review', value: choice.review_recommendation ? 'recommended' : 'compared' },
      ],
      evidence: Array.from(new Set([...entryPoints, ...createdFiles, ...artifactEvidence])),
      risks,
      preview,
      action: {
        label: 'Choose this option',
        prompt: resumeCommandForChoice(input.runFolder, choice.id, input.commandPrefix),
        primary: true,
      },
    };
  });
}

function renderVariantCheckpoint(ctx: Parameters<HtmlProjector>[0]): string | undefined {
  if (ctx.checkpoint === undefined) return undefined;
  const aggregate = load(ctx.readJsonRunRelative, PROTOTYPE_VARIANT_AGGREGATE_PATH, (raw) =>
    PrototypeVariantAggregate.safeParse(raw),
  );
  const providerEvidence = load(
    ctx.readJsonRunRelative,
    PROTOTYPE_VARIANT_PROVIDER_EVIDENCE_PATH,
    (raw) => PrototypeVariantProviderEvidence.safeParse(raw),
  );
  const verification = load(ctx.readJsonRunRelative, PROTOTYPE_VARIANT_VERIFICATION_PATH, (raw) =>
    PrototypeVariantVerification.safeParse(raw),
  );
  const review = load(ctx.readJsonRunRelative, PROTOTYPE_VARIANT_REVIEW_PATH, (raw) =>
    PrototypeVariantReview.safeParse(raw),
  );
  const choices = load(ctx.readJsonRunRelative, PROTOTYPE_VARIANT_CHOICES_PATH, (raw) =>
    PrototypeVariantChoiceOptions.safeParse(raw),
  );
  if (
    aggregate === undefined ||
    providerEvidence === undefined ||
    verification === undefined ||
    review === undefined ||
    choices === undefined
  ) {
    return undefined;
  }
  const allowed = new Set(ctx.checkpoint.allowed_choices);
  const visibleChoices = choices.choices.filter((choice) => allowed.has(choice.id));
  if (visibleChoices.length === 0) return undefined;
  const recommended =
    visibleChoices.find((choice) => choice.id === choices.recommended_variant_id) ??
    visibleChoices.find((choice) => choice.recommended) ??
    visibleChoices[0];
  if (recommended === undefined) return undefined;
  const commandPrefix = ctx.resumeCommandPrefix ?? 'circuit resume';
  const resumeCommand = `${commandPrefix} --run-folder ${shellSingleQuote(
    ctx.runFolder,
  )} --checkpoint-choice '<variant-id>'`;

  return renderMultiVariantComparisonPage({
    title: 'Prototype review',
    metaLine: `Prototype review · ${ctx.runId}`,
    headline: 'Choose a prototype direction',
    subtitle: 'Experience each local prototype, record your review notes, then choose a direction.',
    recommendation: {
      label: recommended.label,
      rationale: review.comparison_summary,
      badgeText: review.verdict === 'recommend' ? 'Recommended variant' : 'Operator choice',
      intent: review.verdict === 'recommend' ? 'positive' : 'attention',
      aside: `${providerEvidence.captured_count} relay selections captured`,
    },
    variants: variantComparisonItems({
      aggregate,
      providerEvidence,
      choices: visibleChoices,
      recommendedChoiceId: recommended.id,
      runFolder: ctx.runFolder,
      commandPrefix,
      projectRoot: ctx.projectRoot,
      reviewAssets: verification.review_assets,
    }),
    resume: {
      runFolder: ctx.runFolder,
      runId: ctx.runId,
      stepId: ctx.checkpoint.step_id,
      commandPrefix,
      attempt: ctx.checkpoint.attempt,
      requestSha256: ctx.checkpoint.request_sha256,
    },
    details: (
      <VariantDetails
        review={review}
        verification={verification}
        providerEvidence={providerEvidence}
        checkpointRequestPath={ctx.checkpoint?.request_path}
        resumeCommand={resumeCommand}
      />
    ),
    footerLeft: `circuit · prototype · ${ctx.runId}`,
    footerRight: PROTOTYPE_VARIANT_AGGREGATE_PATH,
  });
}

export const prototypeCheckpointProjector: HtmlProjector = (ctx) => {
  if (ctx.flowId !== 'prototype' || ctx.runOutcome !== 'checkpoint_waiting') return undefined;
  if (ctx.checkpoint?.step_id === 'prototype-variant-checkpoint-step') {
    return renderVariantCheckpoint(ctx);
  }
  if (ctx.checkpoint?.step_id !== 'prototype-checkpoint-step') return undefined;
  const brief = load(ctx.readJsonRunRelative, PROTOTYPE_BRIEF_PATH, (raw) =>
    PrototypeBrief.safeParse(raw),
  );
  const plan = load(ctx.readJsonRunRelative, PROTOTYPE_PLAN_PATH, (raw) =>
    PrototypePlan.safeParse(raw),
  );
  const artifact = load(ctx.readJsonRunRelative, PROTOTYPE_ARTIFACT_PATH, (raw) =>
    PrototypeArtifact.safeParse(raw),
  );
  const verification = load(ctx.readJsonRunRelative, PROTOTYPE_VERIFICATION_PATH, (raw) =>
    PrototypeVerification.safeParse(raw),
  );
  if (
    brief === undefined ||
    plan === undefined ||
    artifact === undefined ||
    verification === undefined
  ) {
    return undefined;
  }
  const choices = filteredChoices(ctx.checkpoint.allowed_choices);
  if (choices.length === 0) return undefined;
  const recommendedChoice = choices.find((choice) => choice.id === 'keep-prototype') ?? choices[0];
  if (recommendedChoice === undefined) return undefined;

  const safeDefaultId = ctx.checkpoint.safe_default_choice;
  const options: CheckpointPageOption[] = choices.map((choice) => ({
    id: choice.id,
    label: choice.label,
    description: choice.description,
    ...(choice.id === recommendedChoice.id ? { isRecommended: true } : {}),
    ...(choice.id === safeDefaultId ? { isDefault: true } : {}),
  }));
  const defaultChoice = options.find((option) => option.id === safeDefaultId);

  const commandPrefix = ctx.resumeCommandPrefix ?? 'circuit resume';
  const resumeCommandTemplate = `${commandPrefix} --run-folder ${shellSingleQuote(
    ctx.runFolder,
  )} --checkpoint-choice '<choice>'`;
  const rawEvidence = [
    PROTOTYPE_BRIEF_PATH,
    PROTOTYPE_PLAN_PATH,
    PROTOTYPE_ARTIFACT_PATH,
    PROTOTYPE_VERIFICATION_PATH,
    ctx.checkpoint.request_path,
  ];
  const reviewAsset = verification.review_assets.find(
    (group) => group.root === artifact.prototype_root,
  );
  const artifactPreview =
    reviewAsset === undefined
      ? { status: 'unavailable' as const }
      : previewForEntryPoints({
          entryPoints: artifact.entry_points,
          runFolder: ctx.runFolder,
          projectRoot: ctx.projectRoot,
          expectedFiles: reviewAsset.files,
        });

  return renderCheckpointPage({
    meta: { flowLabel: 'Prototype', runId: ctx.runId, stepId: ctx.checkpoint.step_id },
    question: brief.objective,
    subtitle:
      'Choose whether to keep this local prototype, save it as Build input, or mark it discarded.',
    ribbon: [
      'Waiting for you',
      verification.overall_status === 'passed' ? 'Verified local artifact' : 'Verification failed',
    ],
    recommendation: {
      label: recommendedChoice.label,
      rationale: 'Safe default: keep the prototype evidence and decide on Build separately.',
    },
    options,
    artifact: {
      title: 'Prototype preview',
      description: artifact.summary,
      preview: artifactPreview,
    },
    ...(defaultChoice === undefined
      ? {}
      : { defaultChoice: { id: defaultChoice.id, label: defaultChoice.label } }),
    context: (
      <div className="grid gap-4 md:grid-cols-2">
        <ArtifactCard artifact={artifact} />
        <VerificationCard verification={verification} />
        <RiskCard artifact={artifact} brief={brief} />
        <PlanCard plan={plan} />
      </div>
    ),
    appendix: <Appendix rawEvidence={rawEvidence} resumeCommandTemplate={resumeCommandTemplate} />,
    resume: {
      runFolder: ctx.runFolder,
      commandPrefix,
      attempt: ctx.checkpoint.attempt,
      requestSha256: ctx.checkpoint.request_sha256,
    },
    footerLeft: `circuit · prototype · ${ctx.runId}`,
    footerRight: PROTOTYPE_ARTIFACT_PATH,
  });
};
