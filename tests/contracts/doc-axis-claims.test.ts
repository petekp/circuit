import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { flowDefinitions } from '../../src/flows/catalog.js';

// Axis-support claims that survive in living docs must agree with the catalog.
// The hand-maintained per-flow table in run-process.md was deleted (the
// authoring-model playbook bans "axis support per flow" lists); the remaining
// claims — each flow contract's "## Axis Support" section and the operator
// guide's Tournament/Autonomous control rows — are pinned here against
// `schematic.axes`, the single source the engine derives from. The classifiers
// fail loud when a claim becomes unparseable, so a prose rewrite that defeats
// the gate trips this test instead of silently drifting.

const root = resolve(__dirname, '..', '..');

type AxisTruth = {
  readonly visibility: string;
  readonly allowedDepths: readonly string[];
  readonly tournament: boolean;
  readonly autonomous: boolean;
};

const truth = new Map<string, AxisTruth>();
for (const flow of flowDefinitions) {
  const axes = flow.schematic.axes;
  if (axes === undefined) continue;
  truth.set(flow.id, {
    visibility: flow.visibility,
    allowedDepths: [...axes.allowed_depths],
    tournament: axes.supports_tournament,
    autonomous: axes.supports_autonomous,
  });
}

// Flows whose contract carries an "## Axis Support" section worth pinning.
const CONTRACT_FLOWS = ['fix', 'build', 'explore', 'review', 'pursue'] as const;

function axisSection(flowId: string): string {
  const text = readFileSync(resolve(root, 'src/flows', flowId, 'contract.md'), 'utf8');
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^## Axis Support\s*$/.test(line));
  expect(start, `${flowId}/contract.md has no "## Axis Support" section`).toBeGreaterThanOrEqual(0);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^## /.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

function parseDepths(section: string, flowId: string): string[] {
  const match = section.match(/axes\.allowed_depths\s*=\s*\[([^\]]+)\]/);
  expect(match, `${flowId} contract states no axes.allowed_depths`).not.toBeNull();
  return (match?.[1] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

// A contract claims an axis is supported, not supported, or — if neither reads
// decisively — fails the test. "does not support X" wins over a "supports …"
// clause that spans the same sentence ("supports autonomous … does not support
// tournament").
function claimsAxis(section: string, word: string, flowId: string): boolean {
  if (new RegExp(`does not support[^.]*\\b${word}\\b`, 'i').test(section)) return false;
  const affirmed = new RegExp(`\\bsupports?\\b[^.]*\\b${word}\\b`, 'i').test(section);
  expect(affirmed, `${flowId} contract makes no decidable claim about ${word} support`).toBe(true);
  return true;
}

function controlRowFlows(label: string): { flows: Set<string>; found: boolean } {
  const text = readFileSync(resolve(root, 'docs/operator-guide.md'), 'utf8');
  const row = text.split('\n').find((line) => new RegExp(`^\\|\\s*${label}\\b`).test(line));
  if (row === undefined) return { flows: new Set(), found: false };
  const cell = row.split('|').slice(1, -1).pop() ?? '';
  const flows = new Set<string>();
  for (const id of truth.keys()) {
    if (new RegExp(`\\b${id}\\b`, 'i').test(cell)) flows.add(id);
  }
  return { flows, found: true };
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

describe('doc axis claims agree with the catalog', () => {
  it('derives axis truth for the whole catalog (loud on empty)', () => {
    expect(truth.size).toBeGreaterThanOrEqual(6);
    for (const flowId of CONTRACT_FLOWS) {
      expect(truth.has(flowId), `catalog has no axis truth for ${flowId}`).toBe(true);
    }
  });

  it('pins each flow contract axis section to schematic.axes', () => {
    for (const flowId of CONTRACT_FLOWS) {
      const fact = truth.get(flowId);
      if (fact === undefined) continue;
      const section = axisSection(flowId);

      expect(sorted(parseDepths(section, flowId)), `${flowId} allowed depths`).toEqual(
        sorted(fact.allowedDepths),
      );
      expect(claimsAxis(section, 'tournament', flowId), `${flowId} tournament`).toBe(
        fact.tournament,
      );
      expect(claimsAxis(section, 'autonomous', flowId), `${flowId} autonomous`).toBe(
        fact.autonomous,
      );
    }
  });

  it('pins the operator-guide control rows to public-flow support', () => {
    const tournament = controlRowFlows('Tournament');
    const autonomous = controlRowFlows('Autonomous continuation');
    expect(tournament.found, 'operator-guide Tournament control row').toBe(true);
    expect(autonomous.found, 'operator-guide Autonomous control row').toBe(true);

    const publicTournament = sorted(
      [...truth]
        .filter(([, fact]) => fact.visibility === 'public' && fact.tournament)
        .map(([id]) => id),
    );
    const publicAutonomous = sorted(
      [...truth]
        .filter(([, fact]) => fact.visibility === 'public' && fact.autonomous)
        .map(([id]) => id),
    );

    expect(publicTournament.length).toBeGreaterThanOrEqual(1);
    expect(publicAutonomous.length).toBeGreaterThanOrEqual(1);
    expect(sorted(tournament.flows), 'tournament control row flows').toEqual(publicTournament);
    expect(sorted(autonomous.flows), 'autonomous control row flows').toEqual(publicAutonomous);
  });
});
