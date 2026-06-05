import {
  findCloseBuilder,
  resolveCloseReadPaths,
} from '../../flows/registries/close-writers/registry.js';
import {
  findComposeBuilder,
  resolveComposeReadPaths,
} from '../../flows/registries/compose-writers/registry.js';
import type { StepOutcome } from '../domain/step.js';
import type { ComposeStep } from '../manifest/executable-flow.js';
import { runtimeConnectorPlanner } from '../run/connector-planning.js';
import type { RunContext } from '../run/run-context.js';
import { type StepExecutionContext, stepExecutionContextFromContext } from '../run/run-values.js';
import {
  type StepExecutionResult,
  stepExecutionFailedFrom,
  stepExecutionOutcome,
  unwrapStepExecutionResult,
} from './result.js';
import { readRouteFromReport } from './shared.js';

type ComposeExecutionContext = StepExecutionContext<'compose'>;

async function readJsonReport(context: ComposeExecutionContext, path: string): Promise<unknown> {
  return await context.ports.runFiles.readJson(path);
}

async function readOptionalJsonReport(
  context: ComposeExecutionContext,
  path: string,
  required: boolean,
): Promise<unknown> {
  try {
    return await readJsonReport(context, path);
  } catch (error) {
    if (!required && (error as { readonly code?: unknown }).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function writeRegisteredComposeReport(
  step: ComposeStep,
  context: ComposeExecutionContext,
): Promise<unknown | undefined> {
  const report = step.writes?.report;
  if (report?.schema === undefined) return undefined;

  const flow = context.run.packageIndex.flow;
  const indexedStep = context.indexedStep;
  const composeBuilder = findComposeBuilder(report.schema);
  if (composeBuilder !== undefined) {
    const readPaths = resolveComposeReadPaths(composeBuilder, flow, indexedStep);
    const inputs: Record<string, unknown | undefined> = {};
    for (const [name, path] of Object.entries(readPaths)) {
      inputs[name] = path === undefined ? undefined : await readJsonReport(context, path);
    }
    const body = composeBuilder.build({
      runFolder: context.ports.runDirectory.path,
      flow,
      step: indexedStep,
      goal: context.run.goal,
      ...(context.run.axes === undefined ? {} : { axes: context.run.axes }),
      ...(context.ports.worktree.projectRoot === undefined
        ? {}
        : { projectRoot: context.ports.worktree.projectRoot }),
      ...(context.ports.worktree.evidencePolicy === undefined
        ? {}
        : { evidencePolicy: context.ports.worktree.evidencePolicy }),
      ...(context.ports.selection.configLayers === undefined
        ? {}
        : { selectionConfigLayers: context.ports.selection.configLayers }),
      connectorPlanner: runtimeConnectorPlanner,
      inputs,
    });
    await context.ports.runFiles.writeJson(report, body);
    return body;
  }

  const closeBuilder = findCloseBuilder(report.schema);
  if (closeBuilder !== undefined) {
    const readPaths = resolveCloseReadPaths(closeBuilder, flow, indexedStep);
    const inputs: Record<string, unknown | undefined> = {};
    for (const descriptor of closeBuilder.reads) {
      const path = readPaths[descriptor.name];
      inputs[descriptor.name] =
        path === undefined
          ? undefined
          : await readOptionalJsonReport(context, path, descriptor.required);
    }
    const body = closeBuilder.build({
      runFolder: context.ports.runDirectory.path,
      flow,
      closeStep: indexedStep,
      goal: context.run.goal,
      inputs,
    });
    await context.ports.runFiles.writeJson(report, body);
    return body;
  }

  throw new Error(
    `no compose report writer registered for schema '${report.schema}' at compose step '${step.id}'`,
  );
}

export async function executeComposeResult(
  step: ComposeStep,
  context: RunContext,
): Promise<StepExecutionResult> {
  return executeComposeWithPorts(
    step,
    stepExecutionContextFromContext(context, step.id, 'compose'),
  );
}

export async function executeComposeWithPorts(
  step: ComposeStep,
  context: ComposeExecutionContext,
): Promise<StepExecutionResult> {
  try {
    if (step.writes?.report?.schema !== undefined) {
      const body = await writeRegisteredComposeReport(step, context);
      await context.ports.traceLog.append({
        run_id: context.run.runId,
        kind: 'step.report_written',
        step_id: step.id,
        attempt: context.run.activeStepAttempt ?? 1,
        report_path: step.writes.report.path,
        report_schema: step.writes.report.schema,
      });
      if (step.routeFromReport !== undefined) {
        const route = readRouteFromReport(body, step.routeFromReport.path);
        if (!Object.hasOwn(step.routes, route)) {
          throw new Error(
            `compose step '${step.id}' route_from_report selected undeclared route '${route}'`,
          );
        }
        return stepExecutionOutcome({
          route,
          details: { writer: step.writer, route_source: 'report' },
        });
      }
      return stepExecutionOutcome({ route: 'pass', details: { writer: step.writer } });
    }

    const body = step.body ?? { stepId: step.id, writer: step.writer };
    const writes = step.writes ?? {};
    await Promise.all(
      Object.values(writes).map((ref) =>
        context.ports.runFiles.writeJson(ref, {
          stepId: step.id,
          writer: step.writer,
          body,
        }),
      ),
    );
    return stepExecutionOutcome({ route: 'pass', details: { writer: step.writer } });
  } catch (error) {
    return stepExecutionFailedFrom(error);
  }
}

export async function executeCompose(step: ComposeStep, context: RunContext): Promise<StepOutcome> {
  return unwrapStepExecutionResult(await executeComposeResult(step, context));
}
