// Sweep e2e fixture scanner — dual-channel, like a real tsc/eslint wrapper.
//
// stdout: `{ "findings": [...] }` — the structured work-list the census and the
//   per-wave partition parse.
// exit code: non-zero while any finding remains — the honesty floor the pinned
//   rescan reads. A finding is a `src/**/*.ts` file that still carries the
//   NEEDS_FIX marker and has not been suppressed (a `sweep-suppress` directive).
//
// This is the program the census pins via `npm run scan`. The pin fingerprints
// both the package.json `scripts.scan` STRING (`node scan.mjs`) and this file's
// bytes, plus anything it imports through a static relative specifier, so
// swapping the script and rewriting this program are both caught across waves
// (spec 6.6). What still is not covered: a scanner that reads its rules from a
// data file rather than importing them.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function tsFiles(dir) {
  let out = [];
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(tsFiles(p));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

const root = process.cwd();
const findings = [];
for (const file of tsFiles(join(root, 'src'))) {
  const body = readFileSync(file, 'utf8');
  if (body.includes('NEEDS_FIX') && !body.includes('sweep-suppress')) {
    const rel = file
      .slice(root.length + 1)
      .split('\\')
      .join('/');
    findings.push({
      finding_id: `needs-fix:${rel}`,
      file: rel,
      rule: 'no-needs-fix',
      message: `unresolved NEEDS_FIX marker in ${rel}`,
    });
  }
}
process.stdout.write(`${JSON.stringify({ findings })}\n`);
process.exit(findings.length === 0 ? 0 : 1);
