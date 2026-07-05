import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseExecutionArgs, runExecutionCommand } from '../../src/cli/run.js';
import { captureStreams } from '../helpers/runtime-fixtures.js';

// Checkpoint UX audit, finding 5: a typo in the flow name used to escape as a
// thrown internal error naming the compiled-flow path on disk
// ("compiled flow not found: .../generated/flows/prototpe/circuit.json").
// The operator asked for a flow by name, so the answer names flows: say the
// name is unknown and list the flows this install actually has.

describe('run with an unknown flow name', () => {
  it('lists the available flows instead of leaking the compiled-flow path', async () => {
    const args = parseExecutionArgs('run', ['prototpe', '--goal', 'probe the unknown-name path']);
    const { result, stderr } = await captureStreams(() => runExecutionCommand(args, {}));

    expect(result).toBe(2);
    expect(stderr).toContain("no flow named 'prototpe'");
    // The real flows are offered by name...
    expect(stderr).toContain('prototype');
    expect(stderr).toContain('review');
    // ...internal flows stay hidden, and no filesystem path leaks.
    expect(stderr).not.toMatch(/\bgoal\b/);
    expect(stderr).not.toContain('compiled flow not found');
    expect(stderr).not.toContain('generated/flows');
  });

  // First-run lab finding 2: running the CLI from a directory that is not the
  // circuit checkout resolves the flow root relative to the current directory,
  // finds nothing, and said only "no flow named 'review' is installed." with no
  // flow listing and no way forward. When the searched root has no flows at
  // all, the message must say where it looked and how to point the CLI at a
  // real flow root.
  it('names the searched root and the --flow-root remedy when no flows exist there', async () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), 'circuit-empty-flow-root-'));
    const args = parseExecutionArgs('run', [
      'review',
      '--goal',
      'probe the empty flow-root path',
      '--flow-root',
      emptyRoot,
    ]);
    const { result, stderr } = await captureStreams(() => runExecutionCommand(args, {}));

    expect(result).toBe(2);
    expect(stderr).toContain("no flow named 'review'");
    // An empty root means the operator is pointed at the wrong place, so the
    // message says where the CLI looked and how to redirect it.
    expect(stderr).toContain(emptyRoot);
    expect(stderr).toContain('--flow-root');
  });
});
