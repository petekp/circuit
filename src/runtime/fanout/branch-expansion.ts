import { type FanoutBranch, FanoutBranch as FanoutBranchSchema } from '../../schemas/step.js';
import { expandTemplate, resolveDottedPath } from '../../shared/fanout-branch-template.js';
import { resolveRuntimeNumberSource } from '../../shared/runtime-source.js';
import type { FanoutStep } from '../manifest/executable-flow.js';
import type { RunFileStore } from '../run-files/run-file-store.js';
import type { RunContext } from '../run/run-context.js';
import type { ResolvedBranch } from './types.js';

// Lift the branch's evidence off its own source item. A field that is missing,
// empty, or not text fails the expansion instead of quietly handing the worker
// an empty slice: a reviewer that sees nothing reports nothing, and a fanout
// that silently reviews nothing is the exact dishonesty this flow exists to
// avoid.
function itemEvidence(item: unknown, field: string, branchId: string): string {
  if (item === undefined) {
    throw new Error(
      `fanout branch '${branchId}': item_evidence_field needs a dynamic fanout; a static branch has no item to take evidence from`,
    );
  }
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    throw new Error(
      `dynamic fanout branch '${branchId}': item_evidence_field '${field}' needs an object item`,
    );
  }
  const value = (item as Record<string, unknown>)[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `dynamic fanout branch '${branchId}': item field '${field}' must be non-empty text to serve as this branch's evidence`,
    );
  }
  return value;
}

function resolveBranch(branch: FanoutBranch, item?: unknown): ResolvedBranch {
  if ('flow_ref' in branch) {
    return {
      kind: 'sub-run',
      branch_id: branch.branch_id,
      flowRef: branch.flow_ref.flow_id,
      entryMode: branch.flow_ref.entry_mode,
      ...(branch.flow_ref.version === undefined ? {} : { version: branch.flow_ref.version }),
      goal: branch.goal,
      depth: branch.depth,
      ...(branch.selection === undefined ? {} : { selection: branch.selection }),
    };
  }
  return {
    kind: 'relay',
    branch_id: branch.branch_id,
    role: branch.execution.role,
    goal: branch.execution.goal,
    report_schema: branch.execution.report_schema,
    ...(branch.execution.reads === undefined
      ? {}
      : { reads: branch.execution.reads.map((path) => String(path)) }),
    ...(branch.execution.item_evidence_field === undefined
      ? {}
      : {
          item_evidence: itemEvidence(item, branch.execution.item_evidence_field, branch.branch_id),
        }),
    ...(branch.execution.inherit_step_reads === undefined
      ? {}
      : { inherit_step_reads: branch.execution.inherit_step_reads }),
    ...(branch.execution.provenance_field === undefined
      ? {}
      : { provenance_field: branch.execution.provenance_field }),
    ...(branch.execution.max_attempts === undefined
      ? {}
      : { max_attempts: branch.execution.max_attempts }),
    ...(branch.connector === undefined ? {} : { connector: branch.connector }),
    ...(branch.selection === undefined ? {} : { selection: branch.selection }),
  };
}

export async function expandFanoutBranches(
  step: FanoutStep,
  files: RunFileStore,
  context?: Pick<RunContext, 'axes'>,
): Promise<readonly ResolvedBranch[]> {
  const branches = step.branches;

  if (branches.kind === 'static') {
    return branches.branches.map((branch) => resolveBranch(FanoutBranchSchema.parse(branch)));
  }

  const sourceRaw = await files.readJson(branches.source_report);
  const items = resolveDottedPath(sourceRaw, branches.items_path);
  if (!Array.isArray(items)) {
    throw new Error(
      `dynamic fanout: items_path '${branches.items_path}' did not resolve to an array (got ${typeof items})`,
    );
  }
  const maxBranches =
    typeof branches.max_branches === 'number'
      ? branches.max_branches
      : resolveRuntimeNumberSource(branches.max_branches, context?.axes);
  if (branches.required_count !== undefined) {
    const expected = resolveRuntimeNumberSource(branches.required_count, context?.axes);
    if (items.length !== expected) {
      throw new Error(
        `dynamic fanout expected ${expected} items from '${branches.items_path}' but found ${items.length}`,
      );
    }
  }
  if (items.length > maxBranches) {
    throw new Error(
      `dynamic fanout expanded to ${items.length} items but max_branches is ${maxBranches}`,
    );
  }

  const seen = new Set<string>();
  const resolved: ResolvedBranch[] = [];
  for (const item of items) {
    const branch = FanoutBranchSchema.parse(expandTemplate(branches.template, item));
    if (seen.has(branch.branch_id)) {
      throw new Error(`dynamic fanout produced duplicate branch_id '${branch.branch_id}'`);
    }
    seen.add(branch.branch_id);
    resolved.push(resolveBranch(branch, item));
  }
  return resolved;
}
