import { readFile } from 'node:fs/promises';
import { writeJsonAtomic, writeTextAtomic } from '../../shared/atomic-io.js';
import { resolveRunFilePath } from '../../shared/run-file-paths.js';
import type { RunFileRef } from '../domain/run-file.js';
import type { ReportValidator } from './report-validator.js';

export class RunFileStore {
  constructor(
    readonly runDir: string,
    private readonly validateReport?: ReportValidator,
  ) {}

  resolve(ref: RunFileRef | string): string {
    return resolveRunFilePath(this.runDir, typeof ref === 'string' ? ref : ref.path);
  }

  async writeJson(ref: RunFileRef | string, value: unknown): Promise<string> {
    if (typeof ref !== 'string' && ref.schema !== undefined) {
      this.validateReport?.(ref.schema, value);
    }
    const fullPath = this.resolve(ref);
    // Whole-file run artifacts go through atomic-io (stage to a temp sibling,
    // then rename) so a crash mid-write can never leave a half-written file.
    // writeJsonAtomic mkdirs the parent and emits identical bytes to the prior
    // bare write: `${JSON.stringify(value, null, 2)}\n`.
    writeJsonAtomic(fullPath, value);
    return fullPath;
  }

  async writeText(ref: RunFileRef | string, value: string): Promise<string> {
    if (typeof ref !== 'string' && ref.schema !== undefined) {
      throw new Error(
        `writeText cannot write schema-tagged run file '${ref.path}'; use writeJson after parsing and validation`,
      );
    }
    const fullPath = this.resolve(ref);
    writeTextAtomic(fullPath, value);
    return fullPath;
  }

  async readText(ref: RunFileRef | string): Promise<string> {
    return await readFile(this.resolve(ref), 'utf8');
  }

  async readJson<T = unknown>(ref: RunFileRef | string): Promise<T> {
    const raw = await this.readText(ref);
    return JSON.parse(raw) as T;
  }
}
