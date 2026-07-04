import { render } from 'ink';
import { createElement } from 'react';
import { flowCatalog } from '../../flows/catalog.js';
import { colorEnabled, terminalPalette } from '../terminal-style.js';
import { App } from './app.js';
import { type SessionResult, formatConfigChangeSummary } from './state.js';

// Entry point for the TTY face of bare `circuit`. The router lazy-imports
// this module, so Ink/React only load when someone actually opens the shell.
//
// The shell reports its outcome and its config writes on exit. Anything that
// needs the terminal back (the config-change summary, composing a flow,
// handing over a run command) happens here after Ink unmounts — the shell
// never writes to scrollback or spawns work while it owns the screen.

export async function runInteractiveShell(): Promise<number> {
  let session: SessionResult = { outcome: { kind: 'quit' }, configChanges: [] };
  const instance = render(
    createElement(App, {
      flows: flowCatalog.flows,
      onExit: (value) => {
        session = value;
      },
    }),
  );
  await instance.waitUntilExit();

  // Read through an accessor so TypeScript uses the declared type: control
  // flow keeps the initializer's narrowing because the reassignment happens
  // inside the render callback above.
  const result = ((): SessionResult => session)();

  // The durable record of the session's writes, printed once. This is the
  // teaching surface the in-TUI status line intentionally does not persist.
  const summary = formatConfigChangeSummary(result.configChanges);
  if (summary !== null) {
    const palette = terminalPalette(colorEnabled());
    const [header, ...lines] = summary.split('\n');
    process.stdout.write(`${palette.dim(header ?? '')}\n`);
    for (const line of lines) process.stdout.write(`${palette.dim(line)}\n`);
  }

  const { outcome } = result;
  if (outcome.kind === 'generate') {
    // Same dispatch as `circuit generate …` from the router: the confirm
    // screen showed this exact command before the operator pressed enter.
    const { runGenerateCommand } = await import('../generate.js');
    return runGenerateCommand([...outcome.argv]);
  }
  if (outcome.kind === 'run-template') {
    process.stdout.write(`${outcome.command}\n`);
    process.stdout.write('fill in the goal and run it when ready.\n');
    return 0;
  }
  return 0;
}
