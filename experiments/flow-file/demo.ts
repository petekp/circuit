// Offline demo for the portable flow-file loader (experimental).
//
// Loads one sample flow-file from docs/ideas/flow-file-samples/ and prints the
// compiled flow's id, purpose, and step count. This proves the whole seam end to
// end OFFLINE: parse -> composeFlow -> floor -> assemble -> compile, with no model
// call and no flow run. It is NOT wired into the published CLI vocabulary.
//
// Run it with:
//   npx tsx experiments/flow-file/demo.ts [sample-name]
// where sample-name defaults to `flake-hunter`.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFlowFile, resolveRequiredSkills } from '../../src/flows/composition/flow-file.js';

const here = dirname(fileURLToPath(import.meta.url));
const samplesDir = join(here, '..', '..', 'docs', 'ideas', 'flow-file-samples');

const sampleName = process.argv[2] ?? 'flake-hunter';
const samplePath = join(samplesDir, `${sampleName}.flow.md`);

const text = readFileSync(samplePath, 'utf8');
const result = loadFlowFile(text);

if (!result.ok) {
  console.error(`flow-file '${sampleName}' failed at stage '${result.stage}':`);
  for (const error of result.errors) console.error(`  - ${error}`);
  process.exit(1);
}

const { compiled, schematic, roleSet, skills } = result;
console.log(`flow-file: ${sampleName}.flow.md`);
console.log(`  title:    ${roleSet.title}`);
console.log(`  id:       ${compiled.id}`);
console.log(`  purpose:  ${compiled.purpose}`);
console.log(`  steps:    ${compiled.steps.length}`);
const stages = schematic.stages ?? [];
console.log(`  stages:   ${stages.map((stage) => stage.canonical).join(' -> ')}`);

if (skills.requires.length > 0) {
  const { present, missing } = resolveRequiredSkills(skills.requires);
  console.log(`  skills:   requires ${skills.requires.join(', ')}`);
  if (missing.length > 0) console.log(`            missing locally: ${missing.join(', ')}`);
  if (present.length > 0) console.log(`            present locally: ${present.join(', ')}`);
}
