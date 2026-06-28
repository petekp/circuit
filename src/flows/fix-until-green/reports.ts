// Fix Until Green's report schemas.
//
// fix-until-green owns its OWN plan and verification schema names rather than
// reusing build.plan@v1 / fix.verification@v1. The compose, verification, and
// report-schema registries are global and keyed by schema name, built from every
// flow package, so reusing another flow's name would collide two writers on one
// key. Its own names keep the flow self-contained.
//
// The plan is the preamble's output: it lifts the verification commands the loop
// body re-runs each iteration into a deliberate, check-able list. The verification
// report is the canonical command-list result (the same VerificationResult shape
// Build emits) — its overall_status is what the until-loop's evidence floor reads
// as proof of a green run.

import { z } from 'zod';
import { VerificationCommand, VerificationResult } from '../../schemas/verification.js';

export const FixUntilGreenPlan = z
  .object({
    objective: z.string().min(1),
    approach: z.string().min(1),
    verification: z
      .object({
        commands: z.array(VerificationCommand).min(1),
      })
      .strict(),
  })
  .strict();
export type FixUntilGreenPlan = z.infer<typeof FixUntilGreenPlan>;

export const FixUntilGreenVerification = VerificationResult;
export type FixUntilGreenVerification = z.infer<typeof FixUntilGreenVerification>;
