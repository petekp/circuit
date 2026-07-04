import { join } from 'node:path';

// Human-facing status lines for interactive terminals. A default run prints
// nothing until its final JSON envelope, which reads as a hang during a
// multi-minute run and buries the "what now" when it parks at a checkpoint.
// These lines go to stderr, and only when stderr is a real terminal without
// --progress jsonl, so the stdout JSON envelope contract and machine progress
// streams are untouched. Builders are pure; the gate is the one predicate.

export function ttyNoticesEnabled(input: {
  readonly stream: { readonly isTTY?: boolean };
  readonly progressJsonl: boolean;
}): boolean {
  return input.stream.isTTY === true && !input.progressJsonl;
}

export function runStartedNotice(input: {
  readonly flowName: string;
  readonly entryModeName?: string;
  readonly runFolder: string;
}): string {
  const mode = input.entryModeName === undefined ? '' : ` (${input.entryModeName})`;
  return [
    `Running ${input.flowName}${mode}. This can take a while.`,
    `Reports land in ${join(input.runFolder, 'reports')} while the run works.`,
    '',
  ].join('\n');
}

export function checkpointWaitingNotice(input: {
  readonly runFolder: string;
  readonly choices: readonly string[];
  readonly summaryHtmlPath?: string;
}): string {
  const lines = [
    '',
    'This run is paused and waiting for your decision.',
    `Choices: ${input.choices.join(', ')}`,
    `Resume with: circuit resume --run-folder ${input.runFolder} --checkpoint-choice <choice>`,
  ];
  if (input.summaryHtmlPath !== undefined) {
    lines.push(`Decision page: ${input.summaryHtmlPath}`);
  }
  lines.push('');
  return lines.join('\n');
}

export function runFinishedNotice(input: {
  readonly outcome: string;
  readonly runFolder: string;
}): string {
  return `\nRun finished: ${input.outcome}. Reports: ${join(input.runFolder, 'reports')}\n`;
}
