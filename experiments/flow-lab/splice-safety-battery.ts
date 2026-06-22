// PHASE 3 — the SPLICE-SEAM SAFETY BATTERY.
//
// THROWAWAY SPIKE — captured in experiments/, NEVER promoted to src/. No model
// calls, no network, no engine seam. Pure-function probes over the offline splice
// demonstrator (splice-demonstrator.ts), built to answer ONE question for the
// "generate thin, then thicken" decision (Phase 4):
//
//   When a running flow re-shapes its own remaining steps (a splice / a
//   re-proposed tail), what does the splice seam's gate set actually CATCH, and
//   where is it FAIL-OPEN?
//
// The seam (spliceIntoRemainingSteps) re-runs TWO gates on a spliced schematic:
//   1. the schema safety floor   — FlowSchematic.safeParse  (dangling routes / shape)
//   2. the catalog safety floor  — tryCompile               (block/contract compat)
// It does NOT re-run the typed-contract PRODUCER chain (evaluateRunnability's
// writer-coupling wall). evaluateRunnability takes a pre-assembly *spec*; the
// splice operates on a post-assembly *schematic*, so the seam cannot reuse the
// existing gate without inverting schematic -> spec. That asymmetry is the thing
// under test.
//
// This battery constructs adversarial subtrees against the KNOWN whole-seed
// (frame -> plan -> act(displaced) -> verify -> close, where act produces
// build.implementation@v1, consumed by BOTH verify and close), runs the real
// splice on each, and INDEPENDENTLY runs two fuller-floor checks on whatever the
// seam honored:
//   - the AUTHORITATIVE writer-coupling gate, replicating evaluateRunnability's
//     post-compile loop exactly (the real resolvers, on the spliced compiled flow).
//   - a BROADER producer-completeness proxy: every step input read must have an
//     upstream producer (catches input-read breaks the writer-coupling gate, which
//     only inspects writer-SOURCED reads, does not look at).
//
// A finding is FAIL-OPEN when the seam returns spliced:true but a fuller-floor
// check rejects the result. That is the precise bound the Phase 4 thicken
// capability must close (re-run the full floor, including the producer chain,
// before honoring a re-shape).
//
// Run: npx tsx experiments/flow-lab/splice-safety-battery.ts
// Writes: experiments/flow-lab/_splice-safety-results.json

import { writeFileSync } from 'node:fs';
import { flowDefinitions } from '../../src/flows/catalog.js';
import {
  RESEARCH_THEN_BUILD,
  composeFlow,
  evaluateRunnability,
  evaluateValidity,
} from '../../src/flows/composition/index.js';
import {
  findCloseBuilder,
  resolveCloseReadPaths,
} from '../../src/flows/registries/close-writers/registry.js';
import {
  findComposeBuilder,
  resolveComposeReadPaths,
} from '../../src/flows/registries/compose-writers/registry.js';
import type {
  RuntimeIndexedFlow,
  RuntimeIndexedStep,
} from '../../src/flows/registries/runtime-index.js';
import {
  findVerificationWriter,
  resolveVerificationReadPaths,
} from '../../src/flows/registries/verification-writers/registry.js';
import { tryCompile } from './harness.js';
import {
  DISPLACED_STEP_ID,
  type RunState,
  type SpliceBudget,
  type Subtree,
  decomposeActSubtree,
  runStateFromSchematic,
  spliceIntoRemainingSteps,
  summarize,
  wholeSchematic,
} from './splice-demonstrator.js';

type SchematicStepInput = Record<string, unknown>;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// ---------------------------------------------------------------------------
// FULLER-FLOOR CHECK 1 — the AUTHORITATIVE writer-coupling gate.
// Replicates evaluateRunnability's post-compile loop EXACTLY (src/flows/composition
// /evaluate.ts:233-271), but starts from an already-compiled flow rather than a
// spec — which is precisely what the seam has after tryCompile. Uses the real
// exported resolvers, so a PASS here means "the production runnability gate, run on
// the spliced flow, would accept it".
// ---------------------------------------------------------------------------
interface RunnableVerdict {
  readonly runnable: boolean;
  readonly aborts: ReadonlyArray<{ stepId: string; schema: string; reason: string }>;
  readonly checkedSteps: number;
}

function reportSchemaOf(step: RuntimeIndexedStep): { path: string; schema: string } | undefined {
  const report = step.writes.report;
  if (typeof report !== 'object' || report === null) return undefined;
  const path = (report as { path?: unknown }).path;
  const schema = (report as { schema?: unknown }).schema;
  if (typeof path !== 'string' || typeof schema !== 'string') return undefined;
  return { path, schema };
}

function writerCouplingRunnable(compiledFlow: unknown): RunnableVerdict {
  const flow: RuntimeIndexedFlow = {
    id: (compiledFlow as { id: string }).id,
    version: (compiledFlow as { version: string }).version,
    stages: [],
    steps: (compiledFlow as { steps: unknown }).steps as RuntimeIndexedStep[],
  };
  const aborts: Array<{ stepId: string; schema: string; reason: string }> = [];
  let checkedSteps = 0;
  for (const step of flow.steps) {
    const report = reportSchemaOf(step);
    if (report === undefined) continue;
    const composeBuilder = findComposeBuilder(report.schema);
    const closeBuilder = findCloseBuilder(report.schema);
    const verificationBuilder = findVerificationWriter(report.schema);
    const verificationDeclaresReads =
      verificationBuilder !== undefined && verificationBuilder.reads !== undefined;
    if (composeBuilder === undefined && closeBuilder === undefined && !verificationDeclaresReads) {
      continue;
    }
    checkedSteps += 1;
    try {
      if (composeBuilder !== undefined) {
        resolveComposeReadPaths(composeBuilder, flow, step as never);
      } else if (closeBuilder !== undefined) {
        resolveCloseReadPaths(closeBuilder, flow, step as never);
      } else if (verificationBuilder !== undefined) {
        resolveVerificationReadPaths(verificationBuilder, flow, step as never);
      }
    } catch (error) {
      aborts.push({
        stepId: step.id,
        schema: report.schema,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { runnable: aborts.length === 0, aborts, checkedSteps };
}

// ---------------------------------------------------------------------------
// FULLER-FLOOR CHECK 2 — the BROADER producer-completeness proxy.
// Every step's INPUT reads (the report paths it consumes at runtime) must have an
// upstream producer (some step that writes that path). This is broader than the
// writer-coupling gate, which only inspects a writer's SOURCED reads, not the
// step's plain input reads. A relay step that reads reports/build/implementation
// .json with no producer would runtime-fail to read its input — a wall the
// writer-coupling gate is structurally blind to.
// ---------------------------------------------------------------------------
function missingProducers(compiledFlow: unknown): string[] {
  const steps = (compiledFlow as { steps: Array<Record<string, unknown>> }).steps;
  const produced = new Set<string>();
  for (const step of steps) {
    const report = (step.writes as { report?: { path?: unknown } } | undefined)?.report;
    if (report && typeof report.path === 'string') produced.add(report.path);
  }
  const missing: string[] = [];
  for (const step of steps) {
    const reads = (step.reads as unknown[] | undefined) ?? [];
    for (const read of reads) {
      const path = typeof read === 'string' ? read : undefined;
      if (path && !produced.has(path)) {
        missing.push(`${String(step.id)} reads ${path} (no producer)`);
      }
    }
  }
  return missing;
}

// What each step in a compiled flow produces — for the report table.
function producedContracts(compiledFlow: unknown): string[] {
  const steps = (compiledFlow as { steps: Array<Record<string, unknown>> }).steps;
  const out: string[] = [];
  for (const step of steps) {
    const report = (step.writes as { report?: { schema?: unknown } } | undefined)?.report;
    if (report && typeof report.schema === 'string') out.push(report.schema);
  }
  return out;
}

// ---------------------------------------------------------------------------
// ADVERSARIAL SUBTREES — constructed against the known whole-seed structure.
// ---------------------------------------------------------------------------

// H2 — the typed-contract / runnability break. Replace the displaced `act-step`
// with a SINGLE step sourced from the REAL `gather-context` body (the analyze
// block, output build.context@v1). The replacement produces build.context@v1 but
// NOT build.implementation@v1 — so verify-step and close-step, which both consume
// build.implementation@v1, lose their producer. Models a plausible bad re-proposal:
// a tail that researches but forgets to implement. The subtree is single-block and
// catalog-valid on its own; the defect is purely the cross-step producer break.
function contractBreakSubtree(displacedId: string): Subtree {
  const legal = decomposeActSubtree(displacedId);
  const entryItem = clone(
    (legal.items as SchematicStepInput[]).find((i) => i.id === legal.entryId),
  );
  if (entryItem === undefined) {
    throw new Error('contractBreakSubtree: could not source the analyze body');
  }
  // Make the analyze body a single entry==exit step. Its outbound `continue` is a
  // placeholder the splice overwrites with the displaced step's outbound
  // (-> verify-step); `retry` self-loops; the rest are conservative stops.
  const id = entryItem.id as string;
  entryItem.routes = { continue: '@stop', retry: id, ask: '@stop', stop: '@stop' };
  return {
    entryId: id,
    exitIds: [id],
    items: [entryItem],
    introducedStages: ['analyze'],
  };
}

// H1 — the laundered exit. Take the legal decompose subtree but make its exit
// SELF-DECLARE `continue -> @complete` (an attempt to skip verify-step entirely).
// The splice's outbound re-home fills the exit's routes from the displaced step's
// original outbound FIRST (continue -> verify-step), then only adds subtree-declared
// routes NOT already keyed. Because the displaced `act-step` declares `continue`,
// the self-declared `continue -> @complete` is overridden. We MEASURE the spliced
// exit's `continue` target to prove the launder is structurally impossible.
function launderingSubtree(displacedId: string): Subtree {
  const legal = decomposeActSubtree(displacedId);
  const items = clone(legal.items) as SchematicStepInput[];
  const exitIds = new Set(legal.exitIds);
  for (const item of items) {
    if (exitIds.has(item.id as string)) {
      (item.routes as Record<string, string>).continue = '@complete';
    }
  }
  return { ...legal, items };
}

// ---------------------------------------------------------------------------
// PROBES.
// ---------------------------------------------------------------------------
type Classification = 'CAUGHT_BY_SEAM' | 'FAIL_OPEN' | 'CLEAN';

interface AdversarialProbe {
  readonly id: string;
  readonly hazard: string;
  readonly spliced: boolean;
  readonly finding: string | null;
  readonly compiledOk: boolean | null;
  readonly writerCouplingRunnable: boolean | null;
  readonly writerCouplingAborts: ReadonlyArray<{ stepId: string; schema: string; reason: string }>;
  readonly missingProducers: readonly string[];
  readonly classification: Classification;
  readonly note: string;
}

function freshRun(): { schematic: ReturnType<typeof wholeSchematic>; runState: RunState } {
  const schematic = wholeSchematic();
  const runState = runStateFromSchematic(schematic, DISPLACED_STEP_ID, ['frame-step', 'plan-step']);
  return { schematic, runState };
}

function classifyHonoredSplice(splicedSchematic: unknown): {
  classification: Classification;
  compiledOk: boolean;
  wc: RunnableVerdict;
  missing: string[];
} {
  const compiled = tryCompile(splicedSchematic as never);
  if (!compiled.ok) {
    // Honored a splice that does not even compile — should be impossible (the seam
    // compiles before honoring), but record it as a fail-open if it ever happens.
    return {
      classification: 'FAIL_OPEN',
      compiledOk: false,
      wc: { runnable: false, aborts: [], checkedSteps: 0 },
      missing: ['<spliced schematic did not compile>'],
    };
  }
  const wc = writerCouplingRunnable(compiled.flow);
  const missing = missingProducers(compiled.flow);
  const classification: Classification =
    wc.runnable && missing.length === 0 ? 'CLEAN' : 'FAIL_OPEN';
  return { classification, compiledOk: true, wc, missing };
}

// H2 probe — does the seam catch a producer break, or honor it fail-open?
function probeContractBreak(): AdversarialProbe {
  const { schematic, runState } = freshRun();
  const subtree = contractBreakSubtree(DISPLACED_STEP_ID);
  const budget: SpliceBudget = { remaining: 3, touched: new Set() };
  const result = spliceIntoRemainingSteps(
    schematic,
    runState,
    {
      from_step: DISPLACED_STEP_ID,
      kind: 'turned-out-bigger',
      evidence: 'researches, never implements',
    },
    subtree,
    budget,
  );
  if (!result.spliced) {
    return {
      id: 'H2-contract-break',
      hazard:
        'replacement stops producing build.implementation@v1 (verify + close lose their input)',
      spliced: false,
      finding: result.finding,
      compiledOk: null,
      writerCouplingRunnable: null,
      writerCouplingAborts: [],
      missingProducers: [],
      classification: 'CAUGHT_BY_SEAM',
      note: 'seam rejected the producer break at schema or catalog gate',
    };
  }
  const { classification, compiledOk, wc, missing } = classifyHonoredSplice(result.schematic);
  return {
    id: 'H2-contract-break',
    hazard: 'replacement stops producing build.implementation@v1 (verify + close lose their input)',
    spliced: true,
    finding: null,
    compiledOk,
    writerCouplingRunnable: wc.runnable,
    writerCouplingAborts: wc.aborts,
    missingProducers: missing,
    classification,
    note:
      classification === 'FAIL_OPEN'
        ? 'seam HONORED a flow a fuller floor rejects — the producer-chain gap the thicken seam must close'
        : 'seam honored and the fuller floor also accepts (no break realized)',
  };
}

// H1 probe — the laundered exit. We MEASURE whether the spliced exit's `continue`
// was forced back to verify-step (launder blocked) despite the subtree's attempt
// to route continue -> @complete.
function probeLaunder(): {
  id: string;
  hazard: string;
  spliced: boolean;
  finding: string | null;
  splicedExitContinue: string | null;
  launderBlocked: boolean;
  note: string;
} {
  const { schematic, runState } = freshRun();
  const subtree = launderingSubtree(DISPLACED_STEP_ID);
  const exitId = subtree.exitIds[0];
  if (exitId === undefined) throw new Error('launderingSubtree produced no exit id');
  const result = spliceIntoRemainingSteps(
    schematic,
    runState,
    {
      from_step: DISPLACED_STEP_ID,
      kind: 'turned-out-bigger',
      evidence: 'attempts to skip verify',
    },
    subtree,
    { remaining: 3, touched: new Set() },
  );
  if (!result.spliced) {
    return {
      id: 'H1-laundered-exit',
      hazard: 'subtree exit self-declares continue -> @complete to skip the verify step',
      spliced: false,
      finding: result.finding,
      splicedExitContinue: null,
      launderBlocked: true,
      note: 'seam rejected the launder outright (also acceptable)',
    };
  }
  const exitStep = result.runState.steps.get(exitId);
  const splicedExitContinue = exitStep?.routes.continue ?? null;
  const launderBlocked = splicedExitContinue === 'verify-step';
  return {
    id: 'H1-laundered-exit',
    hazard: 'subtree exit self-declares continue -> @complete to skip the verify step',
    spliced: true,
    finding: null,
    splicedExitContinue,
    launderBlocked,
    note: launderBlocked
      ? 'outbound re-home FORCED continue -> verify-step; the self-declared @complete was overridden (launder structurally blocked)'
      : 'WARNING: spliced exit did not inherit the displaced outbound — launder NOT blocked',
  };
}

// H3 probe — isolation. The splice must mutate only clones, never the caller's
// inputs. We snapshot the input schematic and run state, run a splice, and assert
// byte-identity of the inputs afterward.
function probeIsolation(): {
  id: string;
  hazard: string;
  schematicUnmutated: boolean;
  runStateUnmutated: boolean;
  note: string;
} {
  const { schematic, runState } = freshRun();
  const subtree = decomposeActSubtree(DISPLACED_STEP_ID);
  const schematicBefore = JSON.stringify(schematic);
  const runStateBefore = JSON.stringify({
    cursor: runState.cursor,
    entry: runState.entry,
    sliceActive: runState.sliceActive,
    steps: [...runState.steps.entries()],
    completedCounts: [...runState.completedCounts.entries()],
  });
  spliceIntoRemainingSteps(
    schematic,
    runState,
    { from_step: DISPLACED_STEP_ID, kind: 'turned-out-bigger', evidence: 'isolation probe' },
    subtree,
    { remaining: 3, touched: new Set() },
  );
  const schematicAfter = JSON.stringify(schematic);
  const runStateAfter = JSON.stringify({
    cursor: runState.cursor,
    entry: runState.entry,
    sliceActive: runState.sliceActive,
    steps: [...runState.steps.entries()],
    completedCounts: [...runState.completedCounts.entries()],
  });
  return {
    id: 'H3-isolation',
    hazard: 'splice mutates the caller-owned schematic or run state in place',
    schematicUnmutated: schematicBefore === schematicAfter,
    runStateUnmutated: runStateBefore === runStateAfter,
    note: 'a splice that fails its gate must leave the run on its current, still-valid flow',
  };
}

// Baseline sanity: confirm a LEGAL decompose-down splice is honored AND passes both
// fuller-floor checks (so a FAIL_OPEN on H2 is a real seam gap, not a checker bug).
function probeLegalBaseline(): {
  id: string;
  spliced: boolean;
  writerCouplingRunnable: boolean | null;
  missingProducers: readonly string[];
  producedAfter: readonly string[];
  note: string;
} {
  const { schematic, runState } = freshRun();
  const subtree = decomposeActSubtree(DISPLACED_STEP_ID);
  const result = spliceIntoRemainingSteps(
    schematic,
    runState,
    { from_step: DISPLACED_STEP_ID, kind: 'turned-out-bigger', evidence: 'legal decompose-down' },
    subtree,
    { remaining: 3, touched: new Set() },
  );
  if (!result.spliced) {
    return {
      id: 'baseline-legal',
      spliced: false,
      writerCouplingRunnable: null,
      missingProducers: ['<legal splice was rejected — unexpected>'],
      producedAfter: [],
      note: 'a legal decompose-down should be honored; rejection means the demonstrator regressed',
    };
  }
  const compiled = tryCompile(result.schematic as never);
  if (!compiled.ok) {
    return {
      id: 'baseline-legal',
      spliced: true,
      writerCouplingRunnable: false,
      missingProducers: ['<legal splice did not compile>'],
      producedAfter: [],
      note: 'unexpected: legal splice failed to compile',
    };
  }
  const wc = writerCouplingRunnable(compiled.flow);
  return {
    id: 'baseline-legal',
    spliced: true,
    writerCouplingRunnable: wc.runnable,
    missingProducers: missingProducers(compiled.flow),
    producedAfter: producedContracts(compiled.flow),
    note: 'a legal decompose-down: honored, and both fuller-floor checks pass (control for the H2 gap)',
  };
}

// H4 probe — the WRITER-SOURCED required-read gap, demonstrated with the seam's
// OWN gate set. H2 showed the catalog gate catches an INPUT-contract producer
// break (the class an in-position splice realizes). This probe shows the OTHER
// class — a compose/close writer whose INTERNAL required read has no producer —
// passes the seam's gates (schema + catalog, via evaluateValidity's assemble +
// compile + catalog) yet ABORTS at runtime, caught only by evaluateRunnability,
// which the seam does NOT run. RESEARCH_THEN_BUILD is the committed make-or-break
// case (tests/contracts/composition-runnability.test.ts): its welded `plan`
// build-compose writer requires build.brief@v1, which only a checkpoint writer can
// produce, so no composed role set can satisfy it. This is the precise fail-open a
// thicken that splices a model-COMPOSED tail (novel writer wiring) would hit.
function probeWriterSourcedGap(): {
  id: string;
  hazard: string;
  catalogValid: boolean;
  seamGatesAccept: boolean;
  fullFloorRunnable: boolean;
  aborts: ReadonlyArray<{ stepId: string; schema: string; reason: string }>;
  gapConfirmed: boolean;
  note: string;
} {
  const outcome = composeFlow(RESEARCH_THEN_BUILD, { definitions: flowDefinitions });
  if (!outcome.ok) {
    return {
      id: 'H4-writer-sourced-gap',
      hazard: 'a composed tail introduces a writer whose internal required read has no producer',
      catalogValid: false,
      seamGatesAccept: false,
      fullFloorRunnable: false,
      aborts: [],
      gapConfirmed: false,
      note: 'compose failed to produce a spec; gap not demonstrable this run',
    };
  }
  const validity = evaluateValidity(outcome.spec);
  // The seam's gate set is schema + catalog. evaluateValidity runs assemble +
  // compile + catalog; the schema floor is satisfied by construction (the schematic
  // comes from assembleFlowSchematic). So a re-compile of that schematic is exactly
  // what the seam would accept.
  const seamGatesAccept =
    validity.valid && validity.schematic !== undefined && tryCompile(validity.schematic).ok;
  const runnability = evaluateRunnability(outcome.spec);
  return {
    id: 'H4-writer-sourced-gap',
    hazard: 'a composed tail introduces a writer whose internal required read has no producer',
    catalogValid: validity.valid,
    seamGatesAccept,
    fullFloorRunnable: runnability.runnable,
    aborts: runnability.aborts,
    gapConfirmed: seamGatesAccept && !runnability.runnable,
    note: runnability.runnable
      ? 'unexpected: this spec is runnable — the committed make-or-break case may have changed'
      : 'seam gates (schema + catalog) ACCEPT a flow the full floor (evaluateRunnability) REJECTS — the producer-chain gap a composed-tail thicken must close by re-running the full floor',
  };
}

// ---------------------------------------------------------------------------
// RUN.
// ---------------------------------------------------------------------------
function main(): void {
  const baselineFloor = summarize();
  const m = baselineFloor.migration;
  const baselineFloorHolds =
    m.cursorWasDisplaced &&
    m.cursorLandsOnEntry &&
    m.displacedAbsentFromSteps &&
    m.allRouteTargetsResolve &&
    m.displacedCountDropped &&
    m.survivorsKept &&
    m.noSubtreeIdInCounts &&
    !baselineFloor.safetyFloor.spliced &&
    baselineFloor.safetyFloor.chainRejected &&
    Object.values(baselineFloor.conservativeDefaults).every((v) => v === true);

  const legalBaseline = probeLegalBaseline();
  const h1 = probeLaunder();
  const h2 = probeContractBreak();
  const h3 = probeIsolation();
  const h4 = probeWriterSourcedGap();

  const headline = {
    baseline_floor_holds: baselineFloorHolds,
    legal_splice_honored_and_clean:
      legalBaseline.spliced &&
      legalBaseline.writerCouplingRunnable === true &&
      legalBaseline.missingProducers.length === 0,
    launder_blocked: h1.launderBlocked,
    // H2: the INPUT-contract producer break (the class an in-position splice
    // realizes). Did the seam CATCH it, or honor it fail-open?
    input_contract_break_caught_by_seam: h2.classification === 'CAUGHT_BY_SEAM',
    input_contract_break_failopen: h2.classification === 'FAIL_OPEN',
    // H4: the WRITER-SOURCED required-read break (the class a composed tail
    // realizes). The seam's gates ACCEPT it but the full floor REJECTS it — the
    // genuine fail-open a composed-tail thicken must close.
    writer_sourced_gap_confirmed: h4.gapConfirmed,
    isolation_preserved: h3.schematicUnmutated && h3.runStateUnmutated,
  };

  const results = {
    meta: {
      spike: 'splice-safety-battery',
      seedFlow: 'build-whole: frame -> plan -> act(displaced) -> verify -> close',
      displaced: DISPLACED_STEP_ID,
      gatesInSeam: ['FlowSchematic.safeParse (schema)', 'tryCompile (catalog)'],
      fullerFloorChecks: [
        'writerCouplingRunnable (replicates evaluateRunnability post-compile loop)',
        'missingProducers (broader: every step input read needs a producer)',
      ],
    },
    headline,
    baselineFloor,
    legalBaseline,
    probes: { h1, h2, h3, h4 },
  };

  writeFileSync(
    new URL('./_splice-safety-results.json', import.meta.url),
    `${JSON.stringify(results, null, 2)}\n`,
  );

  const log = console.log;
  log('=== SPLICE SAFETY BATTERY ===');
  log(`seed: ${results.meta.seedFlow}`);
  log('');
  log('--- baseline (regression floor) ---');
  log(`  demonstrator floor holds:           ${headline.baseline_floor_holds}`);
  log(`  legal splice honored + clean:       ${headline.legal_splice_honored_and_clean}`);
  log(`    writer-coupling runnable:         ${legalBaseline.writerCouplingRunnable}`);
  log(`    produced after splice:            ${legalBaseline.producedAfter.join(', ')}`);
  log('');
  log('--- H1: laundered exit (skip verify) ---');
  log(`  spliced:                            ${h1.spliced}`);
  log(`  spliced exit continue ->:           ${h1.splicedExitContinue}`);
  log(`  launder blocked:                    ${headline.launder_blocked}`);
  log(`  ${h1.note}`);
  log('');
  log('--- H2: INPUT-contract producer break (in-position splice class) ---');
  log(`  spliced (seam honored):             ${h2.spliced}`);
  log(`  classification:                     ${h2.classification}`);
  if (h2.finding) log(`  seam finding:                       ${h2.finding}`);
  if (h2.missingProducers.length > 0) {
    log(`  missing producers:                  ${h2.missingProducers.join('; ')}`);
  }
  log(`  ${h2.note}`);
  log('');
  log('--- H4: WRITER-SOURCED required-read gap (composed-tail class) ---');
  log(`  seam gates (schema+catalog) accept: ${h4.seamGatesAccept}`);
  log(`  full floor (runnability) runnable:  ${h4.fullFloorRunnable}`);
  log(`  GAP confirmed (seam accepts, floor rejects): ${h4.gapConfirmed}`);
  if (h4.aborts.length > 0) {
    log(
      `  floor aborts:                       ${h4.aborts.map((a) => `${a.stepId}:${a.schema}`).join('; ')}`,
    );
  }
  log(`  ${h4.note}`);
  log('');
  log('--- H3: isolation ---');
  log(`  input schematic unmutated:          ${h3.schematicUnmutated}`);
  log(`  input run state unmutated:          ${h3.runStateUnmutated}`);
  log('');
  log('--- HEADLINE ---');
  for (const [k, v] of Object.entries(headline)) log(`  ${k}: ${v}`);
  log('');
  log('wrote experiments/flow-lab/_splice-safety-results.json');
}

main();
