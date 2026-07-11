// Verification scalars — engine-shared schemas for command-list
// verification reports. Used by Build/Fix verification
// outputs, by Build's checkpoint policy template, and by any future
// flow that runs a budgeted command list. Lifted out of Build's
// report module so the same shape isn't owned by one flow that
// others must reach across to.

import { z } from 'zod';

const SHELL_BINARIES = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'dash',
  'cmd',
  'cmd.exe',
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
]);

function commandBinaryName(argv0: string): string {
  const normalized = argv0.replaceAll('\\', '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase();
}

const ProjectRelativeCwd = z
  .string()
  .min(1)
  .superRefine((cwd, ctx) => {
    if (cwd.startsWith('/') || cwd.startsWith('~') || /^[A-Za-z]:[\\/]/.test(cwd)) {
      ctx.addIssue({
        code: 'custom',
        message: 'cwd must be project-relative and cannot use absolute or home paths',
      });
    }
    if (cwd.startsWith('\\\\') || cwd.startsWith('//')) {
      ctx.addIssue({
        code: 'custom',
        message: 'cwd must not use UNC or network absolute paths',
      });
    }
    const parts = cwd.split('/');
    if (parts.some((part) => part === '..')) {
      ctx.addIssue({
        code: 'custom',
        message: 'cwd must not escape the project root',
      });
    }
    if (cwd !== '.' && parts.some((part) => part.length === 0 || part === '.')) {
      ctx.addIssue({
        code: 'custom',
        message: 'cwd must be "." or a normalized project-relative path',
      });
    }
  });

export const VerificationCommand = z
  .object({
    id: z.string().min(1),
    cwd: ProjectRelativeCwd,
    argv: z.array(z.string().min(1)).min(1),
    timeout_ms: z.number().int().positive(),
    max_output_bytes: z.number().int().positive(),
    env: z.record(z.string(), z.string()),
  })
  .strict()
  .superRefine((command, ctx) => {
    const firstArg = command.argv[0];
    if (firstArg === undefined) return;
    const binary = commandBinaryName(firstArg);
    if (SHELL_BINARIES.has(binary)) {
      ctx.addIssue({
        code: 'custom',
        path: ['argv'],
        message: 'verification commands must use direct argv execution, not a shell executable',
      });
    }
  });
export type VerificationCommand = z.infer<typeof VerificationCommand>;

export const VerificationCommandResult = z
  .object({
    command_id: z.string().min(1),
    argv: z.array(z.string().min(1)).min(1),
    cwd: ProjectRelativeCwd,
    exit_code: z.number().int().nonnegative(),
    status: z.enum(['passed', 'failed']),
    duration_ms: z.number().int().nonnegative(),
    stdout_summary: z.string(),
    stderr_summary: z.string(),
    // Whether this command was killed for hitting its verification budget
    // rather than exiting on its own. Defaults false so every fixture and
    // report written before this field existed still parses.
    timed_out: z.boolean().default(false),
  })
  .strict()
  .superRefine((result, ctx) => {
    const expected = result.exit_code === 0 ? 'passed' : 'failed';
    if (result.status !== expected) {
      ctx.addIssue({
        code: 'custom',
        path: ['status'],
        message: `status must be '${expected}' when exit_code is ${result.exit_code}`,
      });
    }
  });
export type VerificationCommandResult = z.infer<typeof VerificationCommandResult>;

export const VerificationResult = z
  .object({
    overall_status: z.enum(['passed', 'failed']),
    commands: z.array(VerificationCommandResult).min(1),
  })
  .strict()
  .superRefine((verification, ctx) => {
    const expected = verification.commands.some((command) => command.status === 'failed')
      ? 'failed'
      : 'passed';
    if (verification.overall_status !== expected) {
      ctx.addIssue({
        code: 'custom',
        path: ['overall_status'],
        message: `overall_status must be '${expected}' for command results`,
      });
    }
  });
export type VerificationResult = z.infer<typeof VerificationResult>;
