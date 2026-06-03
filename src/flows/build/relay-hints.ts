// Build flow relay shape hints.

import type { SchemaShapeHint } from '../registries/shape-hints/types.js';

export const buildContextShapeHint: SchemaShapeHint = {
  kind: 'schema',
  schema: 'build.context@v1',
  instruction: [
    'Respond with a single raw JSON object whose top-level shape is exactly:',
    '{ "verdict": "accept", "sources": [{ "kind": "<file|command|log|operator-note|reference>", "ref": "<project-relative path, command id, log line, note id, or external reference>", "summary": "<one-line summary of what this source contributed>" }], "observations": ["<observation grounded in the sources>"], "open_questions": ["<question still unresolved after gathering context>"], "anticipated_file_extensions": ["<file extension the change will likely touch, such as .ts, .tsx, or .test.ts>"] }',
    "Read the relevant source and tests before planning. This step is read-only by intent: do not edit files, write files, or run commands that modify the checkout. Scale the breadth of your reading to the run's stated rigor (provided to you): on a quick or lite job read just the directly implicated files; on a deep job map the surrounding modules, callers, and local conventions. sources must contain at least one entry; observations must contain at least one entry. Use an empty open_questions array only when nothing remains unresolved. Every observation must be grounded in the cited sources - do not invent details the sources do not support.",
    'In anticipated_file_extensions, predict the file extensions the implementer will likely touch based on what you read (for example .ts and .test.ts for a typed code change with tests). Use the implementation file types, not every file you read. Use an empty array only when the read gives no confident prediction. This list is advisory: it scopes and warns, it does not bind the implementer.',
    'Do not include extra top-level keys. Do not wrap the JSON in Markdown code fences. Do not include any prose before or after the JSON object. The runtime parses your response with JSON.parse, rejects any verdict not drawn from the accepted-verdicts list, and validates the full report body against build.context@v1 before writing reports/build/context.json.',
  ].join(' '),
};

export const buildImplementationShapeHint: SchemaShapeHint = {
  kind: 'schema',
  schema: 'build.implementation@v1',
  instruction: [
    'Respond with a single raw JSON object whose top-level shape is exactly:',
    '{ "verdict": "accept", "summary": "<what changed>", "changed_files": ["<project-relative path>"], "evidence": ["<verification or implementation evidence>"] }',
    'Make the smallest behaviorally scoped change that satisfies the requested goal. Do not broaden semantics, normalize data, or add extra behavior just because tests still pass.',
    "The plan's anticipated_file_extensions lists the file types the grounding read expects this change to touch. Treat it as an advisory starting scope, not a hard limit: if the real change needs other file types, make the change and report the files you actually touched.",
    'Use an empty changed_files array only when no file changed. Evidence must contain at least one item. Do not include extra top-level keys. Do not wrap the JSON in Markdown code fences. Do not include any prose before or after the JSON object.',
    'The runtime parses your response with JSON.parse, rejects any verdict not drawn from the accepted-verdicts list, and validates the full report body against build.implementation@v1 before writing reports/build/implementation.json.',
  ].join(' '),
};

export const buildReviewShapeHint: SchemaShapeHint = {
  kind: 'schema',
  schema: 'build.review@v1',
  instruction: [
    'Respond with a single raw JSON object whose top-level shape is exactly:',
    '{ "verdict": "<accept|accept-with-fixes|reject>", "summary": "<review summary>", "findings": [{ "severity": "<critical|high|medium|low>", "text": "<finding text>", "file_refs": ["<file:line reference>"] }] }',
    'Review the change against the requested scope, not just against passing tests. Flag behavior that broadens semantics beyond the goal even when verification passes.',
    'Use an empty findings array only with verdict "accept". Verdicts "accept-with-fixes" and "reject" must include at least one finding. Use an empty file_refs array when a finding has no file-specific reference. Do not include extra top-level keys. Do not wrap the JSON in Markdown code fences. Do not include any prose before or after the JSON object.',
    'The runtime parses your response with JSON.parse, rejects any verdict not drawn from the accepted-verdicts list, and validates the full report body against build.review@v1 before writing reports/build/review.json.',
  ].join(' '),
};
