// The equipment-enforcement resolver maps a declared equipment scope plus the
// running connector's tool-scope capability to the EFFECTIVE enforcement. It is
// the one place that decides whether a declared "enforced" scope becomes a real
// tool restriction or is honestly downgraded to guidance. Pure and total: every
// (scope, capability) pair returns a decision, never throws.

import { describe, expect, it } from 'vitest';

import { resolveEquipmentEnforcement } from '../../src/shared/equipment-enforcement.js';

describe('resolveEquipmentEnforcement', () => {
  it('treats an undeclared scope as trusted with no restriction', () => {
    const decision = resolveEquipmentEnforcement(undefined, 'allow-list');
    expect(decision).toEqual({ declared: 'trusted', effective: 'trusted', downgraded: false });
    expect(decision.toolAllowList).toBeUndefined();
    expect(decision.finding).toBeUndefined();
  });

  it('treats a full tool scope as trusted with no restriction', () => {
    const decision = resolveEquipmentEnforcement(
      { tools: 'full', enforcement: 'trusted' },
      'allow-list',
    );
    expect(decision).toEqual({ declared: 'trusted', effective: 'trusted', downgraded: false });
    expect(decision.toolAllowList).toBeUndefined();
  });

  it('renders a trusted allow-list as guidance only — no enforced tool list', () => {
    const decision = resolveEquipmentEnforcement(
      { tools: { allow: ['Read', 'Grep'] }, enforcement: 'trusted' },
      'allow-list',
    );
    expect(decision.declared).toBe('trusted');
    expect(decision.effective).toBe('trusted');
    expect(decision.downgraded).toBe(false);
    // A trusted scope is guidance: it never restricts the connector's tools.
    expect(decision.toolAllowList).toBeUndefined();
  });

  it('enforces an allow-list when the connector can restrict tools', () => {
    const decision = resolveEquipmentEnforcement(
      { tools: { allow: ['Read', 'Edit', 'Write'] }, enforcement: 'enforced' },
      'allow-list',
    );
    expect(decision.declared).toBe('enforced');
    expect(decision.effective).toBe('enforced');
    expect(decision.downgraded).toBe(false);
    expect(decision.toolAllowList).toEqual(['Read', 'Edit', 'Write']);
    expect(decision.finding).toBeUndefined();
  });

  it('downgrades an enforced scope to trusted when the connector cannot restrict tools', () => {
    const decision = resolveEquipmentEnforcement(
      { tools: { allow: ['Read', 'Edit'] }, enforcement: 'enforced' },
      'none',
    );
    // Declared intent is preserved for the audit, but the EFFECTIVE state is
    // honest: trusted, never displayed as enforced.
    expect(decision.declared).toBe('enforced');
    expect(decision.effective).toBe('trusted');
    expect(decision.downgraded).toBe(true);
    // A downgraded scope grants no enforced tool list — nothing is restricted.
    expect(decision.toolAllowList).toBeUndefined();
    expect(decision.finding).toBeDefined();
    expect(decision.finding).toMatch(/downgrad/i);
  });
});
