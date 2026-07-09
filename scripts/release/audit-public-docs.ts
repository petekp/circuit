#!/usr/bin/env node

import { loadReleaseSchemas, loadYamlWithSchema, pathExists, readText } from './shared.ts';

type PublicDocAudit = {
  id: string;
  files: string[];
  pattern: RegExp;
  exception?: string;
};

const audits: PublicDocAudit[] = [
  {
    id: 'agent-connector-name',
    files: ['README.md', 'docs/contracts/connector.md'],
    pattern: /\bagent connector\b|\b`agent`\b/i,
    exception: 'EX-REL-002-CODEX-ISOLATED',
  },
  {
    id: 'codex-isolation-overclaim',
    files: ['README.md', 'docs/contracts/host-capabilities.md'],
    pattern: /isolated\s+`?CODEX_HOME`?|isolated\s+.*`?TMPDIR`?/i,
    exception: 'EX-REL-002-CODEX-ISOLATED',
  },
  {
    id: 'custom-connector-stale-append-argv-protocol',
    files: ['README.md', 'docs/contracts/connector.md'],
    pattern: /append-argv|stdout JSON/i,
  },
  {
    id: 'native-host-current-wording',
    files: [
      'README.md',
      'docs/contracts/native-host-adapters.md',
      'docs/contracts/host-capabilities.md',
    ],
    pattern: /native .*supported|first-class native/i,
    exception: 'EX-REL-004-MODE-MATRIX',
  },
  {
    id: 'fix-terminology',
    files: ['README.md', 'plugins/claude/commands/run.md', 'docs/flows/authoring-model.md'],
    pattern: /\/circuit:repair|\brepair:\b|Repair-only|Fix\/Repair|Repair\/Fix/i,
  },
];

async function main() {
  const schemas = await loadReleaseSchemas();
  const exceptions = loadYamlWithSchema(
    'docs/release/parity/exceptions.yaml',
    schemas.ParityExceptionLedger,
  );
  const exceptionIds = new Set(
    exceptions.exceptions.map((exception: { id: string }) => exception.id),
  );
  const issues: string[] = [];
  const tracked: string[] = [];

  for (const audit of audits) {
    const hits = [];
    for (const file of audit.files) {
      // Fail closed: a declared audit file that has gone missing means the
      // target moved and this check is now blind. Silently skipping it would
      // let stale wording pass, so surface it as an issue instead.
      if (!pathExists(file)) {
        issues.push(
          `${audit.id}: declared audit file '${file}' is missing — restore it or update the audit's file list`,
        );
        continue;
      }
      const text = readText(file);
      if (audit.pattern.test(text)) hits.push(file);
    }
    if (hits.length === 0) continue;
    if (audit.exception === undefined) {
      issues.push(`${audit.id}: ${hits.join(', ')} matches stale public wording`);
      continue;
    }
    if (exceptionIds.has(audit.exception)) {
      tracked.push(`${audit.id}: ${hits.join(', ')} tracked by ${audit.exception}`);
    } else {
      issues.push(`${audit.id}: ${hits.join(', ')} has no tracking exception ${audit.exception}`);
    }
  }

  for (const warning of tracked) console.warn(`tracked: ${warning}`);
  if (issues.length > 0) {
    for (const issue of issues) console.error(`error: ${issue}`);
    process.exit(1);
  }
  console.log('✓ public doc risk claims are tracked');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
