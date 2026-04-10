import { readFileSync } from "node:fs";

import {
  appendValidatedEvents,
  assertNextStepExists,
  assertCommandStepUsable,
  ensureRunRelativeFileExists,
  getRouteTarget,
  isTerminalRoute,
  loadRunContext,
  maybeAppendArtifactWrittenEvent,
  recordEventsAndRender,
  terminalStatusForRoute,
} from "./command-support.js";
import {
  requireStepById,
  resolveRequestPath,
  resolveResponsePath,
} from "./manifest-utils.js";

export interface RequestCheckpointOptions {
  runRoot: string;
  step: string;
}

export interface ResolveCheckpointOptions {
  route?: string;
  runRoot: string;
  selection?: string;
  step: string;
}

export interface CheckpointCommandResult {
  activeRunPath: string;
  gatePassed: boolean;
  noOp: boolean;
  route?: string;
  selection?: string;
  status: string;
  step: string;
}

function parseSelection(
  responsePath: string,
  fallbackSelection?: string,
): string {
  try {
    const parsed = JSON.parse(readFileSync(responsePath, "utf-8")) as Record<string, unknown>;
    if (typeof parsed.selection === "string" && parsed.selection.length > 0) {
      return parsed.selection;
    }
  } catch {
    if (fallbackSelection) {
      return fallbackSelection;
    }
    throw new Error(`could not parse checkpoint response: ${responsePath}`);
  }

  if (fallbackSelection) {
    return fallbackSelection;
  }

  throw new Error(`checkpoint response is missing top-level selection: ${responsePath}`);
}

export function requestCheckpoint(
  options: RequestCheckpointOptions,
): CheckpointCommandResult {
  const context = loadRunContext(options.runRoot);
  const step = requireStepById(context.manifest, options.step);
  const stepId = step.id;

  if (step.kind !== "checkpoint") {
    throw new Error(`step ${stepId} is not a checkpoint step`);
  }

  const checkpointState = context.state.checkpoints?.[stepId];
  if (
    checkpointState?.status === "waiting" &&
    context.state.current_step === stepId &&
    context.state.status === "waiting_checkpoint"
  ) {
    const renderResult = recordEventsAndRender(context.runRoot, []);
    return {
      activeRunPath: renderResult.activeRunPath,
      gatePassed: false,
      noOp: true,
      status: renderResult.status,
      step: stepId,
    };
  }

  const precondition = assertCommandStepUsable({
    allowCompletedStepNoOp: true,
    allowedStatuses: ["in_progress"],
    commandName: "request-checkpoint",
    state: context.state,
    stepId,
  });

  if (precondition.noOp) {
    const renderResult = recordEventsAndRender(context.runRoot, []);
    return {
      activeRunPath: renderResult.activeRunPath,
      gatePassed: true,
      noOp: true,
      route: precondition.route,
      status: renderResult.status,
      step: stepId,
    };
  }

  const attempt = checkpointState?.attempt ?? 1;
  const events: Array<{
    attempt?: number;
    eventType: string;
    payload: Record<string, unknown>;
    stepId?: string;
  }> = [];
  maybeAppendArtifactWrittenEvent(
    context.runRoot,
    context.state,
    step,
    stepId,
    events,
  );
  if (events.length > 0) {
    appendValidatedEvents(context.runRoot, events);
    events.length = 0;
  }

  const requestPath = resolveRequestPath(step, stepId, attempt);
  ensureRunRelativeFileExists(context.runRoot, requestPath, "checkpoint request");

  events.push({
    attempt,
    eventType: "checkpoint_requested",
    payload: {
      attempt,
      checkpoint_kind: (step.checkpoint as Record<string, any>).kind,
      request_path: requestPath,
    },
    stepId,
  });

  const renderResult = recordEventsAndRender(context.runRoot, events);
  return {
    activeRunPath: renderResult.activeRunPath,
    gatePassed: false,
    noOp: false,
    status: renderResult.status,
    step: stepId,
  };
}

export function resolveCheckpoint(
  options: ResolveCheckpointOptions,
): CheckpointCommandResult {
  const context = loadRunContext(options.runRoot);
  const step = requireStepById(context.manifest, options.step);
  const stepId = step.id;

  if (step.kind !== "checkpoint") {
    throw new Error(`step ${stepId} is not a checkpoint step`);
  }

  const precondition = assertCommandStepUsable({
    allowCompletedStepNoOp: true,
    allowedStatuses: ["waiting_checkpoint"],
    commandName: "resolve-checkpoint",
    state: context.state,
    stepId,
  });

  if (precondition.noOp) {
    const renderResult = recordEventsAndRender(context.runRoot, []);
    return {
      activeRunPath: renderResult.activeRunPath,
      gatePassed: true,
      noOp: true,
      route: precondition.route,
      selection: context.state.checkpoints?.[stepId]?.selection,
      status: renderResult.status,
      step: stepId,
    };
  }

  const attempt = context.state.checkpoints?.[stepId]?.attempt ?? 1;
  const responsePath = resolveResponsePath(step, stepId, attempt);
  const responseFullPath = ensureRunRelativeFileExists(
    context.runRoot,
    responsePath,
    "checkpoint response",
  );
  const selection = parseSelection(responseFullPath, options.selection);
  const gate = (step.gate ?? {}) as Record<string, any>;
  const allowList = Array.isArray(gate.allow)
    ? gate.allow.filter((entry): entry is string => typeof entry === "string")
    : [];

  if (!allowList.includes(selection)) {
    throw new Error(
      `selection ${selection} does not satisfy checkpoint gate for ${stepId}`,
    );
  }

  const route = assertNextStepExists(
    context.manifest,
    getRouteTarget(step, selection, options.route),
  );
  const events: Array<{
    attempt?: number;
    eventType: string;
    payload: Record<string, unknown>;
    stepId?: string;
  }> = [
    {
      attempt,
      eventType: "checkpoint_resolved",
      payload: {
        attempt,
        response_path: responsePath,
        selection,
      },
      stepId,
    },
    {
      eventType: "gate_passed",
      payload: {
        gate_kind: gate.kind,
        route,
        step_id: stepId,
      },
      stepId,
    },
  ];

  if (isTerminalRoute(route)) {
    events.push({
      eventType: "run_completed",
      payload: {
        status: terminalStatusForRoute(route),
        terminal_target: route,
      },
      stepId,
    });
  } else {
    events.push({
      eventType: "step_started",
      payload: {
        step_id: route,
      },
      stepId: route,
    });
  }

  const renderResult = recordEventsAndRender(context.runRoot, events);
  return {
    activeRunPath: renderResult.activeRunPath,
    gatePassed: true,
    noOp: false,
    route,
    selection,
    status: renderResult.status,
    step: stepId,
  };
}
