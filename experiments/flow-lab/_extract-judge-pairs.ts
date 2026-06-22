// Extract blinded Arm-A vs Arm-B flow pairs from the context-premise results, for a
// BLIND judge panel. Deterministic (no Math.random — index-parity decides X/Y), so
// the mapping is reproducible. Writes _judge-pairs.json.
//
// Each pair gives the judge the FULL situation (task + the research context, i.e. the
// ground truth of what the work actually is) and two candidate flows rendered as
// readable step sequences, labelled X / Y with the A/B identity hidden. A control
// task should read as a near-tie; an act/fix step appearing on the read-only control
// is a NEGATIVE signal for whichever arm added it.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LAB = resolve('experiments/flow-lab');

interface Role {
  stage: string;
  block: string;
  executionKind: string;
  relayRole?: string;
  terminal?: boolean;
}
interface RoleSet {
  id: string;
  roles: Role[];
}
interface ArmRep {
  arm: 'A' | 'B';
  rawShape: string | null;
  rawRoleSet: RoleSet | null;
  finalRoleSet: RoleSet | null;
}
interface Summary {
  id: string;
  contextClass: string;
  rawModalA: string | null;
  rawModalB: string | null;
}

// The task situations (base + research context) — mirrored from the harness so the
// judge sees the same ground truth the informed arm was given.
const SITUATIONS: Record<string, { base: string; context: string; klass: string }> = {
  'flaky-test': {
    base: 'An integration test for the file-upload endpoint fails intermittently, about one run in four, and the cause is unknown. Make it reliably pass.',
    context:
      'The failure is a genuine race condition in the shared ConnectionPool.acquire() path under concurrent requests, not a test-only timing issue. Two other endpoints (export, import) use the same pool and could hit the same race. There is no existing harness for exercising concurrency. A test-level retry would hide the race while leaving the production bug in place. The pool code itself has no unit tests.',
    klass: 'shift',
  },
  'export-feature': {
    base: 'Build a CSV export feature for the reports page: add an endpoint, a serializer, and a download button, with tests.',
    context:
      'src/export/ already provides a generic StreamingExporter with a documented Serializer interface; JSON, XLSX, and PDF formats already plug in by implementing that one interface and registering it in a format map. Adding CSV is implementing one Serializer plus one registry line. The download button is a shared component that already takes a format prop. A golden-file test pattern exists for the other formats.',
    klass: 'shift',
  },
  'auth-migration': {
    base: 'Decide whether to move our internal service auth from session cookies to JWTs, and if it is the right call, carry out the migration.',
    context:
      'All 43 internal endpoints route through a single requireSession() middleware; a vetted token utility (sign/verify) already exists and is used for password resets; a feature-flag system can gate a phased rollout; a staging environment mirrors production; no third-party integrations depend on the cookie format. The change is mechanical but touches every endpoint.',
    klass: 'shift',
  },
  'audit-then-fix': {
    base: 'Take a look at the authentication module for security problems.',
    context:
      'A confirmed SQL-injection in the login query (user input concatenated into SQL), plus two lower-severity issues (a permissive CORS rule and a missing rate limit on login). The team has asked for the confirmed injection to be fixed in this same change, and the others triaged.',
    klass: 'shift',
  },
  'vague-improve': {
    base: 'Make the checkout flow better.',
    context:
      'The checkout has no automated tests; the main CheckoutContainer is a single 640-line component mixing data-fetching, validation, and rendering; there is one open, reproducible bug where applying a discount code after editing the cart silently drops the discount; analytics show a 12% drop-off at the payment step.',
    klass: 'shift',
  },
  'simple-fix-control': {
    base: 'A date helper returns the wrong month for the last day of any 31-day month (an off-by-one). Fix it so the existing unit tests pass.',
    context:
      'The bug is a single off-by-one in getMonthIndex() at src/date/helpers.ts:42; the existing unit test file already covers the failing cases; nothing else in the codebase relies on the incorrect behavior.',
    klass: 'control',
  },
  'audit-readonly-control': {
    base: 'Do a security review of the payments module before release. Do not change any code; just write up what you find.',
    context:
      'The module is small (about 300 lines), already has good test coverage, and the review is genuinely read-only; no issues were pre-identified, and the release process forbids code changes in this window.',
    klass: 'control',
  },
};

function renderFlow(roleSet: RoleSet | null): string {
  if (!roleSet || !Array.isArray(roleSet.roles)) return '(no proposal)';
  return roleSet.roles
    .map((r) => {
      const role = r.relayRole ? `/${r.relayRole}` : '';
      const term = r.terminal ? ' [end]' : '';
      return `${r.stage}:${r.block}(${r.executionKind}${role})${term}`;
    })
    .join('  ->  ');
}

function main(): void {
  const raw = JSON.parse(readFileSync(resolve(LAB, '_context-premise-results.json'), 'utf8')) as {
    summaries: Summary[];
    flows: Record<string, ArmRep[]>;
  };

  const pairs = raw.summaries.map((s, idx) => {
    const reps = raw.flows[s.id] ?? [];
    const a = reps.filter((r) => r.arm === 'A');
    const b = reps.filter((r) => r.arm === 'B');
    // Modal raw role set per arm (first rep matching the modal shape).
    const repA = a.find((r) => r.rawShape === s.rawModalA) ?? a[0];
    const repB = b.find((r) => r.rawShape === s.rawModalB) ?? b[0];
    const flowA = renderFlow(repA?.rawRoleSet ?? null);
    const flowB = renderFlow(repB?.rawRoleSet ?? null);
    // Deterministic blinding: even-index tasks put A as X, odd-index put B as X.
    const aIsX = idx % 2 === 0;
    const sit = SITUATIONS[s.id];
    return {
      taskId: s.id,
      contextClass: s.contextClass,
      situation: sit ? `${sit.base}\n\nWhat investigation found:\n${sit.context}` : s.id,
      optionX: aIsX ? flowA : flowB,
      optionY: aIsX ? flowB : flowA,
      // hidden key for scoring after the panel returns
      _mapping: { X: aIsX ? 'A' : 'B', Y: aIsX ? 'B' : 'A' },
      _rawShapeA: s.rawModalA,
      _rawShapeB: s.rawModalB,
    };
  });

  writeFileSync(resolve(LAB, '_judge-pairs.json'), `${JSON.stringify(pairs, null, 2)}\n`);
  process.stderr.write(`wrote _judge-pairs.json (${pairs.length} pairs)\n`);
  for (const p of pairs) {
    process.stderr.write(
      `\n[${p.taskId} / ${p.contextClass}] X=${p._mapping.X} Y=${p._mapping.Y}\n`,
    );
    process.stderr.write(`  X: ${p.optionX}\n`);
    process.stderr.write(`  Y: ${p.optionY}\n`);
  }
}

main();
