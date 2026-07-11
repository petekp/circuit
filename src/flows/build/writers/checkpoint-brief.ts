// Build brief checkpoint writer.
//
// Assembles a fresh BuildBrief from the run goal plus the
// policy.report_template object. The brief is fully populated at first
// write — checkpoint.response_path always points at step.writes.response
// — so no re-stamp happens after operator resolution. This eliminates
// the crash window between a stamped-brief write and the
// checkpoint.resolved trace_entry.
//
// Resume-time validator: reads the on-disk brief, verifies its hash
// against the value the checkpoint request stored, parses it through
// the BuildBrief schema, and asserts the brief.checkpoint.* shape
// belongs to the waiting step.

import { readFileSync } from 'node:fs';
import { sha256Hex } from '../../../shared/connector-relay.js';
import { resolveRunRelative } from '../../../shared/run-relative-path.js';
import {
  inferBuildVerificationNeeds,
  requireResolvedVerificationCommands,
} from '../../../shared/verification-resolver.js';
import type {
  CheckpointBriefBuilder,
  CheckpointBuildContext,
  CheckpointResumeContext,
} from '../../registries/checkpoint-writers/types.js';
import { BuildBrief } from '../reports.js';
import {
  BuildBriefReportTemplate,
  projectBuildBrief,
  validateBuildBriefCheckpointOwnership,
} from './checkpoint-brief-projection.js';

export const buildBriefCheckpointBuilder: CheckpointBriefBuilder = {
  resultSchemaName: 'build.brief@v1',
  build(context: CheckpointBuildContext): unknown {
    const rawTemplate = context.step.policy.report_template;
    if (rawTemplate === undefined) {
      throw new Error(
        `checkpoint step '${context.step.id}' writing build.brief@v1 requires policy.report_template`,
      );
    }
    const template = BuildBriefReportTemplate.parse(rawTemplate);
    const verificationCommands = requireResolvedVerificationCommands({
      ...(context.projectRoot === undefined ? {} : { projectRoot: context.projectRoot }),
      goal: context.goal,
      requestedNeeds: inferBuildVerificationNeeds(context.goal),
      commandIdPrefix: 'build',
      maxOutputBytes: 200_000,
    });
    return projectBuildBrief({
      context,
      template,
      verificationCommands,
    });
  },
  validateResumeContext(context: CheckpointResumeContext): BuildBrief {
    const reportAbs = resolveRunRelative(context.runFolder, context.reportPath);
    const raw = readFileSync(reportAbs, 'utf8');
    if (context.reportSha256 === undefined) {
      throw new Error(
        'checkpoint resume rejected: checkpoint request is missing checkpoint_report_sha256',
      );
    }
    const observedHash = sha256Hex(raw);
    if (observedHash !== context.reportSha256) {
      throw new Error('checkpoint resume rejected: waiting Build brief hash differs from request');
    }
    const brief = BuildBrief.parse(JSON.parse(raw));
    return validateBuildBriefCheckpointOwnership({ brief, step: context.step });
  },
};
