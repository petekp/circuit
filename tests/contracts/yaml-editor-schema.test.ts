import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  yamlEditorSchemaTargets,
  yamlLanguageServerSchemaMappings,
} from '../../scripts/schemas/yaml-schema-registry.ts';

const root = resolve(__dirname, '..', '..');
const vscodeSettingsPath = '.vscode/settings.json';
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

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(resolve(root, path), 'utf8'));
}

function schemaText(path: string): string {
  return readFileSync(resolve(root, path), 'utf8');
}

function globToRegExp(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === '*' && next === '*') {
      source += '.*';
      index += 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else {
      source += char?.replace(/[|\\{}()[\]^$+?.]/g, '\\$&') ?? '';
    }
  }
  return new RegExp(`${source}$`);
}

function matchesPattern(path: string, pattern: string): boolean {
  return globToRegExp(pattern).test(path);
}

describe('YAML editor schemas', () => {
  it('keeps generated JSON Schemas in sync with Zod sources', () => {
    expect(() =>
      execFileSync('npm', ['run', 'check-yaml-schemas'], {
        cwd: root,
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });

  it('maps every generated schema into the YAML language server settings', () => {
    const settings = readJson(vscodeSettingsPath) as {
      readonly 'yaml.schemas'?: Record<string, readonly string[]>;
    };
    expect(settings['yaml.schemas']).toEqual(yamlLanguageServerSchemaMappings());

    for (const target of yamlEditorSchemaTargets) {
      expect(existsSync(resolve(root, target.schemaPath)), target.schemaPath).toBe(true);
    }
  });

  it('maps every Circuit-owned tracked YAML file to an editor schema', () => {
    const mappedPatterns = Object.values(yamlLanguageServerSchemaMappings()).flat();
    const missingMappings = trackedYamlFiles().filter(
      (path) =>
        !externalYamlPaths.has(path) &&
        !mappedPatterns.some((pattern) => matchesPattern(path, pattern)),
    );

    expect(missingMappings, 'Circuit-owned YAML files need editor schema mappings').toEqual([]);
  });

  it('emits config completions for key names and enum values', () => {
    const config = readJson('schemas/yaml/circuit-config.schema.json') as {
      readonly anyOf?: readonly Record<string, unknown>[];
    };
    const serialized = JSON.stringify(config);

    expect(serialized).toContain('"schema_version"');
    expect(serialized).toContain('"skill_hooks"');
    expect(serialized).toContain('"policy"');
    expect(serialized).toContain('"auto"');
    expect(serialized).toContain('"mute"');
  });

  it('emits release and custom descriptor schema files as draft-07 JSON Schema', () => {
    for (const target of yamlEditorSchemaTargets) {
      const schema = readJson(target.schemaPath) as {
        readonly $schema?: string;
        readonly $id?: string;
        readonly title?: string;
      };
      expect(schema.$schema, target.schemaPath).toBe('http://json-schema.org/draft-07/schema#');
      expect(schema.$id, target.schemaPath).toBe(target.id);
      expect(schema.title, target.schemaPath).toBe(target.title);
      expect(schemaText(target.schemaPath), target.schemaPath).toContain('\n');
    }
  });
});
