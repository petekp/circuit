import { z } from 'zod';

/**
 * EquipmentScope — the declared per-step "equipment" field for the tools axis.
 *
 * Equipment scope makes "how much capability a worker is given" a declared
 * field on a step rather than an accident of which flow you picked. This field
 * governs the TOOLS sub-axis (the skills sub-axis rides the existing
 * `skill_slots` field). It is authored manifest-first on the schematic step and
 * compiled onto the runtime step, exactly like `skill_slots` — the engine reads
 * it off the step, never from a catalog keyed by flow id.
 *
 * See docs/ideas/e2-equipment-scope-spec.md (the design) and
 * docs/ideas/equipment-scope-build-brief.md (the build brief).
 */

// A tool a worker may be granted (e.g. "Read", "Edit", "Bash"). Kept as a
// permissive non-empty string: the connector layer owns the concrete tool
// vocabulary per host, and equipment scope only needs to carry the author's
// declared list. The runtime maps these names to a connector's native tool
// surface when it enforces them.
export const EquipmentToolName = z.string().min(1);
export type EquipmentToolName = z.infer<typeof EquipmentToolName>;

// An explicit allow-list: the worker is scoped to exactly these tools. Rejects
// an empty list (an empty scope is a contradiction — express "no restriction"
// with the literal "full") and duplicate entries (an authoring slip).
export const EquipmentToolAllowList = z
  .object({
    allow: z.array(EquipmentToolName).min(1),
  })
  .strict()
  .superRefine((scope, ctx) => {
    const seen = new Set<string>();
    for (const [index, tool] of scope.allow.entries()) {
      if (seen.has(tool)) {
        ctx.addIssue({
          code: 'custom',
          path: ['allow', index],
          message: `duplicate tool '${tool}'`,
        });
      }
      seen.add(tool);
    }
  });
export type EquipmentToolAllowList = z.infer<typeof EquipmentToolAllowList>;

// The capability set a step's worker is scoped to.
//   "full"          — today's implicit default: the worker keeps the
//                     connector's full tool surface (no restriction).
//   { allow: [...] } — the worker is scoped to exactly this tool list.
export const EquipmentToolScope = z.union([z.literal('full'), EquipmentToolAllowList]);
export type EquipmentToolScope = z.infer<typeof EquipmentToolScope>;

// Whether the declared tool scope is merely offered to the worker (trusted) or
// actually restricts what the worker can invoke at the write tier (enforced).
//
//   "trusted"  — the safe default. The scope is rendered to the worker as
//                guidance; the substrate reports it honestly as not-enforced.
//   "enforced" — the scope is a real boundary. Honorable only where the
//                connector can restrict tools; on a connector that cannot, the
//                runtime downgrades the binding to trusted and records a finding.
//                Never displayed as enforced when it was downgraded.
export const EquipmentEnforcement = z.enum(['trusted', 'enforced']);
export type EquipmentEnforcement = z.infer<typeof EquipmentEnforcement>;

export const EquipmentScope = z
  .object({
    tools: EquipmentToolScope.default('full'),
    enforcement: EquipmentEnforcement.default('trusted'),
  })
  .strict()
  .superRefine((scope, ctx) => {
    // Enforcing "full" is a contradiction: there is nothing to restrict to.
    // An enforced binding must name the tools it restricts the worker to.
    if (scope.enforcement === 'enforced' && scope.tools === 'full') {
      ctx.addIssue({
        code: 'custom',
        path: ['enforcement'],
        message:
          'enforced equipment scope requires an explicit tools allow-list (there is nothing to restrict when tools is "full")',
      });
    }
  });
export type EquipmentScope = z.infer<typeof EquipmentScope>;

// The value an absent field is equivalent to: the connector's full tool surface,
// offered (not enforced). The compiler omits the field from compiled output when
// it carries this no-op value, so flows that declare nothing stay byte-stable.
export const DEFAULT_EQUIPMENT_SCOPE: EquipmentScope = Object.freeze({
  tools: 'full',
  enforcement: 'trusted',
});

export function isDefaultEquipmentScope(scope: EquipmentScope): boolean {
  return scope.tools === 'full' && scope.enforcement === 'trusted';
}
