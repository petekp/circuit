// Build checkpoint HTML projector.
//
// Renders only while Build is waiting at its checkpoint. The packet data stays
// in build.brief@v1; this projector owns only the visual arrangement. The page
// shape (ribbon, recommendation, options, do-nothing strip, resume commands)
// comes from the shared checkpoint renderer; Build contributes its context
// cards (artifact, salience, risk, proof) and the raw-evidence appendix.

import {
  type CheckpointPageOption,
  renderCheckpointPage,
  shellSingleQuote,
} from '../../../shared/html/checkpoint-page.js';
import { card, chip } from '../../../shared/html/components.js';
import { MAX_BULLET_LEN, escapeHtml, truncate } from '../../../shared/html/page.js';
import type { HtmlProjector, JsonObject } from '../../../shared/html/projector.js';
import {
  BuildBrief,
  type BuildCheckpointPacket,
  type BuildCheckpointPacketChoice,
} from '../reports.js';

const BUILD_BRIEF_PATH = 'reports/build/brief.json';

function bulletList(items: readonly string[]): string {
  return `<ul class="tradeoffs">
          ${items.map((item) => `<li>${escapeHtml(truncate(item, MAX_BULLET_LEN))}</li>`).join('\n          ')}
        </ul>`;
}

function commandText(command: { readonly argv: readonly string[]; readonly cwd: string }): string {
  return `${command.cwd}$ ${command.argv.join(' ')}`;
}

function renderCommandChips(
  commands: readonly { readonly argv: readonly string[]; readonly cwd: string }[],
): string {
  return `<div class="evidence">
          ${commands.map((command) => chip(commandText(command))).join('\n          ')}
        </div>`;
}

function renderArtifactCard(brief: BuildBrief, packet: BuildCheckpointPacket): string {
  const bodyHtml = `      <p class="summary">${escapeHtml(packet.artifact.preview)}</p>
      <div>
        <p class="section-label">Scope</p>
        <p class="summary">${escapeHtml(packet.artifact.scope)}</p>
      </div>
      <div>
        <p class="section-label">Success bar</p>
        ${bulletList(packet.artifact.success_criteria)}
      </div>`;
  return card({
    intent: 'info',
    eyebrow: packet.artifact.title,
    title: brief.objective,
    bodyHtml,
  });
}

function renderProofCard(packet: BuildCheckpointPacket): string {
  const bodyHtml = `      <p class="summary">${escapeHtml(packet.proof.summary)}</p>
      <div>
        <p class="section-label">Planned checks</p>
        ${renderCommandChips(packet.proof.commands)}
      </div>
      <div>
        <p class="section-label">Proof state</p>
        ${bulletList(packet.proof.evidence)}
      </div>`;
  return card({
    intent: packet.proof.status === 'missing' ? 'attention' : 'neutral',
    eyebrow: packet.proof.status,
    title: 'Proof',
    bodyHtml,
  });
}

function renderRiskCard(packet: BuildCheckpointPacket): string {
  const bodyHtml = `      <p class="summary">${escapeHtml(packet.risk.summary)}</p>
      <div>
        <p class="section-label">Tradeoffs</p>
        ${bulletList(packet.risk.tradeoffs)}
      </div>`;
  return card({
    intent: 'attention',
    eyebrow: 'manager judgment',
    title: 'Risk',
    bodyHtml,
  });
}

function renderSalienceCard(packet: BuildCheckpointPacket): string {
  const bodyHtml = `      <p class="summary">${escapeHtml(packet.salience.summary)}</p>
      <div>
        <p class="section-label">Why now</p>
        ${bulletList(packet.salience.why_now)}
      </div>
      <div>
        <p class="section-label">Stays internal</p>
        ${bulletList(packet.salience.hidden_routine_work)}
      </div>`;
  return card({
    intent: 'neutral',
    eyebrow: 'salience',
    title: 'Why this needs you',
    bodyHtml,
  });
}

function filteredChoices(
  packetChoices: readonly BuildCheckpointPacketChoice[],
  allowedChoices: readonly string[],
): BuildCheckpointPacketChoice[] {
  const allowed = new Set(allowedChoices);
  return packetChoices.filter((choice) => allowed.has(choice.id));
}

function loadBrief(
  readJsonRunRelative: (relPath: string) => JsonObject | undefined,
): BuildBrief | undefined {
  const raw = readJsonRunRelative(BUILD_BRIEF_PATH);
  const parsed = BuildBrief.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export const buildCheckpointProjector: HtmlProjector = (ctx) => {
  if (ctx.flowId !== 'build' || ctx.runOutcome !== 'checkpoint_waiting') return undefined;
  if (ctx.checkpoint === undefined) return undefined;
  const brief = loadBrief(ctx.readJsonRunRelative);
  if (brief === undefined) return undefined;

  const packet = brief.checkpoint_packet;
  if (packet === undefined) return undefined;
  const choices = filteredChoices(packet.choices, ctx.checkpoint.allowed_choices);
  if (choices.length === 0) return undefined;
  const recommendedChoice =
    choices.find((choice) => choice.id === packet.recommendation.choice_id) ?? choices[0];
  if (recommendedChoice === undefined) return undefined;

  const safeDefaultId = ctx.checkpoint.safe_default_choice;
  const options: CheckpointPageOption[] = choices.map((choice) => ({
    id: choice.id,
    label: choice.label,
    description: choice.description,
    ...(choice.id === recommendedChoice.id ? { isRecommended: true } : {}),
    ...(choice.id === safeDefaultId ? { isDefault: true } : {}),
    extraHtml: `      <div>
        <p class="section-label">Executable route</p>
        <div class="evidence">
          ${chip(`${choice.route.key} -> ${choice.route.target}`)}
        </div>
      </div>`,
  }));
  const defaultChoice = options.find((option) => option.id === safeDefaultId);

  const contextHtml = `  <div class="grid">
${renderArtifactCard(brief, packet)}

${renderSalienceCard(packet)}

${renderRiskCard(packet)}

${renderProofCard(packet)}
  </div>`;

  const resumeCommandTemplate = `circuit resume --run-folder ${shellSingleQuote(
    ctx.runFolder,
  )} --checkpoint-choice '<choice>'`;
  const rawEvidence = [
    BUILD_BRIEF_PATH,
    packet.internal.request_path,
    packet.internal.response_path,
    ...packet.internal.raw_evidence,
    ctx.checkpoint.request_path,
  ];
  const appendixHtml = `  <details>
    <summary>Raw evidence and resume command</summary>
    <div class="body">
      <p><strong>Decision.</strong> ${escapeHtml(packet.decision.question)}</p>
      <p><strong>Resume command.</strong> <code>${escapeHtml(resumeCommandTemplate)}</code></p>
      <p><strong>Reports.</strong></p>
      <div class="evidence">
        ${rawEvidence.map((item) => chip(item)).join('\n        ')}
      </div>
    </div>
  </details>`;

  return renderCheckpointPage({
    meta: { flowLabel: 'Build', runId: ctx.runId, stepId: ctx.checkpoint.step_id },
    question: brief.objective,
    subtitle: `${packet.decision.question} ${packet.decision.operator_judgment}`,
    ribbon: [
      'Waiting for you',
      ...(ctx.checkpoint.depth === undefined ? [] : [`Depth ${ctx.checkpoint.depth}`]),
      `Proof ${packet.proof.status}`,
    ],
    recommendation: {
      label: packet.recommendation.label,
      rationale: packet.recommendation.rationale,
    },
    options,
    ...(defaultChoice === undefined
      ? {}
      : { defaultChoice: { id: defaultChoice.id, label: defaultChoice.label } }),
    contextHtml,
    appendixHtml,
    resume: { runFolder: ctx.runFolder },
    footerLeft: `circuit · build · ${ctx.runId}`,
    footerRight: BUILD_BRIEF_PATH,
  });
};
