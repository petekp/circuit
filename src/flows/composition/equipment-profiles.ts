import { z } from 'zod';
import { DEFAULT_EQUIPMENT_SCOPE, type EquipmentScope } from '../../schemas/equipment-scope.js';

/**
 * Equipment profiles — the closed menu of per-block tool scopes a composed flow
 * may assign.
 *
 * The composer chooses a graph of blocks, but every block ran as the same
 * do-everything worker (the connector's full tool surface). Equipment profiles
 * are the lever that makes a generated flow genuinely fitted: a "researcher"
 * step that only looks, an "implementer" step that edits, a "verifier" step that
 * runs the suite. Each profile names a fixed tool scope; the proposer picks one
 * per worker step from this list, and the composer attaches the matching
 * `equipment_scope` to the step.
 *
 * Why a closed enum on top of the permissive `EquipmentScope` schema: the
 * proposer must pick from a vocabulary it cannot get wrong (a name outside the
 * menu walls honestly and is named back so the model self-corrects), exactly
 * like the (block, execution-kind) menu. The free-string allow-list in
 * `equipment-scope.ts` stays the underlying compiled form each profile expands
 * to — this module just fixes the small set of named profiles a generated flow
 * is allowed to choose from.
 *
 * Every profile is `trusted` (offered as guidance, not hard-enforced at the
 * write tier). Trusted scopes are legal on any step, so the proposer never has
 * to reason about the implementer-only enforcement constraint when picking one.
 * The composer can OPT IN to hard `--tools` enforcement on the implementer step
 * (see `toEnforcedScope` and the composer's `enforceImplementerTools` lever):
 * that upgrade is applied only to the write-tier step, so the parse gate that
 * restricts `enforced` to implementer relays is never tripped.
 */

// The read-scope tools every profile shares: a worker can always look around.
const READ_TOOLS = ['Read', 'Grep', 'Glob'] as const;

export const EquipmentProfileId = z.enum(['read-only', 'editor', 'tester', 'full']);
export type EquipmentProfileId = z.infer<typeof EquipmentProfileId>;

export const EQUIPMENT_PROFILE_IDS = EquipmentProfileId.options;

interface EquipmentProfile {
  readonly scope: EquipmentScope;
  // One line, plain English, rendered into the proposer prompt.
  readonly purpose: string;
}

export const EQUIPMENT_PROFILES: Readonly<Record<EquipmentProfileId, EquipmentProfile>> = {
  'read-only': {
    scope: { tools: { allow: [...READ_TOOLS] }, enforcement: 'trusted' },
    purpose:
      'read, search, and list files; no edits or commands. For steps that investigate or gather context.',
  },
  editor: {
    scope: { tools: { allow: [...READ_TOOLS, 'Edit', 'Write'] }, enforcement: 'trusted' },
    purpose:
      'read, search, and edit or write files; no shell commands. For steps that change code or docs.',
  },
  tester: {
    scope: { tools: { allow: [...READ_TOOLS, 'Bash'] }, enforcement: 'trusted' },
    purpose:
      'read, search, and run commands like tests and builds; no file edits. For steps that verify.',
  },
  full: {
    scope: DEFAULT_EQUIPMENT_SCOPE,
    purpose:
      'the full tool surface (the default): read, edit, and run commands. For steps that need everything.',
  },
};

export function isEquipmentProfileId(value: unknown): value is EquipmentProfileId {
  return EquipmentProfileId.safeParse(value).success;
}

// Expand a chosen profile to the EquipmentScope the composer attaches to the
// step. A frozen-source profile must not be aliased into the spec, so each
// call returns a fresh scope object.
export function profileToScope(id: EquipmentProfileId): EquipmentScope {
  const { scope } = EQUIPMENT_PROFILES[id];
  return scope.tools === 'full'
    ? { tools: 'full', enforcement: scope.enforcement }
    : { tools: { allow: [...scope.tools.allow] }, enforcement: scope.enforcement };
}

// The enforced variant of a tightening profile scope: the same allow-list, but
// hard-enforced at the write tier (the connector restricts `--tools`) instead of
// offered as guidance. Only an allow-list can be enforced — enforcing 'full' is a
// contradiction the EquipmentScope schema rejects — so a 'full' scope is returned
// unchanged (the caller is responsible for only enforcing a tightening profile).
// Returns a fresh scope object so a frozen-source profile is never aliased.
export function toEnforcedScope(scope: EquipmentScope): EquipmentScope {
  if (scope.tools === 'full') return { tools: 'full', enforcement: scope.enforcement };
  return { tools: { allow: [...scope.tools.allow] }, enforcement: 'enforced' };
}

// One source of truth for the prompt: render the closed menu as a bullet list
// so the validator and the proposer prompt never drift. Consumed by
// propose-prompts.ts.
export function renderEquipmentProfileMenu(): string {
  return EQUIPMENT_PROFILE_IDS.map((id) => `- \`${id}\` — ${EQUIPMENT_PROFILES[id].purpose}`).join(
    '\n',
  );
}
