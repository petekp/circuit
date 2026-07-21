import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import type { LifecycleReportReader } from './lifecycle-types.js';

const MAX_REPORT_BYTES = 262_144;

export class FinalReportReaderError extends Error {
  readonly code: string;
  readonly next_action: string | undefined;

  constructor(code: string, message: string, nextAction?: string) {
    super(message);
    this.name = 'FinalReportReaderError';
    this.code = code;
    this.next_action = nextAction;
  }
}

interface PathIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly modified: bigint;
  readonly changed: bigint;
  readonly links: bigint;
}

function identity(info: BigIntStats): PathIdentity {
  return {
    device: info.dev,
    inode: info.ino,
    size: info.size,
    modified: info.mtimeNs,
    changed: info.ctimeNs,
    links: info.nlink,
  };
}

function sameIdentity(left: PathIdentity, right: PathIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modified === right.modified &&
    left.changed === right.changed &&
    left.links === right.links
  );
}

function pathSegments(path: string): string[] {
  if (
    path.length === 0 ||
    path.length > 4_096 ||
    path.includes('\\') ||
    path.includes('\0') ||
    isAbsolute(path)
  ) {
    throw new FinalReportReaderError(
      'final_report_unsafe',
      'The saved final report path is unsafe.',
    );
  }
  const segments = path.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new FinalReportReaderError(
      'final_report_unsafe',
      'The saved final report path is unsafe.',
    );
  }
  return segments;
}

export class McpFinalReportReader implements LifecycleReportReader {
  async read(input: Parameters<LifecycleReportReader['read']>[0]) {
    const locator = input.run.final_report;
    if (locator === undefined || input.run.state !== 'complete') {
      throw new FinalReportReaderError(
        'final_report_unavailable',
        'This Circuit run does not have a final report.',
      );
    }
    let workspace: string;
    try {
      workspace = await realpath(input.workspace.canonical_path);
    } catch {
      throw new FinalReportReaderError(
        'workspace_unavailable',
        'The trusted Codex workspace is unavailable.',
      );
    }
    if (workspace !== resolve(input.workspace.canonical_path)) {
      throw new FinalReportReaderError(
        'workspace_changed',
        'The trusted Codex workspace changed before Circuit read the report.',
      );
    }
    let workspaceInfo: BigIntStats;
    try {
      workspaceInfo = await lstat(workspace, { bigint: true });
    } catch {
      throw new FinalReportReaderError(
        'workspace_unavailable',
        'The trusted Codex workspace is unavailable.',
      );
    }
    if (
      workspaceInfo.isSymbolicLink() ||
      !workspaceInfo.isDirectory() ||
      String(workspaceInfo.dev) !== input.workspace.device ||
      String(workspaceInfo.ino) !== input.workspace.inode
    ) {
      throw new FinalReportReaderError(
        'workspace_changed',
        'The trusted Codex workspace changed before Circuit read the report.',
      );
    }

    const segments = ['.circuit', 'runs', input.run.run_id, ...pathSegments(locator.path)];
    const directoryIdentities: PathIdentity[] = [];
    let cursor = workspace;
    for (const segment of segments.slice(0, -1)) {
      cursor = join(cursor, segment);
      let info: BigIntStats;
      try {
        info = await lstat(cursor, { bigint: true });
      } catch {
        throw new FinalReportReaderError(
          'final_report_unavailable',
          'The saved final report is unavailable.',
        );
      }
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new FinalReportReaderError(
          'final_report_unsafe',
          'Circuit refused a final report path that crosses a link or non-directory.',
        );
      }
      directoryIdentities.push(identity(info));
    }
    const reportPath = join(cursor, segments.at(-1) ?? '');
    let pathInfo: BigIntStats;
    try {
      pathInfo = await lstat(reportPath, { bigint: true });
    } catch {
      throw new FinalReportReaderError(
        'final_report_unavailable',
        'The saved final report is unavailable.',
      );
    }
    if (pathInfo.isSymbolicLink() || !pathInfo.isFile() || pathInfo.nlink !== 1n) {
      throw new FinalReportReaderError(
        'final_report_unsafe',
        'Circuit refused a final report that is not one ordinary file.',
      );
    }
    if (pathInfo.size > BigInt(MAX_REPORT_BYTES) || pathInfo.size !== BigInt(locator.byte_length)) {
      throw new FinalReportReaderError(
        'final_report_stale',
        'The saved final report size no longer matches the completed run.',
      );
    }

    const handle = await open(reportPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    let descriptorBefore: BigIntStats;
    let descriptorAfter: BigIntStats;
    try {
      descriptorBefore = await handle.stat({ bigint: true });
      bytes = await handle.readFile();
      descriptorAfter = await handle.stat({ bigint: true });
    } finally {
      await handle.close();
    }
    if (
      !sameIdentity(identity(pathInfo), identity(descriptorBefore)) ||
      !sameIdentity(identity(descriptorBefore), identity(descriptorAfter))
    ) {
      throw new FinalReportReaderError(
        'final_report_stale',
        'The saved final report changed while Circuit read it.',
      );
    }
    for (const [index, expected] of directoryIdentities.entries()) {
      const path = join(workspace, ...segments.slice(0, index + 1));
      const observed = await lstat(path, { bigint: true });
      if (
        observed.isSymbolicLink() ||
        !observed.isDirectory() ||
        !sameIdentity(expected, identity(observed))
      ) {
        throw new FinalReportReaderError(
          'final_report_stale',
          'The final report path changed while Circuit read it.',
        );
      }
    }
    const finalPathInfo = await lstat(reportPath, { bigint: true });
    if (
      finalPathInfo.isSymbolicLink() ||
      !sameIdentity(identity(pathInfo), identity(finalPathInfo))
    ) {
      throw new FinalReportReaderError(
        'final_report_stale',
        'The saved final report changed while Circuit read it.',
      );
    }
    if (createHash('sha256').update(bytes).digest('hex') !== locator.sha256) {
      throw new FinalReportReaderError(
        'final_report_stale',
        'The saved final report contents no longer match the completed run.',
      );
    }
    let data: unknown;
    try {
      data = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new FinalReportReaderError(
        'final_report_invalid',
        'The saved final report is not valid JSON.',
      );
    }
    return { schema: locator.schema, summary: locator.summary, data };
  }
}
