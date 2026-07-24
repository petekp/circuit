import type { CompiledFlow } from '../schemas/compiled-flow.js';
import type { ResolvedConnector } from '../schemas/connector.js';
import type { ProgressEvent } from '../schemas/progress-event.js';
import type { ResolvedSelection } from '../schemas/selection-policy.js';
import type { ConnectorRelayInput, RelayResult } from './connector-relay.js';

// Structured relayer descriptor. Without it, relay materialization could lose
// the connector identity used for trace provenance and compatibility checks.
export interface RelayFn {
  readonly connectorName: string;
  readonly connector?: ResolvedConnector;
  // Explicit capability claim required before a host-injected relayer may
  // receive a prompt-only flow. Built-in direct connectors are checked at
  // dispatch instead.
  readonly promptOnlyContext?: true;
  readonly relay: (input: RelayInput) => Promise<RelayResult>;
}

export interface RelayInput extends ConnectorRelayInput {
  readonly connector?: string;
  readonly resolvedSelection?: ResolvedSelection;
}

export type ProgressReporter = (event: ProgressEvent) => void;

export interface RuntimeEvidencePolicy {
  readonly includeUntrackedFileContent?: boolean;
}

export interface ComposeWriterInput {
  readonly runFolder: string;
  readonly flow: CompiledFlow;
  readonly step: CompiledFlow['steps'][number] & { kind: 'compose' };
  readonly goal: string;
  readonly projectRoot?: string;
  readonly evidencePolicy?: RuntimeEvidencePolicy;
}

export type ComposeWriterFn = (input: ComposeWriterInput) => void;
