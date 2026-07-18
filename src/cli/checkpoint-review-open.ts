import { spawn as nodeSpawn } from 'node:child_process';

type SpawnedOpener = {
  on(event: 'error', listener: () => void): unknown;
  unref(): void;
};

type SpawnOpener = (
  command: string,
  args: readonly string[],
  options: { readonly detached: true; readonly stdio: 'ignore' },
) => SpawnedOpener;

export interface OpenLocalCheckpointReviewOptions {
  readonly platform?: NodeJS.Platform | string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly spawn?: SpawnOpener;
}

function envFlagEnabled(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0' && value !== 'false';
}

export function isLocalCheckpointReviewUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      url.port.length > 0 &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.hash.length === 0
    );
  } catch {
    return false;
  }
}

export function openLocalCheckpointReview(
  url: string,
  options: OpenLocalCheckpointReviewOptions = {},
): boolean {
  if (!isLocalCheckpointReviewUrl(url)) return false;
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (envFlagEnabled(env.CIRCUIT_NO_AUTO_OPEN) || envFlagEnabled(env.CI)) return false;
  if (
    platform === 'linux' &&
    (env.DISPLAY === undefined || env.DISPLAY === '') &&
    (env.WAYLAND_DISPLAY === undefined || env.WAYLAND_DISPLAY === '')
  ) {
    return false;
  }

  let command: string;
  let args: string[];
  if (platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (platform === 'linux') {
    command = 'xdg-open';
    args = [url];
  } else if (platform === 'win32') {
    if (/[&|<>^"%]/.test(url)) return false;
    command = 'cmd';
    args = ['/c', 'start', '""', url];
  } else {
    return false;
  }

  const spawn = options.spawn ?? (nodeSpawn as unknown as SpawnOpener);
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
