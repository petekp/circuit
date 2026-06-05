import { describe, expect, it } from 'vitest';

import { createDefaultExecutors } from '../../src/runtime/executors/index.js';
import { readSource } from '../helpers/source-imports.js';

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function stringLiterals(source: string): string[] {
  return uniqueSorted([...source.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? ''));
}

function sourceBlock(source: string, startNeedle: string, endNeedle: string): string {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start);
  if (start < 0 || end < 0) {
    throw new Error(`could not find source block ${startNeedle}`);
  }
  return source.slice(start, end);
}

function runtimeStepKindUnionValues(): string[] {
  const source = readSource('src/runtime/domain/step.ts');
  const match = source.match(/export type StepKind = (?<union>[^;]+);/);
  if (match?.groups?.union === undefined) throw new Error('StepKind union not found');
  return stringLiterals(match.groups.union);
}

function executableStepUnionValues(): string[] {
  const source = readSource('src/runtime/manifest/executable-flow.ts');
  const union = sourceBlock(
    source,
    'export type ExecutableStep =',
    'export interface ExecutableFlow',
  );
  const interfaceNames = [...union.matchAll(/\|\s*(\w+)/g)].map((match) => match[1] ?? '');

  return uniqueSorted(
    interfaceNames.map((name) => {
      const interfaceBlock = sourceBlock(source, `export interface ${name}`, '\n}\n');
      const match = interfaceBlock.match(/readonly kind: '([^']+)'/);
      if (match?.[1] === undefined) throw new Error(`${name} kind literal not found`);
      return match[1];
    }),
  );
}

function schemaStepVariantValues(): string[] {
  const source = readSource('src/schemas/step.ts');
  const stepUnion = sourceBlock(source, 'export const Step =', '.superRefine');
  const schemaNames = [...stepUnion.matchAll(/\b(\w+Step),/g)].map((match) => match[1] ?? '');

  return uniqueSorted(
    schemaNames.map((name) => {
      const schemaBlock = sourceBlock(source, `export const ${name} =`, `export type ${name} =`);
      const match = schemaBlock.match(/kind: z\.literal\('([^']+)'\)/);
      if (match?.[1] === undefined) throw new Error(`${name} kind literal not found`);
      return match[1];
    }),
  );
}

function executableConversionValues(): string[] {
  const source = readSource('src/runtime/manifest/from-compiled-flow.ts');
  const convertStep = sourceBlock(
    source,
    'function convertStep(',
    'export function fromCompiledFlow',
  );
  return stringLiterals(convertStep).filter((value) =>
    runtimeStepKindUnionValues().includes(value),
  );
}

function workContractStepKeyValues(): string[] {
  const source = readSource('src/shared/work-contract-projection.ts');
  const keysBlock = sourceBlock(source, 'const STEP_KEYS:', 'function sha256');
  const keyMatches = [...keysBlock.matchAll(/^ {2}(?:(['"])([^'"]+)\1|([A-Za-z][\w-]*)):/gm)];
  return uniqueSorted(keyMatches.map((match) => match[2] ?? match[3] ?? ''));
}

describe('StepKind alignment ratchet', () => {
  it('keeps every hand-maintained step-kind surface aligned', () => {
    const expected = runtimeStepKindUnionValues();

    expect(schemaStepVariantValues(), 'schema Step discriminated union').toEqual(expected);
    expect(executableStepUnionValues(), 'ExecutableStep interface union').toEqual(expected);
    expect(executableConversionValues(), 'fromCompiledFlow convertStep cases').toEqual(expected);
    expect(Object.keys(createDefaultExecutors()).sort(), 'default executor registry').toEqual(
      expected,
    );
    expect(workContractStepKeyValues(), 'WorkContract projection STEP_KEYS').toEqual(expected);
  });
});
