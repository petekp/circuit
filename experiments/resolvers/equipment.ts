// Resolver #2 — equipment (the skill-injection chooser).
//
// The second instance from the next-phase build brief, built per
// e2-equipment-scope-spec.md. Given a work step's work-type (its relay role plus
// the task's domain tags) it selects a set of skills to attach to the step's
// `skill_slots` — the field that already exists on the schematic step
// (src/schemas/flow-schematic.ts) and is carried to the compiled step
// (src/schemas/step.ts), then injected at relay dispatch
// (src/shared/skill-loading.ts). The resolver rides that existing manifest field;
// it adds no engine branch.
//
// Built to the SAME shape as the structure resolver (decision-layer-exploration.md
// §7) without sharing a type yet: `(work-type context, prior choices) -> one
// choice for the equipment axis`, a comparable resolution record, assembly-time
// binding, and — load-bearing here — an explicit enforced-vs-trusted verdict.
//
// THE ENFORCED-VS-TRUSTED DECISION (the brief asks for it explicit + tested):
// today's `skill_slots` is ADDITIVE injection — skill-loading.ts only *adds*
// skills to the worker; there is no allow-list and no withhold. So an injected
// skill set is a SUGGESTION the worker is offered, not the worker's ONLY tools.
// The resolution is therefore honestly `trusted`. Real enforcement (the injected
// kit is the upper bound on reads/tools) needs the `equipment_scope` field that
// primitive 3b records as ABSENT — so a caller that asks for `enforced` gets a
// resolution DOWNGRADED to `trusted` with a recorded finding, rather than a false
// promise.
import type { FlowSchematicAssemblySpec } from '../../src/flows/assemble-flow-schematic.js';
import type { BlockStepUse } from '../../src/flows/block-step-expansion.js';
import type { SkillSlot } from '../../src/schemas/skill.js';

// A step's work-type — the "task context" half of the call shape for this axis.
// `role` is the relay identity; `domain_tags` are the task's technology signals
// (e.g. 'react', 'sql') the chooser maps to domain skills.
export interface EquipmentStepContext {
  readonly step_id: string;
  readonly role: 'researcher' | 'implementer' | 'reviewer';
  readonly domain_tags: readonly string[];
}

// axis -> choice already made this run. Equipment is resolved per work step after
// structure, so a caller may pass the structure choice here; the thin cut does
// not branch on it, but the argument keeps the two resolvers' shapes identical.
export type PriorChoices = Readonly<Record<string, string>>;

// What the caller wants the injection to MEAN. `trusted` = offer the skills;
// `enforced` = make them the step's only kit. The substrate can only honor
// `trusted` today (see the downgrade below).
export type EquipmentEnforcement = 'enforced' | 'trusted';

// One equipment resolution — the comparable evidence record. Field-aligned with
// StructureResolution where it can be (axis/choice/binding_time/enforcement/
// rationale); the extra fields are the enforced-vs-trusted honesty.
export interface EquipmentResolution {
  readonly axis: 'equipment';
  readonly step_id: string;
  // The chosen kit, ready to drop onto the step's skill_slots.
  readonly choice: readonly SkillSlot[];
  readonly binding_time: 'assembly';
  // What the caller asked for vs what the substrate can actually honor.
  readonly requested_enforcement: EquipmentEnforcement;
  readonly enforcement: 'trusted';
  // True when the caller asked for `enforced` but got `trusted` — the substrate
  // gap made explicit instead of silently swallowed.
  readonly downgraded: boolean;
  // The substrate-gap explanation when downgraded; null otherwise.
  readonly finding: string | null;
  readonly rationale: string;
}

// SkillSlot.id is a branded string (SkillSlotId); this brands a plain id so the
// tables below read as literals.
const slot = (id: string, description: string): SkillSlot => ({
  id: id as SkillSlot['id'],
  description,
});

// The base skill each relay role is given, by work-type. Thin first cut: a fixed
// per-role skill plus whatever the domain tags add.
const ROLE_BASE_SKILL: Record<EquipmentStepContext['role'], SkillSlot> = {
  researcher: slot('codebase-navigator', 'Locate and read the code paths a task touches.'),
  implementer: slot('implementation-patterns', 'Apply the smallest safe change idioms.'),
  reviewer: slot('review-rubric', 'Check a change against correctness and scope.'),
};

// Map a domain tag to a skill slot. The "detect a work-type tag -> attach a
// declared skill set" rule the brief calls for, kept deliberately small.
const DOMAIN_SKILL: Record<string, SkillSlot> = {
  react: slot('react-expert', 'React component, hook, and JSX patterns.'),
  typescript: slot('typescript-strict', 'Strict-mode TypeScript types and inference.'),
  sql: slot('sql-schema', 'SQL schema, query, and migration patterns.'),
  database: slot('sql-schema', 'SQL schema, query, and migration patterns.'),
  css: slot('css-layout', 'CSS layout, spacing, and responsive patterns.'),
};

function selectSkills(ctx: EquipmentStepContext): SkillSlot[] {
  const slots: SkillSlot[] = [ROLE_BASE_SKILL[ctx.role]];
  const seen = new Set<string>([slots[0]?.id as unknown as string]);
  for (const tag of ctx.domain_tags) {
    const skill = DOMAIN_SKILL[tag.toLowerCase()];
    if (skill === undefined) continue;
    const id = skill.id as unknown as string;
    if (seen.has(id)) continue;
    seen.add(id);
    slots.push(skill);
  }
  return slots;
}

// The chooser: (work-type context, prior choices) -> the equipment choice for one
// step. `requested` defaults to `trusted` — the only thing the substrate can
// honor; asking for `enforced` returns a downgraded resolution with a finding.
export function resolveEquipment(
  ctx: EquipmentStepContext,
  options: { readonly requested?: EquipmentEnforcement; readonly prior?: PriorChoices } = {},
): EquipmentResolution {
  const requested = options.requested ?? 'trusted';
  const choice = selectSkills(ctx);
  const ids = choice.map((s) => s.id as unknown as string).join(', ');
  const downgraded = requested === 'enforced';
  return {
    axis: 'equipment',
    step_id: ctx.step_id,
    choice,
    binding_time: 'assembly',
    requested_enforcement: requested,
    enforcement: 'trusted',
    downgraded,
    finding: downgraded
      ? 'Requested enforced equipment, but skill_slots is additive injection with no withhold/allow-list. Enforcement needs the equipment_scope field (reads/tools/write_tier), which primitive 3b records as absent. Resolution downgraded to trusted.'
      : null,
    rationale: `Attach [${ids}] to ${ctx.role} step '${ctx.step_id}' (trusted: offered to the worker, not enforced as its only kit).`,
  };
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// Materialize equipment resolutions onto a seed assembly spec: set each resolved
// step's `skillSlots` (the BlockStepUse authoring field that the assembler
// expands to `skill_slots`). Rides the existing manifest field — no engine
// branch. Steps with no resolution are left untouched.
export function applyEquipment(
  seed: FlowSchematicAssemblySpec,
  resolutions: readonly EquipmentResolution[],
): FlowSchematicAssemblySpec {
  const byStep = new Map(resolutions.map((r) => [r.step_id, r]));
  const items = seed.items.map((item): BlockStepUse => {
    const resolution = byStep.get(item.id as unknown as string);
    if (resolution === undefined) return item;
    return {
      ...clone(item),
      skillSlots: [...resolution.choice] as unknown as BlockStepUse['skillSlots'],
    };
  });
  return { ...clone(seed), items };
}

// Resolve equipment for every relay step in a spec from one set of task domain
// tags, returning the resolutions and the equipped spec in one call. The natural
// way the lab measures the resolver: equip a flow, re-score it, watch
// work-step-without-skill-slots fall.
export function resolveAndApplyEquipment(
  seed: FlowSchematicAssemblySpec,
  domainTags: readonly string[],
  options: { readonly requested?: EquipmentEnforcement } = {},
): { readonly resolutions: EquipmentResolution[]; readonly spec: FlowSchematicAssemblySpec } {
  const resolutions: EquipmentResolution[] = [];
  for (const item of seed.items) {
    const execution = item.execution;
    if (execution === undefined || execution.kind !== 'relay') continue;
    const role = execution.role as EquipmentStepContext['role'];
    resolutions.push(
      resolveEquipment(
        { step_id: item.id as unknown as string, role, domain_tags: domainTags },
        { requested: options.requested ?? 'trusted' },
      ),
    );
  }
  return { resolutions, spec: applyEquipment(seed, resolutions) };
}
