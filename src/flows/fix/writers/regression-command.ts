// Which command proves the bug, and who chose it.
//
// The frame step is read-only. It cannot run anything, so when the goal names
// no repro it honestly defers authoring a regression test. Before this helper
// existed, that deferral ended the matter: no baseline ran, the proof recorded
// 'deferred', and fix-close refused outcome 'fixed' even on a run where the
// repair landed, the project's checks passed, the change-set was clean, and the
// reviewer accepted. The operator saw a run that needed attention and a repair
// that had, in fact, worked.
//
// The missing capability was small. By the time the baseline step runs, the
// brief already carries `verification_command_candidates` — commands Circuit
// itself resolved from the project (its package.json scripts or its declared
// verification config), not commands a model invented. Running the first of
// those BEFORE fix-act costs one command and often yields exactly the evidence
// a person would ask for: red before, green after.
//
// It is weaker evidence than a targeted repro, so the source rides along on the
// report. A reader can tell "the test that reproduces this bug went from
// failing to passing" from "the project's test suite went from failing to
// passing" without re-deriving it from the brief.

import type { VerificationCommand } from '../../registries/verification-writers/types.js';
import type { FixBrief, FixRegressionCommandSource } from '../reports.js';

export interface RegressionProofCommand {
  readonly command: VerificationCommand;
  readonly source: FixRegressionCommandSource;
}

// Returns the command the regression baseline should run before fix-act, or
// undefined when the project offers nothing to run at all.
export function regressionProofCommand(brief: FixBrief): RegressionProofCommand | undefined {
  const regressionTest = brief.regression_contract.regression_test;
  if (regressionTest.status === 'failing-before-fix') {
    return { command: regressionTest.command, source: 'declared' };
  }
  // Same order the verification step uses, so the baseline and fix-verify run
  // the same thing. Picking a different candidate here would make "red before,
  // green after" an assertion about two different commands.
  const adopted = brief.verification_command_candidates[0];
  if (adopted === undefined) return undefined;
  return { command: adopted, source: 'adopted-verification' };
}
