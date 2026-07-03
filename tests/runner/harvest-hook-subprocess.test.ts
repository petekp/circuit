import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ContinuityIndex, ContinuityRecord } from '../../src/index.js';

// End-to-end proof of the harvest hook's outer skin. `handoff-harvest.test.ts`
// exercises the harvest LOGIC in-process, and `plugin-node-floor.test.ts` proves
// the `.js` shim guards old Node — but neither runs the real
// `plugins/claude/hooks/harvest.js` -> `harvest.ts` -> launcher -> runtime chain
// as a subprocess on the current Node with realistic host hook-input JSON on
// stdin. That middle is exactly where AGENTS.md rule 6 lives: the hook must take
// its workspace identity from the stdin hook-input `cwd`, never from
// `process.cwd()`. This test drives the whole chain and asserts a real ambient
// record lands where the stdin `cwd` dictates.
//
// Why the file-existence assertion matters: harvest.ts's robustness contract
// returns 0 on every path (a continuity harvest must never break the session it
// fires in), including when the launcher is missing or the spawn fails. So exit
// 0 alone is a vacuous pass — the record MUST be on disk with the harvested
// intent for the test to mean anything.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const harvestShim = resolve(repoRoot, 'plugins/claude/hooks/harvest.js');

const tempRoots: string[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

// The Claude host sends a Stop hook a JSON object on stdin. harvest.ts reads
// `cwd`, `transcript_path`, `session_id`, and `hook_event_name` from it (see
// harvest.ts readInput/main). Mirror that shape exactly.
function runHarvestHook(
  input: Record<string, unknown>,
  options: { readonly processCwd: string },
): { status: number | null; stdout: string; stderr: string } {
  // Rule 6 is about the hook, not an inherited project dir: omit
  // CLAUDE_PROJECT_DIR so a real repo value in the test runner's environment
  // can never mask a `process.cwd()` regression by accident.
  const { CLAUDE_PROJECT_DIR: _omitProjectDir, ...baseEnv } = process.env;
  const childEnv = {
    ...baseEnv,
    // The chain cold-starts two type-stripped .ts processes plus the ~3MB
    // bundled runtime; the hook's default internal spawn timeout is only 5s.
    // Give it real headroom so a slow/cold CI box does not time the harvest out
    // and skip the write (which would surface here as a missing record).
    CIRCUIT_HARVEST_HOOK_TIMEOUT_MS: '60000',
    // Debug on: if any silent-return-0 path is taken, its reason lands on
    // stderr for diagnosis instead of vanishing.
    CIRCUIT_HANDOFF_HOOK_DEBUG: '1',
  };

  const result = spawnSync(process.execPath, [harvestShim], {
    cwd: options.processCwd,
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: childEnv,
    timeout: 90_000,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe('harvest hook subprocess (real .js -> .ts -> runtime chain)', () => {
  it('writes the ambient record under the stdin cwd, not the process cwd (rule 6)', () => {
    const projectRoot = tempRoot('circuit-harvest-subproc-project-');
    const processCwd = tempRoot('circuit-harvest-subproc-cwd-');
    const transcriptPath = join(projectRoot, 'transcript.jsonl');
    const intent = 'F6 subprocess harvest end-to-end intent';
    writeFileSync(
      transcriptPath,
      `${JSON.stringify({ type: 'user', message: { role: 'user', content: intent } })}\n`,
    );

    // The hook process runs from processCwd — a DIFFERENT directory than the
    // project root — while the hook-input names projectRoot as the workspace.
    const result = runHarvestHook(
      {
        hook_event_name: 'Stop',
        cwd: projectRoot,
        transcript_path: transcriptPath,
        session_id: 'f6subproc',
      },
      { processCwd },
    );

    // Robustness contract: the hook always exits 0. This is necessary but not
    // sufficient — the record assertions below are what make the pass real.
    expect(result.status, result.stderr).toBe(0);

    // The record must land under the stdin cwd (the project root), keyed by
    // session id, and nowhere else.
    const recordsDir = join(projectRoot, '.circuit/continuity/records');
    const ambientRecords = existsSync(recordsDir)
      ? readdirSync(recordsDir).filter((f) => f.startsWith('ambient-') && f.endsWith('.json'))
      : [];
    expect(ambientRecords, `hook stderr:\n${result.stderr}`).toEqual(['ambient-f6subproc.json']);

    const record = ContinuityRecord.parse(
      JSON.parse(readFileSync(join(recordsDir, 'ambient-f6subproc.json'), 'utf8')),
    );
    expect(record).toMatchObject({
      continuity_kind: 'ambient',
      ambient_provenance: {
        session_id: 'f6subproc',
        source: 'stop',
        transcript_path: transcriptPath,
      },
    });
    // The genuine intent survived the whole chain into the record.
    expect(record.narrative.goal).toContain(intent);

    // The index at the project root points at the freshly written record.
    const index = ContinuityIndex.parse(
      JSON.parse(readFileSync(join(projectRoot, '.circuit/continuity/index.json'), 'utf8')),
    );
    expect(index.ambient_record).toMatchObject({
      record_id: 'ambient-f6subproc',
      continuity_kind: 'ambient',
    });

    // Rule 6, stated as an absence: the process cwd must be untouched. A
    // `process.cwd()` regression in the hook path would write the store here.
    expect(existsSync(join(processCwd, '.circuit'))).toBe(false);
  });

  it('records the pre-compact source when the host fires PreCompact', () => {
    const projectRoot = tempRoot('circuit-harvest-subproc-precompact-');
    const processCwd = tempRoot('circuit-harvest-subproc-precompact-cwd-');
    const transcriptPath = join(projectRoot, 'transcript.jsonl');
    writeFileSync(
      transcriptPath,
      `${JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'capture before the host compacts' },
      })}\n`,
    );

    const result = runHarvestHook(
      {
        hook_event_name: 'PreCompact',
        cwd: projectRoot,
        transcript_path: transcriptPath,
        session_id: 'f6precompact',
      },
      { processCwd },
    );

    expect(result.status, result.stderr).toBe(0);
    const recordPath = join(projectRoot, '.circuit/continuity/records/ambient-f6precompact.json');
    expect(existsSync(recordPath), `hook stderr:\n${result.stderr}`).toBe(true);
    const record = ContinuityRecord.parse(JSON.parse(readFileSync(recordPath, 'utf8')));
    // The firing hook names the capture source honestly: PreCompact -> pre-compact.
    expect(record).toMatchObject({
      continuity_kind: 'ambient',
      ambient_provenance: { source: 'pre-compact' },
    });
  });
});
