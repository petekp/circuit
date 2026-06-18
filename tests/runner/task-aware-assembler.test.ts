// Phase 1 — the task-aware assembler.
//
// The old custom-flow seam was task-BLIND: it discarded the task description,
// hardcoded surface_area:'small'/risk:'low', and always seeded build's spine
// (grain was the only lever). This suite pins the new behavior: the assembler
// READS the task into signals, picks an archetype FAMILY from those signals, and
// instantiates a task-appropriate shape that reuses a registered contract family
// — so every generated flow still passes the fail-closed catalog/kind gates.
//
// Two invariants this suite protects:
//   1. Different tasks produce different families (the signal is USED, not
//      discarded) — and each family compiles clean (catalog 0, kind policy ok,
//      primary_result bound).
//   2. The build family stays byte-identical to the structure-resolver path, so
//      the built-in byte-identity guards (assemble-flow-equivalence, m9-truth,
//      check-flow-drift) keep holding — the change is in the create/resolver
//      layer only, never in the engine or the built-in specs.
import { describe, expect, it } from 'vitest';
import { assembleFlowSchematic } from '../../src/flows/assemble-flow-schematic.js';
import { buildAssemblySpec } from '../../src/flows/build/assembly-spec.js';
import { validateCompiledFlowKindPolicy } from '../../src/flows/canonical-stage-policy.js';
import { compileSchematicToCompiledFlow } from '../../src/flows/compile-schematic-to-flow.js';
import { resolveArchetype } from '../../src/flows/resolvers/archetype.js';
import { type ArchetypeFamily, extractAssemblySignals } from '../../src/flows/resolvers/signals.js';
import { applyStructure, resolveStructure } from '../../src/flows/resolvers/structure.js';
import { collectSchematicCatalogIssues } from '../../src/flows/schematic-catalog-check.js';
import { CompiledFlow } from '../../src/schemas/compiled-flow.js';

interface FamilyCase {
  readonly desc: string;
  readonly family: ArchetypeFamily;
}

// One representative task per family. The descriptions use the principled cue
// vocabulary (explain/teach => editorial; fix/bug/crash => fix; review/audit =>
// review; research/compare/investigate => research; prototype/mock => prototype;
// otherwise build). These are NOT the pre-registered evaluation task set — that
// set lives in docs/ideas/assembler-rebuild-preregistration.md and is scored in
// the breadth harness. These are the behavioral unit pins.
const FAMILY_CASES: readonly FamilyCase[] = [
  {
    desc: 'Explain how the transformer attention mechanism works as an interactive tutorial',
    family: 'editorial',
  },
  { desc: 'Fix the race condition that crashes the worker pool under load', family: 'fix' },
  { desc: 'Review the authentication module for security vulnerabilities', family: 'review' },
  {
    desc: 'Research and compare state-management options for the web client',
    family: 'research',
  },
  { desc: 'Prototype a landing-page hero in three visual directions', family: 'prototype' },
  { desc: 'Add a dark-mode toggle to the settings page', family: 'build' },
];

describe('extractAssemblySignals reads the task into signals', () => {
  it('classifies each representative task into its expected family', () => {
    for (const { desc, family } of FAMILY_CASES) {
      const signals = extractAssemblySignals(desc);
      expect(signals.family, desc).toBe(family);
      // A non-default family must cite at least one cue; build is the fallthrough
      // default and may legitimately cite nothing.
      if (family !== 'build') {
        expect(signals.signals_used.length, desc).toBeGreaterThan(0);
      }
    }
  });

  it('produces distinct families across distinct tasks (the signal is not discarded)', () => {
    const families = new Set(FAMILY_CASES.map((c) => extractAssemblySignals(c.desc).family));
    expect(families.size).toBeGreaterThanOrEqual(5);
  });

  it('escalates surface_area and risk from cues instead of always small/low', () => {
    const migrate = extractAssemblySignals(
      'Migrate the billing system across every service to the new provider',
    );
    expect(migrate.surface_area).toBe('large');
    const auth = extractAssemblySignals('Fix the broken password reset in the auth flow');
    expect(auth.risk).not.toBe('low');
  });
});

describe('cue matching is word-aware (no mid-word / derivational collisions)', () => {
  // A whole-word family cue must NOT fire as a prefix of an unrelated longer
  // word: 'explore' must not match inside 'explorer', 'fix' not inside 'fixture',
  // 'audit' not inside 'auditorium'. Each of these tasks is a plain build/UI
  // request with no real family intent, so the conservative build fallthrough is
  // the correct family. Before the trailing word-boundary fix these silently
  // misrouted to research/review/editorial/fix (impl-less shapes).
  const COLLISION_BUILD: readonly string[] = [
    'build a file explorer component for the sidebar', // explorer != explore
    'build a log analyzer tool for the dashboard', // analyzer != analyze
    'add a teacher profile page to the school portal', // teacher != teach
    'build an auditorium booking page for the venue', // auditorium != audit
    'add an inspector panel to the layout editor', // inspector != inspect
    'set up a test fixture for the shopping cart', // fixture != fix
  ];

  it('does not misroute build/UI tasks whose words merely contain a cue', () => {
    for (const desc of COLLISION_BUILD) {
      expect(extractAssemblySignals(desc).family, desc).toBe('build');
    }
  });

  // The flip side: stem cues and ordinary inflections of whole-word cues must
  // STILL fire, so the boundary fix doesn't cost real recall.
  interface RouteCase {
    readonly desc: string;
    readonly family: ArchetypeFamily;
  }
  const STILL_ROUTES: readonly RouteCase[] = [
    { desc: 'the login crashes intermittently on submit', family: 'fix' }, // crashes -> crash
    { desc: 'authentication keeps failing for SSO users', family: 'fix' }, // failing -> fix family
    { desc: 'investigate why the dashboard renders slowly', family: 'research' }, // investigat* stem
    { desc: 'compare three caching strategies and recommend one', family: 'research' }, // compar* stem
    { desc: 'reproduce the intermittent deadlock in the scheduler', family: 'fix' }, // repro* stem
    { desc: 'audit the payment service for PCI compliance gaps', family: 'review' }, // audit base word
  ];

  it('still fires for stems and ordinary inflections of cues', () => {
    for (const { desc, family } of STILL_ROUTES) {
      expect(extractAssemblySignals(desc).family, desc).toBe(family);
    }
  });

  it('still escalates surface/risk from stem cues (migrat*, auth*)', () => {
    const migrate = extractAssemblySignals('migrate the user records to the new schema');
    expect(migrate.surface_area, 'migration -> large surface').toBe('large');
    const authn = extractAssemblySignals('authentication is broken for SSO logins');
    expect(authn.risk, 'authentication -> high risk').toBe('high');
  });
});

describe('resolveArchetype instantiates a sound, task-appropriate shape', () => {
  it('every family compiles clean: catalog 0, kind policy ok, primary_result bound', () => {
    for (const { desc, family } of FAMILY_CASES) {
      const signals = extractAssemblySignals(desc);
      const resolution = resolveArchetype('my-generated-flow', signals);
      expect(resolution.family).toBe(family);
      expect(resolution.schematic.id, family).toBe('my-generated-flow');

      // The catalog gate runs on the SCHEMATIC (one graph) regardless of how
      // many runtime modes it compiles to.
      const issues = collectSchematicCatalogIssues(resolution.schematic);
      expect(
        issues.map((i) => i.message),
        `${family} catalog`,
      ).toHaveLength(0);

      // Some families (fix, research, prototype) carry depth/tournament
      // route_overrides and legitimately compile to a per-mode package — one
      // graph per runtime mode. Validate EVERY resulting graph: kind policy ok
      // and a primary_result bound.
      const compiled = compileSchematicToCompiledFlow(resolution.schematic);
      const flows = compiled.kind === 'single' ? [compiled.flow] : [...compiled.flows.values()];
      expect(flows.length, `${family} flows`).toBeGreaterThan(0);
      for (const flow of flows) {
        const parsed = CompiledFlow.parse(flow);
        expect(parsed.runtime_surface?.primary_result, `${family} primary_result`).toBeDefined();
        const policy = validateCompiledFlowKindPolicy(parsed);
        expect(policy.ok, `${family}: ${policy.ok ? '' : policy.reason}`).toBe(true);
      }
    }
  });

  it('the build family is byte-identical to the structure-resolver path (guards hold)', () => {
    const desc = 'Add a dark-mode toggle to the settings page';
    const signals = extractAssemblySignals(desc);
    const resolution = resolveArchetype('dark-mode-flow', signals);
    expect(resolution.family).toBe('build');

    // The structure-resolver path the old seam used, for the same task.
    const grained = applyStructure(
      { ...buildAssemblySpec, id: 'dark-mode-flow', purpose: desc },
      resolveStructure({ summary: desc, surface_area: signals.surface_area, risk: signals.risk }),
    );
    const expected = assembleFlowSchematic({ ...grained, id: 'dark-mode-flow' });
    expect(resolution.schematic).toEqual(expected);
  });

  it('an explicit decompose request forces the build full spine', () => {
    const signals = extractAssemblySignals('Add a dark-mode toggle to the settings page', {
      explicit_decompose: true,
    });
    const resolution = resolveArchetype('dark-mode-flow', signals);
    expect(resolution.family).toBe('build');
    // The schematic carries the authoring items; the full spine has all of them.
    expect(resolution.schematic.items.length).toBe(buildAssemblySpec.items.length);
  });
});
