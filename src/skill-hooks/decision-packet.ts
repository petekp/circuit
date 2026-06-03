// Skill-hook decision-packet builders — pre-wired alongside ./policy.ts.
//
// Part of the deliberately forward-staged skill-hook policy layer (Phase 3.5
// of the run-centered migration). No live caller yet by design; the schema half
// (Config.skill_hooks, Step.skill_hooks, the 'skill-hook-ask' decision reason)
// ships today. Oracle: tests/contracts/skill-hook-policy-schema.test.ts.
// See ./policy.ts for the full lifecycle note. Intentionally staged, not dead.

import { RunId } from '../schemas/ids.js';
import type { Ref } from '../schemas/ref.js';
import {
  RunDecisionPacket,
  type RunDecisionPacket as RunDecisionPacketValue,
} from '../schemas/run-envelope.js';
import type { RunSkillHookEvent } from '../schemas/skill-hook.js';

export interface BuildSkillHookDecisionPacketInput {
  readonly runId: string;
  readonly event: RunSkillHookEvent;
  readonly artifactRefs?: readonly Ref[];
}

export function buildSkillHookAskDecisionPacket(
  input: BuildSkillHookDecisionPacketInput,
): RunDecisionPacketValue {
  if (input.event.policy.mode !== 'ask' || input.event.decision_packet_id === undefined) {
    throw new Error('skill-hook ask packets require an ask event with decision_packet_id');
  }

  return RunDecisionPacket.parse({
    schema: 'run.decision-packet@v0',
    decision_id: input.event.decision_packet_id,
    reason: 'skill-hook-ask',
    prompt: `Use configured skills for ${input.event.hook}?`,
    choices: [
      {
        id: 'use-skills',
        label: 'Use skills',
        effect: 'Prepare the skills configured for this Skill Hook.',
      },
      {
        id: 'skip-skills',
        label: 'Skip skills',
        effect: 'Continue without preparing these skills.',
      },
    ],
    resume_target: {
      kind: 'run-envelope',
      run_id: RunId.parse(input.runId),
    },
    artifact_refs: [...(input.artifactRefs ?? [])],
  });
}

export function buildStrictSkillUnavailableDecisionPacket(
  input: BuildSkillHookDecisionPacketInput,
): RunDecisionPacketValue {
  if (
    input.event.policy.mode === 'none' ||
    input.event.policy.strict !== true ||
    input.event.decision_packet_id === undefined ||
    input.event.unavailable_skills === undefined ||
    input.event.unavailable_skills.length === 0
  ) {
    throw new Error(
      'strict unavailable-skill packets require strict policy, unavailable skills, and decision_packet_id',
    );
  }

  return RunDecisionPacket.parse({
    schema: 'run.decision-packet@v0',
    decision_id: input.event.decision_packet_id,
    reason: 'strict-skill-unavailable',
    prompt: `Configured skills are unavailable for ${input.event.hook}.`,
    choices: [
      {
        id: 'continue-without-skill',
        label: 'Continue',
        effect: 'Continue without the unavailable skills and record that they did not run.',
      },
      {
        id: 'stop',
        label: 'Stop',
        effect: 'Stop so the skill installation or policy can be fixed first.',
      },
    ],
    resume_target: {
      kind: 'run-envelope',
      run_id: RunId.parse(input.runId),
    },
    artifact_refs: [...(input.artifactRefs ?? [])],
  });
}
