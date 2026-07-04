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
});
