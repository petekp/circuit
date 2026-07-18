import { createHash } from 'node:crypto';
import { isAbsolute, relative } from 'node:path';
import { VerificationCommand } from '../../../schemas/verification.js';
import { CONTROL_PLANE_PROTOTYPES_DIR } from '../../../shared/control-plane-paths.js';
import { harvestGoalCommandCandidates } from '../../../shared/goal-commands.js';
import type {
  ComposeBuildContext,
  ComposeBuilder,
} from '../../registries/compose-writers/types.js';
import { PrototypeBrief } from '../reports.js';

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, '/');
}

function isInsideOrSame(relativePath: string): boolean {
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function hashRunFolder(runFolder: string): string {
  return createHash('sha256').update(runFolder).digest('hex').slice(0, 12);
}

function prototypeRoot(context: ComposeBuildContext): string {
  if (context.projectRoot !== undefined) {
    const relativeRunFolder = relative(context.projectRoot, context.runFolder);
    if (isInsideOrSame(relativeRunFolder) && relativeRunFolder.length > 0) {
      return `${normalizeSlashes(relativeRunFolder)}/prototype-files`;
    }
  }
  return `${CONTROL_PLANE_PROTOTYPES_DIR}/${hashRunFolder(context.runFolder)}`;
}

function cleanGoal(goal: string): string {
  return goal.replace(/^\s*prototype\s*:\s*/i, '').trim() || goal.trim();
}

// Goal-stated commands become verification candidates so a spike goal that
// names its own proof ("pnpm typecheck exits 0") is verified against exactly
// that proof. Each candidate must still satisfy VerificationCommand (no shell
// binaries, project-relative cwd); candidates that do not are dropped rather
// than failing the brief.
function goalVerificationCandidates(goal: string): VerificationCommand[] {
  const candidates: VerificationCommand[] = [];
  for (const [index, candidate] of harvestGoalCommandCandidates(goal).entries()) {
    const parsed = VerificationCommand.safeParse({
      id: `goal-command-${index + 1}`,
      cwd: '.',
      argv: [...candidate.argv],
      timeout_ms: 600_000,
      max_output_bytes: 200_000,
      env: {},
    });
    if (parsed.success) candidates.push(parsed.data);
  }
  return candidates;
}

export const prototypeBriefComposeBuilder: ComposeBuilder = {
  resultSchemaName: 'prototype.brief@v1',
  build(context: ComposeBuildContext): unknown {
    const objective = cleanGoal(context.goal);
    const root = prototypeRoot(context);
    return PrototypeBrief.parse({
      objective,
      prototype_scope: `Create a small, disposable artifact under ${root} that makes the requested idea inspectable.`,
      out_of_scope: [
        'Production application code outside prototype_root',
        'Generated host plugin packages',
        'Deployment, branch preview, provider, or model claims',
      ],
      target_user: 'Operator inspecting whether the idea is worth carrying into Build',
      success_criteria: [
        'The prototype files exist under prototype_root',
        'At least one entry point is reported',
        'The result names evidence and limitations honestly',
      ],
      prototype_root: root,
      verification_command_candidates: goalVerificationCandidates(context.goal),
      claim_limits: ['not production', 'not deployed', 'not production-ready'],
    });
  },
};
