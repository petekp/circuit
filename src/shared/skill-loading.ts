import type { LayeredConfig } from '../schemas/config.js';
import type { CompiledFlowId, SkillId, SkillSlotId } from '../schemas/ids.js';
import type { ResolvedSelection } from '../schemas/selection-policy.js';
import type { SkillSlot } from '../schemas/skill.js';
import type { LoadedSkillCause, LoadedSkillEvidence } from '../schemas/trace-entry.js';
import { type UserSkillRegistry, createUserSkillRegistry } from './user-skill-registry.js';

export interface LoadedRelaySkill extends LoadedSkillEvidence {
  readonly body: string;
}

interface ResolveLoadedRelaySkillsInput {
  readonly flowId: CompiledFlowId;
  readonly stepId: string;
  readonly skillSlots: readonly SkillSlot[];
  readonly resolvedSelection: ResolvedSelection;
  readonly configLayers?: readonly LayeredConfig[];
  readonly registry?: UserSkillRegistry;
  // Skill ids a skill-hook `auto` policy injected into this step (the actuator).
  // Loaded after flow selection and slot bindings, slot-less and deduped against
  // both, so a skill already present via selection or a binding is not loaded
  // twice. See src/skill-hooks/injection.ts.
  readonly injectedSkillIds?: readonly SkillId[];
}

export function resolveSkillBindingsForFlow(
  flowId: CompiledFlowId,
  configLayers: readonly LayeredConfig[] = [],
): ReadonlyMap<string, SkillId> {
  const globalBindings = new Map<string, SkillId>();
  const flowBindings = new Map<string, SkillId>();
  const flowKey = flowId as unknown as string;

  for (const layer of configLayers) {
    for (const [slot, skill] of Object.entries(layer.config.skills.bindings)) {
      if (skill === undefined) continue;
      globalBindings.set(slot, skill);
    }

    const circuit = layer.config.flows[flowKey as CompiledFlowId];
    if (circuit === undefined) continue;
    for (const [slot, skill] of Object.entries(circuit.skill_bindings)) {
      if (skill === undefined) continue;
      flowBindings.set(slot, skill);
    }
  }

  return new Map([...globalBindings, ...flowBindings]);
}

export function resolveLoadedRelaySkills(
  input: ResolveLoadedRelaySkillsInput,
): readonly LoadedRelaySkill[] {
  const registry = input.registry ?? createUserSkillRegistry();
  const bindings = resolveSkillBindingsForFlow(input.flowId, input.configLayers);
  const loaded: LoadedRelaySkill[] = [];
  const seen = new Set<string>();

  // `cause` is stamped here, at load time, where the source is known for
  // certain: the selection loop knows it loaded a declared default, the slot
  // loop knows it bound a slot, the injection loop knows it actuated a hook. A
  // later reader cannot recover that distinction from id and path alone, so we
  // record it now and let the trace schema verify it (slot <=> binding) and the
  // run schema cross-check skill-hook causes against real hook events.
  const addSkill = (id: SkillId, cause: LoadedSkillCause, slot?: SkillSlotId) => {
    const key = id as unknown as string;
    if (seen.has(key)) return;
    let resolved: ReturnType<UserSkillRegistry['resolve']>;
    try {
      resolved = registry.resolve(id);
    } catch (err) {
      const slotText = slot === undefined ? '' : ` for slot '${slot as unknown as string}'`;
      throw new Error(
        `relay step '${input.stepId}' selected skill '${key}'${slotText} could not be resolved:\n${(err as Error).message}`,
      );
    }

    seen.add(key);
    loaded.push({
      id: resolved.entry.id,
      cause,
      ...(slot === undefined ? {} : { slot }),
      path: resolved.entry.path,
      sha256: resolved.entry.sha256,
      bytes: resolved.entry.bytes,
      body: resolved.body,
    });
  };

  for (const id of input.resolvedSelection.skills) {
    addSkill(id, 'selection');
  }

  for (const slot of input.skillSlots) {
    const skill = bindings.get(slot.id as unknown as string);
    if (skill === undefined) continue;
    addSkill(skill, 'binding', slot.id);
  }

  // Skill-hook injected skills come last and carry no slot: they are run-time
  // actuation, not a declared selection or slot binding. `seen` dedup means an
  // injected skill that the step already loads (via selection or a binding) is
  // not added again.
  for (const id of input.injectedSkillIds ?? []) {
    addSkill(id, 'skill-hook');
  }

  return loaded;
}
