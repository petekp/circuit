// Saying which report was missing, and who was supposed to write it.
//
// A step that reads a report which is not there fails with Node's own words:
//
//   step 'plan-step' handler threw: ENOENT: no such file or directory, open
//   '/Users/someone/.circuit/runs/20260802-.../reports/prototype/brief.json'
//
// Three problems with that as the last thing a run says. It leads with an errno
// constant. It quotes an absolute path that is mostly the machine's business.
// And it stops exactly where the useful part starts: the run knows its own
// graph, so it knows which step was supposed to produce that file, and it never
// says.
//
// This module answers the third one, which makes the other two worth fixing on
// the way past. The flow is the authority — the producer is looked up in the
// step list, never guessed from the path.

import type { ExecutableFlow } from '../manifest/executable-flow.js';

// Node's message for a file that is not there. The path is the last quoted
// segment; the leading `open`/`stat`/`lstat` varies by syscall.
const ENOENT_MESSAGE = /^ENOENT: no such file or directory, \w+ '(.+)'$/;

function runRelative(runDir: string, absolutePath: string): string {
  const prefix = runDir.endsWith('/') ? runDir : `${runDir}/`;
  return absolutePath.startsWith(prefix) ? absolutePath.slice(prefix.length) : absolutePath;
}

function producerStepId(flow: ExecutableFlow, reportPath: string): string | undefined {
  for (const step of flow.steps) {
    for (const ref of Object.values(step.writes ?? {})) {
      if (ref.path === reportPath) return step.id;
    }
  }
  return undefined;
}

/**
 * The reason to record when a step failed because a report it reads is absent.
 *
 * Returns undefined for anything that is not a missing-file failure, so the
 * caller keeps the engine's original message. Half-translating a reason is
 * worse than leaving it alone.
 */
export function missingInputReason(input: {
  readonly flow: ExecutableFlow;
  readonly runDir: string;
  readonly stepId: string;
  readonly message: string;
}): string | undefined {
  const match = ENOENT_MESSAGE.exec(input.message.trim());
  const absolutePath = match?.[1];
  if (absolutePath === undefined) return undefined;
  const reportPath = runRelative(input.runDir, absolutePath);
  const producer = producerStepId(input.flow, reportPath);
  const opening = `step '${input.stepId}' needs '${reportPath}', which is not in the run folder`;
  // No producer means the flow asks a step to read something no step in it
  // writes. That is an authoring fault rather than a run-time one, and naming
  // it as such is more useful than sending the operator looking for a file.
  if (producer === undefined) {
    return `${opening}. No step in this flow writes that report, so nothing in this run could have produced it.`;
  }
  if (producer === input.stepId) {
    return `${opening}. This step writes that report itself, so it failed before or during its own write.`;
  }
  return `${opening}. '${producer}' writes that report; it did not run, or it ran without writing.`;
}
