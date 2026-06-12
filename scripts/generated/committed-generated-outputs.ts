#!/usr/bin/env node
// The committed generated outputs this guard protects: the runtime-bundle code
// artifacts (the esbuild bundle plus the git-state and launcher-core sidecars
// each host commits) and the tracked markdown that doc-classes marks
// `generated`. This is NOT the whole generated tree — generated JSON (compiled
// flows, host skill/flow mirrors, schematics, the block catalog) is covered by
// check-flow-drift, which re-emits and byte-compares it on every run. This set
// is the remainder, each member protected one of two ways:
//
//   - the Edit-deny list in .claude/settings.json refuses the Edit tool on it
//     (the only option for non-markdown artifacts), or
//   - docs/doc-classes.json marks it `generated`, so the doc-rot gates fix the
//     generator instead of the file.
//
// tests/contracts/generated-surface-guard.test.ts proves every member of this
// set is covered by one or the other. The set is derived from the generators
// themselves — the runtime-bundle output constants and the doc-classes manifest
// — so it cannot silently lag the way a hand-kept list would.
import { classifyAll } from '../docs/doc-classes.ts';
import {
  RUNTIME_BUNDLE_ASSET_SIDECARS,
  RUNTIME_BUNDLE_OUTPUT_PATHS,
} from '../plugins/runtime-bundle.ts';

// Generated code artifacts the runtime-bundle generator commits next to each
// host: the esbuild bundle plus the git-state and launcher-core sidecars.
// dist/* sidecar targets are gitignored local-build artifacts, not committed,
// so they are excluded.
export function committedRuntimeBundleOutputs(): string[] {
  const sidecarOuts = RUNTIME_BUNDLE_ASSET_SIDECARS.flatMap((sidecar) => sidecar.outs);
  return [...RUNTIME_BUNDLE_OUTPUT_PATHS, ...sidecarOuts]
    .filter((rel) => !rel.startsWith('dist/'))
    .sort();
}

// Tracked markdown classified `generated` by docs/doc-classes.json.
export function generatedMarkdownOutputs(): string[] {
  return classifyAll()
    .docs.filter((doc) => doc.class === 'generated')
    .map((doc) => doc.path)
    .sort();
}

// The full set the guard test must find covered.
export function committedGeneratedOutputs(): string[] {
  return [...committedRuntimeBundleOutputs(), ...generatedMarkdownOutputs()].sort();
}
