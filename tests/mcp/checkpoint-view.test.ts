import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CheckpointViewError,
  type StoredCheckpointLocatorV1,
  assertCheckpointResume,
  readCheckpointView,
} from '../../src/hosts/codex-mcp/checkpoint-view.js';
import {
  CODEX_SANDBOX_METADATA_KEY,
  type TrustedCodexWorkspace,
} from '../../src/hosts/codex-mcp/resources.js';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_RUN_ID = '22222222-2222-4222-8222-222222222222';
const MAX_REQUEST_BYTES = 256 * 1024;
const roots: string[] = [];

type RequestBody = {
  schema_version: number;
  step_id: string;
  prompt: string;
  allowed_choices: string[];
  choices: Array<{ id: string; label?: string; description?: string }>;
  safe_default_choice?: string;
  execution_context: Record<string, unknown>;
  [key: string]: unknown;
};

type Fixture = {
  root: string;
  workspace: TrustedCodexWorkspace;
  runId: string;
  runFolder: string;
  requestPath: string;
  requestFile: string;
  request: RequestBody;
  locator: StoredCheckpointLocatorV1;
};

function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'circuit-mcp-checkpoint-'));
  roots.push(root);
  return root;
}

function defaultRequest(): RequestBody {
  return {
    schema_version: 1,
    step_id: 'choose-direction',
    prompt: 'Choose the direction to continue.',
    allowed_choices: ['focused', 'broader'],
    choices: [
      {
        id: 'focused',
        label: 'Focused change',
        description: 'Keep the change narrow.',
      },
      { id: 'broader' },
    ],
    safe_default_choice: 'focused',
    execution_context: {
      project_root: '/must/not/be-returned',
      review_inputs: [{ path: 'private-review-input.json', sha256: 'a'.repeat(64) }],
      review_assets: { images: [{ path: 'private-preview.png' }] },
    },
  };
}

async function createFixture(
  options: {
    root?: string;
    workspaceName?: string;
    runId?: string;
    requestPath?: string;
    request?: RequestBody;
    rawBytes?: Uint8Array | string;
    locator?: Partial<StoredCheckpointLocatorV1>;
  } = {},
): Promise<Fixture> {
  const root = options.root ?? (await temporaryRoot());
  const workspacePath = join(root, options.workspaceName ?? 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const workspace: TrustedCodexWorkspace = {
    identity_source: CODEX_SANDBOX_METADATA_KEY,
    workspace: await realpath(workspacePath),
  };
  const runId = options.runId ?? RUN_ID;
  const runFolder = join(workspace.workspace, '.circuit', 'runs', runId);
  const requestPath = options.requestPath ?? 'reports/checkpoints/choose-direction-request.json';
  const requestFile = join(runFolder, ...requestPath.split('/'));
  await mkdir(dirname(requestFile), { recursive: true });

  const request = options.request ?? defaultRequest();
  const bytes = options.rawBytes ?? JSON.stringify(request);
  await writeFile(requestFile, bytes);
  const allowedChoices = options.locator?.allowed_choices ?? request.allowed_choices;
  const locator: StoredCheckpointLocatorV1 = {
    generation: 1,
    step_id: request.step_id,
    attempt: 1,
    request_path: requestPath,
    request_sha256: sha256(bytes),
    allowed_choices: [...allowedChoices],
    choices_sha256: sha256(JSON.stringify(allowedChoices)),
    ...options.locator,
  };

  return { root, workspace, runId, runFolder, requestPath, requestFile, request, locator };
}

async function expectCheckpointError(
  operation: Promise<unknown>,
  code: string,
): Promise<CheckpointViewError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(CheckpointViewError);
    expect((error as CheckpointViewError).code).toBe(code);
    return error as CheckpointViewError;
  }
  throw new Error('expected checkpoint operation to fail');
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('MCP checkpoint view', () => {
  it('returns only bounded public checkpoint data and a deterministic token', async () => {
    const fixture = await createFixture();

    const first = await readCheckpointView({
      workspace: fixture.workspace,
      run_id: fixture.runId,
      checkpoint: fixture.locator,
    });
    const afterRestart = await readCheckpointView({
      workspace: { ...fixture.workspace },
      run_id: fixture.runId,
      checkpoint: { ...fixture.locator, allowed_choices: [...fixture.locator.allowed_choices] },
    });

    expect(first).toEqual({
      token: expect.stringMatching(/^cpt1\.[a-f0-9]{64}$/),
      prompt: 'Choose the direction to continue.',
      choices: [
        {
          id: 'focused',
          label: 'Focused change',
          description: 'Keep the change narrow.',
        },
        { id: 'broader', label: 'broader' },
      ],
    });
    expect(afterRestart.token).toBe(first.token);
    expect(JSON.stringify(first)).not.toContain('execution_context');
    expect(JSON.stringify(first)).not.toContain('private-review-input');
    expect(JSON.stringify(first)).not.toContain('private-preview');
    expect(JSON.stringify(first)).not.toContain('project_root');
  });

  it('binds the token to the workspace, run, generation, step, attempt, path, bytes, and ordered choices', async () => {
    const root = await temporaryRoot();
    const base = await createFixture({ root, workspaceName: 'workspace-a' });
    const baseView = await readCheckpointView({
      workspace: base.workspace,
      run_id: base.runId,
      checkpoint: base.locator,
    });

    const generation = await readCheckpointView({
      workspace: base.workspace,
      run_id: base.runId,
      checkpoint: { ...base.locator, generation: 2 },
    });
    const attempt = await readCheckpointView({
      workspace: base.workspace,
      run_id: base.runId,
      checkpoint: { ...base.locator, attempt: 2 },
    });
    const otherPath = await createFixture({
      root,
      workspaceName: 'workspace-a',
      requestPath: 'reports/checkpoints/same-request-at-new-path.json',
    });
    const otherPathView = await readCheckpointView({
      workspace: otherPath.workspace,
      run_id: otherPath.runId,
      checkpoint: otherPath.locator,
    });
    const otherRun = await createFixture({
      root,
      workspaceName: 'workspace-a',
      runId: OTHER_RUN_ID,
    });
    const otherRunView = await readCheckpointView({
      workspace: otherRun.workspace,
      run_id: otherRun.runId,
      checkpoint: otherRun.locator,
    });
    const otherWorkspace = await createFixture({ root, workspaceName: 'workspace-b' });
    const otherWorkspaceView = await readCheckpointView({
      workspace: otherWorkspace.workspace,
      run_id: otherWorkspace.runId,
      checkpoint: otherWorkspace.locator,
    });

    const changedStepRequest = defaultRequest();
    changedStepRequest.step_id = 'choose-another-direction';
    const changedStep = await createFixture({
      root,
      workspaceName: 'workspace-a',
      requestPath: 'reports/checkpoints/changed-step.json',
      request: changedStepRequest,
    });
    const changedStepView = await readCheckpointView({
      workspace: changedStep.workspace,
      run_id: changedStep.runId,
      checkpoint: changedStep.locator,
    });

    const changedChoicesRequest = defaultRequest();
    changedChoicesRequest.allowed_choices.reverse();
    changedChoicesRequest.choices.reverse();
    const changedChoices = await createFixture({
      root,
      workspaceName: 'workspace-a',
      requestPath: 'reports/checkpoints/changed-choices.json',
      request: changedChoicesRequest,
    });
    const changedChoicesView = await readCheckpointView({
      workspace: changedChoices.workspace,
      run_id: changedChoices.runId,
      checkpoint: changedChoices.locator,
    });

    const changedBytesRequest = defaultRequest();
    changedBytesRequest.prompt = 'Choose a changed direction.';
    const changedBytes = await createFixture({
      root,
      workspaceName: 'workspace-a',
      requestPath: 'reports/checkpoints/changed-bytes.json',
      request: changedBytesRequest,
    });
    const changedBytesView = await readCheckpointView({
      workspace: changedBytes.workspace,
      run_id: changedBytes.runId,
      checkpoint: changedBytes.locator,
    });

    expect(
      new Set([
        baseView.token,
        generation.token,
        attempt.token,
        otherPathView.token,
        otherRunView.token,
        otherWorkspaceView.token,
        changedStepView.token,
        changedChoicesView.token,
        changedBytesView.token,
      ]).size,
    ).toBe(9);
  });

  it('accepts only the current token and one advertised choice', async () => {
    const fixture = await createFixture();
    const view = await readCheckpointView({
      workspace: fixture.workspace,
      run_id: fixture.runId,
      checkpoint: fixture.locator,
    });

    await expect(
      assertCheckpointResume({
        workspace: fixture.workspace,
        run_id: fixture.runId,
        checkpoint: fixture.locator,
        checkpoint_token: view.token,
        choice_id: 'focused',
      }),
    ).resolves.toEqual(view);

    await expectCheckpointError(
      assertCheckpointResume({
        workspace: fixture.workspace,
        run_id: fixture.runId,
        checkpoint: { ...fixture.locator, generation: 2 },
        checkpoint_token: view.token,
        choice_id: 'focused',
      }),
      'checkpoint_stale',
    );
    await expectCheckpointError(
      assertCheckpointResume({
        workspace: fixture.workspace,
        run_id: fixture.runId,
        checkpoint: fixture.locator,
        checkpoint_token: view.token,
        choice_id: 'not-advertised',
      }),
      'choice_unavailable',
    );
    await expectCheckpointError(
      assertCheckpointResume({
        workspace: fixture.workspace,
        run_id: fixture.runId,
        checkpoint: fixture.locator,
        checkpoint_token: 'not-a-checkpoint-token',
        choice_id: 'focused',
      }),
      'checkpoint_token_invalid',
    );
  });

  it.each([
    ['unknown outer field', (request: RequestBody) => Object.assign(request, { surprise: true })],
    [
      'wrong schema version',
      (request: RequestBody) => Object.assign(request, { schema_version: 2 }),
    ],
    [
      'missing execution context',
      (request: RequestBody) => Reflect.deleteProperty(request, 'execution_context'),
    ],
    ['duplicate allowed choice', (request: RequestBody) => request.allowed_choices.push('focused')],
    ['duplicate labeled choice', (request: RequestBody) => request.choices.push({ id: 'focused' })],
    ['mismatched choice order', (request: RequestBody) => request.choices.reverse()],
    [
      'unsafe default',
      (request: RequestBody) => Object.assign(request, { safe_default_choice: 'not-allowed' }),
    ],
    [
      'too-long prompt',
      (request: RequestBody) => Object.assign(request, { prompt: 'x'.repeat(4_001) }),
    ],
    [
      'too-long label',
      (request: RequestBody) => Object.assign(request.choices[0] ?? {}, { label: 'x'.repeat(121) }),
    ],
    [
      'too-long description',
      (request: RequestBody) =>
        Object.assign(request.choices[0] ?? {}, { description: 'x'.repeat(501) }),
    ],
    [
      'more than twenty choices',
      (request: RequestBody) => {
        request.allowed_choices = Array.from({ length: 21 }, (_, index) => `choice-${index}`);
        request.choices = request.allowed_choices.map((id) => ({ id }));
      },
    ],
  ] as const)('fails closed for a malformed request: %s', async (_label, mutate) => {
    const request = defaultRequest();
    mutate(request);
    const fixture = await createFixture({
      request,
      locator: {
        step_id: 'choose-direction',
        allowed_choices: ['focused', 'broader'],
      },
    });

    await expectCheckpointError(
      readCheckpointView({
        workspace: fixture.workspace,
        run_id: fixture.runId,
        checkpoint: fixture.locator,
      }),
      'checkpoint_request_invalid',
    );
  });

  it('rejects stale step, hash, and ordered-choice locators', async () => {
    const fixture = await createFixture();

    for (const checkpoint of [
      { ...fixture.locator, step_id: 'stale-step' },
      { ...fixture.locator, request_sha256: '0'.repeat(64) },
      {
        ...fixture.locator,
        allowed_choices: [...fixture.locator.allowed_choices].reverse(),
        choices_sha256: sha256(JSON.stringify([...fixture.locator.allowed_choices].reverse())),
      },
    ]) {
      await expectCheckpointError(
        readCheckpointView({
          workspace: fixture.workspace,
          run_id: fixture.runId,
          checkpoint,
        }),
        'checkpoint_stale',
      );
    }

    await expectCheckpointError(
      readCheckpointView({
        workspace: fixture.workspace,
        run_id: fixture.runId,
        checkpoint: { ...fixture.locator, choices_sha256: '0'.repeat(64) },
      }),
      'checkpoint_locator_invalid',
    );
  });

  it.each([
    '/tmp/request.json',
    '../request.json',
    'reports/../request.json',
    'reports//request.json',
    'reports\\request.json',
    'reports/request\0.json',
  ])('rejects a non-normalized or unsafe request path: %j', async (requestPath) => {
    const fixture = await createFixture();

    await expectCheckpointError(
      readCheckpointView({
        workspace: fixture.workspace,
        run_id: fixture.runId,
        checkpoint: { ...fixture.locator, request_path: requestPath },
      }),
      'checkpoint_locator_invalid',
    );
  });

  it('rejects symlinks at the request and parent-directory boundaries', async () => {
    const finalLinkFixture = await createFixture();
    const outside = join(finalLinkFixture.root, 'outside.json');
    await writeFile(outside, JSON.stringify(defaultRequest()));
    await rm(finalLinkFixture.requestFile);
    await symlink(outside, finalLinkFixture.requestFile);

    await expectCheckpointError(
      readCheckpointView({
        workspace: finalLinkFixture.workspace,
        run_id: finalLinkFixture.runId,
        checkpoint: finalLinkFixture.locator,
      }),
      'checkpoint_request_unsafe',
    );

    const parentLinkFixture = await createFixture({ workspaceName: 'parent-link-workspace' });
    const realReports = join(parentLinkFixture.root, 'real-reports');
    await mkdir(join(realReports, 'checkpoints'), { recursive: true });
    await writeFile(
      join(realReports, 'checkpoints', 'choose-direction-request.json'),
      JSON.stringify(defaultRequest()),
    );
    await rm(join(parentLinkFixture.runFolder, 'reports'), { recursive: true });
    await symlink(realReports, join(parentLinkFixture.runFolder, 'reports'), 'dir');

    await expectCheckpointError(
      readCheckpointView({
        workspace: parentLinkFixture.workspace,
        run_id: parentLinkFixture.runId,
        checkpoint: parentLinkFixture.locator,
      }),
      'checkpoint_request_unsafe',
    );
  });

  it('rejects non-regular and multiply linked request files', async () => {
    const directoryFixture = await createFixture();
    await rm(directoryFixture.requestFile);
    await mkdir(directoryFixture.requestFile);
    await expectCheckpointError(
      readCheckpointView({
        workspace: directoryFixture.workspace,
        run_id: directoryFixture.runId,
        checkpoint: directoryFixture.locator,
      }),
      'checkpoint_request_unsafe',
    );

    const linkedFixture = await createFixture({ workspaceName: 'linked-workspace' });
    await link(linkedFixture.requestFile, join(linkedFixture.root, 'second-link.json'));
    await expectCheckpointError(
      readCheckpointView({
        workspace: linkedFixture.workspace,
        run_id: linkedFixture.runId,
        checkpoint: linkedFixture.locator,
      }),
      'checkpoint_request_unsafe',
    );
  });

  it('rejects oversized, malformed JSON, and invalid UTF-8 request bytes', async () => {
    const oversized = await createFixture({ rawBytes: ' '.repeat(MAX_REQUEST_BYTES + 1) });
    await expectCheckpointError(
      readCheckpointView({
        workspace: oversized.workspace,
        run_id: oversized.runId,
        checkpoint: oversized.locator,
      }),
      'checkpoint_request_too_large',
    );

    const malformed = await createFixture({
      workspaceName: 'malformed-workspace',
      rawBytes: '{not json',
    });
    await expectCheckpointError(
      readCheckpointView({
        workspace: malformed.workspace,
        run_id: malformed.runId,
        checkpoint: malformed.locator,
      }),
      'checkpoint_request_invalid',
    );

    const invalidUtf8 = await createFixture({
      workspaceName: 'invalid-utf8-workspace',
      rawBytes: Uint8Array.from([0xc3, 0x28]),
    });
    await expectCheckpointError(
      readCheckpointView({
        workspace: invalidUtf8.workspace,
        run_id: invalidUtf8.runId,
        checkpoint: invalidUtf8.locator,
      }),
      'checkpoint_request_invalid',
    );
  });

  it('requires the trusted workspace to already be canonical and available', async () => {
    const fixture = await createFixture();
    const alias = join(fixture.root, 'workspace-alias');
    await symlink(fixture.workspace.workspace, alias, 'dir');

    await expectCheckpointError(
      readCheckpointView({
        workspace: { ...fixture.workspace, workspace: alias },
        run_id: fixture.runId,
        checkpoint: fixture.locator,
      }),
      'workspace_unavailable',
    );
  });
});
