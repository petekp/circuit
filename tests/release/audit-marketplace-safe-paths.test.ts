import { describe, expect, it } from 'vitest';

import { SAFETY_PATTERN, auditText } from '../../scripts/release/audit-marketplace-safe-paths.ts';

interface Finding {
  file: string;
  line: number;
  source: string;
}

function annotated(claim: string): string {
  return [
    `import { fileURLToPath } from 'node:url';`,
    '',
    `// ${claim}`,
    'const p = fileURLToPath(import.meta.url);',
    'void p;',
  ].join('\n');
}

describe('audit-marketplace-safe-paths', () => {
  it('accepts the build-time replacement claim', () => {
    const findings = auditText(
      annotated('Marketplace-safe by build-time replacement: esbuild inlines VERSION.'),
    );
    expect(findings).toEqual([]);
  });

  it('accepts the build-pipeline emission claim', () => {
    const findings = auditText(
      annotated('Marketplace-safe by build-pipeline emission: bundler emits sidecar.'),
    );
    expect(findings).toEqual([]);
  });

  it('accepts the env-var claim', () => {
    const findings = auditText(
      annotated('Marketplace-safe by env var: CIRCUIT_PLUGIN_ROOT is the primary input.'),
    );
    expect(findings).toEqual([]);
  });

  it('accepts the source-tree fallback claim', () => {
    const findings = auditText(
      annotated('Marketplace-safe by source-tree fallback: resolves to <repo>/bin in dev.'),
    );
    expect(findings).toEqual([]);
  });

  it('accepts the trusted host-metadata claim', () => {
    const findings = auditText(
      annotated('Marketplace-safe by host metadata: Codex supplies an absolute workspace URL.'),
    );
    expect(findings).toEqual([]);
  });

  it('flags an unannotated fileURLToPath call', () => {
    const text = [
      `import { fileURLToPath } from 'node:url';`,
      '',
      'const p = fileURLToPath(import.meta.url);',
      'void p;',
    ].join('\n');
    const findings: Finding[] = auditText(text, 'src/example.ts');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file: 'src/example.ts',
      line: 3,
      source: 'const p = fileURLToPath(import.meta.url);',
    });
  });

  it('ignores commented-out fileURLToPath lines', () => {
    const text = [
      `import { fileURLToPath } from 'node:url';`,
      '',
      '// const p = fileURLToPath(import.meta.url);',
    ].join('\n');
    expect(auditText(text)).toEqual([]);
  });

  it('ignores the import declaration itself', () => {
    const text = `import { fileURLToPath } from 'node:url';`;
    expect(auditText(text)).toEqual([]);
  });

  it('rejects an unrecognized "Marketplace-safe by" claim phrase', () => {
    const text = [
      `import { fileURLToPath } from 'node:url';`,
      '',
      '// Marketplace-safe by wishful thinking: nope.',
      'const p = fileURLToPath(import.meta.url);',
    ].join('\n');
    expect(auditText(text)).toHaveLength(1);
  });

  it('rejects a claim further than the lookback window above the call', () => {
    const above = Array.from({ length: 12 }, (_, i) => `// filler ${i}`);
    const text = [
      '// Marketplace-safe by env var: too far away.',
      ...above,
      'const p = fileURLToPath(import.meta.url);',
    ].join('\n');
    expect(auditText(text)).toHaveLength(1);
  });

  it('exports a SAFETY_PATTERN that matches every accepted phrase', () => {
    expect(SAFETY_PATTERN.test('Marketplace-safe by build-time replacement: x')).toBe(true);
    expect(SAFETY_PATTERN.test('Marketplace-safe by build-pipeline emission: x')).toBe(true);
    expect(SAFETY_PATTERN.test('Marketplace-safe by env var: x')).toBe(true);
    expect(SAFETY_PATTERN.test('Marketplace-safe by source-tree fallback: x')).toBe(true);
    expect(SAFETY_PATTERN.test('Marketplace-safe by host metadata: x')).toBe(true);
    expect(SAFETY_PATTERN.test('Marketplace-safe by something else: x')).toBe(false);
  });
});
