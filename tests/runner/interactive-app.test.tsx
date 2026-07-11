import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/cli/interactive/app.js';
import type { SessionResult } from '../../src/cli/interactive/state.js';

// Frame tests for the Ink shell: real keystrokes through a fake stdin, real
// frames out. Config writes are pointed at temp dirs so a test run never
// touches the machine's config, and the configure flow is asserted all the
// way down to the YAML file the ephemeral status line claims to have written.

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const DOWN = '[B';
const ENTER = '\r';
const ESC = '';

const FLOWS = [
  { id: 'review', title: 'Adversarial review', purpose: 'review changes with teeth' },
  { id: 'fix', title: 'Fix with proof', purpose: 'fix a bug and prove it' },
  { id: 'build', title: 'Build', purpose: 'build a feature' },
] as const;

let homeDir: string;
let cwd: string;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'circuit-shell-home-'));
  cwd = mkdtempSync(join(tmpdir(), 'circuit-shell-cwd-'));
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function mount(onExit: (result: SessionResult) => void = () => {}) {
  return render(<App flows={[...FLOWS]} onExit={onExit} configOptions={{ homeDir, cwd }} />);
}

async function press(stdin: { write: (data: string) => void }, ...keys: readonly string[]) {
  for (const key of keys) {
    stdin.write(key);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function plain(frame: string | undefined): string {
  return (frame ?? '').replace(ANSI_PATTERN, '');
}

describe('interactive shell frames', () => {
  it('opens on the home menu with breadcrumb and footer', () => {
    const { lastFrame, unmount } = mount();
    const frame = plain(lastFrame());
    expect(frame).toContain('circuit');
    for (const item of ['Browse flows', 'Configure', 'Create a flow', 'Quit']) {
      expect(frame).toContain(item);
    }
    expect(frame).toContain('q quit');
    unmount();
  });

  it('browses flows, filters with /, and drills into a preview', async () => {
    const { lastFrame, stdin, unmount } = mount();
    await press(stdin, ENTER);
    let frame = plain(lastFrame());
    expect(frame).toContain('review');
    expect(frame).toContain('fix');
    expect(frame).toContain('build');

    await press(stdin, '/', 'f', 'i');
    frame = plain(lastFrame());
    expect(frame).toContain('fix');
    expect(frame).not.toContain('review  ');
    expect(frame).toContain('fix a bug and prove it');

    await press(stdin, ENTER, ENTER); // keep filter, then open the flow
    frame = plain(lastFrame());
    // The preview table is the same renderer `circuit preview fix` uses.
    expect(frame).toContain('STEP');
    expect(frame).toContain('ARCHETYPE');
    expect(frame).toContain('↳ circuit preview fix');
    unmount();
  });

  it('cycling the dial updates the equivalent command in the footer', async () => {
    const { lastFrame, stdin, unmount } = mount();
    await press(stdin, ENTER, ENTER, 'p'); // browse -> review -> dial auto
    expect(plain(lastFrame())).toContain('↳ circuit preview review --power auto');
    unmount();
  });

  it('configure edits write the project YAML and show an ephemeral status line', async () => {
    const { lastFrame, stdin, unmount } = mount();
    await press(stdin, DOWN, ENTER); // home -> Configure
    let frame = plain(lastFrame());
    expect(frame).toContain('defaults.power');
    expect(frame).toContain('(unset)');

    await press(stdin, ENTER, '[C', ENTER); // edit, auto -> low, save
    frame = plain(lastFrame());
    expect(frame).toContain('✓ defaults.power = low');
    expect(frame).toContain('↳ circuit config set defaults.power low');
    // The status line is honest: the file exists and carries the value.
    const configPath = join(cwd, '.circuit', 'config.yaml');
    expect(existsSync(configPath)).toBe(true);
    expect(readFileSync(configPath, 'utf8')).toContain('power: low');
    // The field now shows the value with provenance.
    expect(frame).toContain('low (project)');
    unmount();
  });

  it('a second edit replaces the status line instead of stacking a new one', async () => {
    const { lastFrame, stdin, unmount } = mount();
    await press(stdin, DOWN, ENTER); // home -> Configure
    await press(stdin, ENTER, '[C', ENTER); // set defaults.power (auto -> low)
    await press(stdin, DOWN); // move to the default-connector field
    await press(stdin, ENTER, '[C', ENTER); // set relay.default (auto -> claude-code)
    const frame = plain(lastFrame());
    // This is the regression guard for the push-down bug: two writes must
    // leave exactly one status glyph on screen, not one per change.
    expect(frame.match(/✓/g) ?? []).toHaveLength(1);
    // The one status line is about the latest key; the earlier one's status
    // was replaced, not stacked above it.
    expect(frame).toContain('✓ relay.default');
    expect(frame).not.toContain('✓ defaults.power');
    unmount();
  });

  it('q reports a quit outcome with an empty change log', async () => {
    const onExit = vi.fn();
    const { stdin, unmount } = mount(onExit);
    await press(stdin, 'q');
    expect(onExit).toHaveBeenCalledWith({ outcome: { kind: 'quit' }, configChanges: [] });
    unmount();
  });

  it('create composes the generate command and exits with its argv', async () => {
    const onExit = vi.fn();
    const { lastFrame, stdin, unmount } = mount(onExit);
    await press(stdin, DOWN, DOWN, ENTER); // home -> Create a flow
    await press(stdin, 'd', 'o', ' ', 'x', ENTER);
    let frame = plain(lastFrame());
    expect(frame).toContain('circuit generate --description "do x"');
    await press(stdin, 'p'); // publish toggle
    frame = plain(lastFrame());
    expect(frame).toContain('--publish --yes');
    await press(stdin, ENTER);
    expect(onExit).toHaveBeenCalledWith({
      outcome: { kind: 'generate', argv: ['--description', 'do x', '--publish', '--yes'] },
      configChanges: [],
    });
    unmount();
  });

  it('esc ascends the stack back to home', async () => {
    const { lastFrame, stdin, unmount } = mount();
    await press(stdin, ENTER, ENTER, ESC, ESC);
    expect(plain(lastFrame())).toContain('Browse flows');
    unmount();
  });
});
