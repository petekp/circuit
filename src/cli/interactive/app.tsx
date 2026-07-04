import { Box, Text, useApp, useInput } from 'ink';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { LayeredConfig } from '../../schemas/config.js';
import { discoverRuntimeConfigLayers } from '../../shared/config-loader.js';
import { applyConfigSet, applyConfigUnset } from '../config-command.js';
import { resolveFlowSelectionPreview } from '../flow-selection-preview.js';
import { hostKindFromEnv, renderMatrix, renderSinglePreview } from '../preview.js';
import { colorEnabled, terminalPalette } from '../terminal-style.js';
import { readSourceVersion } from '../version-info.js';
import {
  type ConfigField,
  type Effect,
  type FlowSummary,
  HOME_ITEMS,
  type Screen,
  type SessionResult,
  type ShellEvent,
  type ShellState,
  type StatusLine,
  breadcrumb,
  configFields,
  configSetCommand,
  configUnsetCommand,
  currentScreen,
  generateCommand,
  initialState,
  previewCommand,
  reduce,
  visibleFlows,
} from './state.js';

// The Ink face of the interactive shell. All decisions live in the pure
// reducer (state.ts); this file adapts keystrokes into events, executes the
// reducer's effects through the same exported cores the flag commands use
// (applyConfigSet/applyConfigUnset), and renders. Feedback is an ephemeral
// status line in the live region — replaced by the next action and cleared on
// navigation, so nothing marches down the scrollback. The durable record of
// what was written is printed once, after unmount, from the SessionResult.

export interface AppProps {
  readonly flows: readonly FlowSummary[];
  readonly onExit: (result: SessionResult) => void;
  // Test seam: points config reads/writes and preview layer discovery at a
  // temp home/project instead of the real machine.
  readonly configOptions?: { readonly homeDir?: string; readonly cwd?: string };
}

interface EffectiveValue {
  readonly value: string | undefined;
  readonly source: 'project' | 'user-global' | undefined;
}

function valueAtPath(config: unknown, path: readonly string[]): unknown {
  let node: unknown = config;
  for (const segment of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

function effectiveValue(layers: readonly LayeredConfig[], key: string): EffectiveValue {
  const path = key.split('.');
  let found: EffectiveValue = { value: undefined, source: undefined };
  for (const layer of layers) {
    if (layer.layer !== 'project' && layer.layer !== 'user-global') continue;
    const value = valueAtPath(layer.config, path);
    if (value !== undefined) found = { value: String(value), source: layer.layer };
  }
  return found;
}

// Run the reducer's config effect through the shared write cores and turn the
// result into a config-result event. The in-TUI text stays compact (no file
// path — the configure field already shows project/global provenance); the
// full teaching lives in `command`, and `change` is set only when a write
// actually landed so the reducer knows to log it.
function executeEffect(effect: Effect, options: AppProps['configOptions']): ShellEvent {
  if (effect.kind === 'config-set') {
    const result = applyConfigSet(effect.key, effect.value, effect.scope, options ?? {});
    if (!result.ok) return { type: 'config-result', ok: false, text: result.message };
    const command = configSetCommand(effect.key, effect.value, effect.scope);
    return {
      type: 'config-result',
      ok: true,
      text: `${effect.key} = ${effect.value}`,
      command,
      change: { key: effect.key, command },
    };
  }
  const result = applyConfigUnset(effect.key, effect.scope, options ?? {});
  if (!result.ok) return { type: 'config-result', ok: false, text: result.message };
  const command = configUnsetCommand(effect.key, effect.scope);
  if ('noop' in result) {
    // Nothing was written, so no `change`: the status line reports it but the
    // session log and the derived config reads stay put.
    return { type: 'config-result', ok: true, text: `${effect.key} already unset`, command };
  }
  return {
    type: 'config-result',
    ok: true,
    text: `${effect.key} unset`,
    command,
    change: { key: effect.key, command },
  };
}

function StatusRegion({ status }: { readonly status: StatusLine }) {
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={status.ok ? 'green' : 'red'}>{status.ok ? '✓' : '✗'}</Text> {status.text}
      </Text>
      {status.command === undefined ? null : <Text dimColor>{`  ↳ ${status.command}`}</Text>}
    </Box>
  );
}

function HomeView({ cursor }: { readonly cursor: number }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      {HOME_ITEMS.map((item, index) => (
        <Text key={item} {...(index === cursor ? { color: 'cyan' } : {})}>
          {index === cursor ? '❯ ' : '  '}
          {item}
        </Text>
      ))}
    </Box>
  );
}

function BrowseView({
  state,
  screen,
}: {
  readonly state: ShellState;
  readonly screen: Extract<Screen, { kind: 'browse' }>;
}) {
  const flows = visibleFlows(state, screen);
  const idWidth = Math.max(...state.flows.map((flow) => flow.id.length), 4);
  const selected = flows[screen.cursor];
  return (
    <Box flexDirection="column" marginTop={1}>
      {(screen.filtering || screen.filter !== '') && (
        <Text>
          <Text dimColor>/</Text>
          {screen.filter}
          {screen.filtering ? <Text inverse> </Text> : null}
        </Text>
      )}
      {flows.length === 0 ? (
        <Text dimColor>no flows match</Text>
      ) : (
        flows.map((flow, index) => (
          <Text key={flow.id} {...(index === screen.cursor ? { color: 'cyan' } : {})}>
            {index === screen.cursor ? '❯ ' : '  '}
            {flow.id.padEnd(idWidth + 2)}
            <Text dimColor={index !== screen.cursor}>{flow.title}</Text>
          </Text>
        ))
      )}
      {selected === undefined ? null : (
        <Box marginTop={1}>
          <Text dimColor>{selected.purpose}</Text>
        </Box>
      )}
    </Box>
  );
}

function FlowView({
  screen,
  configVersion,
  configOptions,
}: {
  readonly screen: Extract<Screen, { kind: 'flow' }>;
  readonly configVersion: number;
  readonly configOptions: AppProps['configOptions'];
}) {
  // configVersion is a deliberate extra dependency: it invalidates this memo
  // after a config write, because the input that actually changed (the YAML
  // file on disk) is invisible to React.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  const body = useMemo(() => {
    const palette = terminalPalette(colorEnabled());
    const layers = discoverRuntimeConfigLayers(configOptions ?? {}).selectionConfigLayers;
    const hostKind = hostKindFromEnv();
    try {
      const dials = screen.matrix ? (['high', 'medium', 'low'] as const) : ([screen.dial] as const);
      const previews = dials.map((power) =>
        resolveFlowSelectionPreview({
          flowId: screen.flowId,
          ...(power === undefined ? {} : { power }),
          configLayers: layers,
          ...(hostKind === undefined ? {} : { hostKind }),
        }),
      );
      if (screen.matrix) return renderMatrix(palette, previews);
      const first = previews[0];
      return first === undefined ? '' : renderSinglePreview(palette, first);
    } catch (err) {
      return palette.warn(
        `preview unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [screen.flowId, screen.dial, screen.matrix, configVersion, configOptions]);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>{body}</Text>
    </Box>
  );
}

function ConfigureField({
  field,
  active,
  editing,
  current,
}: {
  readonly field: ConfigField;
  readonly active: boolean;
  readonly editing: { readonly optionIndex: number } | undefined;
  readonly current: EffectiveValue;
}) {
  const marker = active ? '❯ ' : '  ';
  if (active && editing !== undefined) {
    return (
      <Box flexDirection="column">
        <Text color="cyan">
          {marker}
          {field.label.padEnd(22)}
        </Text>
        <Text>
          {'    '}
          {field.options.map((option, index) => (
            <Text key={option} inverse={index === editing.optionIndex}>
              {` ${option} `}
            </Text>
          ))}
        </Text>
      </Box>
    );
  }
  const valueText =
    current.value === undefined ? (
      <Text dimColor>(unset)</Text>
    ) : (
      <Text bold>
        {current.value} <Text dimColor>({current.source})</Text>
      </Text>
    );
  return (
    <Text {...(active ? { color: 'cyan' } : {})}>
      {marker}
      {field.label.padEnd(22)}
      {valueText}
      <Text dimColor>{`  ${field.key}`}</Text>
    </Text>
  );
}

function ConfigureView({
  screen,
  configVersion,
  configOptions,
}: {
  readonly screen: Extract<Screen, { kind: 'configure' }>;
  readonly configVersion: number;
  readonly configOptions: AppProps['configOptions'];
}) {
  const fields = configFields(screen.flowId);
  // configVersion invalidates the layer read after each config write (the
  // changed input is the YAML file on disk, which React cannot see).
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  const layers = useMemo(
    () => discoverRuntimeConfigLayers(configOptions ?? {}).selectionConfigLayers,
    [configVersion, configOptions],
  );
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        scope: <Text bold>{screen.scope}</Text>{' '}
        <Text dimColor>
          ({screen.scope === 'project' ? './.circuit/config.yaml' : '~/.config/circuit/config.yaml'}
          )
        </Text>
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {fields.map((field, index) => (
          <ConfigureField
            key={field.key}
            field={field}
            active={index === screen.cursor}
            editing={index === screen.cursor ? screen.editing : undefined}
            current={effectiveValue(layers, field.key)}
          />
        ))}
      </Box>
    </Box>
  );
}

function CreateView({ screen }: { readonly screen: Extract<Screen, { kind: 'create' }> }) {
  if (screen.stage === 'describe') {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text>Describe the task this flow should encode:</Text>
        <Box marginTop={1}>
          <Text>
            <Text dimColor>› </Text>
            {screen.description}
            <Text inverse> </Text>
          </Text>
        </Box>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>Ready to compose this flow:</Text>
      <Box marginTop={1}>
        <Text color="cyan">{generateCommand(screen.description, screen.publish)}</Text>
      </Box>
      <Box marginTop={1}>
        <Text>
          publish after composing: <Text bold>{screen.publish ? 'yes' : 'no (draft)'}</Text>
        </Text>
      </Box>
    </Box>
  );
}

const HELP_LINES: Readonly<Record<Screen['kind'], readonly string[]>> = {
  home: ['↑↓ or j/k  move', 'enter      select', 'q          quit'],
  browse: [
    '↑↓ or j/k  move',
    '/          filter (esc clears)',
    'g / G      top / bottom',
    'enter      preview the flow',
    'esc        back',
  ],
  flow: [
    'p          cycle the power dial',
    'm          toggle the dial matrix',
    'c          configure this flow',
    'r          exit with a run command to fill in',
    'esc        back',
  ],
  configure: [
    '↑↓ or j/k  move between settings',
    'enter      edit (←→ choose, enter save, esc cancel)',
    'u          unset the selected key',
    's          switch project/global scope',
    'esc        back',
  ],
  create: [
    'type       describe the flow',
    'enter      continue / start composing',
    'p          toggle publish (confirm step)',
    'esc        back',
  ],
};

function HelpView({ screen }: { readonly screen: Screen }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>keys — {screen.kind}</Text>
      {HELP_LINES[screen.kind].map((line) => (
        <Text key={line}>{line}</Text>
      ))}
      <Box marginTop={1}>
        <Text dimColor>press any key to close</Text>
      </Box>
    </Box>
  );
}

function footerText(screen: Screen): string {
  if (screen.kind === 'home') return '↑↓ move · enter select · ? help · q quit';
  if (screen.kind === 'browse') {
    return screen.filtering
      ? 'type to filter · enter keep · esc clear'
      : '↑↓ move · / filter · enter preview · esc back · ? help';
  }
  if (screen.kind === 'flow') return 'p dial · m matrix · c configure · r run · esc back · ? help';
  if (screen.kind === 'configure') {
    return screen.editing === undefined
      ? '↑↓ move · enter edit · u unset · s scope · esc back · ? help'
      : '←→ choose · enter save · esc cancel';
  }
  return screen.stage === 'describe'
    ? 'type description · enter continue · esc back'
    : 'enter start · p publish toggle · esc edit · ? help';
}

export function App({ flows, onExit, configOptions }: AppProps) {
  const { exit } = useApp();
  const [state, setState] = useState<ShellState>(() => initialState(flows));
  const stateRef = useRef(state);

  const send = useCallback(
    (event: ShellEvent) => {
      const { state: next, effect } = reduce(stateRef.current, event);
      stateRef.current = next;
      setState(next);
      if (next.outcome !== undefined) {
        onExit({ outcome: next.outcome, configChanges: next.configChanges });
        exit();
        return;
      }
      if (effect !== undefined) {
        // Config writes are synchronous; feed the result straight back so the
        // status line lands in the same keystroke.
        send(executeEffect(effect, configOptions));
      }
    },
    [onExit, exit, configOptions],
  );

  useInput((input, key) => {
    send({
      type: 'key',
      key: {
        input,
        upArrow: key.upArrow,
        downArrow: key.downArrow,
        leftArrow: key.leftArrow,
        rightArrow: key.rightArrow,
        return: key.return,
        escape: key.escape,
        backspace: key.backspace,
        delete: key.delete,
      },
    });
  });

  const screen = currentScreen(state);

  return (
    <Box flexDirection="column">
      <Text>
        <Text color="cyan">◆</Text> <Text bold>circuit</Text>{' '}
        <Text dimColor>· v{readSourceVersion()} ·</Text> {breadcrumb(state)}
      </Text>
      {state.help ? (
        <HelpView screen={screen} />
      ) : screen.kind === 'home' ? (
        <HomeView cursor={screen.cursor} />
      ) : screen.kind === 'browse' ? (
        <BrowseView state={state} screen={screen} />
      ) : screen.kind === 'flow' ? (
        <FlowView
          screen={screen}
          configVersion={state.configVersion}
          configOptions={configOptions}
        />
      ) : screen.kind === 'configure' ? (
        <ConfigureView
          screen={screen}
          configVersion={state.configVersion}
          configOptions={configOptions}
        />
      ) : (
        <CreateView screen={screen} />
      )}
      <Box marginTop={1} flexDirection="column">
        {state.status !== null ? <StatusRegion status={state.status} /> : null}
        {screen.kind === 'flow' ? <Text dimColor>{`↳ ${previewCommand(screen)}`}</Text> : null}
        <Text dimColor>{footerText(screen)}</Text>
      </Box>
    </Box>
  );
}
