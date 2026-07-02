// Portable flow-file format (experimental, default-OFF): the loader.
//
// A flow-file is a CompositionRoleSet written by hand — the file-authored sibling
// of `circuit generate`'s model proposal. These tests lock the whole seam the way
// composition-propose.test.ts locks the model seam, but with a FILE in the model's
// seat: a sample parses to the right role set; each of the three canonical samples
// runs end to end through the SAME floor the generate path uses and compiles to a
// valid CompiledFlow whose id equals the file's id; a wrong file fails CLOSED at
// the right gate with the floor's real error; equipment maps to the real scope;
// and the skill `requires` resolver flags a missing id against an injected root.
//
// The samples under docs/ideas/flow-file-samples/ are the e2e fixtures, loaded
// from disk so the doc artifacts and the parser can never silently drift.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadFlowFile,
  parseFlowFile,
  resolveRequiredSkills,
} from '../../src/flows/composition/flow-file.js';
import { profileToScope } from '../../src/flows/composition/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const samplesDir = join(here, '..', '..', 'docs', 'ideas', 'flow-file-samples');

function sample(name: string): string {
  return readFileSync(join(samplesDir, `${name}.flow.md`), 'utf8');
}

const SAMPLE_NAMES = ['flake-hunter', 'tighten-loop', 'ship-with-build'] as const;

describe('portable flow-file — parseFlowFile', () => {
  it('maps the flake-hunter sample to the expected CompositionRoleSet', () => {
    const { roleSet, skills } = parseFlowFile(sample('flake-hunter'));

    expect(roleSet.id).toBe('flake-hunter');
    expect(roleSet.title).toBe('Flake Hunter');
    expect(roleSet.purpose.length).toBeGreaterThan(0);

    expect(
      roleSet.roles.map((role) => ({
        stage: role.stage,
        block: role.block,
        kind: role.executionKind,
        role: role.relayRole,
        equipment: role.equipment,
        terminal: role.terminal,
      })),
    ).toEqual([
      {
        stage: 'frame',
        block: 'frame',
        kind: 'compose',
        role: undefined,
        equipment: undefined,
        terminal: undefined,
      },
      {
        stage: 'analyze',
        block: 'diagnose',
        kind: 'relay',
        role: 'researcher',
        equipment: 'read-only',
        terminal: undefined,
      },
      {
        stage: 'act',
        block: 'act',
        kind: 'relay',
        role: 'implementer',
        equipment: 'editor',
        terminal: undefined,
      },
      {
        stage: 'verify',
        block: 'run-verification',
        kind: 'verification',
        role: undefined,
        equipment: undefined,
        terminal: undefined,
      },
      {
        stage: 'review',
        block: 'review',
        kind: 'relay',
        role: 'reviewer',
        equipment: 'read-only',
        terminal: undefined,
      },
      // The close step is auto-marked terminal because no step declared terminal.
      {
        stage: 'close',
        block: 'close-with-evidence',
        kind: 'compose',
        role: undefined,
        equipment: undefined,
        terminal: true,
      },
    ]);

    // The skills block is parsed and carried through (slots + requires).
    expect(skills.requires).toEqual(['flake-triage']);
    expect(skills.slots).toEqual([
      { id: 'flake-triage', description: 'How this team reproduces and isolates a flaky test.' },
    ]);
  });

  it('infers the goal-child-run block for a kind: sub-run step (ship-with-build)', () => {
    const { roleSet } = parseFlowFile(sample('ship-with-build'));
    const subRun = roleSet.roles.find((role) => role.executionKind === 'sub-run');
    expect(subRun).toBeDefined();
    // The author wrote `kind: sub-run, flow: build` with no block id; the parser
    // expands it to the one catalog block whose sole execution kind is sub-run.
    expect(subRun?.block).toBe('goal-child-run');
    expect(subRun?.flowId).toBe('build');
    expect(subRun?.goalText).toBe('implement the framed change');
    expect(subRun?.subRunDepth).toBe('medium');
  });

  it('keeps the Markdown body as notes', () => {
    const { notes } = parseFlowFile(sample('flake-hunter'));
    expect(notes).toContain('Use this when a test fails intermittently');
  });
});

describe('portable flow-file — loadFlowFile end to end', () => {
  for (const name of SAMPLE_NAMES) {
    it(`compiles the ${name} sample to a valid CompiledFlow whose id equals the file id`, () => {
      const result = loadFlowFile(sample(name));
      if (!result.ok) {
        throw new Error(
          `flow-file '${name}' failed at stage '${result.stage}': ${result.errors.join(' | ')}`,
        );
      }
      expect(result.ok).toBe(true);
      expect(result.compiled.id as unknown as string).toBe(name);
      expect(result.compiled.steps.length).toBeGreaterThan(0);
      // The compiled flow binds a primary result (goal-reaching), proven by the
      // floor; the schematic carries the file's id verbatim.
      expect(result.schematic.id as unknown as string).toBe(name);
    });
  }

  it('tighten-loop emits the bounded back-edge (verify retry -> act)', () => {
    const result = loadFlowFile(sample('tighten-loop'));
    if (!result.ok) throw new Error(`unexpected failure: ${result.errors.join(' | ')}`);
    const verify = result.compiled.steps.find(
      (step) => (step.id as unknown as string) === 'run-verification',
    );
    const retryTarget = verify?.routes.retry as unknown as string | undefined;
    expect(retryTarget).toBe('act');
  });
});

describe('portable flow-file — fail-closed cases', () => {
  it('an unknown block id fails at parse with a named error', () => {
    const text = [
      '---',
      'id: bad-block',
      'title: Bad Block',
      'purpose: References a block that does not exist in the catalog.',
      'steps:',
      '  - { stage: frame, block: frame }',
      '  - { stage: analyze, block: not-a-real-block, role: researcher }',
      '  - { stage: close, block: close-with-evidence }',
      '---',
    ].join('\n');
    const result = loadFlowFile(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe('parse');
    expect(result.errors.join(' ')).toMatch(/unknown block id 'not-a-real-block'/);
  });

  it('a step that reads a result nothing upstream produces fails at compose', () => {
    // `act` requires a plan or diagnosis in addition to the brief; opening with
    // frame -> act produces neither, so the composer walls with no satisfiable
    // input set (the floor's real error, named back to the author).
    const text = [
      '---',
      'id: missing-producer',
      'title: Missing Producer',
      'purpose: The act step reads a result no upstream step produces.',
      'steps:',
      '  - { stage: frame, block: frame }',
      '  - { stage: act, block: act, role: implementer }',
      '  - { stage: close, block: close-with-evidence }',
      '---',
    ].join('\n');
    const result = loadFlowFile(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe('compose');
    expect(result.errors.join(' ')).toMatch(/no input set satisfiable/);
  });

  it('a malformed frontmatter document fails at parse', () => {
    // Missing the closing fence: there is no parseable frontmatter at all.
    const text = ['---', 'id: broken', 'title: Broken', 'steps: []', 'no closing fence here'].join(
      '\n',
    );
    const result = loadFlowFile(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe('parse');
    expect(result.errors.join(' ')).toMatch(/no YAML frontmatter|malformed/);
  });

  it('a frontmatter document missing a required field fails at parse', () => {
    const text = [
      '---',
      'id: no-steps',
      'title: No Steps',
      'purpose: Has no steps array.',
      '---',
    ].join('\n');
    const result = loadFlowFile(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe('parse');
    expect(result.errors.join(' ')).toMatch(/steps/);
  });
});

describe('portable flow-file — equipment', () => {
  it('a read-only equipment value maps to the read-only scope on that step', () => {
    const result = loadFlowFile(sample('flake-hunter'));
    if (!result.ok) throw new Error(`unexpected failure: ${result.errors.join(' | ')}`);
    const diagnose = result.compiled.steps.find(
      (step) => (step.id as unknown as string) === 'diagnose',
    );
    expect(diagnose?.equipment_scope).toEqual(profileToScope('read-only'));
  });
});

describe('portable flow-file — resolveRequiredSkills', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'circuit-flow-file-skills-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('flags a missing id and accepts a present one against an injected root', () => {
    // Plant one skill under the injected root; leave the other unplanted.
    const present = 'flake-triage';
    const missing = 'does-not-exist';
    mkdirSync(join(root, present), { recursive: true });
    writeFileSync(join(root, present, 'SKILL.md'), '# Flake triage\n', 'utf8');

    const result = resolveRequiredSkills([present, missing], { roots: [root] });
    expect(result.present).toEqual([present]);
    expect(result.missing).toEqual([missing]);
  });
});
