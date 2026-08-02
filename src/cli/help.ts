// Real help for the CLI: `circuit <cmd> --help`, `circuit help [cmd]`, and
// root `circuit --help` all render from here.
//
// This module owns help routing (resolveHelpInvocation) and help content.
// Commander never renders help for circuit: main() intercepts help requests
// before the forwarding parser in circuit.ts runs, because those forwarding
// stubs parse `<cmd> [args...]` and Commander's generated help for them is an
// empty shell with no flags. Content rules:
//
// - `run` derives its flag list from RUN_EXECUTION_FLAGS
//   (src/cli/run-flag-vocabulary.ts), the single source of truth for the
//   run/resume option surface, so the list cannot drift from the parser.
//   Flags with docValid:false (--dry-run) are hard-rejected at parse time and
//   must not be taught anywhere, including here.
// - Root help is the same front-door page bare `circuit` prints in a pipe
//   (src/cli/front-door.ts), so discovery has one source of truth.
// - Every other command carries a hand-authored block in COMMAND_HELP below.
//   The Record is keyed by CliCommandName, so adding a command word to the
//   vocabulary is a type error here until its help exists.
import { CLI_COMMAND_NAMES, type CliCommandName } from './command-vocabulary.js';
import { renderFrontDoor } from './front-door.js';
import { RUN_EXECUTION_FLAGS } from './run-flag-vocabulary.js';
import { CLI_RUNTIME_ROUTING_POLICY } from './runtime-routing-policy.js';

export type HelpInvocation =
  | { readonly kind: 'root' }
  | { readonly kind: 'command'; readonly command: CliCommandName }
  | { readonly kind: 'unknown-command'; readonly word: string };

const HELP_FLAGS = new Set(['--help', '-h']);

function isCommandName(word: string): word is CliCommandName {
  return (CLI_COMMAND_NAMES as readonly string[]).includes(word);
}

// The command vocabulary as prose: 'run, resume, ..., or version'.
export function commandWordList(): string {
  const names = CLI_COMMAND_NAMES.slice(0, -1).join(', ');
  return `${names}, or ${CLI_COMMAND_NAMES[CLI_COMMAND_NAMES.length - 1]}`;
}

// Classify argv as a help request, or return undefined so normal dispatch
// proceeds. Handles root `--help`/`-h`, the `help [topic]` command, and
// `<cmd> ... --help` with the help token anywhere before a `--` terminator
// (after `--`, a help token is payload for the command, not a request).
export function resolveHelpInvocation(argv: readonly string[]): HelpInvocation | undefined {
  const first = argv[0];
  if (first === undefined) return undefined;
  if (HELP_FLAGS.has(first)) return { kind: 'root' };
  if (first === 'help') {
    const topic = argv[1];
    if (topic === undefined || topic === 'help') return { kind: 'root' };
    if (isCommandName(topic)) return { kind: 'command', command: topic };
    return { kind: 'unknown-command', word: topic };
  }
  if (!isCommandName(first)) return undefined;
  const rest = argv.slice(1);
  const terminator = rest.indexOf('--');
  const scope = terminator === -1 ? rest : rest.slice(0, terminator);
  if (scope.some((token) => HELP_FLAGS.has(token))) return { kind: 'command', command: first };
  return undefined;
}

export function renderRootHelp(): string {
  return renderFrontDoor();
}

interface FlagHelp {
  readonly flag: string;
  readonly blurb: string;
}

interface CommandHelp {
  readonly summary: string;
  readonly usage: readonly string[];
  readonly flags: readonly FlagHelp[];
  readonly notes?: readonly string[];
  readonly example: string;
  readonly next: string;
}

// Hand-authored blurbs for the vocabulary-derived run flag list. The list
// itself always comes from RUN_EXECUTION_FLAGS; a new flag without a blurb
// here still appears in help, just without a description.
const RUN_FLAG_BLURBS: Readonly<Record<string, string>> = {
  '--goal': 'what the run must accomplish (required)',
  '--why': 'why the goal matters; extra context the run may use',
  '--target':
    'what to work on, named outright; Review takes working-tree, staged, unstaged, commit:<ref>, a range like main...HEAD, or a path like src/auth',
  '--process': 'thoroughness override; normally derived from --power',
  '--power': 'model dial; default medium, auto lets the run pick within configured bounds',
  '--tournament': 'fan out branches and select one; optional count, default 3',
  '--autonomous': 'auto-resolve supported checkpoints in a bounded continuation loop',
  '--run-folder': 'where the run stores its trace, reports, and evidence',
  '--fixture': 'compiled flow file to load; trusted paths only',
  '--flow-root': 'load flows from this root instead of the packaged flows',
  '--checkpoint-choice': 'used by resume; answers the pending checkpoint',
  '--checkpoint-response': 'used by resume; carries a reviewed choice and comments',
  '--checkpoint-response-file':
    'used by resume; reads a regular JSON file (relative paths use the current directory)',
  '--checkpoint-review':
    'used by resume; regenerate the local review page and continue when Done is pressed',
  '--progress': 'stream progress events; use jsonl',
  '--include-untracked-content': 'let Review send untracked file contents to the configured worker',
  '--reuse-children-from':
    "reuse finished child branches from a prior crashed run's folder (fresh runs only)",
};

function runFlagHelp(): readonly FlagHelp[] {
  return RUN_EXECUTION_FLAGS.filter((row) => row.docValid).map((row) => ({
    flag: row.valueHint === undefined ? row.flag : `${row.flag} ${row.valueHint}`,
    blurb: RUN_FLAG_BLURBS[row.flag] ?? '',
  }));
}

const EXIT_CODE_NOTE =
  'Exit codes: 0 = run complete or paused at a checkpoint, 1 = closed short of complete, 2 = usage error.';

const COMMAND_HELP: Readonly<Record<CliCommandName, CommandHelp>> = {
  run: {
    summary: 'execute one flow against a goal, with evidence and a report',
    usage: ['circuit run <flow-name> --goal "<goal>" [options]'],
    flags: runFlagHelp(),
    notes: [
      'The flow name is required: pass one of build|fix|review|explore|prototype|pursue, or a published custom flow name.',
      'Routing is model-only; the host or operator names the flow, and the CLI never classifies the goal text.',
      '--power also derives the process level, clamped to what the flow supports. An explicit --process wins.',
      'Config layers: ~/.config/circuit/config.yaml, then ./.circuit/config.yaml, then flags. Later layers win.',
      CLI_RUNTIME_ROUTING_POLICY,
      EXIT_CODE_NOTE,
    ],
    example: 'circuit run fix --goal "fix the flaky retry test in tests/runner"',
    next: 'circuit checkpoints lists paused runs; circuit runs show --run-folder <path> --json inspects a finished run.',
  },
  resume: {
    summary: 'continue a paused run by answering its checkpoint',
    usage: [
      'circuit resume --run-folder <path> (--checkpoint-review | --checkpoint-choice <choice> | --checkpoint-response <response> | --checkpoint-response-file <path>) [--progress jsonl]',
    ],
    flags: [
      { flag: '--run-folder <path>', blurb: 'the paused run folder (required)' },
      {
        flag: '--checkpoint-review',
        blurb: 'regenerate the local review page; Done saves comments and continues the run',
      },
      {
        flag: '--checkpoint-choice <choice>',
        blurb: 'a bare checkpoint answer; manual fallback without review comments',
      },
      {
        flag: '--checkpoint-response <response>',
        blurb: 'a typed choice and comments prepared by the HTML review page',
      },
      {
        flag: '--checkpoint-response-file <path>',
        blurb: 'an explicit regular JSON export, at most 64 KiB; relative to current directory',
      },
      { flag: '--progress <format>', blurb: 'stream progress events; use jsonl' },
    ],
    notes: [
      'Choose exactly one review, choice, token, or file response form. Static HTML keeps manual copy and export available; opening or saving a file never approves a checkpoint by itself.',
      EXIT_CODE_NOTE,
    ],
    example: 'circuit resume --run-folder .circuit/runs/<run_id> --checkpoint-review',
    next: 'circuit checkpoints shows every paused run and the choices it is waiting on.',
  },
  handoff: {
    summary: 'save, resume, or finish a continuity record for cross-session work',
    usage: [
      'circuit handoff [save] [--goal <goal>] [--next <next>] [--run-folder <path>]',
      'circuit handoff resume | done | brief | harvest [--json]',
      'circuit handoff hooks install [--launcher <path>]',
    ],
    flags: [
      { flag: '--goal <goal>', blurb: 'the goal the next session should pick up' },
      { flag: '--next <next>', blurb: 'the concrete next step to take on resume' },
      { flag: '--run-folder <path>', blurb: 'attach the record to a live run folder' },
      { flag: '--json', blurb: 'machine-readable output' },
      { flag: '--progress <format>', blurb: 'stream progress events; use jsonl' },
    ],
    notes: [
      'save is the default action.',
      'hook is the host-invoked entry; hosts pass --source and the hook payload on stdin.',
    ],
    example: 'circuit handoff brief',
    next: 'circuit handoff resume picks the saved record back up in a new session.',
  },
  history: {
    summary: 'search and maintain the cross-run history index',
    usage: [
      'circuit history rebuild [--json]',
      'circuit history query "<text>" [--flow <id>] [--kind <run|report|trace|checkpoint>] [--json]',
      'circuit history pull "<text>" --flow <id> --decision-point <label> --run-folder <path>',
      'circuit history status [--json]',
      'circuit history memory-merge [--write] [--json]',
      'circuit history memory-effect [--write] [--json]',
    ],
    flags: [
      { flag: '--runs-base <path>', blurb: 'override where recorded runs are read from' },
      { flag: '--index-dir <path>', blurb: 'override where the index lives' },
      { flag: '--limit <n>', blurb: 'cap the number of results' },
      { flag: '--per-run-limit <n>', blurb: 'cap results per run' },
      { flag: '--rebuild-if-stale', blurb: 'rebuild the index first when it is out of date' },
    ],
    example: 'circuit history query "flaky test" --json',
    next: 'circuit memory note records an operator note future runs can surface.',
  },
  memory: {
    summary: 'record and manage operator notes that future runs can surface',
    usage: [
      'circuit memory note "<text>" --flow <flow-id> [--applies-to <kind>]',
      'circuit memory list [--flow <flow-id>] [--json]',
      'circuit memory forget <memory-id>',
    ],
    flags: [
      { flag: '--flow <flow-id>', blurb: 'the flow the note applies to (required for note)' },
      { flag: '--applies-to <kind>', blurb: 'hint category; default operator_note' },
      { flag: '--run-folder <path>', blurb: 'cite a specific run folder instead of the latest' },
      { flag: '--runs-base <path>', blurb: 'override where recorded runs are read from' },
      { flag: '--memory-dir <path>', blurb: 'override where notes are stored' },
      { flag: '--json', blurb: 'machine-readable output' },
    ],
    example: 'circuit memory note "prefer fakes over mocks in this repo" --flow fix',
    next: 'circuit history query searches notes and run evidence together.',
  },
  create: {
    summary: 'create a custom flow from a proven template',
    usage: ['circuit create --description "<flow idea>" [--name <slug>] [--publish --yes]'],
    flags: [
      { flag: '--description <flow idea>', blurb: 'what the flow should do (required)' },
      { flag: '--name <slug>', blurb: 'the flow name; derived from the description when omitted' },
      { flag: '--decompose', blurb: 'force the fully decomposed build shape' },
      { flag: '--publish', blurb: 'publish the flow so circuit run can execute it' },
      { flag: '--yes', blurb: 'skip the publish confirmation' },
      { flag: '--progress <format>', blurb: 'stream progress events; use jsonl' },
    ],
    example: 'circuit create --description "review a pull request for accessibility regressions"',
    next: 'circuit run <name> --goal "<goal>" executes a published custom flow.',
  },
  generate: {
    summary: 'generate a custom flow block-by-block with a model',
    usage: ['circuit generate --description "<task to encode>" [--name <slug>] [--publish --yes]'],
    flags: [
      { flag: '--description <task>', blurb: 'the task the flow should encode (required)' },
      { flag: '--name <slug>', blurb: 'the flow name; derived from the description when omitted' },
      { flag: '--publish', blurb: 'publish the flow so circuit run can execute it' },
      { flag: '--yes', blurb: 'skip the publish confirmation' },
      { flag: '--max-repair <n>', blurb: 'retry budget for schema repair' },
      { flag: '--timeout-ms <ms>', blurb: 'model call timeout' },
      { flag: '--progress <format>', blurb: 'stream progress events; use jsonl' },
    ],
    notes: ['generate calls a model through a connector, so it needs a working connector setup.'],
    example: 'circuit generate --description "port a bug fix across three sibling services"',
    next: 'circuit run <name> --goal "<goal>" executes a published custom flow.',
  },
  uninstall: {
    summary: 'remove the Circuit instruction block and print plugin removal steps',
    usage: ['circuit uninstall [--dir <path>] [--json]'],
    flags: [
      { flag: '--dir <path>', blurb: 'project directory to clean; defaults to the current one' },
      { flag: '--json', blurb: 'machine-readable output' },
    ],
    example: 'circuit uninstall --json',
    next: 'reinstalling the plugin restores the instruction block.',
  },
  runs: {
    summary: 'list recent runs, or inspect one in detail',
    usage: [
      'circuit runs [--project-root <path>] [--runs-base <path>] [--json]',
      'circuit runs show --run-folder <path> --json',
    ],
    flags: [
      { flag: '--runs-base <path>', blurb: 'override where recorded runs are read from' },
      { flag: '--json', blurb: 'machine output (required for show)' },
      { flag: '--run-folder <path>', blurb: 'show only: the run folder to project' },
    ],
    example: 'circuit runs',
    next: 'circuit checkpoints lists runs waiting on a decision.',
  },
  reclaim: {
    summary: 'remove orphaned fanout worktrees left behind by killed runs',
    usage: ['circuit reclaim [--project-root <path>] [--json]'],
    flags: [
      { flag: '--project-root <path>', blurb: 'project to reclaim; defaults to the current one' },
      { flag: '--json', blurb: 'machine-readable output' },
    ],
    notes: ['Safe to run any time; worktrees of live runs are left alone.'],
    example: 'circuit reclaim --json',
    next: 'circuit runs show --run-folder <path> --json explains what a leftover run did.',
  },
  checkpoints: {
    summary: 'list pending checkpoints across active runs',
    usage: ['circuit checkpoints [--project-root <path>] [--runs-base <path>] [--json]'],
    flags: [
      { flag: '--project-root <path>', blurb: 'project to scan; defaults to the current one' },
      { flag: '--runs-base <path>', blurb: 'override where recorded runs are read from' },
      { flag: '--json', blurb: 'machine-readable output' },
    ],
    example: 'circuit checkpoints --json',
    next: 'circuit resume --run-folder <path> --checkpoint-choice <choice> answers one.',
  },
  demo: {
    summary: 'run Fix for real against a throwaway project built to have one fixable bug',
    usage: ['circuit demo [--dir <path>] [--power <auto|low|medium|high>]'],
    flags: [
      {
        flag: '--dir <path>',
        blurb: 'where to create the demo project; defaults to a temp directory',
      },
      {
        flag: '--power <auto|low|medium|high>',
        blurb: 'model dial for the demo run; defaults to low',
      },
    ],
    notes: [
      'The demo writes a small git repository with a failing test, then runs Fix against it. It never touches your own checkout.',
      'This is a real run with real model cost. It is small on purpose, but it is not free.',
    ],
    example: 'circuit demo',
    next: 'circuit run fix --goal "..." points the same flow at your own work.',
  },
  preview: {
    summary: 'show the connector, model, and effort each relay step would use, spawn-free',
    usage: ['circuit preview [flow] [--power <auto|low|medium|high>] [--matrix] [--json]'],
    flags: [
      { flag: '--power <auto|low|medium|high>', blurb: 'preview under this model dial setting' },
      { flag: '--matrix', blurb: 'every flow by every power setting' },
      { flag: '--json', blurb: 'machine-readable output' },
    ],
    example: 'circuit preview fix --power high',
    next: 'circuit doctor checks that the chosen connectors are actually ready.',
  },
  doctor: {
    summary: 'check connector health and grade run readiness',
    usage: ['circuit doctor [--json]'],
    flags: [{ flag: '--json', blurb: 'machine-readable output' }],
    notes: [
      'Readiness is graded on the connectors your flows would actually use; other connectors are reported informationally.',
    ],
    example: 'circuit doctor',
    next: 'circuit preview shows which connector each relay step would use.',
  },
  config: {
    summary: 'read and edit the layered selection config',
    usage: [
      'circuit config [show] [--json]',
      'circuit config set <key> <value> [--project|--global]',
      'circuit config unset <key> [--project|--global]',
    ],
    flags: [
      { flag: '--project', blurb: 'target ./.circuit/config.yaml (default)' },
      { flag: '--global', blurb: 'target ~/.config/circuit/config.yaml' },
      { flag: '--json', blurb: 'machine-readable output (show only)' },
    ],
    example: 'circuit config set defaults.power high',
    next: 'circuit preview shows the selections your config produces.',
  },
  version: {
    summary: 'print the Circuit version',
    usage: ['circuit version [--json]'],
    flags: [{ flag: '--json', blurb: 'include runtime provenance fields' }],
    example: 'circuit version --json',
    next: 'circuit doctor checks the connectors this install would use.',
  },
};

function renderHelp(name: CliCommandName, help: CommandHelp): string {
  const lines: string[] = [`circuit ${name}: ${help.summary}`, '', 'usage:'];
  for (const usage of help.usage) lines.push(`  ${usage}`);
  if (help.flags.length > 0) {
    const width = Math.max(...help.flags.map((row) => row.flag.length)) + 2;
    lines.push('', 'flags:');
    for (const row of help.flags) lines.push(`  ${row.flag.padEnd(width)}${row.blurb}`.trimEnd());
  }
  if (help.notes !== undefined && help.notes.length > 0) {
    lines.push('', 'notes:');
    for (const note of help.notes) lines.push(`  ${note}`);
  }
  lines.push('', 'example:', `  ${help.example}`, '', `next: ${help.next}`);
  return lines.join('\n');
}

export function renderCommandHelp(command: CliCommandName): string {
  return renderHelp(command, COMMAND_HELP[command]);
}
