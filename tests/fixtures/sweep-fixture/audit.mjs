// Sweep e2e fixture suppression audit.
//
// stdout: the count of `src/**/*.ts` files carrying a `sweep-suppress`
//   directive (the census reads this as the baseline).
// exit code: non-zero once any suppression exists — the anti-cheat floor. A
//   worker that silences a finding rather than fixing it clears the scan but
//   trips this audit, so the rescan's overall_status is still `failed`.
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

let count = 0;
for (const file of tsFiles(join(process.cwd(), 'src'))) {
  if (readFileSync(file, 'utf8').includes('sweep-suppress')) count += 1;
}
process.stdout.write(`${count}\n`);
process.exit(count === 0 ? 0 : 1);
