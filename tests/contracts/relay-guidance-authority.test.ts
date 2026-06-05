import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('relay guidance authority boundary', () => {
  it('keeps production relay selection planning behind relay guidance', () => {
    const relayExecutorSource = readFileSync(
      join(process.cwd(), 'src/runtime/executors/relay.ts'),
      'utf8',
    );
    const relayGuidanceSource = readFileSync(
      join(process.cwd(), 'src/runtime/run/relay-guidance.ts'),
      'utf8',
    );
    const connectorResolverSource = readFileSync(
      join(process.cwd(), 'src/connectors/resolver.ts'),
      'utf8',
    );
    const selectionResolverSource = readFileSync(
      join(process.cwd(), 'src/selection/selection-resolver.ts'),
      'utf8',
    );
    const relaySelectionSource = readFileSync(
      join(process.cwd(), 'src/selection/relay-selection.ts'),
      'utf8',
    );
    const fanoutBranchExecutionSource = readFileSync(
      join(process.cwd(), 'src/runtime/fanout/branch-execution.ts'),
      'utf8',
    );
    const fanoutExecutorSource = readFileSync(
      join(process.cwd(), 'src/runtime/executors/fanout.ts'),
      'utf8',
    );
    const relayProvenanceTestSource = readFileSync(
      join(process.cwd(), 'tests/runner/runner-relay-provenance.test.ts'),
      'utf8',
    );

    expect(relayExecutorSource).toContain('planRelayGuidanceDecision');
    expect(relayExecutorSource).not.toContain('deriveResolvedSelection');
    expect(relayExecutorSource).not.toContain('resolveLoadedRelaySkills');
    expect(relayExecutorSource).not.toContain('resolveRelayExecution');
    expect(fanoutBranchExecutionSource).toContain('planRelayGuidanceDecision');
    expect(fanoutBranchExecutionSource).not.toContain('resolveRelayExecution');
    expect(fanoutExecutorSource).toContain('planRelayFanoutBranchGuidanceDecision');
    expect(fanoutExecutorSource).not.toContain('resolveRelayExecution');
    expect(relayGuidanceSource).toContain('deriveResolvedSelection');
    expect(relayGuidanceSource).toContain('resolveLoadedRelaySkills');
    expect(relayGuidanceSource).toContain('resolveRelayGuidanceExecution');
    expect(relayGuidanceSource).toContain('requestedConnectorForGuidanceInput');
    expect(relayGuidanceSource).not.toContain('export interface RelayGuidancePlan');
    expect(relayGuidanceSource).not.toContain('selectionForCompatibility');
    expect(relayGuidanceSource).not.toContain('selection: step.selection');
    expect(relayGuidanceSource).not.toContain('relayer: context.relayer');
    expect(relayGuidanceSource).not.toContain('resolveRelayExecution');
    expect(relayGuidanceSource).not.toContain('requestedConnectorForRelay');
    expect(connectorResolverSource).toContain('resolveConnectorForGuidanceInput');
    expect(connectorResolverSource).not.toContain('resolveConnectorForRelay');
    expect(selectionResolverSource).toContain('resolveSelectionForGuidanceInput');
    expect(selectionResolverSource).not.toContain('export interface ResolveSelectionInput');
    expect(selectionResolverSource).not.toContain('resolveSelectionForRelay');
    expect(selectionResolverSource).not.toContain('PRE_WORKFLOW_CONFIG_SOURCES');
    expect(relaySelectionSource).toContain('GuidanceSelectionConfig');
    expect(relaySelectionSource).toContain('bindsExecutionDepthToGuidanceSelection');
    expect(relaySelectionSource).toContain('guidanceSelectionConfigLayersWithExecutionDepth');
    expect(relaySelectionSource).toContain('selectionConfigLayersForGuidanceInput');
    expect(relaySelectionSource).not.toContain('export type GuidanceSelectionConfig');
    expect(relaySelectionSource).not.toContain(
      'export function bindsExecutionDepthToRelaySelection',
    );
    expect(relaySelectionSource).not.toContain(
      'export function selectionConfigLayersWithExecutionDepth',
    );
    expect(relaySelectionSource).not.toContain('RelayerInvocationConfig');
    expect(relaySelectionSource).not.toContain('readonly relayer?:');
    expect(relaySelectionSource).not.toContain('RelayFn');
    expect(relaySelectionSource).not.toContain('selectionConfigLayersForRelay');
    expect(relayProvenanceTestSource).toContain('planRelayGuidanceDecision');
    expect(relayProvenanceTestSource).not.toContain('resolveConnectorForRelay');
  });
});
