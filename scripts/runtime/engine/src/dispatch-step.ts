import { existsSync, readFileSync } from "node:fs";

import {
  appendValidatedEvents,
  assertNextStepExists,
  assertCommandStepUsable,
  ensureRunRelativeFileExists,
  getRouteTarget,
  isTerminalRoute,
  loadRunContext,
  maybeAppendArtifactWrittenEvent,
  readDispatchReceiptEventPayload,
  recordEventsAndRender,
  resolveStepArtifactPath,
  terminalStatusForRoute,
} from "./command-support.js";
import {
  requireStepById,
  resolveReceiptPath,
  resolveRequestPath,
  resolveResultPath,
} from "./manifest-utils.js";
import { resolveRunRelativePath } from "./path-utils.js";

export interface DispatchStepOptions {
  runRoot: string;
  step: string;
}

export interface ReconcileDispatchOptions {
  completion?: string;
  route?: string;
  runRoot: string;
  step: string;
  verdict?: string;
}

export interface DispatchCommandResult {
  activeRunPath: string;
  attempt: number;
  gatePassed: boolean;
  noOp: boolean;
  route?: string;
  status: string;
  step: string;
}

function normalizeCompletion(value: string): "blocked" | "complete" | "partial" {
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "complete":
      return "complete";
    case "partial":
      return "partial";
    case "blocked":
      return "blocked";
    default:
      throw new Error(`unsupported completion value: ${value}`);
  }
}

function getNestedString(
  value: unknown,
  path: string[],
): string | undefined {
  let current = value;

  for (const segment of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return typeof current === "string" && current.length > 0 ? current : undefined;
}

function readResultFileIfNeeded(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function resolveDesiredAttempt(
  state: Record<string, any>,
  stepId: string,
): number {
  const job = state.jobs?.[stepId];
  if (!job) {
    return 1;
  }

  if (job.status === "requested" || job.status === "running") {
    return job.attempt;
  }

  if (job.status === "failed") {
    return job.attempt + 1;
  }

  if (job.status === "complete" && !state.routes?.[stepId]) {
    return job.attempt + 1;
  }

  return job.attempt;
}

function canSkipReconcile(
  state: Record<string, any>,
  stepId: string,
  attempt: number,
  completion: "blocked" | "complete" | "partial",
  verdict: string | undefined,
  resultPath: string,
): boolean {
  const job = state.jobs?.[stepId];
  if (!job || job.attempt !== attempt) {
    return false;
  }

  if ((job.completion ?? "complete") !== completion) {
    return false;
  }

  if ((job.result ?? "") !== resultPath) {
    return false;
  }

  if ((job.verdict ?? undefined) !== verdict) {
    return false;
  }

  const expectedStatus = completion === "complete" ? "complete" : "failed";
  return job.status === expectedStatus;
}

export function dispatchStep(
  options: DispatchStepOptions,
): DispatchCommandResult {
  const context = loadRunContext(options.runRoot);
  const step = requireStepById(context.manifest, options.step);
  const stepId = step.id;

  if (step.kind !== "dispatch") {
    throw new Error(`step ${stepId} is not a dispatch step`);
  }

  const precondition = assertCommandStepUsable({
    allowCompletedStepNoOp: true,
    allowedStatuses: ["in_progress", "waiting_worker"],
    commandName: "dispatch-step",
    state: context.state,
    stepId,
  });

  if (precondition.noOp) {
    const renderResult = recordEventsAndRender(context.runRoot, []);
    return {
      activeRunPath: renderResult.activeRunPath,
      attempt: context.state.jobs?.[stepId]?.attempt ?? 1,
      gatePassed: true,
      noOp: true,
      route: precondition.route,
      status: renderResult.status,
      step: stepId,
    };
  }

  const currentJob = context.state.jobs?.[stepId];
  if (context.state.status === "waiting_worker") {
    if (currentJob?.status !== "requested" && currentJob?.status !== "running") {
      throw new Error(
        `dispatch-step cannot recover receipt for step "${stepId}" without a requested or running job`,
      );
    }

    const attempt = currentJob.attempt;
    const receiptPath = resolveReceiptPath(step, stepId, attempt);
    const receiptFullPath = resolveRunRelativePath(context.runRoot, receiptPath);
    const events: Array<{
      attempt?: number;
      eventType: string;
      payload: Record<string, unknown>;
      stepId?: string;
    }> = [];

    if (!currentJob.receipt && existsSync(receiptFullPath)) {
      events.push({
        attempt,
        eventType: "dispatch_received",
        payload: readDispatchReceiptEventPayload(
          receiptFullPath,
          receiptPath,
          stepId,
          attempt,
        ),
        stepId,
      });
    }

    const renderResult = recordEventsAndRender(context.runRoot, events);
    return {
      activeRunPath: renderResult.activeRunPath,
      attempt,
      gatePassed: false,
      noOp: events.length === 0,
      status: renderResult.status,
      step: stepId,
    };
  }

  const attempt = resolveDesiredAttempt(context.state, stepId);
  const requestPath = resolveRequestPath(step, stepId, attempt);
  const receiptPath = resolveReceiptPath(step, stepId, attempt);
  const receiptFullPath = resolveRunRelativePath(context.runRoot, receiptPath);
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

  ensureRunRelativeFileExists(context.runRoot, requestPath, "dispatch request");

  events.push({
    attempt,
    eventType: "dispatch_requested",
    payload: {
      attempt,
      protocol: step.protocol,
      request_path: requestPath,
    },
    stepId,
  });

  if (existsSync(receiptFullPath)) {
    events.push({
      attempt,
      eventType: "dispatch_received",
      payload: readDispatchReceiptEventPayload(
        receiptFullPath,
        receiptPath,
        stepId,
        attempt,
      ),
      stepId,
    });
  }

  const renderResult = recordEventsAndRender(context.runRoot, events);
  return {
    activeRunPath: renderResult.activeRunPath,
    attempt,
    gatePassed: false,
    noOp: false,
    status: renderResult.status,
    step: stepId,
  };
}

export function reconcileDispatch(
  options: ReconcileDispatchOptions,
): DispatchCommandResult {
  const context = loadRunContext(options.runRoot);
  const step = requireStepById(context.manifest, options.step);
  const stepId = step.id;

  if (step.kind !== "dispatch") {
    throw new Error(`step ${stepId} is not a dispatch step`);
  }

  const precondition = assertCommandStepUsable({
    allowCompletedStepNoOp: true,
    allowedStatuses: ["waiting_worker"],
    commandName: "reconcile-dispatch",
    state: context.state,
    stepId,
  });

  if (precondition.noOp) {
    const renderResult = recordEventsAndRender(context.runRoot, []);
    return {
      activeRunPath: renderResult.activeRunPath,
      attempt: context.state.jobs?.[stepId]?.attempt ?? 1,
      gatePassed: true,
      noOp: true,
      route: precondition.route,
      status: renderResult.status,
      step: stepId,
    };
  }

  const currentJob = context.state.jobs?.[stepId];
  if (currentJob?.status !== "requested" && currentJob?.status !== "running") {
    throw new Error(
      `reconcile-dispatch cannot run for step "${stepId}" without a requested or running job`,
    );
  }

  const attempt = currentJob.attempt ?? 1;
  const receiptPath = resolveReceiptPath(step, stepId, attempt);
  const resultPath = resolveResultPath(step, stepId, attempt);
  const receiptFullPath = resolveRunRelativePath(context.runRoot, receiptPath);
  const resultFullPath = ensureRunRelativeFileExists(
    context.runRoot,
    resultPath,
    "dispatch result",
  );
  const events: Array<{
    attempt?: number;
    eventType: string;
    payload: Record<string, unknown>;
    stepId?: string;
  }> = [];

  if (!context.state.jobs?.[stepId]?.receipt && existsSync(receiptFullPath)) {
    events.push({
      attempt,
      eventType: "dispatch_received",
      payload: readDispatchReceiptEventPayload(
        receiptFullPath,
        receiptPath,
        stepId,
        attempt,
      ),
      stepId,
    });
  }

  let parsedResult: unknown;
  const needParsedResult = !options.completion || !options.verdict;
  if (needParsedResult) {
    parsedResult = readResultFileIfNeeded(resultFullPath);
  }

  const passList = Array.isArray((step.gate as Record<string, any>).pass)
    ? ((step.gate as Record<string, any>).pass as string[])
    : [];
  const completionCandidate =
    options.completion ??
    getNestedString(parsedResult, ["completion"]) ??
    getNestedString(parsedResult, ["status"]) ??
    getNestedString(parsedResult, ["claim", "completion"]) ??
    (() => {
      const inferredVerdict =
        options.verdict ??
        getNestedString(parsedResult, ["verdict"]) ??
        getNestedString(parsedResult, ["claim", "verdict"]) ??
        getNestedString(parsedResult, ["result", "verdict"]);
      return inferredVerdict && passList.includes(inferredVerdict)
        ? "complete"
        : undefined;
    })();

  if (!completionCandidate) {
    throw new Error(`could not determine completion from result: ${resultPath}`);
  }

  const completion = normalizeCompletion(completionCandidate);
  const verdict =
    options.verdict ??
    getNestedString(parsedResult, ["verdict"]) ??
    getNestedString(parsedResult, ["claim", "verdict"]) ??
    getNestedString(parsedResult, ["result", "verdict"]);
  const assertedPassRoute =
    options.route !== undefined
      ? assertNextStepExists(
          context.manifest,
          getRouteTarget(step, "pass", options.route),
        )
      : undefined;

  if (
    canSkipReconcile(
      context.state,
      stepId,
      attempt,
      completion,
      verdict,
      resultPath,
    )
  ) {
    const renderResult = recordEventsAndRender(context.runRoot, events);
    return {
      activeRunPath: renderResult.activeRunPath,
      attempt,
      gatePassed: false,
      noOp: events.length === 0,
      status: renderResult.status,
      step: stepId,
    };
  }

  const artifactPath = resolveStepArtifactPath(step);
  if (completion === "complete" && artifactPath) {
    const artifactFullPath = resolveRunRelativePath(context.runRoot, artifactPath);
    if (!existsSync(artifactFullPath)) {
      throw new Error(
        `reconcile-dispatch cannot record completion=complete for step "${stepId}": missing declared artifact ${artifactPath}`,
      );
    }
  }

  const route =
    completion === "complete" && verdict && passList.includes(verdict)
      ? (assertedPassRoute ??
        assertNextStepExists(
          context.manifest,
          getRouteTarget(step, "pass"),
        ))
      : undefined;

  const jobPayload: Record<string, unknown> = {
    attempt,
    completion,
    result_path: resultPath,
  };
  if (verdict) {
    jobPayload.verdict = verdict;
  }
  events.push({
    attempt,
    eventType: "job_completed",
    payload: jobPayload,
    stepId,
  });
  maybeAppendArtifactWrittenEvent(
    context.runRoot,
    {
      ...context.state,
      jobs: {
        ...(context.state.jobs ?? {}),
        [stepId]: {
          ...(context.state.jobs?.[stepId] ?? {}),
          attempt,
          completion,
          result: resultPath,
          status: completion === "complete" ? "complete" : "failed",
          verdict,
        },
      },
    },
    step,
    stepId,
    events,
  );

  if (completion !== "complete" || !verdict || !passList.includes(verdict)) {
    const renderResult = recordEventsAndRender(context.runRoot, events);
    return {
      activeRunPath: renderResult.activeRunPath,
      attempt,
      gatePassed: false,
      noOp: false,
      status: renderResult.status,
      step: stepId,
    };
  }

  if (!route) {
    throw new Error(`reconcile-dispatch could not resolve pass route for ${stepId}`);
  }

  events.push({
    eventType: "gate_passed",
    payload: {
      gate_kind: (step.gate as Record<string, any>).kind,
      route,
      step_id: stepId,
    },
    stepId,
  });

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
    attempt,
    gatePassed: true,
    noOp: false,
    route,
    status: renderResult.status,
    step: stepId,
  };
}
