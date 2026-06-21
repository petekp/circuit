import { readFileSync } from 'node:fs';
import { resolveRunRelative } from '../../../shared/run-relative-path.js';
import { reportPathForSchemaInRuntimeFlow } from '../../registries/runtime-index.js';
import type {
  VerificationBuildContext,
  VerificationBuilder,
  VerificationCommand,
  VerificationCommandObservation,
} from '../../registries/verification-writers/types.js';
import { PrototypeArtifact, PrototypePlan, PrototypeVerification } from '../reports.js';

const ARTIFACT_INTEGRITY_SCRIPT = [
  "const fs = require('node:fs')",
  "const path = require('node:path')",
  "const payload = JSON.parse(process.argv[1] || '{}')",
  'const projectRoot = process.cwd()',
  "const root = String(payload.prototype_root || '')",
  'const planned = Array.isArray(payload.planned_files) ? payload.planned_files : []',
  'const created = Array.isArray(payload.created_files) ? payload.created_files : []',
  'const entry = Array.isArray(payload.entry_points) ? payload.entry_points : []',
  'const errors = []',
  'function inside(base, target) { const rel = path.relative(base, target); return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)); }',
  'const rootAbs = path.resolve(projectRoot, root)',
  'if (!inside(projectRoot, rootAbs)) errors.push(`prototype_root escapes project root: ${root}`)',
  'if (!fs.existsSync(rootAbs)) errors.push(`prototype_root does not exist: ${root}`)',
  'else if (!fs.lstatSync(rootAbs).isDirectory()) errors.push(`prototype_root is not a directory: ${root}`)',
  'else if (fs.lstatSync(rootAbs).isSymbolicLink()) errors.push(`prototype_root is a symlink: ${root}`)',
  'const rootReal = fs.existsSync(rootAbs) ? fs.realpathSync.native(rootAbs) : rootAbs',
  'const createdSet = new Set(created)',
  'for (const rel of planned) { if (!createdSet.has(rel)) errors.push(`planned file missing from created_files: ${rel}`); }',
  'for (const rel of Array.from(new Set([...planned, ...created, ...entry]))) {',
  '  if (typeof rel !== "string" || rel.length === 0) { errors.push("reported path must be a non-empty string"); continue; }',
  '  if (!rel.startsWith(`${root}/`)) errors.push(`prototype path is outside prototype_root: ${rel}`)',
  '  const abs = path.resolve(projectRoot, rel)',
  '  if (!inside(rootAbs, abs)) errors.push(`prototype path escapes prototype_root: ${rel}`)',
  '  if (!fs.existsSync(abs)) { errors.push(`prototype path does not exist: ${rel}`); continue; }',
  '  if (fs.lstatSync(abs).isSymbolicLink()) errors.push(`prototype path is a symlink: ${rel}`)',
  '  const real = fs.realpathSync.native(abs)',
  '  if (!inside(rootReal, real)) errors.push(`prototype path escapes real prototype_root: ${rel}`)',
  '}',
  'if (errors.length > 0) { console.error(errors.join("\\n")); process.exit(1); }',
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
  };
  return {
    id: 'prototype-artifact-integrity',
    cwd: '.',
    argv: [process.execPath, '-e', ARTIFACT_INTEGRITY_SCRIPT, JSON.stringify(payload)],
    timeout_ms: 30_000,
    max_output_bytes: 20_000,
    env: {},
  };
}

function projectPrototypeVerification(
  observations: readonly VerificationCommandObservation[],
): PrototypeVerification {
  const overallStatus = observations.some((observation) => observation.status === 'failed')
    ? 'failed'
    : 'passed';
  return PrototypeVerification.parse({
    overall_status: overallStatus,
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
  buildResult(observations: readonly VerificationCommandObservation[]): unknown {
    return projectPrototypeVerification(observations);
  },
};
