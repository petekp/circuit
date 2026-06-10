import { z } from 'zod';

export const ChangeKind = z.enum([
  'ratchet-advance',
  'equivalence-refactor',
  'migration-escrow',
  'discovery',
  'disposable',
  'break-glass',
]);
export type ChangeKind = z.infer<typeof ChangeKind>;

const ChangeKindBase = z.object({
  failure_mode: z.string().min(1),
  acceptance_evidence: z.string().min(1),
  alternate_framing: z.string().min(1),
});

export const MigrationEscrowChangeKind = ChangeKindBase.extend({
  change_kind: z.literal('migration-escrow'),
  expires_at: z.iso.datetime(),
  restoration_plan: z.string().min(1),
}).strict();
export type MigrationEscrowChangeKind = z.infer<typeof MigrationEscrowChangeKind>;

export const BreakGlassChangeKind = ChangeKindBase.extend({
  change_kind: z.literal('break-glass'),
  post_hoc_adr_deadline_at: z.iso.datetime(),
}).strict();
export type BreakGlassChangeKind = z.infer<typeof BreakGlassChangeKind>;

export const StandardChangeKind = ChangeKindBase.extend({
  change_kind: z.enum(['ratchet-advance', 'equivalence-refactor', 'discovery', 'disposable']),
});
export type StandardChangeKind = z.infer<typeof StandardChangeKind>;

export const ChangeKindDeclaration = z.discriminatedUnion('change_kind', [
  StandardChangeKind.extend({ change_kind: z.literal('ratchet-advance') }).strict(),
  StandardChangeKind.extend({ change_kind: z.literal('equivalence-refactor') }).strict(),
  StandardChangeKind.extend({ change_kind: z.literal('discovery') }).strict(),
  StandardChangeKind.extend({ change_kind: z.literal('disposable') }).strict(),
  MigrationEscrowChangeKind,
  BreakGlassChangeKind,
]);
export type ChangeKindDeclaration = z.infer<typeof ChangeKindDeclaration>;
