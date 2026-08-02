import { readFileSync } from 'node:fs';
import type { CheckpointReviewAssetGroups } from '../../../schemas/checkpoint-review-assets.js';
import { circuitOwnedVerificationCommand } from '../../../schemas/verification.js';
import { snapshotCheckpointReviewAssetGroups } from '../../../shared/checkpoint-review-assets.js';
import { resolveRunRelative } from '../../../shared/run-relative-path.js';
import { reportPathForSchemaInRuntimeFlow } from '../../registries/runtime-index.js';
import type {
  VerificationBuildContext,
  VerificationBuilder,
  VerificationCommand,
  VerificationCommandObservation,
} from '../../registries/verification-writers/types.js';
import { PrototypeArtifact, PrototypePlan, PrototypeVerification } from '../reports.js';

// Integrity judges the implementer's FINAL DECLARED work: every created file and
// entry point must be a real, non-symlink path inside prototype_root, or be
// declared as an integration touchpoint. Touchpoints are the schema's channel
// for integration spikes whose goal requires touching files outside the
// disposable root; each declared touchpoint must itself be a real, non-symlink
// path inside the project but outside prototype_root. The plan's anticipated
// file list is ADVISORY ONLY — the plan writer guesses a deliverable shape
// before the implementer runs, and a goal whose right artifact is a different
// shape (a CLI script instead of an HTML sketch, the F11 finding from the live
// surface test) must not fail integrity on that guess. An unrealized planned
// file is surfaced on stdout so the mismatch stays legible in the verification
// report without failing the run.
const ARTIFACT_INTEGRITY_SCRIPT = [
  "const fs = require('node:fs')",
  "const path = require('node:path')",
  "const payload = JSON.parse(process.argv[1] || '{}')",
  'const projectRoot = process.cwd()',
  "const root = String(payload.prototype_root || '')",
  'const planned = Array.isArray(payload.planned_files) ? payload.planned_files : []',
  'const created = Array.isArray(payload.created_files) ? payload.created_files : []',
  'const entry = Array.isArray(payload.entry_points) ? payload.entry_points : []',
  'const touchpoints = Array.isArray(payload.integration_touchpoints) ? payload.integration_touchpoints : []',
  'const errors = []',
  'function inside(base, target) { const rel = path.relative(base, target); return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)); }',
  'const rootAbs = path.resolve(projectRoot, root)',
  'if (!inside(projectRoot, rootAbs)) errors.push(`prototype_root escapes project root: ${root}`)',
  'if (!fs.existsSync(rootAbs)) errors.push(`prototype_root does not exist: ${root}`)',
  'else if (!fs.lstatSync(rootAbs).isDirectory()) errors.push(`prototype_root is not a directory: ${root}`)',
  'else if (fs.lstatSync(rootAbs).isSymbolicLink()) errors.push(`prototype_root is a symlink: ${root}`)',
  'const rootReal = fs.existsSync(rootAbs) ? fs.realpathSync.native(rootAbs) : rootAbs',
  'const declared = new Set(touchpoints.map((tp) => tp && typeof tp.path === "string" ? tp.path : ""))',
  'for (const tp of touchpoints) {',
  '  const rel = tp && typeof tp.path === "string" ? tp.path : ""',
  '  if (rel.length === 0) { errors.push("integration touchpoint path must be a non-empty string"); continue; }',
  '  if (rel.startsWith(`${root}/`)) errors.push(`integration touchpoint is inside prototype_root: ${rel}`)',
  '  const abs = path.resolve(projectRoot, rel)',
  '  if (!inside(projectRoot, abs)) { errors.push(`integration touchpoint escapes project root: ${rel}`); continue; }',
  '  if (!fs.existsSync(abs)) { errors.push(`integration touchpoint does not exist: ${rel}`); continue; }',
  '  if (fs.lstatSync(abs).isSymbolicLink()) errors.push(`integration touchpoint is a symlink: ${rel}`)',
  '  else if (!inside(projectRoot, fs.realpathSync.native(abs))) errors.push(`integration touchpoint escapes real project root: ${rel}`)',
  '}',
  'const createdSet = new Set(created)',
  'const unrealizedPlan = planned.filter((rel) => !createdSet.has(rel))',
  'for (const rel of Array.from(new Set([...created, ...entry]))) {',
  '  if (typeof rel !== "string" || rel.length === 0) { errors.push("reported path must be a non-empty string"); continue; }',
  '  const abs = path.resolve(projectRoot, rel)',
  '  if (declared.has(rel)) {',
  '    if (!fs.existsSync(abs)) errors.push(`prototype path does not exist: ${rel}`)',
  '    continue;',
  '  }',
  '  if (!rel.startsWith(`${root}/`)) errors.push(`prototype path is outside prototype_root and not a declared integration touchpoint: ${rel}`)',
  '  if (!inside(rootAbs, abs)) errors.push(`prototype path escapes prototype_root: ${rel}`)',
  '  if (!fs.existsSync(abs)) { errors.push(`prototype path does not exist: ${rel}`); continue; }',
  '  if (fs.lstatSync(abs).isSymbolicLink()) errors.push(`prototype path is a symlink: ${rel}`)',
  '  const real = fs.realpathSync.native(abs)',
  '  if (!inside(rootReal, real)) errors.push(`prototype path escapes real prototype_root: ${rel}`)',
  '}',
  'if (errors.length > 0) { console.error(errors.join("\\n")); process.exit(1); }',
  'if (unrealizedPlan.length > 0) console.log(`note (advisory): the plan anticipated files the artifact did not declare: ${unrealizedPlan.join(", ")}`)',
  'if (touchpoints.length > 0) console.log(`note: ${touchpoints.length} integration touchpoint(s) outside prototype_root: ${touchpoints.map((tp) => tp.path).join(", ")}`)',
  'console.log(`Prototype artifact integrity passed for ${root}`)',
].join('; ');

function readReport<T>(
  context: VerificationBuildContext,
  schemaName: string,
  parse: (raw: unknown) => T,
): T {
  const reportPath = reportPathForSchemaInRuntimeFlow(context.flow, schemaName);
  if (!context.step.reads.includes(reportPath as never)) {
    throw new Error(
      `prototype.verification@v1 requires step '${context.step.id}' to read ${reportPath}`,
    );
  }
  return parse(JSON.parse(readFileSync(resolveRunRelative(context.runFolder, reportPath), 'utf8')));
}

function artifactIntegrityCommand(input: {
  readonly plan: PrototypePlan;
  readonly artifact: PrototypeArtifact;
}): VerificationCommand {
  const payload = {
    prototype_root: input.artifact.prototype_root,
    planned_files: input.plan.files_to_create,
    created_files: input.artifact.created_files,
    entry_points: input.artifact.entry_points,
    integration_touchpoints: input.artifact.integration_touchpoints.map((touchpoint) => ({
      path: touchpoint.path,
      change: touchpoint.change,
    })),
  };
  return circuitOwnedVerificationCommand({
    id: 'prototype-artifact-integrity',
    cwd: '.',
    argv: [process.execPath, '-e', ARTIFACT_INTEGRITY_SCRIPT, JSON.stringify(payload)],
    timeout_ms: 30_000,
    max_output_bytes: 20_000,
    env: {},
  });
}

function projectPrototypeVerification(
  observations: readonly VerificationCommandObservation[],
  context: VerificationBuildContext,
): PrototypeVerification {
  const overallStatus = observations.some((observation) => observation.status === 'failed')
    ? 'failed'
    : 'passed';
  const artifact = readReport(context, 'prototype.artifact@v1', (raw) =>
    PrototypeArtifact.parse(raw),
  );
  let reviewAssets: CheckpointReviewAssetGroups = [];
  if (overallStatus === 'passed' && artifact.verdict === 'accept') {
    if (context.projectRoot === undefined) {
      throw new Error('prototype review asset snapshot requires projectRoot');
    }
    // The snapshot scans prototype_root only, so entry points that live at
    // declared integration touchpoints outside the root are not snapshot
    // candidates; passing them would fail the missing-entry-point check.
    const inRootEntryPoints = artifact.entry_points.filter((entryPoint) =>
      entryPoint.startsWith(`${artifact.prototype_root}/`),
    );
    reviewAssets = snapshotCheckpointReviewAssetGroups({
      projectRoot: context.projectRoot,
      groups: [{ root: artifact.prototype_root, entryPoints: inRootEntryPoints }],
    });
  }
  return PrototypeVerification.parse({
    overall_status: overallStatus,
    review_assets: reviewAssets,
    commands: observations.map((observation) => ({
      command_id: observation.command.id,
      argv: observation.command.argv,
      cwd: observation.command.cwd,
      exit_code: observation.exit_code,
      status: observation.status,
      duration_ms: observation.duration_ms,
      stdout_summary: observation.stdout_summary,
      stderr_summary: observation.stderr_summary,
    })),
  });
}

export const prototypeVerificationWriter: VerificationBuilder = {
  resultSchemaName: 'prototype.verification@v1',
  // Sources commands from the prototype plan and reads the artifact for the
  // integrity command. Declared so a composer wires the reads and the offline
  // floor resolves them; loadCommands below is the enforcing source of truth.
  reads: [
    { name: 'plan', schema: 'prototype.plan@v1', required: true },
    { name: 'artifact', schema: 'prototype.artifact@v1', required: true },
  ],
  loadCommands(context: VerificationBuildContext): readonly VerificationCommand[] {
    const plan = readReport(context, 'prototype.plan@v1', (raw) => PrototypePlan.parse(raw));
    const artifact = readReport(context, 'prototype.artifact@v1', (raw) =>
      PrototypeArtifact.parse(raw),
    );
    return [artifactIntegrityCommand({ plan, artifact }), ...plan.verification.commands];
  },
  buildResult(
    observations: readonly VerificationCommandObservation[],
    context: VerificationBuildContext,
  ): unknown {
    return projectPrototypeVerification(observations, context);
  },
};
