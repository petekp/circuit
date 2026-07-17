import { isAbsolute, join, resolve } from 'node:path';

type ResumeCommandHostKind = 'claude-code' | 'codex' | 'generic-shell';

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function operatorSummaryResumeCommandPrefix(input: {
  readonly hostKind?: ResumeCommandHostKind | undefined;
  readonly pluginRoot?: string | undefined;
  readonly execPath?: string | undefined;
  readonly cliEntryPath?: string | undefined;
}): string {
  const execPath = input.execPath;
  if (
    execPath !== undefined &&
    isAbsolute(execPath) &&
    input.pluginRoot !== undefined &&
    isAbsolute(input.pluginRoot) &&
    input.hostKind !== undefined &&
    input.hostKind !== 'generic-shell'
  ) {
    const wrapper = join(input.pluginRoot, 'scripts', 'circuit.js');
    const presentation = input.hostKind === 'claude-code' ? ' present' : '';
    return `${shellSingleQuote(execPath)} ${shellSingleQuote(wrapper)}${presentation} resume`;
  }

  if (execPath !== undefined && isAbsolute(execPath) && input.cliEntryPath !== undefined) {
    const entry = isAbsolute(input.cliEntryPath) ? input.cliEntryPath : resolve(input.cliEntryPath);
    return `${shellSingleQuote(execPath)} ${shellSingleQuote(entry)} resume`;
  }

  return 'circuit resume';
}
