import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import type { z } from 'zod';
import {
  OriginalCapabilitySnapshot,
  ParityExceptionLedger,
  ProofScenarioIndex,
  PublicClaimLedger,
} from '../../src/release/schemas.js';
import { CustomFlowPackageDescriptor } from '../../src/schemas/custom-flow-descriptor.js';

const root = resolve(__dirname, '..', '..');
const yamlValidationDocPath = 'docs/yaml-validation.md';

const schemaByPath = {
  'docs/release/claims/public-claims.yaml': PublicClaimLedger,
  'docs/release/parity/exceptions.yaml': ParityExceptionLedger,
  'docs/release/parity/original-circuit.yaml': OriginalCapabilitySnapshot,
  'docs/release/proofs/index.yaml': ProofScenarioIndex,
  'docs/release/proofs/runs/customization/custom-home/drafts/release-note-flow/circuit.yaml':
    CustomFlowPackageDescriptor,
  'docs/release/proofs/runs/customization/custom-home/skills/release-note-flow/circuit.yaml':
    CustomFlowPackageDescriptor,
} satisfies Record<string, z.ZodTypeAny>;

const externalYamlPaths = new Set([
  '.github/workflows/codex-compatibility.yml',
  '.github/workflows/verify.yml',
]);

function trackedYamlFiles(): string[] {
  return execFileSync('git', ['ls-files', '*.yaml', '*.yml'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .sort();
}

// Two checked-in customization proofs are FROZEN records captured before M9
// retired the custom-flow `archetype` field. Mirror the `entry` precedent in
// tests/release/release-infrastructure.test.ts: strip the legacy key at the
// parse site so the strict descriptor schema validates the historical record,
// rather than rewriting frozen release evidence.
const LEGACY_ARCHETYPE_PROOF_PATHS = new Set([
  'docs/release/proofs/runs/customization/custom-home/drafts/release-note-flow/circuit.yaml',
  'docs/release/proofs/runs/customization/custom-home/skills/release-note-flow/circuit.yaml',
]);

function parseYamlFile(relPath: string): unknown {
  const parsed: unknown = YAML.parse(readFileSync(resolve(root, relPath), 'utf8'));
  if (
    LEGACY_ARCHETYPE_PROOF_PATHS.has(relPath) &&
    parsed !== null &&
    typeof parsed === 'object' &&
    'archetype' in parsed
  ) {
    const { archetype: _legacyArchetype, ...rest } = parsed as Record<string, unknown>;
    return rest;
  }
  return parsed;
}

describe('checked-in YAML surfaces', () => {
  it('classifies every tracked YAML file', () => {
    const tracked = trackedYamlFiles();
    const classified = new Set([...Object.keys(schemaByPath), ...externalYamlPaths]);
    const unclassified = tracked.filter((path) => !classified.has(path));
    const staleClassifications = [...classified].filter((path) => !tracked.includes(path)).sort();

    expect(
      unclassified,
      'tracked YAML files must be schema-validated or explicitly classified',
    ).toEqual([]);
    expect(
      staleClassifications,
      'YAML validation classifications must point at tracked files',
    ).toEqual([]);
  });

  it('documents every tracked YAML file classification', () => {
    const docText = readFileSync(resolve(root, yamlValidationDocPath), 'utf8');
    const missingDocEntries = trackedYamlFiles().filter((path) => !docText.includes(`\`${path}\``));

    expect(missingDocEntries, 'docs/yaml-validation.md must list every tracked YAML file').toEqual(
      [],
    );
  });

  it('schema-validates Circuit-owned YAML files', () => {
    for (const [relPath, schema] of Object.entries(schemaByPath)) {
      expect(() => schema.parse(parseYamlFile(relPath)), relPath).not.toThrow();
    }
  });

  it('parses external YAML files that Circuit does not own as Zod contracts', () => {
    for (const relPath of externalYamlPaths) {
      expect(() => parseYamlFile(relPath), relPath).not.toThrow();
    }
  });
});
