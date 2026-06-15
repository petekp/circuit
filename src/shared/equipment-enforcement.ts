import type { ToolScopeCapability } from '../schemas/connector.js';
import type { EquipmentEnforcement, EquipmentScope } from '../schemas/equipment-scope.js';

// The resolved enforcement decision for one relay dispatch. `declared` preserves
// the author's intent for the audit; `effective` is the honest runtime state.
// They diverge only on the downgrade path: a scope declared "enforced" against a
// connector that cannot restrict tools resolves to effective "trusted" with
// `downgraded: true` and a `finding`. `toolAllowList` is present ONLY when the
// scope is genuinely enforced — it is the exact tool surface the connector is
// restricted to. A trusted scope (declared, or downgraded) carries no list:
// trusted is guidance, and guidance never restricts the connector.
export interface EquipmentEnforcementDecision {
  readonly declared: EquipmentEnforcement;
  readonly effective: EquipmentEnforcement;
  readonly downgraded: boolean;
  readonly toolAllowList?: readonly string[];
  readonly finding?: string;
}

// Map a declared equipment scope plus the running connector's tool-scope
// capability to the effective enforcement. Pure and total: every pair returns a
// decision, never throws. This is the single seam where "enforced" becomes a
// real restriction or is honestly downgraded — the connector layer and the
// trace recorder both consume what this returns.
export function resolveEquipmentEnforcement(
  scope: EquipmentScope | undefined,
  capability: ToolScopeCapability,
): EquipmentEnforcementDecision {
  // No scope, or the full tool surface: nothing to restrict. Trusted by
  // definition. (The schema forbids enforced + full, so a full scope is always
  // trusted here.)
  if (scope === undefined || scope.tools === 'full') {
    return { declared: 'trusted', effective: 'trusted', downgraded: false };
  }

  // An allow-list offered as guidance. It is rendered to the worker in the
  // prompt but never restricts the connector's tools.
  if (scope.enforcement === 'trusted') {
    return { declared: 'trusted', effective: 'trusted', downgraded: false };
  }

  // Declared enforced against an allow-list. Honor it only where the connector
  // can actually restrict its tool surface.
  if (capability === 'allow-list') {
    return {
      declared: 'enforced',
      effective: 'enforced',
      downgraded: false,
      toolAllowList: scope.tools.allow,
    };
  }

  // Declared enforced, but the connector cannot restrict tools. Downgrade to
  // trusted and record a finding. Never displayed as enforced; grants no list.
  return {
    declared: 'enforced',
    effective: 'trusted',
    downgraded: true,
    finding:
      "equipment scope declared 'enforced' but the connector cannot restrict tools (tool_scope capability 'none'); downgraded to trusted — the tool list is offered as guidance, not enforced",
  };
}
