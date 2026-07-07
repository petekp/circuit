import { describe, expect, it } from 'vitest';
import {
  type FlowSummary,
  type KeyEvent,
  type ShellState,
  configFields,
  currentScreen,
  formatConfigChangeSummary,
  generateArgv,
  initialState,
  reduce,
  visibleFlows,
} from '../../src/cli/interactive/state.js';

// The interactive shell's whole interaction model is a pure reducer, so the
// contract is pinned with plain function calls: navigation is a drill-down
// stack (enter descends, esc ascends), free-text screens suspend the letter
// shortcuts, and every outward action carries its flag-command equivalent.

const FLOWS: readonly FlowSummary[] = [
  { id: 'review', title: 'Review', purpose: 'review changes' },
  { id: 'fix', title: 'Fix', purpose: 'fix a bug' },
  { id: 'build', title: 'Build', purpose: 'build a feature' },
];

function key(partial: Partial<KeyEvent> & { input?: string }): KeyEvent {
  return { input: '', ...partial };
}

function press(state: ShellState, ...keys: readonly KeyEvent[]): ShellState {
  let current = state;
  for (const k of keys) {
    current = reduce(current, { type: 'key', key: k }).state;
  }
  return current;
}

function type(state: ShellState, text: string): ShellState {
  return press(state, ...[...text].map((ch) => key({ input: ch })));
}

const DOWN = key({ downArrow: true });
const UP = key({ upArrow: true });
const ENTER = key({ return: true });
const ESC = key({ escape: true });

describe('home screen', () => {
  it('moves the cursor with j/k and arrows, clamped to the menu', () => {
    let state = initialState(FLOWS);
    state = press(state, key({ input: 'j' }), DOWN);
    expect(currentScreen(state)).toMatchObject({ kind: 'home', cursor: 2 });
    state = press(state, UP, UP, UP);
    expect(currentScreen(state)).toMatchObject({ kind: 'home', cursor: 0 });
  });

  it('enter descends into browse, configure, and create', () => {
    const home = initialState(FLOWS);
    expect(currentScreen(press(home, ENTER)).kind).toBe('browse');
    expect(currentScreen(press(home, DOWN, ENTER)).kind).toBe('configure');
    expect(currentScreen(press(home, DOWN, DOWN, ENTER)).kind).toBe('create');
  });

  it('quit is reachable by menu item and by q', () => {
    const home = initialState(FLOWS);
    expect(press(home, key({ input: 'q' })).outcome).toEqual({ kind: 'quit' });
    expect(press(home, DOWN, DOWN, DOWN, ENTER).outcome).toEqual({ kind: 'quit' });
  });
});

describe('browse screen', () => {
  const browse = press(initialState(FLOWS), ENTER);

  it('filter narrows the visible flows and esc clears it', () => {
    let state = press(browse, key({ input: '/' }));
    state = type(state, 'fi');
    const screen = currentScreen(state);
    expect(visibleFlows(state, screen).map((f) => f.id)).toEqual(['fix']);
    // While typing, q is text, not quit.
    const typed = press(state, key({ input: 'q' }));
    expect(typed.outcome).toBeUndefined();
    const cleared = press(state, ESC);
    expect(visibleFlows(cleared, currentScreen(cleared))).toHaveLength(3);
  });

  it('enter drills into the flow without leaving a status line behind', () => {
    const state = press(browse, DOWN, ENTER);
    expect(currentScreen(state)).toMatchObject({ kind: 'flow', flowId: 'fix' });
    // Browsing is navigation, not a mutation: no ephemeral status, and the
    // flow footer teaches `circuit preview fix` on its own.
    expect(state.status).toBeNull();
    expect(state.configChanges).toHaveLength(0);
  });

  it('g and G jump to the ends, esc ascends to home', () => {
    const bottom = press(browse, key({ input: 'G' }));
    expect(currentScreen(bottom)).toMatchObject({ cursor: 2 });
    const top = press(bottom, key({ input: 'g' }));
    expect(currentScreen(top)).toMatchObject({ cursor: 0 });
    expect(currentScreen(press(browse, ESC)).kind).toBe('home');
  });
});

describe('flow screen', () => {
  const flow = press(press(initialState(FLOWS), ENTER), ENTER); // review

  it('p cycles the dial and m toggles the matrix', () => {
    let state = press(flow, key({ input: 'p' }));
    expect(currentScreen(state)).toMatchObject({ dial: 'auto' });
    state = press(state, key({ input: 'p' }), key({ input: 'p' }), key({ input: 'p' }));
    expect(currentScreen(state)).toMatchObject({ dial: 'high' });
    state = press(state, key({ input: 'p' }));
    expect(currentScreen(state)).toMatchObject({ dial: undefined });
    state = press(state, key({ input: 'm' }));
    expect(currentScreen(state)).toMatchObject({ matrix: true });
  });

  it('r exits with a run-command template for the flow', () => {
    const state = press(flow, key({ input: 'r' }));
    expect(state.outcome).toMatchObject({ kind: 'run-template' });
    if (state.outcome?.kind !== 'run-template') throw new Error('expected run-template');
    expect(state.outcome.command).toContain('circuit run review --goal');
  });

  it('c opens configure scoped to this flow, with per-flow fields', () => {
    const state = press(flow, key({ input: 'c' }));
    expect(currentScreen(state)).toMatchObject({ kind: 'configure', flowId: 'review' });
    const keys = configFields('review').map((f) => f.key);
    expect(keys).toContain('flows.review.selection.effort');
    expect(keys).toContain('flows.review.selection.depth');
  });
});

describe('configure screen', () => {
  const configure = press(initialState(FLOWS), DOWN, ENTER);

  it('enter edits, arrows choose an option, enter emits the config-set effect', () => {
    const state = press(configure, ENTER); // edit defaults.power, options start at auto
    const { state: next, effect } = reduce(
      press(state, key({ input: 'l' })), // auto -> low
      { type: 'key', key: ENTER },
    );
    expect(effect).toEqual({
      kind: 'config-set',
      key: 'defaults.power',
      value: 'low',
      scope: 'project',
    });
    // The edit closes; feedback arrives later via the config-result event.
    expect(currentScreen(next)).not.toHaveProperty('editing.optionIndex');
  });

  it('s switches scope so the effect targets the global file', () => {
    const state = press(configure, key({ input: 's' }), ENTER);
    const { effect } = reduce(state, { type: 'key', key: ENTER });
    expect(effect).toMatchObject({ kind: 'config-set', scope: 'global' });
  });

  it('u emits config-unset for the selected key', () => {
    const { effect } = reduce(press(configure, DOWN), { type: 'key', key: key({ input: 'u' }) });
    expect(effect).toEqual({ kind: 'config-unset', key: 'relay.default', scope: 'project' });
  });

  it('a landed write sets the status, logs the change, and bumps configVersion', () => {
    const ok = reduce(configure, {
      type: 'config-result',
      ok: true,
      text: 'defaults.power = low',
      command: 'circuit config set defaults.power low',
      change: { key: 'defaults.power', command: 'circuit config set defaults.power low' },
    }).state;
    expect(ok.configVersion).toBe(1);
    expect(ok.status?.command).toBe('circuit config set defaults.power low');
    expect(ok.configChanges).toEqual([
      { key: 'defaults.power', command: 'circuit config set defaults.power low' },
    ]);
  });

  it('a failure shows the status but touches neither the log nor configVersion', () => {
    const failed = reduce(configure, { type: 'config-result', ok: false, text: 'nope' }).state;
    expect(failed.configVersion).toBe(0);
    expect(failed.status?.ok).toBe(false);
    expect(failed.configChanges).toHaveLength(0);
  });

  it('a no-op (already-unset) shows the status but logs nothing', () => {
    // No `change` field: the write did not land.
    const noop = reduce(configure, {
      type: 'config-result',
      ok: true,
      text: 'relay.default already unset',
      command: 'circuit config unset relay.default',
    }).state;
    expect(noop.configVersion).toBe(0);
    expect(noop.configChanges).toHaveLength(0);
    expect(noop.status?.text).toContain('already unset');
  });

  it('navigating away clears the status line so it never bleeds into another screen', () => {
    const afterWrite = reduce(configure, {
      type: 'config-result',
      ok: true,
      text: 'defaults.power = low',
      command: 'circuit config set defaults.power low',
      change: { key: 'defaults.power', command: 'circuit config set defaults.power low' },
    }).state;
    expect(afterWrite.status).not.toBeNull();
    // Esc pops back to home; the ephemeral status must not survive the hop,
    // but the durable session log must.
    const home = press(afterWrite, ESC);
    expect(currentScreen(home).kind).toBe('home');
    expect(home.status).toBeNull();
    expect(home.configChanges).toHaveLength(1);
  });
});

describe('config-change summary', () => {
  const change = (key: string, command: string) => ({ key, command });

  it('is null when nothing was written', () => {
    expect(formatConfigChangeSummary([])).toBeNull();
  });

  it('lists each write once, keeping the last value per key', () => {
    const summary = formatConfigChangeSummary([
      change('defaults.power', 'circuit config set defaults.power high'),
      change('defaults.power', 'circuit config set defaults.power low'),
      change('relay.default', 'circuit config set relay.default auto'),
    ]);
    expect(summary).toContain('config changes saved this session');
    // The superseded first write does not appear; the last one does.
    expect(summary).not.toContain('defaults.power high');
    expect(summary).toContain('circuit config set defaults.power low');
    expect(summary).toContain('circuit config set relay.default auto');
  });

  it('uses the singular for a single change', () => {
    const summary = formatConfigChangeSummary([
      change('defaults.power', 'circuit config set defaults.power low'),
    ]);
    expect(summary).toContain('config change saved this session');
  });
});

describe('create screen', () => {
  const create = press(initialState(FLOWS), DOWN, DOWN, ENTER);

  it('typing accumulates (q and ? are text here), enter confirms, enter starts generate', () => {
    let state = type(create, 'tidy up sql queries?');
    expect(currentScreen(state)).toMatchObject({ description: 'tidy up sql queries?' });
    expect(state.outcome).toBeUndefined();
    state = press(state, ENTER); // confirm stage
    expect(currentScreen(state)).toMatchObject({ stage: 'confirm' });
    state = press(state, key({ input: 'p' }), ENTER);
    expect(state.outcome).toEqual({
      kind: 'generate',
      argv: ['--description', 'tidy up sql queries?', '--publish', '--yes'],
    });
  });

  it('enter on an empty description stays put', () => {
    const state = press(create, ENTER);
    expect(currentScreen(state)).toMatchObject({ kind: 'create', stage: 'describe' });
  });

  it('generateArgv omits publish flags for drafts', () => {
    expect(generateArgv('x', false)).toEqual(['--description', 'x']);
  });
});

describe('help overlay', () => {
  it('? opens help and the next keypress closes it without acting', () => {
    let state = press(initialState(FLOWS), key({ input: '?' }));
    expect(state.help).toBe(true);
    state = press(state, key({ input: 'q' }));
    expect(state.help).toBe(false);
    expect(state.outcome).toBeUndefined();
  });
});
