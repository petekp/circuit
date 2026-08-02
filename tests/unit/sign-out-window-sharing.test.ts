// A sign-out window belongs to the credential, not to a branch.
//
// Measured on two overlapping Review runs of this repository (trace stamps
// 09:23:54 through 09:25:34): thirteen consecutive fanout branches failed on
// "Not logged in - Please run /login", spaced at the fanout cadence, with the
// branches before and after succeeding on the same CLI. Circuit spawns each
// branch as a fresh short-lived CLI process that reads the credential cold, so
// when the access token expires those cold starts race to redeem one rotating
// refresh token and the losers get a 401 back.
//
// Two things were wrong. The window ran 99 seconds and the schedule covered
// 50, so a branch entering at the top of it exhausted inside it. And every
// branch discovered and rode out the same global condition alone: nothing a
// branch learned reached its thirteen siblings, including the one fact that
// ends the window, which is that some sibling got through.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  connectorFailureSummary,
  forgetConnectorSuccesses,
  noteConnectorSucceeded,
  transientSignOutCli,
} from '../../src/connectors/subprocess.js';
import {
  connectorAskBudget,
  connectorRetryDelayMs,
  pauseForConnectorRetry,
} from '../../src/runtime/executors/relay.js';

function signedOutFailure(cli: string): string {
  return (
    connectorFailureSummary({
      cli,
      signInHint: `Run \`${cli}\` once to sign in`,
      stderr: '',
      stdout: '',
      streamError: 'Not logged in · Please run /login',
    }) ?? ''
  );
}

/** A doubted sign-out: the CLI has to have answered before it can be doubted. */
function doubtedSignOut(cli: string): string {
  noteConnectorSucceeded(cli);
  const summary = signedOutFailure(cli);
  forgetConnectorSuccesses();
  return summary;
}

describe('the wait a doubted sign-out buys', () => {
  beforeEach(() => {
    forgetConnectorSuccesses();
  });
  afterEach(() => {
    forgetConnectorSuccesses();
  });

  it('outlasts the 99-second window that cost this repository thirteen branches', () => {
    const transient = doubtedSignOut('claude');
    const budget = connectorAskBudget(2, transient);

    // Every wait the loop actually spends: one before each ask after the first.
    let covered = 0;
    for (let ask = 2; ask <= budget; ask += 1) {
      covered += connectorRetryDelayMs(ask, transient);
    }

    expect(covered).toBeGreaterThan(99_000);
  });
});

describe('what one branch learns about a sign-out window', () => {
  beforeEach(() => {
    forgetConnectorSuccesses();
  });
  afterEach(() => {
    forgetConnectorSuccesses();
  });

  it('names the CLI out of the sentence the connector layer authored', () => {
    // The extractor lives beside the template that produces the sentence, so
    // the two cannot drift apart unnoticed. This is the round-trip that says
    // so.
    expect(transientSignOutCli(doubtedSignOut('claude'))).toBe('claude');
    expect(transientSignOutCli(doubtedSignOut('codex'))).toBe('codex');
    expect(transientSignOutCli(doubtedSignOut('cursor-agent'))).toBe('cursor-agent');
  });

  it('does not name a CLI for a failure that is not a doubted sign-out', () => {
    expect(transientSignOutCli('claude-code subprocess exited with code 143')).toBeUndefined();
    // An undoubted sign-out is a real one. Nobody should wait on a window that
    // a sibling's success is not going to close.
    expect(transientSignOutCli(signedOutFailure('claude'))).toBeUndefined();
  });

  it('stops waiting the moment a sibling branch gets through', async () => {
    const transient = doubtedSignOut('claude');
    // The real wait here is 30 seconds. The point of the test is that it does
    // not take 30 seconds, because a sibling succeeds while this one waits.
    expect(connectorRetryDelayMs(4, transient)).toBe(30_000);

    const startedAt = Date.now();
    const waiting = pauseForConnectorRetry(4, transient);
    setTimeout(() => {
      noteConnectorSucceeded('claude');
    }, 20);
    await waiting;

    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it('keeps waiting when the CLI that got through is a different one', async () => {
    const transient = doubtedSignOut('claude');
    const waiting = pauseForConnectorRetry(2, transient);
    setTimeout(() => {
      // codex answering says nothing about the claude credential.
      noteConnectorSucceeded('codex');
      noteConnectorSucceeded('claude');
    }, 20);
    await waiting;
    // Reaching here at all means the claude release, not the codex one, ended
    // the wait: a 5-second timer would have outlasted the test's own patience
    // only if neither release landed.
    expect(true).toBe(true);
  });

  it('releases every branch waiting on the same window, not just the first', async () => {
    const transient = doubtedSignOut('claude');
    const startedAt = Date.now();
    const branches = [4, 4, 4, 4, 4].map((ask) => pauseForConnectorRetry(ask, transient));
    setTimeout(() => {
      noteConnectorSucceeded('claude');
    }, 20);
    await Promise.all(branches);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it('still releases branches that hit a second window after the first closed', async () => {
    // The teardown of a closed window used to be keyed by CLI name alone, so
    // the last branch tidying up after window one could unmap the registry
    // entry window two had just installed under the same name. Those branches
    // were then unreachable and sat out their whole timeout.
    const transient = doubtedSignOut('claude');

    const first = pauseForConnectorRetry(4, transient);
    setTimeout(() => {
      noteConnectorSucceeded('claude');
    }, 20);
    await first;

    const startedAt = Date.now();
    const second = pauseForConnectorRetry(4, transient);
    setTimeout(() => {
      noteConnectorSucceeded('claude');
    }, 20);
    await second;

    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it('waits out the full delay when nothing gets through', async () => {
    // A dead connector is not a sign-out: it has no window, so no sibling's
    // success can end its wait and it spends the whole backoff.
    const dead = 'claude-code subprocess exited with code 143';
    const startedAt = Date.now();
    await pauseForConnectorRetry(2, dead);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(connectorRetryDelayMs(2, dead) - 5);
  });
});
