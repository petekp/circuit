// Composed fix-family role sets for the dynamic-vs-reference COMPOSED arm.
//
// The reference arm runs the hand-authored built-in fix flow. The generated arm
// runs the flow `circuit create` INSTANTIATES from a family template. This module
// adds a third path: a fix flow GENUINELY COMPOSED block by block from a role set,
// with no family template behind it.
//
// FIX_LINEAR_FULL is the fix arc assembled from individual blocks: frame the
// defect, gather context, diagnose the cause, make the change, verify it, and
// close with evidence. It is offline-VALID, runtime-RUNNABLE (every compose/close
// writer's required upstream reads have a producer), and NOVEL — its block
// sequence does not match any built-in (closest is the fix flow at jaccard ~0.43,
// so the comparison can actually separate composed from hand-authored). All three
// properties are proven offline by tests/contracts/composed-arm-plumbing.test.ts.
//
// publishComposedFlowWith reproduces, in process, exactly what `circuit create
// --publish` writes on disk for a custom flow: the compiled default graph at
// <home>/flows/<slug>/circuit.json plus a manifest.json whose custom_flows entry
// the trust gate path-matches. The composed arm then runs the SAME subprocess and
// the SAME scorer as the other two arms — only the flow-production step differs.
//
// DEPENDENCY INJECTION. The compile chain (composeFlow, the validity/runnability
// checks, assemble/compile/plan, and the flow catalog) is injected as `deps`
// rather than imported here, so this module's only top-level imports are
// TYPE-ONLY. That keeps it loadable under plain `node` (the harness launcher,
// which strips types but cannot remap the `.js`→`.ts` specifiers inside src/) AND
// under vitest. The test binds src deps; the harness binds the BUILT dist deps via
// loadComposeDepsFromDist (a computed dynamic import resolved after its build
// step). One logic path, two dep bindings, no duplication.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type * as AssembleModule from '../../src/flows/assemble-flow-schematic.ts';
import type * as CatalogModule from '../../src/flows/catalog.ts';
import type * as CompileModule from '../../src/flows/compile-schematic-to-flow.ts';
import type * as FilePlanModule from '../../src/flows/compiled-flow-file-plan.ts';
import type * as CompositionModule from '../../src/flows/composition/index.ts';

type CompositionRoleSet = CompositionModule.CompositionRoleSet;

// The full fix arc as a genuine block-level composition (NO build `plan`).
// frame (compose, fix.brief) -> gather-context -> diagnose -> act ->
// run-verification -> close-with-evidence (terminal). Mirrors what the fix flow
// DOES, assembled from individual blocks rather than the fix template.
export const FIX_LINEAR_FULL: CompositionRoleSet = {
  id: 'fix-linear-full',
  title: 'Genuine fix arc (block-level)',
  purpose:
    'Frame the defect, gather context, diagnose the cause, make the change, verify it, and close with evidence — assembled block by block, not from the fix template.',
  roles: [
    { stage: 'frame', block: 'frame', executionKind: 'compose' },
    { stage: 'analyze', block: 'gather-context', executionKind: 'relay', relayRole: 'researcher' },
    { stage: 'analyze', block: 'diagnose', executionKind: 'relay', relayRole: 'researcher' },
    { stage: 'act', block: 'act', executionKind: 'relay', relayRole: 'implementer' },
    { stage: 'verify', block: 'run-verification', executionKind: 'verification' },
    { stage: 'close', block: 'close-with-evidence', executionKind: 'compose', terminal: true },
  ],
};

// The full fix arc WITH a bounded inspect/fix/verify loop — retry the change back
// to `act` on a failed verification up to the attempt cap. The reference fix
// flow's actual recovery shape, composed. Kept here as the recovery variant; the
// harness runs FIX_LINEAR_FULL by default.
export const FIX_LINEAR_LOOP: CompositionRoleSet = {
  id: 'fix-linear-loop',
  title: 'Genuine fix arc with bounded recovery loop',
  purpose:
    'Frame the defect, gather context, diagnose, make the change, verify it, and on a failed verification retry the change up to the attempt cap; close with evidence.',
  roles: [
    { stage: 'frame', block: 'frame', executionKind: 'compose' },
    { stage: 'analyze', block: 'gather-context', executionKind: 'relay', relayRole: 'researcher' },
    { stage: 'analyze', block: 'diagnose', executionKind: 'relay', relayRole: 'researcher' },
    { stage: 'act', block: 'act', executionKind: 'relay', relayRole: 'implementer' },
    {
      stage: 'verify',
      block: 'run-verification',
      executionKind: 'verification',
      loopBackTo: 'act',
    },
    { stage: 'close', block: 'close-with-evidence', executionKind: 'compose', terminal: true },
  ],
};

export const COMPOSED_FIX_SHAPES: Record<string, CompositionRoleSet> = {
  'fix-linear-full': FIX_LINEAR_FULL,
  'fix-linear-loop': FIX_LINEAR_LOOP,
};

// The compile chain this module needs, injected so the only static imports here
// stay type-only. The test binds the src exports; the harness binds the dist ones.
export interface ComposeDeps {
  composeFlow: typeof CompositionModule.composeFlow;
  evaluateValidity: typeof CompositionModule.evaluateValidity;
  evaluateRunnability: typeof CompositionModule.evaluateRunnability;
  assembleFlowSchematic: typeof AssembleModule.assembleFlowSchematic;
  compileSchematicToCompiledFlow: typeof CompileModule.compileSchematicToCompiledFlow;
  planCompiledFlowFiles: typeof FilePlanModule.planCompiledFlowFiles;
  flowDefinitions: typeof CatalogModule.flowDefinitions;
}

export interface PublishedComposedFlow {
  readonly slug: string;
  readonly flowPath: string;
}

// Compose a role set in process and write it to disk exactly as `circuit create
// --publish` would: compiled files under <home>/flows/<slug>/ (circuit.json is
// the blessed default mode) plus <home>/manifest.json with a custom_flows entry
// the trust gate path-matches. Returns { slug, flowPath } shaped like the
// generated arm's parseCreateOutput so the run + scorer drop in unchanged.
//
// Throws (fails loud) if the composed spec walls, is offline-invalid, or would
// abort at a writer at runtime — a broken role set must surface here, not as a
// confusing mid-run abort.
export function publishComposedFlowWith(
  deps: ComposeDeps,
  input: {
    readonly roleSet: CompositionRoleSet;
    readonly home: string;
    readonly description: string;
    readonly createdAt: string;
  },
): PublishedComposedFlow {
  const outcome = deps.composeFlow(input.roleSet, { definitions: deps.flowDefinitions });
  if (!outcome.ok) {
    const walls = outcome.walls.map((w) => `${w.block}: ${w.reason}`).join('; ');
    throw new Error(`composed flow '${input.roleSet.id}' walled: ${walls}`);
  }
  const validity = deps.evaluateValidity(outcome.spec);
  if (!validity.valid || !validity.compiles) {
    const issues = validity.catalogIssues.join('; ');
    throw new Error(
      `composed flow '${input.roleSet.id}' is offline-invalid (valid=${validity.valid} compiles=${validity.compiles}): ${issues || validity.error || 'no detail'}`,
    );
  }
  const runnability = deps.evaluateRunnability(outcome.spec);
  if (!runnability.runnable) {
    const aborts = runnability.aborts
      .map((a) => `${a.stepId}(${a.schema}): ${a.reason}`)
      .join('; ');
    throw new Error(`composed flow '${input.roleSet.id}' is not runnable: ${aborts}`);
  }

  const schematic = deps.assembleFlowSchematic(outcome.spec);
  const compiled = deps.compileSchematicToCompiledFlow(schematic);
  const files = deps.planCompiledFlowFiles(compiled);
  const main = files.find((file) => file.filename === 'circuit.json');
  if (main === undefined) {
    throw new Error(`composed flow '${input.roleSet.id}' produced no circuit.json`);
  }
  // The slug is the compiled flow's own id (validateCustomFlow requires
  // flow.id === slug). Reading it from the compiled graph keeps the two in step.
  const slug = main.flow.id;

  const flowRoot = join(input.home, 'flows');
  const flowDir = join(flowRoot, slug);
  mkdirSync(flowDir, { recursive: true });
  for (const file of files) {
    writeJson(join(flowDir, file.filename), file.flow);
  }

  const flowPath = join(flowDir, 'circuit.json');
  const manifest = {
    schema_version: 1 as const,
    custom_flows: [
      {
        id: slug,
        description: input.description,
        flow_path: flowPath,
        flow_paths: files.map((file) => join(flowDir, file.filename)),
        skill_path: join(input.home, 'skills', slug, 'SKILL.md'),
        command_path: join(input.home, 'commands', `${slug}.md`),
        published_at: input.createdAt,
      },
    ],
  };
  writeJson(join(input.home, 'manifest.json'), manifest);

  return { slug, flowPath: resolve(flowPath) };
}

// Bind the compile chain from the BUILT dist tree. Used by the harness (launched
// under plain `node`), which builds dist before running. The specifiers are
// computed (not string literals) so `tsc --noEmit` does not try to resolve dist/
// before it is built; node resolves them at runtime. The test binds src deps
// directly instead and never calls this.
export async function loadComposeDepsFromDist(repoRoot: string): Promise<ComposeDeps> {
  const url = (rel: string) => pathToFileURL(resolve(repoRoot, rel)).href;
  const [composition, assemble, compile, filePlan, catalog] = await Promise.all([
    import(url('dist/flows/composition/index.js')),
    import(url('dist/flows/assemble-flow-schematic.js')),
    import(url('dist/flows/compile-schematic-to-flow.js')),
    import(url('dist/flows/compiled-flow-file-plan.js')),
    import(url('dist/flows/catalog.js')),
  ]);
  return {
    composeFlow: composition.composeFlow,
    evaluateValidity: composition.evaluateValidity,
    evaluateRunnability: composition.evaluateRunnability,
    assembleFlowSchematic: assemble.assembleFlowSchematic,
    compileSchematicToCompiledFlow: compile.compileSchematicToCompiledFlow,
    planCompiledFlowFiles: filePlan.planCompiledFlowFiles,
    flowDefinitions: catalog.flowDefinitions,
  };
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
