// Compose writer registry types.
//
// A compose writer turns a schematic's compose step into a
// schema-validated report. It generalizes the close-writer pattern:
// every flow's brief, plan, intake, analysis, etc., gets its own
// builder file under src/flows/<wf>/writers/ and is registered
// by output schema name on the flow package. The runner relays
// via the catalog-derived registry — it does not need to know which
// schemas exist.
//
// To add a new flow's compose step, an author writes:
//   1. The schema for the output report in src/flows/<wf>/reports.ts
//   2. A ComposeBuilder in src/flows/<wf>/writers/<schema>.ts
//   3. Register it on the package's `writers.compose`
//
// Close-with-evidence has its own registry under
// src/flows/registries/close-writers/. The two registries are intentionally
// kept separate because close steps have additional contract concerns
// (evidence_links, optional reads for mode-conditional inputs)
// that don't apply to upstream compose steps.

import type { Axes } from '../../../schemas/axes.js';
import type { LayeredConfig as LayeredConfigValue } from '../../../schemas/config.js';
import type { PrototypeVariantConnectorPlanner } from '../../../selection/connector-planning.js';
import type { RuntimeEvidencePolicy } from '../../../shared/relay-runtime-types.js';
import type { RuntimeGitReader } from '../../../shared/runtime-git-reader.js';
import type { RuntimeIndexedComposeStep, RuntimeIndexedFlow } from '../runtime-index.js';

export type ComposeStep = RuntimeIndexedComposeStep;

// Declarative description of a typed-report read. The runner uses
// this to pre-resolve paths and read JSON before invoking build().
// Builders that need non-standard resolution (e.g., review.result
// reads a relay result body, not a typed report) can omit
// `reads` and resolve paths themselves inside build().
export interface ComposeReadDescriptor {
  readonly name: string;
  readonly schema: string;
  readonly required: boolean;
}

export interface ComposeBuildContext {
  readonly runFolder: string;
  readonly flow: RuntimeIndexedFlow;
  readonly step: ComposeStep;
  readonly goal: string;
  readonly axes?: Axes;
  readonly projectRoot?: string;
  readonly evidencePolicy?: RuntimeEvidencePolicy;
  readonly gitReader?: RuntimeGitReader;
  readonly selectionConfigLayers?: readonly LayeredConfigValue[];
  readonly connectorPlanner?: PrototypeVariantConnectorPlanner;
  // True when this run's on-demand context-pull DELIVERY is active for the
  // relays this writer feeds: delivery is opted in AND the consuming relay is not
  // inside a delivery-blind slice corridor, so a step handed a thin envelope can
  // pull a withheld named slice and have it delivered back. A compose writer may
  // key its envelope thickness on this — under-provision (thin) when the relay
  // can recover the rest on demand, provision fully (fat) otherwise. Absent /
  // false on every run with delivery off (the default) and at deep depth, so a
  // writer that reads it stays byte-identical to before this signal existed.
  readonly contextDeliveryActive?: boolean;
  // Pre-resolved inputs from declared reads (or empty if no reads
  // declared). Builders narrow each via their own Zod schema.
  readonly inputs: Record<string, unknown | undefined>;
}

export interface ComposeBuilder {
  // Schema name of the report this builder produces (e.g.
  // 'build.plan@v1', 'explore.brief@v1'). Acts as the registry key.
  readonly resultSchemaName: string;
  // Optional declarative reads. When omitted, the builder resolves
  // paths itself in build().
  readonly reads?: readonly ComposeReadDescriptor[];
  // Per-flow logic. Returns the unvalidated report body — the
  // builder is responsible for validating against the registered
  // result schema before returning.
  build(context: ComposeBuildContext): unknown | Promise<unknown>;
}
