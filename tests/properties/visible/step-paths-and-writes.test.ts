// Property tests for two step-schema invariants:
//
//   step.prop.run_relative_paths     — RunRelativePath rejects
//                                      absolute, escaping, or
//                                      OS-mixed paths and accepts
//                                      portable POSIX-relative ones.
//   step.prop.writes_shape_per_variant — every Step `kind` has a
//                                      `.strict()` writes record;
//                                      surplus keys are rejected
//                                      and required keys are
//                                      enforced.
//
// Both are validated by the Zod schemas at parse time. The
// example-based tests in tests/contracts/step-schema.test.ts pin one
// witness per failure mode. Deterministic generators add width by
// varying the failure dimensions independently.

import { describe, expect, it } from 'vitest';

import {
  ComposeStep,
  RelayStep,
  RunRelativePath,
  SubRunStep,
  VerificationStep,
} from '../../../src/index.js';

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}

function nextInt(rng: () => number, mod: number): number {
  return Math.floor((rng() / 0x100000000) * mod);
}

function pick<T>(rng: () => number, choices: readonly T[]): T {
  const value = choices[nextInt(rng, choices.length)];
  if (value === undefined) throw new Error('pick() on empty choices');
  return value;
}

describe('step.prop.run_relative_paths — RunRelativePath validation', () => {
  // Property: RunRelativePath rejects iff the candidate is one of
  // (empty, absolute, contains backslash, contains colon, contains
  // empty/'.'/'..' segments). Otherwise it accepts.
  //
  // Generator emits both sound and unsound paths along independent
  // mutation dimensions so each rejection axis is exercised. Sound
  // paths are random POSIX segments joined by '/'.
  it('rejects exactly when one of the documented disallowed forms appears', () => {
    const rng = mulberry32(0x4a71c10);
    let acceptedCount = 0;
    let rejectedAbsolute = 0;
    let rejectedBackslash = 0;
    let rejectedColon = 0;
    let rejectedSegment = 0;
    let rejectedEmpty = 0;

    const segmentParts = ['reports', 'data', 'a', 'b', 'foo', 'bar', 'sub', 'leaf'];

    for (let i = 0; i < 400; i++) {
      const segCount = 1 + nextInt(rng, 4); // 1..4 segments
      const segs: string[] = [];
      for (let s = 0; s < segCount; s++) segs.push(pick(rng, segmentParts));
      let path = segs.join('/');
      // Optionally append a file extension to vary leaf shape.
      if (nextInt(rng, 4) === 0) path = `${path}.json`;

      // Mutator: ~60% leave path sound, ~40% inject one of the
      // disallowed forms. Each disallowed form is its own bucket so
      // anti-vacuity floors prove every reject axis is hit.
      const mutate = nextInt(rng, 12);
      let expectedReject = false;
      let expectedBucket: 'sound' | 'absolute' | 'backslash' | 'colon' | 'segment' | 'empty' =
        'sound';
      if (mutate === 0) {
        path = '';
        expectedReject = true;
        expectedBucket = 'empty';
      } else if (mutate === 1) {
        path = `/${path}`;
        expectedReject = true;
        expectedBucket = 'absolute';
      } else if (mutate === 2) {
        path = path.replace('/', '\\');
        // Path may have no '/' to replace if segCount=1; check.
        if (!path.includes('\\')) {
          path = `${path}\\extra`;
        }
        expectedReject = true;
        expectedBucket = 'backslash';
      } else if (mutate === 3) {
        path = `C:${path}`;
        expectedReject = true;
        expectedBucket = 'colon';
      } else if (mutate === 4) {
        path = `${path}/..`;
        expectedReject = true;
        expectedBucket = 'segment';
      } else if (mutate === 5) {
        path = `./${path}`;
        expectedReject = true;
        expectedBucket = 'segment';
      } else if (mutate === 6) {
        path = `${path}//double`;
        expectedReject = true;
        expectedBucket = 'segment';
      }

      const result = RunRelativePath.safeParse(path);
      if (expectedReject) {
        expect(result.success, `case ${i} bucket=${expectedBucket}: expected reject`).toBe(false);
        switch (expectedBucket) {
          case 'absolute':
            rejectedAbsolute++;
            break;
          case 'backslash':
            rejectedBackslash++;
            break;
          case 'colon':
            rejectedColon++;
            break;
          case 'segment':
            rejectedSegment++;
            break;
          case 'empty':
            rejectedEmpty++;
            break;
          default:
            throw new Error(`bucket ${expectedBucket} should not produce reject`);
        }
      } else {
        expect(
          result.success,
          `case ${i}: sound path '${path}' rejected — ${
            result.success ? '' : (result.error.issues[0]?.message ?? '<no issue message>')
          }`,
        ).toBe(true);
        acceptedCount++;
      }
    }

    expect(acceptedCount, 'no sound-path accept cases').toBeGreaterThan(80);
    expect(rejectedAbsolute, 'no absolute-path reject cases').toBeGreaterThan(10);
    expect(rejectedBackslash, 'no backslash reject cases').toBeGreaterThan(10);
    expect(rejectedColon, 'no colon reject cases').toBeGreaterThan(10);
    expect(rejectedSegment, 'no segment reject cases').toBeGreaterThan(10);
    expect(rejectedEmpty, 'no empty-string reject cases').toBeGreaterThan(10);
  });
});

describe('step.prop.writes_shape_per_variant — strict writes shape per kind', () => {
  // Property: every Step variant uses `.strict()` on `writes`, so a
  // surplus key on the writes record is a parse error regardless of
  // which kind. Each kind also enforces variant-specific required
  // keys (compose: report; verification: report; relay:
  // request/receipt/result, optional report; sub-run: result,
  // optional report). Generator drives random (kind, mutation)
  // pairs and asserts the schema agrees with the law.
  it('rejects surplus keys on writes for every kind, and accepts the canonical shape', () => {
    const rng = mulberry32(0x4a71c20);
    let composeAccepts = 0;
    let composeSurplusRejects = 0;
    let verificationAccepts = 0;
    let verificationSurplusRejects = 0;
    let relayAccepts = 0;
    let relaySurplusRejects = 0;
    let subrunAccepts = 0;
    let subrunSurplusRejects = 0;

    const baseStepCommon = (id: string) => ({
      id,
      title: `Step ${id}`,
      protocol: `${id}@v1`,
      reads: [],
      routes: { pass: '@complete' },
    });

    const surplusKeys = ['extraneous', 'phantom', 'sneaky', 'misc'];

    for (let i = 0; i < 200; i++) {
      const kind = pick(rng, ['compose', 'verification', 'relay', 'sub-run'] as const);
      const surplus = nextInt(rng, 2) === 0;
      // Pick a surplus key from the pool to vary the rejection
      // signature; the property is "surplus rejected", not
      // "this-particular-key rejected".
      const surplusKey = pick(rng, surplusKeys);

      const sharedReport = {
        path: `reports/${kind}-${i}.md`,
        schema: `${kind}@v1`,
      };

      if (kind === 'compose') {
        const writes = surplus
          ? { report: sharedReport, [surplusKey]: 'surplus' }
          : { report: sharedReport };
        const payload = {
          ...baseStepCommon(`synth-${i}`),
          executor: 'orchestrator',
          kind: 'compose',
          writes,
          check: {
            kind: 'schema_sections',
            source: { kind: 'report', ref: 'report' },
            required: ['Heading'],
          },
        };
        const result = ComposeStep.safeParse(payload);
        if (surplus) {
          composeSurplusRejects++;
          expect(result.success, `case ${i} compose surplus accepted`).toBe(false);
        } else {
          composeAccepts++;
          expect(
            result.success,
            `case ${i} compose sound rejected: ${
              result.success ? '' : JSON.stringify(result.error.issues)
            }`,
          ).toBe(true);
        }
      } else if (kind === 'verification') {
        const writes = surplus
          ? { report: sharedReport, [surplusKey]: 'surplus' }
          : { report: sharedReport };
        const payload = {
          ...baseStepCommon(`verif-${i}`),
          executor: 'orchestrator',
          kind: 'verification',
          writes,
          check: {
            kind: 'schema_sections',
            source: { kind: 'report', ref: 'report' },
            required: ['Heading'],
          },
        };
        const result = VerificationStep.safeParse(payload);
        if (surplus) {
          verificationSurplusRejects++;
          expect(result.success).toBe(false);
        } else {
          verificationAccepts++;
          expect(result.success).toBe(true);
        }
      } else if (kind === 'relay') {
        const writes = surplus
          ? {
              request: 'relay/request.json',
              receipt: 'relay/receipt.json',
              result: 'relay/result.json',
              [surplusKey]: 'surplus',
            }
          : {
              request: 'relay/request.json',
              receipt: 'relay/receipt.json',
              result: 'relay/result.json',
            };
        const payload = {
          ...baseStepCommon(`disp-${i}`),
          executor: 'worker',
          kind: 'relay',
          role: 'implementer',
          writes,
          check: {
            kind: 'result_verdict',
            source: { kind: 'relay_result', ref: 'result' },
            pass: ['accept', 'reject'],
          },
        };
        const result = RelayStep.safeParse(payload);
        if (surplus) {
          relaySurplusRejects++;
          expect(result.success).toBe(false);
        } else {
          relayAccepts++;
          expect(
            result.success,
            `case ${i} relay sound rejected: ${
              result.success ? '' : JSON.stringify(result.error.issues)
            }`,
          ).toBe(true);
        }
      } else {
        // sub-run
        const writes = surplus
          ? {
              result: 'sub-run/result.json',
              [surplusKey]: 'surplus',
            }
          : { result: 'sub-run/result.json' };
        const payload = {
          ...baseStepCommon(`subr-${i}`),
          executor: 'orchestrator',
          kind: 'sub-run',
          flow_ref: { flow_id: 'build', entry_mode: 'default' },
          goal: 'do work',
          depth: 'medium',
          writes,
          check: {
            kind: 'result_verdict',
            source: { kind: 'sub_run_result', ref: 'result' },
            pass: ['accept', 'reject'],
          },
        };
        const result = SubRunStep.safeParse(payload);
        if (surplus) {
          subrunSurplusRejects++;
          expect(result.success).toBe(false);
        } else {
          subrunAccepts++;
          expect(
            result.success,
            `case ${i} sub-run sound rejected: ${
              result.success ? '' : JSON.stringify(result.error.issues)
            }`,
          ).toBe(true);
        }
      }
    }

    expect(composeAccepts).toBeGreaterThan(15);
    expect(composeSurplusRejects).toBeGreaterThan(15);
    expect(verificationAccepts).toBeGreaterThan(15);
    expect(verificationSurplusRejects).toBeGreaterThan(15);
    expect(relayAccepts).toBeGreaterThan(15);
    expect(relaySurplusRejects).toBeGreaterThan(15);
    expect(subrunAccepts).toBeGreaterThan(15);
    expect(subrunSurplusRejects).toBeGreaterThan(15);
  });
});
