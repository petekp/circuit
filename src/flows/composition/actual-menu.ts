// Flow-shape composition (experimental, default-OFF): the actual menu.
//
// The composer reuses REGISTERED ACTUAL contracts via aliasing — it never
// invents a contract body. This module derives, straight from the catalog, the
// menu of actuals the composer may draw from: for every (block, executionKind)
// the existing built-in flows use, the concrete actual they bind that block's
// generic output to, together with whether that actual has a registered body
// and the writers its execution kind needs. The composer then selects from this
// menu; the gates do the rest.
//
// Deriving the menu from `flowDefinitions` (not a hand-kept table) is the rails:
// the composer rides catalog data, so a new family's actuals become composable
// the moment that family ships. The body/writer verdicts come from the SAME
// registries the engine consults, so "registered" here means registered for the
// engine, not asserted.

import type { z } from 'zod';
import { FLOW_BLOCK_DEFINITIONS } from '../../schemas/flow-block-definitions.js';
import type { FlowBlockId } from '../../schemas/flow-blocks.js';
import type { SchematicStep } from '../../schemas/flow-schematic.js';
import { resolveFieldSignature } from '../contract-body-signature.js';
import type { FlowDefinition } from '../flow-definition.js';
import { findCloseBuilder } from '../registries/close-writers/registry.js';
import { findComposeBuilder } from '../registries/compose-writers/registry.js';
import { findVerificationWriter } from '../registries/verification-writers/registry.js';

export type ExecutionKind = SchematicStep['execution']['kind'];

export interface MenuEntry {
  // The catalog block this entry came from, and how it was executed.
  readonly block: FlowBlockId;
  readonly executionKind: ExecutionKind;
  readonly relayRole?: string;
  // For a sub-run donor step: the child flow it runs and the entry mode it uses.
  // The composer reads these to synthesize a sub-run execution descriptor that
  // targets the same child the donor did, rather than parsing the actual name
  // (which is not a reliable encoding — explainer.build-result@v1 runs `build`).
  readonly subRunFlowRef?: string;
  readonly subRunEntryMode?: string;
  readonly stage: SchematicStep['stage'];
  // The concrete actual the donor flow bound the block's generic output to.
  readonly actual: string;
  // The block's generic output_contract this actual specializes.
  readonly generic: string;
  // The contract namespace the actual belongs to (e.g. 'fix', 'build').
  readonly family: string;
  // The donor step that produced this entry (for provenance + check reuse).
  readonly donorFlowId: string;
  readonly donorStepId: string;
  // The donor step's check — reused verbatim because it describes the actual's
  // own output shape, which the composer is reusing unchanged.
  readonly check?: NonNullable<SchematicStep['check']>;
  // For a CONTENT checkpoint donor (a checkpoint that writes a typed report, like
  // the build frame producing build.brief@v1): the donor's policy.report_template,
  // the template object the checkpoint writer reads to populate that report. The
  // composer reuses it verbatim so a composed content-checkpoint produces a brief
  // its writer can fill — read live from the catalog, so it tracks the donor's
  // template with no drift. Absent for routing-only checkpoints (no donor report).
  readonly checkpointReportTemplate?: Record<string, unknown>;
  // Whether this entry is the donor flow's PRIMARY use of its block. A block
  // reused several times in one flow (run-verification appears as a pre-change
  // baseline, the post-change verification, a touch-area proof) yields several
  // actuals that all type-check for the same role but mean different things. The
  // primary use is the first occurrence at or after the flow's change (`act`)
  // step — the post-change instance the reviewer and close step depend on. A
  // singly-used block is trivially primary. The composer prefers primary actuals
  // so it reuses a block's canonical output, not an auxiliary variant.
  readonly donorPrimaryForBlock: boolean;
  // Registration verdicts, read from the engine's own registries.
  readonly bodyRegistered: boolean;
  readonly hasVerificationWriter: boolean;
  readonly hasCloseWriter: boolean;
  readonly hasComposeWriter: boolean;
}

function asString(value: unknown): string {
  return value as unknown as string;
}

function familyOf(actual: string): string {
  const dot = actual.indexOf('.');
  return dot === -1 ? actual : actual.slice(0, dot);
}

// Identify, per donor flow, the step id of each block's PRIMARY use — the one
// occurrence the composer should reuse when a block appears more than once. The
// primary use is the first occurrence at or after the flow's change step (the
// last `act`-block step), which is the post-change instance; a baseline captured
// before the change is auxiliary. A block used once is its own primary. When a
// flow has no `act` step, every block's first occurrence is primary (there is no
// pre/post-change axis to separate the uses).
function primaryUseStepIds(definition: FlowDefinition): ReadonlySet<string> {
  const items = definition.schematic.items;
  let actIndex = -1;
  items.forEach((item, index) => {
    if (asString(item.block) === 'act') actIndex = index;
  });

  const primaryByBlock = new Map<string, string>();
  items.forEach((item, index) => {
    const block = asString(item.block);
    const existing = primaryByBlock.get(block);
    if (existing === undefined) {
      primaryByBlock.set(block, asString(item.id));
      return;
    }
    // Prefer the first occurrence at or after the change step over an earlier
    // (pre-change) one. Once a post-change occurrence is chosen, keep it.
    const existingIndex = items.findIndex((it) => asString(it.id) === existing);
    const existingIsPostChange = actIndex !== -1 && existingIndex >= actIndex;
    const thisIsPostChange = actIndex !== -1 && index >= actIndex;
    if (!existingIsPostChange && thisIsPostChange) {
      primaryByBlock.set(block, asString(item.id));
    }
  });

  return new Set(primaryByBlock.values());
}

// The generic a step's output specializes is its BLOCK's `output_contract`, not
// whatever the flow's `contract_aliases` happen to map. A single actual can be
// aliased to several generics in one flow — fix.diagnosis@v1 is aliased to
// diagnosis.result@v1 (its block output) AND to flow.evidence@v1 (so a
// downstream human-decision can read it as evidence). Keying generics off the
// alias map collapses these to last-wins and loses the block's true output
// generic, which makes the actual uncomposable for its own block's role. The
// block definition is the single, unambiguous source.
const BLOCK_OUTPUT_GENERIC = new Map<string, string>(
  FLOW_BLOCK_DEFINITIONS.map((block) => [block.id, asString(block.output_contract)]),
);

// Derive the full menu from the flow definitions. Every step of every flow
// contributes one entry; the composer filters by (block, executionKind,
// generic) + registration when it selects.
export function deriveActualMenu(definitions: readonly FlowDefinition[]): readonly MenuEntry[] {
  const entries: MenuEntry[] = [];
  for (const definition of definitions) {
    const primaryStepIds = primaryUseStepIds(definition);
    for (const item of definition.schematic.items) {
      const actual = asString(item.output);
      // The generic is the block's declared output_contract. A step that outputs
      // that generic raw (actual === generic) specializes nothing; the composer's
      // candidate filter excludes such raw outputs.
      const generic = BLOCK_OUTPUT_GENERIC.get(asString(item.block)) ?? actual;
      const execution = item.execution;
      entries.push({
        block: item.block as unknown as FlowBlockId,
        executionKind: execution.kind,
        ...(execution.kind === 'relay' ? { relayRole: execution.role } : {}),
        ...(execution.kind === 'sub-run'
          ? {
              subRunFlowRef: asString(execution.flow_ref.flow_id),
              subRunEntryMode: asString(execution.flow_ref.entry_mode),
            }
          : {}),
        stage: item.stage,
        actual,
        generic,
        family: familyOf(actual),
        donorFlowId: definition.id,
        donorStepId: asString(item.id),
        ...(item.check === undefined ? {} : { check: item.check }),
        ...(execution.kind === 'checkpoint' && item.checkpoint_policy?.report_template !== undefined
          ? { checkpointReportTemplate: item.checkpoint_policy.report_template }
          : {}),
        donorPrimaryForBlock: primaryStepIds.has(asString(item.id)),
        bodyRegistered: resolveFieldSignature(actual) !== null,
        hasVerificationWriter: findVerificationWriter(actual) !== undefined,
        hasCloseWriter: findCloseBuilder(actual) !== undefined,
        hasComposeWriter: findComposeBuilder(actual) !== undefined,
      });
    }
  }
  return entries;
}

// A registered body is the floor for any reuse. Verification steps additionally
// need a verification writer (the compiler's ensureSupportedKindReportPair
// fails closed without one); a close-stage compose step that binds the primary
// result is safest with a close writer, though the compiler does not require it.
export function entryIsRegisteredFor(entry: MenuEntry, executionKind: ExecutionKind): boolean {
  if (!entry.bodyRegistered) return false;
  if (executionKind === 'verification' && !entry.hasVerificationWriter) return false;
  return true;
}

// The Zod body behind an actual, or undefined. Exposed so the composer's
// sanity checks and the eval harness can introspect shapes without re-importing
// the registry internals.
export function actualHasBody(actual: string): boolean {
  return resolveFieldSignature(actual) !== null;
}

export type ContractBodyResolver = (actual: string) => z.ZodType<unknown> | undefined;
