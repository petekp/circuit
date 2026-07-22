import { FixBrief, FixVerificationCommand } from '../reports.js';
import type { FixRegressionContract } from '../reports.js';

export type FixBriefProjectorInputs = {
  readonly goal: string;
  readonly verificationCommands: readonly FixVerificationCommand[];
};

function parseSimpleArgv(command: string): string[] | undefined {
  const argv: string[] = [];
  let current = '';
  let quote: "'" | '"' | undefined;
  let tokenStarted = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (char === undefined) continue;

    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
        tokenStarted = true;
        continue;
      }
      if (quote === '"' && char === '\\') {
        const next = command[index + 1];
        if (next === '"' || next === '\\') {
          current += next;
          index += 1;
          tokenStarted = true;
          continue;
        }
      }
      current += char;
      tokenStarted = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (tokenStarted) {
        argv.push(current);
        current = '';
        tokenStarted = false;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      tokenStarted = true;
      continue;
    }

    // Verification executes argv directly, so shell control syntax is rejected.
    if (/[|&;<>()`$]/.test(char)) return undefined;

    current += char;
    tokenStarted = true;
  }

  if (quote !== undefined) return undefined;
  if (tokenStarted) argv.push(current);
  if (argv.length === 0) return undefined;
  if (argv.some((part) => part.length === 0)) return undefined;
  return argv;
}

function explicitRegressionCommand(goal: string): FixVerificationCommand | undefined {
  const match =
    /\bregression command is\s+`([^`]+)`/i.exec(goal) ??
    /\bregression command:\s*`([^`]+)`/i.exec(goal);
  const rawCommand = match?.[1];
  if (rawCommand === undefined) return undefined;
  const argv = parseSimpleArgv(rawCommand);
  if (argv === undefined) return undefined;
  return FixVerificationCommand.parse({
    id: 'fix-regression',
    cwd: '.',
    argv,
    timeout_ms: 600_000,
    max_output_bytes: 200_000,
    env: {},
  });
}

function commandFromArgv(id: string, argv: readonly string[], cwd = '.'): FixVerificationCommand {
  return FixVerificationCommand.parse({
    id,
    cwd,
    argv,
    timeout_ms: 600_000,
    max_output_bytes: 200_000,
    env: {},
  });
}

function trimInlineCwd(value: string): string | undefined {
  const unquoted = /^`([^`]+)`$/u.exec(value.trim())?.[1] ?? value;
  const cwd = unquoted
    .trim()
    .replace(/[.:;,]+$/u, '')
    .trim();
  if (/^(?:the\s+)?(?:workspace|project|repo|repository)\s+root$/iu.test(cwd)) return '.';
  if (cwd.length === 0 || cwd.includes('\0')) return undefined;
  if (/\s/.test(cwd)) return undefined;
  if (cwd.startsWith('/') || cwd.split('/').some((segment) => segment === '..')) return undefined;
  return cwd;
}

function explicitInlineVerifyWithCommand(
  goal: string,
  id: string,
): FixVerificationCommand | undefined {
  const match =
    /\bverify with\s+`([^`]+)`\s+from\s+(?:(`[^`]+`)|((?:the\s+)?(?:workspace|project|repo|repository)\s+root)|([^\s`]+))/iu.exec(
      goal,
    );
  const rawCommand = match?.[1];
  const rawCwd = match?.[2] ?? match?.[3] ?? match?.[4];
  if (rawCommand === undefined || rawCwd === undefined) return undefined;
  const argv = parseSimpleArgv(rawCommand);
  const cwd = trimInlineCwd(rawCwd);
  if (argv === undefined || cwd === undefined) return undefined;
  return commandFromArgv(id, argv, cwd);
}

function explicitInlineVerifyWithCommands(goal: string): readonly FixVerificationCommand[] {
  const command = explicitInlineVerifyWithCommand(goal, 'fix-objective-1');
  return command === undefined ? [] : [command];
}

export function explicitObjectiveCheckCommands(goal: string): readonly FixVerificationCommand[] {
  const match =
    /\bObjective check commands:\s*\n([\s\S]*?)(?:\n\n|\nAllowed changed files:|$)/i.exec(goal);
  const rawSection = match?.[1];
  if (rawSection === undefined) return explicitInlineVerifyWithCommands(goal);

  const commands: FixVerificationCommand[] = [];
  const seen = new Set<string>();
  for (const line of rawSection.split('\n')) {
    const rawCommand = /^\s*-\s+(.+?)\s*$/.exec(line)?.[1];
    if (rawCommand === undefined) continue;
    const argv = parseSimpleArgv(rawCommand);
    if (argv === undefined) continue;
    const key = argv.join('\0');
    if (seen.has(key)) continue;
    seen.add(key);
    commands.push(commandFromArgv(`fix-objective-${commands.length + 1}`, argv));
  }
  return commands;
}

function regressionContractForGoal(goal: string): FixRegressionContract {
  const command =
    explicitRegressionCommand(goal) ?? explicitInlineVerifyWithCommand(goal, 'fix-regression');
  if (command === undefined) {
    return {
      expected_behavior: `After fix: ${goal}`,
      actual_behavior: `Before fix: ${goal}`,
      repro: {
        kind: 'not-reproducible',
        deferred_reason:
          'Default Fix brief — operator-supplied repro evidence not available at frame time',
      },
      regression_test: {
        status: 'deferred',
        deferred_reason:
          'Default Fix brief — regression-test authoring deferred until repro evidence is supplied',
      },
    };
  }

  return {
    expected_behavior: `After fix: ${goal}`,
    actual_behavior: `Before fix: ${goal}`,
    repro: {
      kind: 'command',
      command,
    },
    regression_test: {
      status: 'failing-before-fix',
      command,
    },
  };
}

export function projectFixBrief(inputs: FixBriefProjectorInputs): FixBrief {
  return FixBrief.parse({
    problem_statement: inputs.goal,
    expected_behavior: `Resolve: ${inputs.goal}`,
    observed_behavior: `Currently: ${inputs.goal}`,
    scope: inputs.goal,
    regression_contract: regressionContractForGoal(inputs.goal),
    success_criteria: [`Demonstrate the fix addresses: ${inputs.goal}`],
    verification_command_candidates: inputs.verificationCommands,
  });
}
