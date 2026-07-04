import { render } from 'ink';
import { createElement } from 'react';
import { flowCatalog } from '../../flows/catalog.js';
import { App } from './app.js';
import type { ShellOutcome } from './state.js';

// Entry point for the TTY face of bare `circuit`. The router lazy-imports
// this module, so Ink/React only load when someone actually opens the shell.
//
// Outcomes that need the terminal back (composing a flow, handing over a run
// command) are executed here after Ink unmounts — the shell itself never
// spawns work while it owns the screen.

export async function runInteractiveShell(): Promise<number> {
  let outcome: ShellOutcome = { kind: 'quit' };
  const instance = render(
    createElement(App, {
      flows: flowCatalog.flows,
      onOutcome: (value) => {
        outcome = value;
      },
    }),
  );
  await instance.waitUntilExit();

  // Read through an accessor so TypeScript uses the declared union type:
  // control flow keeps the initializer's narrowing on `outcome` because the
  // reassignment happens inside the render callback above.
  const result = ((): ShellOutcome => outcome)();
  if (result.kind === 'generate') {
    // Same dispatch as `circuit generate …` from the router: the confirm
    // screen showed this exact command before the operator pressed enter.
    const { runGenerateCommand } = await import('../generate.js');
    return runGenerateCommand([...result.argv]);
  }
  if (result.kind === 'run-template') {
    process.stdout.write(`${result.command}\n`);
    process.stdout.write('fill in the goal and run it when ready.\n');
    return 0;
  }
  return 0;
}
