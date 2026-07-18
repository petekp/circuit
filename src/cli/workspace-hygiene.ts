// `circuit doctor` workspace probe: will this repo's formatter sweep the
// `.circuit/` control plane?
//
// Circuit seeds `.circuit/.gitignore` so machine-written run records never get
// committed, but repo-wide format hooks (`prettier --check .` in a pre-commit
// hook or CI) do not read nested .gitignore files: Prettier only honors the
// ignore files at the directory it runs from. A repo with such a hook chokes
// on run evidence JSON the first time a run writes it. This probe detects the
// setup and hands the operator the one-line fix. It is informational only and
// never affects doctor's exit code.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface WorkspaceHygieneFinding {
  readonly id: 'prettier-sweeps-circuit';
  readonly detail: string;
  readonly remediation: string;
}

const PRETTIER_CONFIG_FILES = [
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.yml',
  '.prettierrc.yaml',
  '.prettierrc.json5',
  '.prettierrc.js',
  '.prettierrc.cjs',
  '.prettierrc.mjs',
  '.prettierrc.toml',
  'prettier.config.js',
  'prettier.config.cjs',
  'prettier.config.mjs',
];

// A line that hides `.circuit` from a root-level ignore file, in the forms
// operators actually write: `.circuit`, `.circuit/`, `/.circuit`,
// `.circuit/**`, `**/.circuit`.
const CIRCUIT_IGNORE_LINE = /^(\*\*\/)?\/?\.circuit(\/(\*\*)?)?$/;

function fileHasCircuitLine(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .some((line) => CIRCUIT_IGNORE_LINE.test(line.trim()));
  } catch {
    return false;
  }
}

function hasPrettierSetup(projectRoot: string): boolean {
  if (PRETTIER_CONFIG_FILES.some((name) => existsSync(join(projectRoot, name)))) return true;
  if (existsSync(join(projectRoot, '.prettierignore'))) return true;
  const packageJsonPath = join(projectRoot, 'package.json');
  if (!existsSync(packageJsonPath)) return false;
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      prettier?: unknown;
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    if (parsed.prettier !== undefined) return true;
    return (
      Object.hasOwn(parsed.devDependencies ?? {}, 'prettier') ||
      Object.hasOwn(parsed.dependencies ?? {}, 'prettier')
    );
  } catch {
    // An unreadable package.json is someone else's problem; the probe only
    // reports setups it can positively identify.
    return false;
  }
}

/**
 * Report workspace-hygiene problems doctor should surface for `projectRoot`.
 * Quiet until Circuit has actually written a `.circuit/` control plane there:
 * before that, a format hook has nothing to trip over.
 */
export function workspaceHygieneFindings(projectRoot: string): readonly WorkspaceHygieneFinding[] {
  if (!existsSync(join(projectRoot, '.circuit'))) return [];
  if (!hasPrettierSetup(projectRoot)) return [];
  const covered =
    fileHasCircuitLine(join(projectRoot, '.prettierignore')) ||
    // Prettier 3 honors the repo-root .gitignore by default, so a `.circuit`
    // line there also covers it. Circuit's own seeded ignore lives NESTED at
    // `.circuit/.gitignore`, which Prettier never reads; that blind spot is
    // exactly what this probe exists to catch.
    fileHasCircuitLine(join(projectRoot, '.gitignore'));
  if (covered) return [];
  return [
    {
      id: 'prettier-sweeps-circuit',
      detail:
        "this repo runs Prettier, and '.circuit/' is not listed in .prettierignore or the root .gitignore, so repo-wide format hooks will choke on Circuit's machine-written run records.",
      remediation: "add a '.circuit/' line to .prettierignore (or the root .gitignore).",
    },
  ];
}
