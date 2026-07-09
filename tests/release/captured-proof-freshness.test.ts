import { describe, expect, it } from 'vitest';
import {
  type CapturedProof,
  capturedProofFreshnessFailures,
} from '../../scripts/release/captured-proof-freshness.ts';

// capturedProofFreshnessFailures is the drift half of the captured-proof
// freshness guard: given the current release version and each capture's files,
// it returns one operator-facing message per staleness. These pin the exact
// conditions that must go red so a version-drifted or missing capture cannot
// keep backing a public claim.

const doctorOutput = (version: string): string =>
  [
    '$ node plugins/codex/scripts/circuit.js doctor',
    'exit: 0',
    'stdout:',
    '{',
    '  "status": "ok",',
    `  "runtime_version": "${version}",`,
    '  "checks": [ { "name": "runtime_version_executes", "ok": true } ]',
    '}',
  ].join('\n');

const doctorCapture = (version: string): CapturedProof => ({
  slug: 'doctor',
  dirRel: 'docs/release/proofs/runs/doctor',
  files: [{ rel: 'docs/release/proofs/runs/doctor/output.txt', content: doctorOutput(version) }],
});

describe('capturedProofFreshnessFailures', () => {
  it('is silent when the captured runtime_version matches the current release', () => {
    const failures = capturedProofFreshnessFailures({
      currentVersion: '0.1.0-alpha.10',
      captures: [doctorCapture('0.1.0-alpha.10')],
    });
    expect(failures).toEqual([]);
  });

  it('flags a stale doctor capture naming the pinned and current versions', () => {
    const failures = capturedProofFreshnessFailures({
      currentVersion: '0.1.0-alpha.10',
      captures: [doctorCapture('0.1.0-alpha.9')],
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("captured proof 'doctor'");
    expect(failures[0]).toContain("runtime_version '0.1.0-alpha.9'");
    expect(failures[0]).toContain("current release is '0.1.0-alpha.10'");
    expect(failures[0]).toContain('stale');
    expect(failures[0]).toContain('--scenario doctor');
  });

  it('does not match the runtime_version_executes check name', () => {
    // A capture that only mentions the check name (no pinned version field) must
    // not be treated as a version pin.
    const capture: CapturedProof = {
      slug: 'handoff',
      dirRel: 'docs/release/proofs/runs/handoff',
      files: [
        {
          rel: 'docs/release/proofs/runs/handoff/notes.txt',
          content: '{ "name": "runtime_version_executes", "ok": true }',
        },
      ],
    };
    expect(
      capturedProofFreshnessFailures({ currentVersion: '0.1.0-alpha.10', captures: [capture] }),
    ).toEqual([]);
  });

  it('passes captures that pin no Circuit version (handoff, customization)', () => {
    const handoff: CapturedProof = {
      slug: 'handoff',
      dirRel: 'docs/release/proofs/runs/handoff',
      files: [
        { rel: 'docs/release/proofs/runs/handoff/result.json', content: '{"outcome":"complete"}' },
      ],
    };
    const customization: CapturedProof = {
      slug: 'customization',
      dirRel: 'docs/release/proofs/runs/customization',
      // A user flow's own "version": "0.1.0" is not a Circuit runtime_version and
      // must not be flagged.
      files: [
        {
          rel: 'docs/release/proofs/runs/customization/custom-home/flows/x/circuit.json',
          content: '{"id":"x","version":"0.1.0"}',
        },
      ],
    };
    expect(
      capturedProofFreshnessFailures({
        currentVersion: '0.1.0-alpha.10',
        captures: [handoff, customization],
      }),
    ).toEqual([]);
  });

  it('flags a capture whose directory produced no files', () => {
    const failures = capturedProofFreshnessFailures({
      currentVersion: '0.1.0-alpha.10',
      captures: [
        { slug: 'customization', dirRel: 'docs/release/proofs/runs/customization', files: [] },
      ],
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("captured proof 'customization' has no files");
    expect(failures[0]).toContain('--scenario customization');
  });

  it('aggregates failures across multiple captures', () => {
    const failures = capturedProofFreshnessFailures({
      currentVersion: '0.1.0-alpha.10',
      captures: [
        doctorCapture('0.1.0-alpha.9'),
        { slug: 'handoff', dirRel: 'docs/release/proofs/runs/handoff', files: [] },
      ],
    });
    expect(failures).toHaveLength(2);
  });
});
