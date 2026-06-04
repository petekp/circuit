// Skill-hook decision-packet builder.
//
// buildStrictSkillUnavailableDecisionPacket turns a strict `auto` policy whose
// configured skill is unavailable into the operator decision the actuator gates
// on (while that decision is pending the actuator injects nothing). Oracle:
// tests/contracts/skill-hook-policy-schema.test.ts. See ./policy.ts for how the
// decision_packet_id is set.

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
