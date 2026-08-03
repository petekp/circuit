import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type FreezeArgs,
  defaultTranscriptPath,
  freezeSession,
  parseFreezeArgs,
} from '../../evals/resumption-quiz/freeze-session.ts';
import { type FreezeTimeGit, bundleLayout } from '../../evals/resumption-quiz/shared/types.ts';

const FIXTURE_ROOT = resolve('tests/evals/fixtures/resumption-quiz');
const FIXTURE_TRANSCRIPT = join(FIXTURE_ROOT, 'transcript.jsonl');
const FIXTURE_CONTINUITY = join(FIXTURE_ROOT, 'continuity');
const SESSION_ID = 'synthetic-quiz-fixture-001';

const FROZEN_NOW = new Date('2026-06-11T09:00:00.000Z');
const GIT_FACTS: FreezeTimeGit = {
  branch: 'fix/duration-units',
  head: 'abc1234abc1234abc1234abc1234abc1234abc12',
  status_short: ' M src/duration.ts\n M tests/duration.test.ts',
};

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function syntheticProject({ withContinuity = true } = {}): {
  projectRoot: string;
  transcriptPath: string;
  outDir: string;
} {
  const root = tempDir('rq-freeze-');
  const projectRoot = join(root, 'project');
  mkdirSync(projectRoot, { recursive: true });
  if (withContinuity) {
    cpSync(FIXTURE_CONTINUITY, join(projectRoot, '.circuit', 'continuity'), { recursive: true });
  }
  const transcriptPath = join(root, 'transcript.jsonl');
  copyFileSync(FIXTURE_TRANSCRIPT, transcriptPath);
  return { projectRoot, transcriptPath, outDir: join(root, 'sessions') };
}

function freezeArgs(overrides: Partial<FreezeArgs> = {}): FreezeArgs {
  const project = syntheticProject();
  return {
    sessionId: SESSION_ID,
    transcriptPath: project.transcriptPath,
    projectRoot: project.projectRoot,
    outDir: project.outDir,
    dryRun: false,
    ...overrides,
  };
}

function fixtureSha256(): string {
  return createHash('sha256').update(readFileSync(FIXTURE_TRANSCRIPT)).digest('hex');
}

describe('freezeSession bundle layout', () => {
  it('writes a byte-identical transcript copy with a stable sha256', () => {
    const args = freezeArgs();
    const manifest = freezeSession(args, { now: () => FROZEN_NOW, gitProbe: () => GIT_FACTS });
    const layout = bundleLayout(join(args.outDir, SESSION_ID));

    const copied = readFileSync(layout.transcript);
    expect(copied.equals(readFileSync(FIXTURE_TRANSCRIPT))).toBe(true);
    expect(manifest.transcript_sha256).toBe(fixtureSha256());
    expect(manifest.transcript_bytes).toBe(copied.byteLength);

    // The same bytes frozen twice hash identically: the hash depends on the
    // transcript alone, never on freeze time or machine state.
    const again = freezeSession(freezeArgs(), { now: () => new Date(), gitProbe: () => GIT_FACTS });
    expect(again.transcript_sha256).toBe(manifest.transcript_sha256);
  });

  it('records session identity, freeze time, and injected git facts', () => {
    const args = freezeArgs();
    const manifest = freezeSession(args, { now: () => FROZEN_NOW, gitProbe: () => GIT_FACTS });

    expect(manifest.schema_version).toBe(1);
    expect(manifest.session_id).toBe(SESSION_ID);
    expect(manifest.project_root).toBe(resolve(args.projectRoot));
    expect(manifest.frozen_at).toBe(FROZEN_NOW.toISOString());
    expect(manifest.freeze_time_git).toEqual(GIT_FACTS);

    const layout = bundleLayout(join(args.outDir, SESSION_ID));
    const onDisk = JSON.parse(readFileSync(layout.bundle_json, 'utf8'));
    expect(onDisk).toEqual(manifest);
  });

  it('copies the continuity control plane and lists record stems', () => {
    const args = freezeArgs();
    const manifest = freezeSession(args, { now: () => FROZEN_NOW, gitProbe: () => GIT_FACTS });
    const layout = bundleLayout(join(args.outDir, SESSION_ID));

    expect(existsSync(join(layout.continuity_dir, 'index.json'))).toBe(true);
    expect(existsSync(join(layout.continuity_dir, 'records', `ambient-${SESSION_ID}.json`))).toBe(
      true,
    );
    expect(manifest.continuity_records_present).toEqual([
      `ambient-${SESSION_ID}`,
      'continuity-8c4a1f2e-9b3d-4c5a-a6e7-2d1f0b9c8a7e',
    ]);
  });

  it('freezes a project with no continuity dir to an empty record list', () => {
    const project = syntheticProject({ withContinuity: false });
    const args = freezeArgs({
      projectRoot: project.projectRoot,
      transcriptPath: project.transcriptPath,
      outDir: project.outDir,
    });
    const manifest = freezeSession(args, { now: () => FROZEN_NOW, gitProbe: () => GIT_FACTS });
    const layout = bundleLayout(join(args.outDir, SESSION_ID));

    expect(manifest.continuity_records_present).toEqual([]);
    // The dir still exists so downstream arm building can copy it blindly.
    expect(existsSync(layout.continuity_dir)).toBe(true);
  });
});

describe('freezeSession refusals and dry run', () => {
  it('dry run validates and returns the manifest without writing anything', () => {
    const args = freezeArgs({ dryRun: true });
    const manifest = freezeSession(args, { now: () => FROZEN_NOW, gitProbe: () => GIT_FACTS });
    expect(manifest.transcript_sha256).toBe(fixtureSha256());
    expect(existsSync(join(args.outDir, SESSION_ID))).toBe(false);
  });

  it('refuses to freeze over an existing bundle', () => {
    const args = freezeArgs();
    freezeSession(args, { now: () => FROZEN_NOW, gitProbe: () => GIT_FACTS });
    expect(() => freezeSession(args, { now: () => FROZEN_NOW, gitProbe: () => GIT_FACTS })).toThrow(
      /already exists/,
    );
  });

  it('fails loudly on a missing transcript', () => {
    const args = freezeArgs({ transcriptPath: '/nonexistent/transcript.jsonl' });
    expect(() => freezeSession(args, { now: () => FROZEN_NOW, gitProbe: () => GIT_FACTS })).toThrow(
      /transcript not found/,
    );
  });
});

describe('parseFreezeArgs', () => {
  it('requires --session-id', () => {
    expect(() => parseFreezeArgs([])).toThrow(/--session-id/);
  });

  it('rejects session ids that are not safe path segments', () => {
    expect(() => parseFreezeArgs(['--session-id', '../escape'])).toThrow(/safe path segment/);
    expect(() => parseFreezeArgs(['--session-id', 'a/b'])).toThrow(/safe path segment/);
  });

  it('defaults project root to cwd and out dir to the sessions root', () => {
    const args = parseFreezeArgs(['--session-id', SESSION_ID]);
    expect(args.projectRoot).toBe(process.cwd());
    expect(args.outDir).toBe(resolve('evals/resumption-quiz/sessions'));
    expect(args.dryRun).toBe(false);
  });

  it('derives the default transcript path from the host transcript layout', () => {
    const args = parseFreezeArgs(['--session-id', SESSION_ID, '--project-root', '/tmp/my.proj']);
    expect(args.transcriptPath).toBe(
      join(homedir(), '.claude', 'projects', '-tmp-my-proj', `${SESSION_ID}.jsonl`),
    );
    expect(defaultTranscriptPath('/Users/synthetic/projects/parse-config', SESSION_ID)).toBe(
      join(
        homedir(),
        '.claude',
        'projects',
        '-Users-synthetic-projects-parse-config',
        `${SESSION_ID}.jsonl`,
      ),
    );
  });

  it('honors explicit --transcript, --out, and --dry-run', () => {
    const args = parseFreezeArgs([
      '--session-id',
      SESSION_ID,
      '--transcript',
      '/tmp/explicit.jsonl',
      '--out',
      '/tmp/bundles',
      '--dry-run',
    ]);
    expect(args.transcriptPath).toBe('/tmp/explicit.jsonl');
    expect(args.outDir).toBe('/tmp/bundles');
    expect(args.dryRun).toBe(true);
  });

  it('rejects unknown args and flags missing values', () => {
    expect(() => parseFreezeArgs(['--session-id', SESSION_ID, '--bogus'])).toThrow(/unknown arg/);
    expect(() => parseFreezeArgs(['--session-id'])).toThrow(/requires a value/);
  });
});
