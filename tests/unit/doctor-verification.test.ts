// `circuit doctor`'s verification probe.
//
// Build and Fix both stop before their first step if they cannot find a
// command that proves a change. That used to be discoverable only by starting
// a run and reading a package.json complaint in a project that has no
// package.json. Doctor answers it up front, and names the config key that
// fixes it.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { probeVerification, renderDoctorReport } from '../../src/cli/doctor.js';
import { terminalPalette } from '../../src/cli/terminal-style.js';

const roots: string[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const plain = terminalPalette(false);

describe('probeVerification', () => {
  it('reports the package.json script a Node project would use', () => {
    const root = tempRoot('doctor-verification-scripts-');
    writeFileSync(
      join(root, 'package.json'),
      `${JSON.stringify({ private: true, scripts: { verify: 'vitest' } })}\n`,
    );

    const probe = probeVerification(root, false);

    expect(probe.status).toBe('ready');
    expect(probe.commands[0]?.argv).toEqual(['npm', 'run', 'verify']);
    expect(probe.detail).toContain('package.json');
  });

  it('reports the declared command and where it came from', () => {
    const root = tempRoot('doctor-verification-declared-');
    mkdirSync(join(root, '.circuit'), { recursive: true });
    writeFileSync(
      join(root, '.circuit', 'config.yaml'),
      ['schema_version: 1', 'verification:', '  general:', '    argv: [pytest, -q]', ''].join('\n'),
    );

    const probe = probeVerification(root, true);

    expect(probe).toMatchObject({
      status: 'ready',
      declared: true,
      detail: 'declared in .circuit/config.yaml',
    });
    expect(probe.commands[0]?.argv).toEqual(['pytest', '-q']);
  });

  it('says plainly when a project has no proof command, and names the fix', () => {
    const root = tempRoot('doctor-verification-none-');

    const probe = probeVerification(root, false);
    expect(probe.status).toBe('blocked');
    expect(probe.commands).toEqual([]);

    const report = renderDoctorReport(plain, [], [], probe);
    expect(report).toContain('Build and Fix have no way to prove a change in this project.');
    expect(report).toContain("circuit config set verification.general '{argv: [make, check]}'");
  });

  it('shows the resolved command in the report when one exists', () => {
    const root = tempRoot('doctor-verification-render-');
    mkdirSync(join(root, '.circuit'), { recursive: true });
    writeFileSync(
      join(root, '.circuit', 'config.yaml'),
      [
        'schema_version: 1',
        'verification:',
        '  general:',
        '    argv: [cargo, test]',
        '    cwd: crates/core',
        '',
      ].join('\n'),
    );

    const report = renderDoctorReport(plain, [], [], probeVerification(root, true));

    expect(report).toContain('Build and Fix would prove a change with: cargo test in crates/core');
  });
});
