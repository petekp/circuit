// Resolver #2 — equipment (the skill-injection chooser).
//
// The second decision-layer resolver, promoted from the offline flow lab
// (experiments/resolvers/equipment.ts) into src. Given a work step's work-type
// (its relay role plus the task's domain tags) it selects a set of skills to
// attach to the step's `skill_slots` — the manifest field that already exists on
// the schematic step (src/schemas/flow-schematic.ts) and is carried to the
// compiled step (src/schemas/step.ts), then injected at relay dispatch
// (src/shared/skill-loading.ts). The resolver rides that existing field; it adds
// no engine branch and introduces no new execution kind.
//
// Built to the SAME four-part shape as the structure resolver (resolvers/
// structure.ts): a uniform `(context, prior) -> one resolution for one axis`
// call, a comparable Resolution record (axis / choice / binding_time /
// enforcement / rationale), a materializer `applyEquipment(seed, resolutions) ->
// FlowSchematicAssemblySpec`, and a one-call `resolveAndApplyEquipment(...)`.
// Pure: imports only public flow types, no engine dependency.
//
// The shared shape is RECORDED, not extracted — see
// docs/ideas/resolver-shared-shape.md. The equipment instance deliberately
// DIVERGES from structure in three load-bearing ways (these are why a premature
// `Resolver<T>` type would be wrong):
//
//   1. Scope is PER WORK STEP. Structure resolves one grain per flow; equipment
//      resolves one kit per relay step, so a flow yields MANY resolutions.
//   2. Enforcement is TRUSTED ONLY. Today's `skill_slots` is ADDITIVE injection —
//      skill-loading.ts only *adds* skills to the worker; there is no allow-list
//      and no withhold. An injected kit is OFFERED to the worker, not its only
//      tools. So the resolution is honestly `trusted`.
//   3. A DOWNGRADE / finding channel. Real enforcement (the kit is the upper
//      bound on the worker's tools) needs the `equipment_scope` field — which
//      this thin first cut does NOT set. A caller that asks for `enforced` gets a
//      resolution DOWNGRADED to `trusted` with a recorded finding (the
//      #89 honest-downgrade model), never a false promise.
import type { SkillSlot } from '../../schemas/skill.js';
import type { FlowSchematicAssemblySpec } from '../assemble-flow-schematic.js';
import type { BlockStepUse } from '../block-step-expansion.js';

// A step's work-type — the "context" half of the uniform call shape for this
// axis. `role` is the relay identity; `domain_tags` are the task's technology
// signals (e.g. 'react', 'sql') the chooser maps to domain skills.
export interface EquipmentStepContext {
  readonly step_id: string;
  readonly role: 'researcher' | 'implementer' | 'reviewer';
  readonly domain_tags: readonly string[];
}

// The "prior choices" half of the call shape: axis -> choice already made this
// run. Equipment is resolved per work step after structure, so a caller may pass
// the structure choice here; the thin cut does not branch on it, but the
// argument keeps the two resolvers' call shapes identical.
export type PriorChoices = Readonly<Record<string, string>>;

// What the caller wants the injection to MEAN. `trusted` = offer the skills;
// `enforced` = make them the step's only kit. The substrate can only honor
// `trusted` today (see the downgrade below).
export type EquipmentEnforcement = 'enforced' | 'trusted';

// One equipment resolution — the comparable evidence record. Field-aligned with
// StructureResolution where it can be (axis / choice / binding_time /
// enforcement / rationale); the extra fields (step_id, requested_enforcement,
// downgraded, finding) are the per-step scope and the enforced-vs-trusted
// honesty that this axis needs and structure does not.
export interface EquipmentResolution {
  readonly axis: 'equipment';
  // Per-step scope: which step this kit is for.
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

// SkillSlot.id is a branded string (SkillSlotId); this brands a plain slug so the
// tables below read as literals. The ids are slugs the SkillSlotId pattern
// accepts.
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
// declared skill set" rule, kept deliberately small.
const DOMAIN_SKILL: Record<string, SkillSlot> = {
  react: slot('react-expert', 'React component, hook, and JSX patterns.'),
  typescript: slot('typescript-strict', 'Strict-mode TypeScript types and inference.'),
  sql: slot('sql-schema', 'SQL schema, query, and migration patterns.'),
  database: slot('sql-schema', 'SQL schema, query, and migration patterns.'),
  css: slot('css-layout', 'CSS layout, spacing, and responsive patterns.'),
};

function selectSkills(ctx: EquipmentStepContext): SkillSlot[] {
  const base = ROLE_BASE_SKILL[ctx.role];
  const slots: SkillSlot[] = [base];
  const seen = new Set<string>([base.id as unknown as string]);
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

// The substrate-gap finding, recorded whenever a caller asks for `enforced` and
// gets `trusted`. Names the missing field so the downgrade is legible, not a
// silent swallow.
const ENFORCEMENT_DOWNGRADE_FINDING =
  'Requested enforced equipment, but skill_slots is additive injection with no ' +
  'withhold/allow-list — the kit is offered to the worker, not imposed as its ' +
  'only tools. Real enforcement needs the equipment_scope field (tool allow-list ' +
  '+ write-tier), which this resolver does not set. Resolution downgraded to trusted.';

// The chooser: (work-type context, options) -> the equipment choice for one
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
    finding: downgraded ? ENFORCEMENT_DOWNGRADE_FINDING : null,
    rationale: `Attach [${ids}] to ${ctx.role} step '${ctx.step_id}' (trusted: offered to the worker, not enforced as its only kit).`,
  };
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// Materialize equipment resolutions onto a seed assembly spec: set each resolved
// step's `skillSlots` (the BlockStepUse authoring field the assembler expands to
// `skill_slots`). Rides the existing manifest field — no engine branch. Steps
// with no resolution are left untouched. Mirrors structure's `applyStructure`:
// it produces a `FlowSchematicAssemblySpec` the existing assembler eats.
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

// One call: resolve equipment for every relay step in a spec from one set of
// task domain tags, returning the per-step resolutions and the equipped spec.
// The per-step scope is visible here — one resolution per relay step, unlike
// structure's single per-flow resolution.
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
