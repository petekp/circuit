// EquipmentScope schema contract — the declared per-step equipment field
// (tools + enforced-vs-trusted). See docs/ideas/e2-equipment-scope-spec.md and
// docs/ideas/equipment-scope-build-brief.md.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EQUIPMENT_SCOPE,
  EquipmentScope,
  isDefaultEquipmentScope,
} from '../../src/index.js';

describe('EquipmentScope — declared per-step tool scope', () => {
  it('parses an empty object to the wide/full, trusted default', () => {
    const parsed = EquipmentScope.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.tools).toBe('full');
      expect(parsed.data.enforcement).toBe('trusted');
    }
  });

  it('DEFAULT_EQUIPMENT_SCOPE is the no-op default and isDefaultEquipmentScope reports it', () => {
    expect(isDefaultEquipmentScope(DEFAULT_EQUIPMENT_SCOPE)).toBe(true);
    expect(isDefaultEquipmentScope(EquipmentScope.parse({}))).toBe(true);
  });

  it('accepts a trusted allow-list (tools offered as guidance)', () => {
    const parsed = EquipmentScope.safeParse({
      tools: { allow: ['Read', 'Grep', 'Edit'] },
      enforcement: 'trusted',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(isDefaultEquipmentScope(parsed.data)).toBe(false);
    }
  });

  it('accepts an enforced allow-list (tools restricted at the write tier)', () => {
    const parsed = EquipmentScope.safeParse({
      tools: { allow: ['Read', 'Edit', 'Write'] },
      enforcement: 'enforced',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects enforced + full — enforcement has nothing to restrict', () => {
    const parsed = EquipmentScope.safeParse({ tools: 'full', enforcement: 'enforced' });
    expect(parsed.success).toBe(false);
  });

  it('rejects an empty allow-list', () => {
    const parsed = EquipmentScope.safeParse({ tools: { allow: [] } });
    expect(parsed.success).toBe(false);
  });

  it('rejects a duplicate tool in the allow-list', () => {
    const parsed = EquipmentScope.safeParse({ tools: { allow: ['Read', 'Read'] } });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown enforcement value', () => {
    const parsed = EquipmentScope.safeParse({
      tools: { allow: ['Read'] },
      enforcement: 'mandatory',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects surplus keys (strict)', () => {
    const parsed = EquipmentScope.safeParse({
      tools: 'full',
      enforcement: 'trusted',
      reads: 'wide',
    });
    expect(parsed.success).toBe(false);
  });

  it('defaults enforcement to trusted when only tools are declared', () => {
    const parsed = EquipmentScope.safeParse({ tools: { allow: ['Read'] } });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.enforcement).toBe('trusted');
    }
  });
});
