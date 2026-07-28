import { type FanoutBranch, FanoutBranch as FanoutBranchSchema } from '../../schemas/step.js';
import { expandTemplate, resolveDottedPath } from '../../shared/fanout-branch-template.js';
import { resolveRuntimeNumberSource } from '../../shared/runtime-source.js';
import type { FanoutStep } from '../manifest/executable-flow.js';
import type { RunFileStore } from '../run-files/run-file-store.js';
import type { RunContext } from '../run/run-context.js';
import type { ResolvedBranch } from './types.js';

function resolveBranch(branch: FanoutBranch): ResolvedBranch {
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
    ...(branch.execution.provenance_field === undefined
      ? {}
      : { provenance_field: branch.execution.provenance_field }),
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
    resolved.push(resolveBranch(branch));
  }
  return resolved;
}
