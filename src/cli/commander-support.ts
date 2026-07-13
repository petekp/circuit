// Shared Commander bootstrap and error normalization for the CLI command
// modules. Every command builds a Commander program the same way (override
// process.exit, silence Commander's own stderr writer) and normalizes the
// two CommanderError shapes the same way (a displayed --help exits 0; a
// parse error surfaces its message with Commander's 'error: ' prefix
// stripped). Call sites differ only in whether they throw the normalized
// message or return it, so this module exposes both the throwing parse
// helper and the message extractor.
import { type Command, CommanderError } from 'commander';

// Apply the shared program configuration: exitOverride() turns Commander's
// process.exit into a thrown CommanderError, and the silent writeErr keeps
// Commander from printing its own diagnostics (each command renders its own
// error envelope on stderr/stdout).
export function configureCommanderProgram(program: Command): Command {
  return program.exitOverride().configureOutput({ writeErr: () => {} });
}

// Strip Commander's 'error: ' prefix from a CommanderError message; pass
// through any other error's message unchanged. Used by call sites that
// return the message rather than throw (history, runs).
export function commanderErrorMessage(err: unknown): string {
  if (err instanceof CommanderError) return err.message.replace(/^error: /, '');
  return err instanceof Error ? err.message : String(err);
}

// Commander signals help through two error codes, and neither message is fit
// for an operator: `commander.helpDisplayed` (an explicit --help/-h, help
// already printed, exit 0) and `commander.help` (the internal '(outputHelp)'
// error raised by the help command and by a bare invocation of a program
// that requires a subcommand). Callers that return messages (runs, history,
// memory) use this predicate to substitute their real missing-subcommand
// message instead of leaking the raw '(outputHelp)' token.
export function isCommanderHelpSignal(err: unknown): err is CommanderError {
  return (
    err instanceof CommanderError &&
    (err.code === 'commander.helpDisplayed' || err.code === 'commander.help')
  );
}

// Configure and parse a program, normalizing CommanderError. A successfully
// displayed help (--help/-h, or a help command that printed and would exit
// 0) exits the process with code 0; a help raised as a usage error (bare
// invocation of a subcommand-only program) becomes a plain 'missing
// subcommand' Error rather than leaking '(outputHelp)'; any other
// CommanderError is rethrown as a plain Error carrying the prefix-stripped
// message; non-Commander errors propagate unchanged. Used by call sites
// that throw on parse failure (circuit, handoff, create).
export function parseCommanderOrThrow(program: Command, argv: readonly string[]): void {
  try {
    configureCommanderProgram(program).parse(argv, { from: 'user' });
  } catch (err) {
    if (err instanceof CommanderError && err.code === 'commander.helpDisplayed') process.exit(0);
    if (err instanceof CommanderError && err.code === 'commander.help') {
      if (err.exitCode === 0) process.exit(0);
      throw new Error('missing subcommand');
    }
    if (err instanceof CommanderError) throw new Error(err.message.replace(/^error: /, ''));
    throw err;
  }
}
