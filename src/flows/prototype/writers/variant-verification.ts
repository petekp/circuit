import { readFileSync } from 'node:fs';
import { resolveRunRelative } from '../../../shared/run-relative-path.js';
import { reportPathForSchemaInRuntimeFlow } from '../../registries/runtime-index.js';
import type {
  VerificationBuildContext,
  VerificationBuilder,
  VerificationCommand,
  VerificationCommandObservation,
} from '../../registries/verification-writers/types.js';
import {
  PrototypeVariantAggregate,
  PrototypeVariantProviderEvidence,
  PrototypeVariantVerification,
} from '../reports.js';

const VARIANT_INTEGRITY_SCRIPT = [
  "const fs = require('node:fs')",
  "const path = require('node:path')",
  "const payload = JSON.parse(process.argv[1] || '{}')",
  'const projectRoot = process.cwd()',
  'const variants = Array.isArray(payload.variants) ? payload.variants : []',
  'const errors = []',
  'function inside(base, target) { const rel = path.relative(base, target); return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)); }',
  'for (const variant of variants) {',
  '  const id = String(variant.variant_id || "")',
  '  const root = String(variant.variant_root || "")',
  '  const created = Array.isArray(variant.created_files) ? variant.created_files : []',
  '  const entry = Array.isArray(variant.entry_points) ? variant.entry_points : []',
  '  const rootAbs = path.resolve(projectRoot, root)',
  '  if (!inside(projectRoot, rootAbs)) errors.push(`${id}: variant_root escapes project root: ${root}`)',
  '  if (!fs.existsSync(rootAbs)) errors.push(`${id}: variant_root does not exist: ${root}`)',
  '  else if (!fs.lstatSync(rootAbs).isDirectory()) errors.push(`${id}: variant_root is not a directory: ${root}`)',
  '  else if (fs.lstatSync(rootAbs).isSymbolicLink()) errors.push(`${id}: variant_root is a symlink: ${root}`)',
  '  const rootReal = fs.existsSync(rootAbs) ? fs.realpathSync.native(rootAbs) : rootAbs',
  '  if (created.length === 0) errors.push(`${id}: accepted variant has no created_files`)',
  '  if (entry.length === 0) errors.push(`${id}: accepted variant has no entry_points`)',
  '  for (const rel of Array.from(new Set([...created, ...entry]))) {',
  '    if (typeof rel !== "string" || rel.length === 0) { errors.push(`${id}: reported path must be a non-empty string`); continue; }',
  '    if (!rel.startsWith(`${root}/`)) errors.push(`${id}: variant path is outside variant_root: ${rel}`)',
  '    const abs = path.resolve(projectRoot, rel)',
  '    if (!inside(rootAbs, abs)) errors.push(`${id}: variant path escapes variant_root: ${rel}`)',
  '    if (!fs.existsSync(abs)) { errors.push(`${id}: variant path does not exist: ${rel}`); continue; }',
  '    if (fs.lstatSync(abs).isSymbolicLink()) errors.push(`${id}: variant path is a symlink: ${rel}`)',
  '    const real = fs.realpathSync.native(abs)',
  '    if (!inside(rootReal, real)) errors.push(`${id}: variant path escapes real variant_root: ${rel}`)',
  '  }',
  '}',
  'if (errors.length > 0) { console.error(errors.join("\\n")); process.exit(1); }',
  'console.log(`Prototype variant integrity passed for ${variants.length} variant(s)`)',
].join('; ');

function readReport<T>(
  context: VerificationBuildContext,
  schemaName: string,
  parse: (raw: unknown) => T,
): T {
  const reportPath = reportPathForSchemaInRuntimeFlow(context.flow, schemaName);
  if (!context.step.reads.includes(reportPath as never)) {
    throw new Error(
      `prototype.variant-verification@v1 requires step '${context.step.id}' to read ${reportPath}`,
    );
  }
  return parse(JSON.parse(readFileSync(resolveRunRelative(context.runFolder, reportPath), 'utf8')));
}

function aggregate(context: VerificationBuildContext) {
  return readReport(context, 'prototype.variant-aggregate@v1', (raw) =>
    PrototypeVariantAggregate.parse(raw),
  );
}

function providerEvidence(context: VerificationBuildContext) {
  return readReport(context, 'prototype.variant-provider-evidence@v1', (raw) =>
    PrototypeVariantProviderEvidence.parse(raw),
  );
}

function integrityCommand(context: VerificationBuildContext): VerificationCommand {
  const payload = {
    variants: aggregate(context)
      .branches.filter(
        (branch) => branch.child_outcome === 'complete' && branch.result_body !== undefined,
      )
      .flatMap((branch) =>
        branch.result_body?.verdict === 'accept'
          ? [
              {
                variant_id: branch.result_body.variant_id,
                variant_root: branch.result_body.variant_root,
                created_files: branch.result_body.created_files,
                entry_points: branch.result_body.entry_points,
              },
            ]
          : [],
      ),
  };
  return {
    id: 'prototype-variant-artifact-integrity',
    cwd: '.',
    argv: [process.execPath, '-e', VARIANT_INTEGRITY_SCRIPT, JSON.stringify(payload)],
    timeout_ms: 30_000,
    max_output_bytes: 20_000,
    env: {},
  };
}

function projectVariantVerification(
  observations: readonly VerificationCommandObservation[],
  context: VerificationBuildContext,
): PrototypeVariantVerification {
  const aggregateReport = aggregate(context);
  const evidence = providerEvidence(context);
  const commandFailed = observations.some((observation) => observation.status === 'failed');
  const admitted = aggregateReport.branches.filter(
    (branch) =>
      branch.child_outcome === 'complete' && branch.admitted && branch.result_body !== undefined,
  );
  const admittedIds = new Set(admitted.map((branch) => branch.branch_id));
  const capturedProviderEvidenceCount = evidence.variants.filter(
    (variant) => admittedIds.has(variant.variant_id) && variant.status === 'captured',
  ).length;
  const overallStatus =
    commandFailed || admitted.length < 2 || capturedProviderEvidenceCount < 2 ? 'failed' : 'passed';
  return PrototypeVariantVerification.parse({
    overall_status: overallStatus,
    required_captured_provider_evidence_count: 2,
    captured_provider_evidence_count: capturedProviderEvidenceCount,
    admitted_variant_count: admitted.length,
    variant_results: aggregateReport.branches.map((branch) => {
      const providerEvidenceStatus =
        evidence.variants.find((variant) => variant.variant_id === branch.branch_id)?.status ??
        'missing';
      const accepted =
        branch.child_outcome === 'complete' && branch.admitted && branch.result_body !== undefined;
      const status =
        accepted && !commandFailed && providerEvidenceStatus === 'captured'
          ? 'passed'
          : accepted && commandFailed
            ? 'failed'
            : 'blocked';
      return {
        variant_id: branch.branch_id,
        status,
        entry_points: branch.result_body?.entry_points ?? [],
        created_files: branch.result_body?.created_files ?? [],
        ...(status === 'passed'
          ? {}
          : {
              failure_summary: !accepted
                ? `branch outcome '${branch.child_outcome}' with verdict '${branch.verdict}'`
                : providerEvidenceStatus !== 'captured'
                  ? 'provider/model evidence was not captured from relay.started'
                  : 'variant artifact integrity command failed',
            }),
        notes: [
          `branch outcome: ${branch.child_outcome}`,
          `verdict: ${branch.verdict}`,
          `provider evidence: ${providerEvidenceStatus}`,
        ],
      };
    }),
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

export const prototypeVariantVerificationWriter: VerificationBuilder = {
  resultSchemaName: 'prototype.variant-verification@v1',
  // Reads the variant aggregate (for the integrity command) and the variant
  // provider evidence (for the projected result). Declared so a composer wires the
  // reads and the offline floor resolves them; loadCommands/buildResult below are
  // the enforcing source of truth.
  reads: [
    { name: 'aggregate', schema: 'prototype.variant-aggregate@v1', required: true },
    { name: 'providerEvidence', schema: 'prototype.variant-provider-evidence@v1', required: true },
  ],
  loadCommands(context: VerificationBuildContext): readonly VerificationCommand[] {
    return [integrityCommand(context)];
  },
  buildResult(
    observations: readonly VerificationCommandObservation[],
    context: VerificationBuildContext,
  ): unknown {
    return projectVariantVerification(observations, context);
  },
};
