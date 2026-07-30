import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { z } from 'zod';

const MAX_FLOW_FIXTURE_BYTES = 4 * 1024 * 1024;

// Only the start-relevant slice of the compiled fixture. Unknown keys are the
// rest of the flow package and are deliberately ignored here.
const PackagedFlowAxesV1 = z.object({
  axes: z.object({
    allowed_depths: z.array(z.enum(['low', 'medium', 'high'])).min(1),
    supports_tournament: z.boolean(),
    supports_autonomous: z.boolean(),
  }),
});

export interface PackagedFlowStartAxes {
  readonly allowed_processes: readonly ('low' | 'medium' | 'high')[];
  readonly supports_tournament: boolean;
  readonly supports_autonomous: boolean;
}

export class PackagedFlowAxesError extends Error {
  readonly code = 'flow_package_invalid' as const;
  readonly nextAction = 'Reinstall the Circuit plugin, then retry.';

  constructor(message: string) {
    super(message);
    this.name = 'PackagedFlowAxesError';
  }
}

/**
 * Reads which start options a packaged flow accepts from its sealed compiled
 * fixture. This is the same file the engine loads for the run, so the start
 * boundary and the engine can never disagree about what a flow allows.
 */
export function loadPackagedFlowStartAxes(path: string): PackagedFlowStartAxes {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd);
    if (!before.isFile() || before.size === 0 || before.size > MAX_FLOW_FIXTURE_BYTES) {
      throw new Error('the flow fixture is not a bounded regular file');
    }
    const decoded = PackagedFlowAxesV1.parse(JSON.parse(readFileSync(fd, 'utf8')) as unknown);
    const after = fstatSync(fd);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error('the flow fixture changed while Circuit read it');
    }
    return {
      allowed_processes: decoded.axes.allowed_depths,
      supports_tournament: decoded.axes.supports_tournament,
      supports_autonomous: decoded.axes.supports_autonomous,
    };
  } catch (error) {
    if (error instanceof PackagedFlowAxesError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new PackagedFlowAxesError(
      `Circuit could not trust the packaged flow it was asked to start: ${message}`,
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
