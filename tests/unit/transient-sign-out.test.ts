// A sign-out reported by a CLI that was working minutes ago.
//
// Observed on a 24-branch Review of this repository: eight branches died on
// "Not logged in - Please run /login" while the branches before and after them
// answered normally on the same CLI. The operator was told to sign in to a
// session that was not signed out, and the two asks the engine spends on a
// dead connector were 400ms apart, far too quick to outlast the blip.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  connectorFailureSummary,
  forgetConnectorSuccesses,
  isTransientSignOutFailure,
  noteConnectorSucceeded,
} from '../../src/connectors/subprocess.js';
import {
  connectorAskBudget,
  connectorRetryBackoffMs,
  connectorRetryDelayMs,
} from '../../src/runtime/executors/relay.js';

function signedOutFailure(cli: string): string | undefined {
  return connectorFailureSummary({
    cli,
    signInHint: `Run \`${cli}\` once to sign in`,
    stderr: '',
    stdout: '',
    streamError: 'Not logged in · Please run /login',
  });
}

describe('a sign-out from a CLI that just answered', () => {
  beforeEach(() => {
    forgetConnectorSuccesses();
  });
  afterEach(() => {
    forgetConnectorSuccesses();
  });

  it('is reported as a sign-out when the CLI has never answered', () => {
    const summary = signedOutFailure('claude');
    expect(summary).toContain('The claude CLI is not logged in');
    expect(isTransientSignOutFailure(summary ?? '')).toBe(false);
  });

  it('is doubted once the same CLI has answered', () => {
    noteConnectorSucceeded('claude');
    const summary = signedOutFailure('claude');
    expect(summary).toContain('answered normally minutes ago');
    expect(summary).toContain('transient authentication failure');
    // The sign-in instruction survives, demoted: it is still the fix if the
    // doubt turns out to be wrong.
    expect(summary).toContain('Run `claude` once to sign in');
    expect(isTransientSignOutFailure(summary ?? '')).toBe(true);
  });

  it('does not let one CLI vouch for another', () => {
    noteConnectorSucceeded('codex');
    expect(signedOutFailure('claude')).toContain('The claude CLI is not logged in');
  });

  it('buys real seconds and three more asks than an ordinary connector death', () => {
    const transient = 'The claude CLI ... more likely a transient authentication failure than ...';
    const dead = 'claude-code subprocess exited with code 143';

    expect(connectorAskBudget(2, dead)).toBe(2);
    expect(connectorAskBudget(2, transient)).toBe(5);

    expect(connectorRetryDelayMs(2, dead)).toBe(connectorRetryBackoffMs(2));
    expect(connectorRetryDelayMs(2, transient)).toBe(5_000);
    expect(connectorRetryDelayMs(3, transient)).toBe(15_000);
    expect(connectorRetryDelayMs(4, transient)).toBe(30_000);
    // The 60-second tail is what makes the schedule outlast the 99-second
    // window measured on this repository's own Review runs; 5/15/30 stopped at
    // 50 and exhausted inside it. See tests/unit/sign-out-window-sharing.
    expect(connectorRetryDelayMs(5, transient)).toBe(60_000);
    // Past the end of the schedule the wait holds at its longest rather than
    // falling off the array.
    expect(connectorRetryDelayMs(9, transient)).toBe(60_000);
  });
});
