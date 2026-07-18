import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type DoctorConnectorEntry, renderDoctorReport } from '../../src/cli/doctor.js';
import { terminalPalette } from '../../src/cli/terminal-style.js';
import { workspaceHygieneFindings } from '../../src/cli/workspace-hygiene.js';

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'circuit-workspace-hygiene-'));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function seedCircuitDir(): void {
  mkdirSync(join(projectRoot, '.circuit', 'runs'), { recursive: true });
}

describe('workspaceHygieneFindings (pdk-poc formatter friction)', () => {
  it('flags a Prettier repo whose ignore files do not cover .circuit', () => {
    seedCircuitDir();
    writeFileSync(join(projectRoot, '.prettierrc'), '{}\n');

    const findings = workspaceHygieneFindings(projectRoot);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe('prettier-sweeps-circuit');
    expect(findings[0]?.remediation).toContain('.prettierignore');
  });

  it('detects Prettier through a package.json devDependency', () => {
    seedCircuitDir();
    writeFileSync(
      join(projectRoot, 'package.json'),
      `${JSON.stringify({ devDependencies: { prettier: '^3.0.0' } })}\n`,
    );

    expect(workspaceHygieneFindings(projectRoot)).toHaveLength(1);
  });

  it('detects Prettier through a bare .prettierignore file', () => {
    seedCircuitDir();
    writeFileSync(join(projectRoot, '.prettierignore'), 'dist\n');

    expect(workspaceHygieneFindings(projectRoot)).toHaveLength(1);
  });

  it('stays quiet before Circuit has written a .circuit control plane', () => {
    writeFileSync(join(projectRoot, '.prettierrc'), '{}\n');

    expect(workspaceHygieneFindings(projectRoot)).toEqual([]);
  });

  it('stays quiet when the repo has no Prettier setup', () => {
    seedCircuitDir();
    writeFileSync(join(projectRoot, 'package.json'), `${JSON.stringify({ private: true })}\n`);

    expect(workspaceHygieneFindings(projectRoot)).toEqual([]);
  });

  it.each(['.circuit', '.circuit/', '/.circuit', '.circuit/**', '**/.circuit'])(
    'accepts a %s line in .prettierignore as coverage',
    (line) => {
      seedCircuitDir();
      writeFileSync(join(projectRoot, '.prettierrc'), '{}\n');
      writeFileSync(join(projectRoot, '.prettierignore'), `dist\n${line}\n`);

      expect(workspaceHygieneFindings(projectRoot)).toEqual([]);
    },
  );

  it('accepts a .circuit line in the root .gitignore (Prettier 3 reads it)', () => {
    seedCircuitDir();
    writeFileSync(join(projectRoot, '.prettierrc'), '{}\n');
    writeFileSync(join(projectRoot, '.gitignore'), 'node_modules\n.circuit/\n');

    expect(workspaceHygieneFindings(projectRoot)).toEqual([]);
  });

  it('does not treat a lookalike path like .circuits as coverage', () => {
    seedCircuitDir();
    writeFileSync(join(projectRoot, '.prettierrc'), '{}\n');
    writeFileSync(join(projectRoot, '.prettierignore'), '.circuits\nfoo/.circuit-cache\n');

    expect(workspaceHygieneFindings(projectRoot)).toHaveLength(1);
  });

  it('the nested seeded .circuit/.gitignore does NOT count as coverage', () => {
    // The exact pdk-poc blind spot: Circuit seeds .circuit/.gitignore, but
    // Prettier never reads nested .gitignore files, so the finding must fire.
    seedCircuitDir();
    writeFileSync(join(projectRoot, '.circuit', '.gitignore'), '*\n!.gitignore\n');
    writeFileSync(join(projectRoot, '.prettierrc'), '{}\n');

    expect(workspaceHygieneFindings(projectRoot)).toHaveLength(1);
  });

  it('survives a malformed package.json without throwing', () => {
    seedCircuitDir();
    writeFileSync(join(projectRoot, 'package.json'), '{not json');

    expect(workspaceHygieneFindings(projectRoot)).toEqual([]);
  });
});

describe('doctor report workspace section', () => {
  const palette = terminalPalette(false);
  const entries: readonly DoctorConnectorEntry[] = [
    {
      connector: 'claude-code',
      executable: 'claude',
      state: 'ok',
      detail: 'ready',
      chosen: true,
      chosen_by: ['auto'],
    },
  ];

  it('renders workspace findings with the paste-able fix', () => {
    const report = renderDoctorReport(palette, entries, [
      {
        id: 'prettier-sweeps-circuit',
        detail: 'this repo runs Prettier without covering .circuit',
        remediation: "add a '.circuit/' line to .prettierignore.",
      },
    ]);

    expect(report).toContain('Workspace');
    expect(report).toContain('this repo runs Prettier without covering .circuit');
    expect(report).toContain("fix: add a '.circuit/' line to .prettierignore.");
  });

  it('omits the workspace section when there are no findings', () => {
    expect(renderDoctorReport(palette, entries, [])).not.toContain('Workspace');
    expect(renderDoctorReport(palette, entries)).not.toContain('Workspace');
  });
});
