// The complete top-level CLI command vocabulary, in dispatch order.
//
// This is the single source of truth for both the Commander forwarding
// setup in circuit.ts (parseTopLevelInvocation) and any consumer that
// needs to reserve the command words — e.g. the custom-flow create
// command's reserved-slug guard. It lives in a dependency-free leaf so
// both circuit.ts and create.ts can import it without forming a module
// initialization cycle.
export const CLI_COMMAND_NAMES = [
  'run',
  'resume',
  'handoff',
  'history',
  'memory',
  'create',
  'generate',
  'uninstall',
  'runs',
  'reclaim',
  'inbox',
  'preview',
  'doctor',
  'config',
  'version',
] as const;

export type CliCommandName = (typeof CLI_COMMAND_NAMES)[number];
