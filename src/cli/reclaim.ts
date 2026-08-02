import { join, resolve } from 'node:path';
import { Command } from 'commander';
import { makeTraceRunStatusResolver, reapWorktrees } from '../runtime/fanout/worktree-reaper.js';
import { controlPlaneRoot, runsRoot } from '../shared/control-plane-paths.js';
import { commanderErrorMessage, configureCommanderProgram } from './commander-support.js';
import { diamondHeaderLine } from './styled-table.js';
import { type TerminalPalette, colorEnabled, terminalPalette } from './terminal-style.js';

// `circuit reclaim` — operator-driven worktree reaper.
//
// A process killed mid-fanout skips the worktree-cleanup `finally`, orphaning
// per-branch git worktrees under `.circuit/worktrees/`. This command walks that
// layout for a project, removes the worktrees whose owning run is closed or
// dead, leaves a live (still-running or parked) run's worktrees alone, and
// prints a JSON summary of what it did. It is safe to run any time; with
// nothing to reclaim it reports empty lists.
//
// The project root defaults to the current directory. Pass `--project-root` to
// reclaim a project you are not standing in — without it, running from a
// subdirectory resolves the wrong control plane and silently reclaims nothing.

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export interface ReclaimReadout {
  readonly worktreesRoot: string;
  readonly removed: readonly string[];
  readonly kept: readonly string[];
  readonly errors: readonly { readonly path: string; readonly message: string }[];
}

/**
 * What a person sees. The JSON envelope stays available behind --json, which
 * until now was accepted and ignored while everyone got the envelope.
 *
 * A kept worktree is the interesting one: it was left alone because its run is
 * still going or is parked waiting on a decision, so the line says that rather
 * than leaving the operator to wonder why reclaim skipped it.
 */
export function renderReclaimSummary(palette: TerminalPalette, summary: ReclaimReadout): string {
  const lines: string[] = [diamondHeaderLine(palette, 'circuit reclaim'), ''];
  if (summary.removed.length === 0 && summary.kept.length === 0 && summary.errors.length === 0) {
    lines.push(`Nothing to reclaim. No leftover worktrees under ${summary.worktreesRoot}.`);
    return `${lines.join('\n')}\n`;
  }
  if (summary.removed.length > 0) {
    lines.push(
      `Removed ${summary.removed.length} leftover ${summary.removed.length === 1 ? 'worktree' : 'worktrees'}:`,
      ...summary.removed.map((path) => `  ${path}`),
      '',
    );
  }
  if (summary.kept.length > 0) {
    lines.push(
      `Kept ${summary.kept.length}: the owning run is still running or parked on a decision.`,
      ...summary.kept.map((path) => `  ${path}`),
      '',
    );
  }
  if (summary.errors.length > 0) {
    lines.push(
      `Could not remove ${summary.errors.length}:`,
      ...summary.errors.map((error) => `  ${error.path}  ${palette.dim(error.message)}`),
      '',
    );
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function parseReclaimArgs(
  argv: readonly string[],
): { readonly json: boolean; readonly projectRoot: string } | string {
  let options: { json?: boolean; projectRoot?: string } | undefined;
  const program = configureCommanderProgram(new Command('circuit reclaim'))
    .option('--json')
    .option('--project-root <path>')
    .allowExcessArguments(false)
    .action(() => {
      options = program.opts<{ json?: boolean; projectRoot?: string }>();
    });
  try {
    program.parse(argv, { from: 'user' });
  } catch (err) {
    return commanderErrorMessage(err);
  }
  return {
    json: options?.json === true,
    projectRoot: resolve(options?.projectRoot ?? process.cwd()),
  };
}

export async function runReclaimCommand(argv: readonly string[]): Promise<number> {
  const parsed = parseReclaimArgs(argv);
  if (typeof parsed === 'string') {
    process.stderr.write(`error: ${parsed}\n`);
    return 2;
  }

  const projectRoot = parsed.projectRoot;
  const worktreesRoot = join(controlPlaneRoot(projectRoot), 'worktrees');

  const summary = await reapWorktrees({
    worktreesRoot,
    // Anchor `git worktree remove` at the resolved project root so reclaim works
    // when `--project-root` points somewhere other than the process cwd.
    repoRoot: projectRoot,
    resolveRunStatus: makeTraceRunStatusResolver(runsRoot(projectRoot)),
  });

  if (parsed.json) {
    writeJson({
      schema_version: 1,
      worktrees_root: worktreesRoot,
      removed: summary.removed,
      kept: summary.kept,
      errors: summary.errors,
    });
  } else {
    process.stdout.write(
      renderReclaimSummary(terminalPalette(colorEnabled()), { worktreesRoot, ...summary }),
    );
  }

  // A recorded per-worktree failure is operator-visible but does not make the
  // command itself fail: the reaper is best-effort and the summary is the proof.
  return 0;
}
