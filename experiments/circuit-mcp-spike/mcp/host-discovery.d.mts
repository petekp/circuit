export interface CodexExecutablePin {
  executable: string;
  source: string;
  version: string;
  identity: {
    device: string;
    inode: string;
    size: number;
    modified_ms: number;
  };
}

export interface HostDiscoveryOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
  systemApplicationsRoot?: string;
  userApplicationsRoot?: string;
  versionProbe?: (executable: string) => Promise<string>;
}

export function discoverTrustedCodexExecutable(
  options?: HostDiscoveryOptions,
): Promise<CodexExecutablePin>;

export function assertTrustedCodexExecutableUnchanged(
  pin: CodexExecutablePin,
  options?: Pick<HostDiscoveryOptions, 'versionProbe'>,
): Promise<void>;

export function discoverTrustedCodexHome(options?: HostDiscoveryOptions): Promise<{
  path: string;
  source: string;
}>;

export function discoverTrustedCodexHost(options?: HostDiscoveryOptions): Promise<{
  codex: CodexExecutablePin;
  codexHome: { path: string; source: string };
}>;
