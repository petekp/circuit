import { CompiledDepth } from '../../schemas/depth.js';
import { PowerDialSetting } from '../../schemas/power.js';
import { Effort } from '../../schemas/selection-policy.js';

// Pure state machine for the interactive shell. Every keystroke flows through
// `reduce`, which returns the next state plus at most one side effect for the
// component to execute (config writes are the only IO the shell performs
// in-place; everything else is navigation or an exit outcome). Keeping this
// file free of Ink and IO makes the whole interaction model unit-testable
// with plain function calls.
//
// Navigation is a drill-down stack: Enter descends, Esc ascends, and the
// stack itself is the breadcrumb. The parity rule lives here too — every
// action that changes something outside the shell carries the equivalent
// `circuit …` command, committed to scrollback as a receipt so the TUI
// teaches the flag surface as it is used.

export type Scope = 'project' | 'global';
export type DialChoice = 'auto' | 'low' | 'medium' | 'high';
export const DIAL_CYCLE: readonly (DialChoice | undefined)[] = [
  undefined,
  'auto',
  'low',
  'medium',
  'high',
];

export interface FlowSummary {
  readonly id: string;
  readonly title: string;
  readonly purpose: string;
}

// The subset of Ink's Key shape the reducer reads. app.tsx adapts Ink's
// callback into this event; tests construct it directly.
export interface KeyEvent {
  readonly input: string;
  readonly upArrow?: boolean;
  readonly downArrow?: boolean;
  readonly leftArrow?: boolean;
  readonly rightArrow?: boolean;
  readonly return?: boolean;
  readonly escape?: boolean;
  readonly backspace?: boolean;
  readonly delete?: boolean;
}

export interface Receipt {
  readonly id: number;
  readonly ok: boolean;
  readonly text: string;
  // The flag-command equivalent of what just happened (`↳ circuit …`).
  readonly command?: string;
}

export type Screen =
  | { readonly kind: 'home'; readonly cursor: number }
  | {
      readonly kind: 'browse';
      readonly cursor: number;
      readonly filter: string;
      readonly filtering: boolean;
    }
  | {
      readonly kind: 'flow';
      readonly flowId: string;
      readonly dial: DialChoice | undefined;
      readonly matrix: boolean;
    }
  | {
      readonly kind: 'configure';
      readonly scope: Scope;
      readonly cursor: number;
      readonly flowId?: string;
      readonly editing?: { readonly optionIndex: number };
    }
  | {
      readonly kind: 'create';
      readonly stage: 'describe' | 'confirm';
      readonly description: string;
      readonly publish: boolean;
    };

export type ShellOutcome =
  | { readonly kind: 'quit' }
  | { readonly kind: 'generate'; readonly argv: readonly string[] }
  | { readonly kind: 'run-template'; readonly command: string };

export type Effect =
  | {
      readonly kind: 'config-set';
      readonly key: string;
      readonly value: string;
      readonly scope: Scope;
    }
  | { readonly kind: 'config-unset'; readonly key: string; readonly scope: Scope };

export interface ShellState {
  readonly flows: readonly FlowSummary[];
  readonly stack: readonly Screen[];
  readonly receipts: readonly Receipt[];
  readonly nextReceiptId: number;
  // Bumped after every config write so the component recomputes anything
  // derived from the config layers (previews, effective values).
  readonly configVersion: number;
  readonly help: boolean;
  readonly outcome?: ShellOutcome;
}

export type ShellEvent =
  | { readonly type: 'key'; readonly key: KeyEvent }
  | {
      readonly type: 'config-result';
      readonly ok: boolean;
      readonly text: string;
      readonly command?: string;
    };

export interface ReduceResult {
  readonly state: ShellState;
  readonly effect?: Effect;
}

export const HOME_ITEMS = ['Browse flows', 'Configure', 'Create a flow', 'Quit'] as const;

export interface ConfigField {
  readonly key: string;
  readonly label: string;
  readonly options: readonly string[];
}

// The editable vocabulary. Options come from the same zod enums the engine
// validates against, so the menu cannot offer a value `circuit config set`
// would reject. Model pins stay flag-only in v1 (free-form text with a
// provider prefix is a worse fit for a picker than for a flag).
export function configFields(flowId?: string): readonly ConfigField[] {
  const global: ConfigField[] = [
    { key: 'defaults.power', label: 'power dial', options: PowerDialSetting.options },
    {
      key: 'relay.default',
      label: 'default connector',
      options: ['auto', 'claude-code', 'codex', 'cursor-agent'],
    },
  ];
  if (flowId === undefined) return global;
  return [
    ...global,
    {
      key: `circuits.${flowId}.selection.effort`,
      label: `${flowId} effort`,
      options: Effort.options,
    },
    {
      key: `circuits.${flowId}.selection.depth`,
      label: `${flowId} depth`,
      options: CompiledDepth.options,
    },
  ];
}

export function initialState(flows: readonly FlowSummary[]): ShellState {
  return {
    flows,
    stack: [{ kind: 'home', cursor: 0 }],
    receipts: [],
    nextReceiptId: 1,
    configVersion: 0,
    help: false,
  };
}

export function currentScreen(state: ShellState): Screen {
  return state.stack[state.stack.length - 1] as Screen;
}

export function visibleFlows(state: ShellState, screen: Screen): readonly FlowSummary[] {
  if (screen.kind !== 'browse' || screen.filter === '') return state.flows;
  const needle = screen.filter.toLowerCase();
  return state.flows.filter(
    (flow) => flow.id.toLowerCase().includes(needle) || flow.title.toLowerCase().includes(needle),
  );
}

export function breadcrumb(state: ShellState): string {
  const labels = state.stack.map((screen) => {
    if (screen.kind === 'home') return 'home';
    if (screen.kind === 'browse') return 'flows';
    if (screen.kind === 'flow') return screen.flowId;
    if (screen.kind === 'configure') return `configure (${screen.scope})`;
    return 'create';
  });
  return labels.join(' › ');
}

// The flag-command equivalent of the current flow-detail view, shown live in
// the footer and used for the run template.
export function previewCommand(screen: Extract<Screen, { kind: 'flow' }>): string {
  const parts = ['circuit preview', screen.flowId];
  if (screen.dial !== undefined) parts.push(`--power ${screen.dial}`);
  if (screen.matrix) parts.push('--matrix');
  return parts.join(' ');
}

export function configSetCommand(key: string, value: string, scope: Scope): string {
  return `circuit config set ${key} ${value}${scope === 'global' ? ' --global' : ''}`;
}

export function configUnsetCommand(key: string, scope: Scope): string {
  return `circuit config unset ${key}${scope === 'global' ? ' --global' : ''}`;
}

export function generateArgv(description: string, publish: boolean): readonly string[] {
  return ['--description', description, ...(publish ? ['--publish', '--yes'] : [])];
}

export function generateCommand(description: string, publish: boolean): string {
  return `circuit generate --description ${JSON.stringify(description)}${publish ? ' --publish --yes' : ''}`;
}

function replaceTop(state: ShellState, screen: Screen): ShellState {
  return { ...state, stack: [...state.stack.slice(0, -1), screen] };
}

function push(state: ShellState, screen: Screen): ShellState {
  return { ...state, stack: [...state.stack, screen] };
}

function pop(state: ShellState): ShellState {
  if (state.stack.length <= 1) return state;
  return { ...state, stack: state.stack.slice(0, -1) };
}

function withReceipt(state: ShellState, ok: boolean, text: string, command?: string): ShellState {
  const receipt: Receipt = {
    id: state.nextReceiptId,
    ok,
    text,
    ...(command === undefined ? {} : { command }),
  };
  return {
    ...state,
    receipts: [...state.receipts, receipt],
    nextReceiptId: state.nextReceiptId + 1,
  };
}

function quit(state: ShellState): ShellState {
  return { ...state, outcome: { kind: 'quit' } };
}

// True while a screen owns free-text input, which suspends the single-letter
// shortcut layer (q, ?, mnemonics) so typing "quick fix" does not quit.
function isTyping(screen: Screen): boolean {
  if (screen.kind === 'browse') return screen.filtering;
  if (screen.kind === 'create') return screen.stage === 'describe';
  return false;
}

function isPrintable(key: KeyEvent): boolean {
  return (
    key.input.length === 1 &&
    key.return !== true &&
    key.escape !== true &&
    key.backspace !== true &&
    key.delete !== true &&
    // Control characters (Ctrl+…) arrive as code points below 0x20.
    key.input.charCodeAt(0) >= 0x20
  );
}

function moveCursor(cursor: number, delta: number, count: number): number {
  if (count === 0) return 0;
  return Math.min(Math.max(cursor + delta, 0), count - 1);
}

function reduceHome(
  state: ShellState,
  screen: Extract<Screen, { kind: 'home' }>,
  key: KeyEvent,
): ReduceResult {
  if (key.downArrow === true || key.input === 'j') {
    return {
      state: replaceTop(state, {
        ...screen,
        cursor: moveCursor(screen.cursor, 1, HOME_ITEMS.length),
      }),
    };
  }
  if (key.upArrow === true || key.input === 'k') {
    return {
      state: replaceTop(state, {
        ...screen,
        cursor: moveCursor(screen.cursor, -1, HOME_ITEMS.length),
      }),
    };
  }
  if (key.return === true) {
    const item = HOME_ITEMS[screen.cursor];
    if (item === 'Browse flows') {
      return { state: push(state, { kind: 'browse', cursor: 0, filter: '', filtering: false }) };
    }
    if (item === 'Configure') {
      return { state: push(state, { kind: 'configure', scope: 'project', cursor: 0 }) };
    }
    if (item === 'Create a flow') {
      return {
        state: push(state, { kind: 'create', stage: 'describe', description: '', publish: false }),
      };
    }
    return { state: quit(state) };
  }
  return { state };
}

function reduceBrowse(
  state: ShellState,
  screen: Extract<Screen, { kind: 'browse' }>,
  key: KeyEvent,
): ReduceResult {
  const flows = visibleFlows(state, screen);

  if (screen.filtering) {
    if (key.escape === true) {
      return { state: replaceTop(state, { ...screen, filtering: false, filter: '', cursor: 0 }) };
    }
    if (key.return === true) {
      return { state: replaceTop(state, { ...screen, filtering: false }) };
    }
    if (key.backspace === true || key.delete === true) {
      return {
        state: replaceTop(state, { ...screen, filter: screen.filter.slice(0, -1), cursor: 0 }),
      };
    }
    if (key.upArrow === true) {
      return {
        state: replaceTop(state, {
          ...screen,
          cursor: moveCursor(screen.cursor, -1, flows.length),
        }),
      };
    }
    if (key.downArrow === true) {
      return {
        state: replaceTop(state, { ...screen, cursor: moveCursor(screen.cursor, 1, flows.length) }),
      };
    }
    if (isPrintable(key)) {
      return {
        state: replaceTop(state, { ...screen, filter: screen.filter + key.input, cursor: 0 }),
      };
    }
    return { state };
  }

  if (key.escape === true) return { state: pop(state) };
  if (key.downArrow === true || key.input === 'j') {
    return {
      state: replaceTop(state, { ...screen, cursor: moveCursor(screen.cursor, 1, flows.length) }),
    };
  }
  if (key.upArrow === true || key.input === 'k') {
    return {
      state: replaceTop(state, { ...screen, cursor: moveCursor(screen.cursor, -1, flows.length) }),
    };
  }
  if (key.input === 'g') return { state: replaceTop(state, { ...screen, cursor: 0 }) };
  if (key.input === 'G') {
    return { state: replaceTop(state, { ...screen, cursor: Math.max(0, flows.length - 1) }) };
  }
  if (key.input === '/') {
    return { state: replaceTop(state, { ...screen, filtering: true, filter: '', cursor: 0 }) };
  }
  if (key.return === true) {
    const flow = flows[screen.cursor];
    if (flow === undefined) return { state };
    const next = push(state, { kind: 'flow', flowId: flow.id, dial: undefined, matrix: false });
    return {
      state: withReceipt(next, true, `previewing ${flow.id}`, `circuit preview ${flow.id}`),
    };
  }
  return { state };
}

function reduceFlow(
  state: ShellState,
  screen: Extract<Screen, { kind: 'flow' }>,
  key: KeyEvent,
): ReduceResult {
  if (key.escape === true) return { state: pop(state) };
  if (key.input === 'p') {
    const index = DIAL_CYCLE.indexOf(screen.dial);
    const dial = DIAL_CYCLE[(index + 1) % DIAL_CYCLE.length];
    return { state: replaceTop(state, { ...screen, dial }) };
  }
  if (key.input === 'm') {
    return { state: replaceTop(state, { ...screen, matrix: !screen.matrix }) };
  }
  if (key.input === 'c') {
    return {
      state: push(state, { kind: 'configure', scope: 'project', cursor: 0, flowId: screen.flowId }),
    };
  }
  if (key.input === 'r') {
    const command = [
      `circuit run ${screen.flowId} --goal "<your goal>"`,
      ...(screen.dial !== undefined ? [`--power ${screen.dial}`] : []),
    ].join(' ');
    return { state: { ...state, outcome: { kind: 'run-template', command } } };
  }
  return { state };
}

function reduceConfigure(
  state: ShellState,
  screen: Extract<Screen, { kind: 'configure' }>,
  key: KeyEvent,
): ReduceResult {
  const fields = configFields(screen.flowId);
  const field = fields[screen.cursor];

  if (screen.editing !== undefined && field !== undefined) {
    const count = field.options.length;
    if (key.escape === true) {
      const { editing: _drop, ...rest } = screen;
      return { state: replaceTop(state, rest) };
    }
    if (key.leftArrow === true || key.input === 'h') {
      const optionIndex = (screen.editing.optionIndex + count - 1) % count;
      return { state: replaceTop(state, { ...screen, editing: { optionIndex } }) };
    }
    if (key.rightArrow === true || key.input === 'l') {
      const optionIndex = (screen.editing.optionIndex + 1) % count;
      return { state: replaceTop(state, { ...screen, editing: { optionIndex } }) };
    }
    if (key.return === true) {
      const value = field.options[screen.editing.optionIndex] as string;
      const { editing: _drop, ...rest } = screen;
      return {
        state: replaceTop(state, rest),
        effect: { kind: 'config-set', key: field.key, value, scope: screen.scope },
      };
    }
    return { state };
  }

  if (key.escape === true) return { state: pop(state) };
  if (key.downArrow === true || key.input === 'j') {
    return {
      state: replaceTop(state, { ...screen, cursor: moveCursor(screen.cursor, 1, fields.length) }),
    };
  }
  if (key.upArrow === true || key.input === 'k') {
    return {
      state: replaceTop(state, { ...screen, cursor: moveCursor(screen.cursor, -1, fields.length) }),
    };
  }
  if (key.input === 's') {
    return {
      state: replaceTop(state, {
        ...screen,
        scope: screen.scope === 'project' ? 'global' : 'project',
      }),
    };
  }
  if (key.return === true && field !== undefined) {
    return { state: replaceTop(state, { ...screen, editing: { optionIndex: 0 } }) };
  }
  if (key.input === 'u' && field !== undefined) {
    return {
      state,
      effect: { kind: 'config-unset', key: field.key, scope: screen.scope },
    };
  }
  return { state };
}

function reduceCreate(
  state: ShellState,
  screen: Extract<Screen, { kind: 'create' }>,
  key: KeyEvent,
): ReduceResult {
  if (screen.stage === 'describe') {
    if (key.escape === true) return { state: pop(state) };
    if (key.return === true) {
      if (screen.description.trim() === '') return { state };
      return { state: replaceTop(state, { ...screen, stage: 'confirm' }) };
    }
    if (key.backspace === true || key.delete === true) {
      return {
        state: replaceTop(state, { ...screen, description: screen.description.slice(0, -1) }),
      };
    }
    if (isPrintable(key)) {
      return {
        state: replaceTop(state, { ...screen, description: screen.description + key.input }),
      };
    }
    return { state };
  }

  if (key.escape === true) return { state: replaceTop(state, { ...screen, stage: 'describe' }) };
  if (key.input === 'p') {
    return { state: replaceTop(state, { ...screen, publish: !screen.publish }) };
  }
  if (key.return === true) {
    return {
      state: {
        ...state,
        outcome: { kind: 'generate', argv: generateArgv(screen.description, screen.publish) },
      },
    };
  }
  return { state };
}

export function reduce(state: ShellState, event: ShellEvent): ReduceResult {
  if (state.outcome !== undefined) return { state };

  if (event.type === 'config-result') {
    const next = withReceipt(state, event.ok, event.text, event.command);
    return { state: event.ok ? { ...next, configVersion: next.configVersion + 1 } : next };
  }

  const key = event.key;
  const screen = currentScreen(state);

  // The help overlay swallows the next keypress: any key closes it.
  if (state.help) return { state: { ...state, help: false } };

  if (!isTyping(screen)) {
    if (key.input === '?') return { state: { ...state, help: true } };
    if (key.input === 'q') return { state: quit(state) };
  }

  if (screen.kind === 'home') return reduceHome(state, screen, key);
  if (screen.kind === 'browse') return reduceBrowse(state, screen, key);
  if (screen.kind === 'flow') return reduceFlow(state, screen, key);
  if (screen.kind === 'configure') return reduceConfigure(state, screen, key);
  return reduceCreate(state, screen, key);
}
