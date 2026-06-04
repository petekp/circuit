import { z } from 'zod';
import {
  ConnectorName,
  CustomConnectorDescriptor,
  EnabledConnector,
  RESERVED_CONNECTOR_NAMES,
} from './connector.js';
import { HostConfig } from './host.js';
import { CompiledFlowId, SkillId, SkillSlotId } from './ids.js';
import { SelectionOverride } from './selection-policy.js';
import { SkillHookConfig } from './skill-hook.js';
import { RelayRole } from './step.js';

// connector-I5 + connector-I9: the registry-layer `ConnectorReference` is a
// 2-variant discriminated union with per-variant `.strict()`. Inline
// `CustomConnectorDescriptor` is NOT a legal registry-layer reference —
// custom connectors must be registered in `relay.connectors` exactly once
// and referenced by name. Surplus keys (typos like `nmae: 'gemini'`) are
// rejected at parse time so they point at the typo directly.
//
// `ConnectorReference` is exported so future callers
// can validate registry-layer references directly (instead of reaching for
// `ConnectorRef`, which admits inline custom descriptors and would silently
// relax connector-I5).
export const ConnectorReference = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('builtin'), name: EnabledConnector }).strict(),
  z.object({ kind: z.literal('named'), name: ConnectorName }).strict(),
]);
export type ConnectorReference = z.infer<typeof ConnectorReference>;

// connector-I9: `.strict()` on RelayConfigBody rejects surplus keys at the
// top level (e.g. `relay.adpaters` typo transposition), so the author's
// intent — "register a custom connector" — fails loudly rather than silently
// producing an empty registry whose named references then fail closure with
// a misleading error far from the typo.
const RelayConfigBody = z
  .object({
    default: z.union([EnabledConnector, z.literal('auto'), ConnectorName]).default('auto'),
    roles: z.partialRecord(RelayRole, ConnectorReference).default({}),
    circuits: z.record(CompiledFlowId, ConnectorReference).default({}),
    connectors: z.record(ConnectorName, CustomConnectorDescriptor).default({}),
  })
  .strict();

const issueAt = (ctx: z.RefinementCtx, path: (string | number)[], message: string) => {
  ctx.addIssue({ code: 'custom', path, message });
};

export const RelayConfig = RelayConfigBody.superRefine((cfg, ctx) => {
  // connector-I2: reserved-name disjointness. A custom connector keyed under a
  // `EnabledConnector` value or the `'auto'` sentinel would silently shadow
  // the built-in in `relay.default` resolution — it would parse, appear
  // in the registry, and be picked by `default: 'codex'`, producing a
  // behavior divergence the author did not intend. Reject at parse time.
  //
  // Iterate only OWN keys via `Object.keys` and
  // check membership via a Set (not via bracket access on the record), so
  // inherited prototype names like `constructor`, `toString`, `__proto__`,
  // and `hasOwnProperty` cannot smuggle past closure checks. Bracket
  // access `cfg.connectors['constructor']` on a parsed object would resolve
  // to `Object.prototype.constructor` and satisfy a truthiness check even
  // when no own property exists.
  const ownConnectorKeys = Object.keys(cfg.connectors);
  const registered = new Set<string>(ownConnectorKeys);
  const reserved = new Set<string>(RESERVED_CONNECTOR_NAMES);
  for (const name of ownConnectorKeys) {
    if (reserved.has(name)) {
      issueAt(
        ctx,
        ['connectors', name],
        `connector name '${name}' is reserved (built-in or 'auto') and cannot be used as a custom connector key`,
      );
    }
    // Registry key and descriptor `name` must
    // agree. `{connectors: {gemini: {name: 'ollama', ...}}}` parses per
    // ConnectorName regex but leaves two connector identities (`gemini` via
    // registry key, `ollama` via emitted descriptor) for a single
    // registered executor. TraceEntries would carry a `name` the audit index
    // doesn't know about.
    const descriptor = cfg.connectors[name];
    if (descriptor && descriptor.name !== name) {
      issueAt(
        ctx,
        ['connectors', name, 'name'],
        `connector registry key '${name}' does not match descriptor name '${descriptor.name}'`,
      );
    }
  }
  const known = new Set<string>(['auto', ...EnabledConnector.options, ...ownConnectorKeys]);
  if (typeof cfg.default === 'string' && !known.has(cfg.default)) {
    issueAt(ctx, ['default'], `relay.default references unknown connector: ${cfg.default}`);
  }
  for (const [role, ref] of Object.entries(cfg.roles)) {
    if (ref && ref.kind === 'named' && !registered.has(ref.name)) {
      issueAt(ctx, ['roles', role], `role connector not registered: ${ref.name}`);
    }
    if (role === 'implementer' && ref && ref.kind === 'named') {
      const descriptor = cfg.connectors[ref.name];
      if (descriptor?.capabilities.filesystem === 'read-only') {
        issueAt(
          ctx,
          ['roles', role],
          `custom connector '${ref.name}' is read-only and cannot be used for implementer relay steps`,
        );
      }
    }
  }
  for (const [circuit, ref] of Object.entries(cfg.circuits)) {
    if (ref && ref.kind === 'named' && !registered.has(ref.name)) {
      issueAt(ctx, ['circuits', circuit], `circuit connector not registered: ${ref.name}`);
    }
  }
});
export type RelayConfig = z.infer<typeof RelayConfig>;

export const SkillBindings = z.record(SkillSlotId, SkillId);
export type SkillBindings = z.infer<typeof SkillBindings>;

export const SkillsConfig = z
  .object({
    bindings: SkillBindings.default({}),
  })
  .strict();
export type SkillsConfig = z.infer<typeof SkillsConfig>;

export const CircuitVariantModelId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, {
    message: 'variant model id must be a fanout-safe kebab-case slug',
  });
export type CircuitVariantModelId = z.infer<typeof CircuitVariantModelId>;

export const CircuitVariantModel = z
  .object({
    id: CircuitVariantModelId,
    label: z.string().min(1),
    connector: ConnectorReference.optional(),
    selection: SelectionOverride,
  })
  .strict()
  .superRefine((variant, ctx) => {
    if (variant.selection.model === undefined) {
      issueAt(ctx, ['selection', 'model'], 'variant model selection.model is required');
    }
    if (variant.selection.effort === undefined) {
      issueAt(ctx, ['selection', 'effort'], 'variant model selection.effort is required');
    }
  });
export type CircuitVariantModel = z.infer<typeof CircuitVariantModel>;

export const CircuitVariantModels = z
  .array(CircuitVariantModel)
  .min(2)
  .max(4)
  .superRefine((variants, ctx) => {
    const seen = new Set<string>();
    for (const [index, variant] of variants.entries()) {
      if (seen.has(variant.id)) {
        issueAt(ctx, [index, 'id'], `duplicate variant model id '${variant.id}'`);
      }
      seen.add(variant.id);
    }
  });
export type CircuitVariantModels = z.infer<typeof CircuitVariantModels>;

// Per-circuit skill contribution flows through `selection.skills` via
// typed `SkillOverride` operations. (Earlier shapes accepted an untyped
// `skills: string[]` channel that bypassed validation.)
export const CircuitOverride = z
  .object({
    selection: SelectionOverride.optional(),
    skill_bindings: SkillBindings.default({}),
    variant_models: CircuitVariantModels.optional(),
  })
  .strict();
export type CircuitOverride = z.infer<typeof CircuitOverride>;

// Top-level Config and its nested `defaults` object both `.strict()` so
// authorial typos (e.g. `defuults: {...}` at root or
// `defaults: {selections: ...}` nested) fail fast at parse time rather
// than silently stripping to empty defaults. `.default(...)` on every
// non-version field preserves the ergonomic that a minimal
// `{schema_version: 1}` parses as a fully-populated Config.
// Slice 5 (D1): the operator-set project-identity override for self-auditing
// project memory. When present it wins over git-remote inference and the
// runs-base fallback (resolveProjectId), so an operator can pin a stable key
// across worktrees/clones (or make the explicit value mandatory by setting it
// and never relying on inference). A fanout-safe kebab-case slug because the id
// is later hashed and stamped into provenance, never joined into a path.
export const ProjectId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, {
    message: 'project_id must be a fanout-safe kebab-case slug',
  });
export type ProjectId = z.infer<typeof ProjectId>;

export const Config = z
  .object({
    schema_version: z.literal(1),
    // Optional so a minimal `{schema_version: 1}` still parses; absent means
    // "infer the project identity from the git remote, then the runs base".
    project_id: ProjectId.optional(),
    // Optional at the layer level so composition can distinguish "this layer
    // has no host opinion" from an explicit `host: {kind: generic-shell}` reset.
    host: HostConfig.optional(),
    relay: RelayConfig.default({
      default: 'auto',
      roles: {},
      circuits: {},
      connectors: {},
    }),
    skills: SkillsConfig.default({ bindings: {} }),
    skill_hooks: SkillHookConfig.default({ policy: {}, detection: { disabled_patterns: {} } }),
    circuits: z.record(CompiledFlowId, CircuitOverride).default({}),
    defaults: z
      .object({
        selection: SelectionOverride.optional(),
      })
      .strict()
      .default({}),
  })
  .strict();
export type Config = z.infer<typeof Config>;

export const ConfigLayer = z.enum(['default', 'user-global', 'project', 'invocation']);
export type ConfigLayer = z.infer<typeof ConfigLayer>;

// CONFIG-I2 — `.strict()` on the layer wrapper: the three-field shape
// (`layer`, `source_path?`, `config`) does not silently grow a fourth
// field. Future ledger additions (checksum, origin, etc.) require an ADR.
export const LayeredConfig = z
  .object({
    layer: ConfigLayer,
    source_path: z.string().optional(),
    config: Config,
  })
  .strict();
export type LayeredConfig = z.infer<typeof LayeredConfig>;
