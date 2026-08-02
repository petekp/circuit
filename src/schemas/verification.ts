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

// A command the engine will actually spawn carries proof, in its TYPE, that it
// passed through this schema: a hand-built object literal is not a
// VerificationCommand and will not compile where one is required.
//
// This exists because two flows shipped `npm run <script>` written straight into
// the flow, unrunnable on any project without that exact script. The habit it
// blocks is constructing a command inline instead of getting one from
// shared/verification-resolver.ts (which asks the project) or from an upstream
// typed report (which was resolved further up). Circuit's own commands, the ones
// that run node against an internal script rather than the project's toolchain,
// mint through circuitOwnedVerificationCommand below.
//
// Honest limit: the brand proves a command was VALIDATED, not that it came from
// the resolver. Provenance cannot survive a JSON report boundary, where a parsed
// command is structurally identical to any other. Enforcing origin end to end
// would mean carrying it as data on the command. What this does buy is that the
// default move, returning a literal, stops compiling and points somewhere
// better. tests/contracts/flow-project-command-boundary.test.ts covers the rest
// by rejecting toolchain binaries named in flow source.
//
// The brand is an anonymous structural key, not a `unique symbol`. A symbol is
// the stronger nominal tool, but the brand reaches the public type of every
// report schema that carries a command, and those schemas (compiled-flow.ts,
// step.ts, flow-schematic.ts) do not import this module. Declaration emit
// cannot synthesize an import for a named symbol it needs, so tsc refused to
// write their .d.ts files at all (TS4023). A structural key writes inline.
//
// The tradeoff is that the brand is forgeable by anyone who types the key. That
// is no longer an accident, it is a deliberate act with the word PROVEN in it,
// and tests/contracts/verification-command-brand.test.ts fails if the key
// appears anywhere but this file.
type ProvenVerificationCommand = {
  readonly __PROVEN_VERIFICATION_COMMAND__: true;
};

const VerificationCommandShape = z
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

export const VerificationCommand = VerificationCommandShape.transform(
  (command) => command as z.infer<typeof VerificationCommandShape> & ProvenVerificationCommand,
);
export type VerificationCommand = z.output<typeof VerificationCommand>;

// The one way to mint a command Circuit runs against itself rather than against
// the project: an internal script under the running node binary, or a helper the
// engine ships. Everything else must come from the resolver or a typed report.
//
// It parses like any other command, so the shell-binary and cwd floors still
// apply, and it refuses argv that names a project toolchain binary — the hatch
// cannot be used to smuggle back the `npm run build` this whole change removed.
export function circuitOwnedVerificationCommand(
  command: z.input<typeof VerificationCommandShape>,
): VerificationCommand {
  const binary = commandBinaryName(command.argv[0] ?? '');
  if (PROJECT_TOOLCHAIN_BINARIES.has(binary)) {
    throw new Error(
      [
        `circuitOwnedVerificationCommand cannot run '${binary}': that is the project's toolchain,`,
        "not Circuit's. Resolve it through shared/verification-resolver.ts so the project can",
        'declare its own command.',
      ].join(' '),
    );
  }
  return VerificationCommand.parse(command);
}

// Binaries that belong to the project being worked on. Named here so the
// circuit-owned hatch above can refuse them.
const PROJECT_TOOLCHAIN_BINARIES = new Set([
  'npm',
  'npx',
  'pnpm',
  'pnpx',
  'yarn',
  'bun',
  'bunx',
  'make',
  'cargo',
  'go',
  'python',
  'python3',
  'pytest',
  'ruff',
  'tsc',
  'eslint',
  'vitest',
  'jest',
]);

// Operator-declared verification, read from `.circuit/config.yaml`.
//
// The automatic resolver reads package.json and nothing else, so a Python, Go,
// Rust, or Makefile project had no way to give Build or Fix a proof command —
// both flows blocked outright. A project declares its own commands here and
// the resolver prefers them over the package.json scripts.
//
// Trust boundary: this sits exactly where package.json scripts already sit.
// Both are repo-authored files whose contents Circuit already executes when it
// runs `npm run verify`, so reading a command from the project config does not
// widen what a hostile repository can do. `argv` is executed directly with no
// shell, and the shared VerificationCommand rules still apply — no shell
// binary as argv[0], no cwd outside the project root.
//
// Only the project layer is read. A verification command is a property of the
// repository, not of the operator, so a personal `~/.config/circuit/config.yaml`
// entry would be wrong to apply to every checkout.
export const DeclaredVerificationCommand = z
  .object({
    argv: z.array(z.string().min(1)).min(1),
    cwd: ProjectRelativeCwd.default('.'),
    // Absent means the shared verification budget. Declared because a Rust or
    // Go suite can legitimately outrun the default.
    timeout_ms: z.number().int().positive().optional(),
  })
  .strict();
export type DeclaredVerificationCommand = z.infer<typeof DeclaredVerificationCommand>;

// Keys match VerificationNeed in the resolver: `general` is the single
// catch-all proof, `build` and `lint` are the extra proofs a Build goal can
// ask for by name.
//
// `scan` and `audit` serve Sweep, which needs two proofs the others do not.
// `scan` is dual-channel: JSON findings on stdout give the work-list, and the
// exit code is the floor. `audit` exits non-zero once any suppression directive
// exists, so a worker cannot silence a finding instead of fixing it. They live
// here rather than in a sweep-owned block because they are the same kind of
// thing as the other three — a command this repository declares — and because
// one resolver means one precedence order and one error voice.
export const VerificationConfig = z
  .object({
    build: DeclaredVerificationCommand.optional(),
    lint: DeclaredVerificationCommand.optional(),
    general: DeclaredVerificationCommand.optional(),
    scan: DeclaredVerificationCommand.optional(),
    audit: DeclaredVerificationCommand.optional(),
    // The config files the declared commands read to decide what counts as a
    // finding. Not a command, but it belongs with them: it is the surface an
    // agent could edit to make a proof pass without fixing anything, and only
    // the project knows which files those are. A loop flow that freezes paths
    // adds these to whatever it froze itself.
    frozen_paths: z.array(ProjectRelativeCwd).optional(),
  })
  .strict();
export type VerificationConfig = z.infer<typeof VerificationConfig>;

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
