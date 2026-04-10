import { existsSync, readFileSync } from "node:fs";

import {
  appendValidatedEvents,
  assertNextStepExists,
  assertCommandStepUsable,
  getRouteTarget,
  isTerminalRoute,
  loadRunContext,
  maybeAppendArtifactWrittenEvent,
  recordEventsAndRender,
  resolveStepArtifactPath,
  terminalStatusForRoute,
} from "./command-support.js";
import { requireStepById } from "./manifest-utils.js";
import { extractH2SectionBodies } from "./markdown-utils.js";
import { resolveRunRelativePath } from "./path-utils.js";

export interface CompleteSynthesisOptions {
  route?: string;
  runRoot: string;
  step: string;
}

export interface CompleteSynthesisResult {
  activeRunPath: string;
  gatePassed: boolean;
  noOp: boolean;
  route?: string;
  status: string;
  step: string;
}

function validateRequiredSections(
  markdownPath: string,
  required: string[],
): void {
  const markdown = readFileSync(markdownPath, "utf-8");
  const sections = extractH2SectionBodies(markdown);
  const missing = required.filter((heading) => !sections[heading] || sections[heading].trim().length === 0);

  if (missing.length > 0) {
    throw new Error(`missing required sections: ${missing.join(", ")}`);
  }
}

export function completeSynthesisStep(
  options: CompleteSynthesisOptions,
): CompleteSynthesisResult {
  const context = loadRunContext(options.runRoot);
  const step = requireStepById(context.manifest, options.step);
  const stepId = step.id;

  if (step.executor !== "orchestrator" || step.kind !== "synthesis") {
    throw new Error(`step ${stepId} is not an orchestrator synthesis step`);
  }

  const precondition = assertCommandStepUsable({
    allowCompletedStepNoOp: true,
    allowedStatuses: ["in_progress"],
    commandName: "complete-synthesis",
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

  const artifactPath = resolveStepArtifactPath(step);
  if (!artifactPath) {
    throw new Error(`step ${stepId} has no artifact path`);
  }

  const artifactFullPath = resolveRunRelativePath(context.runRoot, artifactPath);
  if (!existsSync(artifactFullPath)) {
    throw new Error(`artifact not found: ${artifactPath}`);
  }

  const route = assertNextStepExists(
    context.manifest,
    getRouteTarget(step, "pass", options.route),
  );

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
  }

  const gate = (step.gate ?? {}) as Record<string, any>;
  if (gate.kind === "schema_sections") {
    try {
      validateRequiredSections(
        artifactFullPath,
        Array.isArray(gate.required) ? gate.required : [],
      );
    } catch (error) {
      recordEventsAndRender(context.runRoot, []);
      throw error;
    }
  } else {
    recordEventsAndRender(context.runRoot, []);
    throw new Error(`unsupported synthesis gate for ${stepId}: ${String(gate.kind)}`);
  }

  const transitionEvents: typeof events = [];
  transitionEvents.push({
    eventType: "gate_passed",
    payload: {
      step_id: stepId,
      gate_kind: gate.kind,
      route,
    },
    stepId,
  });

  if (isTerminalRoute(route)) {
    transitionEvents.push({
      eventType: "run_completed",
      payload: {
        status: terminalStatusForRoute(route),
        terminal_target: route,
      },
      stepId,
    });
  } else {
    transitionEvents.push({
      eventType: "step_started",
      payload: {
        step_id: route,
      },
      stepId: route,
    });
  }

  const renderResult = recordEventsAndRender(context.runRoot, transitionEvents);
  return {
    activeRunPath: renderResult.activeRunPath,
    gatePassed: true,
    noOp: false,
    route,
    status: renderResult.status,
    step: stepId,
  };
}
